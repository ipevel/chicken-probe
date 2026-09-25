// 冒烟测试：把 dev 服务器当成真的 hub，从协议层验一遍 ——
// 公开接口的形状、hub 实时流的节奏、联机房的握手与 NPC 名单、啄击判定（对 NPC 与对真人）、
// 健康检查，以及两个 WebSocket 端点能并存（它们挂在同一个 http server 上，
// 路径不匹配时谁 abort 谁就把对方打死 —— 这一条是踩过坑才加的）。
//
//   npm run dev        # 另开一个终端
//   node tools/smoke.mjs
//
// 端口用 PORT 环境变量覆盖。

import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 7788;
const base = `http://localhost:${PORT}`;
let failed = 0;

/**
 * 兜底定时器登记处。用例常常「该看到的都看到了就提前收工」，
 * 若不清掉这些定时器，它们会在收工后才触发、补一条假失败。
 */
const bailTimers = [];
const after = (ms, fn) => {
  const t = setTimeout(fn, ms);
  bailTimers.push(t);
  return t;
};

const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const open = (path) => new WebSocket(`ws://localhost:${PORT}${path}`);
const send = (ws, obj) => ws.send(JSON.stringify(obj));

// ---------------- HTTP：公开接口的形状 ----------------
const me = await (await fetch(`${base}/api/me`)).json();
check('/api/me 形状', typeof me.public_page === 'boolean' && typeof me.site_name === 'string', JSON.stringify(me));

const { nodes } = await (await fetch(`${base}/api/nodes`)).json();
check('/api/nodes 有节点', Array.isArray(nodes) && nodes.length > 0, `${nodes?.length ?? 0} 台`);
check('匿名 payload 不泄露 ip/hostname/remark/token',
  nodes.every(n => !('ip' in n) && !('hostname' in n) && !('remark' in n) && !('token' in n)));

const required = ['id', 'name', 'online', 'country', 'last_seen', 'metrics', 'cpu_cores', 'traffic_limit', 'expires_at'];
check('节点字段齐全', nodes.every(n => required.every(k => k in n)));

// 假数据必须覆盖所有边界态，否则面板与鸡场里的每个状态就没东西可验
const has = (pred, label) => check(`假数据含「${label}」`, nodes.some(pred));
has(n => n.online === false && n.last_seen > 0, '离线节点');
has(n => n.online === false && n.last_seen === 0, '未接入节点');
has(n => n.online && Date.now() / 1000 - n.last_seen > 120, '读数陈旧');
has(n => n.online && n.metrics && n.metrics.cpu == null, '指标读不到');
has(n => (n.metrics?.cpu ?? 0) >= 92, 'CPU 告警');
has(n => n.traffic_limit > 0 && n.month_used > n.traffic_limit, '流量超限');
has(n => n.expires_in != null && n.expires_in <= 7, '即将到期');

// ---------------- 节点历史：面板历史曲线的数据源 ----------------
const NODE = 1;                        // 东京 · Oracle：健康在线，历史该是最完整的一条
const histUrl = (id, qs) => `${base}/api/nodes/${id}/metrics?${qs}`;
const hist = async (id, qs) => (await fetch(histUrl(id, qs))).json();

const m = await hist(NODE, 'hours=24&points=300&series=metrics');
check('历史指标 series=metrics 有数据', Array.isArray(m.metrics) && m.metrics.length > 0, `${m.metrics?.length ?? 0} 点`);
check('历史指标每点字段齐全',
  m.metrics.every(p => ['ts', 'cpu', 'mem_used', 'disk_used', 'net_rx', 'net_tx'].every(k => k in p)));
check('历史指标 ts 单调递增', m.metrics.every((p, i) => i === 0 || p.ts > m.metrics[i - 1].ts));
// 5 分钟一格，24 小时只有 288 格 —— 要 300 个点也给不出来，但绝不能超过请求的点数
check('points=300 时条数落在 250~300（降采样生效）',
  m.metrics.length >= 250 && m.metrics.length <= 300, `${m.metrics.length} 点`);
const coarse = await hist(NODE, 'hours=24&points=120&series=metrics');
check('降采样到更少的点数', coarse.metrics.length <= 120 && coarse.metrics.length >= 100, `${coarse.metrics.length} 点`);

