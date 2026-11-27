/**
 * 「修好会话」的离线测试：规划逻辑 + 与宿主的交互形状。
 *
 * 跑法：node scripts/test-heal.mjs
 *
 * 覆盖：
 *   1) 规划：末轮成功 / 末轮失败 / 连续失败合并 / 回合未结束 / 视野为空 / 空日志
 *   2) 执行：试运行不写盘；确认执行时的 append 参数（surfaceOp + sourceEventSeqs 全覆盖）
 *   3) 失败路径：append 抛错、复核不通过（宿主拒绝替换）都必须是 ok:false，不许静默成功
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { healSession, planHeal, planDrops, isFailedTurnEnd, failureText, normalizeEvents } from '../lib/heal.mjs'

let passed = 0
let failed = 0

function check(name, body) {
  try {
    body()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

function ok(value, what = '') {
  if (!value) throw new Error(`${what}：期望为真`)
}

function is(actual, expected, what = '') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function same(actual, expected, what = '') {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}：期望 ${right}，实际 ${left}`)
}

/** 造事件：按 seq 递增。 */
function makeLog() {
  let seq = 0
  const events = []
  const push = (type, data = {}) => {
    seq += 1
    events.push({ seq, type, data })
    return seq
  }
  return { events, push, current: () => seq }
}

/** 一轮成功：turn/start → user/message → assistant/message → turn/end(completed) */
function okTurn(log) {
  log.push('turn/start', { turn: 1 })
  const user = log.push('user/message', { id: `u-${log.current()}`, role: 'user' })
  const asst = log.push('assistant/message', {})
  const end = log.push('turn/end', { reason: { kind: 'completed' } })
  return { user, asst, end }
}

/** 一轮失败（模拟上游 400）。 */
function badTurn(log, code = 'INVALID_REQUEST') {
  log.push('turn/start', { turn: 2 })
  const user = log.push('user/message', { id: `u-${log.current()}`, role: 'user' })
  const attempt = log.push('assistant/attempt', {
    stream: [{ type: 'finish', reason: { kind: 'error', failure: { message: '400: nope' } } }],
  })
  const end = log.push('turn/end', {
    reason: { kind: 'error', error: { message: '400: {"message":"Sorry, I can\'t respond to this question."}', code } },
  })
  return { user, attempt, end }
}

// ---------------- 1. 规划 ----------------

check('末轮成功 → 不修', () => {
  const log = makeLog()
  okTurn(log)
  const plan = planHeal(log.events, [2, 3])
  is(plan.ok, false)
  is(plan.code, 'last-turn-ok')
})

check('末轮 400 → 从那条用户消息摘到末尾', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const plan = planHeal(log.events, [good.user, good.asst, bad.user, bad.attempt, bad.end])
  is(plan.ok, true)
  is(plan.fromSeq, bad.user, '起点应是失败轮的用户消息')
  same(plan.shadowed, [bad.user, bad.attempt, bad.end], '只摘失败那一串')
  is(plan.failedTurns, 1)
  ok(plan.reason.includes('INVALID_REQUEST'), '原因里应带错误码')
  ok(!plan.shadowed.includes(good.asst), '成功那轮的回答必须保留')
})

check('连续两轮失败（400 后又发「继续」）→ 合并成一次', () => {
  const log = makeLog()
  const good = okTurn(log)
  const first = badTurn(log)
  const second = badTurn(log)
  const nodes = [good.user, good.asst, first.user, first.attempt, first.end, second.user, second.attempt, second.end]
  const plan = planHeal(log.events, nodes)
  is(plan.ok, true)
  is(plan.fromSeq, first.user, '起点要回到最早那次失败')
  is(plan.failedTurns, 2)
  same(plan.shadowed, nodes.slice(2), '两次失败的所有节点都要摘')
})

check('只有失败、没有成功轮 → 也能修（起点取第一轮用户消息）', () => {
  const log = makeLog()
  const bad = badTurn(log)
  const plan = planHeal(log.events, [bad.user, bad.attempt, bad.end])
  is(plan.ok, true)
  is(plan.fromSeq, bad.user)
})

check('回合还没结束 → 拒绝（先停止）', () => {
  const log = makeLog()
  const bad = badTurn(log)
  log.push('turn/start', { turn: 3 })
  log.push('user/message', { id: 'u-x' })
  const plan = planHeal(log.events, [bad.user, bad.attempt, bad.end])
  is(plan.ok, false)
  is(plan.code, 'turn-open')
})

