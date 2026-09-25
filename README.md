# 养鸡探针（Chicken Farm）

一个 monitor 探针主题：**打开是监控面板，点「进鸡场」走进去**，被监控的节点变成一群鸡。
值班时看面板，摸鱼时进去啄两口。

- **探针鸡 / 网站鸡**：`探针鸡` = 被监控的机器（离线倒地、未接入趴睡、CPU 打满的会冒火主动啄人）；
  `网站鸡` = 你自己配的一组网址，服务端定期探测它们的延迟与存活
- **真人同屏**：多人实时，可互相啄、扇翅、把对方啄倒，有啄倒榜与事件流
- **操控**：WASD 移动 · Shift 疾跑 · 空格跳（连按 5~10 段空中扑腾）· 拖动鼠标转视角 ·
  左键/E 啄 · 右键/F 扇翅 · 滚轮缩放 · M 静音；手机上是摇杆 + 三个按钮

> 快速上手：主题装到 hub 上（见「一」），联机服务起在主控同机（见「二」）。
> 只装主题也能用，只是鸡场里只有你自己。

---

## 零、一键部署（推荐）

从 GitHub 拉下来就能直接用，不需要手动调配置。脚本自动完成：装依赖 → 生成配置 → 起联机服务(systemd) → 配反向代理 → 打包主题。

```bash
# 在主控那台机器上（monitor hub 所在），root 执行：
curl -fsSL https://raw.githubusercontent.com/ipevel/chicken-probe/main/deploy.sh -o /tmp/deploy.sh
bash /tmp/deploy.sh
```

脚本会自动探测 hub 端口（9911/28080）、生成 `server/config.json`（`websites` 默认留空，不探测任何第三方站点）、把联机服务装成 `chicken-room` 常驻服务、写 nginx 反向代理、并打出主题包。

常用选项（全部可选）：

| 选项 | 作用 |
|---|---|
| `--hub-port <n>` | 手动指定 hub 端口（自动探测失败时用） |
| `--domain <d>` | 面板域名，用于反向代理（默认自动探测） |
| `--port <n>` | 联机服务端口（默认 7789） |
| `--install-dir <p>` | 安装目录（默认 `/opt/chicken-probe`） |
| `--no-theme` / `--no-proxy` / `--no-systemd` | 跳过对应步骤 |

跑完看输出里的「下一步」：把 `build/theme.tar.gz` 传到 hub 面板「主题 → 上传」，或按提示手动解压到主题目录并切换。之后浏览器打开面板，点「进鸡场」即可。

> 想加「网站鸡」？装完后编辑 `server/config.json` 的 `websites` 数组，`systemctl restart chicken-room`。

---

## 一、安装主题

主题是一个**纯静态包**：根目录放 `dist/` 与 `theme.json`，由 monitor hub 托管在域名根路径。

```bash
npm install          # 只为打包拉一个 three；联机服务不需要它
npm run build:theme  # 产出 build/theme.tar.gz（约 235 KiB）
```

两种安装方式，任选：

1. **面板上传**：hub 后台「主题」→「上传主题」→ 选 `build/theme.tar.gz`；
   装完在主题列表里选「Chicken Farm」。
2. **从 Release 装/更新**：把仓库挂到 GitHub，把 `theme.tar.gz` 作为 Release 资产上传
   （**资产名必须是 `theme.tar.gz`**，hub 只认这个名字，面板里的一键更新就是靠它）。
   `theme.json` 里的 `url` 指向本仓库，hub 据此解析 `<owner>/<repo>`。

打包脚本会自己校验 hub 的硬规矩，不合规直接失败：

| 规矩 | 上限 / 本主题实际 |
|---|---|
| 必须有 | `dist/index.html`、`theme.json` |
| `theme.json` 的 `short` | 只能是 ASCII 字母数字与 `-` `_`（它同时是目录名），本主题是 `chicken-farm` |
| 单文件 | ≤ 8 MiB（最大的是 `vendor/three.module.js`，0.58 MiB） |
| 解压后 | ≤ 64 MiB（实际 0.9 MiB） |
| 上传包 | ≤ 32 MiB（实际约 235 KiB） |
| 部署路径 | 只能是域名根路径（产物里是绝对路径 `/assets...`） |

