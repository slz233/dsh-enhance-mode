#!/usr/bin/env node
/**
 * 浏览器半（client/index.js）的离线测试。
 *
 * 这个文件不是普通 ESM：它按宿主的模块协议包成
 * `window.__ModuleLoader__.load({ id, factory(require) })`，
 * 工厂里只能取"平台种子"模块。所以测试里用 vm 跑它、给假 window、
 * 假的 react / react-dom，然后断言三件事：
 *   1. 注册形状对（id / inject / apply）；
 *   2. 槽位注册名对（`conversation.input.dock`）——写错就是静默不显示；
 *   3. 会话预设的闸门对（标准模式返回 null，增强模式才渲染）。
 *
 * 跑：node scripts/test-client.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = resolve(HERE, '..', 'client', 'index.js')

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

/** 极简 React 替身：够跑通"组件函数被调用一次"这件事，不做渲染。 */
let stateCall = 0
let stateOverrides = null
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } }
  },
  useState(initial) {
    const index = stateCall
    stateCall += 1
    const value = stateOverrides !== null && stateOverrides.has(index) ? stateOverrides.get(index) : initial
    return [value, () => {}]
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  Fragment: 'Fragment',
}

/**
 * 官方 bundle 里确实用过的 primitives 导出（从 0.2.2-rc.5 的各个 client.js 扫出来的）。
 * 客户端只能从模块表里拿这些名字：写错一个，组件就是 `undefined`，界面上什么都不显示。
 */
const VERIFIED_PRIMITIVES = new Set([
  'Button', 'Input', 'Menu', 'MenuItemButton', 'Modal', 'Tooltip', 'Tag', 'Toast', 'StateDot', 'Pill',
  'Checkbox', 'Switch', 'SegmentedControl', 'SegmentedTabs', 'MarkdownText', 'TextShimmer', 'DisclosureRow',
  'MenuSurface', 'MenuGroup', 'HoverCard', 'HoverCardGroup', 'InlineEditor', 'JsonBlock', 'CodeBlock',
  'IconChevronDownOutlineRegular', 'IconChevronUpOutlineRegular', 'IconChevronRightOutlineRegular',
  'IconCheckOutlineRegular', 'IconCloseOutlineRegular', 'IconEditOutlineRegular', 'IconPlusOutlineRegular',
  'IconRefreshOutlineRegular', 'IconTrashOutlineRegular', 'IconSettingsOutlineMedium', 'IconListPenOutlineRegular',
  'IconSlidersTwoOutlineRegular', 'IconSearchOutlineRegular', 'IconEllipsisOutlineRegular',
  'IconWarningOutlineRegular', 'IconAgentPresetOutlineRegular', 'IconChecklistOutlineRegular',
])

/** primitives 替身：每个名字都是一个什么都不渲染的组件。 */
const primitivesStub = Object.fromEntries(
  [...VERIFIED_PRIMITIVES].map(name => [name, function Stub() { return null }]),
)

/** 加载客户端的工厂，返回 { id, plugin }。 */
function loadClient() {
  const source = readFileSync(CLIENT_FILE, 'utf8')
  const registrations = []
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { append() {} },
    addEventListener() {},
    removeEventListener() {},
    body: {},
  }
  const fetchCalls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
      setTimeout: () => 0,
    },
    navigator: { language: 'zh-CN' },
    document,
    // 「打开文件夹」走宿主的 /open-in-app 路由：两个 GET/POST 都记下来
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init })
      if (String(url).includes('open-in-app/apps')) {
        return { ok: true, status: 200, json: async () => ({ apps: ['explorer', 'cursor'] }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
    // 插件自己会 warn 一句"没有 slots 服务"，那是被断言的正常路径，别打到屏幕上
    console: { log: console.log, warn() {}, error: console.error },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: CLIENT_FILE })
  ok('只注册一次模块', registrations.length === 1, `实际 ${registrations.length}`)
  const registration = registrations[0]
  const plugin = registration.factory(specifier => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
    throw new Error(`测试没有提供模块：${specifier}`)
  })
  return { id: registration.id, plugin, source, fetchCalls, document }
}

