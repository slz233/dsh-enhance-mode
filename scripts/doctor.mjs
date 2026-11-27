/**
 * 现场体检：不启动 DSH，只看磁盘上「增强模式」的真实状态。
 *
 * 用法：node scripts/doctor.mjs
 *
 * 回答四个问题：
 *   1. 数据目录在哪、里面有什么；
 *   2. 有哪些预设（标题/字数/是否为空）；
 *   3. 哪些会话选了哪套；
 *   4. 哪些会话被标记为"用过增强模式"（界面靠它决定是否显示胶囊）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDefaultFile, resolveEnhanceDir, resolvePresetDir, resolveSessionsFile } from '../lib/paths.mjs'
import { listPresets } from '../lib/presets.mjs'
import { markerDir, readState } from '../lib/sessions.mjs'

const enhanceDir = resolveEnhanceDir({})
const presetDir = resolvePresetDir({})
const defaultFile = resolveDefaultFile({})
const sessionsFile = resolveSessionsFile({})

function line(char = '─', width = 56) {
  return char.repeat(width)
}

console.log(line('═'))
console.log('增强模式 · 现场体检')
console.log(line('═'))

console.log(`\nDSH_HOME   ${process.env.DSH_HOME ?? '(未设置，用 ~/.dsh)'}`)
console.log(`数据目录   ${enhanceDir}  ${existsSync(enhanceDir) ? '' : '（不存在）'}`)
console.log(`默认预设   ${defaultFile}  ${existsSync(defaultFile) ? '' : '（不存在，首次装配会自动创建示例）'}`)
console.log(`预设目录   ${presetDir}  ${existsSync(presetDir) ? '' : '（不存在，等同"只有默认一套"）'}`)
console.log(`会话记录   ${sessionsFile}  ${existsSync(sessionsFile) ? '' : '（不存在）'}`)

// ---- 预设 ----
console.log(`\n${line()}\n预设\n${line()}`)
const presets = listPresets(presetDir)
if (presets.length === 0) {
  console.log('（一套都没有；把 .md 放进预设目录即可）')
} else {
  for (const preset of presets) {
    const flags = [preset.empty ? '空' : `${preset.chars} 字`]
    console.log(`  ${preset.id}（名字：${preset.name}）`)
    if (preset.description !== '') console.log(`    ${flags.join('｜')}｜描述：${preset.description}`)
  }
}

// ---- 默认预设内容 ----
console.log(`\n${line()}\n默认预设正文（前 3 行）\n${line()}`)
if (existsSync(defaultFile)) {
  const body = readFileSync(defaultFile, 'utf8').replace(/^\uFEFF/, '')
  const head = body.split('\n').slice(0, 3).join('\n')
  console.log(head === '' ? '（空文件）' : head)
} else {
  console.log('（还没有这个文件）')
}

// ---- 会话选择 ----
const state = readState(sessionsFile)
const choices = Object.entries(state.sessions)
console.log(`\n${line()}\n会话选择（${choices.length} 条）\n${line()}`)
if (choices.length === 0) console.log('（还没有任何对话选过预设）')
for (const [sessionId, presetId] of choices) {
  const alive = presets.some(preset => preset.id === presetId)
  console.log(`  ${sessionId} → ${presetId}${alive ? '' : '  ⚠ 该文件已不存在（会回退默认）'}`)
}
if (state.recent.length > 0) console.log(`  最近使用：${state.recent.join('、')}`)

// ---- 标记 ----
const dir = markerDir(sessionsFile)
let marked = []
try {
  marked = readdirSync(dir).filter(name => name.endsWith('.on'))
} catch {
  marked = []
}
console.log(`\n${line()}\n增强模式标记（${marked.length} 个会话）\n${line()}`)
if (marked.length === 0) {
  console.log('（还没有会话在增强模式里装配过；界面此时不会显示胶囊）')
} else {
  console.log(`  目录：${dir}`)
  console.log('  说明：有标记 = 该会话用过增强模式，胶囊会显示。')
}

// ---- 其它文件 ----
console.log(`\n${line()}\n数据目录清单\n${line()}`)
if (existsSync(enhanceDir)) {
  for (const name of readdirSync(enhanceDir)) {
    const file = join(enhanceDir, name)
    const info = statSync(file)
    const size = info.isDirectory() ? `${readdirSync(file).length} 项` : `${info.size} B`
    console.log(`  ${name.padEnd(18)} ${size}`)
  }
} else {
  console.log('（目录还没建出来，重启 DSH 后会自动创建）')
}

console.log(`\n${line('═')}`)
console.log('提示：这个脚本只读磁盘，不启动 DSH、不改任何文件。')
