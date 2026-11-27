/**
 * 改名识别：把"用户自己在资源管理器里改了文件名"这件事，认回原来那一套。
 *
 * 背景：预设的身份就是一个文件名。排序表（`presets-order.json`）和会话选择
 * （`sessions.json`）里存的都是文件名，所以用户在文件夹里把 `03-大小姐.md`
 * 改成 `大小姐.md` 之后，那套会掉到列表末尾，正在用它的会话也会指向一个不存在的
 * 文件。这不是用户乱搞，是最自然的手势，得认。
 *
 * 认法只有一条：**内容指纹完全一致，而且两边都唯一**。
 *
 *   - 消失的 id 里有 1 个，新出现的 id 里有 1 个，两者 sha256 相同 → 判定为改名；
 *   - 同一份内容在两边各有多份（用户复制了好几个）→ 不猜，宁可当成新预设；
 *   - 改名同时改了正文 → 指纹对不上，按新预设处理。这是设计选择：宁可漏认，不要错认。
 *
 * 不往用户的 .md 里写任何东西（不塞 front matter id）：复制文件会产生重复 id、
 * 手改 front matter 会断链，而指纹只存在我们自己的表里，删掉也不影响正常读写。
 */

import { compareIds } from './paths.mjs'
import { listPresetDir } from './presets.mjs'
import { INDEX_VERSION, rankOf, readIndex, writeIndex } from './order.mjs'
import { readState, remapSessions, writeState } from './sessions.mjs'

/**
 * 算出哪些"消失的 id"和"新出现的 id"是同一个文件。
 * @param {{ orders?: Record<string, number>, shas?: Record<string, string> }} index
 * @param {{ id: string, sha: string }[]} items 当前目录里的预设
 * @returns {{ pairs: { from: string, to: string }[], gone: string[], fresh: string[] }}
 *   `gone` / `fresh` 已排除配对成功的那些，剩下的是"真没了"和"真的新加的"
 */
export function planRebind(index, items) {
  const orders = index?.orders ?? {}
  const shas = index?.shas ?? {}
  const known = new Set([...Object.keys(shas), ...Object.keys(orders)])
  const current = new Map(items.map(item => [item.id, item.sha]))

  const gone = [...known].filter(id => !current.has(id))
  const fresh = [...current.keys()].filter(id => !known.has(id))

  /** @type {Map<string, { gone: string[], fresh: string[] }>} */
  const buckets = new Map()
  const bucketOf = sha => {
    let entry = buckets.get(sha)
    if (entry === undefined) {
      entry = { gone: [], fresh: [] }
      buckets.set(sha, entry)
    }
    return entry
  }

  for (const id of gone) {
    const sha = shas[id]
    if (typeof sha === 'string' && sha !== '') bucketOf(sha).gone.push(id)
  }
  for (const id of fresh) {
    const sha = current.get(id)
    if (typeof sha === 'string' && sha !== '') bucketOf(sha).fresh.push(id)
  }

  const pairs = []
  for (const entry of buckets.values()) {
    if (entry.gone.length === 1 && entry.fresh.length === 1) {
      pairs.push({ from: entry.gone[0], to: entry.fresh[0] })
    }
  }

  const paired = new Set()
  for (const pair of pairs) {
    paired.add(pair.from)
    paired.add(pair.to)
  }
  return {
    pairs,
    gone: gone.filter(id => !paired.has(id)),
    fresh: fresh.filter(id => !paired.has(id)),
  }
}

/**
 * 对账后的新表：排序跟着改名走、孤儿记录清掉、指纹刷新成现在磁盘上的内容。
 * @param {{ orders?: Record<string, number>, shas?: Record<string, string> }} index
 * @param {{ id: string, sha: string }[]} items
 * @param {{ from: string, to: string }[]} pairs
 * @returns {{ version: number, orders: Record<string, number>, shas: Record<string, string> }}
 */
