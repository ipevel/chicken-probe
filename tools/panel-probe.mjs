// 面板交互探针：用**真实鼠标点击**验证详情页的两个按钮 ——
// 刷新（⟳）与关闭（✕）。这两个按钮曾经一起失效：模块 import 遮蔽了 window.history，
// 关闭时写 URL 抛错就中断了，看起来像"按钮没绑上"。所以这里点真格的，不调 .click()。
//
// 前置（与其它探针相同）：
//   msedge --headless=new --enable-unsafe-swiftshader --use-angle=swiftshader \
//          --user-data-dir=/tmp/edge-panel --remote-debugging-port=9333 about:blank &
//   node tools/panel-probe.mjs

import { WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 7788;
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page' && /7788|localhost/.test(t.url)) || list.find((t) => t.type === 'page');
if (!page) { console.log('没有可用的页面目标（先起一个无头浏览器）'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
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

const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y) => {
  const p = { x, y, button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...p });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...p });
};
const centerOf = async (expr) => JSON.parse(await ev(`(() => { const el = ${expr}; if (!el) return 'null'; const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y); return JSON.stringify({ x, y, hit: !!top && (top === el || el.contains(top)) }); })()`));

// 有些无头环境里 elementFromPoint 恒为 null（没有可见画布 → 不做命中测试），
// 真实鼠标点击会落空。这种情况下退回 JS 点击并**明确标注**：仍然验到处理函数，
// 但"能不能被点到"这一层就没验到 —— 不能让它冒充通过。
let jsFallback = 0;
const clickEl = async (expr, label) => {
  const c = await centerOf(expr);
  if (c.hit) {
    await click(c.x, c.y);
    return 'real';
  }
  jsFallback++;
  await ev(`${expr}.click(), 'ok'`);
  console.log(`   ⚠️ ${label}：本环境命中测试不可用，退回 JS 点击（处理函数已验证，点击可达性未验证）`);
  return 'js';
};

await send('Page.navigate', { url: `http://localhost:${PORT}/?dbg=1&node=1&panel=${Date.now()}` });
await sleep(6500);

const hud = await ev('window.__panelDebug ? JSON.stringify(window.__panelDebug()) : null');
check('页面挂上了调试缝（?dbg=1）', !!hud);
if (!hud) { process.exit(1); }

const opened = await ev("document.querySelector('.drawer') && document.querySelector('.drawer').className");
check('对着 URL 里的 node 打开了详情', /drawer/.test(String(opened)) && !/closed/.test(String(opened)), String(opened));
check('详情里有历史曲线', (await ev("document.querySelectorAll('.drawer .chart').length")) > 0);

// 1) 真实点击刷新：时间戳必须变
const t0 = await ev("(document.querySelector('.drawer .fetched') || {}).textContent");
await clickEl("[...document.querySelectorAll('.drawer header button')][0]", '刷新按钮');
await sleep(1200);
const t1 = await ev("(document.querySelector('.drawer .fetched') || {}).textContent");
check('点击 ⟳ 刷新生效（更新时间戳变了）', !!t0 && !!t1 && t0 !== t1, `${t0} → ${t1}`);

// 2) 真实点击关闭：抽屉必须收起
await clickEl("[...document.querySelectorAll('.drawer header button')][1]", '关闭按钮');
await sleep(300);
const cls = await ev("document.querySelector('.drawer').className");
check('点击 ✕ 关闭生效', /closed/.test(String(cls)), String(cls));
check('关闭后内部状态也清了', (await ev('window.__panelDebug().open')) === null);

// 3) 顺带验一下点卡片能重新打开（这条曾经因为异常被跳过，要等 2 秒推送才出现）
await clickEl("document.querySelector('.card')", '节点卡');
await sleep(500);
const reopened = await ev("document.querySelector('.drawer').className");
check('点卡片立即打开详情（不靠 2 秒推送兜底）', !/closed/.test(String(reopened)), String(reopened));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exitCode = failed ? 1 : 0;