/**
 * 路径与标识校验：所有"用户给的字符串 → 磁盘路径"的转换都收在这一处。
 *
 * 规则只有一条核心：**预设标识必须是一个普通的 .md 文件名**，
 * 不许带目录、不许带盘符、不许 `..`、不许落在 `_trash` 里。
 * 校验失败一律抛错，调用方必须把错误原文显示给用户，不允许静默降级。
 */

import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, sep } from 'node:path'

/** 软删除目录名：不参与列表、不生成模式行。 */
export const TRASH_DIR = '_trash'

/** 预设文件后缀。 */
export const PRESET_EXT = '.md'

/** 文件名长度上限（Windows 全路径 260 限制的余量足够）。 */
const MAX_ID_LENGTH = 120

/** Windows 不许出现在文件名里的字符 + 控制字符。 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[<>:"|?*\u0000-\u001f]/

/**
 * 本机 DSH_HOME：宿主进程带环境变量；从普通 launch 里跑时退回 ~/.dsh。
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 增强模式的根目录：`$DSH_HOME/enhance`。
 * config.dir 优先（给测试和特殊布局用）。
 */
export function resolveEnhanceDir(config = {}, env = process.env) {
  if (typeof config.dir === 'string' && config.dir.trim() !== '') return config.dir
  return join(resolveHome(env), 'enhance')
}

/**
 * 默认预设（老文件）路径，优先级：config.file > $DSH_ENHANCE_MODE_PROMPT > enhance/mode-prompt.md
 */
export function resolveDefaultFile(config = {}, env = process.env) {
  if (typeof config.file === 'string' && config.file.trim() !== '') return config.file
  const fromEnv = env.DSH_ENHANCE_MODE_PROMPT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(resolveEnhanceDir(config, env), 'mode-prompt.md')
}

/**
 * 预设目录：`enhance/presets`，可由 config.presetDir 覆盖。
 */
export function resolvePresetDir(config = {}, env = process.env) {
  if (typeof config.presetDir === 'string' && config.presetDir.trim() !== '') return config.presetDir
  return join(resolveEnhanceDir(config, env), 'presets')
}

/**
 * 会话选择记录文件：`enhance/sessions.json`。
 */
export function resolveSessionsFile(config = {}, env = process.env) {
  if (typeof config.sessionsFile === 'string' && config.sessionsFile.trim() !== '') return config.sessionsFile
  return join(resolveEnhanceDir(config, env), 'sessions.json')
}

/**
 * 预设内部排序表：`enhance/presets-order.json`（只给界面用，不改文件名）。
 */
export function resolveOrderFile(config = {}, env = process.env) {
  if (typeof config.orderFile === 'string' && config.orderFile.trim() !== '') return config.orderFile
  return join(resolveEnhanceDir(config, env), 'presets-order.json')
}

/**
 * 校验预设标识（文件名）。合法返回 null，非法返回人话原因。
 * @param {unknown} id
 * @returns {string | null}
 */
export function presetIdProblem(id) {
  if (typeof id !== 'string') return '预设标识必须是字符串'
  const name = id.trim()
  if (name === '') return '预设标识不能为空'
  if (name !== id) return '预设标识首尾不能有空格'
  if (name.length > MAX_ID_LENGTH) return `预设标识过长（上限 ${MAX_ID_LENGTH} 字符）`
  if (isAbsolute(name)) return '预设标识不能是绝对路径'
  if (name.includes('/') || name.includes('\\') || name.includes(sep)) return '预设标识不能包含目录分隔符'
  if (name === '.' || name === '..' || name.includes('..')) return '预设标识不能包含 “..”'
  if (name.startsWith('.')) return '预设标识不能以 “.” 开头'
  if (name.startsWith('_')) return '以下划线开头的文件被保留（例如 _trash）'
  if (ILLEGAL_CHARS.test(name)) return '预设标识含有文件名不允许的字符'
  if (basename(name) !== name) return '预设标识只能是文件名'
  if (normalize(name) !== name) return '预设标识含有会被规范化的片段'
  if (!name.toLowerCase().endsWith(PRESET_EXT)) return `预设标识必须以 ${PRESET_EXT} 结尾`
  return null
}

/** 是否合法预设标识。 */
export function isPresetId(id) {
  return presetIdProblem(id) === null
}

/**
 * 文件名比较：中文按拼音、数字按大小。
 *
 * 纯字符串比较会把 `未命名预设-10` 排在 `未命名预设-2` 前面（"1" < "2"），
 * 一堆 `未命名预设-N` 的时候看着就是乱的。`numeric: true` 让数字段按数值比。
 */
