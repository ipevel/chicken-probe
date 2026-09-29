// 窄屏顶部拥挤（#hud-top × #board）的实测探针 —— 配套 docs/visual-refresh-20260929-hud-top-narrow.md
//
// 为什么要有这个脚本：`#hud-top` 是 `flex-wrap: wrap` 的正常流，`#board` 是绝对定位。
// 绝对定位元素**不参与折行计算**，所以「顶栏会不会撞上排行榜」这件事在 CSS 里读不出来，
// 只能用真实布局量。而且 `#board` 的宽度是内容驱动的（榜里名字一长就变宽），
// 所以「某个宽度不重叠」不能靠读 max-width 推 —— 必须逐档实测。
//
// 用法（先起 dev 服务器与一个独立调试端口的 Chrome，别抢 .shots 那套 9222）：
//   node server/dev.js                       # 7788
//   chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录> about:blank
//   node tools/hud-top-probe.mjs                     # 基线（现状）
//   node tools/hud-top-probe.mjs --css=docs/x.css    # 叠加候选方案后再量一遍
//   node tools/hud-top-probe.mjs --css=... --json    # 机器可读
//   node tools/hud-top-probe.mjs --stress=both       # 把榜单推到最大宽度再量
//
// 判定逻辑在 ./hud-top-verdict.mjs（纯函数），可被独立自证：
//   node .shots/probe-sensitivity.mjs   # 喂退化数据，证明判定真的会触发（10/10）
//
// 判据只有两条，和设计稿一致：
//   ① #hud-top 的三个子元素与 #board 的矩形**两两不重叠**（交面积 = 0）
//   ② #hud-top 的行数 ≤ 基线行数（不许为了让开位置而多折一行）
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 判据家族警告：「一个会自己误报的判据，比没有判据更坏。」
//
// 本脚本原先有两种「**假通过**」模式，都表现为「明明没量到，却报 ✅ 无重叠」。
// 两者现在都已被堵住，改动前请先读这段：
//
//   ① **override 未落地** —— 请求 setDeviceMetricsOverride(520×900)，页面
//      `window.innerWidth` 却读回别的值（例如 1440）。此时量到的是**别的视口**的
//      布局，却记在「520 档」名下，于是「520 不重叠」是假的。
//      → 现在每档都读回校验 innerWidth/innerHeight，不符即判**本档无效**（不计入结论）。
//
//   ② **#farm 被隐藏** —— `#farm` 的 `display:none`（class="hidden"）时，其内部一切
//      元素的矩形都是 0×0；`inter()` 对 0 面积矩形返回 null，于是**永远**报「无重叠」。
//      → 现在对退化矩形（宽或高 ≤ 0）直接判废，并要求 #farm 可见。
//
// 两者都由 `verdict` 字段显式标记；有任何一个无效档，退出码就是 2（判据不可用），
// **不会**再打印「无重叠」这种看起来没事的绿灯。
//
// 退出码：0 = 全部档有效且全部通过 / 1 = 有档真重叠 / 2 = 存在无效档（判据不可用）
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { validateSample, summarize } from './hud-top-verdict.mjs';

const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const PAGE = process.env.PAGE || 'http://localhost:7788/';
const CSS_ARG = process.argv.find((a) => a.startsWith('--css='))?.slice(6);
const AS_JSON = process.argv.includes('--json');
const WAIT_ENTER_FARM = Number(process.env.WAIT_FARM || 5000);
// 每档 override 之后的等待：给合成器/媒体查询重算留时间。
const SETTLE_MS = Number(process.env.SETTLE_MS || 450);
// 读回校验的重试次数与间隔：override 偶尔需要一两帧才反映到 window.innerWidth。
const VERIFY_TRIES = Number(process.env.VERIFY_TRIES || 12);
const VERIFY_GAP_MS = Number(process.env.VERIFY_GAP_MS || 120);

