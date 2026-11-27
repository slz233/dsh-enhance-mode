/**
 * 预设的解析与读取。
 *
 * 一个预设就是一个 .md 文件，**文件名就是它的名字**：
 *
 *   喵.md               → 名字「喵」
 *   01-喵.md            → 名字「01-喵」（老文件，不做任何剥离）
 *   大小姐.md           → 名字「大小姐」
 *
 * 文件内容只有两段，都可选：
 *
 *   ---
 *   description: 一句话说明（列表和胶囊上显示的就是这句）
 *   ---
 *   正文……（原样追加到系统提示词末尾）
 *
 * 没有 `description:` 就取正文首段前 40 字当描述。**没有 `title:` 这种东西**：
 * 界面上叫「喵」，文件夹里就叫 `喵.md`，想改名就改文件名（见 lib/store.mjs 的
 * `savePreset`）——只有一个真相，不会出现"这边叫 A、那边叫 B"。
 *
 * front matter 解析只用最朴素的 `key: value`，不引 YAML 依赖——用户的正文里可能有
 * 任意 markdown，任何"聪明"的解析都可能把它吃掉。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PRESET_EXT, TRASH_DIR, compareIds, isPresetId, presetPath } from './paths.mjs'

/** front matter 最多往下找多少行，避免把正文里的 `---` 误当结尾。 */
const FRONT_MATTER_SCAN_LINES = 40

/** 描述自动截断长度（没有 `description:` 时取正文首段的长度）。 */
const AUTO_DESCRIPTION_CHARS = 40

/**
 * 描述**显示**长度上限。
 *
 * 只在界面上截断，**绝不改用户的文件**：别人整理好的 md 扔进来长什么样就还是什么样，
 * 我们只是列表/胶囊里最多显示这么多字，超出的用 `…`。软件里新建/编辑时，
 * 输入框也按这个数限制，免得写出一条撑乱布局的描述。
 */
export const DESCRIPTION_MAX = 120

/** 没有识别成预设的文件，原因码（界面按它给一句人话）。 */
export const IGNORE_REASON = {
  hidden: 'hidden',
  directory: 'directory',
  notMarkdown: 'not-markdown',
  unreadable: 'unreadable',
}

/** 一个目录里最多回报多少条"被忽略的文件"，防止有人扔进来几百个 txt。 */
const MAX_IGNORED = 20

/** front matter 起止标记。 */
const FENCE = '---'

/** 内容指纹：改名识别用（见 lib/rebind.mjs）。 */
export function fingerprint(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 把一段描述压到显示上限：超出就截断并加 `…`。
 * 按**字符**（码点）算，不是字节——中文一个字算一个。
 * @param {string} text
 * @param {number} [max]
 */
export function clampDescription(text, max = DESCRIPTION_MAX) {
  const chars = Array.from(String(text ?? ''))
  const limit = Number.isFinite(max) && max > 0 ? max : DESCRIPTION_MAX
  return chars.length <= limit ? chars.join('') : `${chars.slice(0, limit).join('')}…`
}

/**
 * 拆 front matter。
 * @param {string} raw 已去 BOM 的全文
 * @returns {{ meta: Record<string, string>, body: string, hasFrontMatter: boolean }}
 */
export function splitFrontMatter(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const lines = text.split('\n')
  if (lines.length === 0 || lines[0].trim() !== FENCE) {
    return { meta: {}, body: text, hasFrontMatter: false }
  }

  const limit = Math.min(lines.length, FRONT_MATTER_SCAN_LINES)
  let end = -1
  for (let index = 1; index < limit; index += 1) {
    const line = lines[index].trim()
    if (line === FENCE || line === '...') {
      end = index
      break
    }
  }
  if (end === -1) return { meta: {}, body: text, hasFrontMatter: false }

  /** @type {Record<string, string>} */
  const meta = {}
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    // 这一行不像 `key: value` → 说明开头那个 `---` 只是用户正文里的分隔线，
    // 不是 front matter。整份当正文，一个字都不吞。
    if (match === null) return { meta: {}, body: text, hasFrontMatter: false }
    meta[match[1].toLowerCase()] = unquote(match[2].trim())
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '')
  return { meta, body, hasFrontMatter: true }
}

/** 去掉包裹的引号（单/双/中文引号都认）。 */
function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    const pairs = [["'", "'"], ['"', '"'], ['“', '”'], ['「', '」'], ['『', '』']]
    for (const [open, close] of pairs) {
      if (first === open && last === close) return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}

