// 本地开发用的假探针数据。只在 dev 服务器里跑，不进主题包 ——
// 形状严格照 hub 的公开 payload 抄（/api/nodes、/api/ws 的帧都是 {nodes:[...]}），
// 这样本地浏览器里验的就是线上那条代码路径。
//
// 故意造全了边界态：离线 / 未接入 / 读数陈旧 / 指标读不到 / CPU 告警 / 内存偏高 /
// 流量超限 / 即将到期 —— 面板和鸡场的每个状态都得有真实数据可验，不能靠"大概会发生"。

const SEED = 20260924;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const GB = 1024 ** 3;
const TB = 1024 ** 4;

// 每台机器的静态事实 + 出厂状态。name 是公开字段，探针鸡的名字就取这个。
const SEEDS = [
  { name: '东京 · Oracle', country: 'JP', cores: 4, mem: 24 * GB, disk: 200 * GB, price: 0, currency: 'CNY', cycle: '年付', os: 'Debian 12', kernel: '6.1.0-13-cloud-amd64', arch: 'x86_64', virt: 'KVM', cpu: 'AMD EPYC 7551P 32-Core', agent: '1.4.2', limit: 3 * TB, mode: 'sum', reset: 1, expires: 120, preset: 'healthy' },
  { name: '香港 · CN2 GIA', country: 'HK', cores: 2, mem: 4 * GB, disk: 60 * GB, price: 39.9, currency: 'CNY', cycle: '季付', os: 'Ubuntu 22.04', kernel: '5.15.0-91-generic', arch: 'x86_64', virt: 'KVM', cpu: 'Intel Xeon Gold 6133', agent: '1.4.2', limit: 500 * GB, mode: 'max', reset: 5, expires: 41, preset: 'cpu_alert' },
  { name: '洛杉矶 · 建站机', country: 'US', cores: 2, mem: 2 * GB, disk: 40 * GB, price: 4.5, currency: 'USD', cycle: '月付', os: 'AlmaLinux 9', kernel: '5.14.0-362.el9', arch: 'x86_64', virt: 'KVM', cpu: 'Intel Xeon E5-2697 v2', agent: '1.4.1', limit: 200 * GB, mode: 'sum', reset: 15, expires: 9, preset: 'mem_warn' },
  { name: '法兰克福 · Hetzner', country: 'DE', cores: 8, mem: 16 * GB, disk: 160 * GB, price: 4.51, currency: 'EUR', cycle: '月付', os: 'Debian 11', kernel: '5.10.0-27-amd64', arch: 'x86_64', virt: 'KVM', cpu: 'AMD Ryzen 5 3600 6-Core', agent: '1.4.2', limit: 20 * TB, mode: 'sum', reset: 1, expires: 67, preset: 'healthy' },
  { name: '新加坡 · 落地', country: 'SG', cores: 1, mem: 1 * GB, disk: 20 * GB, price: 19.9, currency: 'CNY', cycle: '年付', os: 'Debian 12', kernel: '6.1.0-18-cloud-amd64', arch: 'x86_64', virt: 'LXC', cpu: 'Intel Xeon Platinum 8163', agent: '1.4.0', limit: 500 * GB, mode: 'max', reset: 1, expires: 3, preset: 'stale' },
  { name: '首尔 · 中转', country: 'KR', cores: 2, mem: 2 * GB, disk: 40 * GB, price: 12, currency: 'CNY', cycle: '月付', os: 'Ubuntu 20.04', kernel: '5.4.0-169-generic', arch: 'x86_64', virt: 'KVM', cpu: 'Intel Xeon E5-2660 v4', agent: '1.4.2', limit: 1 * TB, mode: 'sum', reset: 10, expires: 22, preset: 'offline' },
  { name: '伦敦 · 备用', country: 'GB', cores: 2, mem: 4 * GB, disk: 80 * GB, price: 3.2, currency: 'GBP', cycle: '月付', os: 'Debian 12', kernel: '6.1.0-13-cloud-amd64', arch: 'x86_64', virt: 'KVM', cpu: 'AMD EPYC 7282 16-Core', agent: '1.4.2', limit: 2 * TB, mode: 'sum', reset: 1, expires: 88, preset: 'quota_over' },
  { name: '东京 · 备用机', country: 'JP', cores: 2, mem: 2 * GB, disk: 40 * GB, price: 0, currency: 'CNY', cycle: '年付', os: 'Alpine 3.19', kernel: '6.6.7-0-lts', arch: 'x86_64', virt: 'LXC', cpu: 'Intel Xeon E5-2680 v4', agent: '1.3.9', limit: 0, mode: 'sum', reset: 1, expires: 210, preset: 'metrics_garbled' },
  { name: '圣何塞 · 备份', country: 'US', cores: 0, mem: 0, disk: 0, price: 0, currency: 'CNY', cycle: '月付', os: '', kernel: '', arch: '', virt: '', cpu: '', agent: '', limit: 0, mode: 'sum', reset: 1, expires: -1, preset: 'unconnected' },
  { name: '孟买 · 探针', country: 'IN', cores: 1, mem: 1 * GB, disk: 25 * GB, price: 5.5, currency: 'USD', cycle: '月付', os: 'Ubuntu 24.04', kernel: '6.8.0-41-generic', arch: 'x86_64', virt: 'KVM', cpu: 'Intel Xeon Platinum 8259CL', agent: '1.4.2', limit: 1 * TB, mode: 'max', reset: 20, expires: 35, preset: 'healthy' },
  { name: '悉尼 · 观测点', country: 'AU', cores: 1, mem: 2 * GB, disk: 50 * GB, price: 7.9, currency: 'AUD', cycle: '月付', os: 'Debian 12', kernel: '6.1.0-21-cloud-amd64', arch: 'aarch64', virt: 'KVM', cpu: 'Ampere Altra Q80-30', agent: '1.4.2', limit: 2 * TB, mode: 'sum', reset: 12, expires: 54, preset: 'healthy' },
  { name: '多伦多 · 冷备', country: 'CA', cores: 2, mem: 4 * GB, disk: 80 * GB, price: 0, currency: 'CNY', cycle: '年付', os: 'Rocky 9', kernel: '5.14.0-362.el9', arch: 'x86_64', virt: 'KVM', cpu: 'AMD EPYC 7302P 16-Core', agent: '0.9.8', limit: 0, mode: 'sum', reset: 1, expires: 6, preset: 'expiring_agent_old' },
  // 会自己掉线又回来的机器：鸡场里能看到一只鸡倒下、过几分钟又站起来
  { name: '大阪 · 抖动测试', country: 'JP', cores: 2, mem: 2 * GB, disk: 40 * GB, price: 6.8, currency: 'USD', cycle: '月付', os: 'Debian 12', kernel: '6.1.0-26-cloud-amd64', arch: 'x86_64', virt: 'KVM', cpu: 'AMD EPYC 7542 32-Core', agent: '1.4.2', limit: 1 * TB, mode: 'sum', reset: 8, expires: 73, preset: 'flapping' },
];

