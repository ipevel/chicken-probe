# 养鸡探针 · 整体视觉优化方案

主题：`Chicken Farm` v0.4.0 · 日期 2026-09-29 · 作者：苏小画（设计）
配套产物：`docs/icons/sprite.svg`（权威图标源）、`docs/icons-preview.html`（可核对预览页）

---

## 0. 怎么用这份文档

**结论一句话**：把 UI 里的 emoji / Unicode 字形图标换成 23 个 `currentColor` 描边符号（外加 favicon 与 3D 名牌两处特殊处理），
并把面板与鸡场从「两套各写各的颜色」收敛成**一套 token 家族**；面板结构性 token 全新增、不动现有取值，
鸡场的 HUD 玻璃与文字换成实测达标的 `--farm-*` 一层。

**边界**：本文只给规格与设计资产，不改运行时代码。所有文件路径与行号以本次核对的 `v0.4.0` 工作区为准。
第 ⑨ 章是把这份规格落到代码时的最小改动清单。

**已验证 vs 未验证**（先说清楚，免得把规格当成已渲染结果）：

| 内容 | 状态 |
|---|---|
| 23 个符号在 16/20/24/32px × 亮暗两底 × 三语义色的渲染 | **已渲染核对**（headless Chrome 截图逐格看过，同样内容在 `docs/icons-preview.html` 里） |
| favicon 候选在 16/20/32/64px × 亮暗标签栏的渲染 | **已渲染核对** |
| 对比度数值（面板 9 项 + HUD 16 项） | **已按 WCAG 2.1 公式实算**，脚本算的不是估的 |
| `tools/build-theme.mjs` 的打包规则 | **已读脚本原文核对**（`tools/build-theme.mjs:36-113`） |
| 内联后的体积 | **已实测**（原文 + gzip 都算了） |
| 3D 场景调色板 / 名牌版式 / 光照 | **仅规格，未渲染验证**：本轮没有运行 three.js，名牌画布的实际像素结果要在落地后用浏览器核对 |
| 真机上不同平台的 emoji 字形差异 | 未实测；依据是 `theme/js/flags.js:7-9` 已经记录过的同源结论（Windows 的 Segoe UI Emoji 没有国旗字形）+ 字体依赖分析 |

---

## 1. 现状问题总览

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | 图标用 emoji / Unicode 字形 | `theme/index.html` 14 处字形（另 3 处是给纯汉字补图标），`theme/js/*.js` 20 处，`server/room.js` 3 处 | 字形随平台变；尺寸与基线不受控；无法跟随 `currentColor`；彩色 emoji 根本不响应 `color` |
| 2 | favicon 是 emoji 伪装成的 SVG | `theme/index.html:14` 里是 `<text>🐔</text>` | 依赖系统字体；缺字形的环境显示豆腐块 |
| 3 | HUD 全套颜色硬编码 | `theme/style.css:368-460`（`#ffd95e` `#ffe9b0` `#cfe8b0` `#b8e986` `#ff9a8a` `#8b948c`） | 不随 `html.dark`；与面板 token 无任何交集 —— 「两套视觉语言」的根源 |
| 4 | HUD 文字对比度不达 AA（7 项 + KO 横幅 + 飘字） | 实测：数字 3.77–4.16:1、离场名 1.65:1、分数 4.29:1、联机 4.08:1、错误 2.78:1、KO 1.53:1 | 最亮背景（天空 `#a8d8f0`）上数字发灰、离场名读不出、KO 提示看不见 |
| 5 | KO 横幅靠 `text-shadow` 兜底 | `theme/style.css:486-492`；白字叠天空实测 **1.53:1** | `text-shadow` 不是对比度的合规手段 |
| 6 | 全站没有可见焦点样式 | `theme/style.css` 全文搜不到 `:focus` | 键盘用户在 40+ 个可点元素之间无法定位 |
| 7 | 暗色下缺 `--m-*` 覆盖 | `:root` 定义了 `--m-cpu/mem/disk/load`（`style.css:42-45`），`html.dark`（`:48-75`）没覆盖 | 内存紫 `#7a4fa8` 在 `#1c1f24` 上 **2.76:1**，低于非文字 3:1 —— 分段计量条的「信息本体」在暗色下最弱 |
| 8 | 控件边界不可见 | input/select 边框 `#e5e7ea` 对 `#f5f6f7` 只有 **1.15:1** | 白底控件在浅灰页面上只剩 1.06:1 的填充差，控件范围难辨认（WCAG 1.4.11 需 3:1） |
| 9 | 结构尺寸是散落字面量 | 圆角 6/8/9/10/12/14/999 七种；字号 10/11/11.5/12/12.5/13/14/15/17/19 十种 | 同类元素（`.chip` / `.tab` / `.range` 三种「胶囊」）圆角与选中语言各不相同 |
| 10 | 同类控件两种选中语言 | `.chip[aria-selected]` 是反色填充（`style.css:141`），`.viewtoggle button[aria-pressed]` 是 `--accent-soft` 填充（`:156`） | 用户要多学一套「选中长什么样」 |
| 11 | 3D 名牌里塞 emoji | `theme/js/farm.js:458` `:470` 拼 `title` 时带图标 | canvas 里 emoji 走系统字体，各端渲染不同；还占掉名字宽度；canvas 没有 `currentColor` 可继承 |
| 12 | 名牌与面板同一份数据用两组色 | 面板 CPU 绿 `--c-cpu:#5f9e3f`（`style.css:29`）；名牌圆环绿 `#7ec850`（`chicken.js:359`） | 同一台机器在两个界面里颜色不同 |
| 13 | 场景调色板是 16 处裸字面量 | `theme/js/world.js:48-63` | 新增物件时容易挑出跳出色系的颜色，没有「地表/木质/叶片」的语义分组 |
| 14 | 触屏键只有汉字 | `theme/index.html:115-117` 的「啄/跑/跳」 | 与整站「图标 + 文字」的语言不一致（这一处本来就是纯汉字，属于补图标而非替换） |
| 15 | 图标按钮没有可访问名 | `◐` `▦` `☰` `✏️` `✕` `⟳` 是按钮唯一内容 | 读屏按字符名念出来；**换成 SVG 后若不补 `aria-label` 会变成完全无名称 —— 比现在更糟** |

---

## 2. ① 图标体系

### 2.1 现状问题

1. **emoji 当图标**：`🐔` `🌐` `👤` `⚙` `✏️` `😵` `🏆` `🔗` `💥` `🔇` `🔊` —— 字形由系统字体决定（Segoe UI Emoji / Apple Color Emoji / Noto Color Emoji 三套画法都不同），
   观感不受控；彩色 emoji **不响应 `color`**，所以「在线用绿色、告警用橙色」这套语义表达根本落不到图标上。
2. **Unicode 字形当图标**：`◐` `▦` `☰` `←` `✕` `⟳` —— 纯文本字形，宽度与字重随字体变（`▦` 在部分 Linux 字体里是方块），
   也无法统一线宽；它们和旁边的真图标放一起时，视觉重量对不上。
3. **favicon 是 emoji 伪装 SVG**：`theme/index.html:14` 在 `data:image/svg+xml` 里塞 `<text>🐔</text>`。
   表面上是 SVG，实际渲染仍然依赖字体 —— 这台机器有 emoji 字体就有，没有就是豆腐块。这是本轮最值得修的一处。
4. **图标替换不能只改 HTML**：`theme/js/farm.js:229`（榜单行）、`:470`（别人名牌）、`theme/js/main.js:30,32`（游客默认 icon）、
   `server/room.js:148,178`（服务端下发默认 icon）都是**运行时字符串拼接**，HTML 里改不到。必须同时给出 JS 侧契约（见 2.5）。
5. **没有图标尺度**：现有 HTML 里图标没有 `width/height`，尺寸等于字号；emoji 的行高比文字高，把 `.ghost`（`style.css:101-106`）撑得比设计值高。

### 2.2 目标规格

**形状规格（全部 23 个符号已按此渲染核对）**

| 项 | 值 | 理由 |
|---|---|---|
| 网格 | `viewBox="0 0 24 24"` | 24 号网格是描边图标的事实标准，16/20/24/32 四档缩放都落在整数附近 |
| 描边宽 | `1.75` | 1.5 在 16px 下偏细（1px 缩到亚像素）、2 在小尺寸下糊；1.75 在 16px 下是 1.17px、24px 下 1.75px |
| 端点/转角 | `round` / `round` | 与 `.ghost` 的 9px 圆角、`--radius: 12px` 的柔和调性一致 |
| 颜色 | **只用 `currentColor`，图标内不出现任何颜色字面量** | 亮暗两套、面板与鸡场两套配色共用一个 sprite |
| 元素 | **只用 `<path>`，不用 `<circle>/<rect>/<ellipse>/<line>`** | canvas 侧（3D 名牌）能用 `querySelectorAll('symbol#i-x path')` 逐个取 `d` 拼一条 `Path2D`，不必依赖 `SVGGeometryElement.getPathData()`（兼容性至今不齐）。圆形写成两段 `a` 弧 |
| 实心例外 | `i-logo`、`i-hit` 两个，标 `data-mode="fill"` | 品牌标和小尺寸下的鸡头必须实心才清楚；撞击爆点描边化会变成「星星」不是「打中了」 |
| 属性位置 | 5 个表现属性写在**每个 `<symbol>` 自己身上** | 包一层 `<g>` 没用：`<use>` 的 shadow tree 里继承链是「use 元素 + 文档祖先」，**不是** symbol 的祖先 —— 本轮就踩过这个坑（见 2.6） |

**尺寸与语义色映射**

| 用在哪 | 所在字号 | 图标尺寸 | 颜色 token |
|---|---|---|---|
| 11–12.5px 标签、胶囊（`.pill` `.cell .k` `.num .k` `.sub`） | 11–12.5px | **16px** | `--ink-3`（默认）/ `--accent`（在线）/ `--warn`（告警）/ `--danger`（危险） |
| 13–15px 控件（`.ghost` `.chip` `.tab` `.range` `.viewtoggle`、HUD 行） | 13–15px | **20px** | 同上；HUD 里用 `--farm-ink` / `--farm-*` |
| 17px 标题（`.top h1`） | 17px | **20px** | `--ink` |
| 触屏键（`.tc-btn`） | 16–19px | **26px** | `--farm-ink`（键面 60–104px，26px 图标与汉字并排） |

**图标与文字的排版工具**（新增，避免每个组件各写一遍）

```css
:root {
  --icon-gap: 6px;                 /* 图标与文字的间距，统一值 */
}
.i {                                /* 行内图标 */
  width: 1em; height: 1em;          /* 跟随字号，正文里不破坏行高 */
  flex: none;
  vertical-align: -0.125em;         /* 光学基线：让图标视觉中心落在 x-height 中线 */
}
.i-16 { width: 16px; height: 16px; }
.i-20 { width: 20px; height: 20px; }
.i-26 { width: 26px; height: 26px; }
```

图标容器（图标与文字并排的元素）统一 `display:inline-flex; align-items:center; gap:var(--icon-gap)`。

**品牌与整只鸡的分工**（决定小尺寸用哪个，别混用）

- `i-logo`（实心鸡头）＝ **「这是一只鸡 / 这是这个应用」**：favicon、启动页、`h1`、进鸡场按钮、HUD「探针鸡」行、啄倒榜标题、重生提示。
  ≤20px 的地方只用它。
- `i-chicken`（描边整鸡）＝ **「某一只具体的鸡」**：榜单行首（20px）、3D 名牌降级。
  **下限 18px**，更小的地方退回 `i-logo`（腿在 1.75 描边下只有一线宽，16px 时读不出来）。
- 这两处替换与原来 `🐔` 出现的位置是**一对一**的：原来 🐔 同时出现在 HUD 行与榜标题，现在两处都用 `i-logo`，没有引入新的重复。

### 2.3 符号全表

| ID | 名称 | 风格 | 用途（替换对象） |
|---|---|---|---|
| `i-logo` | 品牌鸡头 | 实心 `currentColor`（眼睛用 `evenodd` 挖空，不填背景色） | favicon 同几何 / 🐔 ×5 |
| `i-chicken` | 整只鸡 | 描边 | 榜单行首默认图标、名牌降级 / 🐔 |
| `i-globe` | 网站鸡 | 描边 | 🌐 |
| `i-user` | 访客 | 描边 | 👤 |
| `i-gear` | 管理后台 | 描边 | ⚙ |
| `i-theme` | 亮/暗切换 | 描边 + 左半实心 | ◐ |
| `i-grid` | 网格视图 | 描边 | ▦ |
| `i-list` | 列表视图 | 描边 | ☰ |
| `i-back` | 回面板 | 描边 | ← |
| `i-pencil` | 改名 | 描边 | ✏️ |
| `i-close` | 关闭 | 描边 | ✕ |
| `i-refresh` | 重新读取历史 | 描边 | ⟳ |
| `i-sound-on` | 声音开启 | 描边 | 🔊 |
| `i-sound-off` | 已静音 | 描边 | 🔇 |
| `i-dizzy` | 被啄晕 | 描边 | 😵 ×3 |
| `i-trophy` | 啄倒数 | 描边 | 🏆 |
| `i-link` | 断线重连 | 描边 | 🔗 |
| `i-hit` | 撞击爆点 | 实心 `currentColor` | 💥 |
| `i-peck` | 啄 | 描边 | 触屏「啄」补图标 |
| `i-run` | 疾跑 | 描边 | 触屏「跑」补图标 |
| `i-jump` | 跳 | 描边 | 触屏「跳」补图标 |
| `i-up` | 上行流量 | 描边 | 独立读数前缀（行内的 ↑ 可保留） |
| `i-down` | 下行流量 | 描边 | 独立读数前缀（行内的 ↓ 可保留） |