// 四档必测 + 430–560 这段「本来不该重叠」的回归带（苏小码的担心就在这里）
const VIEWPORTS = (process.env.VIEWPORTS ||
  '320x568,360x640,375x667,390x844,414x896,430x932,460x900,480x900,500x900,520x900,540x900,560x900,561x900,600x900,640x900')
  .split(',')
  .map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { w, h };
  });

const list = await fetch(`${CDP}/json/list`)
  .then((r) => r.json())
  .catch(() => {
    throw new Error(
      `连不上 ${CDP} —— 需要先起一个**自己独占**的调试 Chrome（别抢 .shots 那套 9222，会互相打断）：\n\n` +
      `  chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录> about:blank\n\n` +
      `起完再跑一次本脚本；端口不同就设 CDP=http://127.0.0.1:<端口>。`
    );
  });
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error(`调试端点 ${CDP} 上没有 page target —— 打开一个 about:blank 再试。`);
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`页面里抛错：${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 设定视口并**读回校验**。
 *
 * 这是堵「假通过①」的地方：只发 setDeviceMetricsOverride 是不够的 ——
 * 命令返回成功不代表 `window.innerWidth` 真的变了。必须读回到与请求一致为止，
 * 否则本档读数属于别的视口，必须判废而不是当成通过。
 *
 * @returns {{ok: boolean, got: {w:number,h:number}, requested: {w:number,h:number}}}
 */
async function setViewportAndVerify(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: true });
  await sleep(SETTLE_MS);
  let got = { w: -1, h: -1 };
  for (let i = 0; i < VERIFY_TRIES; i++) {
    got = await evaluate(`({ w: window.innerWidth, h: window.innerHeight })`);
    if (got.w === w && got.h === h) return { ok: true, got, requested: { w, h } };
    await sleep(VERIFY_GAP_MS);
  }
  return { ok: false, got, requested: { w, h } };
}

await send('Page.enable');
await send('Runtime.enable');

// --fp：复跑 `.farm` 子树的「计算样式指纹」
//      （docs/visual-refresh-20260929-accent-final.md §7.3 ③ 的权威判据）。
//
// 关键设计：**不重写这份指纹的逻辑** —— 直接从 `.shots/farm-fingerprint.mjs` 里把采集表达式读出来用，
// 并照抄它的 sha256 口径（`rows.join('\n')` 取 sha256，不长整棵树的 JSON）、
// 设备尺寸（1440×900 —— 这个值很关键：`.farm` 子树里**包含 `#hud`**，
// 而窄屏媒体查询会在小视口下改变 `#board`/`#hud-top` 的计算样式，把视口差异混进指纹）
// 和**收敛收口**（等 `document.fonts.ready`，并要求连续两次取样哈希一致才认读数）。
//
// 这样它是「同一把尺子、换一个浏览器端口」，而不是「另一把尺子」：
//   CDP=http://127.0.0.1:9333 node tools/hud-top-probe.mjs --fp
//   CDP=http://127.0.0.1:9333 node tools/hud-top-probe.mjs --fp --fp-check=E:/tmp/farm-fingerprint.json
//
// **只读页面、只打印**；`--fp` 不写 `.shots/` 里的基线文件（那是苏小码的资产）。
// 退出码与参考脚本一致：0 = 与基线一致 / 1 = 指纹不同 / 2 = 采样未收敛（判据不可用）。
if (process.argv.includes('--fp')) {
  const { createHash } = await import('node:crypto');
  const ref = await readFile('.shots/farm-fingerprint.mjs', 'utf8');
  const m = ref.match(/const (?:COLLECT|fingerprint)\s*=\s*`([\s\S]*?)`;/);
  if (!m) {
    throw new Error('没能从 .shots/farm-fingerprint.mjs 里取出采集表达式 —— 那个脚本改了形状，\n' +
      '请同步本分支（或直接用参考脚本：node .shots/farm-fingerprint.mjs --check）。');
  }
  // **必须按模板字面量的原语义还原**，不能把源码原文直接丢给页面。
  // 踩过的坑：源码里写的是 `split(/\\s+/)`（模板字面量里 `\\s` 表示「反斜杠 + s」，
  // 求值后才是正则 `/\s+/`）。照抄原文送给 Runtime.evaluate，页面拿到的是 `/\\s+/`
  // —— 匹配的是「一个或多个反斜杠」，于是元素键从 `span#room-state.conn.live`
  // 变成 `span#room-state.conn live`，**指纹必然不同**，判据就成了一张假警报。
  if (m[1].includes('${')) {
    throw new Error('采集表达式里出现了模板插值 ${...}，本分支不能安全还原 —— 请直接用参考脚本。');
  }
  const COLLECT = new Function('return `' + m[1] + '`;')();

  // 与参考脚本同款入口：先定尺寸再导航，避免「390 里加载、1440 上取指纹」这种混口径
  const fpVp = await setViewportAndVerify(1440, 900);
  if (!fpVp.ok) {
    console.error(`\n⚠ 视口未落地：请求 1440×900，读回 ${fpVp.got.w}×${fpVp.got.h} —— 指纹判据不可用（退出码 = 2）。`);
    ws.close();
    process.exit(2);
  }
  await new Promise((res) => {
    const h = (raw) => { if (JSON.parse(String(raw)).method === 'Page.loadEventFired') { ws.off('message', h); res(); } };
    ws.on('message', h);
    send('Page.navigate', { url: PAGE });
  });
  await sleep(2500);
  await evaluate(`location.hash = '#farm'`);
  await sleep(Math.max(WAIT_ENTER_FARM, 9000));

  await evaluate(`document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`);
  const snap = async () => {
    const r = await evaluate(COLLECT);
    if (r.error) throw new Error(`页面里报错：${r.error}`);
    return { ...r, hash: createHash('sha256').update(r.rows.join('\n')).digest('hex') };
  };
  let prev = await snap();
  let cur = prev;
  let stable = false;
  for (let i = 1; i < 8; i++) {
    await sleep(700);
    cur = await snap();
    if (cur.hash === prev.hash) { stable = true; break; }
    prev = cur;
  }

  const checkPath = process.argv.find((a) => a.startsWith('--fp-check='))?.slice(11);
  console.log(`.farm 稳定元素数：${cur.rows.length}（数据驱动容器后代已排除：${JSON.stringify(cur.volatileCounts)}）`);
  console.log(`采样收敛：${stable ? '是' : '否'}`);
  console.log(`关键取值：${JSON.stringify(cur.key)}`);
  console.log(`计算样式指纹 sha256 = ${cur.hash}`);
  if (!stable) {
    console.log('\n⚠ 采样未收敛：连采 8 次哈希都不一致 —— 判据不可用（既不能报「通过」也不能报「被改动」）。');
    console.log('  这是判据自身的环境问题（页面还在动），先让页面稳定再重跑。退出码 = 2');
    ws.close();
    process.exit(2);
  }
  if (checkPath) {
    const prevFile = JSON.parse(await readFile(checkPath, 'utf8'));
    const same = prevFile.hash === cur.hash;
    console.log(`\n与基线比对：${checkPath}\n  基线 ${prevFile.hash}\n  现在 ${cur.hash}`);
    if (same) {
      console.log('✅ 指纹完全一致 —— 鸡场没有任何一处计算样式被改动');
    } else {
      console.log('✗ 指纹不同 —— 鸡场渲染被改动了，必须回退或说明');
      if (prevFile.count !== cur.rows.length) {
        console.log(`（元素数 ${prevFile.count ?? '?'} → ${cur.rows.length} —— 元素集合都变了，先查这个）`);
      }
      const pv = prevFile.rows || [];
      for (let i = 0; i < Math.max(pv.length, cur.rows.length); i++) {
        if (pv[i] !== cur.rows[i]) { console.log(`  首个差异在第 ${i} 项\n    基线 ${pv[i]}\n    现在 ${cur.rows[i]}`); break; }
      }
    }
    console.log(`退出码 = ${same ? 0 : 1}`);
    ws.close();
    process.exit(same ? 0 : 1);
  }
  ws.close();
  process.exit(0);
}

