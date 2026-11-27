/**
 * 预设操作层：界面按钮与助手工具共用的同一批动作。
 *
 * 每个动作都返回普通对象（不抛错），失败时形如
 *   { ok: false, code: 'conflict', message: '……' }
 * 这样界面能直接显示，工具能把 JSON 当结果回给模型。
 *
 * 名字 = 文件名：所以 `update` 收到不同的 `name` 时，是一次**真实的重命名**，
 * 排序、会话选择、最近使用都由 `applyRename` 当场搬到新名字上。
 */

import { listPresetDir, listPresets, resolvePresetId } from './presets.mjs'
import { dropFromIndex, moveToPosition, rankOf, readIndex, sortByOrder, writeIndex } from './order.mjs'
import { applyRename, reconcilePresets } from './rebind.mjs'
import {
  PresetError, createPreset, readPresetFile, removePreset, savePreset, savePresetAs,
} from './store.mjs'
import {
  countUsage, dropPresetFromSessions, getChoice, isMarkedSession, pushRecent, readState, setChoice, writeState,
} from './sessions.mjs'

/**
 * @param {{ presetDir: string, defaultFile: string, sessionsFile: string, orderFile?: string }} options
 */
export function createPresetActions(options) {
  const { presetDir, defaultFile, sessionsFile } = options
  const orderFile = typeof options.orderFile === 'string' ? options.orderFile : null

  function failure(error) {
    if (error instanceof PresetError) return { ok: false, code: error.code, message: error.message }
    return { ok: false, code: 'io', message: `操作失败：${error?.message ?? error}` }
  }

  /** 找不到预设时，把可用清单一起给出来（手打命令的人最需要这个）。 */
  function unknownPresetMessage(raw, candidates) {
    const list = candidates.length === 0 ? '（目录里还没有预设）' : candidates.join('、')
    return `找不到预设「${String(raw ?? '')}」。现有：${list}`
  }

  function loadState() {
    return readState(sessionsFile)
  }

  /** 按内部排序取列表（排序表读不到就按 id 排，不影响使用）。 */
  function orderedPresets() {
    const items = listPresets(presetDir)
    if (orderFile === null) return items
    return sortByOrder(items, readIndex(orderFile).orders)
  }

  /** 列表 + 当前选择 + 最近使用 + 使用计数。 */
  function list(input = {}) {
    try {
      // 先跟文件夹对账：把改名认回来、清掉孤儿记录、刷新内容指纹。
      // 没有变化就一次盘都不写（见 lib/rebind.mjs）。
      let rebound = []
      if (orderFile !== null) {
        rebound = reconcilePresets({ presetDir, indexFile: orderFile, sessionsFile }).pairs
      }
      const { items: raw, ignored } = listPresetDir(presetDir)
      const ordered = orderFile === null ? raw : sortByOrder(raw, readIndex(orderFile).orders)
      const state = loadState()
      const items = ordered.map(item => ({
        id: item.id,
        name: item.name,
        // 列表只用截断后的描述；文件里的原文在 read 里给（编辑时才用到）
        description: item.descriptionShort,
        chars: item.chars,
        empty: item.empty,
        mtimeMs: item.mtimeMs,
        inUse: countUsage(state, item.id),
      }))
      const current = getChoice(state, input.sessionId)
      return {
        ok: true,
        presetDir,
        defaultFile,
        items,
        current,
        currentMissing: current !== null && !items.some(item => item.id === current),
        recent: (state.recent ?? []).filter(id => items.some(item => item.id === id)),
        total: items.length,
        // 目录里看着像预设、但没被收下的文件（.txt、_开头、超过 256 KB…）
        ignored,
        // 这次对账认出来的改名（界面可以提示一句"已识别到改名"）
        rebound,
      }
    } catch (error) {
      return failure(error)
    }
  }

  /** 当前会话用哪套。 */
  function current(input = {}) {
    try {
      const state = loadState()
      const id = getChoice(state, input.sessionId)
      if (id === null) return { ok: true, current: null, source: 'default', defaultFile }
      const preset = readPresetFile(presetDir, id)
      return { ok: true, current: id, name: preset.name, source: 'preset' }
    } catch (error) {
      return failure(error)
    }
  }

  /** 切换本会话使用哪套（不写预设文件）。 */
  function use(input = {}) {
    try {
      const { sessionId } = input
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, code: 'no-session', message: '拿不到当前会话 id，无法切预设' }
      }
      const resolved = resolvePresetId(presetDir, input.id)
      if (resolved.id === null) {
        return {
          ok: false,
          code: 'not-found',
          message: unknownPresetMessage(input.id, resolved.candidates),
        }
      }
      const id = resolved.id
      const preset = readPresetFile(presetDir, id)
      let state = loadState()
      state = setChoice(state, sessionId, id)
      state = pushRecent(state, id)
      if (!writeState(sessionsFile, state)) {
        return { ok: false, code: 'io', message: '会话选择写盘失败（目录不可写？）' }
      }
      return { ok: true, id, name: preset.name }
    } catch (error) {
      return failure(error)
    }
  }

  /** 清除本会话的选择 → 回退默认预设。 */
  function reset(input = {}) {
    try {
      const { sessionId } = input
      let state = loadState()
      if (sessionId in state.sessions) {
        const sessions = { ...state.sessions }
        delete sessions[sessionId]
        state = { ...state, sessions }
        if (!writeState(sessionsFile, state)) {
          return { ok: false, code: 'io', message: '会话选择写盘失败（目录不可写？）' }
        }
      }
      return { ok: true, current: null, source: 'default' }
    } catch (error) {
      return failure(error)
    }
  }

  /** 新建一套。 */
  function create(input = {}) {
    try {
      const created = createPreset(presetDir, {
        name: input.name ?? '未命名预设',
        description: input.description ?? '',
        body: input.body ?? '',
      })
      // 立刻记下指纹：这样"刚建完就去资源管理器里改名"也能认回来
      if (orderFile !== null) {
        const item = listPresets(presetDir).find(entry => entry.id === created.id)
        if (item !== undefined) {
          const index = readIndex(orderFile)
          writeIndex(orderFile, { ...index, shas: { ...index.shas, [item.id]: item.sha } })
        }
      }
      return { ok: true, id: created.id, name: created.name }
    } catch (error) {
      return failure(error)
    }
  }

  /** 改一套：正文/描述可以改，名字改了就是重命名文件。 */
  function update(input = {}) {
    try {
      const saved = savePreset(presetDir, {
        id: input.id,
        name: input.name,
        description: input.description,
        body: input.body,
        expectedMtimeMs: input.expectedMtimeMs,
      })
      if (saved.renamedFrom !== null && orderFile !== null) {
        applyRename({
          indexFile: orderFile,
          sessionsFile,
          from: saved.renamedFrom,
          to: saved.id,
        })
      }
      return {
        ok: true,
        id: saved.id,
        name: saved.name,
        mtimeMs: saved.mtimeMs,
        renamedFrom: saved.renamedFrom,
      }
    } catch (error) {
      return failure(error)
    }
  }

  /** 另存为。 */
  function saveAs(input = {}) {
    try {
      const created = savePresetAs(presetDir, { id: input.id, name: input.name })
      return { ok: true, id: created.id, name: created.name }
    } catch (error) {
      return failure(error)
    }
  }

  /** 软删除：移到 _trash，并清理指向它的会话选择与排序记录。 */
  function remove(input = {}) {
    try {
      const { id } = input
      const removed = removePreset(presetDir, id)
      const state = loadState()
      const dropped = dropPresetFromSessions(state, id)
      let warned = 0
      if (dropped.cleared > 0) {
        warned = dropped.cleared
        writeState(sessionsFile, dropped.state)
      }
      if (orderFile !== null) {
        const index = readIndex(orderFile)
        if (id in index.orders || id in index.shas) writeIndex(orderFile, dropFromIndex(index, id))
      }
      return { ok: true, id, movedTo: removed.movedTo, clearedSessions: warned }
    } catch (error) {
      return failure(error)
    }
  }

  /** 读一套全文（界面右栏用）。 */
  function read(input = {}) {
    try {
      const resolved = resolvePresetId(presetDir, input.id)
      if (resolved.id === null) {
        return { ok: false, code: 'not-found', message: unknownPresetMessage(input.id, resolved.candidates) }
      }
      const preset = readPresetFile(presetDir, resolved.id)
      return { ok: true, preset, inUse: countUsage(loadState(), resolved.id) }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * 界面用来判断"要不要显示胶囊"：active 表示这个会话确实在增强模式里装配过。
   * 只读，不写盘。
   */
  function status(input = {}) {
    try {
      const { sessionId } = input
      const active = isMarkedSession(sessionsFile, sessionId)
      const state = loadState()
      const current = getChoice(state, sessionId)
      return {
        ok: true,
        active,
        sessionId: sessionId ?? null,
        current,
        inUse: current === null ? 0 : countUsage(state, current),
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * 调整内部排序：把某一套挪到第 `position` 位（1 起），其余顺延。
   * 只动 `presets-order.json`，**不改文件名**，也不碰预设内容。
   */
  function reorder(input = {}) {
    try {
      if (orderFile === null) {
        return { ok: false, code: 'unsupported', message: '这个部署没有配置排序表路径' }
      }
      const ids = orderedPresets().map(item => item.id)
      if (ids.length === 0) return { ok: false, code: 'empty', message: '（目录里还没有预设）' }
      if (!ids.includes(input.id)) {
        return { ok: false, code: 'not-found', message: unknownPresetMessage(input.id, ids) }
      }
      const position = Number(input.position)
      if (!Number.isFinite(position) || position < 1) {
        return { ok: false, code: 'bad-position', message: `排序位置必须是 1 到 ${ids.length} 的整数` }
      }
      const next = moveToPosition(ids, input.id, position)
      const index = readIndex(orderFile)
      if (!writeIndex(orderFile, { ...index, orders: rankOf(next) })) {
        return { ok: false, code: 'io', message: '排序写盘失败（目录不可写？）' }
      }
      return { ok: true, order: next }
    } catch (error) {
      return failure(error)
    }
  }

  return { list, current, use, reset, create, update, saveAs, remove, read, status, reorder }
}
