// 历史数据层：按节点的历史指标与延迟/丢包。
//
// 真 hub 的接口（monitor hub，匿名可读）：
//   GET /api/nodes/{id}/metrics?hours=1|6|24|168&points=300..1500&series=metrics|ping
//   metrics → { metrics: [{ts, cpu, cpu_max, minutes, mem_used, disk_used, net_rx, net_tx}],
//               hours, step }
//   ping    → { ping: [{task_id, ts, latency, band?, loss?}], probes: {id: 名称}, loss: {id: 比值}, hours }
// 匿名访客的历史窗口会被主控夹到一个上限，所以响应里的 hours 可能小于请求值 —— 界面要显示实际窗口。
// 主控保留多久（history_days）由 /api/me 给出，v1.3.2 起才有；没有就是老 hub，按 7 天算。
// cpu_max / minutes / step 同样是 v1.3.2 起才有的字段，缺了各自退回原样（见 normalizeRows 与 load）。

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
    /*
     * hub v1.3.1 起报错正文是一句写给人看的中文（如「主题包校验失败，请重新下载」），
     * 且是 text/plain。旧 hub 给的是 unauthorized 这类原始英文短语，反代/CDN
     * 给的是 HTML 页面 —— 这两种都不该显示给访客，所以只认含中文的短句。
     */
    const body = await res.text().catch(() => '');
    const e = new Error(hubText(body) || (res.status === 401 ? '公开页已关闭' : `HTTP ${res.status}`));
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** hub 自己那句中文错误；不是中文短句（英文原始错误、HTML 页面、空响应）时返回空串。 */
export function hubText(raw) {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t || t.length > 200) return '';
  if (t.includes('\n') || t.includes('\r') || t.includes('<')) return '';
  return CJK.test(t) ? t : '';
}

/**
 * 本主题在面板里保存的设置，来自 `GET /api/themes/{short}/config`（hub v1.3.0 起）。
 *
 * hub 原样存面板写进去的对象、不校验字段，所以取值一律经 `pick()` 按声明的类型
 * 判断，而不是直接读。接口不存在（旧 hub 404）、匿名访客被拒（401）都当作
 * 「没有任何保存的设置」，即全部用默认值 —— 不能为一个设置项让整个面板失败。
 */
export async function themeConfig(short, signal) {
  try {
    const res = await fetch(`/api/themes/${encodeURIComponent(short)}/config`, {
      signal, headers: { accept: 'application/json' },
    });
    if (!res.ok) return {};
    const raw = await res.json();
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 取一个设置项。类型由声明决定而不是由存下来的值决定：
 * `Boolean('false')` 是 true，字符串 "false" 绝不能被读成开启。
 */
export function pick(saved, field) {
  const v = saved?.[field.key];
  if (v === undefined || v === null) return field.default;
  if (field.type === 'boolean') return typeof v === 'boolean' ? v : field.default;
  if (field.type === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : field.default;
  return typeof v === 'string' ? v : field.default;
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
        /*
         * net_rx_max / net_tx_max 是 hub v1.3.1 起每行多出的「这一分钟里的最高
         * 网速」，与 net_rx / net_tx（这一分钟的均值）并列。旧 hub 没有这两个
         * 字段，normalizeRows 会把缺失值统一成 null，曲线自然不画峰值。
         *
         * cpu_max 与 minutes 是 v1.3.2 起跟着来的：前者是这一格里的 CPU 峰值
         * （小时级汇总取的是各分钟峰值的最大值），后者是这一格实际折进了多少
         * 分钟行。step 是整段响应共用的「每格覆盖多少秒」，用它减去 minutes
         * 才能看出哪几格没被填满 —— 缺了就是老 hub，那份说明也就不显示。
         *
         * swap_used / tcp / udp / procs 是 hub v1.4.1 起每行多出的四项：交换分区
         * 已用量（字节）与 TCP/UDP 连接数、进程数（计数取整）。旧 hub 同样没有，
         * 缺失即 null —— 交换曲线与连接数曲线整段不画，而不是画成 0。
         */
        : {
          hours: realHours,
          step: num(data.step),
          rows: normalizeRows(data.metrics, [
            'cpu', 'cpu_max', 'minutes', 'mem_used', 'disk_used', 'net_rx', 'net_tx', 'net_rx_max', 'net_tx_max',
            'swap_used', 'tcp', 'udp', 'procs',
          ]),
        };
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