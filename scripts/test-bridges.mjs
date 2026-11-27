/**
 * 桥接与脚本自检：
 *   - 工具定义（enhance_preset）的形状与执行
 *   - 命令派发（dispatch）与命令注册（registerCommand）
 *   - 模式行生成脚本的纯函数（extract / strip / build / replace）
 *
 * 跑法：node scripts/test-bridges.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPresetActions } from '../lib/actions.mjs'
import { COMMAND_NAME, dispatch, parseInput, registerCommand, runCommand } from '../lib/command.mjs'
import { TOOL_NAME, createTitleRenamer, createToolDefinition, sessionIdFromExec, summarize } from '../lib/tool.mjs'
import {
  buildRows, extractStandardPlugins, replaceRegion, stripOwnRow,
} from './sync-presets.mjs'

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

async function checkAsync(name, body) {
  try {
    await body()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}

function is(actual, expected, what = '') {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}：期望 ${right}，实际 ${left}`)
}

function ok(value, what = '') {
  if (!value) throw new Error(`${what}：期望为真`)
}

const root = mkdtempSync(join(tmpdir(), 'enhance-bridges-'))
const paths = {
  presetDir: join(root, 'presets'),
  defaultFile: join(root, 'mode-prompt.md'),
  sessionsFile: join(root, 'sessions.json'),
}

try {
  mkdirSync(paths.presetDir, { recursive: true })
  writeFileSync(paths.defaultFile, '默认那段话。\n', 'utf8')
  writeFileSync(join(paths.presetDir, '01-严格同事.md'), '---\ntitle: 严格同事\ndescription: 结论先行\n---\n先给结论。\n', 'utf8')
  writeFileSync(join(paths.presetDir, '02-只给结论.md'), '第一行只给结论。\n', 'utf8')

  // ---------- 工具 ----------
  const tool = createToolDefinition(paths)

  // 这两条断言守的是 0.2.0 的线上故障：宿主 `tools.register()` 第一件事就是
  // `assertSupportedJsonSchema(output.schema)`，属性里写 `required: true` 会抛
  // `JsonSchemaError`，注册作废 → 模型那边根本没有这个工具。
  check('工具形状：参数/输出都是合法 JSON Schema（required 是顶层数组）', () => {
    is(tool.name, TOOL_NAME)
    is(tool.parameters.type, 'object')
    is(tool.parameters.required, ['action'])
    is(tool.parameters.properties.action.enum, ['list', 'current', 'use', 'create', 'update', 'rename'])
    ok(!('required' in tool.parameters.properties.action), '参数字段里不该有 required')
    ok(!('required' in tool.parameters.properties.id), '参数字段里不该有 required')
    is(tool.output.schema.type, 'object')
    is(tool.output.schema.required, ['ok'])
    ok(!('required' in tool.output.schema.properties.ok), '输出属性里不该有 required（宿主会抛 JsonSchemaError）')
    ok(!('required' in tool.output.schema.properties.code), '输出属性里不该有 required')
    is(typeof tool.output.render, 'function')
    ok(tool.description.includes('预设'), '描述应说明用途')
  })

  await checkAsync('工具 list：返回两套与当前状态', async () => {
    const result = await tool.execute({ action: 'list' }, {})
    is(result.ok, true)
    is(result.total, 2)
    is(result.current, null)
  })

  await checkAsync('工具 use：按 exec.agent.session 记录', async () => {
    const result = await tool.execute({ action: 'use', id: '01-严格同事.md' }, { agent: { session: 'sess-tool' } })
    is(result.ok, true)
    const current = await tool.execute({ action: 'current' }, { agent: { session: { id: 'sess-tool' } } })
    is(current.current, '01-严格同事.md')
  })

  await checkAsync('工具：未知 action → bad-action', async () => {
    const result = await tool.execute({ action: 'nope' }, {})
    is(result.ok, false)
    is(result.code, 'bad-action')
  })

  await checkAsync('工具 rename：没注入改名能力 → unavailable（不抛）', async () => {
    const result = await tool.execute({ action: 'rename' }, { agent: { session: { id: 's' } } })
    is(result.ok, false)
    is(result.code, 'unavailable')
  })

  check('createTitleRenamer：给标题加上「增强模式 · 」前缀，且不重复加', () => {
    const renamed = []
    const snapshots = { title: '写个脚本' }
    const ctx = {
      get: name => (name === 'sessionTitle'
        ? {
            get: () => ({ title: snapshots.title }),
            rename: (_session, next) => {
              renamed.push(next)
              snapshots.title = next
              return { title: next }
            },
          }
        : undefined),
    }
    const renamer = createTitleRenamer(ctx)
    const first = renamer({ agent: { session: { id: 's1' } } })
    is(first.ok, true)
    is(renamed[0], '增强模式 · 写个脚本')
    const second = renamer({ agent: { session: { id: 's1' } } })
    is(second.ok, true)
    is(renamed.length, 1, '已经带前缀就不该再改一次')
  })

  check('createTitleRenamer：宿主没有 sessionTitle → unavailable', () => {
    const result = createTitleRenamer({ get: () => undefined })({ agent: { session: { id: 's' } } })
    is(result.ok, false)
    is(result.code, 'unavailable')
  })

  check('sessionIdFromExec 兼容两种形态', () => {
    is(sessionIdFromExec({ agent: { session: 'a' } }), 'a')
    is(sessionIdFromExec({ agent: { session: { id: 'b' } } }), 'b')
    is(sessionIdFromExec({}), null)
  })

  check('summarize：列表、失败、单条三种输出都可读', () => {
    const listText = summarize({ ok: true, total: 1, current: '01-严格同事.md', items: [{ id: '01-严格同事.md', name: '01-严格同事', chars: 4, inUse: 1, description: '结论先行' }] })
    ok(listText.includes('共 1 套'), '应含总数')
    ok(listText.includes('1 个对话在用'), '应含占用数')
    const failText = summarize({ ok: false, code: 'conflict', message: '被别人改过' })
    ok(failText.includes('conflict') && failText.includes('被别人改过'), '失败应带原因码与说明')
    is(summarize({ ok: true, id: '03-x.md' }), '已处理：03-x.md')
  })

  // ---------- 命令 ----------
  const actions = createPresetActions(paths)

  check('dispatch：覆盖全部 action', () => {
    is(dispatch(actions, { action: 'list' }).ok, true, 'list')
    is(dispatch(actions, { action: 'status', sessionId: 'sess-cmd' }).active, false, 'status.active')
    is(dispatch(actions, { action: 'read', id: '01-严格同事.md' }).preset.name, '01-严格同事', 'read.name')
    is(dispatch(actions, { action: 'use', sessionId: 'sess-cmd', id: '02-只给结论.md' }).ok, true, 'use')
    is(dispatch(actions, { action: 'current', sessionId: 'sess-cmd' }).current, '02-只给结论.md', 'current')
    const created = dispatch(actions, { action: 'create', name: '新套', body: '正文' })
    is(created.ok, true, `create（code=${created.code} message=${created.message}）`)
    is(created.id, '新套.md', 'create 用名字当文件名')
    is(dispatch(actions, { action: 'remove', id: '01-严格同事.md' }).ok, true, 'remove')
    is(dispatch(actions, { action: 'bogus' }).code, 'bad-action', 'bogus')
  })

  // 宿主 `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`：名字里不能有斜杠/大写，
  // 旧的 `enhance-mode/preset` 会被判非法，register 直接抛。
  check('命令名符合宿主正则（字母开头、无斜杠）', () => {
    ok(/^[a-z][a-z0-9_-]*$/.test(COMMAND_NAME), `命令名 ${COMMAND_NAME} 不符合宿主命名规则`)
  })

  check('parseInput：空 / list / use / reset / read / 裸预设名', () => {
    is(parseInput('', 's1'), { action: 'status', sessionId: 's1' })
    is(parseInput('   ', 's1'), { action: 'status', sessionId: 's1' })
    is(parseInput(' list', 's1'), { action: 'list', sessionId: 's1' })
    is(parseInput(' use 02-只给结论.md', 's1'), { action: 'use', sessionId: 's1', id: '02-只给结论.md' })
    is(parseInput(' reset', 's1'), { action: 'reset', sessionId: 's1' })
    is(parseInput(' read 02-只给结论.md', null), { action: 'read', id: '02-只给结论.md' })
    is(parseInput(' 02-只给结论.md', 's1'), { action: 'use', sessionId: 's1', id: '02-只给结论.md' })
  })

  check('runCommand：结果转成 { kind, text }', () => {
    const listed = runCommand(actions, { rawInput: ' list', agent: { session: 'sess-run' } })
    is(listed.kind, 'success')
    ok(listed.text.includes('共 2 套'), '应带总数')
    const used = runCommand(actions, { rawInput: ' use 02-只给结论.md', agent: { session: 'sess-run' } })
    is(used.kind, 'success')
    const bad = runCommand(actions, { rawInput: ' use 不存在.md', agent: { session: 'sess-run' } })
    is(bad.kind, 'error')
    ok(bad.text.includes('not-found'), '失败应带原因码')
  })

  check('registerCommand：按宿主真实形状注册 {name, description, handler}', () => {
    const registered = []
    const ctx = {
      get: name => (name === 'commands' ? { register: definition => { registered.push(definition); return () => {} } } : undefined),
    }
    const dispose = registerCommand(ctx, { dir: root })
    is(typeof dispose, 'function')
    is(registered[0].name, COMMAND_NAME)
    is(typeof registered[0].description, 'string')
    is(typeof registered[0].handler, 'function')
    const result = registered[0].handler({ rawInput: ' list', agent: { session: 'sess-reg' } })
    is(result.kind, 'success')
  })

  check('registerCommand：没有 commands 服务 → null（不抛错）', () => {
    is(registerCommand({}, { dir: root }), null)
    is(registerCommand({ get: () => undefined }, { dir: root }), null)
  })

  check('registerCommand：register 抛错也不冒泡', () => {
    const ctx = { get: () => ({ register: () => { throw new Error('宿主拒绝') } }) }
    is(registerCommand(ctx, { dir: root }), null)
  })

  // ---------- 生成模式行 ----------
  const patchSample = [
    'presets:',
    '  - insert:',
    '      - id: preset-enhance',
    "        name: '@deepseek-ai/dsh-agent-preset'",
    '        config:',
    '          id: enhance',
    '          plugins:',
    "            - id: persona",
    "              name: '@deepseek-ai/dsh-persona'",
    "            - id: tool-fs",
    "              name: '@deepseek-ai/dsh-tool-fs'",
    '            - id: enhance-mode-prompt',
    "              name: '@slz233/dsh-enhance-mode/prompt/index.js'",
    '# >>> enhance-presets:auto（由 scripts/sync-presets.mjs 生成，勿手改）',
    '# <<< enhance-presets:auto',
  ].join('\n')

  check('extractStandardPlugins：抽出 plugins 块', () => {
    const standard = extractStandardPlugins(patchSample)
    ok(standard.block.length >= 4, '应包含插件行')
    is(standard.itemIndent, 6)
    is(standard.pluginsIndent, 10)
  })

  check('stripOwnRow：只去掉自己那一行', () => {
    const standard = extractStandardPlugins(patchSample)
    const kept = stripOwnRow(standard.block)
    ok(!kept.some(line => line.includes('enhance-mode-prompt')), '不应保留自己的行')
    ok(kept.some(line => line.includes('dsh-tool-fs')), '应保留官方插件')
  })

  check('buildRows：每套生成一个模式行并带上 preset 配置', () => {
    const standard = extractStandardPlugins(patchSample)
    const rows = buildRows(
      [{ id: '01-严格同事.md', title: '严格同事' }, { id: '02-只给结论.md', title: '只给结论' }],
      {
        itemIndent: standard.itemIndent,
        pluginsIndent: standard.pluginsIndent,
        block: stripOwnRow(standard.block),
      },
    )
    ok(rows.includes('- id: preset-enhance-'), '应有模式行 id')
    ok(rows.includes("preset: '01-严格同事.md'"), '应指向第一套')
    ok(rows.includes("preset: '02-只给结论.md'"), '应指向第二套')
    is((rows.match(/order:/g) ?? []).length, 2, '两行各一个 order')
    ok(!rows.includes('preset-enhance-prompt'), '不应把增强模式本身再复制一遍')
  })

  check('replaceRegion：只替换标记之间', () => {
    const replaced = replaceRegion(patchSample, 'NEW')
    ok(replaced.includes('NEW'), '应写入新内容')
    ok(replaced.includes('preset-enhance'), '标记之外应保留')
    ok(replaced.includes('<<<'), '结束标记应保留')
    ok(replaced.includes('>>>'), '开始标记应保留')
  })

  check('replaceRegion：缺标记 → 抛错', () => {
    let threw = false
    try {
      replaceRegion('no markers here', 'X')
    } catch {
      threw = true
    }
    ok(threw, '应当抛错而不是猜位置')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)