### 2.4 emoji → 符号 ID 替换映射全表

**A. HTML（`theme/index.html`）**

| 行 | 现在 | 换成 | 尺寸 | 备注 |
|---|---|---|---|---|
| 14 | `data:image/svg+xml` 里 `<text>🐔</text>` | 内联路径版 favicon（见 2.5） | 32 视图 | **去掉 `<text>`**，这是本轮最该修的一处 |
| 31 | `🐔 鸡场加载中…` | `#i-logo` + 文案 | 20 | `#boot` 加 `display:flex; align-items:center; gap:var(--icon-gap)` |
| 36 | `🐔 养鸡探针` | `#i-logo` + `<span id="site-name-text">养鸡探针</span>` | 20 | **必须加 span**：`panel.js:828` 用 `textContent=` 整体覆盖，会把 svg 子节点删掉 |
| 39 | `🐔 进鸡场` | `#i-logo` | 20 | |
| 44 | `⚙ 管理` | `#i-gear` | 20 | |
| 45 | `◐` | `#i-theme` | 20 | 按钮唯一内容 → 补 `aria-label="切换亮色/暗色主题"` |
| 57 | `▦` | `#i-grid` | 20 | 补 `aria-label="网格视图"` |
| 58 | `☰` | `#i-list` | 20 | 补 `aria-label="列表视图"` |
| 74 | `🐔 探针鸡 在线` | `#i-logo` | 16 | HUD 15px（窄屏 12px） |
| 75 | `🌐 网站鸡 在线` | `#i-globe` | 16 | |
| 76 | `👤 访客` | `#i-user` | 16 | |
| 78 | `← 回面板` | `#i-back` | 20 | 有文字，图标 `aria-hidden` |
| 83 | `🐔 啄倒榜` | `#i-logo` + `<span id="board-title-text">啄倒榜</span>` | 16 | **必须加 span**：`farm.js:327-328` 整体覆盖 |
| 92 | `✏️` | `#i-pencil` | 20 | 补 `aria-label="改名字"` |
| 115 | `啄` | `#i-peck` + 保留「啄」 | 26 | 新增图标（原来是纯汉字） |
| 116 | `跑` | `#i-run` + 保留「跑」 | 26 | 同上 |
| 117 | `跳` | `#i-jump` + 保留「跳」 | 26 | 同上 |

**B. JS（运行时字符串拼接，HTML 改不到）**

| 文件:行 | 现在 | 换成 | 尺寸 |
|---|---|---|---|
| `theme/js/panel.js:705` | `'⟳'` | `#i-refresh` | 20（+ `aria-label="重新读取历史"`） |
| `theme/js/panel.js:716` | `'✕'` | `#i-close` | 20（+ `aria-label="关闭详情"`） |
| `theme/js/panel.js:828` | `` `🐔 ${name}` `` 覆盖 `textContent` | 只写 `#site-name-text` | — |
| `theme/js/farm.js:172` | `'🔇 已静音'` / `'🔊 声音开启'` | `#i-sound-off` / `#i-sound-on` + 文案 | 20 |
| `theme/js/farm.js:204` | `` `${icon} ${name}` ``（我的名字行） | `iconEl(iconId, 20)` + 名字 | 20 |
| `theme/js/farm.js:210` | `` `😵 被啄晕了，…` `` | `#i-dizzy` + 文案 | 20 |
| `theme/js/farm.js:211` | `` `🏆 啄倒 ${score} 只鸡` `` | `#i-trophy` + 文案 | 20 |
| `theme/js/farm.js:229` | `` `${r.icon \|\| '🐔'} ${r.name}` `` | `iconIdOf(r.icon)` → `#i-chicken` | 20 |
| `theme/js/farm.js:282` | `'🔗 连接断开，正在重连…'` | `#i-link` + 文案 | 20 |
| `theme/js/farm.js:283` | `'🐔 欢迎回来，战绩已恢复！'` | `#i-logo` + 文案 | 20 |
| `theme/js/farm.js:327-328` | `'🐔 啄倒榜…'` 覆盖 `textContent` | `#i-logo` + `#board-title-text` | 16 |
| `theme/js/farm.js:458` | 名牌 `` `${identityRef.icon} ${identityRef.name}` `` | 改传 `iconId`（见 ⑨ 契约） | 名牌内 18（可选） |
| `theme/js/farm.js:470` | 名牌 `` `${p.icon \|\| '🐔'} ${p.name \|\| '访客'}` `` | 同上 | 名牌内 18（可选） |
| `theme/js/farm.js:611` | `` `💥 你把「${m.toName}」啄倒了` `` | `#i-hit` + 文案 | 20 |
| `theme/js/farm.js:620` | `'😵 你被啄晕了！'` | `#i-dizzy` + 文案 | 28（KO 横幅大字） |
| `theme/js/farm.js:624` | `` `你 🐔💥 啄倒了 ${m.toName}` `` | `#i-chicken` + `#i-hit` + 文案 | 各 20 |
| `theme/js/farm.js:626` | `` `${m.fName} 🐔💥 啄倒了 ${m.toName}` `` | 同上 | 各 20 |
| `theme/js/farm.js:634` | `'🐔 站了起来'` | `#i-logo` + 文案 | 20 |
| `theme/js/main.js:30` | `raw.icon \|\| '🐔'` | `iconIdOf(raw.icon) \|\| 'chicken'` | — |
| `theme/js/main.js:32` | `icon: '🐔'` | `icon: 'chicken'` | — |

**C. 服务端（协议字段仍是字符串）**

| 文件:行 | 现在 | 换成 | 备注 |
|---|---|---|---|
| `server/room.js:46` | 注释「图标只收短字符串（emoji）」 | 注释改成「只收符号名或 1–2 字可见文本」 | 长度上限（`clipped`）不用改，新值 `'chicken'` 只有 7 个字符 |
| `server/room.js:148` | `icon: '🐔'` | `icon: 'chicken'` | 新默认值 |
| `server/room.js:178` | `clipped(m.icon) \|\| '🐔'` | `clipped(m.icon) \|\| 'chicken'` | 老客户端发来的 `'🐔'` 由客户端 `iconIdOf` 兜住，服务端不需要兼容分支 |
| `server/dev.js:178`、`server/index.js:150` | 日志里的 `🐔` | **保留** | 终端日志不是 UI，不进观感范围 |

**D. 明确保留（不替换）**

| 处 | 保留理由 |
|---|---|
| `theme/js/panel.js:345` (`—`)、`:470-472`、`shared/plate.js:37` 行内的 `↑` `↓` | 制表/数学符号，**不是 emoji**，字体覆盖 100%；它们在句子中间（`` ↑${bytes} ↓${bytes} ``），换图标要拆 DOM 结构，收益为零 |
| `theme/js/flag.js` / `flags.js` 的 SVG 国旗 | 已经是 SVG，是本次唯一的既有 SVG 参考，**不推翻**；`mountFlagSprite()` 用 `position:absolute;width:0;height:0;overflow:hidden` 的挂载方式，正好是本次 sprite 内联要照抄的先例 |
| `·` `…` `—` 等标点 | 与图标无关 |
| `chicken.js:111-120` `drawFlag` 的文字角标 | `flag.js:57` 已说明「3D 标签用不了 SVG，退回地区码文本」，这是有意降级 |

### 2.5 sprite 接入方式（这一节是给落地的人看的）

**结论：内联进 `theme/index.html`。**

理由，逐条：

1. **离线可用**：hub 主题是静态包，`theme/index.html` 是入口文档。内联后图标随文档一起来，不新增请求、不存在第二个文件取不到的风险。
2. **`currentColor` 与 CSS 变量能穿透**：外部文件 `<use href="/icons.svg#i-gear">` 在跨文档引用时，
   `color` 不会继承进被引用文档的 shadow tree（各引擎的历史行为差异），
   结果就是「面板里图标是绿的、鸡场里图标是黑的」。同一文档的 `<use>` 没有这个问题。
3. **hub 静态服务路径**：`dist/` 的布局就是站点根，多一个 `/icons.svg` 就多一条路径假设，
   而 `tools/build-theme.mjs` 只按白名单拷贝（`:52-63`），漏拷**不会报错**、只会静默 404。
4. **`docs/` 不在打包范围内**：`build-theme.mjs` 只读 `theme/index.html`、`theme/style.css`、`theme/theme.json`、`theme/js/`、`shared/`、
   `node_modules/three/build`、`THIRD_PARTY_NOTICES.md`（`:36-63`）。所以**图标源放 `docs/` 是安全的**，不会被误打包、也不会撑大 `theme.tar.gz`。

**内联形态**（放在 `<body>` 之后、`#boot` 之前）：

```html
<body>
<!-- 图标 sprite：内联在同一文档里，<use href="#id"> 才拿得到 currentColor。
     用 width/height 0 + overflow:hidden 隐藏，**不要用 display:none** ——
     与 flag.js:20-23 挂国旗 sprite 的方式保持一致。 -->
<svg id="icon-sprite" aria-hidden="true" focusable="false"
     style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>
    <symbol id="i-logo" viewBox="0 0 24 24" ...>…</symbol>
    <!-- 其余 22 个，直接从 docs/icons/sprite.svg 的 <defs> 里原样搬过来 -->
  </defs>
</svg>

<div id="boot">…</div>
```

**使用处**：

```html
<!-- 图标 + 文字（图标必须 aria-hidden，否则读屏会念出图形） -->
<a id="admin-btn" class="ghost" href="/admin" target="_blank" rel="noopener noreferrer">
  <svg class="i i-20" aria-hidden="true" focusable="false"><use href="#i-gear"/></svg>管理
</a>

<!-- 图标是按钮唯一内容：图标 aria-hidden，名称给按钮 -->
<button id="theme-btn" class="ghost icon" type="button"
        title="亮/暗切换" aria-label="切换亮色/暗色主题">
  <svg class="i i-20" aria-hidden="true" focusable="false"><use href="#i-theme"/></svg>
</button>
```

**favicon**（替换 `theme/index.html:14`）：

```html
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='rgb(159,208,138)'/><g transform='translate(2 2) scale(1.16667)' fill='rgb(30,58,22)'><path fill-rule='evenodd' d='M6.4 12.6a6 6 0 1 0 12 0a6 6 0 1 0 -12 0M14.6 11a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'/><path d='M7.7 7.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0'/><path d='M10.2 6.1a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0'/><path d='M13.5 7.1a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0'/><path d='M17.4 11.2L22.4 13.1L17.4 15z'/><path d='M15.3 17.6a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0'/></g></svg>">
```

三处细节说明：

- **图块 + 深色标记**：浅绿圆角图块（`rgb(159,208,138)` = `#9fd08a`，与 `theme-color`、草地同值）保证在白/暗两种标签栏上都看得见；
  标记用的深绿 `#1e3a16` 对图块实测 **7.10:1**。已渲染核对 16/20/32/64px 四档。
- **路径与 `i-logo` 完全同几何**（同一份 `d`，只加了 `translate(2 2) scale(1.16667)`）。
  改 sprite 里 `i-logo` 的路径时，favicon 必须一起改。若 16px 下觉得太挤，把 padding 从 2 收到 1.5（`translate(1.5 1.5) scale(1.2083)`）。
- **颜色用 `rgb()` 不用 `#`**：`data:` URI 里的 `#` 会被当片段标识符截断；用 `rgb()` 写不需要 `%23` 转义，也不依赖浏览器容错。
  现有那行之所以能跑，是因为它根本没有颜色。

**体积（实测）**

测法：`index.html` 的 `</body>` 前插入 sprite 的 `<defs>…</defs>` 整块（不改其他任何字节），
原文用 `Buffer.byteLength` 计字节，gzip 用 zlib level 6（nginx 默认档）。基线 `index.html` = **6,001 B / gzip 2,962 B**。

| 方案 | 插入的 `<defs>` | 原文增量 | gzip 增量 | 内联后 `index.html` |
|---|---|---|---|---|
| A 原样 `<defs>`（含注释）← **推荐** | 10,649 B | +10,650 B | +3,301 B | 6,001 → **16,651 B**（gzip 2,962 → 6,263 B） |
| B 只留 `<symbol>`（去注释与空行） | 8,085 B | +8,086 B | +1,792 B | 6,001 → **14,087 B**（gzip 2,962 → 4,754 B） |
| C B 再压掉标签间空白 | 7,837 B | +7,838 B | +1,786 B | 6,001 → **13,839 B**（gzip 2,962 → 4,748 B） |

三个数别混淆：`sprite.svg` 整个文件是 12,628 B（gzip 4,585 B），其中头部的用法说明注释约 1,979 B 不进内联，
所以方案 A 实际插入 10,649 B。压到 level 9 每档还能再省 1–15 B，忽略即可。

**是否可接受：可以。** 三条对照：

- 打包硬上限是「单文件 ≤ 8MiB、解压 ≤ 64MiB、上传 ≤ 32MiB」（`tools/build-theme.mjs:21-23`）。
  内联后 `index.html` 约 16KB，不到总包 1%；包里真正的大头是 `vendor/three.module.js`（约 2MB）。
