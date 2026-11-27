/**
 * 装配自检：用假的 ctx 跑一遍 apply()，确认
 *   1) 没有 presets 目录时，系统提示段与 0.1.0 **完全一致**（不含任何标注）；
 *   2) 选了预设时，段尾出现该预设的正文与标注；
 *   3) 预设被删时回退默认且不崩；
 *   4) 项目指令那条上下文仍然照旧注册。
 *
 * 跑法：node scripts/test-wiring.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'enhance-wiring-'))
process.env.DSH_HOME = root

const { apply, sessionIdOf } = await import('../prompt/index.js')

let passed = 0
let failed = 0

function check(name, body) {
  try {
    body()
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

/** 最小假 ctx：只实现 apply() 用到的几个方法。 */
function makeCtx() {
  const sections = []
  const contexts = []
  return {
    sections,
    contexts,
    ctx: {
      effect(fn) {
        return fn()
      },
      systemPrompt: {
        getSectionOrder(key) {
          return key === 'DEPLOYMENT_PERSONA_SUFFIX' ? 10200 : undefined
        },
        getContextOrder() {
          return 100
        },
        section(definition) {
          sections.push(definition)
          return () => {}
        },
        context(definition) {
          contexts.push(definition)
          return () => {}
        },
      },
      get() {
        return undefined
      },
    },
  }
}

/**
 * 严格假 ctx：模拟 cordis 4 的 Context Proxy —— 任何**不在对象上**的属性访问都抛
 * `cannot get property "x" without inject`，和宿主真实行为一致。
 * 只有自己定义的成员（effect / systemPrompt / get / inject）可用。
 */
function makeStrictCtx() {
  const sections = []
  const contexts = []
  const tools = []
  const commands = []
  const raw = {
    effect(fn) {
      return fn()
    },
    inject(names, callback) {
      // 宿主里这些服务当时并不存在，于是回调拿到的是同一个（仍然严格的）子 ctx
      callback(proxy)
      return () => {}
    },
    get(name) {
      if (name === 'tools') return raw.tools
      if (name === 'commands') return raw.commands
      return undefined
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      getSectionOrder(key) {
        return key === 'DEPLOYMENT_PERSONA_SUFFIX' ? 10200 : undefined
      },
      getContextOrder() {
        return 100
      },
      section(definition) {
        sections.push(definition)
        return () => {}
      },
      context(definition) {
        contexts.push(definition)
        return () => {}
      },
    },
  }
  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return { sections, contexts, tools, commands, ctx: proxy }
}

const enhanceDir = join(root, 'enhance')
const defaultFile = join(enhanceDir, 'mode-prompt.md')
const presetDir = join(enhanceDir, 'presets')
const sessionsFile = join(enhanceDir, 'sessions.json')

