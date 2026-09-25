// 动作探针：让程序自己走到最近的探针鸡跟前啄一口，验证「打击感」与「血条会掉」这两条
// 光靠读代码证不了的诉求 —— 走到位、出嘴、看名牌上真正画出来的血量有没有变。
//
// 前置（与其它探针相同）：
//   msedge --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
//          --user-data-dir=/tmp/edge-action --remote-debugging-port=9333 about:blank &
//   node tools/action-probe.mjs
//
// 判读：命中后目标名牌签名里的 hp 必须变小（签名就是画上去的那份内容）；
// 同时在 .shots/hit.png 留一张命中瞬间的截图，用眼睛看羽毛/红闪有没有出来。

import { WebSocket } from 'ws';
import { writeFile } from 'node:fs/promises';

const base = 'http://127.0.0.1:9333';
const list = await (await fetch(`${base}/json/list`)).json();
// 目标列表里第一个 page 常常是 Edge 自己的对话框/扩展页，必须按 URL 挑本地页面
const page = list.find((t) => t.type === 'page' && /7788|localhost/.test(t.url)) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.on('message', (b) => {
  const m = JSON.parse(String(b));
  if (m.id && pending.has(m.id)) pending.get(m.id)(m.result);
});
await new Promise((r) => ws.on('open', r));

const evalJs = async (expr) => (await send('Runtime.evaluate', {
  expression: expr, awaitPromise: true, returnByValue: true,
}))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = async () => JSON.parse(await evalJs('window.__farmDebug ? JSON.stringify(window.__farmDebug()) : "null"'));

const KEYS = { KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyE: 69 };
const keyDown = (code) => send('Input.dispatchKeyEvent', {
  type: 'keyDown', code, key: code.slice(-1).toLowerCase(), windowsVirtualKeyCode: KEYS[code], nativeVirtualKeyCode: KEYS[code],
});
const keyUp = (code) => send('Input.dispatchKeyEvent', {
  type: 'keyUp', code, key: code.slice(-1).toLowerCase(), windowsVirtualKeyCode: KEYS[code], nativeVirtualKeyCode: KEYS[code],
});
const held = new Set();
const hold = async (codes) => {
  for (const c of [...held]) if (!codes.includes(c)) { await keyUp(c); held.delete(c); }
  for (const c of codes) if (!held.has(c)) { await keyDown(c); held.add(c); }
};
const releaseAll = async () => { for (const c of [...held]) { await keyUp(c); held.delete(c); } };

await send('Page.navigate', { url: `http://localhost:7788/?dbg=1&action=${Date.now()}#farm` });
await sleep(2500);
// 身份令牌存在 localStorage 里：同 profile 复制过来的旧 token 会让服务端把这条连接
// 当成「重复登录」顶掉（事件 replaced），后面出嘴就送不到。先清掉再重载，拿个干净身份。
await evalJs("localStorage.removeItem('chicken-probe:token'); 'cleared'");
await send('Page.reload', { ignoreCache: true });
await sleep(6000);

let st = await debug();
if (!st) { console.log('页面上没有调试缝（要用 ?dbg=1 打开）'); process.exit(1); }

// 挑靶子：优先「离线倒地」的探针鸡 —— 服务端把它摆成 dead 姿态且不移动，
// 瞄准不会追不上（闲逛中的鸡速度 1.15m/s，追猎式瞄准很难把朝向卡进扇形）
const pickTarget = () => {
  const me = st.mePos;
  const dist = (n) => Math.hypot(n.pos[0] - me[0], n.pos[2] - me[2]);
  const still = st.npcs.filter((n) => n.id.startsWith('p') && n.plateSig && n.plateSig.includes('|1|0') === false);
  const pool = st.npcs.filter((n) => n.id.startsWith('p'));
  const stationary = pool.filter((n) => /离线|未接入/.test(n.label || ''));
  const pick = (stationary.length ? stationary : pool).sort((a, b) => dist(a) - dist(b))[0];
  return pick ? { ...pick, d: dist(pick) } : null;
};

// 挑最近的探针鸡当目标
const nearest = () => {
  const me = st.mePos;
  let best = null;
  for (const n of st.npcs) {
    const d = Math.hypot(n.pos[0] - me[0], n.pos[2] - me[2]);
    if (!best || d < best.d) best = { ...n, d };
  }
  return best;
};