- 内联**不增加请求数**。换成外部 `icons.svg` 反而多一次请求，还要等它到齐才有图标。
- gzip 后只多 3.3KB，且这是入口文档，本来就要下载。

推荐 **A（保留注释）**：多花 1.6KB gzip 换回「每处为什么这么画」的说明 —— 注释里记着两条以后一定会用上的坑
（属性必须写在 `<symbol>` 上、`i-theme` 的 sweep 方向）。在意字节数就用 B。

**`tools/build-theme.mjs` 注意点（已读脚本原文）**

1. **4 处字符串替换是最脆弱的一点**（`:45-51`）：

   ```js
   indexHtml
     .replace('href="/style.css"', `href="/style.css?v=${VERSION}"`)
     .replace('src="/js/main.js"', `src="/js/main.js?v=${VERSION}"`)
     .replace('"three": "/vendor/three.module.js"', `"three": "/vendor/three.module.js?v=${VERSION}"`)
     .replace('href="/vendor/three.module.js"', `href="/vendor/three.module.js?v=${VERSION}"`);
   ```

   `String.prototype.replace` 传字符串时**只替换第一处**。所以：
   - 内联的 sprite **绝不能出现** `href="/style.css"`、`src="/js/main.js"`、`"three": "/vendor/three.module.js"`、`href="/vendor/three.module.js"` 这四个字面量，
     否则版本号会被注入到错误的位置，而 `style.css` / `main.js` 拿到的是未加版本号的 URL —— 浏览器缓存不刷新，但构建**不会报错**。
     本次 sprite 里没有任何 `href`/`src` 属性，是安全的；改 sprite 时别往里加 `<image href=...>`。
   - 建议顺手加一个构建期断言（`tools/` 是苏小码的范围，交他决定）：

     ```js
     // build-theme.mjs 里，writeFile(join(DIST,'index.html'), indexHtml) 之后
     for (const token of ['style.css?v=', 'main.js?v=', 'three.module.js?v=']) {
       if (!indexHtml.includes(token)) { console.error(`❌ 版本号没注进 ${token}`); process.exit(1); }
     }
     ```

   > 实测补充：第 4 处 `.replace('href="/vendor/three.module.js"', …)` 在当前 `theme/index.html` 里**匹配不到任何东西**
   > （该字面量出现 0 次 —— `:25` 的 importmap 是 `"three": "/vendor/three.module.js"`，匹配的是第 3 处；
   > `:26-28` 的注释明确写了「刻意不预载 three」，所以没有 modulepreload 链接）。
   > 也就是说这行今天是空转，**不是**在给某个隐藏引用加版本号。别因为「看起来有 4 处」就去 `<head>` 里补一个 `href="/vendor/three.module.js"` —— 那会把按需加载变成首屏下载。
   > 上面断言里只列 3 个 token 也是这个原因。

2. **内联位置不影响打包**：`:51` 只做文本替换后整份写出，插在哪里都会被带上。
3. **文件名不能含空格**（`:90-92`），`docs/` 不参与拷贝，所以放 `docs/` 完全不受影响。
4. **如果以后要把 sprite 挪进 `theme/`**（不推荐，但记录代价）：要同时改三处 ——
   - `build-theme.mjs` 的拷贝白名单里加 `await cp(join(THEME,'icons'), join(DIST,'icons'), { recursive: true })`（`:52-63` 那一组）；
   - `:45-51` 的替换列表要**增加** `/icons/...` 的版本号注入，否则图标文件永远吃缓存；
   - 引用方式会退化成跨文档 `<use>`，上面第 2 条的 `currentColor` 问题立刻回来。
   结论：**放 `docs/` + 内联进 `index.html` 是唯一同时满足离线、变色、不碰构建的形态。**

### 2.6 落地文件与行号

| 文件 | 动作 |
|---|---|
| `theme/index.html` | **在 `:30` 的 `<body>` 之后、`:31` 的 `#boot` 之前**插入 sprite；`:14` favicon；`:31,36,39,44,45,57,58,74,75,76,78,83,92,115,116,117` 换图标 |
| `theme/style.css` | 新增 `--icon-gap` 与 `.i` / `.i-16` / `.i-20` / `.i-26`（放在 `:root` 与 `html.dark` 之后、组件之前） |
| `theme/js/icons.js` | **新增**（见 ⑨ 契约） |
| `shared/icon-name.js` | **新增**：`iconIdOf(raw)` 纯函数别名表 |
| `theme/js/panel.js` | `:705`、`:716`、`:828` |
| `theme/js/farm.js` | `:172,204,210,211,229,238-275,282,283,327,328,458,470,611,620,624,626,634` |
| `theme/js/main.js` | `:30`、`:32` |
| `theme/js/chicken.js` | 名牌画图标与降级（见第 ⑤ 章） |
| `shared/plate.js` | 返回值增加 `iconId`（`:41-48` 的返回对象） |
| `server/room.js` | `:46`（注释）、`:148`、`:178` |

**本轮就踩过、必须写进代码注释的三个坑**

1. **表现属性必须写在 `<symbol>` 上**。第一版把 `fill="none" stroke="currentColor"` 写在 `<svg>` 根上、
   打算靠继承，结果 21 个描边符号全部渲染成**实心黑块**（`i-list` 的 `M…h.01` 零面积子路径直接消失，整行「只有点没有线」）。
   渲染核对才抓到。包一层 `<g>` 也不管用，原因见 2.2 表格最后一行。
2. **`a` 弧的 sweep 方向决定实心半边在哪一侧**：`i-theme` 要复刻 `◐`（U+25D0，**左半黑**），
   上半段弧必须用 `sweep=0`；写成 `sweep=1` 会得到 `◑`。我用三个尺寸（40/64/96px）并排渲染才确认，
   肉眼在小尺寸下看不出差别。这条同样适用于 `i-logo` 的眼睛挖空（必须 `fill-rule="evenodd"`）。
3. **`i-jump` 画了三版才定**，过程值得记下来，因为「补图标」看着最简单、实际最难：
   第一版是向上箭头（想和 `i-up` 复用形状）—— 渲染比对发现 16–24px 下和 `i-up`（上行流量）几乎一样，
   而这两个符号会分别出现在触屏键和面板读数里；
   第二版是「半圆拱 + 悬空底线」，第三版是「抛物线 + 地面线」—— 都渲染成「隧道 / 桥」。
   最终定为**与 `i-peck` 严格镜像的「向上箭头 + 地面线」**（同一段箭杆 5.1→13.3、同一条地面线 y=17.7）。
   理由：啄与跳本身就是一对反动作，形状成对才说得通；`i-up` 没有地面线，因此仍然一眼可分。
   触屏三键（↓啄 / »跑 / ↑跳）在 26px 实际键面上的并排渲染已确认可分辨。

   **教训**：图标越简单越容易「看着对、用着错」。本轮 23 个符号里只有这一个走了三版，
   而发现问题的唯一办法就是**把候选并排渲染出来看**，不是盯着 `d` 字符串推演。

### 2.7 验收标准

1. `grep -rnP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}\x{25A0}-\x{25FF}\x{2190}-\x{21FF}\x{2B00}-\x{2BFF}]" theme shared`
   在 `theme/` 与 `shared/` 下**只剩 `flag.js`/`flags.js` 的说明性注释**，没有作为 UI 输出的 emoji。

   > 别把 `docs/icons/sprite.svg` 也扫进去：那个文件里**故意留了 4 个 emoji**，全部在 HTML 注释里，
   > 作用是记住「这个符号原来是 😵 / 🏆 / 🔗 / 💥」——`sprite.svg:136,144,153,159`。
   > 它们不在任何 `<symbol>` 的绘制内容里（`<text>` 零出现），也不参与打包，属于文档而非字形。
   > 该文件里还有 1 处 `<path` 出现在 `:12` 的说明注释中，所以 `grep -c '<path' sprite.svg` 会比真实路径数多 1 —— **真实路径 67 条**。
2. 打开 `docs/icons-preview.html`：自检行显示「sprite 内 23 个符号，清单 23 个；没有未登记的符号；没有指向不存在符号的项」。
3. 断网（DevTools → Network → Offline）刷新页面，所有图标正常显示 —— 证明没有外部图标文件依赖。
4. 亮暗切换时所有图标颜色跟着变，**没有任何图标保持黑色** —— 证明颜色走的是 `currentColor`。
5. `document.querySelectorAll('button')` 里，凡是没有可见文本的都带可访问名（`aria-label`）。
6. `npm run build:theme` 通过，且 `dist/index.html` 里 `style.css?v=`、`main.js?v=`、`three.module.js?v=` 三个版本号都存在。

---

## 3. ② 监控面板

### 3.1 现状问题

1. **没有焦点样式**：`theme/style.css` 全文没有 `:focus` 规则。面板上可点元素 40+ 个（卡片、胶囊、页签、范围、抽屉按钮），键盘用户按 Tab 时看不到落点。
2. **尺寸没有尺度**：圆角 6/8/9/10/12/14/999，字号 10/11/11.5/12/12.5/13/14/15/17/19 —— 十五个等级里真正需要的不到十个。
3. **同类控件两种选中语言**：`.chip[aria-selected="true"]` 用反色填充（`:141` `background: var(--ink); color: var(--bg)`），
   `.viewtoggle button[aria-pressed="true"]` 用浅绿填充（`:156` `background: var(--accent-soft)`）。
   两处都是「选中」，长得却不一样。
4. **第三层底色来路不正**：`.sstat`（`:299`）用 `color-mix(in srgb, var(--paper) 60%, var(--bg))` 现算一个底色。
   亮色下它比 `--paper` 暗一点点，暗色下比 `--paper` 亮一点点，**卡片层次在亮暗两套里方向相反**。
5. **控件边界看不见**：`input[type=search]` / `select` 的边框 `--line #e5e7ea` 对 `#f5f6f7` 只有 1.15:1（WCAG 1.4.11 需 3:1）。
6. **暗色下计量条最弱**：`--m-mem #7a4fa8` 在暗色卡片上 2.76:1。
7. **emoji 把控件撑高**：`.ghost` 的 padding 是按 14px 文字算的，🐔 的行高比文字高，实际高度不受控。

**必须保留的既有设计（不推翻）**

- **分段计量条 `.seg`**（`:214-229`）：16 格可数 + 颜色只表指标身份、越线才切 `warn`/`danger`。
  这是色盲可用性设计（不依赖颜色区分状态），**原样保留**，本轮只补暗色的指标色。
- **亮暗两套变量同处定义**（`:5-75`），组件里不写死颜色。
- **安全区** `env(safe-area-inset-*)`（`:351-356`、`:618-623`）。
- **窄屏去掉 `backdrop-filter`**（`:563-565`）、`prefers-reduced-motion`（`:626-628`）。
- **窄屏提高点击区而不动字号**（`:606-613`）。

### 3.2 目标规格

**（1）结构性 token 层（全新增，不改现有取值）**

```css
:root {
  /* 圆角：7 档归 4 档。--radius 保留为 12px，其余落到 --r-sm/--r-xs */
  --r-xs: 6px;    /* 徽标、小角标、.sstat */
  --r-sm: 9px;    /* 按钮、输入、胶囊段（原 8/9/10 → 9） */
  --r-md: 12px;   /* 卡片、抽屉、浮层（= 现有 --radius） */
  --r-pill: 999px;

  /* 间距：4 的倍数，6 作特例保留（现有 gap:6px 用得很多） */
  --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;  --sp-4: 12px;  --sp-5: 16px;  --sp-6: 20px;

  /* 字号：10 档归 8 档。11.5 → 12，12.5 → 13 */
  --fs-10: 10px;  --fs-11: 11px;  --fs-12: 12px;  --fs-13: 13px;
  --fs-14: 14px;  --fs-15: 15px;  --fs-17: 17px;  --fs-19: 19px;

  /* 字重只用三档 */
  --fw-n: 400;  --fw-m: 500;  --fw-b: 600;

  /* 动效：三档时长 + 一条曲线 */
  --dur-1: .12s;  --dur-2: .18s;  --dur-3: .25s;
  --ease: cubic-bezier(.22, .61, .36, 1);

  /* 图标尺度与间距 */
  --ic-16: 16px;  --ic-20: 20px;  --ic-26: 26px;
  --icon-gap: 6px;

  /* 浮动层阴影（现有 --shadow 是卡片级；抽屉/浮层要更深一层） */
  --shadow-2: 0 2px 6px rgba(20,22,26,.08), 0 14px 40px rgba(20,22,26,.14);

  /* 焦点环：双层。内层用 --paper 把环与元素本身隔开，外层必须 ≥3:1 */
  --focus-w: 2px;
  --focus: 0 0 0 var(--focus-w) var(--paper), 0 0 0 calc(var(--focus-w) * 2) var(--accent);
}
html.dark {
  --shadow-2: 0 2px 6px rgba(0,0,0,.5), 0 14px 40px rgba(0,0,0,.45);
  /* --focus 不用重写：里面的 var(--paper)/var(--accent) 会用暗色那套值 */
}
```

焦点环颜色复核（因为 `var()` 是惰性求值，一套定义吃两套主题）：

