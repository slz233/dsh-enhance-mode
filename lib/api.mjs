/**
 * 宿主侧常驻行：给界面开一条**只在本机、只认同源**的 HTTP 数据通道。
 *
 * 为什么需要它：浏览器的界面拿不到文件系统，所有读写必须回宿主做。
 * 宿主对插件开放的三条路里，
 *   - 自建 remote service 要 import 宿主包（插件装在 profile 里，解析不到）；
 *   - 复用斜杠命令（`commands.execute`）能跑，但它会把每次调用记成一条
 *     `command/run` `command/done` 流节点——界面上点一下「保存」就往对话里
 *     插一张卡片，还要求会话已开始；
 *   - 宿主 `webServer` 服务对外开放 `register({kind, path, handler})`。
 * 所以走第三条：一条 exact 路由，JSON 进 JSON 出，写盘仍然落到
 * `lib/actions.mjs`（和 `/enhance` 命令、`enhance_preset` 工具同一份逻辑）。
 *
 * 安全边界（本机插件也不该给本机开个任意写盘口子）：
 *   1. 只接受 POST + `Content-Type: application/json`；
 *   2. Host 存在时必须是本机回环字面量（127.0.0.1 / localhost / ::1）；
 *      宿主命名路由绕过页面令牌校验，这一条挡的是 DNS rebinding；
 *      Host 被代理剥掉时（桌面版会剥）只能放行——浏览器一定带 Host；
 *   3. 校验 Origin/Sec-Fetch-Site（规则见 `sameOrigin()`，照 dshmarket 实战版）；
 *   4. 只认下面那张表里的 op，参数一律当字符串校验长度，绝不拼接路径；
 *   5. 请求体上限 512 KB，超了直接 413。
 * 因此别的网页往 127.0.0.1:9717 POST 会被同源检查 + JSON 预检挡掉，rebinding 会被 Host 检查挡掉。
 *
 * 失败不抛：拿不到 `webServer`（例如 Electron 走 file:// 的宿主）就返回 null，
 * 界面照设计稿降级成「暂不可用」，提示词那一层完全不受影响。
 */

import { createPresetActions } from './actions.mjs'
import { healSession } from './heal.mjs'
import { resolveDefaultFile, resolveOrderFile, resolvePresetDir, resolveSessionsFile } from './paths.mjs'
import { safeService } from './services.mjs'
import { checkForUpdate, localPackage } from './update.mjs'

/** 路由路径：固定，界面里也写死这一个常量（改这里要同步 client/index.js）。 */
export const API_PATH = '/enhance/api'

/** 请求体上限。一套预设正文按 512 KB 算已经很宽了。 */
const MAX_BODY_BYTES = 512 * 1024

/** 单个文本字段上限（字符数），防止有人拿它当文件服务器用。 */
const MAX_TEXT_CHARS = 100000

/** 路由插件在 cordis 里的名字。 */
export const name = 'enhance-mode-api'

/**
 * **故意不写 `inject`。**
 * 这里只通过 `safeService()` 读服务：宿主没提供 `webServer` 时降级，
 * 而不是让整行激活失败（activate 失败会连带影响同包的预设行，0.3.0 踩过）。
 */

/** 参数不合法。和业务失败分开，好让界面文案不同。 */
class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 打一条警告；console 不可用时保持安静。 */
function warn(text) {
  try {
    console.warn(`[enhance-mode] ${text}`)
  } catch {
    // 无所谓
  }
}

/**
 * Host 是否本机回环。
 *
 * 为什么单独查这一条：`webServer` 的命名路由**绕过了页面令牌校验**
 * （实测 `GET /index.html` 是 401、`GET /assets/*` 是 200，命名路由完全自己负责响应）。
 * 同源检查挡得住跨站请求，但挡不住 DNS rebinding——那场景下页面的 Origin 和 Host
 * 会一起变成攻击者的域名，两者恰好"同源"。Host 是攻击者伪造不了的头。
 * @param {string} host
 */
