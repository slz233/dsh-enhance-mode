/**
 * 预设文件的增删改查（Host 侧唯一实现）。
 *
 * 界面上的按钮和助手的 `enhance_preset` 工具都调这里，不写第二份逻辑。
 * 所有失败都抛带 `code` 的错误，界面/工具直接把 `message` 显示给用户。
 *
 * 一条贯穿全文件的约定：**名字就是文件名（去掉 .md）**。
 * 所以"改名"不是改某个字段，而是真的把文件重命名（`savePreset` 里的 `name`）。
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  TRASH_DIR, isPresetId, makePresetId, normalizePresetName, presetIdFromName, presetIdProblem,
  presetNameProblem, presetPath,
} from './paths.mjs'
import { listPresets, parsePreset } from './presets.mjs'

/** 错误码：界面按它决定提示措辞。 */
export const ERROR_CODE = {
  invalidId: 'invalid-id',
  invalidName: 'invalid-name',
  notFound: 'not-found',
  conflict: 'conflict',
  duplicate: 'duplicate',
  io: 'io',
}

/** 带错误码的业务异常。 */
export class PresetError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'PresetError'
    this.code = code
  }
}

/** 确保预设目录存在。 */
export function ensurePresetDir(presetDir) {
  try {
    mkdirSync(presetDir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 种子写完后留下的标记：用户删光也不会再长回来。 */
export const SEEDED_MARKER = '.seeded'

/**
 * 安装时预置的三套示例预设。
 *
 * 名字就是文件名，所以这里不再有 `title`：`喵.md` 在界面上就叫「喵」。
 * 描述只写"这套让你怎么说话"，不写"你能看出它生效了"这种废话——用户在胶囊里
 * 看的就是这三行，多一个字都是噪音。
 * 三套的触发位置刻意不同（段尾 / 段首 / 句尾带外语词），方便对照观察。
 */
export const SEED_PRESETS = [
  {
    id: '喵.md',
    description: '每段话结尾加一个「喵」。',
    body: '每次回答的每段话之后，都要以一个「喵」字结尾。',
  },
  {
    id: '老大.md',
    description: '每段话开头先叫一声「老大」。',
    body: '每次回答的每一段开头，都要先写「老大，」再往下说。',
  },
  {
    id: '大小姐.md',
    description: '动漫大小姐口吻，句尾加「desuwa~」。',
    body: '用动漫里大小姐的口吻说话：每句话的结尾都加上「desuwa~」，语气礼貌、从容、自我感觉良好。',
  },
]

/**
 * 首次运行时种下示例预设。
 *
 * 两条规矩，都是为了"不碰用户的东西"：
 *   1. 目录里已经有任何 `.md` 就完全不种（用户已经有自己的预设）；
 *   2. 有 `.seeded` 标记就不种（用户删光了是他自己的选择，别长回来）。
 * @param {string} presetDir
 * @returns {string[]} 这次实际写下的文件名；空数组表示没种
 */
export function seedDefaultPresets(presetDir) {
  if (!ensurePresetDir(presetDir)) return []
  if (existsSync(join(presetDir, SEEDED_MARKER))) return []
  let existing = []
  try {
    existing = readdirSync(presetDir).filter(name => name.endsWith('.md'))
  } catch {
    return []
  }
  if (existing.length > 0) return []

  const written = []
  for (const seed of SEED_PRESETS) {
    const file = presetPath(presetDir, seed.id)
    if (existsSync(file)) continue
    try {
      writeFileSync(file, serializePreset(seed), 'utf8')
      written.push(seed.id)
    } catch {
      // 单个失败不影响其他；也不留半截目录状态
    }
  }
  try {
    writeFileSync(join(presetDir, SEEDED_MARKER), `${new Date().toISOString()}\n`, 'utf8')
  } catch {
    // 标记写不上就下次再试；不算失败
  }
  return written
}

/** 写文件前先写临时文件再 rename，避免半截文件被读到。 */
function writeAtomic(file, text) {
  const tmp = join(dirname(file), `.${Date.now()}.${process.pid}.tmp`)
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // 可能压根没建成
    }
    throw new PresetError(ERROR_CODE.io, `写入预设失败：${error?.message ?? error}`)
  }
}

/**
 * 序列化成标准格式的 md：只有 `description` 一行 front matter，正文原样跟在后面。
 *
 * **不写 `title`**：名字由文件名决定。老文件里残留的 `title:` 会在下次保存时
 * 自然消失（因为这里整份重写）。
 * @param {{ description?: string, body?: string }} preset
 */
export function serializePreset(preset) {
  const description = String(preset.description ?? '').trim()
  const body = String(preset.body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const front = description === '' ? '' : `---\ndescription: ${description}\n---\n`
  return body === '' ? front : `${front}${body}\n`
}

/**
 * 读一个预设（含 mtime，用于冲突检测）。
 * @returns {{ id: string, name: string, description: string, body: string, chars: number, empty: boolean, mtimeMs: number }}
 */
export function readPresetFile(presetDir, id) {
  const problem = presetIdProblem(id)
  if (problem !== null) throw new PresetError(ERROR_CODE.invalidId, `非法的预设标识「${id}」：${problem}`)
  const file = presetPath(presetDir, id)
  let info
  try {
    info = statSync(file)
  } catch {
    throw new PresetError(ERROR_CODE.notFound, `预设「${id}」不存在（可能刚被改名或删除）`)
  }
  if (!info.isFile()) throw new PresetError(ERROR_CODE.notFound, `预设「${id}」不是一个文件`)
  try {
    const preset = parsePreset(readFileSync(file, 'utf8'), id)
    return { ...preset, mtimeMs: info.mtimeMs }
  } catch (error) {
    throw new PresetError(ERROR_CODE.io, `读取预设失败：${error?.message ?? error}`)
  }
}

/**
 * 保存到已存在的文件，必要时**顺带改名**。
 *
 * 顺序有意如此：先校验 → 查冲突 → 改名（`renameSync`，原子）→ 写内容。
 * 改名失败就什么都没发生；写内容失败的话文件已经在新名字下，内容还是旧的。
 * @param {string} presetDir
 * @param {{
 *   id: string,
 *   name?: string,
 *   description?: string,
 *   body?: string,
 *   expectedMtimeMs?: number,
 * }} input
 * @returns {{ id: string, name: string, mtimeMs: number, renamedFrom: string | null }}
 */
export function savePreset(presetDir, input) {
  const current = readPresetFile(presetDir, input.id)
  if (Number.isFinite(input.expectedMtimeMs) && Math.abs(current.mtimeMs - input.expectedMtimeMs) > 1) {
    throw new PresetError(
      ERROR_CODE.conflict,
      `预设「${input.id}」已被外部修改（磁盘上的版本比界面里的新）`,
    )
  }

  let nextId = input.id
  let renamedFrom = null
  if (typeof input.name === 'string') {
    const problem = presetNameProblem(input.name)
    if (problem !== null) throw new PresetError(ERROR_CODE.invalidName, problem)
    const candidate = presetIdFromName(input.name)
    if (candidate !== input.id) {
      if (existsSync(presetPath(presetDir, candidate))) {
        throw new PresetError(ERROR_CODE.duplicate, `已经有一套叫「${normalizePresetName(input.name)}」的预设了`)
      }
      try {
        renameSync(presetPath(presetDir, input.id), presetPath(presetDir, candidate))
      } catch (error) {
        throw new PresetError(ERROR_CODE.io, `改名失败：${error?.message ?? error}`)
      }
      renamedFrom = input.id
      nextId = candidate
    }
  }

  const text = serializePreset({
    description: input.description ?? current.description,
    body: input.body ?? current.body,
  })
  const file = presetPath(presetDir, nextId)
  writeAtomic(file, text)
  const info = statSync(file)
  return { id: nextId, name: normalizePresetName(nextId), mtimeMs: info.mtimeMs, renamedFrom }
}

/**
 * 新建一套。
 * @param {string} presetDir
 * @param {{ name?: string, description?: string, body?: string, id?: string }} input
 * @returns {{ id: string, name: string, mtimeMs: number }}
 */
export function createPreset(presetDir, input = {}) {
  ensurePresetDir(presetDir)
  const existing = listPresets(presetDir).map(item => item.id)
  let id = input.id
  if (typeof id === 'string' && id !== '') {
    const problem = presetIdProblem(id)
    if (problem !== null) throw new PresetError(ERROR_CODE.invalidId, `非法的预设标识「${id}」：${problem}`)
    if (existing.some(name => name.toLowerCase() === id.toLowerCase())) {
      throw new PresetError(ERROR_CODE.duplicate, `预设「${id}」已存在`)
    }
  } else {
    const problem = presetNameProblem(input.name ?? '未命名预设')
    if (problem !== null) throw new PresetError(ERROR_CODE.invalidName, problem)
    id = makePresetId(presetDir, input.name ?? '未命名预设', existing)
  }
  const text = serializePreset({
    description: input.description ?? '',
    body: input.body ?? '',
  })
  const file = presetPath(presetDir, id)
  if (existsSync(file)) throw new PresetError(ERROR_CODE.duplicate, `预设「${id}」已存在`)
  writeAtomic(file, text)
  return { id, name: normalizePresetName(id), mtimeMs: statSync(file).mtimeMs }
}

/**
 * 另存为：内容复制成新文件，原文件不动。
 */
export function savePresetAs(presetDir, input) {
  const source = readPresetFile(presetDir, input.id)
  const wanted = String(input.name ?? '').trim()
  const name = wanted === '' ? `${source.name} 副本` : wanted
  return createPreset(presetDir, {
    name,
    description: source.description,
    body: source.body,
  })
}

/**
 * 软删除：移到 `presets/_trash/`，重名时加时间戳。
 * @returns {{ id: string, movedTo: string }}
 */
export function removePreset(presetDir, id) {
  const file = presetPath(presetDir, id)
  readPresetFile(presetDir, id) // 不存在就抛 not-found
  const trashDir = join(presetDir, TRASH_DIR)
  try {
    mkdirSync(trashDir, { recursive: true })
  } catch (error) {
    throw new PresetError(ERROR_CODE.io, `创建 _trash 目录失败：${error?.message ?? error}`)
  }

  const used = new Set(readdirSync(trashDir).map(name => name.toLowerCase()))
  const stem = id.replace(/\.md$/i, '')
  let target = id
  if (used.has(id.toLowerCase())) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    target = `${stem}.${stamp}.md`
    let index = 2
    while (used.has(target.toLowerCase())) {
      target = `${stem}.${stamp}-${index}.md`
      index += 1
    }
  }
  const destination = join(trashDir, target)
  try {
    renameSync(file, destination)
  } catch (error) {
    throw new PresetError(ERROR_CODE.io, `删除失败：${error?.message ?? error}`)
  }
  return { id, movedTo: target }
}

/** 文件名是否合法（给界面做即时校验用）。 */
export function validateId(id) {
  return isPresetId(id)
}

/** 名字是否合法（给界面做即时校验用）。 */
export function validateName(name) {
  return presetNameProblem(name) === null
}