| 组合 | 对比度 | 要求 |
|---|---|---|
| `--accent #4a7a37` on `--paper #ffffff`（亮·卡片内） | **5.08:1** | ≥3:1 ✅ |
| `--accent #4a7a37` on `--bg #f5f6f7`（亮·页面底） | **4.70:1** | ≥3:1 ✅ |
| `--accent #9fd08a` on `--paper #1c1f24`（暗·卡片内） | **9.34:1** | ≥3:1 ✅ |
| `--accent #9fd08a` on `--bg #14161a`（暗·页面底） | **10.23:1** | ≥3:1 ✅ |

> 反面示例：**不能用 `--accent-fill #6aa84f` 做焦点环** —— 对白底只有 2.87:1，不达 3:1。
> 这也解释了 `:root` 当初为什么要把文字色和填充色拆成 `--accent` / `--accent-fill` 两个变量。

**（2）补两个语义别名（新增，不动旧名）**

```css
:root {
  --accent-on-soft: #44702f;      /* 文字压在 --accent-soft 上时用（实测 5.12:1） */
  --surface-2: #fafbfc;           /* 二级底色，替换 .sstat 的 color-mix 现算 */
  --line-control: var(--line-2);  /* 控件边界，暂用 --line-2；真要 3:1 见第 ⑩ 章未决项 */
}
html.dark {
  --accent-on-soft: var(--accent);
  --surface-2: #22262c;
}
```

> 为什么需要 `--accent-on-soft`：`--accent #4a7a37` 压在 `--accent-soft #eaf3e4` 上只有 **4.46:1**，差一点点不过 AA。
> 现有组件恰好没有这种组合（`.ghost:hover`、`.viewtoggle[aria-pressed]` 用的都是 `--ink`），
> 但这个坑迟早会踩到，先把安全值备好。

**（3）控件尺寸（实测现有值 → 目标值）**

| 控件 | 现有高度 | 目标 | 依据 |
|---|---|---|---|
| `.ghost`（管理/进鸡场） | ~35px | **36px**（padding 7px 12px） | 桌面够用，触屏在 `:610` 已提到 39px |
| `.ghost.icon`（纯图标按钮） | ~33px | **36px**，且宽 ≥36px | 图标 20px + padding 8px |
| `.chip` | ~27px | **28px**（padding 5px 11px） | WCAG 2.5.8 下限 24px ✅ |
| `.viewtoggle button` | ~31px | **32px** | 同上 |
| `.tab` / `.range` | ~29px | **30px** | 同上 |
| `#me-edit` | ~25px | **32px**（padding 5px 9px） | 原来是下限边缘，触屏上太小 |
| `.tc-btn` | 60–104px | 保持 | 已经远超建议值 ✅ |

**（4）卡片区微调（只动密度，不动结构）**

| 项 | 现在 | 目标 |
|---|---|---|
| `.card` padding | `12px 13px 10px`（`:167`） | `12px 14px 11px` |
| `.grid` 最小列宽 | `minmax(252px, 1fr)`（`:158`） | `minmax(260px, 1fr)` |
| `.nums` gap | `8px 14px`（`:202`） | `8px 16px` |
| `.card-mid` gap | `7px`（`:237`） | `8px` |
| `.summary` gap | `10px`（`:121`） | `12px` |
| `.sstat` 底色 | `color-mix(...)` 现算（`:299`） | `var(--surface-2)` |
| `.sstat` 圆角 | `8px`（`:299`） | `var(--r-xs)`（6px） |
| `.card` / `.cell` 圆角 | `var(--radius)` | 保持 `--r-md` |
| `.pill` / `.chip` / `.conn` 圆角 | `999px` | `var(--r-pill)` |
| `.tab` / `.range` / `.chart-readout` 圆角 | `8px` | `var(--r-sm)`（9px） |
| `.drawer` / `.chart-readout` 阴影 | 硬编码 `-8px 0 30px rgba(0,0,0,.12)` / `var(--shadow)` | `var(--shadow-2)` |

**（5）选中语言统一**

把 `.viewtoggle button[aria-pressed="true"]` 从浅绿填充改成与 `.chip` 一致的**反色填充**：

```css
.viewtoggle button[aria-pressed="true"] {
  background: var(--ink); color: var(--bg); border-color: var(--ink);
}
```

反色填充对比度：`--bg #f5f6f7` on `--ink #16181c` = **16.43:1**；暗色 `#14161a` on `#eceef1` = **15.58:1** ✅。
理由：选中态是「状态」，不是「强调」，用反色表达不容易和 `.conn.live` 的绿色语义撞车；
而且亮暗两套里反色天然成立，不用为暗色再挑一次颜色。

**（6）暗色计量条补齐（缺陷修复，不是审美调整）**

```css
html.dark {
  --m-cpu: #6fb3e8;   /* 暗色卡片上 7.31:1 */
  --m-mem: #b18fdc;   /* 6.16:1（原来是 2.76:1） */
  --m-disk: #bfa189;  /* 6.83:1 */
  --m-load: #e08fb0;  /* 6.87:1 */
}
```

取值直接沿用 `--c-*` 的暗色档色相（`:66-74`），保证「同一指标在图表和计量条上同色」。

### 3.3 落地文件与行号

| 文件 | 行 | 动作 |
|---|---|---|
| `theme/style.css` | `:46` 之后 | 新增结构性 token 与 `--focus`、`--surface-2`、`--accent-on-soft`、`--icon-gap` |
| | `:64` 之后（`html.dark` 内） | 新增 `--shadow-2`、`--surface-2`、`--accent-on-soft`、`--m-cpu/mem/disk/load` 四条覆盖 |
| | `:99` 之后 | 新增全局 `:focus-visible` 规则块 |
| | `:101-106` `.ghost` | padding `6px 11px` → `7px 12px`；`.ghost.icon` padding `6px 9px` → `7px 10px` + `min-width:36px` |
| | `:121` `.summary` | gap 10px → 12px |
| | `:136-142` `.chip` | padding `4px 11px` → `5px 11px`；圆角 → `var(--r-pill)` |
| | `:144-147` 控件 | 圆角 9px → `var(--r-sm)`；边框 → `var(--line-control)` |
| | `:149-156` `.viewtoggle` | 圆角 → `var(--r-sm)`；`:156` 选中态改反色填充 |
| | `:158` `.grid` | 252px → 260px |
| | `:165-179` `.card` | padding；圆角 → `var(--r-md)` |
| | `:191-197` `.pill` | 圆角 → `var(--r-pill)` |
| | `:202` `.nums` | gap `8px 14px` → `8px 16px` |
| | `:214-229` `.seg` | **不动**（保留 16 格与身份色机制） |
| | `:237` `.card-mid` | gap 7px → 8px |
| | `:267` `.drawer` | 阴影 → `var(--shadow-2)` |
| | `:290-295` `.tab/.range` | 圆角 8px → `var(--r-sm)`；padding `4px 11px` → `5px 11px` |
| | `:299-304` `.sstat` | 底色 → `var(--surface-2)`；圆角 8px → `var(--r-xs)` |
| | `:317-326` `.chart-readout` | 圆角 8px → `var(--r-sm)`；阴影 → `var(--shadow-2)` |
| `theme/js/panel.js` | `:705` `:716` `:828` | 见 2.4-B |

### 3.4 验收标准

1. Tab 走一遍面板：每个可点元素都有可见焦点环，环在亮暗两套下都看得见（`--accent` 环 ≥4.7:1）。
2. 亮暗切换后卡片层次方向一致：卡片比页面亮一档，`.sstat` 比卡片再差一档 —— 不再出现亮暗相反的层次。
3. `.viewtoggle` 的选中态与 `.chip` 的选中态是同一套语言（反色填充）。
4. 暗色下 `.seg.mem` 已填格与卡片底的对比度 ≥3:1（现值 2.76:1）。
5. 桌面 1280px 下第一屏能看到的节点卡数量不减少（列宽 252→260 不应导致少一列；如少一列就把 `--sp` 调回 252）。
6. `prefers-reduced-motion: reduce` 下无动画（`:626-628` 保留生效）。

---

## 4. ③ 鸡场 HUD

### 4.1 现状问题

1. **颜色全是硬编码**（`theme/style.css:368-460`）：`#ffd95e` `#ffe9b0` `#cfe8b0` `#b8e986` `#ff9a8a` `#8b948c`，
   以及五种不透明度的深绿玻璃 `rgba(20,30,15,.55/.45/.65/.42/.48)`。不随 `html.dark`，与面板 token 零交集。
2. **对比度实测不达 AA 的有 7 项**（HUD 是半透明玻璃，字色对比度取决于背后是什么，所以按最亮的两种背景算：
   天空 `#a8d8f0` = `world.js:8` 的 `SKY`，草地 `#9fd08a` = `.farm` 与 iOS 回弹露出的底色）：

   | 元素 | 现值 | 玻璃 .55 叠天空 | 玻璃 .55 叠草地 |
   |---|---|---|---|
   | 数字/榜标题 `#ffd95e` | `:375` `:405` | **3.77:1** ❌ | **4.16:1** ❌ |
   | 事件流 `#ffe9b0` | `:420` | 4.31:1 ❌ | 4.76:1 |
   | 分数 `#cfe8b0` | `:460` | 3.89:1 ❌ | **4.29:1** ❌ |
   | 联机徽标 `#b8e986` | `:393` | 3.70:1 ❌ | **4.08:1** ❌ |
   | 错误徽标 `#ff9a8a` | `:395` | 2.52:1 ❌ | **2.78:1** ❌ |
   | 离场名 `#8b948c` | `:410` | **1.65:1** ❌ | **1.82:1** ❌ |
   | 提示条白字 `.85` | `:465` | 4.02:1 ❌ | 4.46:1 ❌ |

   （HUD 主字号 15px 粗体、副字号 12–13px，**都不构成 WCAG 的「大字」**，必须按 4.5:1 要求。）
3. **KO 横幅最严重**：`#ko-banner`（`:486-492`）是白字 30px 直接压在场景上，叠天空实测 **1.53:1**。
   它是「你被啄晕了」的唯一提示，却恰恰在最亮的背景（天空）上最看不见；现有实现靠 `text-shadow` 兜底，而 `text-shadow` 不是合规手段。
4. **玻璃不透明度没有尺度**：深绿玻璃有 `.42 / .45 / .48 / .55 / .65` 五个值，散落在 `.hint`、`.tc-btn`、`#board`、`.feed-item` 里；
   另外键面还有暖色 `rgba(180,70,40,.48)` 与绿色 `rgba(126,200,80,.62)` 两处特例。
5. **`#board-rows .row .sc` 用 `opacity: .8` 压暗**（`:412`）：等于把对比度交给背景决定，改不动、也量不准。
6. **触屏键没有图标**（`:115-117`），与整站语言不一致。

**必须保留（不推翻）**

- **HUD 整层不吃指针**（`:358-360` `#hud { pointer-events: none }`），只有 `#back-btn`/`#board`/`#me`/`#room-state` 自己开 —— 空白处拖动转视角靠它。
- **安全区** `--sa-t/r/b/l`（`:351-356`）与所有 `calc(12px + var(--sa-t))`。
- **窄屏去掉 `backdrop-filter`**（`:563-565`）—— 低端安卓的合成器热点，这一档一律不模糊。
- **横屏矮屏压缩**（`:543-561`）、`@media (hover:none)`（`:593-595`）。
- **摇杆头不加 transition**（`:512` 有注释：要跟手，补间会让它飘）。
- **命中飘字只做位移 + 淡出、不做缩放**（`:475` 与 `:549` 有注释）：省一次合成。这条性能取舍别顺手改。

### 4.2 目标规格

**（1）鸡场 token 层（`--farm-*`，新增；取值全部按最亮背景实算过）**

```css
:root {
  --farm-grass: #9fd08a;          /* 草地 / 回弹露出的底色（原来硬编码在 :340 与 :346） */
  --farm-sky: #a8d8f0;            /* 与 world.js:8 的 SKY 同值，只作文档用，CSS 里不直接用 */

  /* 玻璃三层。基准色 #121c0e 比原来的 #141e0f 略深、略偏绿，与草绿同色相家族 */
  --farm-haze:        rgba(18, 28, 14, .62);   /* 卡片级：hud-stats / board / me / room-state / hint / 飘字 */
  --farm-haze-strong: rgba(14, 22, 10, .80);   /* 药丸级：KO 横幅、事件流、改名浮层 */

  /* 文字八档。实测取「叠天空」与「叠草地」里较差的那个值 */
  --farm-ink:       #ffffff;   /* 6.43:1 / 6.96:1 */
  --farm-ink-dim:   #dbe4d5;   /* 4.92:1 / 5.33:1 */
  --farm-accent:    #ffe27a;   /* 5.02:1 / 5.44:1  数字、榜标题、我的行 */
  --farm-good:      #c0eb96;   /* 4.76:1 / 5.16:1  联机中、在线 */
  --farm-warn:      #ffd98a;   /* 4.76:1 / 5.15:1  重连中、告警 */
  --farm-bad:       #ffd4ca;   /* 4.75:1 / 5.15:1  错误、断开 */
  --farm-off:       #d6ded1;   /* 4.66:1 / 5.05:1  离场灰显 */
  --farm-score:     #d7ecc0;   /* 5.09:1 / 5.52:1  分数行、事件流 */
}
html.dark .farm {
  /* 场景本身不随亮暗切换（3D 世界有自己的光照），只把玻璃再压深一档，
     让习惯暗色的用户少一点界面亮度 */
  --farm-haze: rgba(12, 20, 9, .68);
}
```

