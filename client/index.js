/**
 * 「增强模式」的界面层（浏览器半）。
 *
 * 宿主用 `dsh.client` 找到这个文件，按固定形状执行它：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … } })
 * 工厂里只能取"平台种子"模块。这里只取三样：
 *   react、@deepseek-ai/dsh-client-ui-primitives、（无）
 *
 * **视觉全部用宿主自己的组件**（Modal / Menu / MenuItemButton / Button / Input）：
 * 它们自带主题色、高度、圆角、遮罩、点空白关闭、Esc 关闭、焦点管理。
 * 0.4.0 第一版自绘了弹窗和下拉，在浅色主题下配色全错、按钮过高、点外面关不掉，
 * 所以这一版把外壳整块删掉——自己只写"布局"（flex/宽高/间距），不写任何颜色，
 * 需要颜色时一律用 `currentColor` 派生，保证深浅主题都跟宿主一致。
 *
 * 三条硬约束（宿主文档写明）：
 *  1. 宿主服务只能 `ctx.get('名字')` 读，写 `ctx.名字` 会抛（cordis 4 的 Proxy）；
 *  2. 只在「增强模式」会话里渲染——判据是会话摘要的 `projectionValues.agentPreset`；
 *  3. 浮层交给宿主组件（它们自己 portal 到 body），不要自己造 fixed 浮层。
 */

