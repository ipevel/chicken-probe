# 版本策略

本仓库遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。本文说明「什么算破坏性变更」、
版本号与 tag 怎么写，以及 CI 门禁会拦什么。改版本号前请先读完前两节。

本项目当前处于 **0.y.z 初始开发期**（现在 0.4.3）：接口还没冻结，1.0.0 之前
SemVer 不承诺稳定性。见第 3 节。

## 1. 什么是本项目的公共 API

这个仓库同时发**主题包**（装进 hub 面板）和**联机服务**（跑在主控机器上），
两者通过 WebSocket 协议耦合。已装的主题和已部署的服务是两个独立更新的东西——
面板里的主题可能比服务器新，也可能旧——所以下面每一项都要单独记账。

| 公共 API | 具体范围 | 谁在依赖 |
| --- | --- | --- |
| 主题包格式 | `theme/theme.json` 的字段、`dist/` 结构、资产名必须是 `theme.tar.gz` | hub 面板的安装与一键更新 |
| 联机协议 | `server/room.js` 广播的每一类消息及其字段（`join`/`state`/`npck`/`flap`/`down`/`event`/`replaced` …） | `theme/js/net.js` |
| 状态判定 | `shared/derive.js` 的 `statusOf`：面板卡片、鸡的姿态、HUD 告警数读的是同一份判定 | 面板与鸡场必须一致，见 README 第六节 |
| 联机服务配置 | `server/config.json` 的字段（`hub`/`host`/`port`/`path`/`static`/`websites`）、命令行参数、`PORT` 环境变量 | `deploy.sh`、systemd unit、运维脚本 |
| `/healthz` 响应结构 | `ok` / `room` / `npc` / `hub` / `websites` 五个键 | README 2.7 的排错表、监控 |
| hub 接口消费集合 | `GET /api/nodes`、`/api/ws`、`GET /api/nodes/{id}/metrics`、`GET /api/me`，以及从它们读出的字段：`/api/me` 的 `site_name` 与 `history_days`（v1.3.2 起）、指标行的 `cpu`/`mem_used`/`disk_used`/`net_rx`/`net_tx`/`net_rx_max`/`net_tx_max`（后两者 v1.3.1 起）/`cpu_max`/`minutes`（后两者 v1.3.2 起）、响应的 `hours` 与 `step`（v1.3.2 起） | 主题首屏、范围按钮、曲线与峰值线、覆盖度说明 |
| 部署契约 | `deploy.sh` 的命令行选项、`chicken-room` 服务名、反代路径 `/room/`、默认端口 7789 | README 第二章的每一条命令 |
| 浏览器存储键 | `chicken-probe:room`（localStorage）、玩家令牌所在的 sessionStorage | 用户的本地覆盖与多标签页身份 |

### 已知的部署顺序陷阱

`deploy.sh` 从 `main` 拉服务端，主题则由用户在面板里单独更新。**两者不会自动同步**，
所以协议类改动（表里第 2 行）即使只是「加一条消息」，也要按向后兼容处理：
客户端遇到不认识的字段必须忽略、服务端不能假设客户端是同版本。

## 2. MAJOR / MINOR / PATCH 怎么定

| 递增位 | 何时递增 | 本项目典型例子 |
| --- | --- | --- |
| **MAJOR**（X） | 删除或重命名联机消息字段 / 消息类型；改 `statusOf` 的判定口径；改 `server/config.json` 或命令行参数的含义；改 `/healthz` 结构；把部署契约里的路径、端口、服务名换掉 | 把 `npck` 的 `icon` 从自由字符串改成枚举 |
| **MINOR**（Y） | 新增消息类型或可选字段（老客户端能忽略）；新增面板功能页签 / 节点指标；新增 `websites` 项的字段；新增 `deploy.sh` 选项 | v0.3.0 面板右上角「管理」入口、v0.4.0 残血逃跑、**v0.5.0 跟上 hub v1.3.2 的新字段**（范围铺到 `history_days`、CPU 峰值线、覆盖度说明、`public_remark`） |
| **PATCH**（Z） | 纯修复：数值算错、文案错、排序错、图标缺失、动效抖动、CI 缺陷、许可证补齐 | v0.4.2 撤回 0.4.1 的 SVG sprite、v0.4.3 修图表读数 |

判断口诀：**已装的主题 + 已部署的服务，在不重新部署任何一方的前提下还能不能继续用**。
不能 → MAJOR；能，且多出新东西 → MINOR；能，且什么都没变 → PATCH。

