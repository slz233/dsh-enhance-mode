/**
 * 「修好这条会话」：把失败的回合从**模型视野**里摘掉。
 *
 * 为什么不是删文件：DSH 的会话日志是追加式 + seq 连续，手动截断会产生断层
 * （2026-11-26 踩过：磁盘 seq=2537、进程内存 seq=2561，再写一条就报废）。
 * 本模块只用宿主官方的「表面替换」机制：
 *
 *   session.append('user/message', marker, {
 *     surfaceOp: { op: 'replace', startSeq, endSeq },
 *     sourceEventSeqs: shadowed,
 *   })
 *
 * `surfaceOp` / `sourceEventSeqs` 由 @deepseek-ai/dsh-session 校验
 * （`surface replace: sourceEventSeqs must include every shadowed surface node`），
 * 语义是：**日志照旧追加，但这一段不再进模型的 transcript**。
 * 所以磁盘上一条不少、可审计，只是下一轮请求不再带它。
 *
 * 典型场景：上游 400（内容过滤）后，那条用户消息留在历史里，之后每轮都重发 →
 * 整个会话永久 400。这里把「连续失败的那一串回合」一次摘掉，退回最后一次成功的状态。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveEnhanceDir } from './paths.mjs'

/** 宿主 services 里会话存储的名字。 */
const SESSIONS_SERVICE = 'sessions'

/** 标记事件 id 前缀：与宿主（被 purge 打过补丁的版本）约定一致，会被排除出 transcript。 */
const MARKER_PREFIX = 'rewind-'

/** 标记事件正文。**故意非空**：即使将来宿主不再过滤该前缀，它也是一条合法消息，不会变成空 content。 */
const MARKER_TEXT = '（已清理：失败的回合已从上下文移除）'

/**
 * 把宿主的 events 归一成 [{seq, type, data}]，按 seq 升序。
 * @param {unknown} input `session.snapshotEvents()` 的返回值
 */
export function normalizeEvents(input) {
  let list = []
  if (Array.isArray(input)) list = input
  else if (input && typeof input[Symbol.iterator] === 'function') list = [...input]
  return list
    .filter(event => event && Number.isSafeInteger(Number(event.seq)))
    .map(event => ({ seq: Number(event.seq), type: String(event.type ?? ''), data: event.data }))
    .sort((left, right) => left.seq - right.seq)
}

/** 这一轮的结束原因是不是「失败」。 */
export function isFailedTurnEnd(event) {
  if (!event || event.type !== 'turn/end') return false
  const reason = event.data?.reason
  return Boolean(reason) && reason.kind === 'error'
}

/** 出错回合的一句人话（给命令回显用）。 */
export function failureText(event) {
  const error = event?.data?.reason?.error
  const message = typeof error?.message === 'string' ? error.message : ''
  const code = typeof error?.code === 'string' ? error.code : ''
  if (message === '' && code === '') return '未知错误'
  return code === '' ? message : `${code}: ${message}`
}

/**
 * 规划一次修复：从「最后一次成功回合之后」到「日志末尾」全部摘掉。
 *
 * 连续失败（例如 400 之后用户又发了「继续」再 400）会被合并成一次，
 * 因此不需要用户点很多次。
 *
 * @param {unknown} rawEvents
 * @param {number[]} surfaceNodes 当前进入模型视野的 seq
 * @param {{ fromSeq?: number, lastTurn?: boolean }} [options]
 *        `fromSeq` 指定切点（不传就按「最后一个失败回合」自动找）；
 *        `lastTurn` 表示这是「撤销上一轮」而不是「修失败回合」。
 * @returns {{ok: true, fromSeq: number, toSeq: number, startSeq: number, endSeq: number,
 *            shadowed: number[], failedTurns: number, reason: string}
 *          | {ok: false, code: string, message: string}}
 */
