/**
 * 「增强模式」的两件事，都在这个预设作用域里完成：
 *
 *  1. `enhance:mode-prompt`（系统提示段）
 *     按**本会话选中的预设**读文本，追加在系统提示最末尾。
 *     没选（没有 presets 目录 / 没记录）→ 读老的 mode-prompt.md，行为与 0.1.0 一致。
 *     每步现读文件，保存即下一次装配生效。
 *
 *  2. `enhance:project-instructions`（运行时上下文，user-role 快照）
 *     只读**项目级** AGENTS.md —— 从会话工作目录向上找 `.git` 作为项目根，
 *     按 根 → 工作目录 的顺序收集 AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md。
 *     **故意不读** $DSH_HOME/AGENTS.md 与 ~/.agents/AGENTS.md：
 *     官方 `dsh-agent-instructions` 的全局链是进程级策略、改不了，
 *     所以这个模式干脆不挂那个插件，用这里的小实现代替。
 *
 * 内容永远以文件为准：这里只决定"读哪个文件"，不做任何内容搬运。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import {
  resolveDefaultFile,
  resolveOrderFile,
  resolvePresetDir,
  resolveSessionsFile,
} from '../lib/paths.mjs'
import { ensurePresetDir, seedDefaultPresets } from '../lib/store.mjs'
import { resolveEnhanceText } from '../lib/presets.mjs'
import { reconcilePresets } from '../lib/rebind.mjs'
import { getChoice, markSession, readState } from '../lib/sessions.mjs'
import { registerTool } from '../lib/tool.mjs'
import { registerCommand } from '../lib/command.mjs'

export const name = 'enhance-mode-prompt'

/**
 * 硬依赖：`systemPrompt`（提示词段）+ `tools`（助手工具）。
 *
 * `tools` 和官方工具插件写法一致（`@deepseek-ai/dsh-tool-todo` 就是
 * `inject = ['tools', 'sessionProjections']`），同一个预设里已经有一行靠它注册成功，
 * 所以这里必然能满足。**不要**把 `commands` 写进来：它只服务斜杠命令，
 * 写进来就成了硬依赖，宿主没提供时激活审计会算 pending，整行失败。
 * `workingDirectory` 同样用运行期 `ctx.get()`，缺了也照常工作。
 */
export const inject = ['systemPrompt', 'tools']

/** 自定义文本段：与官方段不同名，避免任何同名碰撞。 */
const SECTION_NAME = 'enhance:mode-prompt'
/** 项目指令上下文。 */
const CONTEXT_NAME = 'enhance:project-instructions'

/** 官方 persona suffix 是 10200；加 100 落在它之后，留出未来插空的余量。 */
const ORDER_AFTER_PERSONA_SUFFIX = 100
/** 宿主没提供 getSectionOrder 时的兜底。 */
const FALLBACK_SECTION_ORDER = 10300
/** 运行时上下文里排在 WORKING_DIRECTORY(100) / SANDBOX(110) / APPROVAL(115) / SUBAGENT(120) 之后。 */
const FALLBACK_CONTEXT_ORDER = 130

/** 项目级候选文件：基础文件 + 本地覆盖。 */
const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/** 默认 64 KB 预算，和官方默认一致。 */
const DEFAULT_MAX_INSTRUCTION_BYTES = 65536

/** 出错时的一句话；给日志用，永远不该把异常再抛出去。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 打一条警告；console 不可用时保持安静。 */
function warn(text) {
  try {
    console.warn(`[enhance-mode] ${text}`)
  } catch {
    // 无所谓
  }
}

/**
 * 等服务就绪后执行回调。
 *
 * 宿主没有 `ctx.inject` 时退化为"立刻执行"——里面全程只用 `ctx.get()` 读服务，
 * 服务缺席只会让入口降级（界面显示暂不可用），不会让这一行激活失败。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} services 需要就绪的服务名
 * @param {(child: import('@deepseek-ai/cordis').Context) => void} callback
 */
function whenReady(ctx, services, callback) {
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(services, callback)
      return
    }
  } catch (error) {
    warn(`ctx.inject 不可用，改为立即注册：${messageOf(error)}`)
  }
  try {
    callback(ctx)
  } catch (error) {
    warn(`入口注册失败：${messageOf(error)}`)
  }
}

/**
 * 首次生成默认文本文件时的**示例**：一句能立刻看出效果的话。
 * 用户把它改成自己的内容即可；文件已存在时不会被覆盖。
 */
const PLACEHOLDER = [
  '每次回答每段话之后都要以一个“喵”字结尾。',
  '',
].join('\n')

/**
 * 从装配上下文里取会话 id。取不到返回 null → 该轮退回默认预设。
 * 宿主把 Session 挂在 `assembly.agent.session` 上；不同版本可能是字符串或对象。
 * @param {{ agent?: { session?: unknown } } | undefined} assembly
 * @returns {string | null}
 */