/**
 * 文件名 → 界面上的名字：**只去掉 `.md`，一个字符都不多剥**。
 *
 * 以前要剥 `01-` 前缀，还有 frontmatter 的 `title` 可以覆盖，于是同一个预设
 * 在文件夹里、列表里、文件里可能是三个不同的名字。现在只剩这一个函数，
 * 名字永远等于文件名，用户想改名就改文件名。
 */
export function nameFromId(id) {
  const name = String(id).replace(new RegExp(`${PRESET_EXT}$`, 'i'), '')
  return name === '' ? String(id) : name
}

/** 正文 → 自动描述：首段压成一行，超长截断。 */
export function descriptionFromBody(body) {
  const paragraph = String(body ?? '')
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .find(part => part !== '') ?? ''
  const oneLine = paragraph.replace(/\s+/g, ' ').trim()
  if (oneLine === '') return ''
  return oneLine.length <= AUTO_DESCRIPTION_CHARS
    ? oneLine
    : `${oneLine.slice(0, AUTO_DESCRIPTION_CHARS)}…`
}

/**
 * 解析一个预设文件。
 * @param {string} raw 文件全文
 * @param {string} id 文件名（含 .md）
 */
export function parsePreset(raw, id) {
  const text = (typeof raw === 'string' ? raw : '').replace(/^\uFEFF/, '')
  const { meta, body } = splitFrontMatter(text)
  const name = nameFromId(id)
  const description = (meta.description ?? '').trim() === ''
    ? descriptionFromBody(body)
    : meta.description.trim()
  const normalizedBody = body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '')
  const trimmedBody = normalizedBody.replace(/\s+$/, '')
  return {
    id,
    name,
    description,
    // 界面上最多显示这么多字；文件里原文一个字都不动（编辑时用 description）
    descriptionShort: clampDescription(description),
    body: trimmedBody === '' ? '' : `${trimmedBody}\n`,
    chars: Array.from(trimmedBody).length,
    empty: trimmedBody === '',
  }
}

/**
 * 列目录：只收合法的 `.md`，顺带回报"看着像预设但没被识别"的文件。
 *
 * 用户在资源管理器里乱建东西是常态（`笔记.txt`、`_旧版.md`、`foo.md` 文件夹、
 * 一整本书另存的 md）。既不能静默吞掉让他一脸懵，也不能让这些都进系统提示词，
 * 所以：能收的收下，不能收的带着原因回去，界面上一行话说清楚。
 *
 * 只回报"看起来本来是想当预设"的：`.seeded`、写盘临时文件、`Thumbs.db` 这类
 * 一律静静跳过。
 *
 * @param {string} presetDir
 * @returns {{
 *   items: { id: string, name: string, description: string, descriptionShort: string, chars: number, empty: boolean, mtimeMs: number, sha: string }[],
 *   ignored: { name: string, reason: string }[],
 * }}
 */
export function listPresetDir(presetDir) {
  /** @type {string[]} */
  let names
  try {
    names = readdirSync(presetDir)
  } catch {
    return { items: [], ignored: [] }
  }

  const items = []
  /** @type {{ name: string, reason: string }[]} */
  const ignored = []
  const note = (name, reason) => {
    if (ignored.length < MAX_IGNORED) ignored.push({ name, reason })
  }

  for (const name of names) {
    if (name === TRASH_DIR) continue
    const lower = name.toLowerCase()
    if (lower.endsWith('.tmp')) continue
    // `.seeded` 这类插件自己的标记：不读也不报
    if (name.startsWith('.') && !lower.endsWith(PRESET_EXT)) continue

    const markdownish = lower.endsWith(PRESET_EXT) || lower.endsWith('.markdown') || lower.endsWith('.txt')
    const file = join(presetDir, name)

    let info
    try {
      info = statSync(file)
    } catch {
      if (markdownish) note(name, IGNORE_REASON.unreadable)
      continue
    }
    if (!info.isFile()) {
      // 名字叫 `foo.md` 的文件夹：容易被误认成预设
      if (lower.endsWith(PRESET_EXT)) note(name, IGNORE_REASON.directory)
      continue
    }
    if (!isPresetId(name)) {
      if (name.startsWith('.') || name.startsWith('_')) note(name, IGNORE_REASON.hidden)
      else if (markdownish) note(name, IGNORE_REASON.notMarkdown)
      continue
    }

    try {
      const raw = readFileSync(file, 'utf8')
      const preset = parsePreset(raw, name)
      items.push({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        descriptionShort: preset.descriptionShort,
        chars: preset.chars,
        empty: preset.empty,
        mtimeMs: info.mtimeMs,
        sha: fingerprint(raw),
      })
    } catch {
      // 单个文件读不动不该让整张列表挂掉
      note(name, IGNORE_REASON.unreadable)
    }
  }
  items.sort((left, right) => compareIds(left.id, right.id))
  return { items, ignored }
}

