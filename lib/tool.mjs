/**
 * 助手工具 `enhance_preset`：让模型也能"列出 / 查看 / 切换 / 新建 / 修改"预设。
 *
 * 与界面共用 `lib/actions.mjs` 的同一批动作，不写第二份逻辑。
 *
 * 注册方式是"裸定义对象"：DSH 的 `defineTool()` 只是把 options 包一层适配，
 * 而宿主的 `@deepseek-ai/dsh-tools` 在 profile 里解析不到（插件跑在 profile，
 * 宿主包在安装目录），所以这里不复用它的 helper。注册失败只降级为"没有工具"，
 * 绝不能因此让整个预设装不上。
 */

import { createPresetActions } from './actions.mjs'
import { resolveDefaultFile, resolveOrderFile, resolvePresetDir, resolveSessionsFile } from './paths.mjs'
import { safeService } from './services.mjs'

/** 工具名。 */
export const TOOL_NAME = 'enhance_preset'

/** 给会话标题加的标识前缀（用户要求"前面写上增强模式"）。 */
export const TITLE_PREFIX = '增强模式 · '

/**
 * 造一个"给当前会话标题加标识"的函数。
 *
 * 为什么是**按需触发**而不是自动改：DSH 的标题只能由一个 provider 生成
 * （`sessionTitle.register()` 是单例，官方 LLM 标题插件已经占了），
 * 想自动加前缀就只能监听 `session/title` 再追加一条，容易和自动生成、
 * 用户手动改名打架。所以我们只提供一个显式动作，用户想标就标。
 *
 * 服务通过 `ctx.get()` 取：会话标题服务不在本行 inject 里，属性访问会抛。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {(invocation: { agent?: { session?: unknown } }) => Record<string, unknown>}
 */
export function createTitleRenamer(ctx) {
  return invocation => {
    const sessionTitle = safeService(ctx, 'sessionTitle')
    if (sessionTitle === undefined || typeof sessionTitle.rename !== 'function') {
      return { ok: false, code: 'unavailable', message: '宿主没有会话标题服务（sessionTitle），这一版无法改名。' }
    }
    const session = invocation?.agent?.session
    if (session === null || typeof session !== 'object') {
      return { ok: false, code: 'unavailable', message: '拿不到当前会话对象，无法改名。' }
    }
    let currentTitle = ''
    try {
      currentTitle = sessionTitle.get(session)?.title ?? ''
    } catch {
      currentTitle = ''
    }
    if (currentTitle.startsWith('增强模式')) return { ok: true, title: currentTitle, message: '标题已经带标识了。' }
    const next = currentTitle === '' ? '增强模式' : `${TITLE_PREFIX}${currentTitle}`
    try {
      const snapshot = sessionTitle.rename(session, next)
      return { ok: true, title: snapshot?.title ?? next }
    } catch (error) {
      return { ok: false, code: 'io', message: `改名失败：${error?.message ?? error}` }
    }
  }
}

/** 从 exec 里取会话 id（字符串或对象两种形态都认）。 */
export function sessionIdFromExec(exec) {
  const session = exec?.agent?.session
  if (typeof session === 'string' && session !== '') return session
  if (session !== null && typeof session === 'object') {
    const id = session.id ?? session.sessionId
    if (typeof id === 'string' && id !== '') return id
  }
  return null
}

const DESCRIPTION = [
  '查看或切换本次对话使用的「增强模式」预设。',
  '预设是几段追加在系统提示词末尾的文本，线性存放在 $DSH_HOME/enhance/presets/*.md。',
  'action=list 列出全部（含标题、描述、字数、是否正在被本对话使用）；',
  'current 查当前用的哪套；use 切换本对话到指定预设（只影响本对话）；',
  'create 新建一套；update 修改一套的标题/描述/正文；',
  'rename 给当前对话标题加上「增强模式 · 」前缀（方便在会话列表里认出来）。',
  '切换或修改后会重新注入系统提示词，可能导致当前缓存命中失效。',
].join('')

