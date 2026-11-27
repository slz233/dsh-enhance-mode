#!/usr/bin/env node
/**
 * 把「官方标准模式」的插件清单抄进本包的 cordis.patch.yml。
 *
 * 为什么要"抄"：DSH 的预设没有继承/extends，patch 覆盖是整块替换。
 * 所以"标准模式 + 一小段"只能是一份 standard 的**快照**，再加我们自己那一行。
 * 代价是快照会漂移——官方哪天给 standard 加工具，我们这份不会自动跟上。
 * 这个脚本就是用来消除漂移的：DSH 升级后重跑一次，重新对齐。
 *
 * 用法（在 DSH 的 shell 里，环境变量 DSH_INSTALL_DIR 已经存在）：
 *   node scripts/sync-standard.mjs
 * 自己指定来源：
 *   node scripts/sync-standard.mjs --from "D:\...\dsh-web-app\presets\standard.patch.yml"
 *
 * Desktop 版源码在 app.asar 里，普通 node 读不到，要用宿主自带的 electron：
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:DSH_NODE_EXECUTABLE" scripts/sync-standard.mjs
 * 或者直接跑同目录的 sync-standard.ps1（会自动找宿主 exe）。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BEGIN as PRESETS_BEGIN, END as PRESETS_END } from './sync-presets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'cordis.patch.yml')

/** 预设的元信息：改这里，重跑同步即可（cordis.patch.yml 是生成物）。 */
const PRESET = {
  rowId: 'preset-enhance',
  id: 'enhance',
  name: '增强模式',
  description: '标准模式的工具集；不读全局 AGENTS.md，只读项目级 AGENTS.md，并在系统提示末尾追加 $DSH_HOME/enhance/mode-prompt.md',
  order: 5,
}

/**
 * 我们自己那一行插件：只注册一段提示词。
 *
 * 为什么用包名子路径而不是 './prompt/index.js'：预设子行的解析基准是**声明它的那个
 * Loader**（也就是 profile 目录），不是本包的 patch 文件所在目录。相对路径会被解析成
 * <profile>/prompt/index.js，找不到 → 整个预设激活失败（0.2.2-rc.5 实测）。
 * 包名从 profile/node_modules 解析，本包就是从那里装的，所以稳定。
 */
const OWN_ROW = [
  '          # —— 本包自己的一行：只注册一段提示词，不碰任何官方段 ——',
  '          - id: enhance-mode-prompt',
  "            name: '@slz233/dsh-enhance-mode/prompt/index.js'",
].join('\n')

/**
 * 预设之外的第二行：包根插件，挂在 profile 根（和预设行同级，缩进 4）。
 *
 * 它做两件事：
 *  1. 注册界面用的数据通道路由（`lib/api.mjs` 的 `apply`）；
 *  2. 充当客户端产物的锚点——宿主按"被挂载的行"去包清单里找 `dsh.client`，
 *     而 `locatePkgJson` 只认**裸包名**（子路径行会被直接跳过）。
 *     这就是这里必须是 `@slz233/dsh-enhance-mode` 而不是某个子路径的原因。
 */
const ROOT_ROW = [
  '',
  '    # —— 包根这一行：注册界面数据通道 + 客户端产物锚点（必须是裸包名） ——',
  '    - id: enhance-mode-api',
  "      name: '@slz233/dsh-enhance-mode'",
].join('\n')


function fail(message) {
  console.error('[sync-standard] ' + message)
  process.exit(1)
}

/** 解析命令行参数：只支持 --from <path>。 */
function readArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--from') {
      out.from = argv[i + 1]
      i += 1
    } else if (arg.startsWith('--from=')) {
      out.from = arg.slice('--from='.length)
    }
  }
  return out
}

/** 找官方 standard.patch.yml：--from > 环境变量 > 从 DSH_INSTALL_DIR 推导。 */
function resolveSource(from) {
  if (typeof from === 'string' && from.trim() !== '') return resolve(from.trim())
  const explicit = process.env.DSH_ENHANCE_STANDARD_PATCH
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir === 'string' && installDir.trim() !== '') {
    const pkgs = dirname(installDir)
    return join(pkgs, 'dsh-web-app', 'presets', 'standard.patch.yml')
  }
  fail(
    '找不到官方 standard.patch.yml。\n'
    + '  - 在 DSH 的 shell 里跑（环境变量 DSH_INSTALL_DIR 会带着）；或\n'
    + '  - 用 --from 指定路径；或\n'
    + '  - 设置环境变量 DSH_ENHANCE_STANDARD_PATCH。',
  )
}

