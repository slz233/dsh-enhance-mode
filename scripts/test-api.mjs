#!/usr/bin/env node
/**
 * 界面数据通道（lib/api.mjs）的离线测试。
 *
 * 不起真服务器：直接把假 req/res 喂给 handler，断言状态码与 JSON。
 * 覆盖的是"安全和分派"这一层：方法、同源、Content-Type、坏 JSON、参数校验，
 * 以及每个 op 是否真的落到了 lib/actions.mjs（用临时目录验证文件变化）。
 *
 * 跑：node scripts/test-api.mjs
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API_PATH, apply as applyApiPlugin, createApiHandler, name as apiPluginName } from '../lib/api.mjs'
import { createPresetActions } from '../lib/actions.mjs'

let passed = 0
let failed = 0

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function equal(name, actual, expected) {
  ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 假请求：能触发 data/end，带 method/headers。 */
function fakeReq({ method = 'POST', headers = {}, body = '' }) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  req.destroy = () => {}
  process.nextTick(() => {
    if (body !== '') req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

/** 假响应：收集状态码、头、体。 */
function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk ?? ''
      res.done?.()
    },
  }
  return res
}

/**
 * 发一次请求。
 * @returns {Promise<{ status: number, headers: Record<string, string>, json: any }>}
 */
async function call(handler, payload, options = {}) {
  const body = options.rawBody ?? (payload === undefined ? '' : JSON.stringify(payload))
  const headers = {
    host: '127.0.0.1:9717',
    origin: 'http://127.0.0.1:9717',
    'content-type': 'application/json',
    ...options.headers,
  }
  // null = 这个头压根不存在（区分"没有这个头"和"头是空串"，两者语义不同）
  for (const name of Object.keys(headers)) {
    if (headers[name] === null) delete headers[name]
  }
  const req = fakeReq({ method: options.method ?? 'POST', headers, body })
  const res = fakeRes()
  const finished = new Promise(resolve => {
    res.done = resolve
  })
  await handler(req, res)
  await finished
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json }
}

/** 造一个隔离的 enhance 目录。 */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-api-'))
  const presetDir = join(root, 'presets')
  const defaultFile = join(root, 'mode-prompt.md')
  const sessionsFile = join(root, 'sessions.json')
  const orderFile = join(root, 'presets-order.json')
  writeFileSync(defaultFile, '默认（喵）\n', 'utf8')
  const actions = createPresetActions({ presetDir, defaultFile, sessionsFile, orderFile })
  return { root, presetDir, defaultFile, sessionsFile, orderFile, actions, handler: createApiHandler(actions) }
}