export function sessionIdOf(assembly) {
  const session = assembly?.agent?.session
  if (typeof session === 'string' && session !== '') return session
  if (session !== null && typeof session === 'object') {
    const id = session.id ?? session.sessionId
    if (typeof id === 'string' && id !== '') return id
  }
  return null
}

/** 文件不存在时创建目录和占位文本；失败不阻断装配（只读盘、无权限等）。 */
function ensureFile(file) {
  try {
    if (existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, PLACEHOLDER, 'utf8')
  } catch {
    // 故意吞掉：装不上文本文件不该让整个预设挂掉
  }
}

/** 每个会话最多记多少条"上次生效的文案"。 */
const MAX_CACHED_SESSIONS = 200

/** 两次"改名对账"之间至少隔这么久，避免一个真删掉的预设让每一步都扫目录。 */
const REBIND_INTERVAL_MS = 2000

/** 取"官方最末尾"那个顺序号。 */
function resolveSectionOrder(ctx) {
  try {
    if (typeof ctx.systemPrompt.getSectionOrder === 'function') {
      const suffix = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
      if (Number.isFinite(suffix)) return suffix + ORDER_AFTER_PERSONA_SUFFIX
    }
  } catch {
    // 宿主版本里没有这个常量名时走兜底
  }
  return FALLBACK_SECTION_ORDER
}

function resolveContextOrder(ctx) {
  try {
    if (typeof ctx.systemPrompt.getContextOrder === 'function') {
      const working = ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY')
      if (Number.isFinite(working)) return working + 30
    }
  } catch {
    // 同上
  }
  return FALLBACK_CONTEXT_ORDER
}

/** 从工作目录向上找含 `.git` 的目录；找不到就以工作目录为根（不把无关的上级卷进来）。 */
function findProjectRoot(cwd) {
  let dir = cwd
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (existsSync(join(dir, '.git'))) return dir
    } catch {
      return cwd
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return cwd
}

/** root → cwd（含两端）的目录链。 */
function directoryChain(root, cwd) {
  const chain = [cwd]
  let dir = cwd
  while (dir !== root) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    chain.unshift(dir)
  }
  return chain
}

/** 模型看到的路径标签：相对项目根，统一用 `/`。 */
function displayPath(root, file) {
  const rel = relative(root, file)
  return (rel === '' ? file : rel).replaceAll('\\', '/')
}

/**
 * 收集项目级指令文件。（导出仅为可离线单测；宿主不会直接调用。）
 * @returns {{ label: string, text: string }[]}
 */