主题自身没有可调参数（hub 不给主题传配置），唯一与部署相关的是「联机服务地址」（见 3.1）。

---

## 二、部署联机服务（**与探针主控同一台服务器**）

鸡场的多人同屏靠一个常驻的 WebSocket 服务。它必须和 monitor hub 跑在同一台机器上：
它要读本机 hub 的公开接口拿节点列表，而**主控不需要对公网多开任何端口**。

```
浏览器 ──(同域 wss://面板域名/room/ws)──► 反向代理 ──► 127.0.0.1:7789（联机服务）
                                                          │
                                                          └─(读 http://127.0.0.1:9911/api/nodes)─► monitor hub
```

### 2.1 前置条件

- Node.js **18+**（用到内置 `fetch`）与 npm
- monitor hub 的**公开页是开着的**（联机服务读的是匿名可读的 `/api/nodes`）
- 主控那台机器上能放一个常驻进程（systemd / supervisor / screen 都行）

### 2.2 启动

```bash
git clone https://github.com/ipevel/chicken-probe.git && cd chicken-probe
npm install --omit=dev                 # 生产只装一个依赖：ws
cp server/config.example.json server/config.json
vi server/config.json                  # 见 2.3
node server/index.js --config server/config.json
```

### 2.3 配置项（`server/config.json`，全部可被命令行参数覆盖）

```json
{
  "hub": "http://127.0.0.1:9911",
  "host": "127.0.0.1",
  "port": 7789,
  "path": "/ws",
  "static": "",
  "websites": [
    { "name": "公司官网", "url": "https://example.com" },
    { "name": "API 健康页", "url": "https://api.example.com/healthz" }
  ]
}
```

| 字段 | 命令行 | 默认 | 说明 |
|---|---|---|---|
| `hub` | `--hub <url>` | `http://127.0.0.1:9911` | 探针主控地址。同机所以走回环；它决定「探针鸡」有几只、什么状态 |
| `host` | `--host <ip>` | `0.0.0.0` | 监听地址。**建议改成 `127.0.0.1`**，只让同机反向代理进来 |
| `port` | `--port <n>` | `7789` | 监听端口，要和反向代理里的转发目标一致 |
| `path` | `--path <p>` | `/ws` | WebSocket 路径（代理剥掉 `/room/` 前缀后落到这个路径） |
| `static` | `--static <dir>` | — | 顺带托管一份主题产物，仅用于**本地体检**；生产由 hub 托管，留空 |
| `websites` | — | `[]` | 「网站鸡」的来源，见 2.4；留空就没有网站鸡 |

环境变量 `HUB_URL`、`PORT` 可作为对应项的兜底；`node server/index.js --help` 打印全部参数。

### 2.4 网站鸡（`websites`）

每一项 `{ name, url }`：`name` 是鸡的名字（不填取域名），`url` 是要探测的地址。

- 每 **15 秒** GET 一次，超时 6 秒；`4xx/5xx` 算「站点应答但状态不对」→ 离线并显示 HTTP 码
- 延迟超过 **1.5 秒**算慢 → 那只鸡会冒火（`alert` 姿态）
- 连不上 → 倒地，标签写具体原因（`无法连接` / `超时` / `HTTP 404`）
- 空数组 = 一只网站鸡都没有；**不会**去探测任何第三方站点

### 2.5 常驻（systemd）

```bash
sudo tee /etc/systemd/system/chicken-room.service > /dev/null <<'EOF'
[Unit]
Description=Chicken Farm room (monitor theme multiplayer)
After=network.target

[Service]
WorkingDirectory=/opt/chicken-probe
ExecStart=/usr/bin/node server/index.js --config server/config.json
Restart=always
RestartSec=3
User=monitor

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now chicken-room
journalctl -u chicken-room -f          # 看日志
```

