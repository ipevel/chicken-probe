// 联机房：真人 + NPC 鸡（探针鸡/网站鸡）。
//
// 分工：
//   真人位置 —— 各端对自己权威，20Hz 上报，服务端只做越界兜底与啄倒判定；
//   NPC 鸡   —— 服务端权威，5Hz 播位置（它们走得慢，20Hz 是浪费）、名单变化时才重发。
// 这样客户端不需要知道任何探针数据，场上有什么鸡全由服务端说了算。

import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { CONF, ST, inPeckArc, WORLD_HALF } from '../shared/physics.js';

const TICK_MS = 1000 / CONF.SNAP_HZ;
const NPC_EVERY = 2;          // 每 2 拍发一次 NPC 位置（10Hz）：逃跑 6.4m/s 时 5Hz 会顿
const NO_STATE_MS = 20000;    // 这么久没上报状态就当人走了（半开连接只能靠这个兜）
const REGEN_DELAY = 4000;
const REGEN_PER_S = 6;
const MAX_NAME = 24;          // 字节数，中文一个字 3 字节
const MAX_MSG_PER_S = 90;
const ROSTER_MIN_GAP_MS = 400;  // 名单重发的下限间隔：分数连着涨时别每拍都刷

const SPAWNS = [
  [0, 0], [6, 6], [-6, 6], [6, -6], [-6, -6], [12, 0], [-12, 0], [0, 12], [0, -12],
];

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > MAX_NAME) break;
    out += ch;
  }
  return out;
}

/** 图标只收短字符串（emoji），别让人往别人的界面里塞长文本或标签。 */
function clipped(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 8);
}

const r = (v, n = 2) => Number.isFinite(+v) ? Number((+v).toFixed(n)) : 0;

