# 开发说明

给要改这个插件的人看的。用户只需要读 [README](../README.md)。

## 本地开发怎么装

装本地目录，改完重启就生效（不经过 npm / GitHub）：

```powershell
dsh plugin --profile desktop add "H:\…\33-enhance"
```

profile 的 `package.json` 里会记成一行 `link:`，DSH 直接读这个工作目录。
从 npm 装的是打包快照，改代码不会自动生效——这是两者唯一的区别。

## 目录

```
package.json            插件声明（dsh.bundle.patch → cordis.patch.yml；dsh.client → 浏览器半）
cordis.patch.yml        ⚠️ 生成物：预设声明 = 官方标准模式的插件清单 + 本包 2 行
prompt/index.js         预设里那一行：注册提示词段 + 读项目级 AGENTS.md
lib/api.mjs             包根那一行：界面用的本机同源数据接口（同时是客户端产物的锚点）
client/index.js         浏览器半：胶囊 + 清理失败按钮 + 管理弹窗
lib/services.mjs        读宿主服务的唯一正确姿势（见下）
lib/actions.mjs         预设动作层（界面 / 斜杠命令 / 助手工具共用）
lib/presets.mjs         预设解析与列目录（含"没被识别"的回报）
lib/store.mjs           预设文件增删改查（改名 = 重命名文件）
lib/order.mjs           内部排序表 + 内容指纹（presets-order.json，v2）
lib/rebind.mjs          改名识别：指纹唯一命中才认，认回排序与会话选择
lib/sessions.mjs        会话选择记录（sessions.json）
lib/paths.mjs           目录与文件位置（DSH_HOME/enhance 下的那几样）
lib/command.mjs         斜杠命令 /enhance 的解析与注册
lib/tool.mjs            助手工具 enhance_preset 的定义与注册
lib/heal.mjs            会话修复：用 surface replace 把失败回合摘出模型视野
lib/update.mjs          版本检查：拉 npm latest，缓存 24 小时，失败静默
docs/images/            README 用的截图
scripts/                生成、检查、测试脚本（见下）
open-prompt.cmd         双击编辑提示词文件
run-check.cmd           双击跑检查
```

## 脚本

| 脚本 | 作用 |
|---|---|
| `scripts/sync-standard.mjs` | DSH 升级后重新抄官方标准模式的清单（消除快照漂移） |
| `scripts/sync-presets.mjs` | 重写 `cordis.patch.yml` 里预设那一段 |
| `scripts/check-session.mjs` | 读回对话日志，确认那段话真的进了系统提示 |
| `scripts/doctor.mjs` | 看本机现状：目录、预设清单、默认文案、会话记录 |
| `scripts/test-*.mjs` | 八个测试文件，共 307 条（`test-project-instructions.mjs` 单独跑，验读取项目级 AGENTS.md） |

```powershell
node scripts/test-presets.mjs; node scripts/test-wiring.mjs; node scripts/test-actions.mjs
node scripts/test-bridges.mjs; node scripts/test-api.mjs; node scripts/test-client.mjs
node scripts/test-heal.mjs; node scripts/test-update.mjs
```

为什么要"抄"官方清单：DSH 的模式没有继承机制，一份模式就是一份完整的插件列表。
`cordis.patch.yml` 是官方标准模式的一份快照，**DSH 升级后重跑一次 `sync-standard` 即可重新对齐**
（不跑的话，官方给标准模式新加了工具，增强模式不会跟上）。

## 硬规矩

**一、宿主服务只能 `ctx.get('名字')` 读，不能写 `ctx.名字`。**

cordis 4 给上下文套了 Proxy，没写进 `inject` 的属性访问会直接抛
`cannot get property "xxx" without inject`；这一抛发生在激活阶段，宿主会把整个预设标记为「坏掉」，
而 DSH 的模式下拉只显示健康的预设——于是症状是：插件装了、也 enabled，但下拉里就是没有，
**界面上一个字都不报**（错误只在「设置 → 智能体预设」那一行后面）。

把服务名加进 `inject` 也不行，那会变成硬依赖，宿主没提供时同样整行失败。所以本插件的 `inject`
只有 `systemPrompt` 和 `tools`：`commands`、`sessionTitle` 在用到时经 `lib/services.mjs` 的
`safeService()`（即 `ctx.get()`）取，`webServer` 用 `ctx.inject(['webServer'], …)` 等就绪再挂路由；
取不到就静默降级（少一个入口，提示词照常工作）。`safeService()` 是读宿主服务的唯一入口，别绕过它。

