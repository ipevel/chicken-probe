// 验证 hub v1.3.2 的新字段有没有真的画到界面上。
//
// 假 hub（server/probe.js）故意停在老版本：它连 v1.3.1 的峰值字段都还没发，而主题
// 对老 hub 是优雅降级，所以 history_days / step / cpu_max / minutes 这几条路径在本地
// 本来是走不到的。这里不动仓库里的假 hub，而是在页面里把 fetch 包一层，给 /api/me 补
// history_days、给历史响应补 step 与每点的 cpu_max / minutes —— 也就是假装对面是个
// v1.3.2 的主控，看界面认不认。最后把补丁摘掉再开一次，确认老 hub 上这些新东西
// 一个都不冒出来（新按钮、峰值虚线、覆盖度说明都不能出现）。
//
// 前置与 probe:panel 相同：node server/dev.js（7788）+ 一个带
// --remote-debugging-port=9333 的无头 Edge（见 README「交互级探针」）。

const CDP = 'http://127.0.0.1:9333';
const APP = 'http://127.0.0.1:7788/?dbg=1';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

const list = await (await fetch(`${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.log('没有可用的页面目标'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)(m.result);
});
await new Promise((r) => { ws.addEventListener('open', r, { once: true }); });

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
  return r?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');

/*
 * 在应用脚本跑起来之前把 fetch 包掉。用 addScriptToEvaluateOnNewDocument 而不是
 * 加载后再改，是因为 /api/me 在 start() 里就发出去了，晚一步就赶不上。
 */
const patchId = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    (() => {
      const DAYS = 30;
      const orig = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]);
        const res = await orig(...args);
        if (url.includes('/api/me')) {
          const j = await res.clone().json();
          j.history_days = DAYS;
          return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/metrics')) {
          const j = await res.clone().json();
          if (Array.isArray(j.metrics)) {
            // 每点补峰值；每 5 个点里留一个只覆盖 20 分钟（step=3600 时算没覆盖满）
            j.step = 3600;
            j.metrics = j.metrics.map((p, i) => ({
              ...p,
              cpu_max: p.cpu == null ? null : Math.min(100, p.cpu + 7),
              minutes: i % 5 === 0 ? 20 : 60,
            }));
          }
          return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return res;
      };
      window.__patched = true;
    })();
  `,
});

// 装好补丁再打开应用
await send('Page.navigate', { url: APP });
await sleep(3500);

check('页面里装上了假主控补丁', await ev('window.__patched === true'));
check('调试缝在（?dbg=1）', await ev('typeof window.__panelDebug === "function"'));

const boot = await ev('window.__panelDebug()');
check('面板拿到了 history_days=30', boot?.historyDays === 30, `historyDays=${boot?.historyDays}`);
check('范围按钮铺到 30 天', JSON.stringify(boot?.ranges) === '[1,6,24,168,720]', `ranges=${JSON.stringify(boot?.ranges)}`);

// 打开一台在线探针鸡的详情
const opened = await ev(`(() => {
  const card = document.querySelector('.card');
  if (!card) return 'no-card';
  card.click();
  return 'clicked';
})()`);
check('点开了节点卡片', opened === 'clicked', opened);
await sleep(2500);

const afterOpen = await ev('window.__panelDebug()');
check('抽屉打开了', afterOpen?.open != null, `open=${afterOpen?.open}`);
check('资源页签在', afterOpen?.detail?.tab === 'resources', `tab=${afterOpen?.detail?.tab}`);

// 切到 30 天，看请求有没有真的带上 hours=720
await ev(`(() => {
  const b = [...document.querySelectorAll('.ranges button')].find(x => x.textContent.includes('30 天'));
  if (!b) return 'no-button';
  b.click();
  return 'ok';
})()`);
await sleep(2500);

const wide = await ev('window.__panelDebug()');
check('切到 30 天后 detail.hours=720', wide?.detail?.hours === 720, `hours=${wide?.detail?.hours}`);

// 图例里要有 CPU 峰值那条，覆盖度说明要出现
const chart = await ev(`(() => {
  const blocks = [...document.querySelectorAll('.chart-block')];
  const cpu = blocks.find(b => b.querySelector('h3')?.textContent.startsWith('CPU'));
  if (!cpu) return { err: 'no-cpu-block' };
  return {
    title: cpu.querySelector('h3').textContent,
    legend: [...cpu.querySelectorAll('.sstat-h span')].map(s => s.textContent),
    hosts: cpu.querySelectorAll('.chart-host svg').length,
  };
})()`);
check('CPU 图例里有「CPU 峰值」', (chart?.legend || []).includes('CPU 峰值'), `legend=${JSON.stringify(chart?.legend)}`);
check('CPU 图标题说「30 天」而不是「720 小时」', /30 天/.test(chart?.title || ''), `title=${chart?.title}`);
check('CPU 图画出来了', (chart?.hosts || 0) > 0, `svg=${chart?.hosts}`);

const foot = await ev(`(() => {
  const ps = [...document.querySelectorAll('.charts-area p.sub, .drawer p.sub')].map(p => p.textContent);
  return ps.join('\\n');
})()`);
check('出现了覆盖度说明', /没覆盖满/.test(foot || ''), (foot || '').split('\n').find(l => /没覆盖满/.test(l)) || '');
check('覆盖度说的是「1 小时」而不是「3 天」（step=3600 是 60 分钟）', /每点覆盖 1 小时/.test(foot || ''));

// 延迟页签要把 30 天收回到 24 小时
await ev(`(() => {
  const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.includes('延迟'));
  if (b) b.click();
  return !!b;
})()`);
await sleep(2000);
const lat = await ev('window.__panelDebug()');
check('切到延迟页签后窗口收到 24 小时', lat?.detail?.hours === 24, `hours=${lat?.detail?.hours}`);
check('延迟页签的按钮列表不含 720', JSON.stringify(lat?.ranges) === '[1,6,24]', `ranges=${JSON.stringify(lat?.ranges)}`);

// 老 hub：把补丁摘掉再开一次，按钮必须只有基础四项
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: patchId?.identifier });
await send('Page.navigate', { url: APP });
await sleep(3000);

const plain = await ev('window.__panelDebug()');
check('摘掉补丁后（老 hub）history_days 为空', plain?.historyDays === null, `historyDays=${plain?.historyDays}`);
check('老 hub 只有基础四个范围按钮', JSON.stringify(plain?.ranges) === '[1,6,24,168]', `ranges=${JSON.stringify(plain?.ranges)}`);

await ev('document.querySelector(".card")?.click()');
await sleep(2500);
const plainFoot = await ev(`(() => {
  const ps = [...document.querySelectorAll('p.sub')].map(p => p.textContent);
  return ps.join('\\n');
})()`);
check('老 hub 上不会出现「没覆盖满」', !/没覆盖满/.test(plainFoot || ''));
const plainLegend = await ev(`(() => {
  const blocks = [...document.querySelectorAll('.chart-block')];
  const cpu = blocks.find(b => b.querySelector('h3')?.textContent.startsWith('CPU'));
  return cpu ? [...cpu.querySelectorAll('.sstat-h span')].map(s => s.textContent) : [];
})()`);
check('老 hub 的 CPU 图例里没有「CPU 峰值」', !(plainLegend || []).includes('CPU 峰值'), `legend=${JSON.stringify(plainLegend)}`);

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项不通过`}`);
process.exit(failed === 0 ? 0 : 1);
