/**
 * 预设的**内部排序 + 内容指纹**（只属于插件，不改文件名、也不看文件名前缀）。
 *
 * 存在 `$DSH_HOME/enhance/presets-order.json`：
 *
 *   {
 *     "version": 2,
 *     "orders": { "喵.md": 0, "大小姐.md": 1 },
 *     "shas":   { "喵.md": "9f2c…", "大小姐.md": "1a07…" }
 *   }
 *
 * `orders` 是界面顺序：没有记录的一律排到最后（按 id），所以新加一个文件永远出现在末尾。
 * `shas` 是每个文件最近一次被看到的内容指纹，只干一件事：用户在资源管理器里改名之后，
 * 用它认出"这还是同一套"（见 lib/rebind.mjs）。删掉这个文件不影响读写预设，只会丢掉顺序和改名识别。
 *
 * 为什么排序单独存一份、不写进预设文件：
 *  - 文件名是用户的（`01-`、`我的口吻.md` 都合法），排序不能反过来约束命名；
 *  - front matter 是"预设内容"，AI 和用户都可能整段改它，排序被顺手改掉会很莫名其妙；
 *  - 删除预设是软删除（进 `_trash`），表里留一条孤儿记录也无害——下次对账时清掉。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { compareIds } from './paths.mjs'

/** 当前格式版本：1 = 只有 orders，2 = 多了 shas。 */
export const INDEX_VERSION = 2

/** 空表（每次返回新对象，避免调用方互相污染）。 */
export function emptyIndex() {
  return { version: INDEX_VERSION, orders: {}, shas: {} }
}

/** 值必须是有限数字才算一条排序记录。 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 值必须是非空字符串才算一条指纹。 */
function shaOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 读排序表。文件不存在 / 坏掉 → 空表（排序只是外观，不值得让整个列表挂掉）。
 * v1 的老文件（只有 `orders`）照样读，`shas` 当空。
 * @param {string} file
 * @returns {{ version: number, orders: Record<string, number>, shas: Record<string, string> }}
 */
export function readIndex(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return emptyIndex()
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyIndex()

  /** @type {Record<string, number>} */
  const orders = {}
  const rawOrders = raw.orders
  if (rawOrders !== null && typeof rawOrders === 'object' && !Array.isArray(rawOrders)) {
    for (const [id, value] of Object.entries(rawOrders)) {
      const rank = numberOrNull(value)
      if (rank !== null) orders[id] = rank
    }
  }

  /** @type {Record<string, string>} */
  const shas = {}
  const rawShas = raw.shas
  if (rawShas !== null && typeof rawShas === 'object' && !Array.isArray(rawShas)) {
    for (const [id, value] of Object.entries(rawShas)) {
      const sha = shaOrNull(value)
      if (sha !== null) shas[id] = sha
    }
  }

  return { version: INDEX_VERSION, orders, shas }
}

/**
 * 写排序表（整份覆盖，临时文件 + rename）。
 * @param {string} file
 * @param {{ orders?: Record<string, number>, shas?: Record<string, string> }} index
 * @returns {boolean} 是否写成功
 */
export function writeIndex(file, index) {
  const payload = {
    version: INDEX_VERSION,
    orders: index?.orders ?? {},
    shas: index?.shas ?? {},
  }
  const tmp = join(dirname(file), `.order.${process.pid}.${Date.now()}.tmp`)
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
 * 从表里删掉一个 id（软删除之后调用，免得表里留孤儿）。
 * @param {{ orders: Record<string, number>, shas: Record<string, string> }} index
 * @param {string} id
 */
export function dropFromIndex(index, id) {
  const orders = { ...index.orders }
  const shas = { ...index.shas }
  delete orders[id]
  delete shas[id]
  return { version: INDEX_VERSION, orders, shas }
}

/**
 * 按内部排序排好；没有记录的排到后面，同档按 id。
 * @template {{ id: string }} T
 * @param {T[]} items
 * @param {Record<string, number>} orders
 * @returns {T[]}
 */
export function sortByOrder(items, orders) {
  const rank = item => (Object.prototype.hasOwnProperty.call(orders, item.id) ? orders[item.id] : Number.MAX_SAFE_INTEGER)
  return [...items].sort((left, right) => {
    const a = rank(left)
    const b = rank(right)
    if (a !== b) return a - b
    return compareIds(left.id, right.id)
  })
}

/**
 * 把 `id` 挪到第 `position` 位（1 起），返回新的 id 顺序。越界会被夹到两端。
 * @param {string[]} ids 当前顺序
 * @param {string} id
 * @param {number} position
 * @returns {string[]}
 */
export function moveToPosition(ids, id, position) {
  const rest = ids.filter(current => current !== id)
  const target = Math.min(Math.max(Math.round(position) - 1, 0), rest.length)
  rest.splice(target, 0, id)
  return rest
}

/**
 * 把一个 id 顺序折成 `{ id: 序号 }`（0 起），供写盘。
 * @param {string[]} ids
 * @returns {Record<string, number>}
 */
export function rankOf(ids) {
  const orders = {}
  ids.forEach((id, index) => {
    orders[id] = index
  })
  return orders
}