### 2.6 反向代理（把同域的 `/room/` 指向它）

主题默认连同域的 `wss://<面板域名>/room/ws`。在主控那台机器上加一条转发：

**nginx**（注意 `proxy_pass` 结尾的斜杠会剥掉 `/room/` 前缀）：

```nginx
location /room/ {
    proxy_pass http://127.0.0.1:7789/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 300s;      # WebSocket 是长连接，别让代理掐掉
}
```

**Caddy**：`handle_path /room/* { reverse_proxy 127.0.0.1:7789 }`

> hub 对主题没有任何 CSP 限制，所以也可以把联机服务放另一个域名 —— 但它本质上是主题的后端，
> 同机 + 同域代理最省事：证书、跨域、运维都简单。若确实要跨域，见 3.1 的三级覆盖。

### 2.7 自检与排错

```bash
curl -s http://127.0.0.1:7789/healthz | jq
# { "ok": true,
#   "room": { "players": 2 },
#   "npc": { "probeTotal": 13, "probeOnline": 11, "webTotal": 2, "webOnline": 1, "total": 15 },
#   "hub": { "url": "http://127.0.0.1:9911", "failures": 0, "nodes": 13 },
#   "websites": { "total": 2, "online": 1 } }
```

| 症状 | 先看哪里 |
|---|---|
| 鸡场显示「未联机」 | `healthz` 能否访问；反代是否转发了 `Upgrade` 头；端口是否被防火墙挡 |
| 场上没有探针鸡 | `hub.failures > 0` → 主控地址写错，或主控的公开页是关的（读不到 `/api/nodes`） |
| 某台机器的鸡在睡觉 | 该节点 `cpu_cores=0 && mem_total=0`（未接入），或 `online=false`（离线） |
| 探针鸡数量不对 | `npc.probeTotal` 与主控节点数对比；超过 240 台只放出前 240 只（快照带宽考虑） |
| 网站鸡不出现 | `websites` 是空数组，或全部探测失败 |
| 两人进去互相看不到 | 确认浏览器控制台里没有 `replaced`（那意味着两个标签共用了同一个身份） |

---

## 三、主题侧配置

### 3.1 联机地址（`theme/js/config.js`）

默认值就是同域的 `/room/ws`，与 2.6 的反向代理配套。三级覆盖，优先级从高到低：

```js
// 1) 地址栏临时试（刷新即失效）
https://你的面板/#farm&room=wss://other-host/ws
// 2) 本机长期改（控制台执行一次）
localStorage.setItem('chicken-probe:room', 'wss://your-host/room/ws')
// 3) 改源码随主题发布
export const ROOM_PATH = '/room/ws';
```

留空 `ROOM_PATH`（或把覆盖值设成空串）= **不联机**：鸡场只画你自己，不造假人。

### 3.2 主题里其它可调常量

| 位置 | 常量 | 作用 |
|---|---|---|
| `theme/js/config.js` | `REPORT_HZ` | 自己位置的上报频率（默认 20 次/秒） |
| `theme/js/net.js` | `MAX_DROP_MS` | 多久没收到帧就认为断了（默认 3 秒） |
| `theme/js/history.js` | `CACHE_TTL_MS` | 历史数据缓存时长（默认 60 秒） |
| `theme/js/panel.js` | `SPARK_CONCURRENCY` / `SPARK_LIMIT` | 卡片迷你曲线的并发数与总量限流 |
| `shared/physics.js` | `CONF.*` | 走速/重力/啄击/击退/连跳等玩法数值（与参考站对齐） |
| `server/npcs.js` | `FLEE_*` / `WALK_SPEED` | 节点鸡的闲逛与残血逃跑行为 |

### 3.3 面板的数据从哪来

面板与鸡场共用一套 hub 接口，都是**匿名可读**、不需要任何密钥：