const pg = await hist(NODE, 'hours=6&points=300&series=ping');
const lineIds = Object.keys(pg.probes ?? {});
check('历史探测 series=ping 有数据', Array.isArray(pg.ping) && pg.ping.length > 0, `${pg.ping?.length ?? 0} 行`);
check('probes 是对象且至少 1 条线',
  lineIds.length >= 1 && lineIds.every(k => typeof pg.probes[k] === 'string'),
  lineIds.map(k => pg.probes[k]).join('、'));
const perLine = lineIds.map(k => pg.ping.filter(p => String(p.task_id) === k));
check('每条线按 ts 升序', perLine.every(rows => rows.length > 0 && rows.every((p, i) => i === 0 || p.ts > rows[i - 1].ts)));
// 多条线必须共享同一套 ts，否则客户端按 ts 拼不成一张对齐的表
const tsSet = new Set(perLine[0].map(p => p.ts));
check('多条探测线的 ts 对齐',
  perLine.every(rows => rows.length === perLine[0].length && rows.every(p => tsSet.has(p.ts))),
  `${lineIds.length} 条线 × ${perLine[0].length} 行`);
check('loss 落在 0~1',
  Object.values(pg.loss ?? {}).every(v => v >= 0 && v <= 1) && pg.ping.every(p => p.loss == null || (p.loss >= 0 && p.loss <= 1)),
  JSON.stringify(pg.loss));

// 匿名访客的窗口会被夹到上限：响应里的 hours 才是「实际窗口」，客户端要拿它显示
const wide = await hist(NODE, 'hours=168&points=300&series=metrics');
check('匿名窗口被夹到 ≤24 小时', wide.hours <= 24, `请求 168 → hours=${wide.hours}`);

// 同一份请求两次必须逐点一致：客户端刷新时曲线不能整条跳（ts 跳了曲线就会重排）
const rep1 = await hist(NODE, 'hours=6&points=300&series=metrics');
const rep2 = await hist(NODE, 'hours=6&points=300&series=metrics');
check('同参数两次请求 ts 序列完全一致',
  rep1.metrics.length === rep2.metrics.length && rep1.metrics.every((p, i) => p.ts === rep2.metrics[i].ts),
  `${rep1.metrics.length} 点`);
check('同参数两次请求数值也一致',
  rep1.metrics.every((p, i) => p.cpu === rep2.metrics[i].cpu && p.mem_used === rep2.metrics[i].mem_used));

// 边界态：服务器跑了几秒之后再看 —— 离线节点的 last_seen 第一帧还停在「已离线 340 秒」，
// 一个 tick 之后才落到它真正的失联时刻，用开头的快照去对时间轴会对不上
// tick 落地前的 last_seen = 启动时刻-340，落地后 = goneAt（≈now-60）：两个值差 280 秒，
// 轮询到差值进 120 秒阈值内就说明 tick 已经跑过，race 窗口内最多等 10 秒
let fresh;
for (let i = 0; i < 20; i++) {
  fresh = (await (await fetch(`${base}/api/nodes`)).json()).nodes;
  const off = fresh.find(n => !n.online && n.last_seen > 0);
  if (off && Math.abs(Date.now() / 1000 - off.last_seen) < 120) break;
  await new Promise(r => setTimeout(r, 500));
}
const offlineNode = fresh.find(n => !n.online && n.last_seen > 0);
const off = await hist(offlineNode.id, 'hours=24&points=300&series=metrics');
check('离线节点失联后不再有指标数据',
  off.metrics.length > 0 && off.metrics[off.metrics.length - 1].ts <= offlineNode.last_seen * 1000,
  `${off.metrics.length} 点，末点 ${new Date(off.metrics.at(-1)?.ts ?? 0).toISOString()}`);
const offPing = await hist(offlineNode.id, 'hours=24&points=300&series=ping');
check('离线节点失联后没有探测数据（latency 为 null）',
  offPing.ping.filter(p => p.ts > offlineNode.last_seen * 1000).every(p => p.latency === null),
  `${offPing.ping.filter(p => p.ts > offlineNode.last_seen * 1000).length} 行在失联之后`);

const unconnected = fresh.find(n => !n.online && n.last_seen === 0);
const un = await hist(unconnected.id, 'hours=24&points=300&series=metrics');
check('未接入节点的指标历史为空', Array.isArray(un.metrics) && un.metrics.length === 0, `${un.metrics?.length ?? 0} 点`);
const unPing = await hist(unconnected.id, 'hours=24&points=300&series=ping');
check('未接入节点没有探测线', unPing.ping.length === 0 && Object.keys(unPing.probes).length === 0);

