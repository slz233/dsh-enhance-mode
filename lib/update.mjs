/**
 * 版本检查：让用户知道仓库里已经有新版了。
 *
 * 为什么插件自己查：DSH 不给第三方插件提供「更新」按钮
 * （宿主文案原话：To upgrade it, uninstall it and install it again），
 * 用户不看 README 就永远不知道自己落后，而这次从 0.6.3 到 0.8.x 差的是一整个修会话的能力。
 *
 * 三条自我约束：
 *  1. 只在启动后查一次，结果缓存 24 小时（失败 1 小时后才重试），不做轮询；
 *  2. 先国内镜像再官方源，两个都挂就当没这功能 —— 绝不弹窗、不阻断、不写日志噪声；
 *  3. 只读 `latest` 的版本号，不上报任何东西，也不携带任何标识。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveEnhanceDir } from './paths.mjs'

/** 成功结果的复用时长。 */
const TTL_MS = 24 * 60 * 60 * 1000

/** 失败结果的冷却时长：断网时别每次都试。 */
const RETRY_MS = 60 * 60 * 1000

/** 单次请求超时。 */
const TIMEOUT_MS = 8000

/** 缓存文件名（放在 enhance 目录里，和预设一起）。 */
const CACHE_FILE = 'update-check.json'

/** 先镜像后官方：国内环境镜像通常几百毫秒，官方源经常超时。 */
const REGISTRIES = [
  'https://registry.npmmirror.com/{name}/latest',
  'https://registry.npmjs.org/{name}/latest',
]

let cachedPackage = null

/**
 * 本包的 name / version（只读一次）。
 * @returns {{ name: string, version: string }}
 */
export function localPackage() {
  if (cachedPackage !== null) return cachedPackage
  try {
    const url = new URL('../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8'))
    cachedPackage = {
      name: typeof parsed.name === 'string' ? parsed.name : '@slz233/dsh-enhance-mode',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    }
  } catch {
    cachedPackage = { name: '@slz233/dsh-enhance-mode', version: '0.0.0' }
  }
  return cachedPackage
}

/**
 * 比较两个语义化版本。
 * 只看 major.minor.patch；同号时「带 prerelease 的小于正式版」。
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1} left 比 right 小 / 相等 / 大
 */
export function compareVersions(left, right) {
  const split = value => String(value ?? '')
    .split('+')[0]
    .split('-')[0]
    .split('.')
    .map(part => {
      const number = Number.parseInt(part, 10)
      return Number.isSafeInteger(number) ? number : 0
    })
  const a = split(left)
  const b = split(right)
  for (let index = 0; index < 3; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  const preA = String(left ?? '').includes('-')
  const preB = String(right ?? '').includes('-')
  if (preA === preB) return 0
  return preA ? -1 : 1
}

/** 缓存路径。 */
function cachePath() {
  return join(resolveEnhanceDir(), CACHE_FILE)
}

/**
 * 读缓存；读不出来就当没有（文件坏了不该让功能挂掉）。
 * @returns {{ checkedAt: number, latest: string | null, ok: boolean, error?: string } | null}
 */
export function readUpdateState() {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const checkedAt = Number(parsed.checkedAt)
    if (!Number.isSafeInteger(checkedAt) || checkedAt <= 0) return null
    return {
      checkedAt,
      latest: typeof parsed.latest === 'string' && parsed.latest !== '' ? parsed.latest : null,
      ok: parsed.ok === true,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
    }
  } catch {
    return null
  }
}

/** 写缓存；写不进去就算了，下次再查。 */
function writeUpdateState(state) {
  try {
    const dir = resolveEnhanceDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(cachePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 目录只读之类：不影响功能
  }
}

/**
 * 拉一次 latest 版本号。镜像和官方源依次试，全失败就抛。
 * @param {string} packageName
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<string>}
 */
export async function fetchLatest(packageName, options = {}) {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('宿主里没有 fetch')
  const errors = []
  for (const template of REGISTRIES) {
    const url = template.replace('{name}', packageName)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const response = await doFetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response || response.ok !== true) throw new Error(`HTTP ${response?.status ?? '?'}`)
      const body = await response.json()
      const version = typeof body?.version === 'string' ? body.version.trim() : ''
      if (version === '') throw new Error('返回里没有 version')
      return version
    } catch (error) {
      errors.push(error?.message ?? String(error))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`查不到最新版本（${errors.join(' / ')}）`)
}

/**
 * 需要的话查一次，然后给出结论。
 *
 * @param {{ packageName?: string, current?: string, force?: boolean, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{ current: string, latest: string | null, hasUpdate: boolean,
 *                     checkedAt: number | null, source: 'cache' | 'network', error?: string }>}
 */
export async function checkForUpdate(options = {}) {
  const pkg = localPackage()
  const packageName = options.packageName ?? pkg.name
  const current = options.current ?? pkg.version
  const force = options.force === true

  const cached = readUpdateState()
  if (!force && cached !== null) {
    const age = Date.now() - cached.checkedAt
    const limit = cached.ok ? TTL_MS : RETRY_MS
    if (age >= 0 && age < limit) return summarize(cached, current, 'cache')
  }

  let state
  try {
    const latest = await fetchLatest(packageName, options)
    state = { checkedAt: Date.now(), latest, ok: true }
  } catch (error) {
    state = { checkedAt: Date.now(), latest: null, ok: false, error: error?.message ?? String(error) }
  }
  writeUpdateState(state)
  return summarize(state, current, 'network')
}

/** 把状态压成界面要的形状。 */
function summarize(state, current, source) {
  const latest = state.latest
  return {
    current,
    latest,
    hasUpdate: latest !== null && compareVersions(latest, current) > 0,
    checkedAt: state.checkedAt,
    source,
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}