/** 假 ctx：只实现 slots 与 effect，其余属性访问一律抛（复刻 cordis 4 的 Proxy）。 */
function strictCtx({ withSlots = true } = {}) {
  const registrations = []
  const raw = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) {
      if (name === 'slots' && withSlots) return slots
      return undefined
    },
  }
  const slots = {
    inject(name, callback) {
      callback()
    },
    register(entry, component) {
      registrations.push({ entry, component })
      return () => {}
    },
  }
  const proxy = new Proxy(raw, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return { ctx: proxy, registrations, slots }
}

console.log(`加载 ${CLIENT_FILE}\n`)
const { id, plugin, fetchCalls, document: fakeDocument } = loadClient()

console.log('[1] 模块形状')
ok('模块 id 是包名', id === '@slz233/dsh-enhance-mode', id)
ok('导出 apply', typeof plugin.apply === 'function')
ok('inject 里只有 slots', Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'slots', JSON.stringify(plugin.inject))

console.log('\n[2] 槽位注册')
const strict = strictCtx()
let threw = null
try {
  plugin.apply(strict.ctx)
} catch (error) {
  threw = error
}
ok('apply() 不因未 inject 的属性访问而抛（cordis 守卫）', threw === null, threw?.message)
ok('注册了一个槽位', strict.registrations.length === 1, `实际 ${strict.registrations.length}`)
const registered = strict.registrations[0]
ok('槽位名对（conversation.input.dock）', registered?.entry?.name === 'conversation.input.dock', registered?.entry?.name)
ok('槽位 id 稳定', registered?.entry?.id === 'enhance-mode-preset', registered?.entry?.id)
ok('槽位 order 是数字', typeof registered?.entry?.order === 'number')
ok('组件是函数', typeof registered?.component === 'function')

console.log('\n[3] 没有 slots 服务时只警告不抛')
const bare = strictCtx({ withSlots: false })
let bareThrew = null
try {
  plugin.apply(bare.ctx)
} catch (error) {
  bareThrew = error
}
ok('slots 缺失时 apply() 不抛', bareThrew === null, bareThrew?.message)
ok('slots 缺失时什么都不注册', bare.registrations.length === 0)

console.log('\n[4] 会话预设闸门')
const DockEntry = registered.component
/** 造一个 slot props：useSessions 是真宿主给的"选择器 hook"。 */
function props(preset, extra = {}) {
  return {
    sessionId: 'session-1',
    useSessions: selector => selector({
      byId: { 'session-1': { projectionValues: preset === undefined ? {} : { agentPreset: preset } } },
    }),
    ...extra,
  }
}

ok('标准模式 → 不渲染', DockEntry(props('standard')) === null)
ok('没有预设信息 → 不渲染', DockEntry(props(undefined)) === null)
const enhanced = DockEntry(props('enhance'))
ok('增强模式 → 渲染', enhanced !== null && typeof enhanced === 'object', JSON.stringify(enhanced))
ok('外面那一行是 dock 外壳', enhanced?.type === 'div')
const dockChild = enhanced?.props?.children?.[0]
const cleanChild = enhanced?.props?.children?.[1]
ok('渲染出来的是胶囊组件', typeof dockChild?.type === 'function')
ok('把 sessionId 传下去了', dockChild?.props?.sessionId === 'session-1')
ok('把翻译函数传下去了', typeof dockChild?.props?.t === 'function')
equal('翻译函数能取到中文文案', dockChild?.props?.t('dock.label', { preset: '喵' }), '增强 · 喵')
ok('清理失败按钮挂在这一行', typeof cleanChild?.type === 'function')
ok('清理按钮拿到 sessionId', cleanChild?.props?.sessionId === 'session-1')
ok('只留一个按钮：胶囊 + 清理失败', enhanced?.props?.children?.length === 2)
ok('缺 sessionId 时不渲染', DockEntry(props('enhance', { sessionId: '' })) === null)

