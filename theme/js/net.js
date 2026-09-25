// 联机客户端：连接、身份续命、快照插值、事件分发。
//
// 只做网络与缓冲，不碰 DOM/Three —— 画的部分在 farm.js。远端的状态用 interp.js
// 采样成「比现在晚 130ms」的位置，网络抖一下也不会一跳一跳的。

import { createBuffer, push as pushSnap, sample, ids as bufIds, latestT } from '/shared/interp.js';
import { CONF, ST } from '/shared/physics.js';
import { roomUrl, REPORT_HZ } from './config.js';

const MAX_DROP_MS = 3000;      // 掉这么久没帧就认为断了
const NPC_MAX = 12;            // NPC 位置帧不多，缓冲小一点就够

export function createNet({ identity, onRoster, onNpcs, onSnapshot, onEvent, onStatus, onWelcome } = {}) {
  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let watchdog = null;
  let reportTimer = null;
  let stopped = false;
  let token = null;
  let myId = null;
  let lastFrameAt = 0;
  let status = 'idle';

  const rosterPlayers = new Map();         // id -> {name, icon}（名单里才有，快照里没有）
  // 令牌只存 sessionStorage：刷新还能认出同一只鸡，但**不同标签页各有各的身份**。
  // 用 localStorage 会让同浏览器的两个标签共用一个令牌，服务端只能不断「顶号」
  // （一直收到 replaced、连接反复重连），期间发出的动作全丢。
  const tokenStore = {
    get() { try { return sessionStorage.getItem('chicken-probe:token'); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('chicken-probe:token', v); } catch {} },
    clear() { try { sessionStorage.removeItem('chicken-probe:token'); } catch {} },
  };
  const players = createBuffer();          // 真人：20Hz，插值 130ms
  const npcs = createBuffer(NPC_MAX);      // NPC：5Hz，走得慢，插值同样有效
  const npcMoney = new Map();              // id -> 静态描述（名字/颜色/姿态标签）

  const setStatus = (s, detail) => {
    if (status === s && !detail) return;
    status = s;
    onStatus?.(s, detail);
  };

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ---- 收到帧 ----
  function onMessage(raw) {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    lastFrameAt = performance.now();

    switch (m.t) {
      case 'w':
        myId = m.id;
        token = m.token;
        // 令牌只在本标签页内保留：刷新/断线回来还是同一只鸡、同一个分数
        tokenStore.set(token);
        setStatus('live');
        // 必须把 id 透给上层：不知道自己是哪个 id，就会把服务端回传的「自己」
        // 当成别人 —— 于是场上多一只残影，还会被自己的残影推着走（一直滑）
        onWelcome?.(m);
        break;
      case 'replaced':
        // 身份被接管（正常只发生在手动复制标签页等场景）：丢掉令牌，
        // 重连时换一个新身份，别和对方来回顶号
        tokenStore.clear();
        onEvent?.(m);
        break;
      case 'r': {
        // 名单：真人 + NPC 描述。全是「谁在场」，每帧快照里只有位置
        npcMoney.clear();
        for (const n of m.npcs || []) npcMoney.set(n.id, n);
        rosterPlayers.clear();
        for (const p of m.list || []) rosterPlayers.set(p.id, p);
        for (const id of m.left || []) rosterPlayers.delete(id);
        onRoster?.(m.list || [], m.probe || {}, m.left || []);
        onNpcs?.(npcMoney);
        break;
      }
      case 's': {
        const map = new Map();
        for (const row of m.ps || []) {
          const [id, x, y, z, yaw, st, hp] = row;
          const meta = rosterPlayers.get(id) || {};
          map.set(id, { x, y, z, yaw, st, hp, name: meta.name, icon: meta.icon });
        }
        pushSnap(players, performance.now(), map);
        break;
      }
      case 'n': {
        const map = new Map();
        for (const row of m.ns || []) {
          const [id, x, z, yaw, st] = row;
          const meta = npcMoney.get(id) || {};
          map.set(id, { x, y: 0, z, yaw, st, name: meta.name, icon: '' });
        }
        pushSnap(npcs, performance.now(), map);
        break;
      }
      default:
        if (m.t === 'ev') onEvent?.(m);
    }
  }



  // ---- 连接 ----
  function connect() {
    if (stopped) return;
    const url = roomUrl();
    if (!url) { setStatus('off'); return; }

    let sock;
    try {
      sock = new WebSocket(url);
    } catch {
      scheduleRetry('地址不合法');
      return;
    }
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      send({ t: 'hello', token: tokenStore.get() || undefined, name: identity.name, icon: identity.icon });
      setStatus('connecting');
      startReporting();
    };
    sock.onmessage = (e) => onMessage(e.data);
    sock.onclose = () => {
      stopReporting();
      if (stopped) return;
      scheduleRetry();
    };
    sock.onerror = () => {};

    clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // 半开连接：不主动判断就会一直显示别人冻住的位置
      if (performance.now() - lastFrameAt > MAX_DROP_MS) { try { ws.close(); } catch {} }
    }, 1000);
  }

  function scheduleRetry(why) {
    setStatus('reconnecting', why);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(10000, 700 * Math.pow(1.6, Math.min(retry++, 5))));
  }

  // ---- 上报 ----
  function startReporting() {
    stopReporting();
    reportTimer = setInterval(() => {
      if (document.hidden) return;
      const st = reporter?.() || {};
      send({ t: 'st', x: r(st.x), y: r(st.y), z: r(st.z), yaw: r(st.yaw, 3), st: st.st || ST.IDLE });
    }, 1000 / REPORT_HZ);
  }
  function stopReporting() { clearInterval(reportTimer); reportTimer = null; }

  let reporter = null;
  const r = (v, n = 3) => Number.isFinite(+v) ? Number((+v).toFixed(n)) : 0;

  return {
    get id() { return myId; },
    get status() { return status; },
    get url() { return roomUrl(); },
    get roster() { return rosterPlayers; },
    get npcInfo() { return npcMoney; },

    start() {
      stopped = false;
      lastFrameAt = performance.now();
      connect();
      return this;
    },
    stop() {
      stopped = true;
      clearInterval(watchdog); clearTimeout(retryTimer);
      stopReporting();
      try { ws?.close(); } catch {}
      ws = null;
      setStatus('off');
    },

    /** 由渲染循环提供「我这只鸡现在在哪」，上报就是读一下它。 */
    setReporter(fn) { reporter = fn; },
    /** 进房间/离开房间时手动补一次，别等下一个 50ms。 */
    pushStateNow(st) { send({ t: 'st', x: r(st.x), y: r(st.y), z: r(st.z), yaw: r(st.yaw, 3), st: st.st || ST.IDLE }); },

    peck() { send({ t: 'peck' }); },
    flap() { send({ t: 'flap' }); },
    rename(name, icon) { send({ t: 'rename', name, icon }); },

    /**
     * 采样：给我「现在该显示成什么样」。
     * @param {number} delayMs 落后的毫秒数（默认取 CONF.RENDER_DELAY）
     */
    samplePlayers(delayMs = CONF.RENDER_DELAY) {
      const target = performance.now() - delayMs;
      const out = new Map();
      for (const id of bufIds(players)) {
        const s = sample(players, target, id);
        if (s) out.set(id, s);
      }
      return out;
    },
    sampleNpcs(delayMs = CONF.RENDER_DELAY) {
      const target = performance.now() - delayMs;
      const out = new Map();
      for (const id of bufIds(npcs)) {
        const s = sample(npcs, target, id);
        if (s) out.set(id, s);
      }
      return out;
    },
    get lastFrameAt() { return lastFrameAt; },
    get hasFrames() { return latestT(players) > 0; },
  };
}