export function planHeal(rawEvents, surfaceNodes, options = {}) {
  const events = normalizeEvents(rawEvents)
  if (events.length === 0) return { ok: false, code: 'empty-log', message: '这个会话还没有任何事件。' }

  const nodes = (Array.isArray(surfaceNodes) ? surfaceNodes : [])
    .map(Number)
    .filter(seq => Number.isSafeInteger(seq))
  if (nodes.length === 0) return { ok: false, code: 'empty-surface', message: '拿不到模型视野里的消息列表，不做猜测。' }

  const bySeq = new Map(events.map(event => [event.seq, event]))
  const isMarker = event => event?.data?.id !== undefined && String(event.data.id).startsWith(MARKER_PREFIX)

  /** 切点：这一条（含）之后的内容全部离开模型视野。 */
  let fromSeq
  let failedTurns = 0
  let reason = ''

  if (Number.isSafeInteger(options.fromSeq)) {
    // 「撤销上一轮」：切点由调用方给定（最后一条真人消息），不做失败判定
    const ends = events.filter(event => event.type === 'turn/end')
    const lastEndSeq = ends.length > 0 ? ends[ends.length - 1].seq : -1
    if (events.some(event => event.type === 'turn/start' && event.seq > lastEndSeq)) {
      return { ok: false, code: 'turn-open', message: '这一轮还没结束，先点停止再撤销。' }
    }
    fromSeq = options.fromSeq
    failedTurns = 1
    reason = '撤销上一轮'
  } else {
    const ends = events.filter(event => event.type === 'turn/end')
    if (ends.length === 0) return { ok: false, code: 'no-turn-end', message: '没有已结束的回合（可能还在生成，先点停止）。' }

    const lastEnd = ends[ends.length - 1]
    const openStart = events.filter(event => event.type === 'turn/start' && event.seq > lastEnd.seq)
    if (openStart.length > 0) {
      return { ok: false, code: 'turn-open', message: '这一轮还没结束，先点停止再修。' }
    }
    if (!isFailedTurnEnd(lastEnd)) {
      return { ok: false, code: 'last-turn-ok', message: '最后一轮是成功的，不需要修。' }
    }
    reason = failureText(lastEnd)

    // 从末尾往回走，把连续的失败回合合并（中间夹着的非失败回合就停）
    let stopSeq = -1
    for (let index = ends.length - 1; index >= 0; index -= 1) {
      const end = ends[index]
      if (!isFailedTurnEnd(end)) {
        stopSeq = end.seq
        break
      }
      failedTurns += 1
    }

    // 失败段的第一条用户消息 = 要摘的起点；找不到就退化为第一个失败回合的 turn/start
    const firstFailedEnd = ends[ends.length - failedTurns]
    const turnStart = events.filter(event => event.type === 'turn/start' && event.seq <= firstFailedEnd.seq).pop()
    const userMessages = events.filter(event =>
      event.type === 'user/message' &&
      event.seq > stopSeq &&
      event.seq <= firstFailedEnd.seq &&
      !isMarker(event),
    )
    fromSeq = userMessages.length > 0
      ? userMessages[0].seq
      : (turnStart ? turnStart.seq : firstFailedEnd.seq)
  }

  const toSeq = events[events.length - 1].seq

  // 宿主按**位置**切片校验（dsh-session 的 replacementRange：
  // nodes.indexOf(startSeq) … indexOf(endSeq)，区间内的节点必须逐个出现在
  // sourceEventSeqs 里）。而 surface.nodes 的顺序**不是按 seq 递增**的：
  // 上下文压缩会把摘要节点塞到最前面、替换会把标记留在被替换段的旧位置上。
  //
  // 所以唯一稳的取法：**切点自己必须就在 nodes 里，然后按位置取它到末尾的那一段**。
  // 这样区间恰好等于这一段，校验不可能再报 missing。
  const cutIdx = nodes.indexOf(fromSeq)
  if (cutIdx < 0) {
    if (!nodes.some(seq => seq >= fromSeq)) {
      return { ok: false, code: 'nothing-to-shadow', message: '这些回合里没有进入模型视野的消息，已经在上下文之外了。' }
    }
    return {
      ok: false,
      code: 'not-in-surface',
      message: `第 ${fromSeq} 条消息已经被压缩或替换掉了，定位不到它。这条会话压缩过，建议新建一个对话继续。`,
    }
  }
  const shadowed = nodes.slice(cutIdx)
  if (shadowed.length === 0) {
    return { ok: false, code: 'nothing-to-shadow', message: '这些回合里没有进入模型视野的消息，已经在上下文之外了。' }
  }

  // 系统提示 / 压缩摘要绝不能跟着消失，否则模型失去指令。
  const systemHit = shadowed.filter(seq => bySeq.get(seq)?.type === 'system/message')
  if (systemHit.length > 0) {
    return {
      ok: false,
      code: 'system-guard',
      message: `切点之后还排着 ${systemHit.length} 条系统提示（seq ${systemHit.slice(0, 3).join(', ')}…），删掉会让模型失去指令，所以不做。`,
    }
  }

  // 切点之后属于本轮的节点必须都在这一段里；有个更靠后的旧节点落在切点之前，
  // 说明视野被压缩/替换过，按位置切会连带删掉中间的真实历史 —— 宁可拒绝。
  const turnNodes = nodes.filter(seq => seq >= fromSeq && bySeq.get(seq)?.type !== 'system/message')
  const missed = turnNodes.filter(seq => !shadowed.includes(seq))
  if (missed.length > 0) {
    return {
      ok: false,
      code: 'scrambled',
      message: `这条会话的视野顺序被压缩/替换过，失败回合和更早的历史交错在一起（${missed.length} 个节点排在切点之前）。硬切会连带删掉中间的真实对话，所以没有动。建议新建一个对话继续。`,
    }
  }

  return {
    ok: true,
    fromSeq,
    toSeq,
    startSeq: shadowed[0],
    endSeq: shadowed[shadowed.length - 1],
    shadowed,
    failedTurns,
    reason,
  }
}

