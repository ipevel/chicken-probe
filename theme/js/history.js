// 历史数据层：按节点的历史指标与延迟/丢包。
//
// 真 hub 的接口（monitor hub，匿名可读）：
//   GET /api/nodes/{id}/metrics?hours=1|6|24|168&points=300..1500&series=metrics|ping
//   metrics → { metrics: [{ts, cpu, mem_used, disk_used, net_rx, net_tx}], hours }
//   ping    → { ping: [{task_id, ts, latency, band?, loss?}], probes: {id: 名称}, loss: {id: 比值}, hours }
// 匿名访客的历史窗口会被主控夹到一个上限，所以响应里的 hours 可能小于请求值 —— 界面要显示实际窗口。

const CACHE_TTL_MS = 60_000;
const cache = new Map();       // key -> { t, data }
const inflight = new Map();    // key -> Promise（同一个请求被多处要时只发一次）

/** 采样点数按容器宽度定：1.5 倍超采样足够，再多只是白烧流量。 */
export function pointsForWidth(width) {
  return Math.min(1500, Math.max(300, Math.round(width * 1.5)));
}

function keyOf(id, series, hours, points) { return `${id}|${series}|${hours}|${points}`; }

async function fetchJson(path, signal) {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    const e = new Error(res.status === 401 ? '公开页已关闭' : `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

/** 历史行：丢掉没有 ts 的、按时间升序、把非数字统一成 null（曲线断开而不是画成 0）。 */
export function normalizeRows(raw, keys) {
  const rows = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const ts = num(r?.ts);
    if (ts == null) continue;
    const row = { ts };
    for (const k of keys) row[k] = num(r[k]);
    rows.push(row);
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

async function load(id, series, hours, width) {
  const points = pointsForWidth(width);
  const key = keyOf(id, series, hours, points);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;

  if (inflight.has(key)) return inflight.get(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  const task = (async () => {
    try {
      const path = `/api/nodes/${encodeURIComponent(id)}/metrics?hours=${hours}&points=${points}&series=${series}`;
      const data = await fetchJson(path, ctrl.signal);
      // 实际窗口：主控会把匿名访客的窗口夹小，界面按这个显示
      const realHours = Number.isFinite(Number(data.hours)) ? Number(data.hours) : hours;
      const out = series === 'ping'
        ? { hours: realHours, ...shapePing(data) }
        : { hours: realHours, rows: normalizeRows(data.metrics, ['cpu', 'mem_used', 'disk_used', 'net_rx', 'net_tx']) };
      cache.set(key, { t: Date.now(), data: out });
      return out;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

function shapePing(data) {
  const probes = data.probes && typeof data.probes === 'object' ? data.probes : {};
  const ids = Object.keys(probes).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const lost = data.loss && typeof data.loss === 'object' ? data.loss : {};
  const loss = {};
  for (const id of ids) loss[id] = num(lost[id]) ?? null;
  return {
    points: Array.isArray(data.ping) ? data.ping : [],
    probes,
    ids,
    loss,
  };
}

/**
 * 名字不叫 `history`：那会遮蔽全局的 `window.history`，而面板里用后者写 URL 状态
 * （`history.replaceState`）。这个坑是「点关闭没反应」的根因 —— 关闭时先写 URL，
 * 抛了 TypeError 就中断在与后面那句加 `closed` 类之间。
 */
export const nodeHistory = {
  /** 资源历史。`totals` 用来算百分比（历史行里只有 used，没有 total）。 */
  metrics(id, hours, width) { return load(id, 'metrics', hours, width); },
  ping(id, hours, width) { return load(id, 'ping', hours, width); },
  /** 手动刷新（详情页的「刷新」按钮 / 排查用）。 */
  invalidate(id) {
    for (const k of [...cache.keys()]) if (k.startsWith(`${id}|`)) cache.delete(k);
  },
  get size() { return cache.size; },
};