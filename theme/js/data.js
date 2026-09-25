// 与 hub 通话：先取一次 /api/nodes，再挂上 /api/ws 实时流。
//
// 这里抄的是「监视面板不能显示一屏冻住的数字」这条底线：hub 的 WS 是 2 秒一推，
// 所以 6 秒收不到帧就认为连接半开（拔网线、休眠、中间设备超时），主动断开重连；
// 重连期间用 5 秒轮询兜底，不让人看着旧数字以为一切正常。

const POLL_MS = 5000;
const WATCHDOG_MS = 6000;
const FETCH_TIMEOUT_MS = 8000;

export function createHub({ onNodes, onState, onMe, path = '/api' } = {}) {
  let socket = null;
  let poll = null;
  let retry = null;
  let watchdog = null;
  let attempts = 0;
  let updatedAt = 0;
  let inflight = false;
  let disposed = false;
  let state = 'connecting';

  const setState = (s, detail) => {
    if (state === s && !detail) return;
    state = s;
    onState?.(s, detail);
  };

  const backoffMs = (n) => Math.min(15000, 1000 * Math.pow(1.6, Math.min(n, 6)));

  async function apiGet(p) {
    const ctrl = new AbortController();
    const bail = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(path + p, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (res.status === 401) { const e = new Error('未授权'); e.status = 401; throw e; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(bail);
    }
  }

  function receive(nodes, via) {
    if (!Array.isArray(nodes)) return;
    updatedAt = Date.now();
    attempts = 0;
    setState(via === 'live' ? 'live' : 'polling');
    onNodes?.(nodes);
    // 实时流回来了就不用继续轮询，反之亦然 —— 两条链路同时跑纯属浪费
    if (via === 'live' && poll) { clearInterval(poll); poll = null; }
  }

  async function fetchOnce() {
    if (inflight || disposed) return;
    inflight = true;
    try {
      const data = await apiGet('/nodes');
      receive(data.nodes, 'polling');
    } catch (e) {
      if (e.status === 401) {
        setState('closed', '公开页已关闭');
        if (poll) { clearInterval(poll); poll = null; }
      } else {
        setState('error', e.message);
      }
    } finally {
      inflight = false;
    }
  }

  function connect() {
    if (disposed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${path}/ws`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      // 协议被拦时构造函数就会抛，这和 onclose 是同一个结论，退回轮询 + 退避
      poll ??= setInterval(fetchOnce, POLL_MS);
      clearTimeout(retry);
      retry = setTimeout(connect, backoffMs(attempts++));
      return;
    }
    socket = ws;

    clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // 页面在后台时浏览器会节流定时器，空闲的 socket 与死掉的长得一样，不判
      if (Date.now() - updatedAt > WATCHDOG_MS) ws.close();
    }, 1000);

    ws.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (Array.isArray(payload.nodes)) receive(payload.nodes, 'live');
    };
    ws.onclose = () => {
      clearInterval(watchdog);
      if (disposed) return;
      if (poll == null) poll = setInterval(fetchOnce, POLL_MS);
      setState('reconnecting', `第 ${attempts + 1} 次重连`);
      clearTimeout(retry);
      retry = setTimeout(connect, backoffMs(attempts++));
    };
    ws.onerror = () => {};
  }

  return {
    get state() { return state; },
    start() {
      disposed = false;
      apiGet('/me').then(me => onMe?.(me)).catch(() => {});
      void fetchOnce();
      connect();
      return this;
    },
    refresh() { return fetchOnce(); },
    stop() {
      disposed = true;
      clearInterval(poll); clearInterval(watchdog); clearTimeout(retry);
      poll = null; watchdog = null; retry = null;
      try { socket?.close(); } catch {}
      socket = null;
    },
  };
}