/**
 * 挖洞：把**夹在历史中间**的失败回合单独摘掉，前后内容照旧留着。
 *
 * 为什么不能复用 planHeal：那条路是「从切点一路切到末尾」，中间夹着的成功内容会一起没。
 * 这里按「连续失败的一组」算它在视野里的连续段，只要这一段里每一条都属于这组，就单独 replace 掉。
 *
 * 连续失败会合并成一组（一次点掉），否则中间那些孤立的 turn/start 残渣会留在界面上。
 *
 * @param {unknown} rawEvents
 * @param {number[]} surfaceNodes
 * @returns {{ startSeq: number, endSeq: number, shadowed: number[], turnEnd: number, turns: number, reason: string }[]}
 *          按 startSeq 从大到小（先替换靠后的，前面位置就不会变）
 */
export function planDrops(rawEvents, surfaceNodes) {
  const events = normalizeEvents(rawEvents)
  const nodes = (Array.isArray(surfaceNodes) ? surfaceNodes : [])
    .map(Number)
    .filter(seq => Number.isSafeInteger(seq))
  if (events.length === 0 || nodes.length === 0) return []

  const bySeq = new Map(events.map(event => [event.seq, event]))
  const starts = events.filter(event => event.type === 'turn/start')
  const ends = events.filter(event => event.type === 'turn/end')

  // 第一步：把连续的失败回合并成一组。组 = 组内第一个 turn/start 到最后一个 turn/end。
  const groups = []
  let open = null
  let previousEndSeq = -1
  for (const end of ends) {
    const turnStart = isFailedTurnEnd(end)
      ? starts.filter(event => event.seq < end.seq).pop()
      : undefined
    if (!isFailedTurnEnd(end) || !turnStart) {
      open = null
      previousEndSeq = end.seq
      continue
    }
    if (open !== null && previousEndSeq === open.lastEndSeq) {
      // 上一轮失败、这一轮还是失败 → 同一组
      open.lastEndSeq = end.seq
      open.turns += 1
      open.reason = failureText(end)
    } else {
      open = { fromSeq: turnStart.seq, lastEndSeq: end.seq, turns: 1, reason: failureText(end) }
      groups.push(open)
    }
    previousEndSeq = end.seq
  }

  // 第二步：每组算它在视野里的位置段，段内每一条都必须属于这组
  const drops = []
  for (const group of groups) {
    const belongs = seq => seq > group.fromSeq && seq <= group.lastEndSeq
    const positions = []
    for (let index = 0; index < nodes.length; index += 1) {
      if (belongs(nodes[index])) positions.push(index)
    }
    if (positions.length === 0) continue

    const from = positions[0]
    const to = positions[positions.length - 1]
    let clean = true
    for (let index = from; index <= to; index += 1) {
      const seq = nodes[index]
      if (!belongs(seq) || bySeq.get(seq)?.type === 'system/message') {
        clean = false
        break
      }
    }
    if (!clean) continue

    drops.push({
      startSeq: nodes[from],
      endSeq: nodes[to],
      shadowed: nodes.slice(from, to + 1),
      turnEnd: group.lastEndSeq,
      turns: group.turns,
      reason: group.reason,
    })
  }

  return drops.sort((left, right) => right.startSeq - left.startSeq)
}

