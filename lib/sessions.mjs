/**
 * 会话级选择记录：`enhance/sessions.json`
 *
 * 结构：
 *   {
 *     "version": 1,
 *     "sessions": { "<会话id>": "02-只给结论.md" },
 *     "recent": ["02-只给结论.md", "01-严格同事.md"]
 *   }
 *
 * 三条原则：
 *  1. **只存"选了哪套"，不存内容**——内容永远以文件为准；
 *  2. 读写永不抛错：文件坏了就当空记录，退回默认预设，别让一轮对话装配失败；
 *  3. 写入用原子写（临时文件 + rename），避免进程被杀时留下半截 JSON。
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 当前格式版本；字段语义变化时 +1。 */
export const STATE_VERSION = 1

/** 最近使用列表上限。 */
export const MAX_RECENT = 20

/** 会话 id 长度上限（防手改文件塞进巨长键）。 */
const MAX_SESSION_ID = 200

/** 空记录（每次返回新对象，避免调用方互相污染）。 */
export function emptyState() {
  return { version: STATE_VERSION, sessions: {}, recent: [] }
}

/** 会话 id 是否可用作键。 */
function usableSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId !== '' && sessionId.length <= MAX_SESSION_ID
}

/**
 * 读记录。任何异常 → 空记录。
 * @param {string} file
 * @returns {{ version: number, sessions: Record<string, string>, recent: string[] }}
 */
export function readState(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return emptyState()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()

  /** @type {Record<string, string>} */
  const sessions = {}
  const rawSessions = parsed.sessions
  if (rawSessions !== null && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
    for (const [key, value] of Object.entries(rawSessions)) {
      if (!usableSessionId(key)) continue
      if (typeof value !== 'string' || value === '') continue
      sessions[key] = value
    }
  }

  /** @type {string[]} */
  const recent = []
  if (Array.isArray(parsed.recent)) {
    for (const item of parsed.recent) {
      if (typeof item !== 'string' || item === '') continue
      if (recent.includes(item)) continue
      recent.push(item)
      if (recent.length >= MAX_RECENT) break
    }
  }

  return {
    version: Number.isFinite(parsed.version) ? parsed.version : STATE_VERSION,
    sessions,
    recent,
  }
}

/**
 * 原子写。失败返回 false，调用方决定是否提示用户。
 * @param {string} file
 * @param {{ sessions: Record<string, string>, recent: string[] }} state
 * @returns {boolean}
 */
export function writeState(file, state) {
  const payload = {
    version: STATE_VERSION,
    sessions: state.sessions ?? {},
    recent: (state.recent ?? []).slice(0, MAX_RECENT),
  }
  const tmp = join(dirname(file), `.sessions.${process.pid}.${Date.now()}.tmp`)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      // 临时文件可能根本没建成
    }
    return false
  }
}

/**
 * 取本会话的选择；没有 → null。
 * @param {{ sessions: Record<string, string> }} state
 * @param {string} sessionId
 * @returns {string | null}
 */