window.__ModuleLoader__.load({
  id: '@slz233/dsh-enhance-mode',
  factory(require) {
    const React = require('react')
    const {
      Button, IconChevronDownOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular,
      IconRefreshOutlineRegular, IconSettingsOutlineMedium, IconTrashOutlineRegular,
      Input, Menu, MenuItemButton, Modal,
    } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = React

    /** 数据通道路径；和 lib/api.mjs 的 API_PATH 必须一致。 */
    const API_PATH = '/enhance/api'

    /**
     * 描述在界面上最多这么多字（和 lib/presets.mjs 的 DESCRIPTION_MAX 保持一致）。
     * 只限制"在这里输入"和"这里显示"——别人整理好的文件长什么样还是什么样。
     */
    const DESCRIPTION_MAX = 120

    /** 所有 class 前缀，避免污染宿主样式。 */
    const NS = 'dse'

    /** 本插件认的宿主预设 id（cordis.patch.yml 里 `config.id`）。 */
    const PRESET_ID = 'enhance'

    /** 槽位里本行的顺序：todo 是 0、goal 是 10，界面行排在它们下面。 */
    const DOCK_ORDER = 20

    // ---------------------------------------------------------------- 文案

    /**
     * 自带一张极小的文案表：宿主的 `ctx.locale` 要写进 `inject` 才是硬依赖，
     * 服务缺失会让整个客户端插件不激活（静默）。语言只看一次 `navigator.language`。
     * @returns {(key: string, params?: Record<string, string | number>) => string}
     */
    function createTranslator() {
      const zh = {
        'dock.label': '增强 · {preset}',
        'dock.default': '默认',
        'dock.missing': '预设已失效',
        'dock.unavailable': '暂不可用',
        'dock.defaultHint': '正在用默认文案（mode-prompt.md），点左边可以换一套',
        'dock.missingHint': '原来选的那套不在了（可能被改名或删除），接着用上一次的文案',
        'dock.hint': '切换会改动系统提示词，本对话的缓存命中可能受影响。',
        'dock.manage': '管理全部（{count} 套）…',
        'dock.empty': '还没有预设文件',
        'dock.switched': '已切到「{name}」，下一句生效',
        'dock.channelDown': '界面通道不可用，先用 /enhance use <预设> 切换',
        'undo.label': '撤销上一轮',
        'undo.confirm': '确认撤销这一轮',
        'undo.done': '已撤销 ✓ 可直接发送',
        'undo.empty': '没有可撤的轮次',
        'undo.busy': '处理中…',
        'undo.hint': '把最后一轮从模型视野里摘掉。界面上的记录不会消失——那是操作日志，只是不会再发给模型。',
        'clean.label': '清理失败',
        'clean.confirm': '确认清理',
        'clean.done': '已清理',
        'clean.empty': '无需清理',
        'clean.failed': '没能清理',
        'clean.hint': '把历史里报错的回合从模型视野里摘掉，前后的正常对话原样保留。界面上的红字不会消失——那是日志，模型已经看不到它了。',
        'modal.title': '管理预设',
        'modal.close': '关闭',
        'modal.search': '搜索预设…',
        'modal.noMatch': '没有匹配的预设',
        'modal.pickOne': '从左边挑一套，或者点「新建」自己写一套',
        'modal.noDesc': '（无描述）',
        'modal.edit': '编辑',
        'modal.save': '保存',
        'modal.cancel': '取消',
        'modal.saveAs': '另存为',
        'modal.remove': '删除',
        'modal.confirmRemove': '确认删除',
        'modal.new': '新建',
        'modal.folder': '打开文件夹',
        'modal.refresh': '刷新',
        'modal.refreshed': '已刷新',
        'modal.refreshBlocked': '先保存或取消编辑，再刷新',
        'modal.bulk': '批量选择',
        'modal.bulkAll': '全选',
        'modal.bulkNone': '取消全选',
        'modal.bulkExit': '退出批量',
        'modal.bulkCount': '已选 {count} 套',
        'modal.bulkDelete': '删除选中的 {count} 套',
        'modal.bulkConfirm': '确认删除 {count} 套',
        'modal.bulkHint': '点一套选中、再点一次取消；按住 Shift 点另一套，可以把这一段全选上。批量模式里只能删。',
        'modal.removedMany': '已删掉 {count} 套',
        'modal.stale': '这个文件已经不在原来的名字上了，清单已刷新',
        'modal.unsavedTitle': '还有没保存的修改',
        'modal.unsavedHint': '现在关掉，这些改动就没了。要先保存吗？',
        'modal.closeSave': '保存后关闭',
        'modal.closeDiscard': '不保存关闭',
        'modal.folderFail': '打不开文件夹：{reason}',
        'modal.folderNoApp': '这个系统上没有可用的文件管理器',
        'modal.reload': '重新读取',
        'modal.field.name': '名字（自动存成 .md 文件）',
        'modal.field.description': '一句话说明它是干什么的（会显示在胶囊上）',
        'modal.field.body': '正文：你想让模型额外遵守的话',
        'modal.renameHint': '改名字会真的重命名磁盘上的文件；排序和正在用它的对话都会跟着走。',
        'modal.ignored': '有 {count} 个文件没被识别：{names}',
        'ig.hidden': '以 _ 或 . 开头',
        'ig.directory': '同名的是文件夹',
        'ig.not-markdown': '不是 .md 文件',
        'ig.unreadable': '读不了',
        'modal.order': '排序',
        'modal.orderHint': '输入序号后回车：这一套会挪到那个位置，其余顺延。只影响界面顺序，不改文件名。',
        'modal.bodyPlaceholder': '写在这里，例如：每段话结尾都加一个「喵」',
        'modal.bodyEmpty': '（正文为空，这套预设不追加任何内容）',
        'modal.chars': '{count} 字',
        'modal.inUse': '{count} 个对话正在使用',
        'modal.dirty': '未保存',
        'modal.saved': '已保存',
        'modal.discard': '当前修改还没保存，确定切到别的预设？',
        'modal.discardYes': '丢弃改动',
        'modal.conflict': '磁盘上的文件比界面里的新。先「重新读取」，免得盖掉别处的修改。',
        'modal.removeHint': '软删除：文件移到 presets\\_trash\\，可以手动恢复。',
        'modal.removeInUse': '{count} 个对话正在用它，删除后回退默认。',
        'modal.aiHint': '也可以直接对助手说「把这段话存成一套预设」',
        'update.found': '发现新版本 v{latest}（当前 v{current}）',
        'update.how': '怎么更新',
        'update.hide': '收起',
        'update.step1': '左侧「插件」页 → 找到 @slz233/dsh-enhance-mode → 卸载',
        'update.step2': '右上角「添加插件」→「安装第三方插件」→ 包名照样填一次',
        'update.step3': '重启 DSH。预设和会话记录都在 %DSH_HOME%\\enhance\\，不会丢',
      }
      const en = {
        'dock.label': 'Enhance · {preset}',
        'dock.default': 'Default',
        'dock.missing': 'Preset missing',
        'dock.unavailable': 'Unavailable',
        'dock.defaultHint': 'Using the default text (mode-prompt.md); click the left side to pick a preset',
        'dock.missingHint': 'The selected preset is gone (renamed or deleted); the last text keeps applying',
        'dock.hint': 'Switching changes the system prompt, so this conversation may miss its cache.',
        'dock.manage': 'Manage all ({count})…',
        'dock.empty': 'No preset files yet',
        'dock.switched': 'Switched to "{name}"; applies from the next turn',
        'dock.channelDown': 'UI channel unavailable; use /enhance use <preset>',
        'undo.label': 'Undo last turn',
        'undo.confirm': 'Undo this turn?',
        'undo.done': 'Undone ✓ send anytime',
        'undo.empty': 'Nothing to undo',
        'undo.busy': 'Working…',
        'undo.hint': 'Takes the last turn out of the model view. The transcript on screen stays — it is an operation log, it just is not sent anymore.',
        'clean.label': 'Clean',
        'clean.confirm': 'Confirm',
        'clean.done': 'Cleaned',
        'clean.empty': 'All clean',
        'clean.failed': "Didn't work",
        'clean.hint': 'Removes the errored turns from the model view only; the good turns around them stay. The red lines on screen stay too — they are the log, the model no longer sees them.',
        'modal.title': 'Manage presets',
        'modal.close': 'Close',
        'modal.search': 'Search presets…',
        'modal.noMatch': 'No matching preset',
        'modal.pickOne': 'Pick one on the left, or press New to write your own',
        'modal.noDesc': '(no description)',
        'modal.edit': 'Edit',
        'modal.save': 'Save',
        'modal.cancel': 'Cancel',
        'modal.saveAs': 'Save as…',
        'modal.remove': 'Delete',
        'modal.confirmRemove': 'Confirm delete',
        'modal.new': 'New',
        'modal.folder': 'Open folder',
        'modal.refresh': 'Refresh',
        'modal.refreshed': 'Refreshed',
        'modal.refreshBlocked': 'Save or cancel the edit before refreshing',
        'modal.bulk': 'Select',
        'modal.bulkAll': 'Select all',
        'modal.bulkNone': 'Select none',
        'modal.bulkExit': 'Exit',
        'modal.bulkCount': '{count} selected',
        'modal.bulkDelete': 'Delete {count}',
        'modal.bulkConfirm': 'Confirm delete {count}',
        'modal.bulkHint': 'Click to select, click again to deselect; Shift-click extends the range. Only deletion is available while selecting.',
        'modal.removedMany': 'Deleted {count}',
        'modal.stale': 'That file is no longer under that name; the list has been refreshed',
        'modal.unsavedTitle': 'Unsaved changes',
        'modal.unsavedHint': 'Closing now discards them. Save first?',
        'modal.closeSave': 'Save and close',
        'modal.closeDiscard': 'Close without saving',
        'modal.folderFail': 'Cannot open the folder: {reason}',
        'modal.folderNoApp': 'No file manager found on this system',
        'modal.reload': 'Reload',
        'modal.field.name': 'Name (saved as a .md file for you)',
        'modal.field.description': 'One line about what it does (shown in the menu)',
        'modal.field.body': 'Body: the extra rule you want the model to follow',
        'modal.renameHint': 'Renaming renames the file on disk; order and the conversations using it follow.',
        'modal.ignored': '{count} file(s) not recognised: {names}',
        'ig.hidden': 'starts with _ or .',
        'ig.directory': 'that name is a folder',
        'ig.not-markdown': 'not a .md file',
        'ig.unreadable': 'unreadable',
        'modal.order': 'Order',
        'modal.orderHint': 'Type a position and press Enter: this preset moves there and the rest shift down. UI order only — file names are untouched.',
        'modal.bodyPlaceholder': 'Write it here, e.g. end every paragraph with "meow"',
        'modal.bodyEmpty': '(empty body — this preset adds nothing)',
        'modal.chars': '{count} chars',
        'modal.inUse': 'used by {count} conversation(s)',
        'modal.dirty': 'unsaved',
        'modal.saved': 'Saved',
        'modal.discard': 'There are unsaved changes. Switch anyway?',
        'modal.discardYes': 'Discard',
        'modal.conflict': 'The file on disk is newer. Reload before saving to avoid overwriting another change.',
        'modal.removeHint': 'Soft delete: the file moves to presets\\_trash\\ and can be restored by hand.',
        'modal.removeInUse': 'used by {count} conversation(s); they fall back to the default.',
        'modal.aiHint': 'You can also ask the assistant: "save this as a preset"',
        'update.found': 'New version v{latest} available (you have v{current})',
        'update.how': 'How to update',
        'update.hide': 'Hide',
        'update.step1': 'Plugins page → find @slz233/dsh-enhance-mode → Uninstall',
        'update.step2': 'Top right "Add plugin" → "Install third-party plugin" → paste the same package name',
        'update.step3': 'Restart DSH. Presets and conversation records stay in %DSH_HOME%\\enhance\\',
      }
      const table = String(navigator.language ?? '').toLowerCase().startsWith('zh') ? zh : en
      return (key, params) => {
        const template = table[key] ?? zh[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/gu, (whole, name) => (name in params ? String(params[name]) : whole))
      }
    }

    // ---------------------------------------------------------------- 通道

    /**
     * 一次同源 POST。
     * @param {Record<string, unknown>} payload
     * @returns {Promise<Record<string, any>>} 宿主返回的 `{ok, …}`
     */
    async function postApi(payload) {
      let response
      try {
        response = await fetch(API_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
        })
      } catch (error) {
        throw new Error(`界面通道连不上：${error?.message ?? error}`)
      }
      if (response.status === 404) throw new Error('宿主没有开界面通道（/enhance/api）')
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`界面通道返回了非 JSON（HTTP ${response.status}）`)
      }
      if (body === null || typeof body !== 'object') throw new Error('界面通道返回格式不对')
      return body
    }

    /**
     * 带 pending / error 的小状态机；`lastFailure` 留着最近一次失败的原始返回
     * （例如 `code: 'conflict'`），因为 `run` 只区分成功与失败。
     */
    function useAsyncAction() {
      const [pending, setPending] = useState(false)
      const [error, setError] = useState(null)
      const lastFailure = useRef(null)
      const run = useCallback(async fn => {
        setPending(true)
        setError(null)
        lastFailure.current = null
        try {
          const value = await fn()
          if (value !== null && typeof value === 'object' && value.ok === false) {
            lastFailure.current = value
            setError(String(value.message ?? '操作失败'))
            return null
          }
          return value
        } catch (thrown) {
          setError(thrown?.message ?? String(thrown))
          return null
        } finally {
          setPending(false)
        }
      }, [])
      return { pending, error, setError, run, lastFailure }
    }

    /**
     * 这个会话是不是增强模式。用槽位给的 `useSessions` 选择器（官方 AgentPresetLabel
     * 的做法）；拿不到就退回读 props 上的会话摘要，仍拿不到就当作不是。
     * @returns {string | undefined}
     */
    function useSessionPreset(props) {
      const { sessionId } = props
      const useSessions = props.useSessions
      if (typeof useSessions === 'function') {
        // `useSessions` 在同一槽位内恒定存在，所以这里的条件调用是稳定的
        return useSessions(state => {
          const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' ? value : undefined
        })
      }
      const direct = props.session?.projectionValues?.agentPreset
      return typeof direct === 'string' ? direct : undefined
    }

    // ---------------------------------------------------------------- 样式

    const STYLE_ID = `${NS}-style`

    /**
     * 只写布局，不写颜色。
     *
     * 0.4.0 教训：自绘配色在浅色主题下会全错（那些 `--dsw-alias-*` token 是运行时
     * 由主题插件注入的，猜名字必翻车）。所以这里只做 flex/宽高/间距/圆角，
     * 需要"看起来有块面"时用 `color-mix(in srgb, currentColor …)` 从继承色派生。
     */
    const CSS = `
.${NS}-dock {
  box-sizing: border-box;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 auto;
  padding: 2px 6px;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 0px) * 2 -
    var(--dsh-composer-dock-inset, 0px) * 4
  );
  max-width: calc(var(--dsh-composer-card-max-width, 780px) - var(--dsh-composer-dock-inset, 0px) * 4);
  /* 这一行是盖在对话正文上方的——所以必须有实体底色，否则文字会从按钮旁边透出来。
     配色照官方 TodoPanel（同一个槽位里已经跑通的组合）：specific-menu + panel 阴影。 */
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  box-shadow: var(--dsw-elevation-panel);
}
.${NS}-menuCopy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.${NS}-menuTitle { font-size: 13px; line-height: 18px; }
.${NS}-menuDesc {
  font-size: 12px; line-height: 16px; opacity: 0.6;
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 下拉最多显示 5 套，多的在里面滚——不然有的会话能长到比窗口还高 */
.${NS}-menuList { max-height: 250px; overflow-y: auto; }
/* 触发器后面那一截说明文字：只读、不接点击，长了就省略号（悬停可看全文） */
.${NS}-trigger { flex: none; white-space: nowrap; }
/* 吃满整行，把右边的「撤销上一轮」推到最靠边的位置 */
.${NS}-dockInner { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 auto; }
/*
 * 「撤销上一轮」：ghost 按钮在这条白底 dock 上等于隐形，用户看不出能点。
 * 所以给它一圈描边 + 悬停底色，做成"看得见边界"的次要按钮（配色仍取主题 token）。
 */
.${NS}-undo {
  flex: none;
  /* 固定一个底宽：不管现在是"清理失败""确认清理"还是"无需清理"，按钮都不忽长忽短 */
  min-width: 92px;
  justify-content: center;
  text-align: center;
  max-width: 150px;
  overflow: hidden;
  border-radius: var(--dsw-radius-md, 8px);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  transition: background-color 120ms ease;
}
/* 万一哪天文案还是太长，宁可省略号也不要撑成横幅；完整原因在 title 里 */
.${NS}-undo > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${NS}-undo:hover { background: color-mix(in srgb, currentColor 9%, transparent); }
.${NS}-undo:active { background: color-mix(in srgb, currentColor 15%, transparent); }
/* 确认态：红字 + 红描边 + 淡红底，明确"再点就真删" */
.${NS}-undoConfirm {
  color: var(--dsw-alias-text-danger, #e5484d);
  box-shadow: inset 0 0 0 1px currentColor;
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.${NS}-caption {
  flex: 1 1 auto; min-width: 0; padding-right: 6px;
  font-size: 12px; line-height: 18px; opacity: 0.6;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${NS}-note { font-size: 12px; line-height: 18px; opacity: 0.6; }

/* 版本提示条：只在真有新版时出现，是一条安静的通知，不是弹窗 */
.${NS}-update {
  display: flex; flex-direction: column; gap: 6px;
  margin-bottom: 12px; padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
  font-size: 12px; line-height: 18px;
}
.${NS}-updateRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.${NS}-updateMore {
  margin-left: auto; padding: 0; border: 0; background: none; cursor: pointer;
  font: inherit; color: inherit; text-decoration: underline; opacity: 0.75;
}
.${NS}-updateMore:hover { opacity: 1; }
.${NS}-updateSteps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; opacity: 0.8; }

.${NS}-dialog { width: 860px; max-width: 94vw; }
.${NS}-layout { display: flex; gap: 14px; align-items: stretch; min-height: 340px; }
.${NS}-side { display: flex; flex-direction: column; gap: 8px; width: 220px; flex: none; min-height: 0; }
/*
 * 底部按钮排。
 * 宿主不给 footer 换行，按钮一多就被压窄，中文会在词中间折行、上下叠在一起（点删除时的样子）。
 * 所以：按钮一律 flex: 0 0 auto + nowrap（宁可换行，不许压扁），整排放不下就整颗按钮掉到下一行。
 */
.${NS}-footer {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end;
  gap: 8px; width: 100%;
}
.${NS}-footer > * { flex: 0 0 auto; white-space: nowrap; }
.${NS}-footer > .${NS}-grow { flex: 1 1 auto; min-width: 0; }
.${NS}-list {
  display: flex; flex-direction: column; gap: 2px;
  min-height: 0; max-height: 340px; overflow-y: auto;
}
.${NS}-row {
  display: flex; flex-direction: column; gap: 1px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.${NS}-row:hover { background: color-mix(in srgb, currentColor 7%, transparent); }
.${NS}-row[data-current="true"] { background: color-mix(in srgb, currentColor 12%, transparent); }
.${NS}-row[data-selected="true"] { background: color-mix(in srgb, currentColor 16%, transparent); }
.${NS}-rowTitle { font-size: 13px; line-height: 18px; }
.${NS}-rowDesc { font-size: 12px; line-height: 16px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${NS}-detail { display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto; min-width: 0; }
.${NS}-readTitle { margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; }
.${NS}-titleRow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.${NS}-titleRow > .${NS}-readTitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${NS}-order {
  flex: none; width: 44px; height: 24px; box-sizing: border-box; padding: 0 2px;
  text-align: center; font: inherit; font-size: 12px; color: inherit; background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  border-radius: 6px;
  appearance: textfield;
  -moz-appearance: textfield;
}
.${NS}-order::-webkit-outer-spin-button,
.${NS}-order::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.${NS}-order:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 40%, transparent); outline-offset: -1px; }
.${NS}-titleInput { flex: 1 1 auto; min-width: 0; }
.${NS}-readDesc { margin: 0; font-size: 12px; line-height: 18px; opacity: 0.6; }
.${NS}-body {
  flex: 1 1 auto; min-height: 120px; max-height: 300px; overflow: auto;
  margin: 0; padding: 10px 12px; box-sizing: border-box;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 8px;
  font: inherit; font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
}
.${NS}-bodyEdit {
  flex: 1 1 auto; min-height: 120px; max-height: 300px; width: 100%; box-sizing: border-box;
  padding: 10px 12px; resize: none; font: inherit; font-size: 13px; line-height: 1.65;
  color: inherit; background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  border-radius: 8px;
}
.${NS}-bodyEdit:focus-visible { outline: 2px solid color-mix(in srgb, currentColor 40%, transparent); outline-offset: -1px; }
.${NS}-field { display: flex; flex-direction: column; gap: 4px; }
.${NS}-fieldLabel { font-size: 12px; line-height: 16px; opacity: 0.6; }
.${NS}-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; line-height: 16px; opacity: 0.6; }
.${NS}-error { font-size: 12px; line-height: 18px; color: inherit; opacity: 0.95; }
.${NS}-empty { padding: 20px 8px; font-size: 12px; text-align: center; opacity: 0.6; }
.${NS}-ignored {
  flex: none; font-size: 11px; line-height: 15px; opacity: 0.55;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.${NS}-grow { flex: 1 1 auto; }
`

    /** 注入一次样式，返回撤销函数。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const element = document.createElement('style')
      element.id = STYLE_ID
      element.textContent = CSS
      document.head.append(element)
      return () => {
        try {
          element.remove()
        } catch {
          // 宿主可能已经清过
        }
      }
    }

    /** 拼接 class 名。 */
    function cx(...parts) {
      return parts.filter(part => typeof part === 'string' && part !== '').join(' ')
    }

    // ---------------------------------------------------------------- 管理弹窗

    /** 空表单。 */
    const EMPTY_DRAFT = { name: '', description: '', body: '' }

    /**
     * 管理弹窗：左列表、右详情。**默认只读**，点「编辑」才进入可改状态
     * （0.4.0 第一版一进来就是输入框，用户反馈分不清"看"和"改"）。
     * 外壳用宿主的 `Modal`：遮罩、点空白关闭、Esc、焦点管理、配色都由它负责。
     */
    function PresetManager(props) {
      const { sessionId, t, onClose } = props
      const [items, setItems] = useState([])
      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(null)
      const [mtime, setMtime] = useState(null)
      const [inUse, setInUse] = useState(0)
      const [search, setSearch] = useState('')
      const [editing, setEditing] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [pendingSelect, setPendingSelect] = useState(null)
      const [confirmRemove, setConfirmRemove] = useState(false)
      const [conflict, setConflict] = useState(false)
      const [note, setNote] = useState(null)
      // 预设目录（「打开文件夹」用）与"没被识别"的文件清单
      const [folder, setFolder] = useState('')
      const [ignored, setIgnored] = useState([])
      const [folderBusy, setFolderBusy] = useState(false)
      // 排序输入框里的草稿；null 表示"没在改，显示真实位置"
      const [orderDraft, setOrderDraft] = useState(null)
      // 关闭时「还有没保存的修改」的确认窗
      const [closePrompt, setClosePrompt] = useState(false)
      // 批量选择：选中的 id、Shift 连选的锚点、删除前的二次确认
      const [selectMode, setSelectMode] = useState(false)
      const [selectedIds, setSelectedIds] = useState([])
      const [bulkAnchor, setBulkAnchor] = useState(null)
      const [confirmBulk, setConfirmBulk] = useState(false)
      const actions = useAsyncAction()

      // 版本提示：宿主不给第三方插件「更新」按钮，只能我们自己说一声。
      // 结论来自后端缓存（启动后查过一次），所以这里不阻塞、不等待网络。
      const [update, setUpdate] = useState(null)
      const [updateOpen, setUpdateOpen] = useState(false)
      useEffect(() => {
        let alive = true
        void postApi({ op: 'update' })
          .then(result => {
            if (alive && result !== null && result.ok !== false && result.hasUpdate === true) setUpdate(result)
          })
          .catch(() => {
            // 通道不通 / 宿主不支持：静默，界面上一个字都不加
          })
        return () => {
          alive = false
        }
      }, [])

      const flash = useCallback(text => {
        setNote(text)
        window.setTimeout(() => setNote(current => (current === text ? null : current)), 1600)
      }, [])

      /** 拉列表；保持选中项不跳。 */
      const refresh = useCallback(async (preferId = null) => {
        const result = await postApi({ op: 'list', sessionId })
        if (result.ok === false) {
          actions.setError(String(result.message ?? '读不到预设列表'))
          return []
        }
        const list = Array.isArray(result.items) ? result.items : []
        // 宿主这次对账认出来的改名：选中项跟着新名字走（rename in Explorer → 点刷新）
        const moved = new Map(
          (Array.isArray(result.rebound) ? result.rebound : []).map(pair => [pair.from, pair.to]),
        )
        setItems(list)
        setFolder(typeof result.presetDir === 'string' ? result.presetDir : '')
        setIgnored(Array.isArray(result.ignored) ? result.ignored : [])
        setSelectedId(current => {
          const wanted = preferId ?? current
          const target = wanted === null ? null : (moved.get(wanted) ?? wanted)
          if (target !== null && list.some(item => item.id === target)) return target
          return list.length === 0 ? null : list[0].id
        })
        return list
      }, [sessionId])

      /** 读一套的全文（正文只存在文件里，界面不留副本）。 */
      const load = useCallback(async id => {
        setEditing(false)
        setDirty(false)
        setConfirmRemove(false)
        setConflict(false)
        if (id === null) {
          setDraft(null)
          setMtime(null)
          setInUse(0)
          return
        }
        const result = await postApi({ op: 'read', id })
        if (result.ok === false) {
          // 文件在资源管理器里被改名/删除了：刷新清单，别只甩一句"没有这个文件"
          if (result.code === 'not-found') {
            flash(t('modal.stale'))
            await refresh()
            return
          }
          actions.setError(String(result.message ?? '读不到这套预设'))
          return
        }
        const preset = result.preset ?? {}
        setDraft({
          name: String(preset.name ?? ''),
          description: String(preset.description ?? ''),
          body: String(preset.body ?? ''),
        })
        setMtime(typeof preset.mtimeMs === 'number' ? preset.mtimeMs : null)
        setInUse(Number(result.inUse ?? 0))
      }, [flash, refresh])

      useEffect(() => {
        void refresh()
      }, [refresh])

      useEffect(() => {
        void load(selectedId)
      }, [selectedId, load])

      const selected = items.find(item => item.id === selectedId) ?? null
      const filtered = useMemo(() => {
        const term = search.trim().toLowerCase()
        if (term === '') return items
        return items.filter(item =>
          item.name.toLowerCase().includes(term)
          || item.id.toLowerCase().includes(term)
          || String(item.description ?? '').toLowerCase().includes(term))
      }, [items, search])

      function pick(id) {
        if (id === selectedId) return
        if (editing && dirty) {
          setPendingSelect(id)
          return
        }
        setSelectedId(id)
      }

      function discardAndPick() {
        const next = pendingSelect
        setPendingSelect(null)
        setEditing(false)
        setDirty(false)
        if (next !== null) setSelectedId(next)
      }

      function editField(field, value) {
        setDraft(current => ({ ...(current ?? EMPTY_DRAFT), [field]: value }))
        setDirty(true)
      }

      /** @returns {Promise<boolean>} 是否真的保存成功（"保存后关闭"要据此决定关不关） */
      async function save() {
        if (draft === null || selected === null) return false
        const result = await actions.run(() => postApi({
          op: 'save',
          id: selected.id,
          name: draft.name,
          description: draft.description,
          body: draft.body,
          expectedMtimeMs: mtime,
        }))
        if (result === null) {
          setConflict(actions.lastFailure.current?.code === 'conflict')
          return false
        }
        // 改了名字就是重命名文件：id 变了，选中项跟着换过去
        const nextId = typeof result.id === 'string' && result.id !== '' ? result.id : selected.id
        setDirty(false)
        setEditing(false)
        setConflict(false)
        setMtime(typeof result.mtimeMs === 'number' ? result.mtimeMs : mtime)
        await refresh(nextId)
        setSelectedId(nextId)
        await load(nextId)
        flash(t('modal.saved'))
        return true
      }

      async function create() {
        const result = await actions.run(() => postApi({ op: 'create', name: '未命名预设', description: '', body: '' }))
        if (result === null) return
        await refresh(result.id)
        setSelectedId(result.id)
        setEditing(true)
        setDirty(false)
      }

      async function saveAs() {
        if (selected === null) return
        const base = (editing && draft !== null ? draft.name : selected.name).trim()
        const result = await actions.run(() => postApi({ op: 'saveAs', id: selected.id, name: `${base} 副本` }))
        if (result === null) return
        await refresh(result.id)
        setSelectedId(result.id)
        flash(t('modal.saved'))
      }

      async function remove() {
        if (selected === null) return
        const result = await actions.run(() => postApi({ op: 'remove', id: selected.id }))
        setConfirmRemove(false)
        if (result === null) return
        setEditing(false)
        setDirty(false)
        await refresh()
      }

      /**
       * 宿主的 `Modal` 把**遮罩、右上角 ×、ESC** 都接到同一个 `onClose` 上。
       * 这里按"事件从哪来"分流：
       *  - 点遮罩（target 不在对话框里）→ 什么都不做：关掉"点空白就关"的习惯；
       *  - 点 ×（target 在对话框里）/ ESC（宿主不传事件）→ 真的关。
       * `nodeType` 用来区分 DOM 节点和 undefined，比看 `event.type` 稳。
       */
      function guardedClose(close) {
        return event => {
          const target = event?.target
          if (target !== null && target !== undefined && typeof target.nodeType === 'number'
            && typeof document.querySelector === 'function') {
            const dialog = document.querySelector(`.${NS}-confirm`) ?? document.querySelector(`.${NS}-dialog`)
            if (dialog !== null && !dialog.contains(target)) return
          }
          close()
        }
      }

      /** 关闭请求：有未保存的修改就先问一句，别让人一按 ESC 白写。 */
      function requestClose() {
        if (editing && dirty) {
          setClosePrompt(true)
          return
        }
        onClose()
      }

      async function saveAndClose() {
        const saved = await save()
        setClosePrompt(false)
        if (saved) onClose()
      }

      /** 「刷新」：重读目录 + 认改名，选中项跟着搬。 */
      async function refreshList() {
        await refresh(selectedId)
        flash(t('modal.refreshed'))
      }

      // ---------------------------------------------------------- 批量选择

      function enterSelect() {
        setSelectMode(true)
        setSelectedIds([])
        setBulkAnchor(null)
        setConfirmBulk(false)
      }

      function exitSelect() {
        setSelectMode(false)
        setSelectedIds([])
        setBulkAnchor(null)
        setConfirmBulk(false)
      }

      /** 全选 / 取消全选：只作用于当前搜索结果里的那些。 */
      function toggleSelectAll() {
        const ids = filtered.map(item => item.id)
        const allSelected = ids.length > 0 && ids.every(id => selectedIds.includes(id))
        setSelectedIds(allSelected ? [] : ids)
        setBulkAnchor(null)
        setConfirmBulk(false)
      }

      /**
       * 列表行点击。普通模式 = 换选（走 pick）；批量模式 = 点一次选中、再点取消，
       * 按住 Shift 点另一套把中间那一整段都选上（照 Windows 资源管理器的习惯）。
       */
      function pickRow(id, event) {
        if (!selectMode) {
          pick(id)
          return
        }
        const index = filtered.findIndex(item => item.id === id)
        const anchorIndex = bulkAnchor === null ? -1 : filtered.findIndex(item => item.id === bulkAnchor)
        if (event !== undefined && event !== null && event.shiftKey === true && anchorIndex >= 0 && index >= 0) {
          const [from, to] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex]
          const range = filtered.slice(from, to + 1).map(item => item.id)
          setSelectedIds(current => {
            const next = [...current]
            for (const item of range) if (!next.includes(item)) next.push(item)
            return next
          })
          setConfirmBulk(false)
          return
        }
        setSelectedIds(current => (current.includes(id)
          ? current.filter(item => item !== id)
          : [...current, id]))
        setBulkAnchor(id)
        setConfirmBulk(false)
      }

      /** 批量删除：一套一套调同一个 remove（软删除，会顺手清掉指向它的会话）。 */
      async function removeSelected() {
        const ids = [...selectedIds]
        if (ids.length === 0) return
        const failed = []
        for (const id of ids) {
          const result = await postApi({ op: 'remove', id })
          if (result.ok === false) failed.push(`${id}（${result.message}）`)
        }
        setConfirmBulk(false)
        setSelectedIds([])
        await refresh()
        if (failed.length > 0) {
          actions.setError(`${failed.length} 套没删掉，第一个：${failed[0]}`)
          return
        }
        setSelectMode(false)
        flash(t('modal.removedMany', { count: ids.length }))
      }

      const removeHint = inUse > 0
        ? `${t('modal.removeHint')} ${t('modal.removeInUse', { count: inUse })}`
        : t('modal.removeHint')

      /**
       * 在系统文件管理器里打开预设目录。
       *
       * 不自绘、也不 spawn `explorer.exe`：直接借宿主的 `/open-in-app` 路由
       * （官方插件提供，"在文件夹中显示"走的就是它；它按平台给出应用 id：
       * Windows = explorer、macOS = finder、Linux = filemanager）。
       * 路由不在（老版本 DSH）就只报一句错，不影响其他功能。
       */
      async function openFolder() {
        if (folder === '') return
        setFolderBusy(true)
        try {
          const response = await fetch('open-in-app/apps', { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          const available = Array.isArray(payload?.apps) ? payload.apps : []
          const app = ['explorer', 'finder', 'filemanager'].find(id => available.includes(id))
          if (app === undefined) throw new Error(t('modal.folderNoApp'))
          const opened = await fetch('open-in-app/open', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ app, path: folder }),
          })
          if (!opened.ok) throw new Error(`HTTP ${opened.status}`)
        } catch (error) {
          actions.setError(t('modal.folderFail', { reason: error?.message ?? String(error) }))
        } finally {
          setFolderBusy(false)
        }
      }

      // 当前这套在列表里的位置（1 起）。列表顺序 = 内部排序，和文件名前缀无关。
      const position = selected === null ? 0 : items.findIndex(item => item.id === selected.id) + 1

      /** 把输入的序号提交上去：只改 `presets-order.json`，不动文件。 */
      async function commitOrder() {
        if (selected === null) return
        const raw = orderDraft === null ? String(position) : orderDraft
        setOrderDraft(null)
        const next = Number.parseInt(raw, 10)
        if (!Number.isInteger(next) || next < 1 || next > items.length || next === position) return
        const result = await actions.run(() => postApi({ op: 'reorder', id: selected.id, position: next }))
        if (result === null) return
        await refresh(selected.id)
      }

      const orderInput = h('input', {
        type: 'number',
        min: 1,
        max: items.length,
        className: cx(`${NS}-order`),
        'aria-label': t('modal.order'),
        title: t('modal.orderHint'),
        value: orderDraft ?? String(position),
        onChange: event => setOrderDraft(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void commitOrder()
          } else if (event.key === 'Escape') {
            event.stopPropagation()
            setOrderDraft(null)
          }
        },
        onBlur: () => {
          if (orderDraft !== null) void commitOrder()
        },
      })

      // footer 自己包一层：宿主不给换行，按钮多了就会被压窄、中文在词中间折行叠在一起。
      // 这一层负责「不缩、不折、放不下就整体换行」。
      const normalFooter = h('div', { className: cx(`${NS}-footer`) },
        h(Button, {
          variant: 'outline',
          icon: h(IconPlusOutlineRegular, { size: 14 }),
          disabled: actions.pending,
          onClick: () => {
            void create()
          },
        }, t('modal.new')),

        h(Button, {
          variant: 'outline',
          disabled: actions.pending || folderBusy || folder === '',
          title: folder,
          onClick: () => {
            void openFolder()
          },
        }, t('modal.folder')),

        h(Button, {
          variant: 'outline',
          // 编辑中且有改动时不让刷：会把草稿冲掉
          disabled: actions.pending || (editing && dirty),
          title: editing && dirty ? t('modal.refreshBlocked') : t('modal.refresh'),
          onClick: () => {
            void refreshList()
          },
        }, t('modal.refresh')),

        h(Button, {
          variant: 'outline',
          disabled: items.length === 0 || actions.pending,
          title: t('modal.bulkHint'),
          onClick: enterSelect,
        }, t('modal.bulk')),

        h('span', { className: cx(`${NS}-grow`) }),

        confirmRemove
          ? h(React.Fragment, null,
            h(Button, { variant: 'outline', onClick: () => setConfirmRemove(false) }, t('modal.cancel')),
            h(Button, {
              variant: 'outline',
              disabled: actions.pending,
              onClick: () => {
                void remove()
              },
            }, t('modal.confirmRemove')),
          )
          : h(Button, {
            variant: 'outline',
            icon: h(IconTrashOutlineRegular, { size: 14 }),
            disabled: selected === null || actions.pending,
            title: removeHint,
            onClick: () => setConfirmRemove(true),
          }, t('modal.remove')),

        h(Button, {
          variant: 'outline',
          disabled: selected === null || actions.pending,
          onClick: () => {
            void saveAs()
          },
        }, t('modal.saveAs')),

        editing
          ? h(React.Fragment, null,
            h(Button, {
              variant: 'outline',
              onClick: () => {
                setEditing(false)
                setDirty(false)
                void load(selectedId)
              },
            }, t('modal.cancel')),
            h(Button, {
              variant: 'primary',
              disabled: actions.pending || !dirty,
              onClick: () => {
                void save()
              },
            }, t('modal.save')),
          )
          : h(Button, {
            variant: 'primary',
            icon: h(IconEditOutlineRegular, { size: 14 }),
            disabled: selected === null,
            onClick: () => {
              setEditing(true)
              setConfirmRemove(false)
            },
          }, t('modal.edit')),
      )

      /** 批量模式的 footer：全选 / 已选数量 / 删除（二次确认）/ 退出。 */
      const allSelected = filtered.length > 0 && filtered.every(item => selectedIds.includes(item.id))
      const selectFooter = h('div', { className: cx(`${NS}-footer`) },
        h(Button, { variant: 'outline', onClick: toggleSelectAll }, allSelected ? t('modal.bulkNone') : t('modal.bulkAll')),
        h('span', { className: cx(`${NS}-note`) }, t('modal.bulkCount', { count: selectedIds.length })),
        h('span', { className: cx(`${NS}-grow`) }),
        confirmBulk
          ? h(React.Fragment, null,
            h(Button, { variant: 'outline', onClick: () => setConfirmBulk(false) }, t('modal.cancel')),
            h(Button, {
              variant: 'outline',
              disabled: selectedIds.length === 0,
              onClick: () => {
                void removeSelected()
              },
            }, t('modal.bulkConfirm', { count: selectedIds.length })),
          )
          : h(Button, {
            variant: 'outline',
            disabled: selectedIds.length === 0,
            onClick: () => setConfirmBulk(true),
          }, t('modal.bulkDelete', { count: selectedIds.length })),
        h(Button, { variant: 'outline', onClick: exitSelect }, t('modal.bulkExit')),
      )

      const footer = selectMode ? selectFooter : normalFooter

      const confirmClose = closePrompt && h(Modal, {
        open: true,
        title: t('modal.unsavedTitle'),
        description: t('modal.unsavedHint'),
        closeLabel: t('modal.close'),
        className: cx(`${NS}-confirm`),
        // 确认窗自己也只能用 ESC / 按钮关；ESC 走这里 = 取消（不丢东西也不保存）
        onClose: guardedClose(() => setClosePrompt(false)),
        footer: h('div', { className: cx(`${NS}-footer`) },
          h(Button, { variant: 'outline', onClick: () => setClosePrompt(false) }, t('modal.cancel')),
          h(Button, {
            variant: 'outline',
            onClick: () => {
              setClosePrompt(false)
              setEditing(false)
              setDirty(false)
              onClose()
            },
          }, t('modal.closeDiscard')),
          h(Button, {
            variant: 'primary',
            disabled: actions.pending,
            onClick: () => {
              void saveAndClose()
            },
          }, t('modal.closeSave')),
        ),
      })

      // 有新版才渲染：已最新 / 查不到 / 通道不通，一个字都不加
      const updateNotice = update === null ? null : h('div', { className: cx(`${NS}-update`) },
        h('div', { className: cx(`${NS}-updateRow`) },
          h('span', null, t('update.found', { latest: update.latest, current: update.current })),
          h('button', {
            type: 'button',
            className: cx(`${NS}-updateMore`),
            onClick: () => setUpdateOpen(value => !value),
          }, updateOpen ? t('update.hide') : t('update.how')),
        ),
        updateOpen && h('ol', { className: cx(`${NS}-updateSteps`) },
          h('li', null, t('update.step1')),
          h('li', null, t('update.step2')),
          h('li', null, t('update.step3')),
        ),
      )

      return h(React.Fragment, null,
        h(Modal, {
          open: true,
          title: t('modal.title'),
          closeLabel: t('modal.close'),
          onClose: guardedClose(requestClose),
          className: cx(`${NS}-dialog`),
          footer,
        },
        updateNotice,
        h('div', { className: cx(`${NS}-layout`) },
        h('div', { className: cx(`${NS}-side`) },
          h(Input, {
            type: 'search',
            placeholder: t('modal.search'),
            'aria-label': t('modal.search'),
            value: search,
            onChange: event => setSearch(event.target.value),
          }),
          h('div', { className: cx(`${NS}-list`), role: 'listbox', 'aria-label': t('modal.title'), 'aria-multiselectable': selectMode ? 'true' : 'false' },
            filtered.length === 0 && h('div', { className: cx(`${NS}-empty`) }, t('modal.noMatch')),
            filtered.map(item => {
              const checked = selectMode && selectedIds.includes(item.id)
              return h('button', {
                key: item.id,
                type: 'button',
                role: 'option',
                'aria-selected': selectMode ? checked : item.id === selectedId,
                className: cx(`${NS}-row`),
                'data-current': !selectMode && item.id === selectedId ? 'true' : 'false',
                'data-selected': checked ? 'true' : 'false',
                onClick: event => pickRow(item.id, event),
              },
              h('span', { className: cx(`${NS}-rowTitle`) }, `${checked ? '✓ ' : ''}${item.name}`),
              h('span', { className: cx(`${NS}-rowDesc`) }, item.description === '' ? t('modal.noDesc') : item.description),
              )
            }),
          ),
          ignored.length > 0 && h('div', {
            className: cx(`${NS}-ignored`),
            title: ignored.map(entry => `${entry.name}（${t(`ig.${entry.reason}`)}）`).join('\n'),
          }, t('modal.ignored', {
            count: ignored.length,
            names: ignored.slice(0, 2).map(entry => entry.name).join('、') + (ignored.length > 2 ? '…' : ''),
          })),
        ),

        h('div', { className: cx(`${NS}-detail`) },
          selectMode
            ? h('div', { className: cx(`${NS}-empty`) }, t('modal.bulkHint'))
            : (selected === null
              ? h('div', { className: cx(`${NS}-empty`) }, t('modal.pickOne'))
              : (editing
              ? [
                h('div', { key: 'title', className: cx(`${NS}-titleRow`) },
                  orderInput,
                  h(Input, {
                    className: cx(`${NS}-titleInput`),
                    'aria-label': t('modal.field.name'),
                    placeholder: t('modal.field.name'),
                    title: t('modal.renameHint'),
                    value: draft?.name ?? selected.name,
                    onChange: event => editField('name', event.target.value),
                  }),
                ),
                h('label', { key: 'description', className: cx(`${NS}-field`) },
                  h('span', { className: cx(`${NS}-fieldLabel`) }, t('modal.field.description')),
                  h(Input, {
                    value: draft?.description ?? selected.description,
                    maxLength: DESCRIPTION_MAX,
                    onChange: event => editField('description', event.target.value),
                  }),
                ),
                h('div', { key: 'body', className: cx(`${NS}-field`), style: { flex: '1 1 auto', minHeight: 0 } },
                  h('span', { className: cx(`${NS}-fieldLabel`) }, t('modal.field.body')),
                  h('textarea', {
                    className: cx(`${NS}-bodyEdit`),
                    value: draft?.body ?? '',
                    placeholder: t('modal.bodyPlaceholder'),
                    onChange: event => editField('body', event.target.value),
                  }),
                ),
              ]
              : [
                h('div', { key: 'title', className: cx(`${NS}-titleRow`) },
                  orderInput,
                  h('h3', { className: cx(`${NS}-readTitle`) }, selected.name),
                ),
                h('p', { key: 'desc', className: cx(`${NS}-readDesc`) }, selected.description === '' ? t('modal.noDesc') : selected.description),
                h('pre', { key: 'body', className: cx(`${NS}-body`) },
                  (draft?.body ?? '').trim() === '' ? t('modal.bodyEmpty') : draft.body),
              ])),
          !selectMode && h('div', { className: cx(`${NS}-meta`) },
            h('span', null, t('modal.chars', { count: selected?.chars ?? 0 })),
            h('span', null, selected?.id ?? ''),
            inUse > 0 && h('span', null, t('modal.inUse', { count: inUse })),
            editing && dirty && h('span', null, t('modal.dirty')),
            note !== null && h('span', null, note),
          ),
          pendingSelect !== null && h('div', { className: cx(`${NS}-field`) },
            h('span', { className: cx(`${NS}-note`) }, t('modal.discard')),
            h('span', null,
              h(Button, { variant: 'outline', onClick: () => setPendingSelect(null) }, t('modal.cancel')),
              ' ',
              h(Button, { variant: 'outline', onClick: discardAndPick }, t('modal.discardYes')),
            ),
          ),
          conflict && h('div', { className: cx(`${NS}-error`) },
            h('span', null, t('modal.conflict')),
            ' ',
            h(Button, {
              variant: 'outline',
              icon: h(IconRefreshOutlineRegular, { size: 14 }),
              onClick: () => {
                void load(selectedId)
              },
            }, t('modal.reload')),
          ),
          actions.error !== null && h('div', { className: cx(`${NS}-error`) }, actions.error),
        ), // -detail
        ), // -layout
        ), // Modal
        confirmClose,
      )
    }

    // ---------------------------------------------------------------- 胶囊

    /**
     * 输入框那行的两个「摘记录」按钮共用这一套状态机。
     *
     * 两段式：第一次点只做试运行（宿主算好范围），按钮变成确认态，
     * 8 秒内再点才真改；超时自动退回去 —— 免得手滑把好好的对话退掉。
     *
     * `mode` 决定切什么：
     *  - `undo`  最后一轮（一个回合，不管里面跑了多少次工具）
     *  - `clean` 历史里夹着的失败回合，单独挖掉，前后对话不动
     */
    function HealButton(props) {
      const { sessionId, t, mode, icon, labelKey, confirmKey, doneKey, emptyKey, failedKey, hintKey } = props
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      // 结果态：「已经干净了，可以直接发」—— 界面上那几行不会消失，不说清楚用户会反复点
      const [outcome, setOutcome] = useState(null)

      // 确认态有时限：不点就自己取消
      useEffect(() => {
        if (preview === null) return undefined
        const timer = setTimeout(() => setPreview(null), 8000)
        return () => clearTimeout(timer)
      }, [preview])

      // 提示 6 秒后自己消失
      useEffect(() => {
        if (note === null) return undefined
        const timer = setTimeout(() => setNote(null), 6000)
        return () => clearTimeout(timer)
      }, [note])

      // 结果态留 20 秒：够看清，又不会一直骗着说"已经干净了"
      useEffect(() => {
        if (outcome === null) return undefined
        const timer = setTimeout(() => setOutcome(null), 20000)
        return () => clearTimeout(timer)
      }, [outcome])

      async function fire(dryRun) {
        setBusy(true)
        try {
          const result = await postApi({ op: 'heal', sessionId, mode, dryRun })
          if (result.ok === false) {
            setPreview(null)
            if (result.empty === true) {
              // 没有可摘的了：这不是错误，是"已经干净"，用结果态说清楚，别再让他点
              setNote(null)
              setOutcome({ kind: 'empty' })
              return null
            }
            setNote(String(result.message ?? '没成功'))
            return null
          }
          return result
        } catch (error) {
          setPreview(null)
          setNote(String(error?.message ?? error))
          return null
        } finally {
          setBusy(false)
        }
      }

      async function onClick() {
        if (busy) return
        setOutcome(null)
        if (preview === null) {
          const previewed = await fire(true)
          if (previewed !== null) setPreview(previewed)
          return
        }
        const done = await fire(false)
        setPreview(null)
        if (done !== null) {
          // 界面上一律按"轮/处"说话，条数只在 tooltip 里出现 —— 用户脑子里没有"节点"这个概念
          setOutcome({
            kind: 'done',
            count: Number(done.turns ?? done.drops ?? 1),
          })
        }
      }

      const confirming = preview !== null
      // 一律按「轮」报数：一轮 = 你发一次 + 模型回应一次，中间跑多少工具都不算多轮
      const count = Number(preview?.turns ?? preview?.drops ?? 0)
      const outcomeLabel = outcome === null
        ? null
        : (outcome.kind === 'empty' ? t(emptyKey) : t(doneKey, { count: outcome.count }))
      // 按钮上永远只放四字短语：出错的完整原因只进 title，悬停才看得到。
      // 否则一条「第 123 条消息被压缩或替换掉了…」会把按钮撑成一条横幅。
      const label = busy
        ? t('undo.busy')
        : (confirming
          ? t(confirmKey)
          : (note !== null
            ? t(failedKey)
            : (outcomeLabel ?? t(labelKey))))

      const detail = confirming
        ? (mode === 'clean'
          ? `${count} 轮失败记录，共 ${Number(preview.removed ?? 0)} 条消息。再点一次执行；8 秒不点自动取消。`
          : `这一轮共 ${Number(preview.removed ?? 0)} 条消息（seq ${preview.fromSeq}–${preview.toSeq}）。再点一次执行；8 秒不点自动取消。`)
        : t(hintKey)

      return h(Button, {
        variant: 'ghost',
        size: 'sm',
        className: cx(`${NS}-trigger`, `${NS}-undo`, confirming && `${NS}-undoConfirm`),
        title: note ?? detail,
        'aria-busy': busy ? 'true' : 'false',
        onClick: () => {
          void onClick()
        },
      },
      h(icon, { size: 12 }),
      h('span', null, label),
      )
    }

    /**
     * 「清理失败」：把失败回合从模型视野里摘掉，前后正常对话原样留着。
     *
     * 只保留这一个按钮。曾经还有个「撤销上一轮」，但那是另一件事
     * （把整轮对话撤掉重发），用户想要那个应该自己分支对话，不该和"修好"混在一起。
     */
    function EnhanceClean(props) {
      return h(HealButton, {
        sessionId: props.sessionId,
        t: props.t,
        mode: 'clean',
        icon: IconTrashOutlineRegular,
        labelKey: 'clean.label',
        confirmKey: 'clean.confirm',
        doneKey: 'clean.done',
        emptyKey: 'clean.empty',
        failedKey: 'clean.failed',
        hintKey: 'clean.hint',
      })
    }

    /**
     * 输入框上方那一行：一个紧凑的触发器 + 宿主的 `Menu` 下拉。
     * 用 `Menu`（而不是自己画的浮层）换来：跟随主题、点外面关闭、Esc 关闭、
     * 自动定位到 body、键盘可达。
     */
    function EnhanceDock(props) {
      const { sessionId, t } = props
      const [open, setOpen] = useState(false)
      const [list, setList] = useState(null)
      const [current, setCurrent] = useState(null)
      const [unavailable, setUnavailable] = useState(false)
      const [managerOpen, setManagerOpen] = useState(false)
      const actions = useAsyncAction()

      const reload = useCallback(async () => {
        try {
          const result = await postApi({ op: 'list', sessionId })
          if (result.ok === false) {
            actions.setError(String(result.message ?? '读不到预设列表'))
            return
          }
          setList(result)
          setCurrent(typeof result.current === 'string' ? result.current : null)
          setUnavailable(false)
        } catch (error) {
          // 通道本身不通（宿主没开路由 / 不是 HTTP 形态）：按设计稿降级
          setUnavailable(true)
          actions.setError(error?.message ?? String(error))
        }
      }, [sessionId])

      useEffect(() => {
        void reload()
      }, [reload])

      const items = list?.items ?? []
      const currentItem = items.find(item => item.id === current) ?? null
      const presetName = unavailable
        ? t('dock.unavailable')
        : (current === null
          ? t('dock.default')
          : (currentItem === null ? t('dock.missing') : currentItem.name))
      // 触发器右侧那一截说明：当前预设的 description；没有预设就说清"正在用默认文案"
      const captionText = unavailable
        ? ''
        : (current === null
          ? t('dock.defaultHint')
          : (currentItem === null ? t('dock.missingHint') : currentItem.description))

      async function choose(id) {
        setOpen(false)
        if (id === current) return
        const result = await actions.run(() => postApi({ op: 'use', sessionId, id }))
        if (result === null) return
        setCurrent(result.id ?? id)
      }

      const anchor = h(Button, {
        variant: 'ghost',
        size: 'sm',
        className: cx(`${NS}-trigger`),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        title: t('dock.hint'),
        onClick: () => setOpen(value => !value),
      },
      h('span', null, t('dock.label', { preset: presetName })),
      h(IconChevronDownOutlineRegular, { size: 12 }),
      )

      return h('div', { className: cx(`${NS}-dockInner`) },
        h(Menu, {
          open,
          onClose: () => setOpen(false),
          align: 'start',
          portal: true,
          autoFocus: true,
          anchor,
          listClassName: cx(`${NS}-menuList`),
        },
        unavailable
          ? h('div', { className: cx(`${NS}-empty`) }, t('dock.channelDown'))
          : [
            items.length === 0 && h('div', { key: 'empty', className: cx(`${NS}-empty`) }, t('dock.empty')),
            items.map(item => h(MenuItemButton, {
              key: item.id,
              current: item.id === current,
              onSelect: () => {
                void choose(item.id)
              },
            },
            h('span', { className: cx(`${NS}-menuCopy`) },
              h('span', { className: cx(`${NS}-menuTitle`) }, item.name),
              item.description !== '' && h('span', { className: cx(`${NS}-menuDesc`) }, item.description),
            ),
            )),
            h(MenuItemButton, {
              key: 'manage',
              icon: h(IconSettingsOutlineMedium, { size: 14 }),
              onSelect: () => {
                setOpen(false)
                setManagerOpen(true)
              },
            }, t('dock.manage', { count: items.length })),
          ],
        ),

        // 只读说明：不接任何点击，长了就省略号（title 里给全文）
        captionText !== '' && h('span', {
          className: cx(`${NS}-caption`),
          title: captionText,
        }, captionText),

        managerOpen && h(PresetManager, {
          sessionId,
          t,
          onClose: () => {
            setManagerOpen(false)
            void reload()
          },
        }),
      )
    }

    // ---------------------------------------------------------------- 注册

    /**
     * 槽位入口：只决定"渲不渲染"，不在这里做请求。
     * 非增强模式会话返回 null，标准模式里看不到任何痕迹。
     */
    function EnhanceDockEntry(props) {
      const preset = useSessionPreset(props)
      const translator = useMemo(() => createTranslator(), [])
      if (preset !== PRESET_ID) return null
      if (typeof props.sessionId !== 'string' || props.sessionId === '') return null
      return h('div', { className: cx(`${NS}-dock`) },
        h(EnhanceDock, { key: 'dock', sessionId: props.sessionId, t: translator }),
        h(EnhanceClean, { key: 'clean', sessionId: props.sessionId, t: translator }),
      )
    }

    return {
      inject: ['slots'],

      /**
       * 客户端插件体。
       * @param {import('@deepseek-ai/cordis').Context} ctx
       */
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined || typeof slots.register !== 'function') {
          console.warn('[enhance-mode] 宿主没有 slots 服务，界面不挂载')
          return
        }

        const disposeStyle = ensureStyle()
        ctx.effect(() => disposeStyle)

        slots.inject('conversation.input.dock', () => slots.register({
          name: 'conversation.input.dock',
          id: 'enhance-mode-preset',
          order: DOCK_ORDER,
        }, EnhanceDockEntry))
      },
    }
  },
})