/** 界面上那条「已清理」标记本身不该占一行：宿主会滤掉 rewind- 前缀，这里再兜一层。 */
function isMarkerMessage(message) {
  if (!message) return true
  const id = message.id
  return typeof id === 'string' && id.startsWith(MARKER_PREFIX)
}

/**
 * 在 append 之前装好：surface 一变，宿主就会重新推导消息列表，
 * 我们在这里把标记消息滤掉（否则界面上多出一行空消息）。
 */
function wrapDeriveMessages(session) {
  if (!session || typeof session.deriveMessages !== 'function') return
  if (session.__enhanceHealDerive === true) return
  const original = session.deriveMessages.bind(session)
  session.deriveMessages = function deriveMessagesWithoutHealMarker() {
    const messages = original()
    if (!Array.isArray(messages)) return []
    return messages.filter(message => !isMarkerMessage(message))
  }
  session.__enhanceHealDerive = true
}

/**
 * surface replace 之后必须丢掉宿主的派生缓存：
 * 不清的话界面会继续挂着已经被切掉的那几条旧消息（模型看不见、人还看得见）。
 * 三个字段照 dsh-purge 的实战写法，改不动就跳过，不影响正确的替换结果。
 */
function invalidateDerivedCache(session) {
  if (!session) return
  try {
    session.derived = []
  } catch {
    // 只读属性就算了
  }
  try {
    session.derivedNodes = 0
  } catch {
    // 同上
  }
  try {
    session.derivedGeneration = -1
  } catch {
    // 同上
  }
}

/** 撤销之后下一句要按新请求开，别接上一轮的 request series。 */
function resetRequestSeries(ctx, sessionId) {
  const agents = service(ctx, 'agents')
  let agent
  try {
    agent = agents?.get?.(sessionId) ?? agents?.agent?.(sessionId)
  } catch {
    agent = undefined
  }
  if (!agent) return
  try {
    agent.requestHeaderLogged = false
  } catch {
    // 改不动就算了
  }
  try {
    agent.requestSurfaceGeneration = -1
  } catch {
    // 同上
  }
  try {
    agent.frozenMessages?.clear?.()
  } catch {
    // 同上
  }
}

/** 宿主服务的安全读取（严格 ctx 下未 inject 的属性访问会抛，所以一律走 get）。 */
function service(ctx, name) {
  try {
    return ctx.get(name)
  } catch {    return undefined
  }
}

/**
 * 执行修复。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string | null} sessionId
 * @param {{ dryRun?: boolean, inspect?: boolean }} [options]
 * @returns {{ok: true, dryRun: boolean, fromSeq: number, toSeq: number, removed: number, failedTurns: number, reason: string, text: string}
 *          | {ok: false, code: string, message: string}}
 */