| 用途 | 接口 |
|---|---|
| 节点列表（首屏） | `GET /api/nodes` |
| 实时推送（2 秒一帧） | `/api/ws` |
| 历史资源曲线 | `GET /api/nodes/{id}/metrics?hours=1\|6\|24\|168&points=300..1500&series=metrics` |
| 历史延迟与丢包 | 同上的 `series=ping`（多探测线 + `loss`） |
| 站点名 / 公开页开关 | `GET /api/me` |

匿名访客的历史窗口可能被主控夹小，界面会显示**实际拿到的窗口**。

---

## 四、本地开发（不需要 hub 也能跑）

```bash
npm install
npm run dev            # http://localhost:7788 —— 假 hub + 联机服务 + 鸡场
npm test               # 单测（node:test）
npm run smoke          # 协议冒烟（需先 npm run dev）
npm run build:theme    # 打包主题
```

`server/dev.js` 跑的是**和线上同一条链路**（主题只认识 `/api/nodes`、`/api/ws`、`/room/ws`），
只是数据源换成 `server/probe.js` 生成的假探针：假数据里故意造全了边界态 ——
离线、未接入、读数陈旧、指标读不到、CPU 告警、流量超限、即将到期、会抖动掉线的机器，
所以本地能验到每个状态，而不是靠"大概会发生"。**假数据只存在于本地开发，不进主题包。**

可调环境变量：`PORT`（默认 7788）。历史接口也一并伪造，且**同参数返回同样的数据**，
所以本地切换时间范围、点刷新时曲线不会乱跳。

### 交互级探针（单测抓不到的手感与交互问题）

手感、漂移、打击感、按钮点不动这类问题必须开真浏览器验。五个探针共用同一套前置：

```bash
msedge --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
       --user-data-dir=/tmp/edge-probe --remote-debugging-port=9333 about:blank &
```

| 探针 | 命令 | 判读 |
|---|---|---|
| 漂移 | `npm run probe:drift` | 按住 W 走 1.2 秒再松开、静置 6 秒：位移必须是 `[0,0,0]`，`myId` 必须等于 `netId`，`peers` 里不能有自己的 id |
| 抖动 / 朝向 | `npm run probe:motion` | 静置时状态只能是 `idle`（出现 `walk` 说明站着也在摆腿）；行走时**朝向与位移的一致性 > 0.7**（负数=倒着走）；按下鼠标后 `dragging` 必须为 true |
| 打击感 / 血条 | `npm run probe:action` | 走到一只离线探针鸡跟前出嘴：服务端要回 `npck`，且**目标名牌上的血量数字必须变小**；同时留一张 `.shots/hit.png` |
| 面板交互 | `npm run probe:panel` | **真实鼠标点击** ⟳ 与 ✕：刷新要让「更新于 hh:mm:ss」变掉，关闭要让抽屉收起；再点卡片要立即重新打开 |
| 残血逃跑 | `node tools/flee-probe.mjs` | 打到残血后：净逃开 ≥ 15 米、速度 > 5.4 m/s、单帧位移连续（不是瞬移） |

鸡场与面板各有一个调试缝读状态，只有带 `?dbg=1` 打开才挂到 `window`，常态页面不留全局对象。

**多标签页的身份**：玩家令牌存在 `sessionStorage` —— 刷新后还是同一只鸡，但同一个浏览器
开两个标签页会各拿一个身份。早先存在 `localStorage` 时两个标签会互相顶号（服务端不断回
`replaced`、连接反复重连），期间发出的啄击会整条丢掉。

---

## 五、面板（监控为主的那一面）

- **总览条**：节点数 / 告警台数 / 最忙 / 本月流量 / 7 天内到期，点数字直接筛出对应机器
- **筛选与排序**：状态（告警·离线·陈旧·即将到期·未接入）、地区、搜索、网格/列表；
  「问题优先」把需要动手的排在前面；筛选条件写进 URL，可以直接分享
- **节点卡**：CPU/内存/硬盘三个大数字 + 负载 + 实时速率 + 本月流量与配额条 + 到期/重置脚注；
  80% 转琥珀、92% 转红，告警时卡片左侧一道色条；**卡上还有近 1 小时的 CPU 迷你曲线**
