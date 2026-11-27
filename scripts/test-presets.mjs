/**
 * 离线自检：预设解析、会话记录、文件存取、排序表、改名识别。不依赖 DSH，不联网，不动真目录。
 * 跑法：node scripts/test-presets.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareIds, makePresetId, normalizePresetName, presetIdFromName, presetIdProblem, presetNameProblem, presetPath,
} from '../lib/paths.mjs'
import {
  DESCRIPTION_MAX, IGNORE_REASON, clampDescription, descriptionFromBody, fingerprint, listPresetDir, listPresets,
  nameFromId, parsePreset, readDefaultBody, readPreset, resolveEnhanceText, resolvePresetId, splitFrontMatter,
} from '../lib/presets.mjs'
import {
  countUsage, dropPresetFromSessions, emptyState, getChoice, pushRecent, readState, remapSessions, setChoice,
  writeState,
} from '../lib/sessions.mjs'
import {
  ERROR_CODE, SEEDED_MARKER, SEED_PRESETS, createPreset, readPresetFile, removePreset, savePreset, savePresetAs,
  seedDefaultPresets, serializePreset,
} from '../lib/store.mjs'
import {
  dropFromIndex, moveToPosition, rankOf, readIndex, sortByOrder, writeIndex,
} from '../lib/order.mjs'
import { applyRename, indexAfterRebind, planRebind, reconcilePresets, sameIndex } from '../lib/rebind.mjs'

let passed = 0
let failed = 0

/** @param {string} name @param {() => void} body */
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