export function healSession(ctx, sessionId, options = {}) {
  const dryRun = options.dryRun !== false
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, code: 'no-session', message: '拿不到当前会话 id。' }
  }
  const store = service(ctx, SESSIONS_SERVICE)
  if (!store || typeof store.get !== 'function') {
    return { ok: false, code: 'no-sessions-service', message: '宿主没有提供会话服务，修不了。' }
  }
  let session = null
  try {
    session = store.get(sessionId)
  } catch {
    session = null
  }
  if (!session) return { ok: false, code: 'session-not-live', message: '这个会话当前没有在宿主里打开，先在界面里点开它。' }
  if (typeof session.append !== 'function' || !session.surface) {
    return { ok: false, code: 'no-append', message: '宿主这个版本不支持表面替换（session.append/surface 缺失）。' }
  }

  const events = normalizeEvents(typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [])
  const nodes = (session.surface.nodes || []).map(Number)

  // 诊断模式：把真实的视野顺序完整写到文件（只读，不改上下文）。
  // 回显只给摘要 —— 一条命令回显塞 170 行会被界面截断（实测只剩几十字）。
  if (options.inspect === true) {
    const at = seq => (typeof session.eventAt === 'function'
      ? session.eventAt(seq)
      : events.find(event => event.seq === seq))
    const lines = nodes.map((seq, index) =>
      `${String(index).padStart(3, ' ')}  ${String(seq).padStart(5, ' ')}  ${at(seq)?.type ?? '?'}`)
    const dump = [`会话 ${sessionId}`, `事件 ${events.length} 条｜视野节点 ${nodes.length} 个`, '位置   seq  类型', ...lines].join('\n')
    const head = nodes.slice(0, 3).map(seq => `${seq}(${at(seq)?.type ?? '?'})`).join(' ')

    let file = ''
    try {
      const dir = resolveEnhanceDir()
      mkdirSync(dir, { recursive: true })
      file = join(dir, 'heal-dump.txt')
      writeFileSync(file, `${dump}\n`, 'utf8')
    } catch (error) {
      return {
        ok: true,
        text: `视野节点 ${nodes.length} 个（写文件失败：${error?.message ?? error}）\n头部：${head}\n\n${dump.slice(0, 800)}`,
      }
    }
    return {
      ok: true,
      text: `视野节点 ${nodes.length} 个，完整顺序已写到 ${file}。头部：${head}`,
    }
  }

  // 「清理失败记录」：挖洞式，只摘失败回合自己那一段，中间的成功内容原样留着
  if (options.mode === 'clean') {
    const first = planDrops(events, session.surface.nodes)
    if (first.length === 0) {
      return {
        ok: false,
        code: 'nothing-to-clean',
        empty: true,
        message: '模型那边已经没有失败记录了——界面上那几行是历史日志，不会再发给模型。可以直接发送。',
      }
    }
    const total = first.reduce((sum, drop) => sum + drop.shadowed.length, 0)
    const turns = first.reduce((sum, drop) => sum + drop.turns, 0)
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        drops: first.length,
        turns,
        removed: total,
        text: `试运行：${turns} 轮失败（分 ${first.length} 处，共 ${total} 条消息）会被摘掉。确认执行：/enhance heal clean go`,
      }
    }

    wrapDeriveMessages(session)
    let done = 0
    let removed = 0
    let cleanedTurns = 0
    // 每轮都重新取快照：前一次替换会改掉位置，拿旧位置接着算会切错
    for (let guard = 0; guard < first.length + 5; guard += 1) {
      const nowEvents = normalizeEvents(typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [])
      const nowNodes = (session.surface.nodes || []).map(Number)
      const plans = planDrops(nowEvents, nowNodes)
      if (plans.length === 0) break
      const drop = plans[0]
      try {
        session.append('user/message', {
          id: `${MARKER_PREFIX}${Date.now().toString(36)}-${done}-${drop.shadowed.length}`,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: MARKER_TEXT }],
        }, {
          surfaceOp: { op: 'replace', startSeq: drop.startSeq, endSeq: drop.endSeq },
          sourceEventSeqs: drop.shadowed,
        })
      } catch (error) {
        invalidateDerivedCache(session)
        resetRequestSeries(ctx, sessionId)
        return {
          ok: done > 0,
          drops: done,
          removed,
          code: 'append-failed',
          message: `清到第 ${done + 1} 处时宿主拒绝了（seq ${drop.startSeq}–${drop.endSeq}）：${error?.message ?? error}`,
          text: done > 0
            ? `已经清掉 ${done} 处，第 ${done + 1} 处宿主没接受：${error?.message ?? error}`
            : `宿主拒绝了这次清理：${error?.message ?? error}`,
        }
      }
      done += 1
      removed += drop.shadowed.length
      cleanedTurns += drop.turns ?? 1
    }
    invalidateDerivedCache(session)
    resetRequestSeries(ctx, sessionId)
    return {
      ok: true,
      drops: done,
      turns: cleanedTurns,
      removed,
      text: `已清理 ${cleanedTurns} 轮失败对话（分 ${done} 处，共摘掉 ${removed} 条消息），可以直接继续对话。`,
    }
  }

  // 「撤销上一轮」：默认切最后一条真人消息。
  // 但最后一轮是失败的话，整组连续失败一起撤 —— 用户点这个按钮就是要"恢复可用"，
  // 不该让他连败五次点五次。
  let overrideFromSeq
  if (options.mode === 'undo') {
    const ends = events.filter(event => event.type === 'turn/end')
    const lastEnd = ends.length > 0 ? ends[ends.length - 1] : undefined
    if (lastEnd === undefined || !isFailedTurnEnd(lastEnd)) {
      const last = [...events].reverse().find(event =>
        event.type === 'user/message' &&
        (event.data?.id === undefined || !String(event.data.id).startsWith(MARKER_PREFIX)))
      if (!last) {
        return {
          ok: false,
          code: 'no-turn',
          empty: true,
          message: '这条会话里没有可以撤销的轮次，直接发送就行。',
        }
      }
      overrideFromSeq = last.seq
    }
    // 最后一轮是失败：不设切点，交给 planHeal 的自动分支（它会把连续失败合并成一次）
  }

  const plan = planHeal(events, session.surface.nodes, overrideFromSeq === undefined ? {} : { fromSeq: overrideFromSeq })
  if (!plan.ok) return plan

  const summary = {
    ok: true,
    dryRun,
    fromSeq: plan.fromSeq,
    toSeq: plan.toSeq,
    removed: plan.shadowed.length,
    failedTurns: plan.failedTurns,
    reason: plan.reason,
  }
  if (dryRun) {
    const what = options.mode === 'undo'
      ? (plan.failedTurns > 1 ? `最近 ${plan.failedTurns} 轮连续失败` : '撤销上一轮')
      : `${plan.failedTurns} 个失败回合`
    const hint = options.mode === 'undo' ? '/enhance heal undo go' : '/enhance heal go'
    return { ...summary, text: `试运行：将摘掉 ${plan.shadowed.length} 条消息（seq ${plan.fromSeq}–${plan.toSeq}，${what}）。确认执行：${hint}` }
  }

  // 先装好界面侧的过滤，再 append —— 否则 append 触发的那次重渲染会先跑到旧逻辑
  wrapDeriveMessages(session)

  // 宿主按位置切片校验，正常一次就过；万一它还报 `missing N`（节点表里有不在 seq 顺序上的成员），
  // 就把缺的补进 sourceEventSeqs、按位置重新取一次范围，最多再试两次。
  let sources = plan.shadowed.slice()
  let startSeq = plan.startSeq
  let endSeq = plan.endSeq
  let attempt = 0
  let lastError = null
  for (;;) {
    attempt += 1
    try {
      session.append('user/message', {
        id: `${MARKER_PREFIX}${Date.now().toString(36)}-${sources.length}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: MARKER_TEXT }],
      }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: sources,
      })
      break
    } catch (error) {
      lastError = error
      const missing = missingSeqs(error?.message)
      if (missing.length === 0 || attempt >= 3) {
        return { ok: false, code: 'append-failed', message: `宿主拒绝了这次替换：${error?.message ?? error}` }
      }
      // 只把宿主点名的节点补进 sourceEventSeqs，**不动 startSeq/endSeq**：
      // 范围由宿主按位置自己算，我们改起点只会让下一次又对不上。
      sources = [...new Set([...sources, ...missing])].sort((left, right) => left - right)
    }
  }

  // 替换已经成了：让宿主重建派生消息（界面才会立刻少掉那几条），并让下一句按新请求开
  invalidateDerivedCache(session)
  resetRequestSeries(ctx, sessionId)

  void lastError

  // 复核：被摘的 seq 必须真的不在 surface 里了
  const left = new Set((session.surface.nodes || []).map(Number))
  const stillThere = sources.filter(seq => left.has(seq))
  if (stillThere.length > 0) {
    return {
      ok: false,
      code: 'verify-failed',
      message: `替换之后仍有 ${stillThere.length} 条留在上下文里（seq ${stillThere.slice(0, 5).join(', ')}…），请把这句回显给维护者。`,
    }
  }

  return {
    ...summary,
    removed: sources.length,
    startSeq,
    endSeq,
    attempts: attempt,
    text: options.mode === 'undo'
      ? (plan.failedTurns > 1
        ? `已撤销最近 ${plan.failedTurns} 轮失败对话（${sources.length} 条消息），可以直接重新发一遍。`
        : `已撤销上一轮（${sources.length} 条消息），直接把你想说的话重新发一遍就行。`)
      : `已修好：摘掉 ${sources.length} 条消息（${plan.failedTurns} 个失败回合，失败原因：${plan.reason}）。可以直接继续对话。`,
  }
}

/** 从宿主的校验错误里取出缺失的 seq（`... shadowed surface node; missing 9, 12`）。 */
function missingSeqs(message) {
  const text = String(message ?? '')
  const match = text.match(/missing ([0-9][0-9,\s]*)/)
  if (!match) return []
  return match[1]
    .split(/[,\s]+/u)
    .map(part => Number(part))
    .filter(seq => Number.isSafeInteger(seq) && seq >= 0)
}