**取值过程留痕**（便于复核）：玻璃 `rgba(18,28,14,.62)` 叠天空得 `#4b6364`、叠草地得 `#48603d`；
上面八档是**在这两个合成色上同时 ≥4.5:1** 的最小改动解，全表见第 ⑧ 章。

**为什么选「把玻璃加深」而不是「把文字提亮」**：`#ff9a8a` 这类错误色在 `.55` 下即使调到白色也才 3.7:1 ——
背景不够深时，靠文字救不回来。同一个动作（`.55 → .62`）把八档文字一起抬进了合格区。

**为什么没有「最淡的第四层玻璃」**：设计初稿有一档 `.45` 的 `--farm-haze-soft`，给 `.hint` 与命中飘字用。
实算否掉了它：`.45` 玻璃叠天空上，改后的 `--farm-ink-dim` 只有 **3.07:1**、纯白也只 **3.40:1**，
比现状 `.85` 白的 3.40/3.72 **没有任何改善**。所以两处都改用 `.62`：
`.hint` 用 `--farm-haze` + `--farm-ink-dim`（4.92:1）、飘字用 `--farm-haze` + `--farm-score`（5.09:1）。
**不保留一个只能做出不达标的档位** —— 六种透明度收敛成两种，这也是本轮的收敛目标之一。

**（2）玻璃、圆角、间距、字号统一**

| 元素 | 玻璃 | 圆角 | 内边距 | 字号 |
|---|---|---|---|---|
| `.hud-stats`（`:368-375`） | `--farm-haze` | `--r-md` 12px（原 10px） | `9px 14px` | 15px 粗体（窄屏 12px 保留） |
| `#back-btn`（`:378-385`） | `--farm-haze` | `--r-md` | `6px 13px` | 13px 粗体 |
| `#room-state`（`:386-395`） | `--farm-haze` | `--r-pill` | `4px 11px` | 12px |
| `#board`（`:398-404`） | `--farm-haze` | `--r-md` | `10px 14px` | 13px |
| `#me`（`:427-431`） | `--farm-haze` | `--r-md` | `10px 14px` | 名字 14px 粗体 / 分数 12px |
| `#me-name-editor`（`:442-447`） | `--farm-haze-strong` | `--r-md` | `10px` | 13px |
| `.feed-item`（`:419-423`） | `--farm-haze-strong` | `--r-pill` | `6px 14px` | 13px |
| `.hint`（`:463-468`） | `--farm-haze` | `--r-pill` | `6px 14px` | 12px（原 13px；触屏 `:472` 的 11px → 12px） |
| `#ko-banner`（`:486-492`） | **新增** `--farm-haze-strong` + 药丸 | `--r-md` | `10px 22px` | 28px 粗体（原 30px） |
| `.dmg-pop`（`:476-485`） | **新增** `--farm-haze` + 药丸 | `--r-pill` | `2px 8px` | 16px 粗体（原样） |
| `.tc-btn`（`:525-541`） | `--farm-haze`（啄键用 `rgba(180,70,40,.48)` 的暖色版本，保留） | 圆（保持） | — | 图标 26px + 汉字 16px |

**（3）文字色映射（把硬编码逐个换成 token）**

| 行 | 现在 | 换成 |
|---|---|---|
| `:375` `#online, #web-online, #visitors` | `#ffd95e` | `var(--farm-accent)` |
| `:393` `#room-state.live` | `#b8e986` | `var(--farm-good)` |
| `:394` `#room-state.connecting/reconnecting/polling` | `#ffd95e` | `var(--farm-warn)` |
| `:395` `#room-state.error/closed/off` | `#ff9a8a` | `var(--farm-bad)` |
| `:405` `#board h3` | `#ffd95e` | `var(--farm-accent)` |
| `:409` `#board-rows .row.me` | `#ffd95e` | `var(--farm-accent)` |
| `:410` `#board-rows .row.off` | `#8b948c` | `var(--farm-off)` |
| `:412` `.row .sc { opacity: .8 }` | opacity 压暗 | `color: var(--farm-ink-dim)` 且**删掉 opacity** |
| `:420` `.feed-item` | `#ffe9b0` | `var(--farm-score)` |
| `:460` `#score` | `#cfe8b0` | `var(--farm-score)` |
| `:465` `.hint` | `rgba(255,255,255,.85)` | `color: var(--farm-ink-dim)`（**去掉 .85 透明度**） |
| `:360` `#hud` | `color: #fff` | `color: var(--farm-ink)` |
| `:478`/`:552`/`:574` `.dmg-pop` | `#ffe9b0` | `var(--farm-score)` |

**（4）KO 横幅与飘字加药丸底衬**

```css
#ko-banner {
  display: flex; align-items: center; justify-content: center; gap: var(--icon-gap);
  background: var(--farm-haze-strong);        /* 新增：白字对天空 1.53 → 6.43:1 */
  border-radius: var(--r-md);
  padding: 10px 22px;
  /* 窄屏由 :582 压到 22px、由 :560 压到 24px，保留这两处 */
}
```

`#ko-banner` 现在要能装图标（`farm.js:620` 的 `😵` → `#i-dizzy`），所以必须变成 flex 容器；
`left:0; right:0` 的定位方式保留，居中由 flex 承担，原有 `text-align:center` 可以留着不影响。

**（5）动效**

```css
.feed-item { animation: pop var(--dur-3) var(--ease); }   /* 原 .25s ease-out */
#ko-banner { transition: opacity .2s var(--ease); }       /* 原 .2s */
#hpfill    { transition: width .15s linear; }             /* 原 .15s：血条要跟手，linear 比默认曲线更准 */
.tc-btn    { transition: transform .08s, background var(--dur-1); }
```

`prefers-reduced-motion` 的全局关闭（`:626-628`）保持生效。

### 4.3 落地文件与行号

`theme/style.css`：`:340` 与 `:346` 的 `#9fd08a` → `var(--farm-grass)`；
`:360`、`:368-395`、`:398-412`、`:419-423`、`:427-460`、`:463-472`、`:476-492`、`:499-541`（触屏键）、
`:543-561`（矮屏）、`:563-588`（窄屏）；`html.dark` 块之后追加 `html.dark .farm` 一段。

`theme/index.html`：`:71-106`（HUD 结构）、`:109-119`（触屏键）、`:122`（KO 横幅）。

### 4.4 验收标准

1. 进鸡场，把视角转向天空（抬头），读 `#online` / `#board h3` / `#me-name` / `#score` ——
   全部能读清；用取色器取玻璃实际合成色后用对比度工具核，每项 ≥4.5:1。
2. 断网触发 `#room-state.reconnecting` 是 `--farm-warn`；伪造 error 态是 `--farm-bad` —— 两者可区分且都达标。
3. 榜单里有一个离场玩家时，他的名字（`--farm-off`）在天空与草地两种背景下都能读出。
4. 故意被啄倒：KO 横幅是一块深色药丸，白字压在任何背景上都清楚（不再依赖 `text-shadow`）。
5. 空白处拖动仍然能转视角（`pointer-events` 分层没被破坏）；窄屏（<560px）下 HUD 仍然不带模糊。
6. 触屏三键显示「图标 + 汉字」，分别为 `#i-peck` / `#i-run` / `#i-jump`，三者一眼可分。

---

## 5. ④ 3D 场景与名牌

> 本章**只出规格，不含渲染验证**：本轮没有运行 three.js。以下数值需要落地后在浏览器里对照最终观感微调。

### 5.1 现状问题

1. **调色板是 16 处裸字面量**（`theme/js/world.js:48-63`）：`fence #9a6a3a`、`coopWall #b5553d`、`coopTrim #f0e6d0`、`leaf #4e8f3a`、`rock #9a9a92`……
   没有「地表 / 土壤 / 木质 / 叶片 / 石材 / 水 / 干草」的语义分组，新增物件时凭感觉挑色，容易挑出跳出色系的颜色。
2. **天空与页面底色不是一个色系**：`world.js:8` 的 `SKY = 0xa8d8f0`（浅蓝）与 `style.css:340` `.farm { background: #9fd08a }`（草绿）。
   iOS 回弹时露出来的是绿、场景里是蓝，两种色相直接相接。
   注：`scene.background` 与 `scene.fog` 用同一个 `SKY` 是**刻意的**（`world.js:140` 注释：场地边缘和远山正好溶进天里），**不要改**。
3. **名牌标题里塞 emoji**（`farm.js:458` `:470`）：canvas 里的 emoji 走系统字体，各端渲染不同，而且抢名字的宽度。
4. **同一份数据两组颜色**：面板 CPU 绿 `--c-cpu #5f9e3f`（`style.css:29`）/ 名牌圆环绿 `#7ec850`（`chicken.js:359`）；
   面板告警橙 `--warn-fill #d98f2b`（`style.css:22`）/ 名牌血条中段 `#e8b23a`（`chicken.js:350`）。
5. **名牌底色与 HUD 玻璃同值不同源**：`chicken.js:311` 的 `rgba(15,25,10,0.55)` 与 `style.css` 的 `rgba(20,30,15,.55)` 是两处各写一遍，调一处另一处不会跟着变。
6. **命中飘字没有底衬**（`:476-485`）：`#ffe9b0` 直接压在场景上，对天空实测 1.28:1。

### 5.2 目标规格：场景调色板（语义分组 + 明度纪律）

**保留 `world.js:48-63` 的全部现有色值**（它们是照参考站抄的，推翻等于换一个场子），只做两件事：
**分组命名** + **定一条明度纪律**（每组色相不同，但相对草地的明度关系固定，新物件按纪律取色）。

| 组 | 现有值 | 语义 | 纪律 |
|---|---|---|---|
| 地表 | `grass 0x6da33f`、`hill 0x6f9e4b` | 草地、土丘 | 与 `.farm` 底色 `#9fd08a` 同色相、低一档明度；草地永远是最亮的地表 |
| 土壤/木构 | `fence 0x9a6a3a`、`fenceTop 0x7a5230`、`trunk 0x7a5230` | 围栏、树干 | 中明度暖棕；同一材质别用两个色相 |
| 建筑 | `coopWall 0xb5553d`、`coopRoof 0x6b4a3a`、`coopDoor 0x3a2a20`、`coopTrim 0xf0e6d0` | 鸡舍 | 墙面是全场最暖的一块，用来把视线引到鸡舍；`coopTrim` 是唯一高明度白 |
| 叶片 | `leaf 0x4e8f3a`、`leaf2 0x5da344` | 树冠（两档） | 比草地深一档；两档之差固定，别再加第三档 |
| 石材 | `rock 0x9a9a92` | 石头 | 唯一的无彩色，明度接近草地，不抢眼 |
| 水 | `water 0x5aa7d6` | 水槽 | 全场唯一的冷色，别复制到别处 |
| 干草 | `hay 0xd8b95a` | 草料 | 高明度暖黄，与 `--farm-accent #ffe27a` 同族 —— 场景与 HUD 之间唯一的呼应点，别丢掉 |
| 鸡 | `ORANGE 0xd98a2b`、`RED 0xc93434`、`EYE 0x1a1a1a`、`PALETTES`（`chicken.js:15-26`） | 鸡本体 | **不动**：喙/冠固定色是参考站的规矩，毛色按 id 推导保证各端一致 |
| 天空/雾 | `SKY 0xa8d8f0` | 背景 + 雾 | **不动**，两者必须同值 |

**光照（`world.js:145-157`）：保持现值，只补一档低配方案**

| 光源 | 现值 | 调整 |
|---|---|---|
| `HemisphereLight(0xcfe6ff, 0x8a9a5a, 0.95)` | 0.95 | 保留；`lowPower` 时提到 **1.05**（补回阴影质量下降损失的环境感） |
| `DirectionalLight(0xfff2d8, 1.6)` pos `(24,34,12)` | 1.6 | 保留；`lowPower` 时降到 **1.45**（PCFShadowMap 比 PCFSoftShadowMap 更「硬」，降一点太阳强度让阴影边界不那么锐） |
| `shadow.bias -0.0004`、`mapSize 1024/2048`、视锥 ±34、`far 90` | — | **不动**：这是调过的值，动它容易回到阴影痤疮 |
| `renderer.outputColorSpace` / `shadowMap.type` | — | **不动** |

可选时刻档（只在真需要「黄昏 / 阴天」观感时启用，默认不启用，避免无谓改动）：

| 档 | hemi | sun 颜色/强度 | 雾 |
|---|---|---|---|
| 正午（默认 = 现值） | `0xcfe6ff/0x8a9a5a` 0.95 | `0xfff2d8` 1.6 | `SKY` 45–110 |
| 黄昏 | `0xffd9b0/0x6a5a3a` 0.9 | `0xffb877` 1.35 | `0xe8b98a` 40–120 |
| 阴天 | `0xdfe8f0/0x7a8a6a` 1.15 | `0xdcdcd2` 0.85 | `0xc8d4dc` 35–100 |

地面贴图 `groundTexture()`（`world.js:21-40`）与实例化草叶（`:211`）的配色不动，只把「草叶色」并入「叶片」组的纪律（比草地深一档）。

### 5.3 名牌规格（`shared/plate.js` + `theme/js/chicken.js:31-39`）

**版式收敛成一张表**（四套的画布与缩放**不动**，只把字号/血条/图标的规则写清楚，让以后能查）：

