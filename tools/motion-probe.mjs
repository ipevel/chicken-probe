// 动作探针：量两件靠肉眼说不清的事 ——
//   A. 站着不动时，鸡有没有高频抖动（逐帧采样，看各量的振幅与翻转次数）
//   B. 移动时，鸡的朝向是不是朝着它实际走的方向（朝向与位移的点积必须为正）
//
// 前置：起一个带远程调试的无头浏览器（与 drift-probe 相同）
//   msedge --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
//          --user-data-dir=/tmp/edge-motion --remote-debugging-port=9333 about:blank &
// 然后：node tools/motion-probe.mjs

import { WebSocket } from 'ws';

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
const key = (type) => send('Input.dispatchKeyEvent', {
  type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87,
});

// 每次换查询串：hash 路由不会重载页面，固定 URL 会验到上一版 JS
await send('Page.navigate', { url: `http://localhost:7788/?dbg=1&motion=${Date.now()}#farm` });
await sleep(6000);

async function sample(times, gapMs) {
  const out = [];
  for (let i = 0; i < times; i++) {
    const raw = await evalJs('window.__farmDebug ? JSON.stringify(window.__farmDebug()) : "no-hook"');
    if (raw === 'no-hook') throw new Error('页面上没有调试缝（要用 ?dbg=1 打开）');
    out.push(JSON.parse(raw));
    await sleep(gapMs);
  }
  return out;
}

const range = (arr) => Math.max(...arr) - Math.min(...arr);
const col = (rows, pick) => rows.map(pick);

console.log('=== A. 站着不动 1.5 秒（每 50ms 采一次）===');
const still = await sample(30, 50);
const bodyX = col(still, (s) => s.mePos[0]);
const bodyZ = col(still, (s) => s.mePos[2]);
const bodyY = col(still, (s) => s.meBody ? s.meBody[1] : 0);
const bodyShake = col(still, (s) => s.meBody ? s.meBody[0] : 0);
const yaws = col(still, (s) => s.meYaw);
const states = col(still, (s) => s.meState);
console.log('帧号跨度:', still[still.length - 1].frames - still[0].frames,
  '| 状态集合:', [...new Set(states)].join(','));
console.log('kx/kz 采样:', still.map((s) => `${s.body.kx}/${s.body.kz}`).slice(0, 6).join(' '),
  '| 朝向采样:', yaws.slice(0, 4).map((v) => v.toFixed(3)).join(' '));
console.log('位置振幅 x/z:', range(bodyX).toFixed(4), '/', range(bodyZ).toFixed(4), '米');
console.log('鸡身 y 振幅:', range(bodyY).toFixed(4), '| 鸡身 x 抖动振幅:', range(bodyShake).toFixed(4));
console.log('朝向振幅:', range(yaws).toFixed(4), '弧度');
const flips = states.reduce((n, s, i) => n + (i && s !== states[i - 1] ? 1 : 0), 0);
console.log('状态翻转次数:', flips, flips > 2 ? '← 高频切换，会看起来发抖' : '（正常）');

console.log('=== B. 按住 W 走 1.5 秒，边走边采，看朝向与位移是否一致 ===');
await key('keyDown');
await sleep(300);                       // 先让它走起来，避免起手帧
const moved = await sample(4, 300);     // 行走期间采样
await key('keyUp');
const a = moved[0], b = moved[moved.length - 1];
const dx = b.mePos[0] - a.mePos[0];
const dz = b.mePos[2] - a.mePos[2];
const dist = Math.hypot(dx, dz);
console.log('行走期间状态:', moved.map((s) => s.meState).join(','), '| 位置序列:',
  moved.map((s) => `${s.mePos[0].toFixed(2)},${s.mePos[2].toFixed(2)}`).join(' → '));
// 朝向约定：yaw=0 面向 +Z（模型的喙在 +Z 一侧），所以前进方向应为 (sin(yaw), cos(yaw))
const fx = Math.sin(b.meYaw), fz = Math.cos(b.meYaw);
const align = dist > 1e-4 ? (dx * fx + dz * fz) / dist : 0;
console.log(`位移向量 (${dx.toFixed(2)}, ${dz.toFixed(2)}) 长度 ${dist.toFixed(2)}m`);
console.log(`朝向 ${b.meYaw.toFixed(3)} rad → 面朝 (${fx.toFixed(2)}, ${fz.toFixed(2)})`);
console.log(`朝向与位移的一致性 ${align.toFixed(3)}`, align > 0.7 ? '（正确：朝着走的方向）' : '← 错误：在倒着走/侧着走');

console.log('=== C. 按下鼠标能不能进入「拖动转视角」状态 ===');
// 判据不依赖 movementX（无头环境里合成事件的 movementX 常为 0，量不出来）：
// 旧代码在「请求指针锁定」之后直接 return，dragging 永远是 false —— 一旦锁定失败
// 就彻底转不了视角。所以正确性判据是：canvas 上按下鼠标后 dragging 必须为 true。
const dragState = await evalJs(`(() => {
  const el = document.querySelector('#app canvas');
  if (!el) return JSON.stringify({ err: 'no-canvas' });
  const mk = (type, extra) => new PointerEvent(type, Object.assign({
    pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true, button: 0, buttons: 1,
  }, extra));
  el.dispatchEvent(mk('pointerdown', { clientX: 500, clientY: 400 }));
  const during = window.__farmDebug().dragging;
  const lockedDuring = window.__farmDebug().locked;
  el.dispatchEvent(mk('pointermove', { clientX: 520, clientY: 410, movementX: 20, movementY: 10 }));
  const yawAfterMove = window.__farmDebug().camYaw;
  el.dispatchEvent(mk('pointerup', { clientX: 520, clientY: 410, buttons: 0 }));
  return JSON.stringify({ during, lockedDuring, yawAfterMove, afterUp: window.__farmDebug().dragging });
})()`);
const st = JSON.parse(dragState || '{}');
console.log('按下鼠标后 dragging =', st.during, '（locked =', st.lockedDuring, '）; 抬起后 dragging =', st.afterUp);
console.log(st.during === true
  ? '✅ 按下即进入拖动状态：指针锁定失败时也能转视角'
  : '❌ 按下没有进入拖动状态 —— 这就是「没法切换视角」的 bug');

process.exit(0);