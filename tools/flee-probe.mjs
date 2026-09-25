// 残血逃跑探针：验证「没血了一口气跑很远、让人去追，而且是跑不是闪现」。
//
// 做法：连上联机房，把**自己的上报位置挪到某只探针鸡旁边**（位置是客户端上报的，
// 所以可以精准站到它跟前），连着啄到血量 ≤ 1/3 触发逃跑，然后按 10Hz 记录它的位置，
// 算出「总距离 / 实际速度 / 单帧最大位移」。
//
//   npm run dev              # 另开一个终端
//   node tools/flee-probe.mjs
//
// 可选：如果本地有带远程调试的无头浏览器开着（--remote-debugging-port=9333），
// 还会顺带核对客户端把逃跑中的鸡播成了 run（腿在跑）而不是滑行。
//
// 判读：总距离 ≥ 15 米、速度明显快过玩家疾跑 5.4、单帧位移 ≈ 速度/10 且无大跳。

import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 7788;
const PECK_GAP_MS = 620;        // > 服务端啄击冷却 500ms
const FLEE_WATCH_MS = 6000;     // 逃跑 4s + 歇息 5s 的前半段
const SNAP_HZ = 10;             // 服务端 NPC 位置帧频率（room.js 里 NPC_EVERY=2）

const open = () => new WebSocket(`ws://localhost:${PORT}/ws`);
const send = (ws, o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = open();
let npcs = [];
let positions = [];             // [{t, x, z}] 目标 NPC 的轨迹
const events = [];
let targetId = null;
let myId = null;

ws.on('open', () => send(ws, { t: 'hello', name: '逃跑探针' }));
ws.on('message', (buf) => {
  const m = JSON.parse(String(buf));
  if (m.t === 'w') myId = m.id;
  if (m.t === 'r') {
    npcs = m.npcs || [];
    if (!targetId) {
      // 挑一只在线、没倒地、且血量还健康的探针鸡 —— 刚被打倒的（hp 0）啄了也是 miss
      const pick = npcs.find((n) => n.kind === 'probe' && !n.offline && !n.ko && n.hp > n.maxHp / 3);
      if (pick) { targetId = pick.id; console.log(`靶子：${pick.id}「${pick.name}」 血量 ${pick.hp}/${pick.maxHp}`); }
    }
  }
  if (m.t === 'n' && targetId) {
    const row = (m.ns || []).find((p) => p[0] === targetId);
    if (row) positions.push({ t: Date.now(), x: row[1], z: row[2] });
  }
  if (m.t === 'ev') events.push(m);
});

// 等靶子出现
for (let i = 0; i < 40 && !targetId; i++) await sleep(100);
if (!targetId) { console.log('没找到可啄的探针鸡（检查 dev 服务器是否在跑）'); process.exit(1); }

/** 站到靶子跟前再啄：位置由客户端上报，所以可以精确站到它身前 0.9 米。 */
async function peckOnce() {
  const last = positions[positions.length - 1];
  if (!last) return false;
  // 朝向 +z（yaw=0）→ 目标要站在我正前方，所以我在它南侧 0.9 米
  send(ws, { t: 'st', x: last.x, y: 0, z: last.z - 0.9, yaw: 0, st: 'peck' });
  await sleep(60);
  send(ws, { t: 'peck' });
  return true;
}

console.log('连着啄到残血…');
let fled = false;
for (let i = 0; i < 14 && !fled; i++) {
  const now = npcs.find((n) => n.id === targetId);
  if (now?.ko) {
    // 打倒了：等它 3 秒后满血起身再继续（复活是设计的一部分）
    console.log('  打倒了，等它起身…');
    await sleep(3600);
    continue;
  }
  await peckOnce();
  await sleep(PECK_GAP_MS);
  const me = npcs.find((n) => n.id === targetId);
  fled = !!me && /逃跑/.test(me.label || '');
  if (me) console.log(`  第 ${i + 1} 口：血量 ${me.hp}/${me.maxHp}${fled ? ' → 逃跑中！' : ''}`);
}
if (!fled) { console.log('没触发逃跑（血量没降到 1/3 以下？）'); process.exit(1); }

// 从触发逃跑那一刻开始记轨迹
positions = [];
await sleep(FLEE_WATCH_MS);

const rows = positions;
const dist = rows.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - rows[i - 1].x, p.z - rows[i - 1].z) : 0), 0);
const steps = rows.slice(1).map((p, i) => Math.hypot(p.x - rows[i].x, p.z - rows[i].z));
const span = rows.length > 1 ? (rows[rows.length - 1].t - rows[0].t) / 1000 : 0;
const maxStep = steps.length ? Math.max(...steps) : 0;
const expectStep = 7.2 / SNAP_HZ;
const straight = rows.length > 1 ? Math.hypot(rows[rows.length - 1].x - rows[0].x, rows[rows.length - 1].z - rows[0].z) : 0;
const mid = steps.filter((v) => v > 0.05);