/** @param {unknown} actual @param {unknown} expected @param {string} [what] */
function is(actual, expected, what = '') {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}：期望 ${right}，实际 ${left}`)
}

function ok(value, what = '') {
  if (!value) throw new Error(`${what}：期望为真`)
}

function throwsWith(fn, code, what = '') {
  try {
    fn()
  } catch (error) {
    if (code !== undefined && error?.code !== code) {
      throw new Error(`${what}：期望错误码 ${code}，实际 ${error?.code}（${error?.message}）`)
    }
    return
  }
  throw new Error(`${what}：期望抛错但没有`)
}

const root = mkdtempSync(join(tmpdir(), 'enhance-test-'))
const presetDir = join(root, 'presets')
const sessionsFile = join(root, 'sessions.json')
const orderFile = join(root, 'presets-order.json')
const defaultFile = join(root, 'mode-prompt.md')

try {
  // ---------- 1. 标识与名字 ----------
  check('合法文件名通过', () => {
    is(presetIdProblem('01-严格同事.md'), null)
    is(presetIdProblem('严格同事.md'), null)
  })

  check('非法文件名逐条拒绝', () => {
    for (const bad of ['..', '../x.md', 'C:\\x.md', '/etc/x.md', 'a/b.md', 'a\\b.md', '_trash/x.md', '_x.md', '.hidden.md', 'x.txt', '', ' x.md']) {
      ok(presetIdProblem(bad) !== null, `应拒绝「${bad}」`)
    }
  })

  check('预设路径不会越界', () => {
    const file = presetPath(presetDir, '02-只给结论.md')
    ok(file.startsWith(presetDir), '路径应在预设目录内')
    throwsWith(() => presetPath(presetDir, '../evil.md'), undefined, '越界路径')
  })

  check('名字 → 文件名：不剥前缀，只补 .md', () => {
    is(nameFromId('01-喵.md'), '01-喵')
    is(nameFromId('喵.md'), '喵')
    is(nameFromId('2024 计划.md'), '2024 计划')
    is(presetIdFromName('喵'), '喵.md')
    is(presetIdFromName('喵.md'), '喵.md', '重复的 .md 不该叠两层')
  })

  check('新文件名：重名加 -2，不再自动编号', () => {
    is(makePresetId(presetDir, '只给结论', []), '只给结论.md')
    is(makePresetId(presetDir, '只给结论', ['只给结论.md']), '只给结论-2.md')
    is(makePresetId(presetDir, '只给结论', ['只给结论.md', '只给结论-2.md']), '只给结论-3.md')
    is(makePresetId(presetDir, 'A', ['a.md']), 'A-2.md', '大小写不同也算重名（Windows）')
  })

  check('名字里的非法字符会被清掉（自动命名路径）', () => {
    is(normalizePresetName('a/b:c'), 'abc')
    is(normalizePresetName('   '), '未命名预设')
    is(normalizePresetName('笔记.md'), '笔记')
  })

  check('名字校验：能直接当文件名才通过', () => {
    is(presetNameProblem('大小姐'), null)
    is(presetNameProblem('2024 计划'), null)
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'CON', 'nul', '_hidden', '.dot', 'trail.']) {
      ok(presetNameProblem(bad) !== null, `应拒绝名字「${bad}」`)
    }
  })

  check('文件名按数字大小排（-2 排在 -10 前面）', () => {
    is(compareIds('未命名预设-2.md', '未命名预设-10.md') < 0, true)
    is(compareIds('未命名预设-10.md', '未命名预设-2.md') > 0, true)
    is(compareIds('喵.md', '喵.md'), 0)
  })

  // ---------- 2. 解析 ----------
  check('front matter 解析', () => {
    const raw = '---\ndescription: 第一行给结论\n---\n正文第一行\n\n正文第二段\n'
    const { meta, body, hasFrontMatter } = splitFrontMatter(raw)
    ok(hasFrontMatter, '应识别 front matter')
    is(meta.description, '第一行给结论')
    is(body, '正文第一行\n\n正文第二段\n')
  })

  check('没有 front matter 时整份都是正文', () => {
    const raw = '就直接写正文\n第二行\n'
    const { meta, body, hasFrontMatter } = splitFrontMatter(raw)
    ok(!hasFrontMatter)
    is(meta, {})
    is(body, raw)
  })

  check('正文里的 --- 不会被当成结尾', () => {
    const raw = '---\ndescription: X\n---\n第一段\n\n---\n\n第二段\n'
    const { body } = splitFrontMatter(raw)
    ok(body.includes('---'), '正文里的 --- 应保留')
    ok(body.includes('第二段'), '结尾后的内容应保留')
  })

  check('parsePreset：名字只来自文件名，title 字段被彻底忽略', () => {
    const preset = parsePreset('---\ntitle: 严格同事\ndescription: 结论先行\n---\n先给结论。\n\n\n', '01-严格同事.md')
    is(preset.name, '01-严格同事', 'title 不该覆盖文件名')
    is(preset.description, '结论先行')
    is(preset.body, '先给结论。\n')
    is(preset.empty, false)
    ok(preset.chars > 0, '字数应大于 0')
  })

  check('parsePreset：没有描述时取首段 40 字', () => {
    const preset = parsePreset('第一行只给结论；空一行；再展开理由。\n\n第二段\n', '只给结论.md')
    is(preset.description, '第一行只给结论；空一行；再展开理由。')
    is(preset.name, '只给结论')
  })

  check('parsePreset：空文件标 empty', () => {
    const preset = parsePreset('', '空的那套.md')
    is(preset.empty, true)
    is(preset.name, '空的那套')
  })

  check('正文自己以 --- 开头时，不会被当成 front matter 吃掉', () => {
    const raw = '---\n这是正文第一行，不是 key: value\n---\n后面还有正文\n'
    const { hasFrontMatter, body } = splitFrontMatter(raw)
    is(hasFrontMatter, false, '这一块不像 front matter')
    is(body, raw, '整份都该进正文，一个字都不吞')
  })

  check('描述显示上限：超长截断加省略号，文件里的原文不动', () => {
    const long = '一'.repeat(DESCRIPTION_MAX + 20)
    is(Array.from(clampDescription(long)).length, DESCRIPTION_MAX + 1, '= 上限 + 省略号')
    ok(clampDescription(long).endsWith('…'), '应加省略号')
    is(clampDescription('短'), '短')
    const preset = parsePreset(`---\ndescription: ${long}\n---\n正文\n`, '长描述.md')
    is(preset.description, long, 'description 保留原文（编辑时用）')
    is(preset.descriptionShort, clampDescription(long), 'descriptionShort 给界面用')
  })

  check('描述自动截断 40 字', () => {
    is(descriptionFromBody('短描述。\n\n第二段'), '短描述。')
    const long = `${'一'.repeat(50)}`
    ok(descriptionFromBody(long).endsWith('…'), '超长应带省略号')
    ok(Array.from(descriptionFromBody(long)).length <= 41, '截断后不超过 41 字符')
  })

  // ---------- 3. 目录列举 ----------
  mkdirSync(presetDir, { recursive: true })
  mkdirSync(join(presetDir, '_trash'), { recursive: true })
  writeFileSync(join(presetDir, '01-严格同事.md'), '---\ntitle: 严格同事\ndescription: 结论先行\n---\n先给结论。\n', 'utf8')
  writeFileSync(join(presetDir, '02-只给结论.md'), '第一行只给结论；空一行；再展开理由。\n', 'utf8')
  writeFileSync(join(presetDir, 'notes.txt'), '不该出现在列表里\n', 'utf8')
  writeFileSync(join(presetDir, '_旧版.md'), '以下划线开头，视为隐藏\n', 'utf8')
  writeFileSync(join(presetDir, '.seeded'), '2026-01-01\n', 'utf8')
  writeFileSync(join(presetDir, '.123.456.tmp'), '临时文件\n', 'utf8')
  // 不设大小上限：再大也照收（用户自己决定往里放什么）
  writeFileSync(join(presetDir, '很大但合法.md'), 'x'.repeat(400 * 1024), 'utf8')
  writeFileSync(join(presetDir, '_trash', '旧预设.md'), '已删除\n', 'utf8')

  check('列表只收合法 .md（跳过 _trash、.seeded、.tmp）', () => {
    const items = listPresets(presetDir)
    is(items.map(item => item.id), ['01-严格同事.md', '02-只给结论.md', '很大但合法.md'])
  })

  check('列表项带名字、描述、指纹', () => {
    const items = listPresets(presetDir)
    is(items[0].name, '01-严格同事')
    is(items[1].name, '02-只给结论')
    ok(items[1].description.startsWith('第一行只给结论'), '描述取首段')
    is(items[0].descriptionShort, '结论先行', '列表还带一份给界面用的截断描述')
    ok(/^[0-9a-f]{64}$/.test(items[0].sha), '应带 sha256 指纹')
  })

  check('被忽略的文件带原因回报（txt / _开头）', () => {
    const { ignored } = listPresetDir(presetDir)
    const reasons = Object.fromEntries(ignored.map(entry => [entry.name, entry.reason]))
    is(reasons['notes.txt'], IGNORE_REASON.notMarkdown)
    is(reasons['_旧版.md'], IGNORE_REASON.hidden)
    ok(!Object.keys(reasons).includes('.seeded'), '插件标记不该出现在回报里')
    ok(!Object.keys(reasons).includes('.123.456.tmp'), '临时文件不该出现在回报里')
  })

  check('大文件照样能读（不设上限，只有 README 里的一句提醒）', () => {
    ok(readPreset(presetDir, '很大但合法.md') !== null, '应能读出来')
  })

  check('目录不存在时列表为空且不抛错', () => {
    is(listPresets(join(root, '不存在')), [])
  })

  // ---------- 4. 决定用哪段文本 ----------
  writeFileSync(defaultFile, '默认那段话。\n', 'utf8')

  check('选了预设 → 用预设正文 + 段尾标注', () => {
    const result = resolveEnhanceText({ presetDir, defaultFile, choice: '02-只给结论.md' })
    is(result.source, 'preset')
    ok(result.text.startsWith('第一行只给结论'), '正文应来自预设')
    ok(result.text.includes('（本次预设：02-只给结论）'), '标注用的是文件名')
    is(result.missing, false)
  })

  check('没选 → 用默认文件，且不加任何标注（与 0.1.0 一致）', () => {
    const result = resolveEnhanceText({ presetDir, defaultFile, choice: null })
    is(result.source, 'default')
    is(result.text, '默认那段话。\n')
    ok(!result.text.includes('本次预设'), '默认路径不应出现标注')
  })

  check('选中的预设被删/改名 → 沿用本会话上一次的文案', () => {
    const result = resolveEnhanceText({ presetDir, defaultFile, choice: '99-不存在.md', lastGood: '上一次的文案。' })
    is(result.source, 'fallback')
    is(result.text, '上一次的文案。')
    is(result.missing, true)
  })

  check('选中的预设没了、也没有历史 → 退回默认文件（仍标 missing）', () => {
    const result = resolveEnhanceText({ presetDir, defaultFile, choice: '99-不存在.md' })
    is(result.text, '默认那段话。\n')
    is(result.missing, true)
  })

  check('预设与默认都读不到 → 没有历史就返回空串', () => {
    const result = resolveEnhanceText({
      presetDir: join(root, '没有预设'),
      defaultFile: join(root, '没有默认.md'),
      choice: 'x.md',
    })
    is(result.text, '')
  })

  check('readDefaultBody 读不到返回 null', () => {
    is(readDefaultBody(join(root, '没有.md')), null)
  })

  // ---------- 5. 会话记录 ----------
  check('记录文件缺失/损坏 → 空记录', () => {
    is(readState(sessionsFile).sessions, {})
    writeFileSync(sessionsFile, '{ 坏掉的 json', 'utf8')
    is(readState(sessionsFile).sessions, {})
  })

  check('设置与读取会话选择', () => {
    let state = emptyState()
    state = setChoice(state, 'sess-a', '02-只给结论.md')
    state = setChoice(state, 'sess-b', '01-严格同事.md')
    is(getChoice(state, 'sess-a'), '02-只给结论.md')
    is(getChoice(state, 'sess-c'), null)
    is(countUsage(state, '02-只给结论.md'), 1, 'A 和 B 互不影响')
  })

  check('最近使用：去重并在队首、数量封顶', () => {
    let state = emptyState()
    state = pushRecent(state, 'a.md')
    state = pushRecent(state, 'b.md')
    state = pushRecent(state, 'a.md')
    is(state.recent, ['a.md', 'b.md'])
    for (let index = 0; index < 30; index += 1) state = pushRecent(state, `p${index}.md`)
    is(state.recent.length, 20)
    is(state.recent[0], 'p29.md')
  })

  check('删除预设后清理会话引用', () => {
    let state = emptyState()
    state = setChoice(state, 'sess-a', 'a.md')
    state = setChoice(state, 'sess-b', 'b.md')
    state = pushRecent(state, 'a.md')
    const result = dropPresetFromSessions(state, 'a.md')
    is(result.cleared, 1)
    is(getChoice(result.state, 'sess-a'), null)
    is(getChoice(result.state, 'sess-b'), 'b.md')
    is(result.state.recent, [])
  })

  check('改名搬家：会话选择与最近使用一起换到新名字', () => {
    let state = emptyState()
    state = setChoice(state, 'sess-a', '旧名.md')
    state = setChoice(state, 'sess-b', '别的.md')
    state = pushRecent(state, '旧名.md')
    const mapped = remapSessions(state, [{ from: '旧名.md', to: '新名.md' }])
    is(getChoice(mapped, 'sess-a'), '新名.md')
    is(getChoice(mapped, 'sess-b'), '别的.md')
    is(mapped.recent, ['新名.md'])
  })

  check('改名搬家：没有命中就返回同一个对象（省一次写盘）', () => {
    const state = setChoice(emptyState(), 'sess-a', '别的.md')
    ok(remapSessions(state, [{ from: '旧名.md', to: '新名.md' }]) === state, '应原样返回')
    ok(remapSessions(state, []) === state, '空映射应原样返回')
  })

  check('原子写：无残留临时文件，能读回', () => {
    const state = setChoice(emptyState(), 'sess-x', 'a.md')
    ok(writeState(sessionsFile, state), '写入应成功')
    is(getChoice(readState(sessionsFile), 'sess-x'), 'a.md')
    const leftovers = readdirSync(root).filter(name => name.startsWith('.sessions.') && name.endsWith('.tmp'))
    is(leftovers, [])
  })

  // ---------- 6. 排序表 ----------
  check('排序表 v2：orders + shas 一起读写', () => {
    const file = join(root, 'index.json')
    ok(writeIndex(file, { orders: { 'a.md': 0, 'b.md': 1 }, shas: { 'a.md': 'x', 'b.md': 'y' } }), '应写成功')
    const index = readIndex(file)
    is(index.version, 2)
    is(index.orders, { 'a.md': 0, 'b.md': 1 })
    is(index.shas, { 'a.md': 'x', 'b.md': 'y' })
  })

  check('排序表 v1 老文件照样读（shas 当空）', () => {
    const file = join(root, 'index-v1.json')
    writeFileSync(file, JSON.stringify({ orders: { 'a.md': 0 } }), 'utf8')
    const index = readIndex(file)
    is(index.orders, { 'a.md': 0 })
    is(index.shas, {})
  })

  check('排序表坏掉/不存在 → 空表，不抛错', () => {
    is(readIndex(join(root, '没有这个文件.json')).orders, {})
    writeFileSync(join(root, 'broken.json'), '{ 不是 json', 'utf8')
    is(readIndex(join(root, 'broken.json')).orders, {})
  })

  check('按内部排序排，没记录的排最后', () => {
    const items = [{ id: 'c.md' }, { id: 'b.md' }, { id: 'a.md' }]
    is(sortByOrder(items, { 'c.md': 0, 'a.md': 1 }).map(item => item.id), ['c.md', 'a.md', 'b.md'])
  })

  check('挪位与折成序号', () => {
    is(moveToPosition(['a', 'b', 'c'], 'c', 1), ['c', 'a', 'b'])
    is(moveToPosition(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a'], '越界夹到末尾')
    is(moveToPosition(['a', 'b', 'c'], 'a', 0), ['a', 'b', 'c'], '越界夹到开头')
    is(rankOf(['a', 'b', 'c']), { a: 0, b: 1, c: 2 })
  })

  check('删除记录：orders 与 shas 一起清', () => {
    const next = dropFromIndex({ orders: { 'a.md': 0 }, shas: { 'a.md': 'x' } }, 'a.md')
    is(next.orders, {})
    is(next.shas, {})
  })

  // ---------- 7. 改名识别 ----------
  check('指纹唯一命中 → 认成同一个文件', () => {
    const plan = planRebind(
      { orders: { '旧.md': 0 }, shas: { '旧.md': 'sha-1' } },
      [{ id: '新.md', sha: 'sha-1' }],
    )
    is(plan.pairs, [{ from: '旧.md', to: '新.md' }])
    is(plan.gone, [])
    is(plan.fresh, [])
  })

  check('内容不同 → 不认（当新预设）', () => {
    const plan = planRebind(
      { orders: { '旧.md': 0 }, shas: { '旧.md': 'sha-1' } },
      [{ id: '新.md', sha: 'sha-2' }],
    )
    is(plan.pairs, [])
    is(plan.gone, ['旧.md'])
    is(plan.fresh, ['新.md'])
  })

  check('两边都有多份同内容 → 不猜', () => {
    const plan = planRebind(
      { orders: {}, shas: { '旧1.md': 'sha-1', '旧2.md': 'sha-1' } },
      [{ id: '新1.md', sha: 'sha-1' }, { id: '新2.md', sha: 'sha-1' }],
    )
    is(plan.pairs, [], '一样的内容有多份，不能张冠李戴')
  })

  check('对账后：排序跟着搬家、孤儿记录清掉、指纹刷新', () => {
    const next = indexAfterRebind(
      { orders: { '旧.md': 0, '别的.md': 1, '删掉的.md': 2 }, shas: { '旧.md': 'sha-1', '删掉的.md': 'sha-x' } },
      [{ id: '别的.md', sha: 'b' }, { id: '新.md', sha: 'sha-1' }],
      [{ from: '旧.md', to: '新.md' }],
    )
    is(next.orders, { '新.md': 0, '别的.md': 1 })
    is(next.shas, { '别的.md': 'b', '新.md': 'sha-1' })
  })

  check('sameIndex 能判断"需不需要写盘"', () => {
    const one = { orders: { 'a.md': 0 }, shas: { 'a.md': 'x' } }
    ok(sameIndex(one, { orders: { 'a.md': 0 }, shas: { 'a.md': 'x' } }))
    ok(!sameIndex(one, { orders: { 'a.md': 1 }, shas: { 'a.md': 'x' } }))
  })

  check('对账：改名后会话选择跟着搬，第二次不再写盘', () => {
    const dir = join(root, 'rebind', 'presets')
    const index = join(root, 'rebind', 'order.json')
    const sessions = join(root, 'rebind', 'sessions.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '旧.md'), '同一段正文。\n', 'utf8')
    writeFileSync(index, JSON.stringify({ version: 2, orders: { '旧.md': 0 }, shas: { '旧.md': fingerprint('同一段正文。\n') } }), 'utf8')
    writeFileSync(sessions, JSON.stringify({ version: 1, sessions: { s1: '旧.md' }, recent: ['旧.md'] }), 'utf8')

    // 用户在资源管理器里改名
    renameFile(join(dir, '旧.md'), join(dir, '新.md'))
    writeFileSync(index, JSON.stringify({ version: 2, orders: { '旧.md': 0 }, shas: { '旧.md': fingerprint('同一段正文。\n') } }), 'utf8')

    const first = reconcilePresets({ presetDir: dir, indexFile: index, sessionsFile: sessions })
    is(first.pairs, [{ from: '旧.md', to: '新.md' }])
    is(readIndex(index).orders, { '新.md': 0 })
    is(getChoice(readState(sessions), 's1'), '新.md')

    const second = reconcilePresets({ presetDir: dir, indexFile: index, sessionsFile: sessions })
    is(second.changed, false, '第二次不该再改什么')
  })

  check('我们自己改名：applyRename 当场搬走排序与会话', () => {
    const dir = join(root, 'rename', 'presets')
    const index = join(root, 'rename', 'order.json')
    const sessions = join(root, 'rename', 'sessions.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '旧.md'), '正文\n', 'utf8')
    writeFileSync(index, JSON.stringify({ version: 2, orders: { '旧.md': 0, '别的.md': 1 }, shas: { '旧.md': 'h' } }), 'utf8')
    writeFileSync(sessions, JSON.stringify({ version: 1, sessions: { s1: '旧.md' }, recent: ['旧.md'] }), 'utf8')

    applyRename({ indexFile: index, sessionsFile: sessions, from: '旧.md', to: '新.md' })
    is(readIndex(index).orders, { '新.md': 0, '别的.md': 1 })
    is(readIndex(index).shas, {}, '指纹留给下一次对账刷新')
    is(getChoice(readState(sessions), 's1'), '新.md')
  })

  // ---------- 8. 文件存取 ----------
  check('序列化：只有 description，不写 title', () => {
    const text = serializePreset({ description: '一句话', body: '正文\n' })
    is(text, '---\ndescription: 一句话\n---\n正文\n')
    ok(!text.includes('title:'), '不该再写 title')
  })

  check('序列化：没描述就是纯正文', () => {
    is(serializePreset({ body: '只有正文\n' }), '只有正文\n')
    is(serializePreset({}), '')
  })

  check('新建预设：名字即文件名，落盘', () => {
    const created = createPreset(presetDir, { name: '新的一套', description: '测试', body: '正文内容\n' })
    is(created.id, '新的一套.md')
    is(created.name, '新的一套')
    const read = readPresetFile(presetDir, created.id)
    is(read.name, '新的一套')
    is(read.description, '测试')
  })

  check('新建重名 → duplicate', () => {
    throwsWith(
      () => createPreset(presetDir, { id: '01-严格同事.md', description: 'x', body: 'y' }),
      ERROR_CODE.duplicate,
      '重复标识',
    )
  })

  check('新建非法名字 → invalid-name', () => {
    throwsWith(() => createPreset(presetDir, { name: 'a/b' }), ERROR_CODE.invalidName, '斜杠')
  })

  check('保存：mtime 过期 → conflict', () => {
    const current = readPresetFile(presetDir, '01-严格同事.md')
    throwsWith(
      () => savePreset(presetDir, { id: '01-严格同事.md', body: '改过', expectedMtimeMs: current.mtimeMs - 5000 }),
      ERROR_CODE.conflict,
      '外部改动',
    )
  })

  check('保存：mtime 一致 → 写入成功', () => {
    const current = readPresetFile(presetDir, '01-严格同事.md')
    const saved = savePreset(presetDir, {
      id: '01-严格同事.md',
      description: current.description,
      body: '换了个正文。\n',
      expectedMtimeMs: current.mtimeMs,
    })
    is(saved.id, '01-严格同事.md')
    is(saved.renamedFrom, null)
    is(readPresetFile(presetDir, '01-严格同事.md').body, '换了个正文。\n')
  })

  check('保存：带新名字 = 真的重命名文件', () => {
    const current = readPresetFile(presetDir, '01-严格同事.md')
    const saved = savePreset(presetDir, {
      id: '01-严格同事.md',
      name: '严格同事',
      body: '改完还叫这个。\n',
      expectedMtimeMs: current.mtimeMs,
    })
    is(saved.id, '严格同事.md')
    is(saved.renamedFrom, '01-严格同事.md')
    ok(existsSync(join(presetDir, '严格同事.md')), '新文件应在')
    ok(!existsSync(join(presetDir, '01-严格同事.md')), '旧文件应没了')
    is(readPresetFile(presetDir, '严格同事.md').name, '严格同事')
  })

  check('保存：改名撞上已有名字 → duplicate，且原文件不动', () => {
    throwsWith(
      () => savePreset(presetDir, { id: '02-只给结论.md', name: '严格同事' }),
      ERROR_CODE.duplicate,
      '改名撞名',
    )
    ok(existsSync(join(presetDir, '02-只给结论.md')), '原文件应还在')
  })

  check('保存：改名成非法名字 → invalid-name，且原文件不动', () => {
    throwsWith(() => savePreset(presetDir, { id: '02-只给结论.md', name: 'a/b' }), ERROR_CODE.invalidName, '斜杠')
    ok(existsSync(join(presetDir, '02-只给结论.md')), '原文件应还在')
  })

  check('另存为：内容复制，原文件不动', () => {
    const copy = savePresetAs(presetDir, { id: '02-只给结论.md', name: '只给结论 副本' })
    is(copy.id, '只给结论 副本.md')
    is(readPresetFile(presetDir, copy.id).body, readPresetFile(presetDir, '02-只给结论.md').body)
    ok(readPresetFile(presetDir, '02-只给结论.md') !== null, '原文件仍在')
  })

  check('软删除：移到 _trash 且不再出现在列表', () => {
    const removed = removePreset(presetDir, '02-只给结论.md')
    ok(removed.movedTo.endsWith('.md'), '应返回新文件名')
    ok(statSync(join(presetDir, '_trash', removed.movedTo)).isFile(), '_trash 里应有文件')
    ok(!listPresets(presetDir).some(item => item.id === '02-只给结论.md'), '列表里不应再有')
  })

  check('删除不存在的预设 → not-found', () => {
    throwsWith(() => removePreset(presetDir, '88-不存在.md'), ERROR_CODE.notFound, '删除不存在')
  })

  check('非法标识 → invalid-id（不碰磁盘）', () => {
    throwsWith(() => readPresetFile(presetDir, '../evil.md'), ERROR_CODE.invalidId, '穿越读')
    throwsWith(() => readPresetFile(presetDir, '_trash/旧预设.md'), ERROR_CODE.invalidId, '读 _trash')
  })

  check('保存后正文字节不丢（中文/换行）', () => {
    const body = '第一行\n\n第二行 带空格  \n第三行'
    const created = createPreset(presetDir, { name: '字节测试', body })
    const raw = readFileSync(join(presetDir, created.id), 'utf8')
    ok(raw.includes('第一行'), '应保留中文')
    ok(readPresetFile(presetDir, created.id).body.includes('第三行'), '应保留末行')
  })

  // ---------- 9. 安装时种下示例预设 ----------
  check('空目录 → 种下三套示例预设（名字就是文件名）', () => {
    const fresh = join(root, 'seed-empty', 'presets')
    const written = seedDefaultPresets(fresh)
    is(written.length, SEED_PRESETS.length)
    const listed = listPresets(fresh)
    is(listed.length, SEED_PRESETS.length)
    ok(listed.some(item => item.name === '喵'), '应有「喵」')
    ok(listed.some(item => item.name === '老大'), '应有「老大」')
    ok(listed.some(item => item.name === '大小姐'), '应有「大小姐」')
    const body = readPresetFile(fresh, '大小姐.md').body
    ok(body.includes('desuwa~'), '大小姐那套正文应含罗马字 desuwa~')
    ok(!/[\u3040-\u30ff]/u.test(body), '三套示例正文都不该出现日文假名（用户看不懂）')
    ok(!readFileSync(join(fresh, '喵.md'), 'utf8').includes('title:'), '种子里不该再写 title')
  })

  check('目录里已有预设 → 一个都不种（不碰用户文件）', () => {
    const busy = join(root, 'seed-busy', 'presets')
    mkdirSync(busy, { recursive: true })
    writeFileSync(join(busy, '我自己的.md'), '---\ndescription: 我的\n---\n只改我自己的。\n', 'utf8')
    const written = seedDefaultPresets(busy)
    is(written.length, 0)
    is(readdirSync(busy).filter(name => name.endsWith('.md')).length, 1)
  })

  check('删光后再跑 → 不会长回来（.seeded 标记生效）', () => {
    const fresh = join(root, 'seed-deleted', 'presets')
    seedDefaultPresets(fresh)
    for (const item of listPresets(fresh)) removePreset(fresh, item.id)
    ok(listPresets(fresh).length === 0, '应先被清空')
    ok(existsSync(join(fresh, SEEDED_MARKER)), '应留下 .seeded 标记')
    is(seedDefaultPresets(fresh).length, 0)
    is(listPresets(fresh).length, 0)
  })

  check('有一套就完全不种（哪怕文件名正好和种子相同）', () => {
    const fresh = join(root, 'seed-partial', 'presets')
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(fresh, SEED_PRESETS[0].id), '我自己的版本。\n', 'utf8')
    const written = seedDefaultPresets(fresh)
    is(written.length, 0, '有一套就一套都不该种')
    is(readPresetFile(fresh, SEED_PRESETS[0].id).body, '我自己的版本。\n')
    is(readdirSync(fresh).filter(name => name.endsWith('.md')).length, 1)
  })

  // ---------- 10. 手打名字的模糊解析（斜杠命令用） ----------
  check('resolvePresetId：全名 / 省 .md / 名字都能命中', () => {
    const fresh = join(root, 'resolve', 'presets')
    seedDefaultPresets(fresh)
    is(resolvePresetId(fresh, '喵.md').id, '喵.md', '全名')
    is(resolvePresetId(fresh, '喵').id, '喵.md', '省掉 .md')
    is(resolvePresetId(fresh, '大小姐').id, '大小姐.md', '只写名字')
    is(resolvePresetId(fresh, '「老大」').id, '老大.md', '带中文引号')
  })

  check('resolvePresetId：歧义/不存在 → 不猜，给候选', () => {
    const fresh = join(root, 'resolve2', 'presets')
    seedDefaultPresets(fresh)
    const ambiguous = resolvePresetId(fresh, '')
    is(ambiguous.id, null, '空输入不该猜')
    is(ambiguous.candidates.length, 3)
    const missing = resolvePresetId(fresh, '不存在')
    is(missing.id, null)
    ok(missing.candidates.length === 3, '应把现有清单带出来')
  })
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结果
  }
}

/** 测试里用的"用户改名"：直接挪文件。 */
function renameFile(from, to) {
  rmSync(to, { force: true })
  writeFileSync(to, readFileSync(from))
  rmSync(from)
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