// 走到目标跟前：把世界方向投影到「相机前后 / 左右」两个轴上按键
const walkTo = async (target, stopAt = 1.2, budgetMs = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    st = await debug();
    const me = st.mePos;
    const dx = target.pos[0] - me[0], dz = target.pos[2] - me[2];
    const d = Math.hypot(dx, dz);
    if (d <= stopAt) { await releaseAll(); return d; }
    const ux = dx / d, uz = dz / d;
    // 相机约定：前 = (-sin, -cos)，右 = (cos, -sin)（见 farm.js 里那段注释）
    const fwd = ux * -Math.sin(st.camYaw) + uz * -Math.cos(st.camYaw);
    const str = ux * Math.cos(st.camYaw) + uz * -Math.sin(st.camYaw);
    const codes = [];
    if (fwd > 0.25) codes.push('KeyW');
    else if (fwd < -0.25) codes.push('KeyS');
    if (str > 0.25) codes.push('KeyD');
    else if (str < -0.25) codes.push('KeyA');
    await hold(codes);
    await sleep(180);
  }
  await releaseAll();
  return null;
};

const target = pickTarget() || nearest();
console.log(`目标：${target.id}「${target.label}」在 ${target.d.toFixed(1)}m 外，名牌签名=${target.plateSig}`);
const reached = await walkTo(target);
console.log(reached == null ? '没走到跟前（把 stopAt 放宽或延长预算）' : `走到 ${reached.toFixed(2)}m 处`);
await sleep(250);

/** 对准 + 出嘴：每帧看朝向与目标方向的一致性，偏了就再走一小步让它转身。 */
async function aimAndPeck(id, tries = 10) {
  for (let i = 0; i < tries; i++) {
    st = await debug();
    const t = st.npcs.find((n) => n.id === id);
    if (!t) return '目标不在场了';
    const dx = t.pos[0] - st.mePos[0], dz = t.pos[2] - st.mePos[2];
    const d = Math.hypot(dx, dz);
    const ux = dx / (d || 1), uz = dz / (d || 1);
    const facing = Math.sin(st.meYaw) * ux + Math.cos(st.meYaw) * uz;   // 朝向与目标方向的一致性
    // 判定扇形是 110°（cos ≥ cos(0.95) ≈ 0.58），这里留足余量到 0.8
    if (d <= 1.5 && facing > 0.8) {
      await releaseAll();
      await keyDown('KeyE');
      await sleep(60);
      await keyUp('KeyE');
      return `在 ${d.toFixed(2)}m、朝向一致性 ${facing.toFixed(2)} 处出嘴`;
    }
    // 没对准：朝目标迈一小步（它会顺手把 yaw 转过去）
    const fwd = ux * -Math.sin(st.camYaw) + uz * -Math.cos(st.camYaw);
    const str = ux * Math.cos(st.camYaw) + uz * -Math.sin(st.camYaw);
    const codes = [];
    if (fwd > 0.25) codes.push('KeyW'); else if (fwd < -0.25) codes.push('KeyS');
    if (str > 0.25) codes.push('KeyD'); else if (str < -0.25) codes.push('KeyA');
    await hold(d ? codes : []);
    await sleep(140);
  }
  await releaseAll();
  return '十次都没对准（目标可能在躲）';
}

const before = (await debug()).npcs.find((n) => n.id === target.id);
console.log('出嘴情况:', await aimAndPeck(target.id));
await sleep(120);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  await writeFile(new URL('../.shots/hit.png', import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log('命中瞬间截图已存 .shots/hit.png');
}
await sleep(700);
const after = (await debug()).npcs.find((n) => n.id === target.id);

const hpOf = (sig) => {
  const parts = String(sig || '').split('|');
  // 签名形如 …|hp|cpu|mem：hp 是倒数第三个字段
  return parts.length >= 3 ? parts[parts.length - 3] : null;
};
const lastEv = (await debug()).lastEvent;
console.log('服务端最近一条事件:', JSON.stringify(lastEv));
console.log(`名牌血量：${hpOf(before?.plateSig)} → ${hpOf(after?.plateSig)}  (meta: ${before?.hp}/${before?.maxHp} → ${after?.hp}/${after?.maxHp})`);
console.log(reached != null && hpOf(before?.plateSig) !== hpOf(after?.plateSig)
  ? '✅ 命中生效：目标血量在名牌上真的变了'
  : '❌ 血量没变：要么没打中（距离/朝向），要么客户端没把 meta.hp 画上去');

await releaseAll();
process.exit(0);