| 版式 | 画布 w×h | sprite 缩放 sx,sy | y | 标题字号 | 副行字号 | 血条 高 / 圆角 / y | 标题基线 | 副行基线 | 旗帜 w×h |
|---|---|---|---|---|---|---|---|---|---|
| `player` | 256×76 | 1.5, 0.45 | 1.16 | 21 | 13 | 9 / h÷2 / 60 | 30 | 52 | 30×20 |
| `probe` | 380×170 | 2.9, 1.3 | 1.45 | 22 | 14 | 7 / h÷2 / 140 | 56 | 90 | 34×24 |
| `web` | 280×110 | 2.2, 0.86 | 1.3 | 21 | 14 | 8 / h÷2 / 82 | 38 | 62 | 30×20 |
| `offline` | 260×76 | 2.0, 0.58 | 0.85 | 22 | 13 | 9 / h÷2 / 60 | 32 | 54 | 30×20 |

规则（把散在代码里的隐含约定写出来）：

- 血条恒为 `x=14`、宽 `W-28`、圆角 `高÷2`、轨色 `rgba(255,255,255,.15)`、填充从 `x=14` 起、最小宽 = 高。
- 圆环半径 `probe = 20`，其余 `16`（`chicken.js:356`）；圆心 `y = 标题基线 - 6`，`x` 从右侧 `W-34` 往左排。
- 名字留白按版式给（`chicken.js:326`）：`offline → W-78`、`probe → 246`、`web → W-70`；**加了图标位之后从 `x0` 里扣，不再另算一套**。

**名牌配色与 HUD 同源**（canvas 不认 CSS 变量，所以这里只能写 `rgba()` 字面量 ——
**但取值必须与 token 一一对应，并在代码注释里写明对应关系**）：

| 名牌元素 | 现值 | 目标 | 对应 token |
|---|---|---|---|
| 牌底（在线） | `rgba(15,25,10,0.55)`（`chicken.js:311`） | `rgba(14,22,10,0.80)` | `--farm-haze-strong`（深一档：名牌是 3D 里的小字，比 HUD更需要底衬） |
| 牌底（离线） | `rgba(28,28,30,0.78)` | `rgba(28,28,30,0.82)` | 无彩色，与 `--farm-off` 呼应 |
| 离线描边 | `rgba(200,90,90,0.55)`（`:315`） | `rgba(255,212,202,0.55)` | `--farm-bad`（原色在深底上偏暗） |
| 标题 | `#ffffff`（`:332`） | 保留 | `--farm-ink` |
| 副行 | `rgba(255,255,255,0.72)`（`:339`） | `#dbe4d5` | `--farm-ink-dim`（**改成实色**：`.72` 透明度等于让背景参与决定对比度） |
| 血条轨 | `rgba(255,255,255,0.15)`（`:346`） | 保留 | — |
| 血条填充 | `#7ec850` / `#e8b23a` / `#e05252`（`:350`） | `#c0eb96` / `#ffd98a` / `#ffd4ca` | `--farm-good` / `--farm-warn` / `--farm-bad` |
| 圆环（CPU / 内存） | `#7ec850` / `#5aa7d6`（`:359-360`） | `#c0eb96` / `#6fb3e8` | `--farm-good` / `--c-mem` 的暗色档 |

> **判据**：名牌是**深色玻璃上的小字**（副行 13–14px 画在 76–170px 高的画布上，再被 sprite 缩放到屏幕），
> 所以它该用 HUD 的**暗底那一套**，而不是面板的**浅底那一套**。
> 这就是「同一指标两组颜色」的正解 —— 不是让两边取同一个 hex，
> 而是让两边的**语义 token 相同**、由底色决定具体色值。
>
> 换色后的实测（名牌玻璃 `.80` 合成到天空 `#2d3d38` / 草地 `#2b3b24`）：
> 标题白字 **11.44 / 11.97:1**、副行 `#dbe4d5` **8.75 / 9.16:1** —— 都远超 4.5:1。
> 顺带说明：副行原来的 `.72` 白（合成后 6.82:1）**本来就是达标的**，
> 改成实色不是修缺陷，而是**去掉「用透明度压字」这种把对比度交给背景的做法**，
> 同时让名牌副行与 HUD 的 dim 档是同一个 token。

### 5.4 名牌图标位：A 方案（推荐）与 B 方案

**A（推荐，先做这个）：名牌不放图标，`title` 只放名字。**

理由：**「这是哪只鸡」已经由鸡的模型本身表达了** —— 毛色按 `appearance({ id })`（`farm.js:337`）逐 id 推导、冠色固定、
姿态（走/跑/啄/扇翅/倒地）与状态色都在模型上。在一个 76–170px 高的画布上再塞一个 18px 图标，
收益低于它占掉的名字宽度（`player` 版式的名字可用宽度只有 246px 左右）。

```js
// farm.js:458 → me.chicken.setPlate({ title: identityRef.name, iconId: iconIdOf(identityRef.icon), hp: hp / CONF.maxHp });
// farm.js:470 → p.chicken.setPlate({ title: p.name || '访客', iconId: iconIdOf(p.icon), hp: (s.hp ?? 100) / CONF.maxHp });
```

（`iconId` 先传进去、`drawPlate` 先不画 —— 等真觉得需要个性化标记时再加 B，不用回头改调用点。）

**B（可选）：画图标。** 用 `Path2D` 复用同一份 `d`：

```js
// theme/js/chicken.js 的 drawPlate 内，名字之前
let x0 = 14;
if (flag) { drawFlag(ctx, flag, 14, 12, L.flagW, L.flagH); x0 = 14 + L.flagW + 8; }
if (iconId) {
  const s = 18;                                  // 画布内 18px
  drawIcon(ctx, iconId, x0, L.titleY - s + 4, s, '#ffffff');
  x0 += s + 6;                                   // 与 --icon-gap 同值
}
const maxW = (/* 原式 */) - (x0 - 14);           // 名字留白跟着缩，不用另算
```

### 5.5 命中飘字与 KO 横幅

| 元素 | 规格 |
|---|---|
| `.dmg-pop`（`:476-485`） | 加药丸底衬 `--farm-haze` + `border-radius: var(--r-pill)` + `padding: 2px 8px`；字号 16px 粗体保留；动效 `dmg-up .7s ease-out` 保留（**只做位移 + 淡出、不做缩放**，这条是性能取舍） |
| `#ko-banner`（`:486-492`） | 加 `--farm-haze-strong` 药丸（见第 ③ 章）；字号 30 → 28（给图标留位置）；`display:flex` 以容纳 `#i-dizzy` / `#i-logo` |
| 颜色 | 飘字 `--farm-score`（5.37:1 起）；KO 白字 + 深玻璃 6.43:1 起 |

### 5.6 落地文件与行号

| 文件 | 行 | 动作 |
|---|---|---|
| `theme/js/world.js` | `:8`、`:21-40`、`:46-66`、`:139-141`、`:145-157`、`:211` | 只做**注释分组**与低配光照微调；色值除 `lowPower` 光照外不动 |
| `theme/js/chicken.js` | `:15-26` | 加注释说明「喙/冠固定色是刻意的」 |
| | `:31-39` | 加「血条恒为 x=14 / 宽 W-28 / 圆角 h÷2」的规则注释，数值不动 |
| | `:111-120` `drawFlag` | 保留（文字角标降级是有意为之） |
| | `:303-363` `drawPlate` | `:311` `:315` `:339` `:350` `:359-360` 换色；`:320-333` 图标位（B 方案） |
| `shared/plate.js` | `:41-48` | 返回值增加 `iconId: iconIdOf(meta.icon)`（需要 `import` 新的 `shared/icon-name.js`） |
| `theme/js/farm.js` | `:458` `:470` | `title` 去掉图标；传 `iconId` |

### 5.7 验收标准

1. 场上同时有探针鸡、网站鸡、真人玩家和一只离线鸡：四种名牌在天空与草地两种背景前都能读清名字与副行。
2. 血量低到 25% 时血条是 `--farm-warn`、归零时是 `--farm-bad`，颜色与 HUD 的告警色是同一族；名牌与 HUD 不再出现「同一状态两种色」。
3. 名牌路径里不再出现任何 emoji。
4. 同一台机器的 CPU 读数在面板图表、面板计量条、名牌圆环三处是同一色相家族（面板浅底深色 / 名牌深底亮色）。
5. 低配模式（`lowPower`）下阴影与光照观感不明显塌陷（`mapSize 1024` + PCF，太阳降到 1.45）。
6. 草地/天空交界仍然「溶」在一起（雾与背景同色没被改动）。

---

## 6. ⑤ 无障碍与暗色

### 6.1 现状问题

1. **没有焦点样式**（全站，同 3.1-1）。
2. **图标按钮没有可访问名**：`◐` `▦` `☰` `✏️` `✕` `⟳` 是按钮的唯一内容，读屏会按字符名念出来。
   **这条改造会引入新风险**：换成 SVG 后 `<use>` 里的图形没有文本，如果不同时加 `aria-label`，
   按钮会变成**完全无名称** —— 比现在更糟。这是本轮最容易踩的回归，必须与图标替换同一批改。
3. **装饰性 emoji 会被读出来**：`🐔 探针鸡 在线 12` 会被念成「鸡 探针鸡 在线 12」，纯噪音。
4. **控件边界 1.15:1**（同 1-8）。
5. **暗色下 `--m-*` 缺失**（同 1-7）。
6. **触屏目标偏小**：`#me-edit` ~25px（见 3.2-3）。
7. **11px 标签**：`.cell .k`、`.num .k` 是 11px —— WCAG 不禁字号，且已用 `--ink-3 #6b7178` 保证 4.93:1；
   而 `index.html:5-10` 明确没有禁用缩放（注释写清了理由），这两点保持不动。

### 6.2 目标规格

**（1）焦点可见**

```css
/* 只在键盘导航时显示，鼠标点击不出现 —— 不破坏现有观感 */
:focus-visible {
  outline: none;
  box-shadow: var(--focus);
  border-radius: inherit;           /* 环跟着元素圆角走 */
}
/* 老浏览器兜底：不支持 :focus-visible 时至少给个可见轮廓 */
@supports not selector(:focus-visible) {
  button:focus, a:focus, input:focus, select:focus {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
}
```

**（2）图标的无障碍三规则**

| 场景 | 做法 |
|---|---|
| 图标旁有文字（进鸡场、管理、回面板、HUD 三行、触屏三键） | `<svg aria-hidden="true" focusable="false">`，名称由文字提供 |
| 图标是控件唯一内容 | 控件加 `aria-label`，**并保留 `title`**（`title` 管鼠标悬浮，`aria-label` 管读屏） |
| 图标承载状态语义（颜色） | 不靠颜色单独表达：HUD 三行有文字标签、榜单行有名字、`--farm-*` 只是加强 |

**必须补 `aria-label` 的清单**（文案与现有 `title` 一致）：

| 元素 | `aria-label` |
|---|---|
| `#theme-btn` | 切换亮色/暗色主题 |
| `[data-view="grid"]` | 网格视图 |
| `[data-view="list"]` | 列表视图 |
| `#me-edit` | 改名字 |
| 抽屉 `close`（`panel.js:716`） | 关闭详情 |
| 抽屉 `reload`（`panel.js:705`） | 重新读取历史 |
| `.tc-btn-peck` / `-run` / `-jump` | 啄 / 疾跑 / 跳（键面汉字保留，`aria-label` 用完整词） |

**（3）触屏目标**：按 3.2-3 的表提升（`#me-edit` 25 → 32px，`.chip` 27 → 28px，桌面 `.ghost` → 36px）。
WCAG 2.5.8 下限 24px、2.5.5（AAA）建议 44px；现有窄屏 `@media`（`:606-613`）已经把点击区加到 33–39px，保持。

**（4）暗色**

- `--m-*` 四条覆盖（3.2-6）。
- `--surface-2`（3.2-2）替换 `.sstat` 的 `color-mix` 现算。
- `--shadow-2`（3.2-1）。
- `--focus` 一套定义吃两套主题（惰性求值），不重复写。
- **鸡场不随亮暗整体翻转**：3D 世界有自己的光照，翻 `html.dark` 只会做出一个「晚上的鸡场」，那是另一个需求。
  所以 `--farm-*` 定义在 `:root`，只在 `html.dark .farm` 里把玻璃压深一档 ——
  「亮暗同处定义」的规矩不破（都在 `:root` 附近），也如实说明了「鸡场不做暗色主题」。

**（5）可选增强（不阻塞本轮）**

```css
@media (prefers-contrast: more) {
  :root { --ink-3: #4f545a; --line: #b9bdc3; }
  html.dark { --ink-3: #b3b9c2; --line: #454b54; }
}
@media (forced-colors: active) {
  .i { forced-color-adjust: auto; }   /* 系统高对比度下用系统色，别硬扛 */
}
```

### 6.3 落地文件与行号

`theme/style.css`：`:99` 之后新增 `:focus-visible` 块；`:64` 之后（`html.dark`）补 `--m-*` / `--surface-2` / `--shadow-2`；
末尾追加 `prefers-contrast` / `forced-colors` 两段（可选）；`:626-628` 的 `prefers-reduced-motion` 保持。

`theme/index.html`：`:45` `:57` `:58` `:92` 补 `aria-label`。
`theme/js/panel.js`：`:705` `:716` 补 `aria-label`。