export function indexAfterRebind(index, items, pairs) {
  const moves = new Map(pairs.map(pair => [pair.from, pair.to]))
  const present = new Set(items.map(item => item.id))

  /** @type {Record<string, number>} */
  const moved = {}
  for (const [id, rank] of Object.entries(index?.orders ?? {})) {
    const next = moves.get(id) ?? id
    // 指向已经不存在的文件的记录：直接清掉，表不会越用越长
    if (!present.has(next)) continue
    // 目标位置已经有记录就不覆盖：这是"改名的目标正好是个已存在的 id"，
    // 正常不会发生（文件名唯一），真撞上了以原记录为准。
    if (!(next in moved)) moved[next] = rank
  }

  // 折成 0..n-1 的连续序号
  const ordered = Object.entries(moved)
    .sort((left, right) => left[1] - right[1] || compareIds(left[0], right[0]))
    .map(([id]) => id)
  const orders = rankOf(ordered)

  /** @type {Record<string, string>} */
  const shas = {}
  for (const item of items) {
    if (typeof item.sha === 'string' && item.sha !== '') shas[item.id] = item.sha
  }
  return { version: INDEX_VERSION, orders, shas }
}

/** 两份表是否一模一样（用来决定"要不要写盘"）。 */
export function sameIndex(left, right) {
  return JSON.stringify({
    orders: left?.orders ?? {},
    shas: left?.shas ?? {},
  }) === JSON.stringify({
    orders: right?.orders ?? {},
    shas: right?.shas ?? {},
  })
}

/**
 * 我们自己在软件里改名之后：把排序记录和会话选择当场搬到新名字上。
 *
 * 不走指纹识别——改名是我们自己做的，旧名→新名是**已知**的，没必要靠内容猜；
 * 而且改名通常伴随正文修改，指纹此时已经对不上了。
 * @param {{ indexFile: string, sessionsFile: string, from: string, to: string }} options
 */
export function applyRename(options) {
  const { indexFile, sessionsFile, from, to } = options
  const index = readIndex(indexFile)
  /** @type {[string, number][]} */
  const merged = []
  for (const [id, rank] of Object.entries(index.orders)) {
    merged.push([id === from ? to : id, rank])
  }
  merged.sort((left, right) => left[1] - right[1] || compareIds(left[0], right[0]))
  const orders = rankOf(merged.map(([id]) => id))

  const shas = { ...index.shas }
  // 指纹随手删掉：正文也一起改了，让下一次对账刷新成新内容的指纹
  delete shas[from]
  writeIndex(indexFile, { version: INDEX_VERSION, orders, shas })

  const state = readState(sessionsFile)
  const mapped = remapSessions(state, [{ from, to }])
  if (mapped !== state) writeState(sessionsFile, mapped)
}

/**
 * 对账：读目录 → 认改名 → 必要时写回排序表与会话记录。
 *
 * 调用时机：界面拉列表时、以及装配提示词发现"选中的那套找不到"时。
 * 不需要写盘就一行都不写（用户每打开一次弹窗都改一次文件是很讨厌的行为）。
 *
 * @param {{ presetDir: string, indexFile: string, sessionsFile: string }} options
 * @returns {{ changed: boolean, pairs: { from: string, to: string }[] }}
 */
export function reconcilePresets(options) {
  const { presetDir, indexFile, sessionsFile } = options
  const index = readIndex(indexFile)
  const { items } = listPresetDir(presetDir)
  const plan = planRebind(index, items)
  const next = indexAfterRebind(index, items, plan.pairs)

  const changed = !sameIndex(index, next)
  if (changed) writeIndex(indexFile, next)

  if (plan.pairs.length > 0) {
    const state = readState(sessionsFile)
    const mapped = remapSessions(state, plan.pairs)
    if (mapped !== state) writeState(sessionsFile, mapped)
  }
  return { changed, pairs: plan.pairs }
}
