/**
 * 从 `$DSH_HOME/enhance/presets/*.md` 生成「增强 · <预设名>」模式行，写进 cordis.patch.yml。
 *
 * 用途（B 方案 / 兜底）：模式下拉里直接一步选到某套预设，不需要点胶囊。
 * 代价：预设多了下拉会变长，且对话中途不能切模式。
 *
 * 用法：
 *   node scripts/sync-presets.mjs            # 只打印，不写文件（默认，安全）
 *   node scripts/sync-presets.mjs --write    # 真正写回 cordis.patch.yml
 *
 * 生成区由两行标记界定；标记之外的任何内容都不碰。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePresetDir } from '../lib/paths.mjs'
import { listPresets } from '../lib/presets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH_FILE = resolve(HERE, '..', 'cordis.patch.yml')

/** 生成区起止标记；`scripts/sync-standard.mjs` 也要原样输出这两行（它会整份重写文件）。 */
export const BEGIN = '# >>> enhance-presets:auto（由 scripts/sync-presets.mjs 生成，勿手改）'
export const END = '# <<< enhance-presets:auto'

/** 生成区里每个模式行的 order 起点（官方四个模式是 1..4，我们的是 5）。 */
const BASE_ORDER = 6

/** id 只留小写字母数字连字符。 */
function slug(text) {
  const ascii = String(text)
    .normalize('NFKD')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  // 中文没法进 id，用序号兜底
  const safe = ascii.replace(/[^a-z0-9-]/g, '')
  return safe === '' ? null : safe
}

/**
 * 从现有 patch 里抽出「增强模式」那一条的 plugins 列表原文。
 * 以行块方式复制，不改动内容，避免自己解析 YAML。
 * @returns {{ itemIndent: number, pluginsIndent: number, block: string[] }}
 */
export function extractStandardPlugins(patchText) {
  const lines = patchText.split('\n')
  const presetIndex = lines.findIndex(line => /^\s*- id: preset-enhance\s*$/.test(line))
  if (presetIndex === -1) throw new Error('cordis.patch.yml 里找不到 `- id: preset-enhance` 这一行')

  const pluginsIndex = lines.findIndex((line, index) => index > presetIndex && /^\s+plugins:\s*$/.test(line))
  if (pluginsIndex === -1) throw new Error('`preset-enhance` 下面找不到 `plugins:` 块')

  const itemIndent = lines[presetIndex].search(/\S/)
  const pluginsIndent = lines[pluginsIndex].search(/\S/)
  const block = []
  for (let index = pluginsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '') {
      const indent = line.search(/\S/)
      if (indent <= pluginsIndent) break
    }
    block.push(line)
  }
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  return { itemIndent, pluginsIndent, block }
}

/** 去掉 plugins 块里"我们自己的那一行"，剩下的就是标准模式的插件清单。 */
export function stripOwnRow(block) {
  const kept = []
  let skipping = false
  let itemIndent = 0
  for (const line of block) {
    const trimmed = line.trim()
    if (trimmed.startsWith('- id: enhance-mode-prompt')) {
      skipping = true
      itemIndent = line.search(/\S/)
      continue
    }
    if (skipping) {
      const indent = line.trim() === '' ? Number.MAX_SAFE_INTEGER : line.search(/\S/)
      if (indent > itemIndent) continue
      skipping = false
    }
    kept.push(line)
  }
  return kept
}

/**
 * 生成模式行。
 * block 里的行是**绝对缩进**的原文，这里按 pluginsIndent 平移，保持嵌套关系不变。
 * @param {{ id: string, name: string }[]} presets
 * @param {{ itemIndent: number, pluginsIndent: number, block: string[] }} standard
 */
export function buildRows(presets, standard) {
  const { itemIndent, pluginsIndent } = standard
  const item = ' '.repeat(itemIndent)
  const field = ' '.repeat(itemIndent + 2)
  const config = ' '.repeat(itemIndent + 4)
  const pluginItem = ' '.repeat(pluginsIndent + 2)
  const lines = []

  presets.forEach((preset, index) => {
    const key = slug(preset.name) ?? `p${index + 1}`
    const order = BASE_ORDER + index
    lines.push(`${item}- id: preset-enhance-${key}`)
    lines.push(`${field}name: '@deepseek-ai/dsh-agent-preset'`)
    lines.push(`${field}config:`)
    lines.push(`${config}id: enhance-${key}`)
    lines.push(`${config}name: 增强 · ${preset.name}`)
    lines.push(`${config}description: 用「${preset.name}」这套预设开一个新对话。`)
    lines.push(`${config}order: ${order}`)
    lines.push(`${config}plugins:`)
    for (const line of standard.block) {
      // 原文缩进相对 pluginsIndent 平移，子级关系原样保留
      const relative = line.trim() === '' ? '' : line.slice(pluginsIndent)
      lines.push(`${' '.repeat(pluginsIndent)}${relative}`)
    }
    lines.push(`${pluginItem}- id: enhance-mode-prompt`)
    lines.push(`${pluginItem}  name: '@slz233/dsh-enhance-mode/prompt/index.js'`)
    lines.push(`${pluginItem}  config:`)
    lines.push(`${pluginItem}    preset: '${preset.id}'`)
    lines.push('')
  })

  return lines.join('\n')
}

/** 用新内容替换生成区；标记缺失则抛错（不猜位置）。 */
export function replaceRegion(patchText, content) {
  const beginIndex = patchText.indexOf(BEGIN)
  const endIndex = patchText.indexOf(END)
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    throw new Error(`cordis.patch.yml 里缺少生成区标记：\n  ${BEGIN}\n  ${END}`)
  }
  const before = patchText.slice(0, beginIndex + BEGIN.length)
  const after = patchText.slice(endIndex)
  return `${before}\n${content}\n${after}`
}

// ---- CLI ----
function main() {
  const write = process.argv.includes('--write')
  const presetDir = resolvePresetDir({})
  const presets = listPresets(presetDir)

  if (presets.length === 0) {
    console.error(`没有找到任何预设：${presetDir}`)
    console.error('先往这个目录里放 .md 文件，再重跑本脚本。')
    process.exit(1)
  }

  const patchText = readFileSync(PATCH_FILE, 'utf8')
  const standard = extractStandardPlugins(patchText)
  const rows = buildRows(presets, {
    itemIndent: standard.itemIndent,
    pluginsIndent: standard.pluginsIndent,
    block: stripOwnRow(standard.block),
  })

  console.log(`预设 ${presets.length} 套，生成 ${presets.length} 个模式行：`)
  for (const preset of presets) console.log(`  - 增强 · ${preset.name}  (${preset.id})`)

  if (!write) {
    console.log('\n---- 生成内容（未写入；加 --write 才会写回）----\n')
    console.log(rows)
    return
  }

  writeFileSync(PATCH_FILE, replaceRegion(patchText, rows), 'utf8')
  console.log(`\n已写入 ${PATCH_FILE}`)
  console.log('提醒：模式定义变更需要重启 DSH 才生效。')
}

// 只在被当作脚本直接运行时执行；被 import 做单测时不跑
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}