check('没有 turn/end → 拒绝', () => {
  const log = makeLog()
  log.push('turn/start', {})
  const plan = planHeal(log.events, [2])
  is(plan.ok, false)
  is(plan.code, 'no-turn-end')
})

check('视野为空 → 拒绝（不猜）', () => {
  const log = makeLog()
  badTurn(log)
  const plan = planHeal(log.events, [])
  is(plan.ok, false)
  is(plan.code, 'empty-surface')
})

check('空日志 → 拒绝', () => {
  const plan = planHeal([], [1])
  is(plan.ok, false)
  is(plan.code, 'empty-log')
})

check('失败回合里的节点都不在视野 → 拒绝（nothing-to-shadow）', () => {
  const log = makeLog()
  okTurn(log)
  badTurn(log)
  const plan = planHeal(log.events, [2, 3])
  is(plan.ok, false)
  is(plan.code, 'nothing-to-shadow')
})

check('isFailedTurnEnd / failureText 只认 error', () => {
  is(isFailedTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), false)
  is(isFailedTurnEnd({ type: 'turn/start', data: {} }), false)
  is(isFailedTurnEnd({ type: 'turn/end', data: { reason: { kind: 'error', error: {} } } }), true)
  is(failureText({ data: { reason: { kind: 'error', error: { code: 'X', message: 'y' } } } }), 'X: y')
})

check('normalizeEvents 会按 seq 排序并丢掉脏数据', () => {
  const list = normalizeEvents([{ seq: 3, type: 'a' }, { seq: 1, type: 'b' }, { type: 'no-seq' }, null])
  same(list.map(event => event.seq), [1, 3])
})

// ---------------- 2/3. 与宿主的交互 ----------------

/** 假 session：append 时真的把 shadowed 从 surface 里拿掉（模拟宿主）。 */
function makeSession(events, nodes, options = {}) {
  const appended = []
  const session = {
    appended,
    events,
    snapshotEvents: () => events,
    surface: { nodes: [...nodes] },
    append(type, data, opts) {
      if (options.appendThrows) throw new Error('host said no')
      appended.push({ type, data, opts })
      if (!options.noEffect) {
        const drop = new Set(opts.sourceEventSeqs)
        session.surface.nodes = session.surface.nodes.filter(node => !drop.has(node))
      }
    },
  }
  return session
}

function ctxOf(session) {
  return { get: name => (name === 'sessions' ? { get: () => session } : undefined) }
}

function failedScenario() {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const nodes = [good.user, good.asst, bad.user, bad.attempt, bad.end]
  const session = makeSession(log.events, nodes)
  return { log, good, bad, nodes, session }
}

check('试运行：不改 surface、不 append', () => {
  const { session, nodes } = failedScenario()
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: true })
  is(result.ok, true)
  is(result.dryRun, true)
  is(session.appended.length, 0, '试运行不许写')
  same(session.surface.nodes, nodes, '试运行不许改视野')
  ok(result.text.includes('heal go'), '要提示怎么执行')
})

check('确认执行：append 参数正确、覆盖全部被摘节点、事后复核通过', () => {
  const { session, bad, good } = failedScenario()
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, true, JSON.stringify(result))
  is(session.appended.length, 1)
  const [call] = session.appended
  is(call.type, 'user/message')
  ok(String(call.data.id).startsWith('rewind-'), 'id 前缀要与宿主约定一致')
  ok(call.data.content.length > 0, '标记消息不能是空 content（会被上游判非法）')
  same(call.opts.sourceEventSeqs, [bad.user, bad.attempt, bad.end])
  is(call.opts.surfaceOp.op, 'replace')
  is(call.opts.surfaceOp.startSeq, bad.user)
  is(call.opts.surfaceOp.endSeq, bad.end)
  ok(!session.surface.nodes.includes(bad.user), '失败轮必须从视野消失')
  ok(session.surface.nodes.includes(good.asst), '成功轮的回答必须还在')
  ok(result.text.includes('已修好'), '要给人话结果')
})

check('宿主拒绝 append → ok:false（不许假装成功）', () => {
  const { session } = failedScenario()
  session.append = () => { throw new Error('host said no') }
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, false)
  is(result.code, 'append-failed')
})

check('宿主接受但没生效 → 复核失败', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const session = makeSession(log.events, [good.user, good.asst, bad.user, bad.attempt, bad.end], { noEffect: true })
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, false)
  is(result.code, 'verify-failed')
})