function isoDate(daysFromNow) {
  const d = new Date(Date.now() + daysFromNow * 86400_000);
  return d.toISOString().slice(0, 10);
}

// 各状态的读数基准。历史曲线也从这里取基准 —— 面板上的当前值和 24 小时曲线
// 必须落在同一个量级，否则一眼就看得出「历史是另一台机器」
const CPU_BASE = { healthy: 12, cpu_alert: 96.5, mem_warn: 22, stale: 30, quota_over: 18, expiring_agent_old: 8, metrics_garbled: 15, unconnected: 0, offline: 0 };
const MEM_PCT = { mem_warn: 88.5, quota_over: 55, healthy: 45, cpu_alert: 60, stale: 52, expiring_agent_old: 20, metrics_garbled: 40, unconnected: 0, offline: 0 };
const DISK_PCT = { quota_over: 71, healthy: 38, metrics_garbled: 44, unconnected: 0, offline: 0 };

function metricsFor(s, rnd, phase) {
  // 用正弦 + 噪声制造「像真的」的波动：纯随机会让 CPU 一秒一个样，反而假
  const wob = (base, amp, speed) => Math.max(0, base + amp * Math.sin(phase * speed + s.cores) + (rnd() - 0.5) * amp * 0.4);
  const cpuBase = CPU_BASE[s.preset] ?? 15;
  const cpu = Math.min(100, wob(cpuBase, cpuBase > 60 ? 3 : 8, 0.07));
  const memPct = MEM_PCT[s.preset] ?? 40;
  const mem_used = s.mem * (memPct / 100 + (rnd() - 0.5) * 0.02);
  const diskPct = DISK_PCT[s.preset] ?? 46;
  return {
    uptime: Math.floor(86400 * 30 + phase * 8),
    cpu: Number(cpu.toFixed(1)),
    load: [Number((cpu / 25).toFixed(2)), Number((cpu / 30).toFixed(2)), Number((cpu / 38).toFixed(2))],
    mem_total: s.mem || null,
    mem_used: s.mem ? Math.round(mem_used) : null,
    swap_total: s.mem ? 2 * GB : null,
    swap_used: s.mem ? Math.round(2 * GB * (s.preset === 'mem_warn' ? 0.42 : 0.03)) : null,
    disk_total: s.disk || null,
    disk_used: s.disk ? Math.round(s.disk * (diskPct / 100)) : null,
    net_rx: Math.round(wob(s.preset === 'quota_over' ? 6e6 : 4e5, 3e5, 0.31)),
    net_tx: Math.round(wob(s.preset === 'quota_over' ? 2e6 : 9e4, 8e4, 0.37)),
    total_rx: Math.round(120 * TB * rnd() + 30 * TB),
    total_tx: Math.round(40 * TB * rnd() + 8 * TB),
    month_rx: 0, month_tx: 0,
    tcp: 40 + Math.floor(rnd() * 60),
    udp: 5 + Math.floor(rnd() * 20),
    procs: 90 + Math.floor(rnd() * 60),
  };
}

