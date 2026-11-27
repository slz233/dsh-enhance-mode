/**
 * 在 cordis 上下文里安全地读一个服务。
 *
 * 背景（0.2.1 修的线上故障）：cordis 4 给 Context 套了 Proxy，
 * **没写进 `inject` 的服务用属性访问会直接抛**
 * `cannot get property "xxx" without inject`。
 * 这一抛发生在 `apply()` 里时，宿主会把这一行标记为激活失败，
 * 而 DSH 的模式下拉只显示"健康"的预设（`presetOptions` 过滤 `broken`），
 * 于是症状是：插件装了、预设行也 active，但下拉里就是没有，界面上没有任何报错
 * （错误只出现在 设置 → 智能体预设 那一行后面）。
 *
 * 所以：凡是不在 `inject` 里声明的服务，一律走 `ctx.get()`。
 * 官方注释写得很清楚：`ctx.get()` 是 "Read a service from the store without the inject requirement"，
 * 服务不在时返回 `undefined`，不抛。
 */

/**
 * @param {object | undefined} ctx cordis 上下文（离线测试里可以是普通对象）
 * @param {string} name 服务名
 * @returns {unknown} 服务值；宿主没有或未激活时返回 undefined
 */
export function safeService(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      // 这个宿主版本没有该服务，或 get 本身不可用
      return undefined
    }
  }
  try {
    // 兜底只服务于离线测试里的假 ctx（真 ctx 一定有 get，走上面的分支）
    return ctx[name]
  } catch {
    return undefined
  }
}