// 进农场：hash 会被 index.html 的启动逻辑接管；这里只在导航后设置
const entryVp = await setViewportAndVerify(390, 844);
if (!entryVp.ok) {
  throw new Error(`入口视口未落地：请求 390×844，读回 ${entryVp.got.w}×${entryVp.got.h} —— 后续所有档都会拿错视口，拒绝继续。`);
}
await new Promise((res) => {
  const h = (raw) => { if (JSON.parse(String(raw)).method === 'Page.loadEventFired') { ws.off('message', h); res(); } };
  ws.on('message', h);
  send('Page.navigate', { url: PAGE });
});
await sleep(1500);
await evaluate(`location.hash = '#farm'`);
await sleep(WAIT_ENTER_FARM);

// 候选样式在**进农场之后**注入：导航会清掉 head 里的东西。
// 留在 head 里就不影响后面纯粹改设备尺寸（媒体查询会跟着重算）。
if (CSS_ARG) {
  const css = await readFile(CSS_ARG, 'utf8');
  const n = await evaluate(`(() => {
    let s = document.getElementById('__probe_css');
    if (!s) { s = document.createElement('style'); s.id = '__probe_css'; document.head.appendChild(s); }
    s.textContent = ${JSON.stringify(css)};
    return s.textContent.length;
  })()`);
  if (!n) throw new Error('候选样式没写进去');
}

