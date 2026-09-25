// 本地开发服务器 = 假 hub + 联机服务 + 静态托管，尽量和线上跑同一套路径：
// 主题只认识 /api/me、/api/nodes、/api/ws 与联机的 /ws；NPC 鸡也走和生产一样的
// hub 数据源 → NPC 管理器 → 房间 这条链路，唯一区别是数据源换成了假探针。
//
//   node server/dev.js            # 默认 7788
//   PORT=7788 node server/dev.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { createFleet } from './probe.js';
import { createNpcManager } from './npcs.js';
import { attachRoom } from './room.js';

const ROOT = resolve(import.meta.dirname, '..');
const THEME = join(ROOT, 'theme');
const VENDOR = join(ROOT, 'node_modules', 'three', 'build');
const PORT = Number(process.env.PORT) || 7788;
const SITE_NAME = '养鸡探针';

// 开发时给两个网站鸡：一个正常、一个必定失败。都打本机，不碰第三方站点
const WEBSITES = [
  { name: '示例官网', url: `http://localhost:${PORT}/api/me` },
  { name: '打不开的站', url: 'http://127.0.0.1:9/' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const fleet = createFleet();
const npcs = createNpcManager({ now: () => Date.now(), log: console });
let webSites = [];
npcs.rebuild(fleet.views(), webSites);

setInterval(() => {
  fleet.tick();
  npcs.rebuild(fleet.views(), webSites);
}, 2000);

// 极简网站探测：开发期只需要「通 / 不通」，生产用的是 sources.js 那份
async function probeWebsites() {
  webSites = await Promise.all(WEBSITES.map(async (s) => {
    const t0 = Date.now();
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
      return { name: s.name, url: s.url, ok: res.status < 400, latency: Date.now() - t0, status: res.status, checkedAt: Date.now() };
    } catch {
      return { name: s.name, url: s.url, ok: false, latency: null, status: 0, checkedAt: Date.now(), error: '连不上' };
    }
  }));
  npcs.rebuild(fleet.views(), webSites);
}
setTimeout(() => void probeWebsites(), 600);
setInterval(() => void probeWebsites(), 15000);

const json = (res, body, code = 200) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/**
 * 把 URL 路径映射到磁盘文件，越界一律拒绝（主题里没人需要 ../）。
 * 不借 path.normalize：它在 Windows 上会把路径换成反斜杠，前缀匹配随即失效。
 * 两个前缀映射到源码树之外，但生产包里它们是 dist 里的真实目录：
 *   vendor/  → three 的模块（打包时复制进 dist/vendor/）
 *   shared/  → 与物理共用的代码（打包时复制进 dist/shared/）
 */
function resolveFile(pathname) {
  const clean = decodeURIComponent(pathname)
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s && s !== '.')
    .join('/');
  const parts = clean.split('/');
  if (parts.includes('..')) return null;
  if (parts[0] === 'vendor') return join(VENDOR, parts.slice(1).join('/'));
  if (parts[0] === 'shared') return join(ROOT, 'shared', parts.slice(1).join('/'));
  const full = join(THEME, clean);
  if (full !== THEME && !full.startsWith(THEME + sep)) return null;
  return full;
}

async function serveStatic(req, res, pathname) {
  const full = resolveFile(pathname || '/');
  if (!full) { res.writeHead(403).end('forbidden'); return; }

  const candidates = pathname.endsWith('/') || pathname === '/' ? [join(full, 'index.html')] : [full];
  // 单页应用：没有扩展名的路径回落到 index.html，和 hub 的 frontend.rs 一致
  if (!extname(pathname)) candidates.push(join(THEME, 'index.html'));

  for (const file of candidates) {
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
      return;
    } catch { /* 试下一个候选 */ }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
}

const server = createServer(async (req, res) => {
  // 同生产入口：解析不了的请求行 target 得接住回 400，否则 unhandledRejection 崩进程
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }
  const p = url.pathname;

  if (p === '/api/me') return json(res, { authed: false, github: false, site_name: SITE_NAME, public_page: true });
  if (p === '/api/nodes') return json(res, { nodes: fleet.views() });

  // 节点历史：面板的历史曲线就吃这个。hours/points 的夹取在 fleet.history 里做
  // （匿名访客拿不到完整窗口，响应里的 hours 才是实际窗口），这里只负责解析参数
  const m = /^\/api\/nodes\/(\d+)\/metrics$/.exec(p);
  if (m) {
    const q = url.searchParams;
    const int = (v, dflt) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : dflt; };
    const body = fleet.history(Number(m[1]), int(q.get('hours'), 24), int(q.get('points'), 300), q.get('series') || 'metrics');
    return body ? json(res, body) : json(res, { error: 'node not found' }, 404);
  }

  if (p === '/healthz') return json(res, { ok: true, players: room.size, npc: npcs.stats(), nodes: fleet.views().length, websites: webSites.length });
  if (p.startsWith('/api/')) return json(res, { error: 'not found' }, 404);

  return serveStatic(req, res, p);
});

// /api/ws：hub 是 2 秒一推的 {nodes, admin}；这里照抄帧形状与节奏
const hub = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === '/api/ws') {
    hub.handleUpgrade(req, socket, head, (ws) => {
      const push = () => {
        if (ws.readyState !== 1) return;
        ws.send(JSON.stringify({ nodes: fleet.views(), admin: false }));
      };
      push();
      const timer = setInterval(push, 2000);
      ws.on('close', () => clearInterval(timer));
    });
  }
});

// /room/ws 是主题里的默认路径（线上由反向代理转到本服务），/ws 留作直连调试
const room = attachRoom(server, { path: ['/room/ws', '/ws'], npcs, log: console });

server.listen(PORT, () => {
  console.log(`🐔 假 hub + 联机服务 + 鸡场  http://localhost:${PORT}`);
  console.log(`   节点 ${fleet.views().length} 台 · 网站 ${WEBSITES.length} 个 · 联机 /ws · 静态根 ${THEME}`);
});

process.on('SIGINT', () => {
  room.close();
  hub.close();
  server.close(() => process.exit(0));
});