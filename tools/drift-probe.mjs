// 漂移探针：用 CDP 驱动无头 Edge 加载鸡场，采样一次、无输入静置 8 秒、再采样，
// 逐项对比「相机 / 我的鸡（物理体与渲染位）/ 节点鸡」动了多少。
//
//   msedge.exe --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader //     --user-data-dir=<唯一目录> --remote-debugging-port=9333 about:blank &
//   node tools/drift-probe.mjs
//
// 哪些量「不该动」：没有输入时身体位移必须为 0；kx/kz 只应来自击退并衰减到 0。
// 相机与节点鸡允许有微小变化（插值/闲逛），但量级应是毫米级而不是米级。
import { WebSocket } from 'ws';
const PORT = 9333;
const base = `http://127.0.0.1:${PORT}`;
const list = await (await fetch(`${base}/json/list`)).json();
// 按 URL 挑目标：列表里第一个 page 常是 Edge 自己的对话框/扩展页
const page = list.find(t => t.type === 'page' && /7788|localhost/.test(t.url)) || list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.on('message', (b) => { const m = JSON.parse(String(b)); if (m.id && pending.has(m.id)) pending.get(m.id)(m.result); });
await new Promise(r => ws.on('open', r));
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
};
// 每次换一个查询串：hash 路由不会重载页面，固定 URL 会让探针验的还是上一版 JS
await send('Page.navigate', { url: `http://localhost:7788/?dbg=1&drift=${Date.now()}#farm` });
await new Promise(r => setTimeout(r, 6000));          // 等挂载 + 首帧
// 真实输入：按住 W 走 1.2 秒再松开 —— 「停下来之后还在滑」才是用户看到的现象
const key = async (type) => send('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
await key('keyDown');
await new Promise(r => setTimeout(r, 1200));
await key('keyUp');
await new Promise(r => setTimeout(r, 500));           // 等它停稳
const a = await evalJs('window.__farmDebug ? JSON.stringify(window.__farmDebug()) : "no-hook"');
await new Promise(r => setTimeout(r, 6000));          // 再静置 6 秒，这期间不该再动
const b = await evalJs('window.__farmDebug ? JSON.stringify(window.__farmDebug()) : "no-hook"');
console.log('t0:', a);
console.log('t1:', b);
const A = JSON.parse(a), B = JSON.parse(b);
const d = (p, q) => [p[0]-q[0], p[1]-q[1], p[2]-q[2]].map(v => +v.toFixed(3));
console.log('myId:', A.myId, 'netId:', A.netId, 'peers:', A.peers);
console.log('相机位移:', d(B.camera, A.camera));
console.log('身体位移:', d([B.body.x, 0, B.body.z], [A.body.x, 0, A.body.z]), 'kx/kz:', A.body.kx, A.body.kz, '→', B.body.kx, B.body.kz);
console.log('我的鸡渲染位位移:', d(B.mePos, A.mePos));
console.log('yaw 变化:', (B.yaw - A.yaw).toFixed(3), 'camYaw 变化:', (B.camYaw - A.camYaw).toFixed(3));
for (let i = 0; i < Math.min(A.npcs.length, B.npcs.length); i++) {
  console.log(`NPC ${A.npcs[i].id} 位移:`, d(B.npcs[i].pos, A.npcs[i].pos));
}
process.exit(0);