// --stress：把榜单推到它「够得着的最大宽度」。这两个状态在真机上都能出现：
//   ① 长标题 —— 点两下 #board 就会切到 '啄倒榜（高占用触发主动攻击 · 点击收起）'（farm.js:365-367）；
//   ② 长名字 —— cleanName 允许 24 字节，中文 8 个字。
// 榜单是内容驱动的，不把这两个状态量出来，「不重叠」就只是当前数据的巧合。
const STRESS = process.argv.find((a) => a.startsWith('--stress'))?.split('=')[1] || (process.argv.includes('--stress') ? 'both' : null);
if (STRESS) {
  await evaluate(`(() => {
    const box = document.querySelector('#board-rows');
    if (!box) return 'no box';
    if (${JSON.stringify(STRESS)} !== 'name') {
      const t = document.querySelector('#board-title-text');
      if (t) t.textContent = '啄倒榜（高占用触发主动攻击 · 点击收起）';
    }
    if (${JSON.stringify(STRESS)} !== 'title') {
      box.replaceChildren();
      for (const nm of ['啄得最凶的那只探针鸡', '内存泄漏嫌疑人', '铁蛋', '磁盘快满了']) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML = '<span class="nm"><svg class="i i-16" aria-hidden="true"><use href="#i-chicken"/></svg>' + nm
          + '</span><span class="sc">999999</span>';
        box.appendChild(row);
      }
    }
    return 'ok';
  })()`);
  await sleep(300);
}

// --feed：往事件流里塞一条提示条，量它在顶栏/榜单上压了多少。
// 事件流本来就是「画在最上层、会盖住 HUD」的临时层（#feed 在 DOM 里排在 #hud-top 之后），
// 量它是为了把「本条 delta 的账」和「本来就有的账」分开。
if (process.argv.includes('--feed')) {
  await evaluate(`(() => {
    const f = document.querySelector('#feed');
    if (!f) return 'no feed';
    const it = document.createElement('div');
    it.className = 'feed-item';
    it.textContent = '铁蛋把 探针鸡-东京-08 啄倒了 · 30 天 +114';
    f.appendChild(it);
    return 'ok';
  })()`);
  await sleep(200);
}