**二、工具定义必须是「宿主已经转换过的 JSON Schema」。**

`defineTool()` 会把 `{ action: { type: 'string', required: true } }` 转成
`{ type: 'object', properties: {...}, required: ['action'] }`。我们没法 import 它
（`@deepseek-ai/dsh-tools` 在安装目录的 asar 里，插件跑在 profile，解析不到），
所以 `lib/tool.mjs` 里直接写转换后的形态。写回友好写法的后果很干脆：`tools.register()` 第一句就是
`assertSupportedJsonSchema(output.schema)`，它会抛
`JsonSchemaError: unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"`，
注册作废、只留一条 console.warn——模型那边就**根本没有这个工具**。

**三、界面层四条（错了都是静默失败）。**

1. 客户端产物只认**裸包名**。宿主按"被挂载的 Loader 行"去包清单里找 `dsh.client`，
   而它的解析器只接受裸包名（`@slz233/dsh-enhance-mode`），子路径行会被直接跳过——
   所以 `cordis.patch.yml` 里必须有一行 `name: '@slz233/dsh-enhance-mode'`。
2. 浏览器半只能用"平台种子"模块。宿主只往模块表里放 `react`、`react-dom`、`@deepseek-ai/cordis`、
   `zod` 等十来个，`require` 任何别的东西都会在工厂执行时抛，症状是界面上什么都没有。
3. `conversation.input.dock` 是整行宽的槽位，浮层必须交给宿主的 `Menu` / `Modal`（它们自己 portal），
   自己 `position: fixed` 会被裁。
4. **不要自绘控件配色。** `--dsw-alias-*` 这些 token 由主题插件在运行时注入，猜名字必翻车。
   视觉只用宿主 `primitives` 的 `Modal` / `Menu` / `MenuItemButton` / `Button` / `Input`，
   自己只写布局；需要块面时用 `color-mix(in srgb, currentColor …)` 从继承色派生。

## 会话修复（`lib/heal.mjs`）

只做一件事：**改模型视野，不改日志，不改界面。** 用的是宿主官方的表面替换：

```js
session.append('user/message', marker, {
  surfaceOp: { op: 'replace', startSeq, endSeq },
  sourceEventSeqs: shadowed,   // 区间内每一条都必须列出来
})
```

四个踩过的坑，改之前先读：

1. **`surface.nodes` 不是按 seq 递增的。** 只有 5 类事件能进 surface
   （`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`），
   而压缩 / 替换会把高 seq 的节点插到很靠前的位置。所以切点必须**自己就在 nodes 里**，
   然后按位置取 `nodes.slice(indexOf(切点))`——用 `seq >= 切点` 过滤必然被宿主判 `missing N`。
2. **切到 `system/message` 必须拒绝。** 那是系统提示 / 压缩摘要，删了模型就没有指令了。
3. **换完要清派生缓存**（`session.derived = []`、`derivedNodes = 0`、`derivedGeneration = -1`），
   否则界面还挂着已经摘掉的旧消息；同时包装 `session.deriveMessages` 把 `rewind-` 标记滤掉，
   不然界面上会多出一行空消息。
4. **界面上的红字不会消失，这是 DSH 的设计。** `turn/end` 之类的审计事件根本不在 surface 里，
   摘掉的只是喂给模型的上下文。README 里已经对用户解释过，别把它当 bug 去"修"。

连续失败由 `planDrops()` 合并成一组、一次 replace 清一段；段内只要有一条不属于这组就整段跳过
（宁可不做，也不连带删掉中间的真实对话）。

## 版本检查（`lib/update.mjs`）

`checkForUpdate()` 是整个插件唯一的对外请求：`GET <registry>/<包名>/latest`，只读版本号。

- 先 `registry.npmmirror.com` 再 `registry.npmjs.org`，各 8 秒超时，两个都挂就当这功能不存在；
- 成功缓存 24 小时、失败冷却 1 小时，写在 `%DSH_HOME%\enhance\update-check.json`；
- 启动后延迟 10 秒执行并 `timer.unref()`，不阻止关窗；
- 结论只给界面读。**别在这里加遥测、别加任何标识参数。**

## 验证一次话真的进去了

```powershell
node "<仓库目录>\scripts\check-session.mjs"
```

会打印最近一个对话的模式、系统提示长度，以及你的文本在不在里面。