try {
  mkdirSync(enhanceDir, { recursive: true })
  writeFileSync(defaultFile, '默认那段话。\n', 'utf8')

  // ---------- 1. 没有 presets 目录：行为与 0.1.0 一致 ----------
  const first = makeCtx()
  apply(first.ctx, {})

  check('注册了系统提示段与项目指令上下文', () => {
    is(first.sections.length, 1)
    is(first.contexts.length, 1)
    ok(first.sections.some((section) => section.name === 'enhance:mode-prompt'), '缺主段')
    is(first.contexts[0].name, 'enhance:project-instructions')
  })

  check('段顺序 = persona suffix + 100', () => {
    is(first.sections.find((section) => section.name === 'enhance:mode-prompt').order, 10300)
  })

  check('没选预设 → 段文本 = 默认文件原文，且无任何标注', () => {
    const text = first.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 'sess-1' } })
    is(text, '默认那段话。\n')
    ok(!text.includes('本次预设'), '默认路径不应出现标注')
  })

  check('拿不到会话 id 也不崩，退回默认', () => {
    const text = first.sections.find((section) => section.name === 'enhance:mode-prompt').text({})
    is(text, '默认那段话。\n')
  })

  check('apply 会把 presets 目录建出来（但不预置文件）', () => {
    ok(existsSync(presetDir), 'presets 目录应存在')
  })

  // ---------- 2. 选了预设 ----------
  writeFileSync(
    join(presetDir, '02-只给结论.md'),
    '---\ntitle: 只给结论\ndescription: 第一行给结论\n---\n第一行只给结论；空一行；再展开理由。\n',
    'utf8',
  )
  writeFileSync(sessionsFile, JSON.stringify({ version: 1, sessions: { 'sess-1': '02-只给结论.md' }, recent: [] }), 'utf8')

  const second = makeCtx()
  apply(second.ctx, {})

  check('选了预设 → 用该预设正文 + 段尾标注', () => {
    const text = second.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 'sess-1' } })
    ok(text.startsWith('第一行只给结论'), '正文应来自预设文件')
    ok(text.trimEnd().endsWith('（本次预设：02-只给结论）'), '标注用的是文件名')
  })

  check('另一个会话不受影响（仍用默认）', () => {
    const text = second.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 'sess-2' } })
    is(text, '默认那段话。\n')
  })

  // ---------- 3. 选中的预设被删 ----------
  rmSync(join(presetDir, '02-只给结论.md'))

  check('预设被删 → 沿用本会话上一次的文案，不抛错', () => {
    const text = second.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 'sess-1' } })
    ok(text.startsWith('第一行只给结论'), '记着的还是上一次那段')
    ok(!text.includes('默认那段话'), '不该在对话中途换成默认文案')
  })

  check('从没有过历史的会话选中缺失预设 → 退回默认文案', () => {
    writeFileSync(
      sessionsFile,
      JSON.stringify({ version: 1, sessions: { 'sess-9': '99-早就没了.md' }, recent: [] }),
      'utf8',
    )
    const text = second.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 'sess-9' } })
    is(text, '默认那段话。\n')
  })

  // ---------- 4. 会话 id 解析 ----------
  check('sessionIdOf 支持字符串与对象两种形态', () => {
    is(sessionIdOf({ agent: { session: 'abc' } }), 'abc')
    is(sessionIdOf({ agent: { session: { id: 'xyz' } } }), 'xyz')
    is(sessionIdOf({}), null)
    is(sessionIdOf(undefined), null)
  })

  // ---------- 5. 默认文件缺失 → 自动补占位 ----------
  const freshRoot = mkdtempSync(join(tmpdir(), 'enhance-fresh-'))
  process.env.DSH_HOME = freshRoot
  const third = makeCtx()
  apply(third.ctx, {})

  check('首次运行会自动写默认文件（占位示例）', () => {
    const text = readFileSync(join(freshRoot, 'enhance', 'mode-prompt.md'), 'utf8')
    ok(text.includes('喵'), '占位内容应包含示例句')
    const rendered = third.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 's1' } })
    ok(rendered.includes('喵'), '段文本应读到占位内容')
  })
  rmSync(freshRoot, { recursive: true, force: true })

  // 上一段把 DSH_HOME 指到了临时目录（已删），这里切回来给后面的用例用。
  process.env.DSH_HOME = root

  // ---------- 5.1 只注册一段（0.9.0 去掉了 core.md） ----------
  //
  // 曾经有过一个可选的 `enhance:mode-core`（order -900，排在官方人设之前）。
  // 它按预设作用域生效 = 所有走增强模式的对话共用同一段，做不到"只影响当前对话"，
  // 和预设那套 per-session 机制互相打架，所以整段删掉。这条用例锁住"不许回来"。
  const onlyTail = makeCtx()
  apply(onlyTail.ctx, {})

  check('系统提示里只有末尾一段，没有第二段', () => {
    is(onlyTail.sections.length, 1)
    is(onlyTail.sections[0].name, 'enhance:mode-prompt')
  })

  check('末尾段之后的最后一个位置没有被别人占用', () => {
    const orders = onlyTail.sections.map((section) => section.order)
    is(Math.max(...orders), 10300)
  })

  // ---------- 6. cordis 4 的服务守卫（0.2.0 线上事故回归） ----------
  // 真实 cordis 给 ctx 套了 Proxy：**没写进 inject 的服务，属性访问会直接抛**
  // `cannot get property "x" without inject`。这一抛会让整行激活失败，
  // 宿主随即把整个预设判为 broken 并从模式下拉里藏起来（界面上没有任何报错）。
  // 所以这里用一个"陌生属性一律抛"的代理，确认 apply() 全程只用 ctx.get()。
  const strict = makeStrictCtx()
  let threw = null
  try {
    apply(strict.ctx, {})
  } catch (error) {
    threw = error
  }

  check('apply() 不因未 inject 的服务而抛错（cordis 守卫）', () => {
    if (threw !== null) throw new Error(`apply 抛了：${threw?.message ?? threw}`)
    is(strict.sections.length, 1)
  })

  check('入口在服务缺席时降级为静默，不影响提示词段', () => {
    const text = strict.sections.find((section) => section.name === 'enhance:mode-prompt').text({ agent: { session: 's-guard' } })
    ok(typeof text === 'string' && text.length > 0, '提示词段仍应产出文本')
  })

  check('工具真的注册上了，且 schema 是宿主接受的那种', () => {
    is(strict.tools.length, 1)
    const tool = strict.tools[0]
    is(tool.name, 'enhance_preset')
    is(tool.parameters.type, 'object')
    is(tool.parameters.required.join(','), 'action')
    ok(!('required' in tool.parameters.properties.action), '参数字段里不该有 required')
    is(tool.output.schema.required.join(','), 'ok')
    ok(!('required' in tool.output.schema.properties.ok), '输出属性里不该有 required（宿主 assertSupportedJsonSchema 会抛）')
  })

  check('斜杠命令真的注册上了，名字符合宿主正则', () => {
    is(strict.commands.length, 1)
    const command = strict.commands[0]
    is(command.name, 'enhance')
    ok(/^[a-z][a-z0-9_-]*$/.test(command.name), '命令名不符合宿主命名规则')
    is(typeof command.handler, 'function')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)