const MEASURE = `(() => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { l: +b.left.toFixed(1), r: +b.right.toFixed(1), t: +b.top.toFixed(1), b: +b.bottom.toFixed(1),
             w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
  };
  const inter = (a, b) => {
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return (w > 0.5 && h > 0.5) ? { w: +w.toFixed(1), h: +h.toFixed(1), area: +(w*h).toFixed(0) } : null;
  };
  const top = document.querySelector('#hud-top');
  const kids = top ? [...top.children] : [];
  const rows = [...new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top)))].sort((a,b)=>a-b);
  const farm = document.querySelector('#farm');
  const farmHidden = farm ? (farm.classList.contains('hidden') || getComputedStyle(farm).display === 'none') : null;
  const bd = document.querySelector('#board');
  const out = {
    vw: window.innerWidth, vh: window.innerHeight,
    farmPresent: !!farm,
    farmHidden,
    farmVisible: farm ? !farmHidden : false,
    farmRect: r('#farm'),
    hudStats: r('.hud-stats'), backBtn: r('#back-btn'), roomState: r('#room-state'),
    board: r('#board'), feed: r('#feed'),
    topRows: rows.length,
    hudTopRect: r('#hud-top'),
    hudTopRight: kids.length ? +Math.max(...kids.map((k) => k.getBoundingClientRect().right)).toFixed(1) : null,
    hudTopWidth: top ? +top.getBoundingClientRect().width.toFixed(1) : null,
    hudTopRightProp: top ? getComputedStyle(top).right : null,
    statsLines: [...document.querySelectorAll('.hud-stats span')].map((s) => +s.getBoundingClientRect().width.toFixed(1)),
    statsPad: getComputedStyle(document.querySelector('.hud-stats')).padding,
    boardPad: bd ? getComputedStyle(bd).padding : null,
    boardH: bd ? +bd.getBoundingClientRect().height.toFixed(1) : null,
    boardBottom: bd ? +bd.getBoundingClientRect().bottom.toFixed(1) : null,
    roomStateText: document.querySelector('#room-state')?.textContent?.trim() || null,
    boardCollapsed: !!document.querySelector('#board')?.classList.contains('collapsed'),
    boardRows: document.querySelectorAll('#board-rows .row').length,
    roomStateDisplay: document.querySelector('#room-state') ? getComputedStyle(document.querySelector('#room-state')).display : null,
    backBtnMin: (() => { const e = document.querySelector('#back-btn'); if (!e) return null; const b = e.getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; })(),
  };
  const pairs = [['hudStats','backBtn'],['hudStats','roomState'],['backBtn','roomState'],
                 ['hudStats','board'],['backBtn','board'],['roomState','board'],['roomState','feed'],['board','feed']];
  out.overlaps = {};
  for (const [a, b] of pairs) {
    if (out[a] && out[b]) { const o = inter(out[a], out[b]); if (o) out.overlaps[a+'\u00d7'+b] = o; }
  }
  return out;
})()`;

// 判定逻辑不在这里 —— 它抽在 ./hud-top-verdict.mjs，为的是能被独立自证
// （喂退化数据进去，看它是否真的判废）。见该文件头部说明。

