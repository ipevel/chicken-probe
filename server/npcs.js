// NPC 鸡的管理（探针鸡 / 网站鸡）。位置由服务端说了算，客户端只负责画 ——
// 这和参考站一样：谁在场、站在哪、什么姿态，都是服务端一头的事，客户端不同步这些。

import { CONF, ST, WORLD_HALF, OBSTACLES, inPeckArc, resolveCircle } from '../shared/physics.js';
import { appearance, spotFor } from '../shared/node-map.js';
import { statusOf, staleFor } from '../shared/derive.js';

const WALK_SPEED = 1.15;
// 残血逃跑：要「一口气跑很远」，所以跑得比玩家的疾跑（5.4）还快一点，
// 否则追着啄的人一步不落、永远在身后 —— 但也不能变成闪现，位置仍然是每拍推进的。
const FLEE_SPEED = 7.2;         // 明显快过玩家疾跑 5.4：一口气拉开，人得追
const FLEE_MS = 4500;   // 一般能跑到 22 米的安全距离再停，而不是被时间截断
const FLEE_SAFE_DIST = 22;      // 要跑这么远才算安全（场地半宽 26，差不多横穿大半场）
const FLEE_COOLDOWN_MS = 6000;  // 冷却：不然每挨一口就再逃一次，低血的鸡永远追不上
// 逃完不是立刻回窝 —— 那会让人看到「它又自己走回来了」，等于没跑远。
// 先把窝挪到落脚点（鸡迁到新地盘），再原地歇一会儿，之后才在附近闲逛。
const FLEE_REST_MS = 5000;
const HOME_RADIUS = 3.2;
const RETARGET_MIN_MS = 3000;
const RETARGET_MAX_MS = 9000;
const MAX_NPCS = 240;
const NPC_HP = 60;

/** 探针状态 → 鸡的姿态。面板卡片、鸡的姿态读的是同一个 statusOf，不会互相矛盾。 */
function poseFor(status, { staleSec = null } = {}) {
  switch (status) {
    case 'unconnected': return { state: ST.SLEEP, tone: 'muted', label: '未接入' };
    case 'offline': return { state: ST.DEAD, tone: 'danger', label: '离线' };
    case 'stale': return { state: ST.IDLE, tone: 'muted', label: `陈旧 ${staleSec ?? 0}s` };
    case 'unreadable': return { state: ST.IDLE, tone: 'danger', label: '数据不可读' };
    case 'quota': return { state: ST.IDLE, tone: 'warn', label: '流量超限' };
    case 'alert': return { state: ST.ALERT, tone: 'danger', label: '告警' };
    case 'expiring': return { state: ST.IDLE, tone: 'warn', label: '即将到期' };
    default: return { state: ST.IDLE, tone: 'ok', label: '正常' };
  }
}

