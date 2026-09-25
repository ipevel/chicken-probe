import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOf, staleFor, toneOf, deployed, unreadable, monthUsage, quotaOver, expiringIn,
  matchesFilter, problemRank, sortNodes, summary, formatBytes, formatSpeed, formatAge,
  formatDays, statusNote, pct, loadTone, nowSec, ATTENTION,
} from '../shared/derive.js';

const GB = 1024 ** 3;
const NOW = 1_800_000_000;   // 固定「现在」，否则用例会跟着真实时间漂

const node = (over = {}) => ({
  id: 1, name: '测试机', sort: 1, public: true, online: true, country: 'JP',
  last_seen: NOW, cpu_cores: 2, mem_total: 4 * GB,
  metrics: { cpu: 10, mem_used: 1 * GB, mem_total: 4 * GB, disk_used: 5 * GB, disk_total: 40 * GB, load: [0.5, 0.4, 0.3] },
  month_used: 0, traffic_limit: 100 * GB, traffic_mode: 'sum',
  expires_in: 90, expires_at: null, month_rx: 0, month_tx: 0,
  ...over,
});

test('未装探针 = 未接入，装了但没在线 = 离线', () => {
  assert.equal(deployed(node()), true);
  assert.equal(deployed(node({ cpu_cores: 0, mem_total: 0 })), false);
  assert.equal(statusOf(node({ cpu_cores: 0, mem_total: 0, online: false })), 'unconnected');
  assert.equal(statusOf(node({ online: false })), 'offline');
});

test('陈旧只在「在线但停报超过 120 秒」时成立，从没上报过不算', () => {
  assert.equal(staleFor(node({ last_seen: NOW - 100 }), NOW), null);
  assert.equal(staleFor(node({ last_seen: NOW - 121 }), NOW), 121);
  assert.equal(staleFor(node({ last_seen: 0 }), NOW), null, 'last_seen=0 是从没上报');
  assert.equal(statusOf(node({ last_seen: NOW - 300 }), NOW), 'stale');
});

test('状态优先级：离线 > 陈旧 > 读不到 > 超流量 > 超阈 > 即将到期 > 正常', () => {
  assert.equal(statusOf(node({ online: false, last_seen: NOW - 999 }), NOW), 'offline');
  assert.equal(statusOf(node({ last_seen: NOW - 999 }), NOW), 'stale');
  assert.equal(statusOf(node({ metrics: { cpu: null, mem_total: null, disk_total: null, load: null } }), NOW), 'unreadable');
  assert.equal(statusOf(node({ month_used: 200 * GB }), NOW), 'quota');
  assert.equal(statusOf(node({ metrics: { ...node().metrics, cpu: 95 } }), NOW), 'alert');
  assert.equal(statusOf(node({ metrics: { ...node().metrics, mem_used: 3.8 * GB } }), NOW), 'alert');
  assert.equal(statusOf(node({ expires_in: 3 }), NOW), 'expiring');
  assert.equal(statusOf(node(), NOW), 'ok');
});

test('未接入优先于离线：机器压根没装探针，不该按离线报', () => {
  assert.equal(statusOf(node({ cpu_cores: 0, mem_total: 0, online: false, last_seen: NOW - 9999 }), NOW), 'unconnected');
});

test('阈值：80 转琥珀、92 转红，79.9 不着色', () => {
  assert.equal(toneOf(79.9), 'ok');
  assert.equal(toneOf(80), 'warn');
  assert.equal(toneOf(91.9), 'warn');
  assert.equal(toneOf(92), 'danger');
  assert.equal(toneOf(null), 'ok');
  assert.equal(toneOf(undefined), 'ok');
});