## 3. 版本号与 tag 的规则

- **版本号形态**：`X.Y.Z`，三段，非负整数且无前导零。`0.4` 和 `0.04.3` 都不是合法版本号。
- **两处声明必须相同**：`package.json` 的 `version` 与 `theme/theme.json` 的 `version`。
  注意路径——本仓库的清单在 `theme/theme.json`，不在仓库根。
- **tag 形态**：`v` + 版本号，例如 `v0.4.3`。tag 名必须与 `theme/theme.json` 的值精确对应。
- **1.0.0 的门槛**：面板与鸡场两条主流程稳定可用、联机协议冻结、`deploy.sh` 覆盖全部
  部署方式。在此之前都是初始开发期，SemVer 不承诺 `0.y.z` 的稳定性。
  升到 1.0.0 之后，请从 `release.yml` 的门禁里删掉 `--zero-major-lenient`，
  「feat 却只升 PATCH」随即从警告变成阻断。
- **新 tag 一律用 annotated**：`git tag -a v0.4.3 -m "v0.4.3"`。轻量 tag 没有作者与时间，
  `git describe` 和 Release 页面都读不出来。
- **已发布的 tag 不动**：本仓库历史上有一部分轻量 tag，**不追溯改写**。重打 tag 会改变
  它的对象 ID，等同于篡改一个已经发布出去的版本。
- **版本号不能被消耗**：一个版本号一旦写进 `theme/theme.json` 并合入主干，就意味着它被
  消耗了，随后必须真的发布——CI 的历史审计会揪出「写进代码却从未打 tag」的版本号。
  **发布顺序是：先改版本号并合并 → 再打 tag → 再 push tag。**

## 4. 已发布的版本不可修改、不可复用

- 同一个版本号只发布一次。要修就发新版本号，不回头改旧版本号的代码。
- 不用更低的版本号重新发布（已发布 `v0.4.3` 后再发 `v0.4.3-rc.1` 不允许）。
- 0.4.1 换成 SVG sprite、0.4.2 全部撤回，是**发新版本**而不是改 0.4.1——
  这正是本节要的：用户从 0.4.0 直接升到 0.4.2 拿到的就是正确的那套图标。

## 5. CI 门禁

`.github/workflows/release.yml` 在 `npm ci` / `npm test` / `npm run build:theme` 之前先跑
`tools/version_gate.py`，**几十秒内失败**，不必等依赖装完。检查项：

| 级别 | 检查 | 拦截什么 |
| --- | --- | --- |
| 阻断 | 版本号格式合法 | `0.4`、`0.04.3` |
| 阻断 | tag 与 `theme/theme.json` 版本号一致 | 手滑打错 tag |
| 阻断 | `package.json` 与 `theme/theme.json` 版本号一致 | 只改了一处 |
| 阻断 | 版本号严格大于所有已发布版本 | 版本号回退、复用、事后补预发布号 |
| 阻断 | 历史审计：有版本号被写进代码却从未打 tag | 版本序列出现空洞 |
| 警告 | 0.y.z 期间区间提交类型与递增位不匹配 | 0.4.1 那类「新功能发补丁版」，1.0.0 后转为阻断 |
| 告警 | tag 已存在且是 HEAD 祖先 | 同一 tag 重复发布（合法重跑，不拦） |

原有那两条版本检查（`theme.json 与 package.json 版本必须一致`、`tag 必须与 theme.json 版本一致`）
保留着：它们是发布不变量的直白表述，门禁在此之上多做「这一版应该更高吗」的判断。

**逃生阀**：`workflow_dispatch` 的 `gateMode` 参数可选 `strict`（默认）/ `warn` / `off`。
`warn` 把阻断项降级为告警并继续发布，`off` 整个跳过。tag push 触发时恒为 `strict`。

### 本地先跑一遍

```bash
npm test

python3 tools/version_gate.py \
  --tag v0.4.4 \
  --version-file package.json:version \
  --version-file theme/theme.json:version \
  --check-commits \
  --zero-major-lenient

# 历史审计（CI 里 strict 模式会跑）
python3 tools/version_gate.py --audit-history theme/theme.json:version
```

## 6. 相关文档

- [README.md](README.md) —— 部署、联机协议、排错、设计取舍
- [docs/](docs/) —— 视觉改造规格（含可执行判据）
- [tools/version_gate.py](tools/version_gate.py) —— 门禁实现
