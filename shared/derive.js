// 面板的判定层：状态、阈值、排序、汇总、格式化。全是纯函数 ——
// 「这台机器算不算告警」这种判断会同时决定总览条的数字、筛选出来的列表、
// 卡片上的色条和鸡场里那只鸡的姿态。四处各写一遍必然互相矛盾，所以只写一遍。
//
// 阈值沿用你现有主题的约定：80% 转琥珀、92% 转红；agent 停报 120 秒算陈旧。

export const WARN_AT = 80;
export const DANGER_AT = 92;
export const STALE_AFTER = 120;
export const EXPIRING_DAYS = 7;

export const nowSec = () => Math.floor(Date.now() / 1000);

/** 机器有没有装过探针：没装过的机器「离线」和「未接入」是两件事。 */
export function deployed(node) {
  return (node.cpu_cores > 0) || (node.mem_total > 0);
}

/** 读数停了多久（秒）。0 或没有 last_seen 表示从没上报过，不算陈旧。 */
export function staleFor(node, now = nowSec()) {
  if (!node.last_seen) return null;
  const age = now - node.last_seen;
  return age > STALE_AFTER ? age : null;
}

/** hub 送了 metrics，但核心字段一个都读不出来 —— 和「还没上报」不是一回事。 */
export function unreadable(node) {
  const m = node.metrics;
  if (!m) return false;
  return m.cpu == null && m.mem_total == null && m.disk_total == null && !m.load;
}

export function pct(used, total) {
  if (used == null || !total) return null;
  return (used / total) * 100;
}

/** 用量条的着色：低于 80 一律不着色，免得四列白卡片上到处是颜色。 */
export function toneOf(v) {
  if (v == null) return 'ok';
  if (v >= DANGER_AT) return 'danger';
  if (v >= WARN_AT) return 'warn';
  return 'ok';
}

/** 负载承担在核数上：load1 超过核数的 2 倍才算告警，单看数值没有意义。 */
export function loadTone(node) {
  const load = node.metrics?.load?.[0];
  const cores = node.cpu_cores;
  if (load == null || !cores) return 'ok';
  const r = load / cores;
  if (r >= 2) return 'danger';
  if (r >= 1) return 'warn';
  return 'ok';
}

/** 计费周期用量：hub 新版给 month_used，老 hub 只有两个方向加模式。 */
export function monthUsage(node) {
  if (node.month_used != null && node.month_used > 0) return node.month_used;
  const rx = node.month_rx || 0, tx = node.month_tx || 0;
  if (rx + tx === 0) return 0;
  return node.traffic_mode === 'max' ? Math.max(rx, tx) : rx + tx;
}

export function quotaOver(node) {
  const limit = node.traffic_limit || 0;
  if (limit <= 0) return false;
  return monthUsage(node) > limit;
}

/** 主状态：只取一个，决定筛选项、色条和鸡的姿态。优先级从坏到好。 */
export function statusOf(node, now = nowSec()) {
  if (!deployed(node)) return 'unconnected';
  if (!node.online) return 'offline';
  if (staleFor(node, now)) return 'stale';
  if (unreadable(node)) return 'unreadable';
  if (quotaOver(node)) return 'quota';
  const m = node.metrics;
  const hot = [m?.cpu, pct(m?.mem_used, m?.mem_total), pct(m?.disk_used, m?.disk_total)]
    .some(v => v != null && v >= DANGER_AT);
  if (hot || loadTone(node) === 'danger') return 'alert';
  if (expiringIn(node) != null && expiringIn(node) <= EXPIRING_DAYS) return 'expiring';
  return 'ok';
}

/** 还有几天到期。expires_in 优先（hub 按自己的日历算过），退回 expires_at。 */
export function expiringIn(node, now = nowSec()) {
  if (node.expires_in != null) return node.expires_in;
  if (!node.expires_at) return null;
  const t = Date.parse(node.expires_at + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now * 1000) / 86400000);
}

export const STATUS_LABEL = {
  alert: '告警',
  offline: '离线',
  stale: '读数陈旧',
  unreadable: '数据不可读',
  quota: '超流量',
  expiring: '即将到期',
  unconnected: '未接入',
  ok: '正常',
};

/**
 * 「需要人看一眼」的状态集合。总览条上那个数字、点开后筛出的列表、卡片左侧的
 * 色条，三处都读这一个集合 —— 数字 3 就必须正好筛出 3 台，否则值班时不敢信它。
 * 离线与陈旧也算在内：停报两分钟的机器正是要动手的那一类。
 * 即将到期不算（总览条另有它自己的一格），未接入不算（机器本来就没装探针）。
 */
