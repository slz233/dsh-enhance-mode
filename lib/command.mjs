/**
 * 宿主侧斜杠命令 `/enhance`：不用等界面，直接在输入框里切预设。
 *
 * 用法（在「增强模式」的对话里输入）：
 *
 *   /enhance            看当前用的是哪套
 *   /enhance list       列出全部预设
 *   /enhance use 喵      把**本次对话**切到这一套
 *   /enhance reset      回到默认文案（mode-prompt.md）
 *   /enhance read 喵     看某套的正文
 *   /enhance rename     给这个对话的标题加「增强模式」标识
 *   /enhance heal       试运行：把失败的回合从上下文里摘掉（不写盘）
 *   /enhance heal go    确认执行（上游 400 之后救活这条会话）
 *
 * 命令名必须匹配 `^[a-z][a-z0-9_-]*$`（宿主 `COMMAND_NAME` 正则），
 * 所以是 `enhance` 而不是带斜杠/带路径的写法；旧版的 `enhance-mode/preset`
 * 会被宿主判为非法名字，注册直接抛错。
 *
 * 注册失败只降级（返回 null 并打一条警告），绝不影响提示词段。
 */

import { createPresetActions } from './actions.mjs'
import { healSession } from './heal.mjs'
import { resolveDefaultFile, resolveOrderFile, resolvePresetDir, resolveSessionsFile } from './paths.mjs'
import { safeService } from './services.mjs'
import { sessionIdFromExec, summarize, createTitleRenamer } from './tool.mjs'

/** 命令名（不含前导斜杠）。 */
export const COMMAND_NAME = 'enhance'

/** 一句话说明，显示在斜杠菜单里。 */
export const COMMAND_DESCRIPTION = '切换本次对话的「增强模式」预设'

/** 输入提示。 */
export const COMMAND_HINT = 'list | use <预设> | reset | read <预设> | rename | heal [go|undo [go]|nodes]'

/**
 * 把 `rawInput` 解析成 `lib/actions.mjs` 的调用参数。
 * 空输入 = 查当前状态。
 * @param {string} rawInput 命令名之后的原文（宿主会带上分隔空格）
 * @param {string | null} sessionId
 * @returns {{ action: string, sessionId?: string, id?: string } & Record<string, unknown>}
 */
export function parseInput(rawInput, sessionId) {
  const text = typeof rawInput === 'string' ? rawInput.trim() : ''
  const base = sessionId === null ? {} : { sessionId }
  if (text === '') return { action: 'status', ...base }

  const [verb, ...rest] = text.split(/\s+/u)
  const argument = rest.join(' ').trim()
  switch (verb) {
    case 'list':
      return { action: 'list', ...base }
    case 'current':
    case 'status':
      return { action: 'status', ...base }
    case 'use':
    case 'switch':
      return { action: 'use', ...base, id: argument }
    case 'reset':
    case 'default':
      return { action: 'reset', ...base }
    case 'read':
    case 'show':
      return { action: 'read', id: argument }
    case 'rename':
    case 'title':
      return { action: 'rename' }
    case 'heal':
    case 'fix':
    case 'undo': {
      const tokens = argument === '' ? [] : argument.split(/\s+/u)
      // 只读诊断：把真实的视野顺序写进文件
      if (tokens.includes('nodes') || tokens.includes('inspect')) {
        return { action: 'heal', ...base, inspect: true, dryRun: true }
      }
      const undoVerb = verb === 'undo' || tokens.includes('undo') || tokens.includes('last')
      const cleanVerb = tokens.includes('clean') || tokens.includes('drop')
      // 默认只试运行；加 go / now / --yes 才真的改上下文
      const confirmed = tokens.includes('go') || tokens.includes('now') || tokens.includes('--yes')
      return {
        action: 'heal',
        ...base,
        ...(cleanVerb ? { mode: 'clean' } : (undoVerb ? { mode: 'undo' } : {})),
        dryRun: !confirmed,
      }
    }
    default:
      // 直接写预设名也当切换：/enhance 02-汪
      return { action: 'use', ...base, id: text }
  }
}

/**
 * 把动作结果压成斜杠命令的返回形态。
 * @param {Record<string, unknown>} value `lib/actions.mjs` 的返回值
 * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }}
 */
export function toCommandResult(value) {
  const text = summarize(value)
  if (value !== null && typeof value === 'object' && value.ok === false) return { kind: 'error', text }
  return { kind: 'success', text }
}