export function createNpcManager({ now = () => Date.now(), log = console } = {}) {
  const npcs = new Map();      // id -> npc
  let rosterDirty = true;
  let rev = 0;
  let cachedRoster = [];

  /**
   * 名单内容真的变了：作废缓存，并**当场**推进版本号 —— 房间是拿版本号比对
   * 来决定「要不要重发名单」的，只置脏不推版本号的话，被啄掉的这点血就永远
   * 卡在服务端，客户端的名牌血条不会动。
   */
  function markRosterDirty() {
    rosterDirty = true;
    rev++;
  }

  function make(id, kind, name, country, home, look, pose) {
    return {
      id, kind, name, country,
      home,
      x: home.x, z: home.z, yaw: home.yaw, st: pose.state,
      tone: pose.tone, label: pose.label,
      scale: look.scale, colors: { body: look.palette, comb: look.comb },
      hp: NPC_HP, maxHp: NPC_HP, ko: false, koUntil: 0, kx: 0, kz: 0,
      nextAttackAt: 0,
      // 逃跑：记下最后打它的位置，朝反方向跑；不在逃跑时 fleeUntil 为 0
      fleeFrom: null, fleeDir: null, fleeUntil: 0, fleeCdUntil: 0, restUntil: 0, speed: 0,
      // 走动目标：站着不动时为空
      tx: null, tz: null, nextPickAt: 0,
      moving: false,
    };
  }

  /** 击退冲量：和真人一样按指数衰减，被啄的鸡会被推出去一段。 */
  function applyKnock(npc, dt) {
    if (!npc.kx && !npc.kz) return;
    npc.x += npc.kx * dt;
    npc.z += npc.kz * dt;
    const f = Math.exp(-6 * dt);
    npc.kx *= f; npc.kz *= f;
    if (Math.abs(npc.kx) < 0.02) npc.kx = 0;
    if (Math.abs(npc.kz) < 0.02) npc.kz = 0;
  }

  const isFleeing = (npc, t) => npc.fleeUntil > 0 && !npc.ko && t < npc.fleeUntil;

  /** 残血就记下攻击者的位置开始逃：追着打的人越多，逃得越频繁，这是被压制的反馈。 */
  function startFlee(npc, at) {
    if (npc.ko || npc.hp > npc.maxHp / 3) return;
    if (now() < npc.fleeCdUntil) return;   // 刚逃过：给追的人一个能打中的窗口
    npc.fleeFrom = { x: at.x, z: at.z };
    npc.fleeUntil = now() + FLEE_MS;
    npc.fleeCdUntil = now() + FLEE_MS + FLEE_COOLDOWN_MS;
    npc.tx = null; npc.tz = null;      // 闲逛目标作废，否则逃一半又拐回原地
    npc.tone = 'warn';
    npc.label = '逃跑中';
    markRosterDirty();
  }

  /** 逃完的收尾：把窝挪到落脚点（不再往回走），并原地歇一会儿。 */
  function settleAfterFlee(npc, t = now()) {
    if (npc.fleeUntil > 0) {
      npc.home = { x: npc.x, z: npc.z };   // 迁到新地盘：之后它在附近闲逛，而不是走回老家
      npc.restUntil = t + FLEE_REST_MS;
    }
    npc.fleeUntil = 0;
    npc.fleeFrom = null;
    npc.fleeDir = null;
    npc.moving = false;
    npc.speed = 0;
    markRosterDirty();   // 名单里的「逃跑中」要跟着撤掉
  }

  /** 逃跑一步。返回 true 表示这一拍被逃跑接管，不该再闲逛。 */
  function fleeStep(npc, dt, t) {
    if (npc.fleeUntil <= 0) return false;
    if (npc.ko || t >= npc.fleeUntil || !npc.fleeFrom) { settleAfterFlee(npc); return false; }
    const d = Math.hypot(npc.x - npc.fleeFrom.x, npc.z - npc.fleeFrom.z);
    if (d >= FLEE_SAFE_DIST) { settleAfterFlee(npc); return false; }

    // 逃跑方向记在 npc.fleeDir 上：一开始背离攻击者，撞到东西就转个角度侧移。
    // 不记下来的话，每拍都重新算「背离攻击者」，会一头扎在同一块石头上原地不动
    if (!npc.fleeDir) {
      let ux, uz;
      if (d < 1e-3) {
        // 和攻击者重叠（刚被击退时可能碰上）：随便挑个方向，别原地不动
        const a = Math.random() * Math.PI * 2;
        ux = Math.sin(a); uz = Math.cos(a);
      } else {
        ux = (npc.x - npc.fleeFrom.x) / d;
        uz = (npc.z - npc.fleeFrom.z) / d;
      }
      npc.fleeDir = { x: ux, z: uz };
    }

    const intended = FLEE_SPEED * dt;
    const bx = npc.x, bz = npc.z;
    npc.x += npc.fleeDir.x * intended;
    npc.z += npc.fleeDir.z * intended;
    // 跑得快就更不能穿模：贴着鸡舍/石头跑时把它推出来（和真人用同一套盒式推出）
    resolveCircle(npc, CONF.radius, OBSTACLES);
    const lim = WORLD_HALF - CONF.radius - 0.2;
    npc.x = Math.max(-lim, Math.min(lim, npc.x));
    npc.z = Math.max(-lim, Math.min(lim, npc.z));

    // 实际几乎没动 = 撞上了东西（障碍或围栏）：转 60° 侧移再跑。
    // 往哪边转由 id 定，稳定可复现，不会两拍之间来回抖
    const moved = Math.hypot(npc.x - bx, npc.z - bz);
    if (moved < intended * 0.45) {
      const sign = npc.id.charCodeAt(1) % 2 === 0 ? 1 : -1;
      const a = Math.atan2(npc.fleeDir.z, npc.fleeDir.x) + sign * Math.PI / 3;
      npc.fleeDir = { x: Math.cos(a), z: Math.sin(a) };
    }

    npc.yaw = Math.atan2(npc.fleeDir.x, npc.fleeDir.z);
    npc.moving = true;
    npc.speed = FLEE_SPEED;
    return true;
  }

  function wander(npc, dt, t) {
    // 倒地/趴睡的鸡不动：这是姿态，也是「这台机器不用管」的视觉提示
    if (npc.ko || npc.st === ST.DEAD || npc.st === ST.SLEEP || npc.st === ST.ALERT) {
      npc.moving = false;
      npc.speed = 0;
      return;
    }
    // 刚逃完：站着喘一会儿，别立刻又开始溜达（否则看起来像"没跑"）
    if (t < npc.restUntil) {
      npc.moving = false;
      npc.speed = 0;
      return;
    }
    if (npc.tx == null && t >= npc.nextPickAt) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * HOME_RADIUS;
      npc.tx = npc.home.x + Math.cos(a) * r;
      npc.tz = npc.home.z + Math.sin(a) * r;
      npc.nextPickAt = t + RETARGET_MIN_MS + Math.random() * (RETARGET_MAX_MS - RETARGET_MIN_MS);
    }
    if (npc.tx != null) {
      const dx = npc.tx - npc.x, dz = npc.tz - npc.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.12) {
        npc.tx = null; npc.tz = null; npc.moving = false; npc.speed = 0;
      } else {
        npc.x += (dx / d) * WALK_SPEED * dt;
        npc.z += (dz / d) * WALK_SPEED * dt;
        resolveCircle(npc, CONF.radius, OBSTACLES);
        npc.yaw = Math.atan2(dx, dz);
        npc.moving = true;
        npc.speed = WALK_SPEED;
      }
    }
  }

  function rebuild(nodes, webSites) {
    const seen = new Set();

    for (const node of nodes) {
      if (npcs.size >= MAX_NPCS) break;
      const id = `p${node.id}`;
      seen.add(id);
      const spot = spotFor(node);
      const look = appearance(node);
      const status = statusOf(node);
      const pose = poseFor(status, { staleSec: staleFor(node) });
      const stats = {
        cpu: node.metrics?.cpu != null ? Math.min(1, node.metrics.cpu / 100) : null,
        mem: node.metrics?.mem_used != null && node.metrics?.mem_total
          ? Math.min(1, node.metrics.mem_used / node.metrics.mem_total) : null,
        up: node.metrics?.uptime ?? null,
        netIn: node.metrics?.net_rx ?? null,
        netOut: node.metrics?.net_tx ?? null,
      };
      const existing = npcs.get(id);
      if (!existing) {
        npcs.set(id, Object.assign(make(id, 'probe', node.name, node.country, spot, look, pose), { stats }));
        markRosterDirty();
      } else {
        existing.stats = stats;
        // 名字/地区/姿态可能变；位置只由 id 决定，不动
        if (existing.name !== node.name || existing.country !== node.country) markRosterDirty();
        const before = `${existing.st}|${existing.tone}|${existing.label}`;
        existing.name = node.name;
        existing.country = node.country;
        // 逃跑的姿态是「正在被追杀」的即时反馈，这一轮探针数据不该把它擦掉；
        // 逃跑结束后（fleeUntil 过期）下一次 rebuild 自然按数据恢复
        if (!existing.ko && !isFleeing(existing, now())) {
          existing.st = pose.state; existing.tone = pose.tone; existing.label = pose.label;
        }
        if (`${existing.st}|${existing.tone}|${existing.label}` !== before) markRosterDirty();
      }
    }

    webSites.forEach((site, i) => {
      const id = `w${i}`;
      seen.add(id);
      const a = (i / Math.max(1, webSites.length)) * Math.PI * 2;
      const r = WORLD_HALF - 6 - (i % 3) * 2.2;
      const home = { x: Math.cos(a) * r, z: Math.sin(a) * r, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) };
      const look = appearance({ id: 9000 + i });
      const pose = site.ok === false
        ? { state: ST.DEAD, tone: 'danger', label: `网站不可达${site.status === 0 ? '' : ` HTTP ${site.status}`}` }
        : site.ok == null
          ? { state: ST.SLEEP, tone: 'muted', label: '未探测' }
          : site.latency > 1500
            ? { state: ST.ALERT, tone: 'warn', label: `慢 ${site.latency}ms` }
            : { state: ST.IDLE, tone: 'ok', label: `正常 ${site.latency}ms` };
      const stats = { latency: site.latency ?? null, reason: site.error || (site.status ? `HTTP ${site.status}` : ''), up: null, cpu: null, mem: null, netIn: null, netOut: null };
      const existing = npcs.get(id);
      if (!existing) {
        npcs.set(id, Object.assign(make(id, 'web', site.name, '', home, look, pose), { stats }));
        markRosterDirty();
      } else if (!existing.ko) {
        existing.stats = stats;
        // 同探针鸡：逃跑姿态优先，探针数据等它逃完再接手
        if (!isFleeing(existing, now())) {
          const before = `${existing.st}|${existing.tone}|${existing.label}`;
          existing.st = pose.state; existing.tone = pose.tone; existing.label = pose.label;
          if (`${existing.st}|${existing.tone}|${existing.label}` !== before) markRosterDirty();
        }
      }
    });

    for (const [id, npc] of npcs) {
      if (!seen.has(id)) { npcs.delete(id); log.info?.(`[npc] ${npc.name} 从场上移除`); rosterDirty = true; }
    }
    if (npcs.size >= MAX_NPCS && nodes.length > MAX_NPCS) {
      log.warn?.(`[npc] 节点数超过 ${MAX_NPCS}，只放出前 ${MAX_NPCS} 只鸡 —— 再多快照就压不动了`);
    }
    // 这里只作废缓存不推版本号：节点的 cpu/内存这类统计每轮都在变，
    // 但名单是低频消息，跟着版本号走会在人一多时变成每 2 秒一份的大包
    rosterDirty = true;
  }

  return {
    get size() { return npcs.size; },
    /** 名单版本号：变了才需要往客户端重发一遍 NPC 描述。 */
    get rev() { return rev; },
    rebuild,

    /**
     * 推进一拍。
     * @param {number} dt
     * @param {Array} players 场上真人（允许被高占用的节点鸡主动啄）
     * @param {Function} onAttack 攻击回调：(npc, victim, knocked)
     */
    step(dt, players = [], onAttack = null) {
      const t = now();
      for (const npc of npcs.values()) {
        if (npc.ko && t >= npc.koUntil) {
          // 起身：位置回自己的窝，姿态交回给下一次 rebuild 按数据重算
          npc.ko = false;
          npc.hp = NPC_HP;
          npc.x = npc.home.x; npc.z = npc.home.z;
          npc.kx = 0; npc.kz = 0;
          npc.fleeUntil = 0;
          markRosterDirty();          // 满血复活，血条得跟着回满
        }
        applyKnock(npc, dt);
        if (!fleeStep(npc, dt, t)) wander(npc, dt, t);

        // 高占用的机器会主动啄人：告警态的节点鸡离得够近就出嘴
        if (npc.tone === 'danger' && npc.st === ST.ALERT && !npc.ko && !isFleeing(npc, t) && onAttack && t >= npc.nextAttackAt) {
          for (const q of players) {
            if (q.ko) continue;
            if (Math.hypot(q.x - npc.x, q.z - npc.z) > CONF.peckRange) continue;
            npc.nextAttackAt = t + 1200 + Math.random() * 1800;
            npc.yaw = Math.atan2(q.x - npc.x, q.z - npc.z);
            onAttack(npc, q, false);
            break;
          }
        }
      }
    },

    /** 名单只在变化时重建：客户端据此知道场上有哪些鸡。版本号由 markRosterDirty 推进。 */
    roster() {
      if (rosterDirty) {
        rosterDirty = false;
        cachedRoster = [...npcs.values()].map(n => ({
          id: n.id, kind: n.kind, name: n.name, country: n.country,
          label: n.label, tone: n.tone, state: n.st, scale: n.scale,
          palette: n.colors.body, comb: n.colors.comb,
          offline: n.st === ST.DEAD || n.st === ST.SLEEP,
          ko: n.ko,
          hp: Math.round(n.hp), maxHp: n.maxHp,
          ...(n.stats || {}),
        }));
      }
      return cachedRoster;
    },

    /** 位置列表：只发位置/朝向/姿态，名字那些在名单里，不必每帧重发。 */
    positions() {
      const out = [];
      for (const n of npcs.values()) {
        out.push([n.id, r(n.x), r(n.z), r(n.yaw, 2), n.st]);
      }
      return out;
    },

    /**
     * 给新访客/复活的人挑个落点：随机借一只还在场的鸡当基准，再错开一点点 ——
     * 用户要的是「随机落到某只鸡旁边」，而不是固定出生环上凭空冒出来。
     * 场上没鸡（比如主控读不到数据）时返回 null，由调用方自己兜底。
     */
    spotNearRandom() {
      const live = [];
      for (const n of npcs.values()) if (!n.ko) live.push(n);
      if (!live.length) return null;
      const base = live[(Math.random() * live.length) | 0];
      const a = Math.random() * Math.PI * 2;
      const off = 0.6 + Math.random() * 0.6;   // 完全重叠会黏在一起，错开才有「落在旁边」的样子
      const lim = WORLD_HALF - 0.8;
      return {
        x: r(Math.max(-lim, Math.min(lim, base.x + Math.sin(a) * off))),
        z: r(Math.max(-lim, Math.min(lim, base.z + Math.cos(a) * off))),
        yaw: r(a, 2),
      };
    },

    /** 啄判定：够近、正对着、且没倒地的 NPC。 */
    peckAt(x, z, yaw, y = 0) {
      let best = null, bestD = Infinity;
      for (const n of npcs.values()) {
        if (n.ko || n.st === ST.SLEEP) continue;
        const d = Math.hypot(n.x - x, n.z - z);
        if (d > CONF.peckRange || d > bestD) continue;
        if (!inPeckArc({ x, z, y }, yaw, { x: n.x, z: n.z, y: 0 })) continue;
        best = n; bestD = d;
      }
      if (!best) return null;
      best.hp -= CONF.peckDamage;
      // 被啄的 NPC 会被推出去：它归服务端管，冲量直接加在它身上
      const dx = best.x - x, dz = best.z - z;
      const d = Math.hypot(dx, dz) || 1;
      best.kx = (dx / d) * CONF.peckKnock;
      best.kz = (dz / d) * CONF.peckKnock;
      markRosterDirty();                         // 血量进了名单，掉了血就得让客户端看见
      if (best.hp <= 0) {
        best.hp = 0;
        best.ko = true;
        best.koUntil = now() + CONF.koTime * 1000;
        best.fleeUntil = 0;                      // 倒了就不用再逃
        best.st = ST.DEAD;
        best.tone = 'danger';
        best.label = '被啄倒';
        markRosterDirty();
        return { npc: best, knocked: true };
      }
      startFlee(best, { x, z });
      return { npc: best, knocked: false };
    },

    /** 扇翅：范围短、无方向限制，范围内所有没倒地的鸡都吃一下。 */
    wingAt(x, z, range = CONF.wingRange) {
      const out = [];
      for (const n of npcs.values()) {
        if (n.ko || n.st === ST.SLEEP) continue;
        const dx = n.x - x, dz = n.z - z;
        const d = Math.hypot(dx, dz);
        if (d > range) continue;
        n.hp -= CONF.wingDamage;
        n.kx = (dx / (d || 1)) * CONF.wingKnock;
        n.kz = (dz / (d || 1)) * CONF.wingKnock;
        markRosterDirty();                       // 同上：血量变了，名单要跟着发
        if (n.hp <= 0) {
          n.hp = 0; n.ko = true; n.koUntil = now() + CONF.koTime * 1000;
          n.fleeUntil = 0;
          n.st = ST.DEAD; n.tone = 'danger'; n.label = '被啄倒';
          markRosterDirty();
          out.push({ npc: n, knocked: true });
        } else {
          startFlee(n, { x, z });
          out.push({ npc: n, knocked: false });
        }
      }
      return out;
    },

    stats() {
      let probeTotal = 0, probeOnline = 0, webTotal = 0, webOnline = 0;
      for (const n of npcs.values()) {
        if (n.kind === 'probe') {
          probeTotal++;
          if (n.st !== ST.DEAD && n.st !== ST.SLEEP) probeOnline++;
        } else {
          webTotal++;
          if (n.st !== ST.DEAD && n.st !== ST.SLEEP) webOnline++;
        }
      }
      return { probeTotal, probeOnline, webTotal, webOnline };
    },
  };
}

const r = (v, n = 2) => Number.isFinite(+v) ? Number((+v).toFixed(n)) : 0;