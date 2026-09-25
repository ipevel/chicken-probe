// 联机服务（生产入口）。**与探针主控 monitor hub 部署在同一台机器上**：
// 它直接读本机 hub 的公开接口拿节点列表，再按 node 数据放出「探针鸡」，
// 另外按配置探测一组网站，放出「网站鸡」。真人玩家由它统一转发。
//
//   node server/index.js --hub http://127.0.0.1:9911 --port 7789
//   node server/index.js --config server/config.json
//
// 完整部署步骤（含反向代理与主题里的地址怎么填）见 README「联机服务」一节。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createHubSource, createWebSource } from './sources.js';
import { createNpcManager } from './npcs.js';
import { attachRoom } from './room.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const configPath = arg('config', '');
let fileConfig = {};
if (configPath) {
  try {
    fileConfig = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  } catch (e) {
    console.error(`[cfg] 读不了 ${configPath}：${e.message}`);
    process.exit(1);
  }
}

const cfg = {
  hub: arg('hub', process.env.HUB_URL || fileConfig.hub || 'http://127.0.0.1:9911'),
  port: Number(arg('port', process.env.PORT || fileConfig.port || 7789)),
  path: arg('path', fileConfig.path || '/ws'),
  host: arg('host', fileConfig.host || '0.0.0.0'),
  websites: fileConfig.websites || [],
  static: arg('static', fileConfig.static || ''),
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`联机服务 —— 与 monitor hub 同机运行

  --hub    <url>   探针主控地址，默认 http://127.0.0.1:9911
  --port   <n>     监听端口，默认 7789
  --path   <p>     WebSocket 路径，默认 /ws
  --host   <ip>    绑定地址，默认 0.0.0.0（建议只绑 127.0.0.1，由代理转发）
  --config <file>  JSON 配置，可写 hub / port / path / host / static / websites
  --static <dir>   顺带托管一份主题产物，方便本地体检（生产由 hub 托管）

配置示例（server/config.example.json 有完整注释版）：
  { "hub": "http://127.0.0.1:9911", "port": 7789,
    "websites": [{ "name": "公司官网", "url": "https://example.com" }] }
`);
  process.exit(0);
}

const log = console;

// ---- NPC 鸡的两个来源 ----
const npcs = createNpcManager({ now: () => Date.now(), log });
const hub = createHubSource({ url: cfg.hub, onNodes: (nodes) => npcs.rebuild(nodes, web.sites), log });
const web = createWebSource({ sites: cfg.websites, onUpdate: () => npcs.rebuild(hub.nodes, web.sites), log });

// ---- HTTP：健康检查 + 可选的静态托管 ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const staticRoot = cfg.static ? resolve(cfg.static) : '';

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/healthz') {
    const s = npcs.stats();
    const body = JSON.stringify({
      ok: true,
      room: { players: room.size },
      npc: { ...s, total: npcs.size },
      hub: { url: cfg.hub, failures: hub.failures, nodes: hub.nodes.length },
      websites: { total: web.sites.length, online: web.summary.online },
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  if (!staticRoot) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('联机服务只提供 WebSocket；主题由 monitor hub 托管');
    return;
  }
  const clean = decodeURIComponent(pathname).replace(/\\/g, '/').split('/').filter(x => x && x !== '.').join('/');
  if (clean.split('/').includes('..')) { res.writeHead(403).end('forbidden'); return; }
  const full = join(staticRoot, clean || 'index.html');
  try {
    const data = await readFile(full.endsWith('/') ? join(full, 'index.html') : full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('404');
  }
});

const room = attachRoom(server, { path: cfg.path, npcs, log });

// 数据源必须显式起步：两个 create*Source 只是造了对象，不 start 就一次都不轮询 ——
// 这样上线会得到一个「连上了但场上什么都没有」的房间，且日志里一句错都不报
hub.start();
web.start();

server.listen(cfg.port, cfg.host, () => {
  log.log(`🐔 联机服务已启动  ws://${cfg.host}:${cfg.port}${cfg.path}`);
  log.log(`   探针主控    ${cfg.hub}（读 /api/nodes，需主控开启公开页）`);
  log.log(`   网站鸡      ${web.sites.length ? `${web.sites.length} 个站点` : '未配置（config.websites 为空就不要网站鸡）'}`);
  log.log(`   健康检查    http://127.0.0.1:${cfg.port}/healthz`);
  log.log(`   主题里的地址：把 theme/js/config.js 的 ROOM_PATH 指到反向代理暴露的同域路径，见 README`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.log('\n收工，正在关闭…');
    hub.stop(); web.stop(); room.close();
    server.close(() => process.exit(0));
  });
}