### 6.4 验收标准

1. 只用键盘：Tab 能走到每一个可点元素，焦点环在亮暗两套下都清楚；Esc 仍能退出鸡场（`farm.js:173` 的行为不变）。
2. 读 DOM 检查：`document.querySelectorAll('button, a')` 里，凡是**没有可见文本**的都带 `aria-label`。
3. 读屏（或按 `aria-label` 逐条核）念出来的名称里不含「鸡」「月亮」这类由图标产生的字符噪音。
4. 系统开「高对比度」时界面仍可用（至少不出现图标消失）。
5. 系统开「减少动态效果」时无动画。
6. 暗色下 `.seg.mem` 已填格 ≥3:1；`.sstat` 与 `.card` 的层次方向与亮色一致。

---

## 7. 新增 / 调整的 CSS token 全表

### 7.1 新增 · 结构性（与主题无关，一套值）

| token | 值 | 用途 |
|---|---|---|
| `--r-xs` | `6px` | 徽标、小角标、`.sstat` |
| `--r-sm` | `9px` | 按钮、输入、页签、`.viewtoggle` |
| `--r-md` | `12px` | 卡片、浮层、HUD 卡（= 现有 `--radius`，保留别名不删） |
| `--r-pill` | `999px` | 胶囊、血条、提示条 |
| `--sp-1` … `--sp-6` | `4 / 6 / 8 / 12 / 16 / 20px` | 间距尺度 |
| `--fs-10` … `--fs-19` | `10 / 11 / 12 / 13 / 14 / 15 / 17 / 19px` | 字号尺度 |
| `--fw-n` / `--fw-m` / `--fw-b` | `400 / 500 / 600` | 字重 |
| `--dur-1` / `--dur-2` / `--dur-3` | `.12s / .18s / .25s` | 时长尺度 |
| `--ease` | `cubic-bezier(.22,.61,.36,1)` | 统一缓动 |
| `--ic-16` / `--ic-20` / `--ic-26` | `16 / 20 / 26px` | 图标尺寸 |
| `--icon-gap` | `6px` | 图标与文字间距 |
| `--focus-w` | `2px` | 焦点环宽度 |
| `--focus` | `0 0 0 2px var(--paper), 0 0 0 4px var(--accent)` | 焦点环（惰性求值，两套主题共用） |

### 7.2 新增 · 语义层（亮 / 暗两套）

| token | 亮 | 暗 | 用途 | 实测 |
|---|---|---|---|---|
| `--surface-2` | `#fafbfc` | `#22262c` | 二级底色（`.sstat`、浮层内嵌块） | 与 `--paper` 差一档，两套方向一致 |
| `--shadow-2` | `0 2px 6px rgba(20,22,26,.08), 0 14px 40px rgba(20,22,26,.14)` | `0 2px 6px rgba(0,0,0,.5), 0 14px 40px rgba(0,0,0,.45)` | 抽屉、图表读数浮层 | — |
| `--accent-on-soft` | `#44702f` | `var(--accent)` | 文字压在 `--accent-soft` 上 | 亮 **5.12:1** ✅ / 暗 ≈8.8:1 ✅ |
| `--line-control` | `var(--line-2)` | `var(--line-2)` | 控件边界 | 亮 1.47:1 —— **不达 3:1，见第 ⑩ 章未决项** |
| `--focus-w` / `--focus` | 见 7.1 | 见 7.1 | 焦点环 | 亮 4.70–5.08:1 ✅ / 暗 9.34–10.23:1 ✅ |

### 7.3 新增 · `--m-*` 暗色覆盖（缺陷修复，不改亮色档）

| token | 亮（现有，不动） | 暗（新增） | 暗色卡片上 |
|---|---|---|---|
| `--m-cpu` | `#3f7fb5` | `#6fb3e8` | 7.31:1 |
| `--m-mem` | `#7a4fa8` | `#b18fdc` | 6.16:1（原 **2.76:1**） |
| `--m-disk` | `#9c6b28` | `#bfa189` | 6.83:1 |
| `--m-load` | `#b0507a` | `#e08fb0` | 6.87:1 |

### 7.4 新增 · 鸡场（一套值 + 一条暗色覆盖）

| token | 值 | `html.dark .farm` |
|---|---|---|
| `--farm-grass` | `#9fd08a` | 不变 |
| `--farm-sky` | `#a8d8f0`（仅文档用） | 不变 |
| `--farm-haze` | `rgba(18,28,14,.62)` | `rgba(12,20,9,.68)` |
| `--farm-haze-strong` | `rgba(14,22,10,.80)` | 不变 |
| `--farm-ink` | `#ffffff` | 不变 |
| `--farm-ink-dim` | `#dbe4d5` | 不变 |
| `--farm-accent` | `#ffe27a` | 不变 |
| `--farm-good` | `#c0eb96` | 不变 |
| `--farm-warn` | `#ffd98a` | 不变 |
| `--farm-bad` | `#ffd4ca` | 不变 |
| `--farm-off` | `#d6ded1` | 不变 |
| `--farm-score` | `#d7ecc0` | 不变 |

### 7.5 明确不改动的 token（避免落地时被顺手改掉）

`--bg` `--paper` `--ink` `--ink-2` `--ink-3` `--line` `--line-2`
`--accent` `--accent-fill` `--accent-soft` `--warn` `--warn-fill` `--danger` `--danger-fill`
`--shadow` `--radius` `--mono` `--sa-t/r/b/l`
`--c-cpu` `--c-mem` `--c-disk` `--c-up` `--c-down` `--c-ping-1…4`（亮暗都已成对，无需动）
`--m-cpu/mem/disk/load` 的**亮色**档。

---

## 8. 对比度数值表（WCAG 2.1 相对亮度公式，实测）

### 8.1 面板

| 用途 | 前景 | 背景 | 对比度 | AA |
|---|---|---|---|---|
| `--ink-3` 11px 标签 | `#6b7178` | `#ffffff` | 4.93:1 | ✅ |
| `--ink-3` 11px 标签 | `#6b7178` | `#f5f6f7` | 4.56:1 | ✅ |
| `--ink-2` 次要文字 | `#5b6068` | `#ffffff` | 6.33:1 | ✅ |
| `--ink` 正文 | `#16181c` | `#ffffff` | 17.77:1 | ✅ |
| `--accent` 文字 | `#4a7a37` | `#ffffff` | 5.08:1 | ✅ |
| `--accent` 文字 | `#4a7a37` | `#f5f6f7` | 4.70:1 | ✅ |
| `--warn` 文字 | `#a15c07` | `#ffffff` | 5.19:1 | ✅ |
| `--danger` 文字 | `#c2221a` | `#ffffff` | 5.94:1 | ✅ |
| 暗色 `--ink-3` | `#8d949e` | `#1c1f24` | 5.40:1 | ✅ |
| 暗色 `--accent` | `#9fd08a` | `#1c1f24` | 9.34:1 | ✅ |
| 暗色 `--warn` | `#e0a951` | `#1c1f24` | 7.84:1 | ✅ |
| **选中态反色（改后）** | `#f5f6f7` | `#16181c` | 16.43:1 | ✅ |
| **选中态反色 · 暗（改后）** | `#14161a` | `#eceef1` | 15.58:1 | ✅ |

**计量条与图表（非文字，需 ≥3:1）**

| 项 | 色 | 亮 `#ffffff` | 暗 `#1c1f24` |
|---|---|---|---|
| `--m-cpu`（亮）/ `#6fb3e8`（暗） | 蓝 | 4.27:1 ✅ | 7.31:1 ✅ |
| `--m-mem`（亮 `#7a4fa8`） | 紫 | 5.98:1 ✅ | **2.76:1 ❌（本轮修）** |
| `--m-disk`（亮 `#9c6b28`） | 棕 | 4.62:1 ✅ | 3.58:1 ✅ |
| `--m-load`（亮 `#b0507a`） | 玫红 | 4.91:1 ✅ | 3.36:1 ✅ |
| `--c-cpu #5f9e3f` | 绿 | 3.26:1 ✅ | — |
| `--c-mem #3f7fb5` | 蓝 | 4.27:1 ✅ | — |
| `--c-disk #8a6a52` | 褐 | 4.92:1 ✅ | — |
| `--c-up #c9821f` | 橙 | 3.14:1 ✅ | — |
| `--c-down #2f8f7f` | 青 | 3.92:1 ✅ | — |

**发现但本轮不改（既有问题，改动会明显影响观感，见第 ⑩ 章）**

| 用途 | 前景 | 背景 | 对比度 | 要求 |
|---|---|---|---|---|
| 输入框/下拉的边框 | `#e5e7ea` | `#f5f6f7` | **1.15:1** | ≥3:1（1.4.11）❌ |
| 输入框/下拉的边框（暗） | `#2a2e35` | `#1c1f24` | **1.21:1** | ≥3:1 ❌ |
| `--accent` 压在 `--accent-soft` 上 | `#4a7a37` | `#eaf3e4` | **4.46:1** | ≥4.5:1 ❌（现有组件没用这种组合，已备 `--accent-on-soft`） |
| `--ink-3` 压在 `--accent-soft` 上 | `#6b7178` | `#eaf3e4` | **4.33:1** | ≥4.5:1 ❌（同上，属未使用组合） |

### 8.2 鸡场 HUD（现状 → 建议）

| 用途 | 前景 | 背景（合成色） | 现状 | 建议 |
|---|---|---|---|---|
| 数字 / 榜标题 | `#ffd95e` → `#ffe27a` | 玻璃 .55→.62 叠天空 `#577274` → `#4b6364` | **3.77:1** ❌ | **5.02:1** ✅ |
| 数字 / 榜标题 | 同上 | 叠草地 `#536e46` → `#48603d` | **4.16:1** ❌ | **5.44:1** ✅ |
| 离场名 | `#8b948c` → `#d6ded1` | 叠天空 | **1.65:1** ❌ | **4.66:1** ✅ |
| 离场名 | 同上 | 叠草地 | **1.82:1** ❌ | **5.05:1** ✅ |
| 分数 | `#cfe8b0` → `#d7ecc0` | 叠草地 | **4.29:1** ❌ | **5.52:1** ✅ |
| 联机徽标 | `#b8e986` → `#c0eb96` | 叠草地 | **4.08:1** ❌ | **5.16:1** ✅ |
| 错误徽标 | `#ff9a8a` → `#ffd4ca` | 叠草地 | **2.78:1** ❌ | **5.15:1** ✅ |
| 主文字 | `#ffffff` | 叠天空 | 5.17:1 ✅ | **6.43:1** ✅ |
| 主文字 | `#ffffff` | 叠草地 | 5.70:1 ✅ | **6.96:1** ✅ |
| dim 档次要文字 | — | 叠天空 / 叠草地 | — | **4.92:1 / 5.33:1** ✅ |
| 事件流 | `#ffe9b0` → `#d7ecc0` | 玻璃 .80 叠天空 | 4.31:1 ❌ | **5.37:1** ✅ |
| 提示条 | `.85` 白 → `#dbe4d5` | 玻璃 `.45` → `.62`，叠天空 | **4.02:1** ❌ | **4.92:1** ✅ |
| 提示条 | 同上 | 叠草地 | 4.46:1 ❌ | **5.33:1** ✅ |
| KO 横幅白字 | `#ffffff` | **无玻璃** 叠天空 | **1.53:1** ❌ | 加 `.80` 玻璃后 **6.43:1** ✅ |
| 命中飘字 | `#ffe9b0` → `#d7ecc0` | **无玻璃** 叠天空 / 加 `.62` 玻璃 | **1.28:1** ❌ | 加玻璃后 **5.09:1** ✅ |
| 3D 名牌标题 | `#ffffff` | 名牌玻璃 `.55` → `.80` 叠天空 | 5.17:1 ✅ | **11.44:1** ✅ |
| 3D 名牌副行 | `.72` 白 → `#dbe4d5` | 名牌玻璃 `.80` 叠天空 | 6.82:1 ✅（**不是缺陷**，是去掉 opacity 压字的收敛） | **8.75:1** ✅ |

**结论**：现状 HUD 有 **7 项文字不达 4.5:1**（另加 KO 横幅、飘字各 1 项）；
建议方案把玻璃从 `.55` 提到 `.62` 后，**8 档文字在两个最亮背景上全部 ≥4.5:1，最小的一项也留 0.16 的余量**（`--farm-off` 4.66:1）。

> 一处需要说清楚的**设计过程**：初稿给 `.hint` 与命中飘字留了一档 `.45` 的 `--farm-haze-soft`，
> 实算发现 `.45` 玻璃叠天空上 `--farm-ink-dim` 只有 **3.07:1**、纯白 **3.40:1** ——
> 比现状 `.85` 白的 3.40/3.72 **没有任何改善**。于是删掉这一档，两处都用 `.62`。
> 六种玻璃透明度收敛成**两种**，这是本轮「收敛」的实绩之一；
> 也说明为什么「先算再定」比「看着调」重要 —— 多一层玻璃看起来更轻，但它会把对比度压到线下。

---

## 9. 交给苏小码的接入契约

### 9.1 新增文件

**`theme/js/icons.js`**（DOM 与 canvas 共用的唯一入口）