async function main() {
  console.log(`API_PATH = ${API_PATH}`)
  const box = sandbox()
  const handler = box.handler

  console.log('\n[1] 网关校验')
  equal('GET 被拒', (await call(handler, {}, { method: 'GET' })).status, 405)
  equal('跨源 POST 被拒', (await call(handler, {}, { headers: { origin: 'https://evil.example' } })).status, 403)
  equal(
    'DNS rebinding 的 Host 被拒（Origin 与 Host 一起变也拦得住）',
    (await call(handler, { op: 'list' }, { headers: { host: 'evil.example:9717', origin: 'http://evil.example:9717' } })).status,
    403,
  )
  equal('局域网 Host 被拒（只服务回环）', (await call(handler, { op: 'list' }, { headers: { host: '192.168.1.5:9717' } })).status, 403)
  equal('Origin: null（沙箱 iframe / data: 文档）被拒', (await call(handler, { op: 'list' }, { headers: { origin: 'null' } })).status, 403)
  equal('空 Origin 被拒（存在但解析不了 ≠ 不存在）', (await call(handler, { op: 'list' }, { headers: { origin: '' } })).status, 403)
  equal(
    'Host 被代理剥掉时放行（桌面版代理行为，网页做不到）',
    (await call(handler, { op: 'list' }, { headers: { host: null, origin: null, 'sec-fetch-site': null } })).status,
    200,
  )
  equal(
    'Chrome 151+ 回环源省略端口也放行',
    (await call(handler, { op: 'list' }, { headers: { origin: 'http://127.0.0.1' } })).status,
    200,
  )
  equal('localhost 也放行', (await call(handler, { op: 'list' }, { headers: { host: 'localhost:9717', origin: 'http://localhost:9717' } })).status, 200)
  equal('没有 Origin 也没有 Sec-Fetch-Site 视为本机进程 → 放行', (await call(handler, { op: 'list' }, { headers: { origin: null } })).status, 200)
  equal(
    '有 Sec-Fetch-Site: cross-site 时拒绝',
    (await call(handler, { op: 'list' }, { headers: { origin: null, 'sec-fetch-site': 'cross-site' } })).status,
    403,
  )
  equal(
    '非 JSON Content-Type 被拒',
    (await call(handler, {}, { headers: { 'content-type': 'text/plain' } })).status,
    415,
  )
  equal('坏 JSON → 400', (await call(handler, {}, { rawBody: '{oops' })).status, 400)
  equal('JSON 不是对象 → 400', (await call(handler, {}, { rawBody: '[1,2]' })).status, 400)
  equal('未知 op → 400', (await call(handler, { op: 'nope' })).status, 400)
  equal('缺 id 的 read → 400', (await call(handler, { op: 'read' })).status, 400)

  console.log('\n[2] 读')
  const empty = await call(handler, { op: 'list', sessionId: 's1' })
  ok('list 成功', empty.json?.ok === true, JSON.stringify(empty.json))
  equal('空目录 items 为空', empty.json?.items?.length, 0)
  equal('还没有选择 → current 为 null', empty.json?.current, null)
  ok('返回 presetDir 供界面显示', typeof empty.json?.presetDir === 'string')

  console.log('\n[3] 写（create / save / conflict / saveAs / remove）')
  const created = (await call(handler, { op: 'create', name: '只给结论', description: '先结论后解释', body: '第一行给结论。' })).json
  ok('create 成功', created?.ok === true, JSON.stringify(created))
  equal('create 用名字当文件名', created?.id, '只给结论.md')
  ok('list 带 ignored 字段（没被识别的文件清单）', Array.isArray(empty.json?.ignored))

  const read = (await call(handler, { op: 'read', id: created.id })).json
  equal('read 名字（= 文件名去 .md）', read?.preset?.name, '只给结论')
  equal('read 正文', read?.preset?.body, '第一行给结论。\n')
  ok('read 带 mtimeMs', typeof read?.preset?.mtimeMs === 'number')

  const conflict = (await call(handler, {
    op: 'save',
    id: created.id,
    body: '改一下。',
    expectedMtimeMs: 1,
  })).json
  equal('mtime 不匹配 → conflict', conflict?.code, 'conflict')
  equal('冲突时文件没被改', readFileSync(join(box.presetDir, created.id), 'utf8').includes('第一行给结论。'), true)

  const saved = (await call(handler, {
    op: 'save',
    id: created.id,
    name: '只给结论',
    description: '先结论后解释',
    body: '改一下。',
    expectedMtimeMs: read.preset.mtimeMs,
  })).json
  ok('mtime 匹配 → 保存成功', saved?.ok === true, JSON.stringify(saved))
  equal('新 mtime 更大或相等', saved.mtimeMs >= read.preset.mtimeMs, true)

  const duplicated = (await call(handler, { op: 'create', name: '只给结论', body: '' })).json
  ok('同名新建不会覆盖，另起一个文件名', duplicated?.id !== created.id, String(duplicated?.id))

  const renamed = (await call(handler, { op: 'save', id: duplicated.id, name: '改名后的那套' })).json
  ok('save 带新名字 = 重命名文件', renamed?.ok === true, JSON.stringify(renamed))
  equal('改名后 id 就是新名字.md', renamed?.id, '改名后的那套.md')
  equal('改名前的名字读不到', (await call(handler, { op: 'read', id: duplicated.id })).json?.code, 'not-found')
  equal('改名后能读回来', (await call(handler, { op: 'read', id: renamed.id })).json?.preset?.name, '改名后的那套')

  const copy = (await call(handler, { op: 'saveAs', id: created.id, name: '只给结论 副本' })).json
  ok('saveAs 成功', copy?.ok === true, JSON.stringify(copy))
  ok('saveAs 产生新 id', copy.id !== created.id)

  const removed = (await call(handler, { op: 'remove', id: copy.id })).json
  ok('remove 成功', removed?.ok === true, JSON.stringify(removed))
  ok('remove 是软删除（进 _trash）', readdirSync(join(box.presetDir, '_trash')).length === 1)
  const afterRemove = (await call(handler, { op: 'read', id: copy.id })).json
  equal('删掉之后 read → not-found', afterRemove?.code, 'not-found')

  console.log('\n[4] 会话选择')
  const used = (await call(handler, { op: 'use', sessionId: 's1', id: created.id })).json
  ok('use 成功', used?.ok === true, JSON.stringify(used))
  const listed = (await call(handler, { op: 'list', sessionId: 's1' })).json
  equal('list 反映本次会话的选择', listed?.current, created.id)
  ok('use 之后 recent 里有它', listed?.recent?.includes(created.id) === true)
  const reset = (await call(handler, { op: 'reset', sessionId: 's1' })).json
  ok('reset 成功', reset?.ok === true, JSON.stringify(reset))
  equal('reset 之后 current 为 null', (await call(handler, { op: 'list', sessionId: 's1' })).json?.current, null)

  console.log('\n[4.5] 内部排序（reorder）')
  // 目录里现在有：created（改过正文的那套）+ 同名新建出来的那一套（remove 掉的是副本）
  const beforeOrder = (await call(handler, { op: 'list' })).json
  const orderIds = beforeOrder.items.map(item => item.id)
  ok('列表至少两套（才谈得上排序）', orderIds.length >= 2, orderIds.join(' | '))
  equal('新预设没有排序记录时排在后面（按 id）', orderIds.join('|') !== '', true)

  const moved = (await call(handler, { op: 'reorder', id: orderIds[orderIds.length - 1], position: 1 })).json
  ok('reorder 成功', moved?.ok === true, JSON.stringify(moved))
  equal('返回值里第一项就是被挪动的那套', moved?.order?.[0], orderIds[orderIds.length - 1])
  const afterOrder = (await call(handler, { op: 'list' })).json
  equal('list 立刻反映新顺序', afterOrder.items[0].id, orderIds[orderIds.length - 1])
  ok('排序表写到了 presets-order.json', readFileSync(box.orderFile, 'utf8').includes(orderIds[orderIds.length - 1]))
  equal('超过末尾的位置 → 夹到末尾', (await call(handler, { op: 'reorder', id: orderIds[0], position: 999 })).json?.order?.at(-1), orderIds[0])
  equal('位置不是整数 → 400 级错误', (await call(handler, { op: 'reorder', id: orderIds[0], position: 'x' })).status, 400)
  equal('排序不会改文件名', orderIds.every(id => readdirSync(box.presetDir).includes(id)), true)

  console.log('\n[5] 参数上限')
  const tooLong = (await call(handler, { op: 'create', name: 'x'.repeat(500) })).json
  equal('名字过长 → 400 级错误', tooLong?.code, 'bad-request')

  console.log('\n[6] 作为 cordis 插件的样子')
  // 这一段走的是"服务缺失"的降级路径，插件会按设计 warn，别打到屏幕上
  const realWarn = console.warn
  console.warn = () => {}
  equal('导出的插件名', apiPluginName, 'enhance-mode-api')

  /** 严格假 ctx：未定义的属性一律抛（复刻 cordis 4 的 Context Proxy）。 */
  function strictCtx(webServer) {
    const raw = {
      effect(fn) {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      get(serviceName) {
        return serviceName === 'webServer' ? webServer : undefined
      },
    }
    return new Proxy(raw, {
      get(target, prop) {
        if (prop in target) return Reflect.get(target, prop)
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    })
  }

  /** 带 `ctx.inject` 的假 ctx：服务"就绪"时立刻回调，模拟宿主启动顺序。 */
  function injectCtx(webServer, { ready = true } = {}) {
    const routes = []
    const raw = {
      effect(fn) {
        fn()
      },
      get(serviceName) {
        return serviceName === 'webServer' ? webServer : undefined
      },
      inject(names, callback) {
        if (!ready) return
        const child = strictCtx(webServer)
        // 子 ctx 只补一个 inject，其余照旧严格
        raw.injected = names
        callback(new Proxy(raw, {
          get(target, prop) {
            if (prop in target) return Reflect.get(target, prop)
            throw new Error(`cannot get property "${String(prop)}" without inject`)
          },
        }))
      },
    }
    return { ctx: raw, routes }
  }

  let offlineThrew = null
  try {
    applyApiPlugin(strictCtx(undefined))
  } catch (error) {
    offlineThrew = error
  }
  ok('没有 webServer 时 apply() 不抛（界面降级，提示词层不受影响）', offlineThrew === null, offlineThrew?.message)

  const routes = []
  let disposed = false
  applyApiPlugin(strictCtx({
    register(route) {
      routes.push(route)
      return () => {
        disposed = true
      }
    },
  }))
  equal('注册了一条路由', routes.length, 1)
  equal('路由是 exact + API_PATH', `${routes[0]?.kind} ${routes[0]?.path}`, `exact ${API_PATH}`)
  equal('注册了 handler', typeof routes[0]?.handler, 'function')
  ok('撤销钩子挂到了 ctx.effect 上', disposed === false)

  // 宿主真实顺序：webServer 可能比我们这行晚就绪 → 必须走 ctx.inject 等它
  const injected = injectCtx({
    register(route) {
      injected.routes.push(route)
      return () => {}
    },
  })
  applyApiPlugin(injected.ctx)
  equal('走 ctx.inject 等 webServer 就绪', JSON.stringify(injected.ctx.injected), '["webServer"]')
  equal('就绪后注册了路由', injected.routes.length, 1)

  const neverReady = injectCtx(undefined, { ready: false })
  let pendingThrew = null
  try {
    applyApiPlugin(neverReady.ctx)
  } catch (error) {
    pendingThrew = error
  }
  ok('webServer 永远不就绪时 apply() 也不抛（只是不注册）', pendingThrew === null, pendingThrew?.message)
  console.warn = realWarn

  rmSync(box.root, { recursive: true, force: true })
  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
