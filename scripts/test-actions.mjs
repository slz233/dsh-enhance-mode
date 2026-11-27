/**
 * 动作层自检：界面按钮与助手工具共用的那批动作（list / current / use / create / update / saveAs / remove）。
 * 跑法：node scripts/test-actions.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPresetActions } from '../lib/actions.mjs'

const root = mkdtempSync(join(tmpdir(), 'enhance-actions-'))
const presetDir = join(root, 'presets')
const defaultFile = join(root, 'mode-prompt.md')
const sessionsFile = join(root, 'sessions.json')
const orderFile = join(root, 'presets-order.json')

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
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${what}：期望 ${right}，实际 ${left}`)
}

try {
  mkdirSync(presetDir, { recursive: true })
  writeFileSync(defaultFile, '默认那段话。\n', 'utf8')

  const actions = createPresetActions({ presetDir, defaultFile, sessionsFile, orderFile })

  check('空目录：list 返回空表且 current 为 null', () => {
    const result = actions.list({ sessionId: 's1' })
    ok(result.ok, '应成功')
    is(result.total, 0)
    is(result.current, null)
  })

  let createdId = ''
  check('create：落盘并出现在列表里（名字即文件名）', () => {
    const result = actions.create({ name: '严格同事', description: '结论先行', body: '先给结论。\n' })
    ok(result.ok, '应成功')
    createdId = result.id
    is(createdId, '严格同事.md')
    const listed = actions.list({ sessionId: 's1' })
    is(listed.total, 1)
    is(listed.items[0].name, '严格同事')
  })

  check('use：记录本会话选择，并把预设推到最近使用', () => {
    const result = actions.use({ sessionId: 's1', id: createdId })
    ok(result.ok, '应成功')
    const listed = actions.list({ sessionId: 's1' })
    is(listed.current, createdId)
    is(listed.recent, [createdId])
    is(listed.items[0].inUse, 1, '使用计数应为 1')
  })

  check('current：返回当前套的名字', () => {
    const result = actions.current({ sessionId: 's1' })
    is(result.current, createdId)
    is(result.name, '严格同事')
  })

  check('use 到不存在的预设 → not-found', () => {
    const result = actions.use({ sessionId: 's1', id: '99-不存在.md' })
    is(result.ok, false)
    is(result.code, 'not-found')
  })

  check('use 没有会话 id → no-session（不写盘）', () => {
    const result = actions.use({ id: createdId })
    is(result.ok, false)
    is(result.code, 'no-session')
  })

  check('update：mtime 过期 → conflict', () => {
    const read = actions.read({ id: createdId })
    ok(read.ok, '读应成功')
    const result = actions.update({
      id: createdId,
      body: '改过',
      expectedMtimeMs: read.preset.mtimeMs - 5000,
    })
    is(result.ok, false)
    is(result.code, 'conflict')
  })

  check('update：正常写入', () => {
    const read = actions.read({ id: createdId })
    const result = actions.update({
      id: createdId,
      name: '严格同事',
      description: '结论先行',
      body: '换了个正文。\n',
      expectedMtimeMs: read.preset.mtimeMs,
    })
    ok(result.ok, '应成功')
    is(actions.read({ id: createdId }).preset.body, '换了个正文。\n')
  })

  check('update 改名字 → 重命名文件，排序与会话选择跟着走', () => {
    const before = actions.list({ sessionId: 's1' })
    ok(before.items[0].id === createdId, '前提：列表里还是旧名字')
    const read = actions.read({ id: createdId })
    const result = actions.update({
      id: createdId,
      name: '严格同事（新）',
      expectedMtimeMs: read.preset.mtimeMs,
    })
    ok(result.ok, '应成功')
    is(result.renamedFrom, createdId)
    const renamedId = result.id
    is(renamedId, '严格同事（新）.md')
    // 会话还指着这一套
    const after = actions.list({ sessionId: 's1' })
    is(after.current, renamedId, '会话选择应搬到新名字')
    createdId = renamedId
  })

  let copyId = ''
  check('saveAs：复制出一套新预设，原文件不动', () => {
    const result = actions.saveAs({ id: createdId, name: '严格同事 副本' })
    ok(result.ok, '应成功')
    copyId = result.id
    ok(copyId !== createdId, '新文件名应不同')
    is(actions.read({ id: createdId }).preset.body, '换了个正文。\n')
  })

  check('reset：回退到默认预设', () => {
    const result = actions.reset({ sessionId: 's1' })
    ok(result.ok, '应成功')
    is(actions.current({ sessionId: 's1' }).current, null)
  })

  check('remove：软删除并清理指向它的会话', () => {
    actions.use({ sessionId: 's2', id: copyId })
    const result = actions.remove({ id: copyId })
    ok(result.ok, '应成功')
    is(result.clearedSessions, 1, '应清掉 1 个引用')
    const listed = actions.list({ sessionId: 's2' })
    ok(!listed.items.some(item => item.id === copyId), '列表里不应再有')
    is(listed.current, null, 's2 应回退默认')
  })

  check('删除不存在的预设 → not-found', () => {
    const result = actions.remove({ id: '77-没有.md' })
    is(result.ok, false)
    is(result.code, 'not-found')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 / ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)