// 「指标读不到」的机器：hub 有记录所以 ts 得留着，但核心字段一个都给不出来
const garbled = fresh.find(n => n.online && n.metrics && n.metrics.cpu == null);
const gm = await hist(garbled.id, 'hours=6&points=300&series=metrics');
check('指标读不到的机器保留 ts、核心字段为 null',
  gm.metrics.length > 0 && gm.metrics.every(p => Number.isFinite(p.ts) && p.cpu === null && p.mem_used === null && p.disk_used === null),
  `${gm.metrics.length} 点`);

const miss = await fetch(histUrl(9999, 'hours=1&series=metrics'));
check('未知节点的历史返回 404', miss.status === 404, `status=${miss.status}`);

// ---------------- hub 实时流：2 秒一帧，形状 {nodes, admin} ----------------
await new Promise((done) => {
  const ws = open('/api/ws');
  let frames = 0, shapeOk = true, gap = 0;
  const t0 = Date.now();
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    shapeOk = shapeOk && Array.isArray(m.nodes) && m.admin === false;
    if (++frames === 2) {
      gap = Date.now() - t0;
      ws.close();
    }
  });
  after(10000, () => { check('hub 实时流推送节奏', false, `10 秒只收到 ${frames} 帧`); ws.close(); });
  ws.on('error', () => { check('hub 实时流可连', false, '连接失败'); done(); });
  ws.on('close', () => {
    check('hub 实时流帧形状 {nodes, admin:false}', shapeOk);
    check('hub 实时流推送节奏 ≈2s', gap >= 1200 && gap <= 3500, `${gap}ms`);
    done();
  });
});

// ---------------- 联机房握手：welcome → 名单（含 NPC）→ 玩家快照 → NPC 位置帧 ----------------
await new Promise((done) => {
  const ws = open('/ws');
  const seen = new Set();
  let myId = null, snapHasMe = false, npcSeen = false, npcPos = false, npcHasHp = false, probeStats = null;
  const kinds = new Set();

  ws.on('open', () => send(ws, { t: 'hello', name: '冒烟测试鸡' }));
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    seen.add(m.t);
    if (m.t === 'w') {
      myId = m.id;
      check('welcome 带 token 与 id', !!m.token && !!m.id);
      send(ws, { t: 'st', x: 3, y: 0, z: 4, yaw: 0.2, st: 'walk' });
    }
    if (m.t === 'r') {
      probeStats = m.probe;
      if (Array.isArray(m.npcs) && m.npcs.length) {
        npcSeen = true;
        for (const n of m.npcs) kinds.add(n.kind);
        // 「别的鸡血条要会掉」：名单必须带血量，客户端才有得画
        npcHasHp = m.npcs.every(n => Number.isFinite(n.hp) && Number.isFinite(n.maxHp));
      }
    }
    if (m.t === 'n' && Array.isArray(m.ns) && m.ns.length) npcPos = true;
    if (m.t === 's' && myId && m.ps.some(p => p[0] === myId)) snapHasMe = true;
    // 该看到的都看到了就收工，不靠固定等秒数
    if (seen.has('w') && seen.has('r') && seen.has('n') && seen.has('s') && npcPos && snapHasMe) ws.close();
  });
  after(8000, () => { check('联机握手', false, `8 秒内只收到 ${[...seen].join(',') || '无'}`); ws.close(); });
  ws.on('error', () => { check('联机房可连', false, '连接失败'); done(); });
  ws.on('close', () => {
    check('收到欢迎帧', seen.has('w'));
    check('收到名单', seen.has('r'), [...seen].join(','));
    check('名单里有 NPC 鸡', npcSeen);
    check('NPC 里探针鸡与网站鸡都在', kinds.has('probe') && kinds.has('web'), [...kinds].join(','));
    check('名单带探针/网站在线数',
      !!probeStats && typeof probeStats.probeOnline === 'number' && typeof probeStats.webOnline === 'number',
      JSON.stringify(probeStats));
    check('NPC 名单带血量与满血量', npcHasHp);
    check('收到 NPC 位置帧 {t:"n"}', npcPos);
    // 服务端会把「你自己」也放进快照，客户端必须按自己的 id 过滤掉，
    // 否则会把残影当别人 —— 那会让鸡被自己的残影推着走（见 tools/drift-probe.mjs）
    check('玩家快照里有我自己（客户端需据此过滤自身）', snapHasMe);
    done();
  });
});