export const ATTENTION = ['alert', 'unreadable', 'quota', 'offline', 'stale'];

export function matchesFilter(node, filter, now = nowSec()) {
  if (!filter || filter === 'all') return true;
  const s = statusOf(node, now);
  if (filter === 'alert') return ATTENTION.includes(s);
  return s === filter;
}

/** 问题优先排序的权重：值班时先看到要动手的那几台。 */
export function problemRank(node, now = nowSec()) {
  switch (statusOf(node, now)) {
    case 'offline': return 0;
    case 'unreadable': return 1;
    case 'quota': return 2;
    case 'alert': return 3;
    case 'stale': return 4;
    case 'expiring': return 5;
    case 'unconnected': return 6;
    default: return 7;
  }
}

export const SORTS = {
  problem: { label: '问题优先', cmp: (a, b, now) => problemRank(a, now) - problemRank(b, now) || a.sort - b.sort },
  cpu: { label: 'CPU 占用', cmp: (a, b) => (b.metrics?.cpu ?? -1) - (a.metrics?.cpu ?? -1) },
  mem: { label: '内存占用', cmp: (a, b) => (pct(b.metrics?.mem_used, b.metrics?.mem_total) ?? -1) - (pct(a.metrics?.mem_used, a.metrics?.mem_total) ?? -1) },
  traffic: { label: '本月流量', cmp: (a, b) => monthUsage(b) - monthUsage(a) },
  expiry: { label: '到期时间', cmp: (a, b) => (expiringIn(a) ?? 9e9) - (expiringIn(b) ?? 9e9) },
};

export function sortNodes(nodes, key = 'problem', now = nowSec()) {
  const s = SORTS[key] || SORTS.problem;
  return [...nodes].sort((a, b) => s.cmp(a, b, now));
}

/** 总览条：一格回答一个值班时的问题。 */
export function summary(nodes, now = nowSec()) {
  const alerts = nodes.filter(n => ATTENTION.includes(statusOf(n, now)));
  let busiest = null, busiestCpu = -1;
  for (const n of nodes) {
    const c = n.metrics?.cpu;
    if (c != null && c > busiestCpu) { busiestCpu = c; busiest = n; }
  }
  return {
    total: nodes.length,
    alerts: alerts.length,
    offline: nodes.filter(n => statusOf(n, now) === 'offline').length,
    busiest,
    busiestCpu,
    monthBytes: nodes.reduce((s, n) => s + monthUsage(n), 0),
    expiringSoon: nodes.filter(n => { const d = expiringIn(n, now); return d != null && d <= EXPIRING_DAYS; }).length,
    countries: [...new Set(nodes.map(n => n.country).filter(Boolean))].sort(),
  };
}

export function formatBytes(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const sign = n < 0 ? '-' : '';
  return `${sign}${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

/** 卡片上用的紧凑写法：不带空格、不带 /s（标签已经写明是速率）。 */
export function formatBytesShort(n) {
  return formatBytes(n, 1).replace(' ', '');
}

export function formatSpeed(bytesPerSec) {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return '—';
  return `${formatBytes(bytesPerSec, 1)}/s`;
}

export function formatAge(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.max(0, Math.round(sec))} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.round(sec / 3600)} 小时`;
  return `${Math.round(sec / 86400)} 天`;
}

export function formatDays(d) {
  if (d == null) return '—';
  if (d < 0) return `已过期 ${Math.abs(d)} 天`;
  if (d === 0) return '今天到期';
  return `${d} 天`;
}

/** 卡片脚注里的状态行：正常时不给噪音，只在需要时说一句话。 */
export function statusNote(node, now = nowSec()) {
  const s = statusOf(node, now);
  switch (s) {
    case 'offline': {
      const gone = node.last_seen ? now - node.last_seen : null;
      return gone != null ? `离线 ${formatAge(gone)}` : '离线';
    }
    case 'unconnected': return '未接入探针';
    case 'stale': return `数据陈旧 ${formatAge(staleFor(node, now))}`;
    case 'unreadable': return '指标读不到';
    case 'quota': return '流量已超限';
    case 'alert': return '指标超阈';
    case 'expiring': return `还有 ${formatDays(expiringIn(node, now))} 到期`;
    default: return '';
  }
}