export function getChoice(state, sessionId) {
  if (!usableSessionId(sessionId)) return null
  const id = state?.sessions?.[sessionId]
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 设置本会话的选择（返回新 state，不改入参）。
 * @param {{ sessions: Record<string, string>, recent: string[] }} state
 * @param {string} sessionId
 * @param {string} presetId
 */
export function setChoice(state, sessionId, presetId) {
  if (!usableSessionId(sessionId)) throw new Error('会话 id 不可用，无法记录预设选择')
  if (typeof presetId !== 'string' || presetId === '') throw new Error('预设标识不能为空')
  return {
    version: STATE_VERSION,
    sessions: { ...state.sessions, [sessionId]: presetId },
    recent: state.recent ?? [],
  }
}

/**
 * 取消本会话的选择（回退到默认预设）。
 */
export function clearChoice(state, sessionId) {
  if (!usableSessionId(sessionId)) return state
  if (!(sessionId in (state.sessions ?? {}))) return state
  const sessions = { ...state.sessions }
  delete sessions[sessionId]
  return { version: STATE_VERSION, sessions, recent: state.recent ?? [] }
}

/**
 * 把某套预设推到"最近使用"队首（去重、限量）。
 */
export function pushRecent(state, presetId, max = MAX_RECENT) {
  if (typeof presetId !== 'string' || presetId === '') return state
  const limit = Number.isFinite(max) && max > 0 ? Math.min(max, MAX_RECENT) : MAX_RECENT
  const previous = state.recent ?? []
  const next = [presetId, ...previous.filter(id => id !== presetId)].slice(0, limit)
  return { version: STATE_VERSION, sessions: state.sessions ?? {}, recent: next }
}

/**
 * 有多少个会话正引用这套预设。
 */
export function countUsage(state, presetId) {
  if (typeof presetId !== 'string' || presetId === '') return 0
  let count = 0
  for (const value of Object.values(state.sessions ?? {})) {
    if (value === presetId) count += 1
  }
  return count
}

/**
 * 某套预设被删/改名后，把所有指向它的会话改成"默认"。
 * 返回 { state, cleared } —— cleared 是被清理的会话数。
 */
export function dropPresetFromSessions(state, presetId) {
  let cleared = 0
  const sessions = {}
  for (const [key, value] of Object.entries(state.sessions ?? {})) {
    if (value === presetId) {
      cleared += 1
      continue
    }
    sessions[key] = value
  }
  return {
    state: {
      version: STATE_VERSION,
      sessions,
      recent: (state.recent ?? []).filter(id => id !== presetId),
    },
    cleared,
  }
}

/**
 * 某套预设**改了文件名**之后，把所有指向旧名字的记录换成新名字。
 *
 * 和 `dropPresetFromSessions` 的区别：那个是"用户主动删了，认命"，
 * 这个是"还是同一套，只是名字变了"，所以会话选择、最近使用都要跟着搬家。
 *
 * 没有任何改动时返回**同一个对象**（调用方据此跳过写盘）。
 * @param {{ sessions: Record<string, string>, recent: string[] }} state
 * @param {{ from: string, to: string }[]} pairs
 */
export function remapSessions(state, pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return state
  const moves = new Map(pairs.map(pair => [pair.from, pair.to]))

  let touched = false
  /** @type {Record<string, string>} */
  const sessions = {}
  for (const [key, value] of Object.entries(state.sessions ?? {})) {
    const next = moves.get(value)
    if (next === undefined) {
      sessions[key] = value
      continue
    }
    sessions[key] = next
    touched = true
  }

  const recent = []
  for (const id of state.recent ?? []) {
    const next = moves.get(id) ?? id
    if (next !== id) touched = true
    if (!recent.includes(next)) recent.push(next)
  }

  if (!touched) return state
  return { version: STATE_VERSION, sessions, recent }
}

/** 记录文件的修改时间；用于"外部改动检测"。 */
export function statOrNull(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

/**
 * 「这个会话确实用过增强模式」的标记文件目录。
 * 界面靠它决定是否渲染胶囊：别的模式的会话里出现的胶囊只会让人困惑。
 * @param {string} sessionsFile
 */
export function markerDir(sessionsFile) {
  return join(dirname(sessionsFile), 'sessions')
}

/** 会话 id → 安全文件名（base64url，避免 Windows 非法字符）。 */
export function markerName(sessionId) {
  return `${Buffer.from(String(sessionId), 'utf8').toString('base64url')}.on`
}

/**
 * 打标记。已存在则什么都不做（每步只是一个 stat，开销可忽略）。
 * 失败静默：这个标记只影响界面显示，不该影响装配。
 * @param {string} sessionsFile
 * @param {string} sessionId
 */
export function markSession(sessionsFile, sessionId) {
  if (!usableSessionId(sessionId)) return false
  const dir = markerDir(sessionsFile)
  const file = join(dir, markerName(sessionId))
  try {
    if (statSync(file).isFile()) return true
  } catch {
    // 没有就往下写
  }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, `${new Date().toISOString()}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 这个会话是否被标记过（即在增强模式里装配过）。 */
export function isMarkedSession(sessionsFile, sessionId) {
  if (!usableSessionId(sessionId)) return false
  try {
    return statSync(join(markerDir(sessionsFile), markerName(sessionId))).isFile()
  } catch {
    return false
  }
}