/**
 * 只要能被用的那部分（老接口，调用方多数不关心被忽略的文件）。
 * @param {string} presetDir
 * @returns {{ id: string, name: string, description: string, descriptionShort: string, chars: number, empty: boolean, mtimeMs: number, sha: string }[]}
 */
export function listPresets(presetDir) {
  return listPresetDir(presetDir).items
}

/**
 * 读一个预设；不存在或非法 → null。
 * @param {string} presetDir
 * @param {string} id
 */
export function readPreset(presetDir, id) {
  let file
  try {
    file = presetPath(presetDir, id)
  } catch {
    return null
  }
  try {
    const info = statSync(file)
    if (!info.isFile()) return null
    const preset = parsePreset(readFileSync(file, 'utf8'), id)
    return { ...preset, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

/**
 * 把用户随手写的名字解析成真实预设 id。
 *
 * 斜杠命令的场景是"手打"，用户不会记得写 `.md`，也不一定写全名。
 * 依次尝试：原样 → 补 `.md` → 忽略大小写 → 文件名前缀（`喵`）→ 名字完全相同。
 * 命中多个就**不猜**，返回 `{ id: null, candidates }`，让调用方把候选列出来。
 * @param {string} presetDir
 * @param {unknown} raw 用户写的名字
 * @returns {{ id: string | null, candidates: string[] }}
 */
export function resolvePresetId(presetDir, raw) {
  const input = String(raw ?? '').trim().replace(/^["'「『]/u, '').replace(/["'」』]$/u, '')
  const items = listPresets(presetDir)
  const candidates = items.map(item => item.id)
  if (input === '') return { id: null, candidates }

  const lower = input.toLowerCase()
  const exact = items.find(item => item.id === input)
  if (exact !== undefined) return { id: exact.id, candidates }

  const withExt = items.find(item => item.id.toLowerCase() === `${lower}.md`)
  if (withExt !== undefined) return { id: withExt.id, candidates }

  const byPrefix = items.filter(item => item.id.toLowerCase().startsWith(lower))
  if (byPrefix.length === 1) return { id: byPrefix[0].id, candidates }

  const byName = items.filter(item => item.name.toLowerCase() === lower)
  if (byName.length === 1) return { id: byName[0].id, candidates }

  return { id: null, candidates }
}

/** 读默认预设（老文件）的正文；读不到返回 null。 */
export function readDefaultBody(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (raw.trim() === '') return ''
    return raw.replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/**
 * 决定"这次装配该用哪段文本"。纯函数式：不读盘以外的副作用，便于单测。
 *
 * @param {{
 *   presetDir: string,
 *   defaultFile: string,
 *   choice: string | null,
 *   lastGood?: string,
 * }} options `lastGood` 是**本会话**上一次真正生效的文案，只在选中的预设文件消失时兜底
 * @returns {{
 *   text: string,
 *   source: 'preset' | 'default' | 'fallback',
 *   presetId: string | null,
 *   presetName: string | null,
 *   missing: boolean,
 * }}
 */
export function resolveEnhanceText(options) {
  const { presetDir, defaultFile, choice } = options
  const lastGood = typeof options.lastGood === 'string' ? options.lastGood : ''

  if (typeof choice === 'string' && choice !== '') {
    const preset = readPreset(presetDir, choice)
    if (preset !== null) {
      // 段尾标注本次用的哪套，便于事后在会话日志里核对；空预设不加标注
      const marker = preset.empty ? '' : `（本次预设：${preset.name}）\n`
      return {
        text: preset.empty ? '' : `${preset.body}${marker}`,
        source: 'preset',
        presetId: preset.id,
        presetName: preset.name,
        missing: false,
      }
    }
    // 选中的那套被删/改名：**沿用本会话上一次生效的文案**，别在对话中途突然换腔调。
    // `lastGood` 由调用方按会话给（见 prompt/index.js）；从来没成功过就没有可沿用的。
    if (lastGood !== '') {
      return { text: lastGood, source: 'fallback', presetId: null, presetName: null, missing: true }
    }
    // 真的一点历史都没有（新会话 + 选中的文件早就没了）：退回老的单文件文案
    const fallback = readDefaultBody(defaultFile)
    if (fallback !== null) {
      return { text: fallback, source: 'fallback', presetId: null, presetName: null, missing: true }
    }
    return { text: '', source: 'fallback', presetId: null, presetName: null, missing: true }
  }

  const body = readDefaultBody(defaultFile)
  if (body !== null) {
    return { text: body, source: 'default', presetId: null, presetName: null, missing: false }
  }
  return { text: lastGood, source: 'default', presetId: null, presetName: null, missing: false }
}