test('负载要按核数读：load1 是核数的 2 倍才算告警', () => {
  assert.equal(loadTone(node({ cpu_cores: 4, metrics: { ...node().metrics, load: [3, 2, 1] } })), 'ok');
  assert.equal(loadTone(node({ cpu_cores: 4, metrics: { ...node().metrics, load: [5, 2, 1] } })), 'warn');
  assert.equal(loadTone(node({ cpu_cores: 4, metrics: { ...node().metrics, load: [9, 2, 1] } })), 'danger');
  assert.equal(loadTone(node({ cpu_cores: 0, metrics: { ...node().metrics, load: [9, 9, 9] } })), 'ok', '不知道核数就不下结论');
});

test('周期用量：优先用 hub 算好的 month_used，老 hub 才按模式自己加', () => {
  assert.equal(monthUsage(node({ month_used: 7 * GB, month_rx: 1 * GB, month_tx: 1 * GB })), 7 * GB);
  assert.equal(monthUsage(node({ month_used: null, month_rx: 3 * GB, month_tx: 2 * GB, traffic_mode: 'sum' })), 5 * GB);
  assert.equal(monthUsage(node({ month_used: null, month_rx: 3 * GB, month_tx: 2 * GB, traffic_mode: 'max' })), 3 * GB);
  assert.equal(monthUsage(node({ month_used: null, month_rx: 0, month_tx: 0 })), 0);
  assert.equal(quotaOver(node({ month_used: 200 * GB, traffic_limit: 100 * GB })), true);
  assert.equal(quotaOver(node({ month_used: 200 * GB, traffic_limit: 0 })), false, '无限套餐没有分母');
});

test('到期天数：expires_in 优先，退回 expires_at 按 UTC 日算', () => {
  assert.equal(expiringIn(node({ expires_in: 5 }), NOW), 5);
  // 用 UTC 零点当「现在」，否则 NOW 自带的时分会让 10 天后算成 9 天 —— 这正是
  // hub 要给 expires_in 的原因：日期各人按自己的钟读，天数会读岔
  const midnight = Math.floor(Date.UTC(2027, 0, 15) / 1000);
  const d = new Date((midnight + 10 * 86400) * 1000).toISOString().slice(0, 10);
  assert.equal(expiringIn(node({ expires_in: null, expires_at: d }), midnight), 10);
  assert.equal(expiringIn(node({ expires_in: null, expires_at: '不是日期' }), NOW), null);
  assert.equal(expiringIn(node({ expires_in: null, expires_at: null }), NOW), null);
});

test('「告警」筛选口要含数据不可读与超流量，不只阈值', () => {
  const unread = node({ metrics: { cpu: null, mem_total: null, disk_total: null, load: null } });
  const over = node({ month_used: 300 * GB });
  const ok = node();
  for (const n of [unread, over]) {
    assert.equal(matchesFilter(n, 'alert', NOW), true);
    assert.equal(problemRank(n, NOW) < problemRank(ok, NOW), true);
  }
  assert.equal(matchesFilter(ok, 'alert', NOW), false);
  assert.equal(matchesFilter(ok, 'all', NOW), true);
  assert.equal(matchesFilter(node({ online: false }), 'offline', NOW), true);
});

test('问题优先排序：离线在最前，健康沉底', () => {
  const list = [
    node({ id: 1, sort: 1 }),
    node({ id: 2, sort: 2, cpu_cores: 0, mem_total: 0, online: false }),
    node({ id: 3, sort: 3, online: false }),
    node({ id: 4, sort: 4, metrics: { cpu: null, mem_total: null, disk_total: null, load: null } }),
    node({ id: 5, sort: 5, expires_in: 2 }),
  ];
  const sorted = sortNodes(list, 'problem', NOW).map(n => n.id);
  assert.equal(sorted[0], 3, '离线排最前');
  assert.equal(sorted[1], 4, '其次是数据不可读');
  assert.ok(sorted.indexOf(5) > sorted.indexOf(3), '即将到期在离线之后');
  assert.equal(sorted[sorted.length - 1], 1, '健康垫底');
  // 未接入是「这台机器还没装探针」，不是故障，排在即将到期之后、健康之前
  assert.ok(sorted.indexOf(2) > sorted.indexOf(5) && sorted.indexOf(2) < sorted.indexOf(1), `实际顺序 ${sorted}`);
});