```js
// 图标薄封装。sprite 已内联在 index.html，这里只做取用与构造：
// 它只把「图标名」翻译成「DOM 元素 / Path2D」，不新建 SVG 属性、不改 sprite 内容。
import { iconIdOf } from '/shared/icon-name.js';

const NS = 'http://www.w3.org/2000/svg';
const pathCache = new Map();

/** <svg class="i i-20"><use href="#i-x"/></svg>
 *  label 有值时给辅助技术（role=img），否则整块 aria-hidden —— 别两样都不给。
 *  ⚠ iconIdOf 可能返回 null（意思是「这个名字应该当文字画」）。
 *  DOM 里这里没有文字位，所以必须自己兜成 i-chicken ——
 *  不兜的话 use href 会写成 #null，得到一个空白方块（而且不报错，很难查）。 */
export function iconEl(name, size = 20, label) {
  const id = iconIdOf(name) || 'i-chicken';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `i i-${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** canvas 侧：把 symbol 里所有 <path> 的 d 合成一条 Path2D（并缓存）。
 *  依赖 sprite「只用 <path>」这条约定，所以不需要 SVGGeometryElement.getPathData()。
 *  fill 模式的符号（i-logo / i-hit）用 data-mode 区分：调用方据此决定 fill 还是 stroke。 */
export function iconPath(name) {
  const id = iconIdOf(name);
  if (!id) return null;                         // null = 该画文字，交给调用方
  if (pathCache.has(id)) return pathCache.get(id);
  const sym = document.getElementById(id);
  if (!sym) return null;                        // sprite 还没挂上，调用方自己降级
  const path = new Path2D();
  for (const el of sym.querySelectorAll('path')) path.addPath(new Path2D(el.getAttribute('d')));
  const rec = { path, mode: sym.getAttribute('data-mode') === 'fill' ? 'fill' : 'stroke' };
  pathCache.set(id, rec);
  return rec;
}

/** 3D 名牌用：在 canvas 上按 24 网格画一个图标。
 *  坐标语义是「左上角 + 边长」，内部负责把 24 网格缩放到 size。 */
export function drawIcon(ctx, name, x, y, size, color) {
  const ic = iconPath(name);
  if (!ic) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  if (ic.mode === 'fill') { ctx.fillStyle = color; ctx.fill(ic.path, 'evenodd'); }
  else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(ic.path);
  }
  ctx.restore();
  return true;
}
```

**`shared/icon-name.js`**（纯函数，可测；放 `shared/` 才能被 `shared/plate.js` 与两端共用）

```js
// 图标名 → 符号 id。协议里的 icon 是任意短字符串，映射收在这一处。
const ALIAS = new Map(Object.entries({
  chicken: 'i-chicken', '🐔': 'i-chicken', 'i-chicken': 'i-chicken',
  logo: 'i-logo', 'i-logo': 'i-logo',
  cat: 'i-chicken',   // 预留：以后想加别的动物，未登记的统统退到鸡
}));

/** 三级降级：
 *  ① 别名表命中 → 符号 id；
 *  ② 1–2 个「非 emoji 的可见字符」→ null（调用方当文字画，保留个性化）；
 *  ③ 其他（emoji / 空 / 过长 / 控制字）→ 兜底 i-chicken，**永不把 emoji 画出去**。 */
export function iconIdOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'i-chicken';
  const hit = ALIAS.get(s);
  if (hit) return hit;
  if (s.length <= 2 && !/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(s)) return null;
  return 'i-chicken';
}
```

> 注意 `iconIdOf` 会返回 `null`。所有调用点要么用 `iconEl`（内部会兜成 `i-chicken`），
> 要么自己处理 `null`（例如名牌降级成纯文字）。别写成 `iconEl(iconIdOf(x))` 之外的隐式假设。

### 9.2 `textContent` 会吃掉图标 —— 四处必须改成 `replaceChildren`

本次改造最容易踩的坑：`el.textContent = '…'` 会**删除所有子元素**。以下四处现在都是整体覆盖，加了图标就会被抹掉：

| 位置 | 现在 | 改成 |
|---|---|---|
| `panel.js:828` | `` $('site-name').textContent = `🐔 ${name}` `` | `$('site-name-text').textContent = name`（HTML 里给文字加 span） |
| `farm.js:327-328` | `$('board-title').textContent = '…'` | `$('board-title-text').textContent = '…'`（同样加 span） |
| `farm.js:204` | `` $('me-name').textContent = `${icon} ${name}` `` | `$('me-name').replaceChildren(iconEl(icon, 20), name)` |
| `farm.js:229` | `` name.textContent = `${icon} ${name}` `` | `name.replaceChildren(iconEl(icon, 20), r.name, r.me ? '（你）' : '')` |

配套：`flash()`（`farm.js:238-246`）与 `feed()`（`:267-275`）加一个可选图标参数，内部用 `replaceChildren`：

```js
function flash(text, ms = FLASH_MS, icon) {
  const el = $('ko-banner');
  if (performance.now() < deadUntil && ms < 2000) return;   // 倒地提示优先，这条逻辑不动
  el.replaceChildren(...(icon ? [iconEl(icon, 28), text] : [text]));
  el.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('show'), ms);
}
```

`feed()` 同理（图标 20px）。`flash` 的 8 处、`feed` 的 6 处调用点，统一多传一个图标名；
**不要在字符串里留 emoji 当退路** —— 那样 emoji 就又回来了。

### 9.3 服务端 `icon` 字段的降级策略

协议字段**保持字符串、不改枚举**（老客户端还在发 `'🐔'`），语义从「emoji」变成「符号名或 1–2 字可见文本」：

| 收到 | 客户端行为 |
|---|---|
| `'chicken'`（新默认）、`'🐔'`（老默认）、`'i-chicken'` | 画 `#i-chicken` |
| 1–2 个非 emoji 可见字符（自定义 `'A'` / `'甲'`） | 当文字画（保留个性化，不画豆腐块） |
| 其他 emoji、超长、控制字、空 | 兜底 `#i-chicken`（**永不画 emoji**） |

服务端只改两处默认值（`room.js:148`、`:178`）与一处注释（`:46`）；`clipped()` 的长度上限不用改（`'chicken'` 7 字符）。
**`theme/js/net.js` 不需要改**（`:87` `:97` `:126` `:195`）—— `icon` 一直是透传字符串。

### 9.4 最小改动顺序（建议按此提交，每步都能单独验证）

1. **只加 sprite + 只换静态 HTML 图标**（`index.html` 一处新块 + 16 处替换 + `style.css` 的 `.i` 规则）。
   验证：页面图标正确、断网可见、亮暗切换变色。
2. **补 `aria-label` 与被 SVG 取代的可访问名**（6 处）。
   验证：无可见文本的按钮全部有可访问名。**这一步不能留到后面做** —— 否则中间态会出现「无名称按钮」。
3. **`theme/js/icons.js` + `shared/icon-name.js` + 动态处替换**（`panel.js` 3 处、`farm.js` 15 处、`main.js` 2 处，
   含 9.2 的四处 `textContent` 改造）。
   验证：榜单行、名字行、事件流、KO 横幅、静音提示的图标都在，且没有 emoji 残留。
4. **面板 token 收敛**（7.1 + 7.2 + 3.2-3/4/5/6 + 第 ⑤ 章的暗色补齐）。
   验证：Tab 焦点环、选中态统一、暗色计量条 ≥3:1。
5. **鸡场 token 收敛**（7.4 + 第 ③ 章）。
   验证：抬头看天空读数字、KO 药丸、`--farm-off` 可读。
6. **服务端默认值与注释**（`room.js` 3 处）+ **`npm run test`**。
   验证：老客户端连上仍然是鸡；新默认值是 `chicken`。
7. **（可选）3D 名牌**（第 ⑤ 章的 A 方案，纯删除 + 传 `iconId`）。

### 9.5 需要苏小码注意的三条硬边界

1. **不要在两处各写一份颜色**：名牌（canvas）必须写 `rgba()` 字面量，但取值要与 token 表一致，并在注释里写明对应关系（见 5.3 表）。
2. **不要改 `.seg` 的机制**（16 格 + 身份色 + 越线才切 warn/danger），也不要给摇杆头加 `transition`。
3. **不要给图标写死颜色**。任何一个 `<symbol>` 里出现 hex/`rgb()` 都算违约 —— 图标只有 `currentColor` 一种颜色来源。

---

## 10. 未决项与缺口

### 10.1 需要用户拍板的两项（本方案已按保守值处理，不阻塞落地）

| # | 事项 | 我的处理（保守默认） | 需要用户决定什么 |
|---|---|---|---|
| 1 | **草绿主色是否保留**（`#9fd08a` 草地 + `#6aa84f`/`#4a7a37` 面板绿） | **保留不动**。它与既有 `theme-color`、`#flags` 素材、参考站观感、`world.js` 的 18 处场景色全绑在一起；换主色等于换一套场景光照，属于另一个需求 | 若要改（例如改成更中性的青绿或换品牌色），需要重算本文所有绿色系对比度，并重做场景调色板的明度纪律 |
| 2 | **控件边界要不要提到 3:1**（WCAG 1.4.11） | **暂不改**，只引入 `--line-control` 占位（当前等于 `--line-2`）。给两组取值供选：亮底 `#8b9098`（3.21:1）/ 暗底 `#69707a`（3.30:1） | 这一步会把所有输入框、下拉的边框明显加深（从几乎看不见变成清晰的框），是观感上的可见变化，超出「优化」范围。要改就一次性改，别只改一半 |

### 10.2 本轮没有做的部分（明确缺口）

| 缺口 | 说明 |
|---|---|
| **3D 场景与名牌未渲染验证** | 本文第 ⑤ 章的调色板、光照数值、名牌版式全部来自源码阅读与既有注释（`world.js:1-4`、`chicken.js:1-6` 都写明「照参考站抄的实测值」）。**我没有运行 three.js**，名牌加玻璃/换色后的小字清晰度必须在浏览器里看过再定。特别是：名牌副行从 `.72` 白改成实色 `#dbe4d5` 后，在 76px 画布上的实际观感需要确认 |
| **真机 emoji 字形差异未实测** | 只在 Chrome + 本机字体上验证过「emoji 渲染依赖字体」这一结论的推理链（依据是 `flags.js:7-9` 记录过的同源问题）。要拿真机证据，得在无 emoji 字体的环境（精简版 Linux 镜像）里跑一次 |
| **图标在 12px 及以下未设计** | 本轮最小档是 16px。若有地方要 12–14px 图标，需要另做一版「简化描边」（1.75 细线在这个尺寸会糊），当前方案的规则是「小于 16px 不用描边图标」 |
| **`i-chicken` 在 16px 以下不可用** | 这是有意的设计约束（规则见 2.2）。如果以后想让小尺寸也有「整只鸡」，需要单独画一版去掉腿、加粗身体的简化鸡 |
| **交互态样式未覆盖** | hover / active / disabled 三态目前是零散的（`.ghost:hover`、`.chip:hover`、`.card:active`），本轮只统一了选中态与焦点态。要完整的状态矩阵需要再开一轮 |
| **动效曲线只统一了时长与缓动函数** | 没有做「进场/退场/位移」的动效规范；`.feed-item` 的 `pop`、`dmg-up` 保留原样，只把时长与曲线换成 token |
| **未做 300% 缩放与 320px 视口的实测** | `@media (max-width: 640px)` 与时序区已有处理（`index.html:5-10` 的注释解释了为什么不禁缩放），但本轮没在 320px 宽 + 200% 字号下逐屏核对 |

### 10.3 体积与性能小结（供决策）

| 项 | 数值 | 判断 |
|---|---|---|
| sprite 内联增量（推荐方案 A） | +10,650 B 原文 / +3,301 B gzip | 可接受：`index.html` 6,001 → 16,651 B，占总包不到 1% |
| 内联后的额外请求数 | **0** | 优于外部 sprite（会多 1 个请求） |
| `theme.tar.gz` 变化 | 0（`docs/` 不参与打包） | 打包产物完全不受影响 |
| 运行时开销 | 每个图标一个 `<use>`，浏览器会对同一 symbol 做绘制复用 | 23 个符号、67 条 path，远低于任何性能敏感阈值 |
| 新增 JS 体积 | `icons.js` 2,879 B + `icon-name.js` 889 B = **3,768 B** 原文 / 2,123 B gzip（含注释） | 合计比一个 sprite 图标还小；在入口文档之后按需加载，可忽略 |

---

## 附：三份产物的对应关系

| 文件 | 是什么 | 怎么核对 |
|---|---|---|
| `docs/icons/sprite.svg` | 权威图标源（23 个 `<symbol>`，含设计约定与踩坑注释） | 直接看注释；或用 `docs/icons-preview.html` 渲染它 |
| `docs/icons-preview.html` | 单文件、零外链的可核对页：四档尺寸 × 亮暗两底 × 三语义色 + token 色板 + HUD 现状/建议并排 + 25 行实测对比度表 + sprite 自检 | 浏览器打开；对比度表的数字是页面内 JS 用 WCAG 公式现场算的，不是抄的 |
| `docs/visual-refresh-20260929.md` | 本文：五章方案 + 两张全表 + 接入契约 + 未决项 | 落地时按第 ⑨ 章顺序做，按各章「验收标准」逐条核 |

预览页里内联的 sprite 与 `sprite.svg` 的 `<defs>` 是**同一份内容**（用脚本从 `sprite.svg` 读出后原样注入），
所以预览页上看到的图形就是权威源，不存在「预览一份、实际另一份」的情况。