console.log('\n=== 逃跑轨迹 ===');
console.log(`采样 ${rows.length} 帧 / ${span.toFixed(2)} 秒`);
// 速度只统计「在动」的那些帧：逃完它会原地歇着，把静息段算进平均会低估真实速度
const movingSpeed = (mid.reduce((a, b) => a + b, 0) / Math.max(1, mid.length)) * SNAP_HZ;
console.log(`总距离 ${dist.toFixed(2)} 米，逃跑速度 ${movingSpeed.toFixed(2)} m/s（玩家疾跑 5.4）`);
console.log(`单帧位移：最大 ${maxStep.toFixed(2)} 米，均值 ${(mid.reduce((a, b) => a + b, 0) / Math.max(1, mid.length)).toFixed(2)} 米（7.2m/s ÷ 10Hz ≈ ${expectStep.toFixed(2)} 米）`);

console.log('轨迹（每 5 帧一个点）:');
for (let i = 0; i < rows.length; i += 5) {
  const p = rows[i];
  console.log(`  t+${((p.t - rows[0].t) / 1000).toFixed(1)}s  (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
}
console.log(`  坐标范围 x[${Math.min(...rows.map(r => r.x)).toFixed(1)}, ${Math.max(...rows.map(r => r.x)).toFixed(1)}]`,
  `z[${Math.min(...rows.map(r => r.z)).toFixed(1)}, ${Math.max(...rows.map(r => r.z)).toFixed(1)}]（边界 ±25.4）`);
console.log('结论：',
  straight >= 15 ? `✅ 跑得够远（净逃开 ${straight.toFixed(1)} 米）` : `❌ 跑得太近（${straight.toFixed(1)} 米）`,
  '|',
  movingSpeed > 5.4 ? `✅ 快过玩家疾跑（${movingSpeed.toFixed(1)} m/s）` : `❌ 不够快（${movingSpeed.toFixed(1)} m/s）`,
  '|',
  maxStep <= expectStep * 2.2 ? '✅ 是连续推进（不是闪现）' : `❌ 出现大跳 ${maxStep.toFixed(2)} 米`);

// 可选：核对客户端的动作（有 CDP 浏览器就看一眼）
try {
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  // 按 URL 挑：列表里第一个 page 常是 Edge 自己的对话框/扩展页
  const page = list.find((t) => t.type === 'page' && /7788|localhost/.test(t.url)) || list.find((t) => t.type === 'page');
  if (page) {
    const { WebSocket: WsClient } = await import('ws');
    const cdp = new WsClient(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); cdp.send(JSON.stringify({ id: i, method, params })); });
    cdp.on('message', (b) => { const m = JSON.parse(String(b)); if (m.id && pending.has(m.id)) pending.get(m.id)(m.result); });
    await new Promise((r) => cdp.on('open', r));
    const debug = async () => JSON.parse((await cmd('Runtime.evaluate', { expression: 'window.__farmDebug ? JSON.stringify(window.__farmDebug()) : "null"', returnByValue: true }))?.result?.value || 'null');
    const st = await debug();
    if (st) {
      const seen = st.npcs.find((n) => /逃跑/.test(n.label || '')) || null;
      console.log('\n=== 客户端渲染 ===');
      console.log(seen
        ? `逃跑中的鸡：渲染状态=${seen.state} 实测速度=${seen.speed} m/s ${seen.state === 'run' ? '✅ 在跑（腿会动）' : '❌ 不是跑步动作'}}`
        : '（此刻没有正在逃跑的鸡，跳过）');
    }
    cdp.close();
  }
} catch { /* 没有调试端口就跳过，不影响服务端结论 */ }

process.exit(0);