// （`--fp` 分支在文件上部 —— 它要自己定尺寸再导航，不能借用这里的 390×844 入口。）
const results = [];
const SHOT = process.argv.find((a) => a.startsWith('--shot'))?.split('=')[1] || null;
for (const { w, h } of VIEWPORTS) {
  const vp = await setViewportAndVerify(w, h);
  const m = await evaluate(MEASURE);
  const v = validateSample(m, { w, h });
  // 即便读数无效也保留原始数据，但**明确标出来**，绝不混进「通过」的结论
  results.push({ ...m, requested: { w, h }, viewportLanded: vp.ok, verdict: v.valid ? 'ok' : 'invalid', invalidReasons: v.reasons });
  if (SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const dir = SHOT.endsWith('/') ? SHOT : SHOT + '/';
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}hud-${w}x${h}.png`, Buffer.from(shot.data, 'base64'));
  }
}

// ── 汇总：只有**有效档**才参与判据，无效档单独列出并让退出码 = 2
const { exitCode, invalid, valid, overlapping: bad } = summarize(results);

if (AS_JSON) {
  console.log(JSON.stringify({
    page: PAGE, css: CSS_ARG || null,
    exitCode,
    summary: { total: results.length, valid: valid.length, invalid: invalid.length, overlapping: bad },
    results,
  }, null, 1));
} else {
  console.log(`页面 ${PAGE}${CSS_ARG ? `  + 候选样式 ${CSS_ARG}` : '（基线，现状）'}`);
  console.log(`视口 | #hud-top 三元素（x 起-止 / 高） | #board（x 起-止 / 高） | 行数 | 重叠 | 判定`);
  for (const m of results) {
    const seg = (x) => (x ? `${x.l}-${x.r}/${x.h}` : '—');
    const ov = Object.entries(m.overlaps).map(([k, v]) => `${k} ${v.w}\u00d7${v.h}`).join(' ');
    const mark = m.verdict === 'ok' ? '有效' : `★无效（${m.invalidReasons.length} 条）`;
    console.log(
      `${m.vw}\u00d7${m.vh} | ${seg(m.hudStats)} | ${seg(m.backBtn)} | ${seg(m.roomState)} | ${seg(m.board)} | ${m.topRows} | ${ov || '无'} | ${mark}`
    );
  }
  const f = valid[0] || results[0];
  console.log(`\n页面状态：#room-state = ${f?.roomStateText}（${f?.roomStateDisplay}）· 榜单 ${f?.boardRows} 行 · collapsed=${f?.boardCollapsed} · #farm 可见=${f?.farmVisible}`);
  console.log(`#back-btn = ${f?.backBtnMin?.w}\u00d7${f?.backBtnMin?.h} · .hud-stats 三行宽 = ${JSON.stringify(f?.statsLines)} · padding = ${f?.statsPad}`);
  console.log(`#board 内边距 = ${f?.boardPad} · 高度/底边 = ${f?.boardH} / ${f?.boardBottom}`);
  console.log(`#hud-top 宽度 = ${f?.hudTopWidth} · right = ${f?.hudTopRightProp}`);

  if (invalid.length) {
    console.log(`\n⚠ 无效档 ${invalid.length}/${results.length} 个 —— 这些档的读数不能用，判据整体不可用：`);
    for (const m of invalid) {
      console.log(`  ${m.vw}\u00d7${m.vh}（请求 ${m.requested.w}\u00d7${m.requested.h}，override 落地=${m.viewportLanded}）`);
      for (const reason of m.invalidReasons) console.log(`      · ${reason}`);
    }
    console.log('  先修环境（浏览器是否被回收？页面是否真的进了农场？）再重跑 —— 不要拿这份结果当结论。');
  }
  console.log(`\n与 #board 相撞的宽度（仅统计有效档）：${bad.length ? bad.join(', ') : (valid.length ? '无' : '—')}`);
  console.log(`顶栏行数（按视口顺序）：${results.map((r) => `${r.vw}:${r.topRows}`).join(' ')}`);
  const wrap = valid.filter((r) => r.topRows > 1).map((r) => r.vw);
  console.log(`折成 2 行的宽度（仅统计有效档）：${wrap.length ? wrap.join(', ') : '无'}`);
  console.log(`\n退出码 = ${exitCode}  ${exitCode === 0 ? '（全部档有效且全部通过）' : exitCode === 1 ? '（有档真重叠）' : '（存在无效档：判据不可用）'}`);
}

ws.close();
process.exit(exitCode);
