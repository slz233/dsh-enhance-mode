#!/usr/bin/env node
/**
 * 读回会话日志，检查「增强模式」的那段文本是否真的进了**系统提示**。
 *
 * 会话日志是 zstd 压缩的 JSONL（一行一帧），路径形如
 *   $DSH_HOME/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd
 * 系统提示存在 `system/message` 记录里（data.message.content[0].text），每轮一条，取最后一条。
 *
 * 用法：
 *   node scripts/check-session.mjs                  # 检查最新的一个会话
 *   node scripts/check-session.mjs --session <文件>  # 检查指定日志
 *   node scripts/check-session.mjs --needle <文字>   # 用指定文字找（默认取 mode-prompt.md 第一行非空内容）
 *
 * Desktop 版：用宿主自带的 electron 跑（Node 22.15+ 才带 zstd）
 *   $env:ELECTRON_RUN_AS_NODE=1; & "$env:DSH_NODE_EXECUTABLE" scripts\check-session.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PERSONA_HINT = 'You are a coding agent powered by'

function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** 会话日志是"一串独立的 zstd 帧"，按魔数切开逐帧解压。 */
function decompressAll(file) {
  const buf = readFileSync(file)
  const starts = []
  let index = buf.indexOf(ZSTD_MAGIC, 0)
  while (index !== -1) {
    starts.push(index)
    index = buf.indexOf(ZSTD_MAGIC, index + 1)
  }
  if (starts.length === 0) throw new Error('不是一个 zstd 日志：' + file)
  const parts = []
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k]
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      // 切错了就跳过这一帧，不影响别的帧
    }
  }
  return parts.join('')
}

function newestSessionLog(root) {
  let best
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (name.endsWith('.zstd')) {
        if (best === undefined || st.mtimeMs > best.mtime) best = { file: full, mtime: st.mtimeMs }
      }
    }
  }
  walk(root)
  return best?.file
}

/** 文本文件第一行非空内容，作为默认要找的标记。 */
function defaultNeedle() {
  try {
    const file = join(resolveHome(), 'enhance', 'mode-prompt.md')
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find(l => l.trim() !== '')
    return line?.trim()
  } catch {
    return undefined
  }
}

/** 取最后一条系统提示的纯文本。 */
function systemText(records) {
  let latest
  for (const record of records) {
    if (record.type !== 'system/message') continue
    const content = record?.data?.message?.content
    if (!Array.isArray(content)) continue
    latest = content.filter(part => part?.type === 'text').map(part => part.text).join('\n\n')
  }
  return latest
}

const home = resolveHome()
const file = arg('session') ?? newestSessionLog(join(home, 'sessions'))
if (file === undefined) {
  console.error('[check-session] 找不到会话日志，用 --session 指定路径。')
  process.exit(1)
}

const needle = arg('needle') ?? defaultNeedle()
if (needle === undefined) {
  console.error('[check-session] 没有要找的文字：用 --needle 指定，或先写 $DSH_HOME/enhance/mode-prompt.md。')
  process.exit(1)
}

let text
try {
  text = decompressAll(file)
} catch (error) {
  console.error('[check-session] ' + error.message)
  process.exit(1)
}

const records = []
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  try {
    records.push(JSON.parse(line))
  } catch {
    // 半行就跳过
  }
}

const header = records.find(record => record.type === 'session')
// 空白会话上切预设时，这次选择记在 `agent-preset/selected`，会话头里的 agentPreset 仍是创建时的默认值
let selected
for (const record of records) {
  if (record.type === 'agent-preset/selected' && record.data?.agentPreset !== undefined) {
    selected = record.data.agentPreset
  }
}
const system = systemText(records)

// 官方的 AGENTS.md 基线是一条 source.kind = 'agent-instructions' 的 user 消息；
// 增强模式剔除了那个插件，所以这里应当是 0 条（项目级由本包以运行时上下文注入，不落在日志里）。
const instructionBases = records.filter(record => record.type === 'user/message'
  && record.data?.source?.kind === 'agent-instructions')
const instructionPaths = new Set()
for (const message of instructionBases) {
  for (const change of message.data?.source?.changes ?? []) {
    if (typeof change?.path === 'string') instructionPaths.add(change.path)
  }
}

console.log('日志文件：' + file)
console.log('会话 id：' + (header?.id ?? '(未知)'))
console.log('模式（切换记录）：' + (selected ?? '(无切换，沿用创建时)'))
console.log('模式（会话创建时）：' + (header?.agentPreset ?? '(未记录)'))
console.log('官方 instructions 基线：' + (instructionBases.length === 0
  ? '无（增强模式不挂 agent-instructions）'
  : instructionBases.length + ' 条 → ' + [...instructionPaths].join(', ')))
console.log('记录数：' + records.length)
console.log('要找的文字：' + JSON.stringify(needle.length > 80 ? needle.slice(0, 80) + '…' : needle))

if (system === undefined) {
  console.log('结论：这个会话还没有系统提示记录（还没跑过一轮）。')
  process.exit(0)
}

const found = system.includes(needle)
console.log('系统提示长度：' + system.length + ' 字符')
console.log('含官方 persona：' + (system.includes(PERSONA_HINT) ? '是' : '否'))
console.log('含要找的文字：' + (found ? '是' : '否'))
console.log('系统提示末尾 200 字：')
console.log('  ' + JSON.stringify(system.slice(-200)))

if (found) {
  const at = system.indexOf(needle)
  console.log('命中位置在全文第 ' + at + ' 字符，距结尾 ' + (system.length - at - needle.length) + ' 字符')
  console.log('结论：这段文字确实在系统提示里。')
} else {
  console.log('结论：这个会话的系统提示里没有这段文字（不选增强模式的会话本就应该没有）。')
}