console.log('\n[5] 没有 useSessions 时的回退')
const fallback = DockEntry({
  sessionId: 'session-2',
  session: { projectionValues: { agentPreset: 'enhance' } },
})
ok('从 props.session 也能认出增强模式', fallback !== null)
ok('标准模式仍然不渲染', DockEntry({ sessionId: 'session-2', session: { projectionValues: { agentPreset: 'standard' } } }) === null)

console.log('\n[6] 只 require 平台种子模块')
// 宿主的模块表里只放了这几个"种子"；require 任何别的东西都会在工厂执行时抛错，
// 而这个错发生在客户端插件激活阶段——界面上只会"什么都没有"，不会有任何提示。
const SEED_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])
const source = readFileSync(CLIENT_FILE, 'utf8')
const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
ok('至少 require 了 react', required.includes('react'), JSON.stringify(required))
ok('用上了宿主的 primitives', required.includes('@deepseek-ai/dsh-client-ui-primitives'), JSON.stringify(required))
const unknown = required.filter(specifier => !SEED_MODULES.has(specifier))
ok('没有 require 种子表之外的模块', unknown.length === 0, unknown.join(', '))

console.log('\n[6.5] 包清单能被宿主解析')
// 宿主靠 JSON.parse(读 package.json) 找 dsh.client。PowerShell 的 `Set-Content -Encoding UTF8`
// 会加 BOM，JSON.parse 直接抛——客户端产物于是永远不出现，而且界面上没有任何提示。
const manifestBytes = readFileSync(new URL('../package.json', import.meta.url))
ok('package.json 没有 BOM', !(manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf),
  `首三字节 ${[...manifestBytes.subarray(0, 3)].join(',')}`)
let manifest = null
try {
  manifest = JSON.parse(manifestBytes.toString('utf8'))
} catch (error) {
  ok('package.json 是合法 JSON', false, error.message)
}
ok('package.json 是合法 JSON', manifest !== null)
ok('声明了 dsh.client.platform = web', manifest?.dsh?.client?.platform === 'web')
ok('导出了 ./client 产物', typeof manifest?.exports?.['./client'] === 'string')