export function attachRoom(httpServer, { path = '/ws', now = () => Date.now(), npcs = null, log = console } = {}) {
  const paths = Array.isArray(path) ? path : [path];
  // noServer + 自己路由：ws 的 path 选项在路径不匹配时会 abortHandshake 直接销毁
  // socket，而同一个 http server 上还挂着 hub 的 /api/ws —— 谁先 abort 谁就把对方打死。
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const peers = new Map();          // id -> peer
  const byToken = new Map();        // token -> id
  const ipCount = new Map();        // ip -> 连接数（一根网线开一千个标签页会拖垮所有人）
  let spawnSeq = 0;
  let lastRosterAt = 0;
  let npcRevSent = -1;

  const room = {
    get size() { return peers.size; },
    list() {
      return [...peers.values()].map(p => ({
        id: p.id, name: p.name, icon: p.icon, score: p.score, hp: Math.round(p.hp), ko: p.ko,
      }));
    },
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    },
    close() { wss.close(); },
  };

  const send = (p, obj) => {
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify(obj)); } catch { /* 断了就等 close 收尾 */ }
    }
  };
  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const p of peers.values()) {
      if (p.ws && p.ws.readyState === 1) { try { p.ws.send(s); } catch {} }
    }
  };

  let rosterDirty = true;
  const rosterFrame = (left = []) => ({
    t: 'r',
    list: room.list(),
    npcs: npcs ? npcs.roster() : [],
    probe: npcs ? npcs.stats() : { probeTotal: 0, probeOnline: 0, webTotal: 0, webOnline: 0 },
    visitors: peers.size,
    left,
  });

  /**
   * 新来的人 / 复活的人落在哪：优先借一只服务端已有的鸡的旁边（用户要的效果），
   * 场上没鸡（主控读不到数据、或全被啄倒）时才回到出生环 —— 兜底必须留着，
   * 否则没有 NPC 的时候新人会挤在原点。
   */
  function spawnSpot() {
    const near = npcs?.spotNearRandom?.();
    if (near) return near;
    const [x, z] = SPAWNS[spawnSeq++ % SPAWNS.length];
    return { x, z, yaw: 0 };
  }

  function leave(p, reason) {
    if (peers.get(p.id) !== p) return;   // 已被同名令牌接管，旧 socket 收尾时不能误删新人
    peers.delete(p.id);
    byToken.delete(p.token);
    rosterDirty = true;
    broadcast({ t: 'ev', k: 'left', id: p.id, name: p.name, reason });
  }

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || '?';
    const count = (ipCount.get(ip) || 0) + 1;
    ipCount.set(ip, count);
    if (count > 12) {
      // 同一 IP 超过 12 个连接：大概率是循环刷新或者有人写脚本，直接拒绝
      try { ws.close(1013, 'too many connections'); } catch {}
      return;
    }

    const p = {
      id: randomUUID().slice(0, 8),
      token: null,
      name: '',
      icon: '🐔',
      ws,
      x: 0, y: 0, z: 0, yaw: 0, st: ST.IDLE,
      hp: CONF.maxHp,
      score: 0,
      ko: false,
      koUntil: 0,
      lastHurtAt: 0,
      lastPeckAt: 0,
      lastWingAt: 0,
      lastMsgAt: now(),
      msgCount: 0,
      msgWindowAt: now(),
      joinedAt: now(),
      hello: false,
    };

    ws.on('message', (buf) => {
      const t = now();
      if (t - p.msgWindowAt > 1000) { p.msgWindowAt = t; p.msgCount = 0; }
      if (++p.msgCount > MAX_MSG_PER_S) return;

      let m;
      try { m = JSON.parse(String(buf)); } catch { return; }
      if (!m || typeof m !== 'object') return;

      if (m.t === 'hello') {
        if (p.hello) return;
        p.hello = true;
        const name = cleanName(m.name) || `访客${p.id.slice(0, 4)}`;
        const icon = clipped(m.icon) || '🐔';
        const claimed = typeof m.token === 'string' ? byToken.get(m.token) : null;

        if (claimed && peers.has(claimed)) {
          // 令牌认领：刷新/断线回来接着当同一只鸡，旧的 socket 让位
          const old = peers.get(claimed);
          peers.delete(old.id);
          send(old, { t: 'ev', k: 'replaced' });
          try { old.ws.close(); } catch {}
          p.id = claimed;
          p.token = m.token;
          p.name = old.name; p.icon = old.icon; p.score = old.score; p.hp = old.hp;
          p.x = old.x; p.z = old.z; p.y = old.y; p.yaw = old.yaw;
        } else {
          p.token = randomUUID();
          const spot = spawnSpot();
          p.x = spot.x; p.z = spot.z; p.yaw = spot.yaw;
        }
        p.name = name; p.icon = icon;
        peers.set(p.id, p);
        byToken.set(p.token, p.id);
        rosterDirty = true;
        send(p, { t: 'w', id: p.id, token: p.token, tick: TICK_MS });
        // 名单与 NPC 位置立刻发一次：新进来的人得先看见场上有谁，别等下一拍
        send(p, rosterFrame());
        npcRevSent = npcs ? npcs.rev : -1;
        broadcast({ t: 'ev', k: 'join', id: p.id, name: p.name, icon: p.icon });
        return;
      }

      if (!p.hello || !peers.has(p.id)) return;
      p.lastMsgAt = t;

      if (m.t === 'st') {
        // 上报位置：客户端对自己权威，但要挡越界坐标（有人手改坐标就能瞬移）
        const lim = WORLD_HALF + 5;
        p.x = Math.max(-lim, Math.min(lim, +m.x || 0));
        p.y = Math.max(-20, Math.min(40, +m.y || 0));
        p.z = Math.max(-lim, Math.min(lim, +m.z || 0));
        p.yaw = +m.yaw || 0;
        p.st = typeof m.st === 'string' ? m.st.slice(0, 8) : ST.IDLE;
        return;
      }

      if (m.t === 'peck') {
        if (p.ko || t - p.lastPeckAt < CONF.peckCooldown * 1000) return;
        p.lastPeckAt = t;
        let hit = null, bestD = Infinity;
        for (const q of peers.values()) {
          if (q === p || q.ko) continue;
          const d = Math.hypot(q.x - p.x, q.z - p.z);
          if (d > CONF.peckRange || d > bestD) continue;
          if (!inPeckArc(p, p.yaw, q)) continue;
          hit = q; bestD = d;
        }

        if (!hit && npcs) {
          // 啄到节点鸡/网站鸡：也算倒，它过一会儿自己站起来（数据说它还在线）
          const res = npcs.peckAt(p.x, p.z, p.yaw, p.y);
          if (res) {
            broadcast({
              t: 'ev', k: 'npck', f: p.id, fName: p.name, to: res.npc.id, toName: res.npc.name,
              knocked: res.knocked,
            });
            if (res.knocked) { p.score += 1; rosterDirty = true; }
            return;
          }
        }

        if (!hit) { send(p, { t: 'ev', k: 'miss' }); return; }
        hit.hp -= CONF.peckDamage;
        hit.lastHurtAt = t;
        hit.st = ST.PECK;
        // 击退方向交给被打的那个人自己施加：真人位置以他自己为准，服务端不硬拽
        const kx = hit.x - p.x, kz = hit.z - p.z;
        const kd = Math.hypot(kx, kz) || 1;
        broadcast({
          t: 'ev', k: 'peck', f: p.id, to: hit.id, fName: p.name, toName: hit.name,
          hp: Math.max(0, hit.hp),
          knock: [Number((kx / kd * CONF.peckKnock).toFixed(2)), Number((kz / kd * CONF.peckKnock).toFixed(2))],
        });
        if (hit.hp <= 0) {
          hit.hp = 0; hit.ko = true; hit.koUntil = t + CONF.koTime * 1000;
          hit.st = ST.DEAD;
          p.score += 1;
          rosterDirty = true;
          broadcast({ t: 'ev', k: 'ko', f: p.id, to: hit.id, fName: p.name, toName: hit.name });
        }
        return;
      }

      if (m.t === 'flap') {
        // 扇翅是攻击，不只是摆动作：范围更短，但没有方向限制
        if (p.ko || t - p.lastWingAt < CONF.wingCooldown * 1000) { send(p, { t: 'ev', k: 'flap', id: p.id }); return; }
        p.lastWingAt = t;
        broadcast({ t: 'ev', k: 'flap', id: p.id });

        for (const q of peers.values()) {
          if (q === p || q.ko) continue;
          if (Math.hypot(q.x - p.x, q.z - p.z) > CONF.wingRange) continue;
          q.hp -= CONF.wingDamage;
          q.lastHurtAt = t;
          const kx = q.x - p.x, kz = q.z - p.z;
          const kd = Math.hypot(kx, kz) || 1;
          broadcast({
            t: 'ev', k: 'wing', f: p.id, to: q.id, fName: p.name, toName: q.name,
            hp: Math.max(0, q.hp),
            knock: [Number((kx / kd * CONF.wingKnock).toFixed(2)), Number((kz / kd * CONF.wingKnock).toFixed(2))],
          });
          if (q.hp <= 0) {
            q.hp = 0; q.ko = true; q.koUntil = t + CONF.koTime * 1000;
            q.st = ST.DEAD;
            p.score += 1;
            rosterDirty = true;
            broadcast({ t: 'ev', k: 'ko', f: p.id, to: q.id, fName: p.name, toName: q.name });
          }
        }
        if (npcs) {
          for (const res of npcs.wingAt(p.x, p.z)) {
            broadcast({ t: 'ev', k: 'npck', f: p.id, fName: p.name, to: res.npc.id, toName: res.npc.name, knocked: res.knocked, wing: true });
            if (res.knocked) { p.score += 1; rosterDirty = true; }
          }
        }
        return;
      }

      if (m.t === 'rename') {
        const name = cleanName(m.name);
        if (name) p.name = name;
        const icon = clipped(m.icon);
        if (icon) p.icon = icon;
        rosterDirty = true;
        send(p, { t: 'ev', k: 'renamed', name: p.name, icon: p.icon });
      }
    });

    ws.on('close', () => {
      const left = (ipCount.get(ip) || 1) - 1;
      if (left <= 0) ipCount.delete(ip); else ipCount.set(ip, left);
      leave(p, 'close');
    });
    ws.on('error', () => {});
    ws.on('pong', () => { p.lastMsgAt = now(); });
  });

  // 心跳：半开连接（拔网线/休眠）不会触发 close，只能靠 ping 探活
  const hb = setInterval(() => {
    for (const p of peers.values()) {
      if (now() - p.lastMsgAt > NO_STATE_MS) {
        try { p.ws.terminate(); } catch {}
        leave(p, 'timeout');
        continue;
      }
      try { p.ws.ping(); } catch {}
    }
  }, 5000);

  let tickNo = 0;
  const tick = setInterval(() => {
    const t = now();
    tickNo++;

    for (const p of peers.values()) {
      if (p.ko && t >= p.koUntil) {
        p.ko = false;
        p.hp = CONF.maxHp;
        const spot = spawnSpot();
        p.x = spot.x; p.z = spot.z; p.y = 0; p.yaw = spot.yaw; p.st = ST.IDLE;
        rosterDirty = true;
        send(p, { t: 'ev', k: 'respawn', x: p.x, z: p.z });
        broadcast({ t: 'ev', k: 'respawned', id: p.id, name: p.name });
      } else if (!p.ko && p.hp < CONF.maxHp && t - p.lastHurtAt > REGEN_DELAY) {
        p.hp = Math.min(CONF.maxHp, p.hp + REGEN_PER_S / CONF.SNAP_HZ);
      }
    }

    npcs?.step(TICK_MS / 1000, [...peers.values()], (npc, victim, knocked) => {
      victim.hp -= CONF.peckDamage;
      victim.lastHurtAt = t;
      const kx = victim.x - npc.x, kz = victim.z - npc.z;
      const kd = Math.hypot(kx, kz) || 1;
      broadcast({
        t: 'ev', k: 'peck', f: npc.id, to: victim.id, fName: npc.name, toName: victim.name,
        hp: Math.max(0, victim.hp), npc: true,
        knock: [Number((kx / kd * CONF.peckKnock).toFixed(2)), Number((kz / kd * CONF.peckKnock).toFixed(2))],
      });
      if (victim.hp <= 0) {
        victim.hp = 0; victim.ko = true; victim.koUntil = t + CONF.koTime * 1000;
        victim.st = ST.DEAD;
        rosterDirty = true;
        broadcast({ t: 'ev', k: 'ko', f: npc.id, to: victim.id, fName: npc.name, toName: victim.name });
      }
    });

    if (peers.size === 0) { rosterDirty = false; return; }

    const npcChanged = npcs && npcs.rev !== npcRevSent;
    if ((rosterDirty || npcChanged) && t - lastRosterAt >= ROSTER_MIN_GAP_MS) {
      rosterDirty = false;
      lastRosterAt = t;
      npcRevSent = npcs ? npcs.rev : -1;
      broadcast(rosterFrame());
    }

    broadcast({
      t: 's',
      ps: [...peers.values()].map(p => [p.id, r(p.x), r(p.y), r(p.z), r(p.yaw, 2), p.st, Math.round(p.hp)]),
    });
    if (npcs && tickNo % NPC_EVERY === 0) {
      broadcast({ t: 'n', ns: npcs.positions() });
    }
  }, TICK_MS);

  wss.on('close', () => { clearInterval(tick); clearInterval(hb); });

  if (httpServer) {
    const onUpgrade = (req, socket, head) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!paths.includes(pathname)) return;   // 不是我的路径，原样留给别的监听器
      room.handleUpgrade(req, socket, head);
    };
    httpServer.on('upgrade', onUpgrade);
    room.detach = () => httpServer.off('upgrade', onUpgrade);
  }

  log.info?.(`[room] 已挂载 ${paths.join(', ')}${npcs ? ' · 已接上 NPC 鸡' : ''}`);
  return room;
}