function loopbackAuthority(host) {
  const lower = String(host).toLowerCase()
  // IPv6 字面量带方括号：`[::1]:9717` → `[::1]`
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

/**
 * 同源校验。规则是照 `dshmarket` 的实战版抄的（它在同一个桌面版里踩过坑）：
 *
 * - **Host 缺失就放行**：桌面版自己的代理会把 `origin`/`host`/`cookie`/`sec-fetch-site`
 *   一起剥掉再转给宿主进程。浏览器发的请求一定带 Host，所以"缺 Host"不是网页能做到的；
 * - Host 在、但不是回环 → 拒绝（挡 DNS rebinding）；
 * - `Sec-Fetch-Site: cross-site` → 拒绝（浏览器自己说的跨站，最省事的否决）；
 * - Origin 缺失 → 放行（同理：网页的 POST 必带 Origin，缺了就不是网页）；
 * - Origin 存在但解析不了（`null`、空串）→ 拒绝，这是"存在但不是合法源"，不是"没有"；
 * - Origin 与 Host 完全相同 → 放行；
 * - Chrome 151+ 在回环源上会**省略端口**（`Origin: http://127.0.0.1` 对 `Host: 127.0.0.1:9717`），
 *   这种情况只比主机名，且只在 Host 已被确认是回环时才放宽。
 * @param {import('node:http').IncomingMessage} req
 */
function sameOrigin(req) {
  const host = req.headers.host
  if (host !== undefined && !loopbackAuthority(host)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    if (host !== undefined && originUrl.host === host) return true
    if (originUrl.port === '' && host !== undefined && loopbackAuthority(host)) {
      return originUrl.hostname === new URL(`http://${host}`).hostname
    }
    return false
  } catch {
    return false
  }
}

/**
 * 读请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', error => {
      reject(new ApiError(400, `读取请求失败：${error?.message ?? error}`))
    })
  })
}

/** 写 JSON 响应。 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.end(body)
}

/** 取一个必填字符串字段。 */
function requiredText(input, field, max = MAX_TEXT_CHARS) {
  const value = input[field]
  if (typeof value !== 'string') throw new ApiError(400, `字段 ${field} 必须是字符串`)
  if (value.length > max) throw new ApiError(400, `字段 ${field} 太长（上限 ${max} 字符）`)
  return value
}

/** 取一个可选字符串字段；没给就是 undefined。 */
function optionalText(input, field, max = MAX_TEXT_CHARS) {
  if (input[field] === undefined || input[field] === null) return undefined
  return requiredText(input, field, max)
}

/** 取 mtime 栅栏：数字 = 必须匹配；null/undefined = 不校验。 */
function optionalMtime(input) {
  const value = input.expectedMtimeMs
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, '字段 expectedMtimeMs 必须是数字或 null')
  }
  return value
}

/** 取一个必填整数（排序位置用）。 */
function requiredInteger(input, field) {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ApiError(400, `字段 ${field} 必须是整数`)
  }
  return value
}

/**
 * 把一次调用派发到 `lib/actions.mjs`。
 * @param {ReturnType<typeof createPresetActions>} actions
 * @param {{ op?: unknown } & Record<string, unknown>} input
 * @param {{ heal?: (payload: Record<string, unknown>) => Record<string, unknown> }} [extras]
 */
function dispatch(actions, input, extras = {}) {
  const op = typeof input.op === 'string' ? input.op : ''
  switch (op) {
    case 'list':
      return actions.list({ sessionId: optionalText(input, 'sessionId', 200) })
    case 'read':
      return actions.read({ id: requiredText(input, 'id', 200) })
    case 'use':
      return actions.use({
        sessionId: requiredText(input, 'sessionId', 200),
        id: requiredText(input, 'id', 200),
      })
    case 'reset':
      return actions.reset({ sessionId: optionalText(input, 'sessionId', 200) })
    case 'create':
      return actions.create({
        name: optionalText(input, 'name', 200),
        description: optionalText(input, 'description', 2000),
        body: optionalText(input, 'body'),
      })
    case 'save':
      return actions.update({
        id: requiredText(input, 'id', 200),
        name: optionalText(input, 'name', 200),
        description: optionalText(input, 'description', 2000),
        body: optionalText(input, 'body'),
        expectedMtimeMs: optionalMtime(input),
      })
    case 'saveAs':
      return actions.saveAs({ id: requiredText(input, 'id', 200), name: optionalText(input, 'name', 200) })
    case 'remove':
      return actions.remove({ id: requiredText(input, 'id', 200) })
    case 'reorder':
      return actions.reorder({
        id: requiredText(input, 'id', 200),
        position: requiredInteger(input, 'position'),
      })
    case 'heal': {
      // 输入框那个「清理失败」按钮走这里
      if (typeof extras.heal !== 'function') {
        return { ok: false, code: 'no-sessions-service', message: '宿主没有会话服务，清理不可用。' }
      }
      return extras.heal({
        sessionId: optionalText(input, 'sessionId', 200),
        dryRun: input.dryRun !== false,
        mode: input.mode === 'undo' || input.mode === 'clean' ? input.mode : 'auto',
      })
    }
    case 'update': {
      // 版本检查：宿主不给第三方插件「更新」按钮，只能我们自己在界面里提示
      if (typeof extras.update !== 'function') {
        return { ok: false, code: 'no-update', message: '版本检查不可用。' }
      }
      return extras.update({ force: input.force === true })
    }
    default:
      throw new ApiError(400, `未知的 op：${op === '' ? '（空）' : op}`)
  }
}