/**
 * 工具参数表：**已经是 JSON Schema 形态**，不是"友好写法"。
 *
 * 宿主 `tools.register()` 只认 `ToolDefinition`（参数是纯 JSON Schema），
 * 友好写法（每个字段里写 `required: true`）要经过 `defineTool()` 的
 * `parameterSchemaSpecToJsonSchema()` 才会变成这个样子。而 `defineTool` 在
 * profile 里**解析不到**（宿主包住在安装目录的 asar 里，插件跑在 profile），
 * 所以这里直接写转换后的形态，等价于 `defineTool` 会产出的结果。
 *
 * 若写回友好写法：`register()` 里的 `assertSupportedJsonSchema` 不校验参数，
 * 参数会带着非法关键字被投影，行为不可预期。
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'current', 'use', 'create', 'update', 'rename'],
      description: '要执行的动作。list / current 只读，不改变任何状态。rename = 给当前对话标题加上「增强模式 · 」前缀。',
    },
    id: {
      type: 'string',
      description: '预设文件名（形如 `喵.md`）。use / update 必填，create 可省略（按名字自动生成）。',
    },
    name: {
      type: 'string',
      description: '预设的名字 = 文件名（不带 .md）。create 省略时叫「未命名预设」；update 省略时保持原名，改了就重命名文件。',
    },
    description: {
      type: 'string',
      description: '一句话介绍（显示在预设列表里）。省略时由正文首段自动截取；超过 120 字在界面上会被截断显示。',
    },
    body: {
      type: 'string',
      description: '要追加到系统提示词末尾的正文，原样写入，不需要转义。',
    },
  },
  required: ['action'],
}

/**
 * 输出契约的 schema：同样是转换后的 JSON Schema。
 *
 * ⚠️ 这一块是 0.2.0 里"工具根本不存在"的真正原因：`tools.register()` 第一件事就是
 * `assertSupportedJsonSchema(output.schema)`，而旧写法把 `required: true` 写在每个
 * 属性**里面**，宿主直接抛
 * `JsonSchemaError: schema.properties.ok.required is not supported on type "boolean"`，
 * 注册随之作废（被本文件的 try/catch 吞掉，只留一条 console.warn）。
 * 正确写法：属性里不写 `required`，在对象层写 `required: ['ok']`。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '操作是否成功。' },
    code: { type: 'string', description: '失败时的原因码。' },
    message: { type: 'string', description: '失败时的中文说明。' },
  },
  required: ['ok'],
}

/**
 * 纯定义：便于离线单测（不依赖宿主）。
 * @param {{ presetDir: string, defaultFile: string, sessionsFile: string }} paths
 * @param {{ renameSession?: (invocation: unknown) => Record<string, unknown> }} [options]
 *   改名能力由宿主提供，离线测试可不传（此时 rename 返回 unavailable）
 */
export function createToolDefinition(paths, options = {}) {
  const actions = createPresetActions(paths)
  const renameSession = options.renameSession

  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    async execute(args, exec) {
      const sessionId = sessionIdFromExec(exec)
      const action = args?.action
      switch (action) {
        case 'list':
          return actions.list({ sessionId })
        case 'current':
          return actions.current({ sessionId })
        case 'use':
          return actions.use({ sessionId, id: args?.id })
        case 'create':
          return actions.create({ name: args?.name, description: args?.description, body: args?.body })
        case 'update':
          return actions.update({
            id: args?.id,
            name: args?.name,
            description: args?.description,
            body: args?.body,
          })
        case 'rename':
          if (typeof renameSession !== 'function') {
            return { ok: false, code: 'unavailable', message: '宿主没有提供改名能力。' }
          }
          return renameSession(exec)
        default:
          return { ok: false, code: 'bad-action', message: `未知的 action：${String(action)}` }
      }
    },
    presentCall(args) {
      return { card: 'generic', title: '增强模式预设', kind: 'other', rawInput: args }
    },
  }
}

/** 把结果压成一段给模型看的短文本（不 dump 全文）。 */
export function summarize(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) return `失败（${value.code}）：${value.message}`
  if (Array.isArray(value.items)) {
    const lines = value.items.map(item => {
      const used = item.inUse > 0 ? ` · ${item.inUse} 个对话在用` : ''
      return `- ${item.name}｜${item.chars} 字${used}${item.description ? `｜${item.description}` : ''}`
    })
    const current = value.current === null ? '默认预设（mode-prompt.md）' : value.current
    return [`共 ${value.total} 套；当前：${current}`, ...lines].join('\n')
  }
  if (typeof value.current === 'string' || value.current === null) {
    return `当前：${value.current ?? '默认预设'}`
  }
  if (typeof value.name === 'string') return `已处理：${value.name}`
  if (typeof value.id === 'string') return `已处理：${value.id}`
  return JSON.stringify(value)
}

/**
 * 注册到宿主。失败只降级（返回 null 并打一条警告），不影响预设本身。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ file?: string, dir?: string, presetDir?: string, sessionsFile?: string }} config
 */
export function registerTool(ctx, config = {}) {
  try {
    const tools = safeService(ctx, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') return null
    const definition = createToolDefinition({
      presetDir: resolvePresetDir(config),
      defaultFile: resolveDefaultFile(config),
      sessionsFile: resolveSessionsFile(config),
      orderFile: resolveOrderFile(config),
    }, { renameSession: createTitleRenamer(ctx) })
    return tools.register(definition) ?? null
  } catch (error) {
    // 工具装不上不该连累提示词段：用户仍可只用界面手动切
    try {
      console.warn(`[enhance-mode] 工具 ${TOOL_NAME} 注册失败：${error?.message ?? error}`)
    } catch {
      // console 不可用就彻底安静
    }
    return null
  }
}