// ---------------- 历史指标 ----------------
// 面板的历史曲线来自真 hub 的 GET /api/nodes/{id}/metrics。本地这份假历史有两个硬约束：
//
//  1. 客户端会按不同的 hours/points 反复拉同一段时间。同一个时间点必须永远给出同一个值 ——
//     若值是「窗口内第几个点」的函数，now 往前挪一格整条曲线就换一套值，用户每次刷新
//     都会看到曲线整体跳变。所以历史只能是 (机器, 格号) 的纯函数，这里再按格缓存一份。
//  2. 13 台 × 7 天 × 5 分钟 = 2.6 万个点。每点一个 {ts,cpu,...} 对象，光属性槽就几百 KB，
//     而且每 5 分钟再产生一批垃圾；按字段分列存 Float32Array（一台 5 列 × 2016 × 4B ≈ 40KB），
//     写入零分配，长时间开着的 dev 服务器不会被历史数据的 GC 拖慢。
//
// Float32 的尾数只有 24 位，几十 GB 的字节数会有千分之一的误差 —— 画在曲线上看不见，
// 换来的内存与分配开销的下降是数量级的。
const HIST_STEP = 300_000;                 // 5 分钟一格，与真 hub 的历史粒度一致
const HIST_PER_DAY = 288;                  // 一天 288 格
const HIST_CAP = 7 * HIST_PER_DAY;         // 2016 格 = 7 天（环形缓冲的容量）
const HIST_MAX_HOURS = 24;                 // 匿名访客能看到的窗口上限（主控 public 配置）
const HIST_MAX_POINTS = 1500;              // 请求点数的防呆上限：别让一个访客一次拉十万个点

// 三条探测线落在三个量级：客户端把多条线拼成一张表时，一眼能看出「哪条线慢」
const PING_LINES = [
  { name: '华东电信', base: 30 },
  { name: '香港 CN2', base: 60 },
  { name: '洛杉矶 BGP', base: 180 },
];