/**
 * 造一个 host 路由 handler。
 * @param {ReturnType<typeof createPresetActions>} actions
 * @param {{ heal?: (payload: Record<string, unknown>) => Record<string, unknown> }} [extras]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(actions, extras = {}) {
  return async function handle(req, res) {
    try {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method', message: '只接受 POST' })
        return
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'origin', message: '拒绝来自非本机同源界面的请求' })
        return
      }
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        send(res, 415, { ok: false, code: 'content-type', message: '只接受 application/json' })
        return
      }
      const text = await readBody(req)
      let input
      try {
        input = text.trim() === '' ? {} : JSON.parse(text)
      } catch {
        send(res, 400, { ok: false, code: 'json', message: '请求体不是合法 JSON' })
        return
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        send(res, 400, { ok: false, code: 'json', message: '请求体必须是一个对象' })
        return
      }
      send(res, 200, await dispatch(actions, input, extras))
    } catch (error) {
      if (error instanceof ApiError) {
        send(res, error.status, { ok: false, code: 'bad-request', message: error.message })
        return
      }
      // 业务失败（PresetError 等）已经被 actions 收成 {ok:false}，走到这里是真意外
      send(res, 500, { ok: false, code: 'internal', message: `界面通道出错：${error?.message ?? error}` })
    }
  }
}

/**
 * 注册路由。拿不到 `webServer`（宿主不是 HTTP 形态）时返回 null，不抛。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dir?: string, file?: string, presetDir?: string, sessionsFile?: string }} [config]
 * @returns {(() => void) | null} 撤销函数
 */
export function registerEnhanceApi(ctx, config = {}) {
  const webServer = safeService(ctx, 'webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    warn(`宿主没有提供 webServer 服务，界面通道（${API_PATH}）不注册；界面会显示「暂不可用」`)
    return null
  }

  const actions = createPresetActions({
    presetDir: resolvePresetDir(config),
    defaultFile: resolveDefaultFile(config),
    sessionsFile: resolveSessionsFile(config),
      orderFile: resolveOrderFile(config),
  })

  let disposer
  try {
    disposer = webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: createApiHandler(actions, {
        heal: payload => healSession(ctx, payload.sessionId ?? null, {
          dryRun: payload.dryRun !== false,
          mode: payload.mode === 'undo' || payload.mode === 'clean' ? payload.mode : 'auto',
        }),
        update: payload => checkForUpdate({ force: payload.force === true }),
      }),
    })
  } catch (error) {
    // 同一进程里重复注册会抛；重复挂载是配置问题，但绝不该连累提示词
    warn(`界面通道路由注册失败：${error?.message ?? error}`)
    return null
  }
  return typeof disposer === 'function' ? disposer : null
}

/**
 * 包根入口（profile 里那一行常驻插件）。
 *
 * 这一行做两件事：注册界面通道，以及当客户端产物的锚点——宿主按"被挂载的行"
 * 找包清单里的 `dsh.client`，而**只有裸包名**能被认出来（子路径行会被跳过），
 * 所以这个行必须用 `name: '@slz233/dsh-enhance-mode'`。
 *
 * 用 `ctx.inject(['webServer'], …)` 等服务就绪而不是一次性 `ctx.get()`：
 * 一次性读取会因为宿主启动顺序（webServer 还没构造完）而静默失败；
 * `inject` 是"就绪后回调"，而且**不写进插件的 `inject` 硬依赖**，服务永远不出现时
 * 只是这个回调不执行，整行照样激活（提示词那一层不受任何影响）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  let started = false
  let updateScheduled = false

  /**
   * 启动 10 秒后静默查一次版本，结论进缓存；管理弹窗打开时只读缓存，
   * 所以用户不会等到网络。断网 / 被墙 / 没有 fetch 都当没这功能。
   */
  const scheduleUpdateCheck = () => {
    if (updateScheduled) return
    updateScheduled = true
    try {
      const timer = setTimeout(() => {
        const pkg = localPackage()
        checkForUpdate({ packageName: pkg.name, current: pkg.version }).catch(() => {})
      }, 10000)
      // 桌面端关窗时别让这个计时器把进程留住
      if (typeof timer?.unref === 'function') timer.unref()
    } catch (error) {
      warn(`版本检查排不上：${error?.message ?? error}`)
    }
  }

  scheduleUpdateCheck()

  /** 真正开始：注册路由并把撤销钩子挂到 fiber 上。 */
  const start = child => {
    if (started) return
    started = true
    const disposer = registerEnhanceApi(child)
    if (disposer !== null && typeof child.effect === 'function') {
      try {
        child.effect(() => disposer)
      } catch (error) {
        warn(`界面通道撤销钩子挂不上：${error?.message ?? error}`)
      }
    }
  }

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], start)
      return
    }
  } catch (error) {
    warn(`ctx.inject 不可用，改为立即注册：${error?.message ?? error}`)
  }
  start(ctx)
}