test('总览条的告警数必须正好等于筛出「告警」的台数', () => {
  const list = [
    node({ id: 1 }),
    node({ id: 2, online: false }),
    node({ id: 3, month_used: 500 * GB }),
    node({ id: 4, last_seen: NOW - 400 }),
    node({ id: 5, expires_in: 3 }),
    node({ id: 6, cpu_cores: 0, mem_total: 0, online: false }),
  ];
  const s = summary(list, NOW);
  const filtered = list.filter(n => matchesFilter(n, 'alert', NOW));
  assert.equal(s.alerts, filtered.length, '数字与列表同源，不能各算一套');
  assert.equal(s.alerts, 3, '离线 + 超流量 + 陈旧');
  assert.deepEqual(filtered.map(n => n.id), [2, 3, 4]);
  assert.equal(s.offline, 1);
  assert.equal(s.expiringSoon, 1, '即将到期单独一格，不混进告警');
  assert.deepEqual([...ATTENTION].sort(), ['alert', 'offline', 'quota', 'stale', 'unreadable']);
});

test('按 CPU 排序：读不出数的沉底而不是当成 0', () => {
  const list = [
    node({ id: 1, metrics: { ...node().metrics, cpu: null } }),
    node({ id: 2, metrics: { ...node().metrics, cpu: 5 } }),
    node({ id: 3, metrics: { ...node().metrics, cpu: 88 } }),
  ];
  assert.deepEqual(sortNodes(list, 'cpu', NOW).map(n => n.id), [3, 2, 1]);
});

test('总览条：告警数含离线，最忙取 CPU 最高，到期只数 7 天内', () => {
  const list = [
    node({ id: 1, metrics: { ...node().metrics, cpu: 42 } }),
    node({ id: 2, online: false }),
    node({ id: 3, month_used: 500 * GB }),
    node({ id: 4, expires_in: 3 }),
  ];
  const s = summary(list, NOW);
  assert.equal(s.total, 4);
  assert.equal(s.busiest.id, 1);
  assert.equal(s.busiestCpu, 42);
  assert.equal(s.monthBytes, 500 * GB);
  assert.deepEqual(s.countries, ['JP']);
});

test('百分比：任一侧缺失都返回 null，不做除零', () => {
  assert.equal(pct(1, 4), 25);
  assert.equal(pct(null, 4), null);
  assert.equal(pct(1, 0), null);
  assert.equal(unreadable(node({ metrics: { cpu: 1, mem_total: null, disk_total: null, load: null } })), false, '只缺一部分不算读不到');
});

test('格式化：字节、速率、时长、天数', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(20 * 1024 ** 4), '20.0 TB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatSpeed(1536), '1.5 KB/s');
  assert.equal(formatAge(45), '45 秒');
  assert.equal(formatAge(600), '10 分钟');
  assert.equal(formatAge(7200), '2 小时');
  assert.equal(formatAge(null), '—');
  assert.equal(formatDays(0), '今天到期');
  assert.equal(formatDays(-3), '已过期 3 天');
  assert.equal(formatDays(9), '9 天');
});

test('卡片状态行：正常时闭嘴，异常时一句话说清', () => {
  assert.equal(statusNote(node(), NOW), '');
  assert.equal(statusNote(node({ online: false, last_seen: NOW - 600 }), NOW), '离线 10 分钟');
  assert.equal(statusNote(node({ cpu_cores: 0, mem_total: 0, online: false }), NOW), '未接入探针');
  assert.equal(statusNote(node({ last_seen: NOW - 200 }), NOW), '数据陈旧 3 分钟');
  assert.equal(statusNote(node({ month_used: 900 * GB }), NOW), '流量已超限');
  assert.equal(statusNote(node({ expires_in: 2 }), NOW), '还有 2 天 到期');
});

test('nowSec 给的是秒而不是毫秒', () => {
  const t = nowSec();
  assert.ok(t > 1_700_000_000 && t < 2_000_000_000, `得到 ${t}`);
});