- **节点详情**（点卡片打开）：
  - **资源** 页签：CPU / 内存 / 硬盘 / 网络 四张历史曲线，数据来自 hub 的历史接口
  - **网络延迟** 页签：多探测线的延迟曲线（同一时间轴上按 ts 归并）+ 每条线的丢包
  - **时间范围** 1 小时 / 6 小时 / 24 小时 / 7 天（延迟只到 24 小时）
  - 每个序列一格**当前 / 均值 / 峰值**，它同时充当图例；鼠标划过曲线有十字线与读数
  - 曲线末端接上最近一次实时推送（实心圆点标出），陈旧读数不会混进历史
  - 历史读不到时明确写出原因（例如「公开页已关闭」），当前值照旧实时
  - 深链：`?node=3&tab=latency&hours=24` 直接打开对应机器的对应视图

## 六、设计上的几个取舍

- **真人由客户端对自己权威**：本地立刻动、20Hz 上报，服务端只做越界兜底与啄倒判定。
  换来的是零延迟的手感，代价是不能防作弊（玩具功能，不划算为它做服务端回滚）。
- **节点鸡由服务端权威**：场上有什么鸡、站哪儿、什么姿态都是服务端算的，客户端只画。
  这样客户端完全不需要知道探针数据结构。
- **远端插值 130ms**：别人画出来的位置总比现在晚一点点，网络抖一下也不会一跳一跳。
- **一处判定、两处呈现**：面板卡片的状态、鸡的姿态、HUD 的告警数读的是同一个 `statusOf`
  （`shared/derive.js`），所以数字、列表、鸡的表现不会互相矛盾。
- **扇翅也是攻击**：范围比啄短，但没有方向限制；被啄/被扇都会被打退一段（击退冲量）。
- **节点鸡残血会跑**：血量掉到 1/3 以下时，它会以 **7.2 m/s**（比玩家疾跑 5.4 还快）朝背离开口者的方向
  连续跑 **最多 4.5 秒 / 22 米**；撞上鸡舍石头会侧移绕开，跑完**把窝挪到落脚点并原地歇 5 秒**
  （所以不会掉头往你这边走回来）。逃跑有 **6 秒冷却**，追着打的人总有机会补上一口。
  位置始终是每 1/10 秒推进一次、客户端插值渲染，不是瞬移。

## 七、目录结构

```
chicken-probe/
├── theme/            主题源码（打包后交给 hub 托管）
│   ├── index.html    面板 + 鸡场的 DOM
│   ├── style.css     两套配色的样式（面板 + 鸡场 HUD）
│   ├── theme.json    主题清单（name / short / version / url）
│   └── js/           面板、数据层、历史图表、鸡场、网络、音效、触屏
├── shared/           客户端与服务端共用：物理、状态判定、节点→鸡映射、插值、图表数学
├── server/           联机服务
│   ├── index.js      生产入口（--hub / --port / --config …）
│   ├── dev.js        本地开发服务器（假 hub + 联机房 + 静态托管）
│   ├── room.js       房间：真人同步、啄倒判定、计分、令牌续命
│   ├── npcs.js       探针鸡/网站鸡（服务端权威，含残血逃跑与主动啄人）
│   ├── sources.js    数据源：读 hub 节点 + 探测网站
│   └── probe.js      假探针数据（仅本地开发，不进主题包）
├── tools/            打包脚本与五个交互探针
└── test/             单测（node:test）
```

## 八、许可与致谢

MIT License，见 [LICENSE](LICENSE)。

- 国旗雪碧图取自同作者的另一个主题 `monitor-theme-monitor-simple`，素材是
  [country-flag-icons](https://github.com/UNITED-ELECTRONICS/country-flag-icons)（MIT）。
- 玩法与视觉参考了 [chicken.ggboom.de](https://chicken.ggboom.de/)（"养鸡VPS"）的公开页面，
  参数（走速、重力、啄击扇形、击退、连跳、地图物件、HUD 配色）按它对齐，代码为本项目自行实现。