/** 抽出 standard 的 plugins 块（从 `plugins:` 行到文件末尾），原样返回条目行。 */
function extractPlugins(text) {
  const lines = text.split(/\r?\n/)
  const keyIndex = lines.findIndex(line => /^\s+plugins:\s*$/.test(line))
  if (keyIndex < 0) fail('来源文件里没有找到 `plugins:` 行，格式可能变了。')
  const keyIndent = lines[keyIndex].match(/^\s*/)[0].length
  const items = []
  for (const line of lines.slice(keyIndex + 1)) {
    if (line.trim() === '') continue
    const indent = line.match(/^\s*/)[0].length
    if (indent <= keyIndent) break
    items.push(line.replace(/\s+$/, ''))
  }
  if (items.length === 0) fail('`plugins:` 下面是空的。')
  if (!items.some(line => /^\s*- id: persona\b/.test(line))) {
    fail('抽出来的清单里没有 `- id: persona`，抽取逻辑可能已经和官方格式对不上。')
  }
  if (items.some(line => /^\s*- id: enhance-mode-prompt\b/.test(line))) {
    fail('官方清单里出现了 `enhance-mode-prompt` 行，和本包的 id 撞了。')
  }
  return items
}

/**
 * 从清单里整块剔除一个条目（含它的 config 子行）。
 *
 * 为什么剔 `agent-instructions`：官方的全局链（$DSH_HOME/AGENTS.md、~/.agents/AGENTS.md）
 * 是**进程级策略**，行配置改不了（README 明确写 dshHome/agentsHome 键会被忽略）。
 * 所以这个模式不挂它，改由 prompt/index.js 自己只读项目级 AGENTS.md。
 */
function dropEntry(items, id) {
  const out = []
  let skipping = false
  for (const line of items) {
    const match = line.match(/^\s*- id:\s*(\S+)\s*$/)
    if (match !== null) skipping = match[1] === id
    if (!skipping) out.push(line)
  }
  return out
}

const args = readArgs(process.argv.slice(2))
const source = resolveSource(args.from)

if (!existsSync(source)) {
  fail(`读不到来源文件：${source}\n（Desktop 版在 app.asar 里，普通 node 读不到；用 ELECTRON_RUN_AS_NODE=1 配合宿主 exe 跑，或跑 sync-standard.ps1。）`)
}

let standardText
try {
  standardText = readFileSync(source, 'utf8')
} catch (error) {
  fail(`读取失败：${source}\n${error.message}`)
}

const rawItems = extractPlugins(standardText)
const items = dropEntry(rawItems, 'agent-instructions')
if (items.length === rawItems.length) {
  fail('没能从官方清单里剔除 `agent-instructions` 行（可能官方改了 id），请检查后重跑。')
}
const itemCount = items.filter(line => /^\s*- id:/.test(line)).length

const header = [
  '# ⚠️ 本文件由 scripts/sync-standard.mjs 生成，手改会在下一次同步时被整份覆盖。',
  '#',
  '# 作用：声明一个「增强模式」预设 = 官方 standard 的插件清单（**剔除 agent-instructions**）',
  '#       + 末尾追加一段自定义提示词 + 自己读项目级 AGENTS.md。',
  '#',
  '# 为什么剔除 agent-instructions：官方全局链（$DSH_HOME/AGENTS.md、~/.agents/AGENTS.md）',
  '# 是进程级策略，行配置改不了；这个模式不读全局指令，只读项目级（见 prompt/index.js）。',
  '#',
  '# 机制：DSH 的预设没有继承，patch 是整块替换，所以这里是 standard 的一份快照；',
  '#       官方升级后重跑同步即可重新对齐。',
  `# 清单行数：${itemCount}（已剔除 1 条 agent-instructions）`,
  '# 生成来源：DSH 安装目录内的 @deepseek-ai/dsh-web-app/presets/standard.patch.yml',
  '#           （本机绝对路径只在命令行输出里，不写进仓库）',
  '- insert:',
  `    - id: ${PRESET.rowId}`,
  "      name: '@deepseek-ai/dsh-agent-preset'",
  '      config:',
  `        id: ${PRESET.id}`,
  `        name: ${PRESET.name}`,
  `        description: ${PRESET.description}`,
  `        order: ${PRESET.order}`,
  '        plugins:',
].join('\n')

const output = `${header}\n${items.join('\n')}\n${OWN_ROW}${ROOT_ROW}\n\n${PRESETS_BEGIN}\n${PRESETS_END}\n`

writeFileSync(OUT, output, 'utf8')

console.log('[sync-standard] 已生成 ' + OUT)
console.log('[sync-standard] 来源：' + source)
console.log('[sync-standard] 官方清单 ' + itemCount + ' 行（已剔除 agent-instructions）'
  + ' + 本包 2 行（enhance-mode-prompt 预设行、enhance-mode-api 包根行）')