check('没有 sessions 服务 / 会话不在宿主里 → 明确报错', () => {
  const noService = healSession({ get: () => undefined }, 'sess-1', { dryRun: false })
  is(noService.code, 'no-sessions-service')
  const noLive = healSession({ get: () => ({ get: () => null }) }, 'sess-1', { dryRun: false })
  is(noLive.code, 'session-not-live')
  const noId = healSession({ get: () => ({ get: () => ({}) }) }, null, { dryRun: false })
  is(noId.code, 'no-session')
})

check('宿主不支持表面替换 → 明确报错', () => {
  const session = { snapshotEvents: () => [] }
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.code, 'no-append')
})

check('视野顺序被打乱（本轮节点排在切点之前）→ 拒绝，不乱切', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  // 真实形态：压缩/替换之后，本轮的某条节点被排到了更早的位置。
  // 按位置切会漏掉它，宿主要求区间内全覆盖 → 直接拒绝。
  const nodes = [bad.attempt, good.user, bad.user, bad.end]
  const plan = planHeal(log.events, nodes)
  is(plan.ok, false)
  is(plan.code, 'scrambled')
  ok(plan.message.includes('新建一个对话'), '要告诉用户改用什么')
})

check('顺序正常时，连续后缀 == 起点之后的全部节点', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const nodes = [good.user, good.asst, bad.user, bad.attempt, bad.end]
  const plan = planHeal(log.events, nodes)
  is(plan.ok, true)
  same(plan.shadowed, [bad.user, bad.attempt, bad.end])
  is(plan.startSeq, bad.user)
  is(plan.endSeq, bad.end)
})

check('宿主先报 missing，补上节点后重试成功', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const session = makeSession(log.events, [good.user, good.asst, bad.user, bad.attempt, bad.end])
  const realAppend = session.append.bind(session)
  let first = true
  session.append = (type, data, opts) => {
    if (first) {
      first = false
      throw new Error('surface replace: sourceEventSeqs must include every shadowed surface node; missing 2')
    }
    return realAppend(type, data, opts)
  }
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, true, JSON.stringify(result))
  is(result.attempts, 2, '应该重试一次')
  is(result.startSeq, 6, 'startSeq 不动，只往 sourceEventSeqs 里补节点')
})

check('诊断模式：完整视野写进文件，回显只给摘要（只读）', () => {
  const { session } = failedScenario()
  const home = mkdtempSync(join(tmpdir(), 'enhance-heal-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = healSession(ctxOf(session), 'sess-1', { inspect: true })
    is(result.ok, true)
    ok(result.text.includes('视野节点'), '要给出节点数')
    ok(result.text.includes('heal-dump.txt'), '要给出文件路径')
    const dump = readFileSync(join(home, 'enhance', 'heal-dump.txt'), 'utf8')
    ok(dump.includes('assistant/message'), '文件里要逐条列出节点')
    ok(dump.includes('位置'), '文件里要有位置列')
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
  is(session.appended.length, 0, '诊断不许写')
})

check('撤销上一轮：切点 = 最后一条真人消息', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const nodes = [good.user, good.asst, bad.user, bad.attempt, bad.end]
  const plan = planHeal(log.events, nodes, { fromSeq: good.user })
  is(plan.ok, true)
  is(plan.fromSeq, good.user)
  same(plan.shadowed, nodes.slice(0), '从切点一路到末尾')
  is(plan.reason, '撤销上一轮')
})

check('撤销上一轮：切点不在视野里 → 拒绝', () => {
  const log = makeLog()
  okTurn(log)
  const bad = badTurn(log)
  const plan = planHeal(log.events, [bad.user, bad.end], { fromSeq: 1 })
  is(plan.ok, false)
  is(plan.code, 'not-in-surface')
})

check('执行后清掉派生缓存（否则界面还挂着已经切掉的旧消息）', () => {
  const { session } = failedScenario()
  session.derived = [{ id: 'stale' }]
  session.derivedNodes = 99
  session.derivedGeneration = 7
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, true, JSON.stringify(result))
  same(session.derived, [])
  is(session.derivedNodes, 0)
  is(session.derivedGeneration, -1)
})

check('标记消息被滤掉，不进界面', () => {
  const { session } = failedScenario()
  session.deriveMessages = () => [
    { id: 'u-1', role: 'user' },
    { id: 'rewind-abc-3', role: 'user' },
  ]
  const result = healSession(ctxOf(session), 'sess-1', { dryRun: false })
  is(result.ok, true)
  same(session.deriveMessages().map(message => message.id), ['u-1'])
  is(session.__enhanceHealDerive, true, '只装一次，重复执行不叠加')
  healSession(ctxOf(session), 'sess-1', { dryRun: false })
  same(session.deriveMessages().map(message => message.id), ['u-1'], '叠加了也不会重复过滤出错')
})

