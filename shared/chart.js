// 图表的纯计算：刻度、投影、降采样、统计、多探测线按时间对齐。
//
// 与 DOM 无关，所以能单测 —— 一张图"看着不对"时，问题要么在这里（算错），
// 要么在渲染层（画错），分开才能查。

/** 取「好看」的刻度：1/2/5×10^n 步长，覆盖 [min,max]。 */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min];                       // 全平的数据：只画一条基准线
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // 取 1/2/5 里「不小于 raw」的那一档（d3 的口径）：raw=25 时选 2→步长 20，
  // 而不是选 5→步长 50（那样 0~100 只剩三条线，太粗）
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out = [];
  // 用乘法而不是反复相加：浮点累加会让 0.30000000000000004 这种刻度冒出来
  for (let i = 0; start + i * step <= end + step * 1e-9; i++) out.push(start + i * step);
  return out;
}

/** 时间轴刻度：等分 [from,to]，返回毫秒时间戳。 */
export function timeTicks(from, to, count = 5) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const n = Math.max(2, count);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(from + ((to - from) * i) / (n - 1)));
  return out;
}

/**
 * 把一行数据投影到画布坐标。
 * @param {Array<object>} rows 按时间升序
 * @param {string} key 取值字段
 * @param {{x0:number,y0:number,x1:number,y1:number}} box
 * @param {{min:number,max:number}} [yRange] 不给就按数据自适应
 * @returns {Array<{x:number,y:number,v:number}>} 值为 null 的点会被跳过（曲线断开）
 */
export function project(rows, key, box, yRange) {
  const n = rows.length;
  if (!n) return [];
  let min = yRange?.min, max = yRange?.max;
  if (min == null || max == null) {
    min = Infinity; max = -Infinity;
    for (const r of rows) {
      const v = r[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) return [];              // 整列都是空：没什么可画
    if (min === max) { min -= 1; max += 1; }
  }
  const sx = n === 1 ? 0 : (box.x1 - box.x0) / (n - 1);
  const sy = (box.y1 - box.y0) / (max - min || 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = rows[i][key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out.push({
      x: box.x0 + i * sx,
      y: box.y1 - (v - min) * sy,
      v,
    });
  }
  return out;
}

/** 一列值的统计（跳过 null）。用于「当前 / 均值 / 峰值」那行。 */
export function stats(values) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0, last = null;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
    last = v;
  }
  if (!n) return { min: null, max: null, avg: null, last: null, count: 0 };
  return { min, max, avg: sum / n, last, count: n };
}

/**
 * 多探测线按时间对齐成一张表：同一 ts 的多条线合成一行。
 * 图要按 x 轴画多条线，就必须共用一套 x —— 各探测线的采样点数量/时刻可能不同，
 * 所以按 ts 归并，缺的留 null（曲线在该处断开，而不是被拉直）。
 */
export function alignByTs(points, probeIds, key = 'latency') {
  const byTs = new Map();
  for (const p of points) {
    if (!probeIds.includes(p.task_id)) continue;
    const ts = p.ts;
    let row = byTs.get(ts);
    if (!row) { row = { ts }; byTs.set(ts, row); }
    row[`p${p.task_id}`] = typeof p[key] === 'number' ? p[key] : null;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 等距降采样：每桶取均值，同时保留该桶的极值。
 * 纯丢点会把 24 小时图里的尖峰抹掉 —— 告警恰恰都是尖峰，所以极值必须留。
 */
export function downsample(values, target) {
  if (target >= values.length) return values.map((v) => ({ avg: v, min: v, max: v }));
  const bucket = values.length / target;
  const out = [];
  for (let i = 0; i < target; i++) {
    const from = Math.floor(i * bucket);
    const to = Math.max(from + 1, Math.floor((i + 1) * bucket));
    let sum = 0, n = 0, min = Infinity, max = -Infinity;
    for (let j = from; j < to && j < values.length; j++) {
      const v = values[j];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      sum += v; n++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out.push(n ? { avg: sum / n, min, max } : { avg: null, min: null, max: null });
  }
  return out;
}

/** 时间戳 → 轴标签。跨度决定精度：24 小时内给时:分，超过给月-日。 */
export function clockLabel(ts, hours) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  if (hours > 48) return `${d.getMonth() + 1}-${p(d.getDate())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}