/**
 * 版本检查的离线测试：比较、镜像回退、缓存、冷却。
 *
 * 跑法：node scripts/test-update.mjs
 *
 * 全程不发真请求（fetch 全部注入），也不碰真实的 %DSH_HOME%。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkForUpdate, compareVersions, fetchLatest, localPackage, readUpdateState } from '../lib/update.mjs'

let passed = 0
let failed = 0

async function check(name, body) {
  try {
    await body()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

function ok(value, what = '') {
  if (!value) throw new Error(`${what}：期望为真`)
}

function is(actual, expected, what = '') {
  if (actual !== expected) {
    throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function same(actual, expected, what = '') {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}：期望 ${right}，实际 ${left}`)
}

/** 临时 DSH_HOME，跑完还原。 */
async function withHome(body) {
  const home = mkdtempSync(join(tmpdir(), 'enhance-update-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body(home)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
}

/** 造一个 fetch：按 url 查表，查不到就抛（模拟断网）。 */
function mockFetch(table) {
  const calls = []
  const impl = async url => {
    calls.push(url)
    const entry = table[url]
    if (entry === undefined) throw new Error('ENOTFOUND')
    return {
      ok: entry.ok !== false,
      status: entry.status ?? (entry.ok === false ? 500 : 200),
      json: async () => entry.body ?? {},
    }
  }
  return { impl, calls }
}

const MIRROR = 'https://registry.npmmirror.com/@slz233/dsh-enhance-mode/latest'
const NPMJS = 'https://registry.npmjs.org/@slz233/dsh-enhance-mode/latest'

// ---------------- 1. 版本比较 ----------------

await check('版本比较：主次号与预发布', () => {
  is(compareVersions('0.8.1', '0.6.3'), 1)
  is(compareVersions('0.6.3', '0.8.1'), -1)
  is(compareVersions('0.8.0', '0.8.0'), 0)
  is(compareVersions('1.0.0', '0.99.99'), 1)
  is(compareVersions('0.8.1-beta', '0.8.1'), -1, '预发布小于正式版')
  is(compareVersions('v0.9.0', '0.8.1'), 1, '前缀 v 不该影响')
})

// ---------------- 2. 拉取 ----------------

await check('镜像命中就不再打官方源', async () => {
  const { impl, calls } = mockFetch({ [MIRROR]: { body: { version: '0.9.0' } } })
  const version = await fetchLatest('@slz233/dsh-enhance-mode', { fetchImpl: impl })
  is(version, '0.9.0')
  same(calls, [MIRROR])
})

await check('镜像挂了回退官方源', async () => {
  const { impl, calls } = mockFetch({ [NPMJS]: { body: { version: '0.9.1' } } })
  const version = await fetchLatest('@slz233/dsh-enhance-mode', { fetchImpl: impl })
  is(version, '0.9.1')
  same(calls, [MIRROR, NPMJS], '先镜像后官方')
})

await check('两个源都挂 → 抛，且带错因', async () => {
  const { impl } = mockFetch({})
  let error = null
  try {
    await fetchLatest('@slz233/dsh-enhance-mode', { fetchImpl: impl })
  } catch (caught) {
    error = caught
  }
  ok(error !== null, '必须抛')
  ok(String(error.message).includes('查不到最新版本'), '文案要能看懂')
})

await check('返回体里没有 version → 继续试下一个源', async () => {
  const { impl, calls } = mockFetch({
    [MIRROR]: { body: { name: 'x' } },
    [NPMJS]: { body: { version: '1.2.3' } },
  })
  const version = await fetchLatest('@slz233/dsh-enhance-mode', { fetchImpl: impl })
  is(version, '1.2.3')
  is(calls.length, 2)
})

// ---------------- 3. 缓存与冷却 ----------------

await withHome(async home => {
  const pkg = localPackage()
  is(pkg.name, '@slz233/dsh-enhance-mode')
  ok(/^\d+\.\d+\.\d+/.test(pkg.version), `本地版本形状不对：${pkg.version}`)

  await check('第一次查：走网络、落盘', async () => {
    const first = mockFetch({ [MIRROR]: { body: { version: '99.0.0' } } })
    const result = await checkForUpdate({ current: '0.8.1', fetchImpl: first.impl })
    is(result.source, 'network')
    is(result.latest, '99.0.0')
    is(result.hasUpdate, true)
    is(first.calls.length, 1)

    const stored = readUpdateState()
    ok(stored !== null, '要落盘')
    is(stored.latest, '99.0.0')
    is(stored.ok, true)
    const raw = JSON.parse(readFileSync(join(home, 'enhance', 'update-check.json'), 'utf8'))
    is(raw.latest, '99.0.0')
  })

  await check('24 小时内走缓存，一个请求都不发', async () => {
    const second = mockFetch({ [MIRROR]: { body: { version: '100.0.0' } } })
    const again = await checkForUpdate({ current: '0.8.1', fetchImpl: second.impl })
    is(again.source, 'cache')
    is(again.latest, '99.0.0', '缓存期内不刷新')
    is(second.calls.length, 0, '缓存期内不许发请求')
  })

  await check('force 要无视缓存', async () => {
    const third = mockFetch({ [MIRROR]: { body: { version: '100.0.0' } } })
    const forced = await checkForUpdate({ current: '0.8.1', force: true, fetchImpl: third.impl })
    is(forced.source, 'network')
    is(forced.latest, '100.0.0')
    is(third.calls.length, 1)
  })
})

await withHome(async () => {
  await check('查不到时不显示更新，并记下 1 小时冷却', async () => {
    const broken = mockFetch({})
    const result = await checkForUpdate({ current: '0.8.1', fetchImpl: broken.impl })
    is(result.hasUpdate, false)
    is(result.latest, null)
    ok(typeof result.error === 'string' && result.error !== '', '要给出错因')
    is(readUpdateState().ok, false, '失败也要记住，别每次都试')

    const retry = mockFetch({})
    await checkForUpdate({ current: '0.8.1', fetchImpl: retry.impl })
    is(retry.calls.length, 0, '1 小时冷却内不重试')
  })
})

await check('缓存文件坏了 → 当作没有缓存', async () => {
  await withHome(async home => {
    mkdirSync(join(home, 'enhance'), { recursive: true })
    writeFileSync(join(home, 'enhance', 'update-check.json'), '{not json')
    is(readUpdateState(), null)
  })
})

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