console.log('\n[7] primitives 里用到的名字都真实存在')
// 名字写错的后果和 require 报错一样：组件是 undefined，界面上什么都不显示。
// 这份白名单是从 0.2.2-rc.5 官方 client bundle 里扫出来的真实导出。
const destructure = /const \{([\s\S]*?)\} = require\(['"]@deepseek-ai\/dsh-client-ui-primitives['"]\)/u.exec(source)
ok('找到了对 primitives 的解构', destructure !== null)
const usedNames = destructure === null
  ? []
  : destructure[1].split(',').map(part => part.trim().split(/\s+as\s+/u)[0].trim()).filter(Boolean)
ok('解构了不止一个组件', usedNames.length > 3, String(usedNames.length))
const invented = usedNames.filter(name => !VERIFIED_PRIMITIVES.has(name))
ok('没有编造组件名', invented.length === 0, invented.join(', '))

console.log('\n[8] 渲染不崩（胶囊 + 管理弹窗各跑一次）')
// useState 替身按"第几次调用"返回固定值，所以可以钉住某个状态来走到弹窗那条分支：
//   0 open / 1 list / 2 current / 3 unavailable / 4 managerOpen
//   5 pending / 6 error（胶囊自己的 useAsyncAction）
//   7 items / 8 selectedId / …（管理弹窗的 state）
const sampleList = {
  ok: true,
  items: [
    { id: '01-喵.md', name: '01-喵', description: '每段结尾一个喵', chars: 23, inUse: 0, mtimeMs: 1 },
    { id: '02-老大.md', name: '02-老大', description: '每段开头叫老大', chars: 21, inUse: 1, mtimeMs: 2 },
  ],
  current: '02-老大.md',
  recent: ['01-喵.md'],
  total: 2,
  persisted: undefined,
  ignored: [],
}

stateCall = 0
stateOverrides = new Map([[1, sampleList], [2, '02-老大.md']])
let dockRender = null
let dockThrew = null
try {
  dockRender = dockChild.type(dockChild.props)
} catch (error) {
  dockThrew = error
}
ok('胶囊渲染不抛', dockThrew === null, dockThrew?.message)
ok('胶囊最外层是容器 div', dockRender?.type === 'div', String(dockRender?.type))
const menu = dockRender?.props?.children?.find(child => child !== null && typeof child === 'object' && child.props?.anchor !== undefined)
ok('胶囊里有下拉菜单', menu !== undefined)
ok('菜单 anchor 带 aria-haspopup', menu?.props?.anchor?.props?.['aria-haspopup'] === 'menu')
ok('菜单默认关闭', menu?.props?.open === false)
ok('下拉列表带限高类（最多显示 5 套，多的滚动）', String(menu?.props?.listClassName ?? '').includes('menuList'), String(menu?.props?.listClassName))
const caption = dockRender?.props?.children?.find(child => String(child?.props?.className ?? '').includes('caption'))
ok('有说明文字那一截', caption !== undefined)
ok('说明文字是当前预设的描述', caption?.props?.children?.[0] === '每段开头叫老大', String(caption?.props?.children?.[0]))
ok('说明文字不接点击（只能点前面的按钮）', caption?.props?.onClick === undefined && caption?.props?.onSelect === undefined)
ok('说明文字带 title（省略号时悬停看全文）', caption?.props?.title === '每段开头叫老大')

stateCall = 0
stateOverrides = new Map([[1, sampleList], [4, true], [7, sampleList.items], [8, '01-喵.md'], [9, { name: '01-喵', description: '每段结尾一个喵', body: '每句话结尾加喵。\n' }], [10, 1], [11, 0]])
let modalThrew = null
let dockWithModal = null
try {
  dockWithModal = dockChild.type(dockChild.props)
} catch (error) {
  modalThrew = error
}
ok('打开管理弹窗时不抛', modalThrew === null, modalThrew?.message)
// 管理弹窗是个组件元素，React 之后才会调用它；这里手动调一次（状态序号接着往下走，
// 正好对上上面 overrides 里 7 以后那批）
const managerEl = dockWithModal?.props?.children?.find(child => child !== null
  && typeof child === 'object' && typeof child.type === 'function' && 'sessionId' in (child.props ?? {}))
ok('胶囊里挂了管理弹窗元素', managerEl !== undefined)
let modal = null
let modalRenderThrew = null
let closeCalls = 0
try {
  modal = managerEl === undefined
    ? null
    : managerEl.type({ ...managerEl.props, onClose: () => { closeCalls += 1 } })
} catch (error) {
  modalRenderThrew = error
}
ok('弹窗渲染不抛', modalRenderThrew === null, modalRenderThrew?.message)

/** 在元素树里按条件找第一个匹配的元素。 */
function findElement(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

// 管理弹窗现在返回的是 Fragment（主弹窗 + 未保存确认窗），主弹窗要单独拎出来
const mainModal = findElement(modal, node => node?.props?.footer !== undefined)
ok('Fragment 里有主弹窗', mainModal !== null)
ok('弹窗挂上了 footer', mainModal?.props?.footer !== undefined)
ok('弹窗标题走文案表', typeof mainModal?.props?.title === 'string' && mainModal.props.title.length > 0, String(mainModal?.props?.title))
ok('弹窗默认是只读（没有 textarea）', JSON.stringify(modal?.props?.children ?? []).includes('textarea') === false)

const orderField = findElement(modal, node => node?.props?.type === 'number')
ok('弹窗里有排序输入框', orderField !== null)
ok('排序输入框显示当前是第几位（第一套 → 1）', orderField?.props?.value === '1', String(orderField?.props?.value))
ok('排序输入框只收整数（min=1）', orderField?.props?.min === 1)
ok('排序输入框带说明（title）', typeof orderField?.props?.title === 'string' && orderField.props.title.length > 0)

console.log('\n[8.1] 关闭行为：点空白不关，ESC / × 才关')
// 宿主的 Modal 把遮罩、×、ESC 都接到 onClose；我们的 guardedClose 按事件来源分流。
fakeDocument.querySelector = () => ({ contains: () => false })
mainModal?.props?.onClose({ target: { nodeType: 1 } })
ok('点遮罩（对话框外）不会关闭', closeCalls === 0, String(closeCalls))
fakeDocument.querySelector = () => ({ contains: () => true })
mainModal?.props?.onClose({ target: { nodeType: 1 } })
ok('点右上角 ×（对话框内）会关闭', closeCalls === 1, String(closeCalls))
mainModal?.props?.onClose()
ok('ESC（宿主不传事件）会关闭', closeCalls === 2, String(closeCalls))

console.log('\n[9] 文件夹、刷新、被忽略的文件')
// 管理弹窗的 useState 序号：7 items → 18 note → 19 folder → 20 ignored → 21 folderBusy → 22 orderDraft → 23 closePrompt
stateCall = 0
stateOverrides = new Map([
  [1, sampleList], [4, true], [7, sampleList.items], [8, '01-喵.md'],
  [9, { name: '01-喵', description: '', body: '' }], [10, 1], [11, 0],
  [19, 'C:\\预设目录'],
  [20, [{ name: 'notes.txt', reason: 'not-markdown' }]],
])
let modal2 = null
let modal2Threw = null
try {
  const dock2 = dockChild.type(dockChild.props)
  const managerEl2 = dock2?.props?.children?.find(child => child !== null
    && typeof child === 'object' && typeof child.type === 'function' && 'sessionId' in (child.props ?? {}))
  modal2 = managerEl2 === undefined ? null : managerEl2.type(managerEl2.props)
} catch (error) {
  modal2Threw = error
}
ok('带目录和忽略清单重新渲染不抛', modal2Threw === null, modal2Threw?.message)

const ignoredNote = findElement(modal2, node => String(node?.props?.className ?? '').includes('ignored'))
ok('有被忽略的文件时给一行提示', ignoredNote !== null)
ok('提示里点了文件名', String(ignoredNote?.props?.children ?? '').includes('notes.txt')
  || String(ignoredNote?.props?.title ?? '').includes('notes.txt'))

const mainModal2 = findElement(modal2, node => node?.props?.footer !== undefined)
const folderButton = findElement(mainModal2?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '打开文件夹')
ok('footer 里有「打开文件夹」按钮', folderButton !== null)
fetchCalls.length = 0
let folderThrew = null
try {
  folderButton?.props?.onClick?.()
  // onClick 里是 `void openFolder()`，等它把两个 fetch 都跑完
  await new Promise(resolve => setImmediate(resolve))
} catch (error) {
  folderThrew = error
}
ok('点它不抛', folderThrew === null, folderThrew?.message)
equal('先问宿主有哪些应用', fetchCalls[0]?.url, 'open-in-app/apps')
equal('再走官方路由打开目录', fetchCalls[1]?.url, 'open-in-app/open')
let openBody = {}
try {
  openBody = JSON.parse(String(fetchCalls[1]?.init?.body ?? '{}'))
} catch {
  openBody = {}
}
equal('app 选平台文件管理器（explorer）', openBody.app, 'explorer')
equal('path 是预设目录', openBody.path, 'C:\\预设目录')

const refreshButton = findElement(mainModal2?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '刷新')
ok('footer 里有「刷新」按钮', refreshButton !== null)
fetchCalls.length = 0
try {
  refreshButton?.props?.onClick?.()
  await new Promise(resolve => setImmediate(resolve))
} catch {
  // 刷新失败会走 actions.setError，测试只看它有没有真的发请求
}
ok('点刷新会重新拉一次列表（op=list）',
  fetchCalls.some(call => call.url === '/enhance/api' && String(call.init?.body ?? '').includes('"op":"list"')),
  JSON.stringify(fetchCalls.map(call => call.url)))

console.log('\n[10] 描述输入框有字数上限')
stateCall = 0
stateOverrides = new Map([
  [1, sampleList], [4, true], [7, sampleList.items], [8, '01-喵.md'],
  [9, { name: '01-喵', description: '长'.repeat(200), body: '正文\n' }],
  [10, 1], [11, 0], [13, true],
])
let modal3 = null
try {
  const dock3 = dockChild.type(dockChild.props)
  const managerEl3 = dock3?.props?.children?.find(child => child !== null
    && typeof child === 'object' && typeof child.type === 'function' && 'sessionId' in (child.props ?? {}))
  modal3 = managerEl3 === undefined ? null : managerEl3.type(managerEl3.props)
} catch {
  modal3 = null
}
const descriptionInput = findElement(modal3, node => node?.props?.maxLength === 120)
ok('编辑状态下描述输入框带 maxLength=120', descriptionInput !== null)

const bulkEntry = findElement(mainModal2?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '批量选择')
ok('普通 footer 里有「批量选择」按钮', bulkEntry !== null)

console.log('\n[11] 批量选择模式')
// 状态序号：23 closePrompt / 24 selectMode / 25 selectedIds / 26 bulkAnchor / 27 confirmBulk
stateCall = 0
stateOverrides = new Map([
  [1, sampleList], [4, true], [7, sampleList.items], [8, '01-喵.md'],
  [9, { name: '01-喵', description: '', body: '' }], [10, 1], [11, 0],
  [24, true], [25, ['01-喵.md']],
])
let modal4 = null
let modal4Threw = null
try {
  const dock4 = dockChild.type(dockChild.props)
  const managerEl4 = dock4?.props?.children?.find(child => child !== null
    && typeof child === 'object' && typeof child.type === 'function' && 'sessionId' in (child.props ?? {}))
  modal4 = managerEl4 === undefined ? null : managerEl4.type(managerEl4.props)
} catch (error) {
  modal4Threw = error
}
ok('批量模式渲染不抛', modal4Threw === null, modal4Threw?.message)
const mainModal4 = findElement(modal4, node => node?.props?.footer !== undefined)
const bulkAll = findElement(mainModal4?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '全选')
ok('批量模式有「全选」按钮', bulkAll !== null)
ok('批量模式没有「编辑」（只能删）', findElement(mainModal4?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '编辑') === null)
const bulkDelete = findElement(mainModal4?.props?.footer,
  node => Array.isArray(node?.props?.children) && String(node.props.children[0]).startsWith('删除选中的'))
ok('批量模式有「删除选中的 N 套」按钮', bulkDelete !== null)
ok('已经选了一套时删除可用', bulkDelete?.props?.disabled === false)
ok('退出批量按钮在', findElement(mainModal4?.props?.footer,
  node => Array.isArray(node?.props?.children) && node.props.children[0] === '退出批量') !== null)
const selectedRow = findElement(modal4, node => node?.props?.['data-selected'] === 'true')
ok('选中的行有标记', selectedRow !== null)
ok('选中行标题带 ✓', String(selectedRow?.props?.children?.[0]?.props?.children ?? '').startsWith('✓ '),
  String(selectedRow?.props?.children?.[0]?.props?.children))

function equal(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