check('挖洞：只摘夹在中间的那个失败回合，前后成功回合都留着', () => {
  const log = makeLog()
  const first = okTurn(log)
  const bad = badTurn(log)
  const third = okTurn(log)
  const nodes = [first.user, first.asst, bad.user, bad.attempt, bad.end, third.user, third.asst]
  const drops = planDrops(log.events, nodes)
  is(drops.length, 1)
  same(drops[0].shadowed, [bad.user, bad.attempt, bad.end])
  is(drops[0].startSeq, bad.user)
  is(drops[0].endSeq, bad.end)
  ok(drops[0].reason.includes('INVALID_REQUEST'), '原因要能看出来')
})

check('挖洞：失败回合的节点被打散 → 跳过，不乱切', () => {
  const log = makeLog()
  const first = okTurn(log)
  const bad = badTurn(log)
  const third = okTurn(log)
  const nodes = [first.user, first.asst, bad.user, third.user, bad.attempt, bad.end, third.asst]
  is(planDrops(log.events, nodes).length, 0, '连续性不成立就不动')
})

check('挖洞：多个失败回合按位置从后往前排', () => {
  const log = makeLog()
  const a = okTurn(log)
  const badA = badTurn(log)
  const b = okTurn(log)
  const badB = badTurn(log)
  const nodes = [a.user, a.asst, badA.user, badA.attempt, badA.end, b.user, b.asst, badB.user, badB.attempt, badB.end]
  const drops = planDrops(log.events, nodes)
  is(drops.length, 2)
  ok(drops[0].startSeq > drops[1].startSeq, '先替换靠后的那一段，前面位置才不会变')
})

check('clean 模式：没有残留就明确说没有', () => {
  const log = makeLog()
  okTurn(log)
  const session = makeSession(log.events, [1, 2, 3])
  const result = healSession(ctxOf(session), 'sess-1', { mode: 'clean', dryRun: false })
  is(result.ok, false)
  is(result.code, 'nothing-to-clean')
  is(result.empty, true, '界面靠这个标记说"已经干净了，别再点"')
  ok(result.message.includes('不会再发给模型'), '要解释界面上的红字为什么还在')
  is(session.appended.length, 0, '没什么可清就不许写')
})

check('clean 模式：试运行只报数，不写', () => {
  const log = makeLog()
  const good = okTurn(log)
  const bad = badTurn(log)
  const third = okTurn(log)
  const nodes = [good.user, good.asst, bad.user, bad.attempt, bad.end, third.user, third.asst]
  const session = makeSession(log.events, nodes)
  const result = healSession(ctxOf(session), 'sess-1', { mode: 'clean', dryRun: true })
  is(result.ok, true, JSON.stringify(result))
  is(result.drops, 1)
  is(result.removed, 3)
  is(session.appended.length, 0, '试运行不许写')
  ok(result.text.includes('clean go'), '要提示怎么执行')
})

check('挖洞：连续失败三轮合并成一处，中间不留残渣', () => {
  const log = makeLog()
  const good = okTurn(log)
  const a = badTurn(log)
  const b = badTurn(log)
  const c = badTurn(log)
  const nodes = [good.user, good.asst, a.user, a.attempt, a.end, b.user, b.attempt, b.end, c.user, c.attempt, c.end]
  const drops = planDrops(log.events, nodes)
  is(drops.length, 1, '连败要合成一处，别让人点三次')
  is(drops[0].turns, 3)
  same(drops[0].shadowed, nodes.slice(2), '从第一轮失败到最后一轮失败，中间不留孤立的 turn/start')
})

check('撤销：最后一轮连败时整组撤（点一次就恢复可用）', () => {
  const log = makeLog()
  const good = okTurn(log)
  const a = badTurn(log)
  const b = badTurn(log)
  const nodes = [good.user, good.asst, a.user, a.attempt, a.end, b.user, b.attempt, b.end]
  const session = makeSession(log.events, nodes)
  const result = healSession(ctxOf(session), 'sess-1', { mode: 'undo', dryRun: false })
  is(result.ok, true, JSON.stringify(result))
  is(session.appended.length, 1, '一次点完，不该点两次')
  is(result.failedTurns, 2, '要按轮次报数')
  same(session.surface.nodes, [good.user, good.asst], '成功那轮必须留着')
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