export function compareIds(left, right) {
  return String(left).localeCompare(String(right), 'zh-Hans-CN', { numeric: true })
}

/**
 * 标识 → 绝对路径。非法标识直接抛错（带原因），不做任何"纠正"。
 * @param {string} presetDir
 * @param {string} id
 */
export function presetPath(presetDir, id) {
  const problem = presetIdProblem(id)
  if (problem !== null) throw new Error(`非法的预设标识「${String(id)}」：${problem}`)
  const file = join(presetDir, id)
  // 双保险：拼出来的路径必须仍在预设目录下
  const normalizedDir = normalize(presetDir).toLowerCase().replace(/[\\/]+$/, '')
  const normalizedFile = normalize(file).toLowerCase()
  if (!normalizedFile.startsWith(`${normalizedDir}${sep}`) && normalizedFile !== normalizedDir) {
    throw new Error(`非法的预设标识「${String(id)}」：路径越界`)
  }
  return file
}

/**
 * 由名字生成一个可用文件名：`名字.md`，重名就 `名字-2.md`。
 *
 * 不再自动加 `01-`、`04-` 这种序号：顺序归 `presets-order.json`（界面里的排序框），
 * 文件名归用户。两套编号同时存在时，人看到 `03-` 却排在第一位只会更糊涂。
 * 老文件里的 `01-` 前缀照读（名字就是 `01-喵`），只是不再生成。
 * @param {string} presetDir 保留给未来的"按目录去重"用，现在不读盘
 * @param {string} name 用户起的名字（不含 .md）
 * @param {string[]} [existing] 现有文件名（省一次读盘）
 */
export function makePresetId(presetDir, name, existing = []) {
  const stem = normalizePresetName(name)
  const used = new Set(existing.map(entry => entry.toLowerCase()))

  const direct = `${stem}${PRESET_EXT}`
  if (!used.has(direct.toLowerCase())) return direct

  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${stem}-${index}${PRESET_EXT}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  // 极端情况：同一个名字有 999 份，退回时间戳
  return `${stem}-${Date.now()}${PRESET_EXT}`
}

/** 名字长度上限（含 .md 全名 120 的余量）。 */
const MAX_NAME_LENGTH = 100

/** Windows 保留设备名，建成文件会直接失败。 */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 名字的规范化：去首尾空格、去掉用户顺手写上的 `.md`。
 * @param {unknown} name
 */
export function normalizePresetName(name) {
  const text = String(name ?? '').replace(ILLEGAL_CHARS, '').replace(/[\\/]/g, '').replace(/\s+/g, ' ').trim()
  const withoutExt = text.replace(new RegExp(`${PRESET_EXT}$`, 'i'), '').trim()
  return withoutExt === '' ? '未命名预设' : withoutExt.slice(0, MAX_NAME_LENGTH)
}

/**
 * 名字能不能直接当文件名（用户改名时的即时校验）。合法返回 null，否则返回人话原因。
 *
 * 和 `presetIdProblem` 的区别：那个校验的是完整文件名（内部标识），
 * 这个校验的是用户眼前那个"名字"，措辞要能直接给用户看。
 * @param {unknown} name
 * @returns {string | null}
 */
export function presetNameProblem(name) {
  if (typeof name !== 'string') return '名字必须是文字'
  const raw = name.trim().replace(new RegExp(`${PRESET_EXT}$`, 'i'), '').trim()
  if (raw === '') return '名字不能为空'
  // 这里故意**不**做静默替换：改名时把用户打的字悄悄改掉，比直接拒绝更让人困惑
  if (ILLEGAL_CHARS.test(raw) || raw.includes('/') || raw.includes('\\')) {
    return '名字里不能有 / \\ : * ? " < > | 这些字符'
  }
  if (raw.length > MAX_NAME_LENGTH) return `名字太长了（上限 ${MAX_NAME_LENGTH} 个字）`
  if (RESERVED_NAMES.test(raw)) return '这是 Windows 的保留设备名（CON/PRN/AUX/NUL/COM1…）'
  if (raw.endsWith('.')) return '名字不能以点结尾（Windows 不允许）'
  if (raw.startsWith('.') || raw.startsWith('_')) return '名字不能以点或下划线开头（这类文件会被忽略）'
  return null
}

/** 名字 → 文件名。 */
export function presetIdFromName(name) {
  return `${normalizePresetName(name)}${PRESET_EXT}`
}