export function collectInstructions(cwd, maxBytes) {
  const root = findProjectRoot(cwd)
  const files = []
  const seen = new Set()
  for (const dir of directoryChain(root, cwd)) {
    for (const candidate of [...PROJECT_CANDIDATES, ...LOCAL_CANDIDATES]) {
      const file = join(dir, candidate)
      let info
      try {
        info = statSync(file)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      let text
      try {
        text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      } catch {
        continue
      }
      const trimmed = text.trim()
      if (trimmed === '') continue
      // 和官方一致：同一候选组里内容相同就只保留最前面那份
      if (seen.has(trimmed)) continue
      seen.add(trimmed)
      files.push({ label: displayPath(root, file), text: trimmed })
    }
  }

  const kept = []
  let budget = maxBytes
  for (const file of files) {
    const bytes = Buffer.byteLength(file.text, 'utf8')
    if (bytes <= budget) {
      kept.push(file)
      budget -= bytes
      continue
    }
    if (budget > 512) {
      // 留一点预算做截断，并明确告诉模型"这被截断了"
      const head = Buffer.from(file.text, 'utf8').subarray(0, budget - 200).toString('utf8')
      kept.push({ label: file.label, text: `${head}\n\n[... truncated to fit the ${maxBytes}-byte budget ...]` })
    }
    break
  }
  return kept
}

/** 把收集到的文件渲染成一条 <system-reminder>。（导出仅为可离线单测。） */
export function renderInstructions(files) {
  if (files.length === 0) return ''
  const sections = files.map(file => `Instructions from: ${file.label}\n\n${escapeFrame(file.text)}`)
  return [
    '<system-reminder>',
    'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.',
    '',
    sections.join('\n\n'),
    '</system-reminder>',
  ].join('\n')
}

/** 项目文件是仓库内容，可能包含能提前闭合 frame 的字面量。 */
function escapeFrame(text) {
  return text.replaceAll('</system-reminder>', '<\\/system-reminder>')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 预设作用域内的上下文
 * @param {{
 *   file?: string,
 *   dir?: string,
 *   presetDir?: string,
 *   sessionsFile?: string,
 *   projectInstructions?: boolean | { maxBytes?: number },
 * }} [config] 预设里那一行的 config
 */
export function apply(ctx, config = {}) {
  const defaultFile = resolveDefaultFile(config)
  const presetDir = resolvePresetDir(config)
  const sessionsFile = resolveSessionsFile(config)
  const orderFile = resolveOrderFile(config)

  ensureFile(defaultFile)
  // 目录建出来，用户才知道该往哪放预设；再按需种下三套示例。
  // 种下的条件很保守：目录里一个 .md 都没有、也没有 .seeded 标记（见 lib/store.mjs）。
  ensurePresetDir(presetDir)
  seedDefaultPresets(presetDir)

  /**
   * 每个会话上一次真正生效的文案。
   *
   * 用途只有一个：选中的那套文件被删/改名之后，这一轮继续用同样的文案，
   * 而不是突然换成 `mode-prompt.md` 里的另一句话（那看起来就像插件抽风）。
   * 必须是**按会话**的——0.5.0 之前它是一个进程级变量，A 会话的文案会漏给 B。
   */
  const lastBySession = new Map()
  let lastScanAt = 0

  function remember(sessionId, text) {
    lastBySession.set(sessionId, text)
    if (lastBySession.size > MAX_CACHED_SESSIONS) {
      const oldest = lastBySession.keys().next()
      if (oldest.done !== true) lastBySession.delete(oldest.value)
    }
  }

  /**
   * 选中的预设找不到了，才去对账（认改名）。节流，免得真删掉时每一步都扫目录。
   * @returns {boolean} 是否认出了改名
   */
  function reconcileIfNeeded() {
    const now = Date.now()
    if (now - lastScanAt < REBIND_INTERVAL_MS) return false
    lastScanAt = now
    try {
      return reconcilePresets({ presetDir, indexFile: orderFile, sessionsFile }).pairs.length > 0
    } catch {
      return false
    }
  }

  // ---- 1. 自定义文本：系统提示最末尾 ----
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolveSectionOrder(ctx),
    // 任意散文：`{{` 必须保持字面
    interpolate: false,
    text: (assembly) => {
      const sessionId = sessionIdOf(assembly)
      // 记一笔"这个会话确实在增强模式里装配过"，界面靠它决定是否显示胶囊。
      // 只写一次，之后每步只是一个 stat，开销可忽略。
      if (sessionId !== null) markSession(sessionsFile, sessionId)
      const cached = sessionId === null ? '' : (lastBySession.get(sessionId) ?? '')
      let choice = sessionId === null ? null : getChoice(readState(sessionsFile), sessionId)
      let resolved = resolveEnhanceText({
        presetDir,
        defaultFile,
        choice,
        lastGood: cached,
      })
      // 选中的文件不见了：先看看是不是用户在文件夹里改了名，认回来接着用
      if (resolved.missing && sessionId !== null && reconcileIfNeeded()) {
        choice = getChoice(readState(sessionsFile), sessionId)
        resolved = resolveEnhanceText({ presetDir, defaultFile, choice, lastGood: cached })
      }
      if (resolved.source === 'preset' && sessionId !== null) remember(sessionId, resolved.text)
      return resolved.text
    },
  }), 'enhance-mode-prompt.section()')

  // ---- 3. 助手工具（与官方工具行完全一致的写法） ----
  //
  // `tools` 写进 inject 是**官方每一行工具插件都这么做的**
  // （如 @deepseek-ai/dsh-tool-todo：`export const inject = ['tools', ...]`），
  // 它在这个预设作用域里一定解析得到——同一个预设里的 tool-todo 就是靠它注册的。
  // 用 ctx.tools 需要 inject 里有 tools，否则就是上一版那个 Proxy 抛错。
  ctx.effect(() => {
    try {
      const dispose = registerTool(ctx, config)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      warn(`工具注册失败（模型暂时没有 enhance_preset）：${messageOf(error)}`)
      return () => {}
    }
  }, 'enhance-mode-prompt.tool()')

  // ---- 4. 斜杠命令（可选：宿主没有 commands 服务就只是少这一个入口） ----
  whenReady(ctx, ['commands'], (child) => {
    child.effect(() => {
      try {
        const dispose = registerCommand(child, config)
        return typeof dispose === 'function' ? dispose : () => {}
      } catch (error) {
        warn(`命令注册失败（不影响提示词）：${messageOf(error)}`)
        return () => {}
      }
    }, 'enhance-mode-prompt.command()')
  })

  // ---- 2. 项目级 AGENTS.md：user-role 运行时上下文 ----
  const settings = config.projectInstructions
  if (settings === false) return
  const maxBytes = typeof settings === 'object' && Number.isFinite(settings?.maxBytes)
    ? settings.maxBytes
    : DEFAULT_MAX_INSTRUCTION_BYTES

  ctx.effect(() => ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: resolveContextOrder(ctx),
    interpolate: false,
    text: (assembly) => {
      const agent = assembly?.agent
      if (agent === undefined) return ''
      try {
        const workingDirectory = ctx.get('workingDirectory')
        if (workingDirectory === undefined) return ''
        const cwd = workingDirectory.get(agent.session)
        return renderInstructions(collectInstructions(cwd, maxBytes))
      } catch {
        // 读盘出错不该让整轮装配失败：这一轮不带项目指令
        return ''
      }
    },
  }), 'enhance-mode-prompt.projectInstructions()')
}