/**
 * 派发一次斜杠命令。
 * @param {ReturnType<typeof createPresetActions>} actions
 * @param {{ rawInput?: string, agent?: { session?: unknown } }} invocation
 */
export function runCommand(actions, invocation, extras = {}) {
  const payload = parseInput(invocation?.rawInput, sessionIdFromExec({ agent: invocation?.agent }))
  if (payload.action === 'heal') {
    if (typeof extras.heal !== 'function') {
      return { kind: 'error', text: '修复能力不可用：宿主没有会话服务。' }
    }
    let value
    try {
      value = extras.heal(payload)
    } catch (error) {
      return { kind: 'error', text: `修复失败：${error?.message ?? error}` }
    }
    const text = typeof value?.text === 'string' ? value.text : (typeof value?.message === 'string' ? value.message : '没有结果')
    return { kind: value?.ok === false ? 'error' : 'success', text }
  }
  if (payload.action === 'rename') {
    if (typeof extras.renameSession !== 'function') {
      return { kind: 'error', text: '改名能力不可用：宿主没有会话标题服务。' }
    }
    try {
      return toCommandResult(extras.renameSession(invocation))
    } catch (error) {
      return { kind: 'error', text: `改名失败：${error?.message ?? error}` }
    }
  }
  try {
    return toCommandResult(dispatch(actions, payload))
  } catch (error) {
    return { kind: 'error', text: `执行失败：${error?.message ?? error}` }
  }
}

/**
 * 把 action 落到具体函数上（命令与工具共用同一批动作）。
 * @param {ReturnType<typeof createPresetActions>} actions
 * @param {{ action: string } & Record<string, unknown>} payload
 */
export function dispatch(actions, payload) {
  switch (payload.action) {
    case 'list':
      return actions.list({ sessionId: payload.sessionId })
    case 'current':
      return actions.current({ sessionId: payload.sessionId })
    case 'status':
      return actions.status({ sessionId: payload.sessionId })
    case 'use':
      return actions.use({ sessionId: payload.sessionId, id: payload.id })
    case 'reset':
      return actions.reset({ sessionId: payload.sessionId })
    case 'read':
      return actions.read({ id: payload.id })
    case 'create':
      return actions.create({
        name: payload.name,
        description: payload.description,
        body: payload.body,
      })
    case 'update':
      return actions.update({
        id: payload.id,
        name: payload.name,
        description: payload.description,
        body: payload.body,
        expectedMtimeMs: payload.expectedMtimeMs,
      })
    case 'saveAs':
      return actions.saveAs({ id: payload.id, name: payload.name })
    case 'remove':
      return actions.remove({ id: payload.id })
    default:
      return { ok: false, code: 'bad-action', message: `未知的 action：${String(payload.action)}` }
  }
}

/**
 * 注册斜杠命令。失败返回 null（界面只是少一个入口，提示词照常工作）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ file?: string, dir?: string, presetDir?: string, sessionsFile?: string }} config
 */
export function registerCommand(ctx, config = {}) {
  try {
    const registry = safeService(ctx, 'commands')
    if (registry === undefined || typeof registry.register !== 'function') {
      warn(`没有找到命令注册入口（commands.register），/^(${COMMAND_NAME}) 不注册`)
      return null
    }

    const actions = createPresetActions({
      presetDir: resolvePresetDir(config),
      defaultFile: resolveDefaultFile(config),
      sessionsFile: resolveSessionsFile(config),
      orderFile: resolveOrderFile(config),
    })

    const disposer = registry.register({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      input: { hint: COMMAND_HINT },
      handler: invocation => runCommand(actions, invocation, {
        renameSession: createTitleRenamer(ctx),
        heal: payload => healSession(ctx, payload.sessionId ?? null, {
          dryRun: payload.dryRun !== false,
          inspect: payload.inspect === true,
          mode: payload.mode === 'undo' || payload.mode === 'clean' ? payload.mode : 'auto',
        }),
      }),
    })
    return typeof disposer === 'function' ? disposer : null
  } catch (error) {
    warn(`命令注册失败：${error?.message ?? error}`)
    return null
  }
}

function warn(message) {
  try {
    console.warn(`[enhance-mode] ${message}`)
  } catch {
    // console 不可用时保持安静
  }
}