// 32 位整数哈希：同一 (机器, 用途, 格号) 永远得到同一个 [0,1)。
// 整段历史的所有随机都从这一句来 —— 可复现的前提
function histNoise(id, salt, g) {
  let h = Math.imul(g, 0x27d4eb2d) ^ Math.imul(id, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

// 一天一个正弦：先有「白天忙、夜里闲」的底子再叠噪声，曲线才不像心电图。
// g % 一天 保证进位不跳变（288 整除），挪格时曲线是连续的
const dayWave = (g, off) => Math.sin(2 * Math.PI * ((g % HIST_PER_DAY) / HIST_PER_DAY) + off);

// 历史是「格号」的纯函数，所以它不跟着 tick() 里的实时抖动走（抖动节点掉线的瞬间，
// 它的历史仍然连续）。这是刻意的：宁愿少一点戏剧性，也不要客户端每次刷新都看到曲线跳
/** 第 g 格的指标读数。null = 这一格整段没有数据（不是「值为 0」，曲线该断在这里） */
function histSample(s, id, g, goneGrid) {
  if (s.preset === 'unconnected') return null;               // 从没上报过 → 整段空白
  if (s.preset === 'offline' && g > goneGrid) return null;   // 失联那一刻之后 → 空白
  // 离线机器消失之前是活的，历史得按「健康」的用量给 —— 直接沿用当前指标表的 0
  // 会让它在曲线上变成一台内存占用为 0 的机器
  const gone = s.preset === 'offline';
  const ph = histNoise(id, 3, 0) * 6.283;
  const cpuBase = gone ? 14 : CPU_BASE[s.preset] ?? 15;
  const amp = cpuBase > 60 ? 3 : 8;   // 高负载机的波动幅度取小：96% 的机器不该有一半时间躺在低谷
  const cpu = Math.max(0, Math.min(100, cpuBase + amp * dayWave(g, ph) + (histNoise(id, 11, g) - 0.5) * amp * 0.4));
  const memPct = (gone ? 45 : MEM_PCT[s.preset] ?? 40) + 3 * dayWave(g, ph + 1.7) + (histNoise(id, 13, g) - 0.5) * 2;
  const diskPct = (gone ? 38 : DISK_PCT[s.preset] ?? 46) + 1.5 * dayWave(g, ph + 3.1) + (histNoise(id, 17, g) - 0.5) * 0.6;
  // 偶尔连着几格跑满带宽：历史曲线上得有毛刺，全是平滑正弦就验不出客户端的缩放
  const burst = histNoise(id, 19, Math.floor(g / 3)) > 0.93 ? 6 : 1;
  const flow = (base, salt, spread) => base * burst * (1 + spread * dayWave(g, ph + 0.9) + (histNoise(id, salt, g) - 0.5) * 0.3);
  const garbled = s.preset === 'metrics_garbled';
  return {
    // 「指标读不到」那台：hub 有记录但核心字段一个也读不出来。ts 必须留着 ——
    // 客户端靠它区分「采到了但读不出」和「这段机器根本不在」
    cpu: garbled ? null : cpu,
    mem_used: garbled || !s.mem ? null : (s.mem * memPct) / 100,
    disk_used: garbled || !s.disk ? null : (s.disk * diskPct) / 100,
    net_rx: flow(s.preset === 'quota_over' ? 6e6 : 4e5, 23, 0.25),
    net_tx: flow(s.preset === 'quota_over' ? 2e6 : 9e4, 29, 0.3),
  };
}

/** 第 g 格、第 line 条探测线的读数。latency 为 null 表示这一格探不通 */
function histPing(s, id, line, g, goneGrid) {
  if (s.preset === 'offline' && g > goneGrid) return { latency: null, loss: 1 };
  if (histNoise(id, 31 + line, g) > 0.98) return { latency: null, loss: 1 };   // 2% 丢包
  // 每条线的基础延迟按机器种子上下浮动，不同机器的同名线不该是同一个数
  const base = PING_LINES[line].base * (0.8 + 0.4 * histNoise(id, 41 + line, 0));
  const spike = histNoise(id, 53 + line, g) > 0.99 ? 3 : 1;   // 偶发绕路
  const v = base * spike * (1 + 0.18 * dayWave(g, histNoise(id, 61 + line, 0) * 6.283) + 0.25 * (histNoise(id, 71 + line, g) - 0.5));
  return { latency: Math.max(3, v), loss: 0 };
}

// 环形缓冲的列。默认 0 会冒充读数，必须显式填 NaN 表示「这一格没有数据」
const histCol = () => new Float32Array(HIST_CAP).fill(NaN);

function createHist(id, spec, goneAt) {
  return {
    id,
    spec,
    // 失联的那一格之后不再有读数。用格号而不是毫秒比较，边界才对得齐 5 分钟网格
    goneGrid: goneAt == null ? Infinity : Math.floor((goneAt * 1000) / HIST_STEP),
    grid: -1,                                  // 已写入的最新格号，-1 = 还没写过
    cpu: histCol(), mem: histCol(), disk: histCol(), rx: histCol(), tx: histCol(),
  };
}

function histWrite(h, g) {
  const i = ((g % HIST_CAP) + HIST_CAP) % HIST_CAP;   // 格号一直长，下标绕回来
  const v = histSample(h.spec, h.id, g, h.goneGrid);
  h.cpu[i] = v && Number.isFinite(v.cpu) ? v.cpu : NaN;
  h.mem[i] = v && Number.isFinite(v.mem_used) ? v.mem_used : NaN;
  h.disk[i] = v && Number.isFinite(v.disk_used) ? v.disk_used : NaN;
  h.rx[i] = v ? v.net_rx : NaN;
  h.tx[i] = v ? v.net_tx : NaN;
}

function histEnsure(h, endGrid) {
  if (endGrid <= h.grid) return;
  // 进程被挂起超过 7 天时，窗口外的格补了也没人看，直接从窗口下沿开始，省掉几万次生成
  for (let g = Math.max(h.grid + 1, endGrid - HIST_CAP + 1); g <= endGrid; g++) histWrite(h, g);
  h.grid = endGrid;
}

const num = (v, digits = 0) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
const mean = (col, i0, i1) => {
  let sum = 0, n = 0;
  for (let i = i0; i < i1; i++) if (Number.isFinite(col[i])) { sum += col[i]; n++; }
  return n ? sum / n : NaN;   // 断点（null）不进均值，否则窗口里一次丢包会把整段拉平
};
const peak = (col, i0, i1) => {
  let m = NaN;
  for (let i = i0; i < i1; i++) if (Number.isFinite(col[i]) && !(col[i] <= m)) m = col[i];
  return m;
};

/**
 * 把 m 个格等距分成 ≤points 个桶。points ≥ m 时一格一桶 ——
 * 不补点：真 hub 不会凭空造历史，短窗口（1 小时只有 12 格）也给不出三百个点。
 */
function bucketRanges(m, points) {
  const ranges = [];
  if (!m) return ranges;
  if (points >= m) {
    for (let i = 0; i < m; i++) ranges.push([i, i + 1]);
    return ranges;
  }
  for (let b = 0; b < points; b++) {
    const i0 = Math.floor((b * m) / points);
    ranges.push([i0, Math.max(Math.floor(((b + 1) * m) / points), i0 + 1)]);
  }
  return ranges;
}

function metricSeries(node, startGrid, endGrid, points) {
  const h = node.hist;
  const ts = [], cpu = [], mem = [], disk = [], rx = [], tx = [];
  for (let g = startGrid; g <= endGrid; g++) {
    const i = ((g % HIST_CAP) + HIST_CAP) % HIST_CAP;
    const c = h.cpu[i], m = h.mem[i], d = h.disk[i], r = h.rx[i], x = h.tx[i];
    // 整格都没有读数（未接入 / 失联之后）就整条不输出：曲线断在这里，而不是掉到 0
    if (!Number.isFinite(c) && !Number.isFinite(m) && !Number.isFinite(d) && !Number.isFinite(r) && !Number.isFinite(x)) continue;
    ts.push(g * HIST_STEP); cpu.push(c); mem.push(m); disk.push(d); rx.push(r); tx.push(x);
  }
  return bucketRanges(ts.length, points).map(([i0, i1]) => ({
    ts: ts[i0 + ((i1 - i0 - 1) >> 1)],   // 取桶中点的时间戳：降采样后曲线不会被整体左移
    // cpu 取峰值而不是均值：24 小时视图下一个桶就是 12 分钟，均值会把一次 100% 的尖峰
    // 抹成「一直 40%」—— 正好抹掉最该看的那个点
    cpu: num(peak(cpu, i0, i1), 1),
    mem_used: num(mean(mem, i0, i1)),
    disk_used: num(mean(disk, i0, i1)),
    net_rx: num(mean(rx, i0, i1)),
    net_tx: num(mean(tx, i0, i1)),
  }));
}

function pingSeries(node, startGrid, endGrid, points) {
  const h = node.hist;
  const lines = node.seed.preset === 'unconnected' ? [] : PING_LINES;
  const probes = {}, loss = {}, ts = [], lat = [], los = [];
  if (!lines.length) return { rows: [], probes, loss };
  lines.forEach((l, li) => {
    probes[node.id * 10 + li + 1] = l.name;   // task_id 取「机器号 ×10 + 线序」：跨机器唯一且稳定
    lat.push([]); los.push([]);
  });

  // 逐格生成：同一个 ts 上三条线都在，客户端才能按 ts 拼成一张表
  for (let g = startGrid; g <= endGrid; g++) {
    ts.push(g * HIST_STEP);
    lines.forEach((_, li) => {
      const p = histPing(node.seed, node.id, li, g, h.goneGrid);
      lat[li].push(p.latency == null ? NaN : p.latency);
      los[li].push(p.loss);
    });
  }

  const rows = [];
  for (const [i0, i1] of bucketRanges(ts.length, points)) {
    const t = ts[i0 + ((i1 - i0 - 1) >> 1)];
    // 包络是「这一组线」的量，不属于任何一条线：每个 ts 先跨线算一次
    let lo = Infinity, hi = -Infinity;
    for (const col of lat) {
      const v = mean(col, i0, i1);
      if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    lines.forEach((_, li) => {
      const row = {
        task_id: node.id * 10 + li + 1,
        ts: t,
        latency: num(mean(lat[li], i0, i1), 1),
        loss: num(mean(los[li], i0, i1), 2),
      };
      // band 只挂在第一条线上：真 hub 的 band 是多线包络，若三条线各塞一份同一个包络，
      // 客户端很容易把它当成「这条线自己的波动区间」画出三条重叠的带子
      if (li === 0 && Number.isFinite(lo)) row.band = [num(lo, 1), num(hi, 1)];
      rows.push(row);
    });
  }

  lines.forEach((_, li) => { loss[node.id * 10 + li + 1] = num(mean(los[li], 0, los[li].length), 3); });
  return { rows, probes, loss };
}

export function createFleet() {
  const rnd = mulberry32(SEED);
  const phase = { t: rnd() * 100 };

  const fleet = SEEDS.map((s, i) => {
    const unconnected = s.preset === 'unconnected';
    const offline = s.preset === 'offline';
    const stale = s.preset === 'stale';
    const garbled = s.preset === 'metrics_garbled';
    const now = Math.floor(Date.now() / 1000);

    const m = unconnected || offline ? null : metricsFor(s, rnd, phase.t);
    if (m && garbled) {
      // 「指标读不到」：hub 送了 metrics，但核心字段一个都读不出来
      m.cpu = null; m.mem_total = null; m.mem_used = null; m.disk_total = null; m.disk_used = null; m.load = null;
    }
    const monthUsed = s.preset === 'quota_over' ? s.limit * 1.18 : s.limit ? s.limit * (0.15 + rnd() * 0.5) : 0;
    // 离线节点：goneAt 是它消失的那一刻。用 60 秒前而不是更久，
    // 否则「已离线 340 秒 > 240 秒复活阈值」会让它在第一帧就自己活过来
    const goneAt = offline ? now - 60 : null;

    return {
      seed: s,
      id: i + 1,
      sort: i + 1,
      online: !unconnected && !offline,
      // 陈旧：agent 停报，但 hub 还认为它在线
      last_seen: unconnected ? 0 : offline ? now - 340 : stale ? now - 186 : now,
      metrics: m,
      hist: createHist(i + 1, s, goneAt),
      month_used: Math.round(monthUsed),
      day_rx: Math.round(monthUsed / 30),
      day_tx: Math.round(monthUsed / 90),
      phase: phase.t + i * 3,
      goneAt,
      upSince: now,
    };
  });

  return {
    fleet,
    rnd,
    tick() {
      phase.t += 0.5;
      const now = Math.floor(Date.now() / 1000);
      for (const n of fleet) {
        const s = n.seed;

        // 抖动节点：在线撑 150 秒后掉线，离线 240 秒后回来。
        // 离线节点（首尔）不复活 —— 假世界里必须一直有一台真下线的机器可看
        if (s.preset === 'flapping') {
          if (n.online && now - n.upSince > 150) {
            n.online = false; n.goneAt = now; n.metrics = null;
          } else if (!n.online && now - n.goneAt > 240) {
            n.online = true; n.upSince = now;
            n.metrics = metricsFor(s, rnd, n.phase);
          }
        }

        if (!n.online) {
          // 离线时 last_seen 是它消失的那一刻，年龄会自己长大；
          // 未接入则是从没上报过（0），两者在面板上是两句不同的话
          n.last_seen = s.preset === 'unconnected' ? 0 : (n.goneAt ?? now);
          continue;
        }
        if (s.preset !== 'stale') n.last_seen = now;
        n.phase += 0.5;
        if (n.metrics) {
          const fresh = metricsFor(s, rnd, n.phase);
          if (s.preset === 'metrics_garbled') {
            fresh.cpu = null; fresh.mem_total = null; fresh.mem_used = null;
            fresh.disk_total = null; fresh.disk_used = null; fresh.load = null;
          }
          n.metrics = fresh;
        }
        if (n.month_used) n.month_used = Math.round(n.month_used * 1.0004);
      }
    },
    /**
     * 节点历史，形状照 GET /api/nodes/{id}/metrics 抄。id 不存在返回 null。
     *
     * hours 一律夹到 ≤24：真 hub 对匿名访客就是把历史窗口夹到主控 public 配置的上限，
     * 客户端拿到的可能比它请求的短，所以响应里必须回一个「实际用的小时数」。
     * points 只用于降采样，格数不够时不会补点 —— 返回值可能比请求的点数少。
     */
    history(nodeId, hours, points, series = 'metrics') {
      const node = Number.isInteger(nodeId) ? fleet[nodeId - 1] : null;
      if (!node || node.id !== nodeId) return null;
      const h = Math.max(1, Math.min(HIST_MAX_HOURS, Math.round(hours) || HIST_MAX_HOURS));
      const pt = Math.max(1, Math.min(HIST_MAX_POINTS, Math.round(points) || 300));
      const endGrid = Math.floor(Date.now() / HIST_STEP);   // 最后一个点对齐 5 分钟网格
      const startGrid = endGrid - h * (HIST_PER_DAY / 24) + 1;
      histEnsure(node.hist, endGrid);
      if (series === 'ping') {
        const { rows, probes, loss } = pingSeries(node, startGrid, endGrid, pt);
        return { hours: h, ping: rows, probes, loss };
      }
      return { hours: h, metrics: metricSeries(node, startGrid, endGrid, pt) };
    },
    /** 公开视图：字段与 hub 匿名 payload 一一对应，不含 ip/hostname/remark/token */
    views() {
      return fleet.map(n => {
        const s = n.seed;
        const expires_in = s.expires < 0 ? null : s.expires;
        const m = n.metrics && {
          ...n.metrics,
          // 周期用量两个方向也一起给，别让读 metrics.month_* 的代码拿到 0
          month_rx: Math.round(n.month_used / 2), month_tx: Math.round(n.month_used / 2),
        };
        return {
          id: n.id,
          name: s.name,
          sort: n.sort,
          public: true,
          online: n.online,
          country: s.country,
          last_seen: n.last_seen,
          metrics: m,
          os: s.os, kernel: s.kernel, arch: s.arch, virt: s.virt,
          cpu_name: s.cpu, cpu_cores: s.cores,
          mem_total: s.mem, swap_total: s.mem ? 2 * GB : 0, disk_total: s.disk,
          agent_version: s.agent,
          price: s.price, currency: s.currency, billing_cycle: s.cycle,
          expires_at: expires_in == null ? null : isoDate(expires_in),
          expires_in,
          month_start: isoDate(-new Date().getDate() + 1),
          day_rx: n.day_rx, day_tx: n.day_tx,
          traffic_limit: s.limit, traffic_mode: s.mode, traffic_reset_day: s.reset,
          total_rx: n.metrics?.total_rx ?? 0, total_tx: n.metrics?.total_tx ?? 0,
          month_rx: Math.round(n.month_used / 2), month_tx: Math.round(n.month_used / 2),
          month_used: n.month_used,
        };
      });
    },
  };
}