// ---------------- 啄倒 NPC：站到它跟前啄一口，服务端要有明确结果 ----------------
let sentPeck = false;
await new Promise((done) => {
  const ws = open('/ws');
  let npcs = [], finished = false;
  const finish = (ok, detail) => { if (!finished) { finished = true; check('啄 NPC 有明确结果', ok, detail); ws.close(); done(); } };
  ws.on('open', () => send(ws, { t: 'hello', name: '啄鸡测试' }));
  ws.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.t === 'r' && Array.isArray(m.npcs)) npcs = m.npcs;
    if (m.t === 'n' && npcs.length && !sentPeck) {
      sentPeck = true;
      const target = npcs.find(n => n.kind === 'probe') || npcs[0];
      const pos = m.ns.find(p => p[0] === target.id);
      if (pos) {
        // 站到它正前方 0.8 米以内再啄：这个距离必定在判定范围内
        send(ws, { t: 'st', x: pos[1], y: 0, z: pos[2] - 0.8, yaw: 0, st: 'peck' });
        setTimeout(() => send(ws, { t: 'peck' }), 80);
      }
    }
    if (m.t === 'ev' && ['npck', 'miss', 'peck', 'ko'].includes(m.k)) finish(true, m.k);
  });
  after(2500, () => finish(false, '2.5 秒内没有回结果'));
  ws.on('error', () => finish(false, '连接失败'));
});

// ---------------- 两个真人互啄：被打的那个必须掉血 ----------------
// 这条同时是客户端「被别的访客打也要掉血」的数据来源：事件带新血量、名单也同步
await new Promise((done) => {
  const a = open('/ws');
  const b = open('/ws');
  let idA = null, idB = null, hpInEvent = null, hpInRoster = null, evt = null;
  // A 站 B 南侧 1 米、朝 +z（yaw=0）正对 B —— 距离与朝向都在判定范围内
  const place = () => {
    if (!idA || !idB) return;
    send(a, { t: 'st', x: 0, y: 0, z: -1, yaw: 0, st: 'idle' });
    send(b, { t: 'st', x: 0, y: 0, z: 0, yaw: 0, st: 'idle' });
    setTimeout(() => send(a, { t: 'peck' }), 150);
  };
  a.on('open', () => send(a, { t: 'hello', name: '拳手A' }));
  b.on('open', () => send(b, { t: 'hello', name: '靶子B' }));
  a.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.t === 'w') { idA = m.id; place(); }
    if (m.t === 'ev' && m.k === 'miss') evt = 'miss';
  });
  b.on('message', (buf) => {
    const m = JSON.parse(String(buf));
    if (m.t === 'w') { idB = m.id; place(); }
    if (m.t === 'ev' && m.k === 'peck' && m.to === idB) { evt = 'peck'; hpInEvent = m.hp; }
    if (m.t === 'r' && idB) {
      const self = m.list.find(p => p.id === idB);
      if (self && self.hp < 100) hpInRoster = self.hp;
    }
  });
  after(3000, () => {
    check('互啄：被打的人收到带新血量的命中事件',
      evt === 'peck' && hpInEvent != null && hpInEvent < 100, `事件=${evt} hp=${hpInEvent}`);
    check('互啄：名单里的血量同步下降', hpInRoster != null && hpInRoster < 100, `名单 hp=${hpInRoster}`);
    a.close(); b.close(); done();
  });
});

// ---------------- 健康检查：运维要看的那几个数 ----------------
const health = await (await fetch(`${base}/healthz`)).json();
check('/healthz 有房间与 NPC 统计',
  health.ok === true && health.npc && typeof health.npc.probeTotal === 'number',
  JSON.stringify(health.npc));

// ---------------- 两个 WS 端点并存 ----------------
await new Promise((done) => {
  const a = open('/api/ws');
  const b = open('/ws');
  let okA = false, okB = false;
  a.on('message', () => { okA = true; });
  // 联机房在 hello 之前不发任何帧，得先报名才算「活着」
  b.on('open', () => send(b, { t: 'hello', name: '并存测试鸡' }));
  b.on('message', () => { okB = true; });
  after(2600, () => {
    check('hub 流与联机房并存（路径不匹配不许 abort 对方的 socket）', okA && okB,
      `/api/ws=${okA ? '活' : '死'} /ws=${okB ? '活' : '死'}`);
    a.close(); b.close(); done();
  });
});

for (const t of bailTimers) clearTimeout(t);   // 别让兜底定时器在收工后补假失败
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;