// 手写 SVG 折线图：网格 + 双轴刻度 + 多条曲线（空值断开）+ 悬停十字线与读数。
//
// 为什么不引图表库：这个主题要打进 8MiB 单文件上限的静态包里，而探针页只需要
// 「时间序列折线 + 悬停读数」这一类图；手写一层两百行的 SVG 比拉一个几百 KB 的
// 图表库更划算，也不会带来第二套主题变量。数学部分在 shared/chart.js（可单测）。

import { niceTicks, timeTicks, project, clockLabel } from '/shared/chart.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
};

const PAD = { l: 46, r: 10, t: 8, b: 20 };

/**
 * 画一张图。
 * @param {HTMLElement} host 容器（会整块替换内容）
 * @param {object} cfg
 *   rows    按时间升序的行数组
 *   series  [{ key, label, color, format }]（format: 值 → 显示文本）
 *   hours   时间跨度，决定横轴标签格式
 *   height  像素高
 *   yMax    可选，固定 Y 轴上限（百分比图传 100）
 *   marker  可选，{ index } 在最后一点画个点（表示"含实时值"）
 */
export function renderChart(host, cfg) {
  const { rows = [], series = [], hours = 6, height = 128, yMax = null, marker = null } = cfg;
  const width = Math.max(240, host.clientWidth || host.getBoundingClientRect().width || 320);
  host.replaceChildren();

  if (!rows.length) {
    host.append(el('div', { class: 'chart-empty' }));
    host.firstChild.textContent = '这个时间范围内没有历史数据';
    return;
  }

  const box = { x0: PAD.l, y0: PAD.t, x1: width - PAD.r, y1: height - PAD.b };
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

  // Y 轴：先按所有序列的范围算刻度（百分比图直接钉 0~100，避免"看起来一直很高"）
  let min = Infinity, max = -Infinity;
  for (const s of series) {
    for (const r of rows) {
      const v = r[s.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  const lo = yMax != null ? 0 : Math.min(min, 0);
  const hi = yMax != null ? yMax : (max === min ? max + 1 : max);
  const ticks = niceTicks(lo, hi, 4);
  const t0 = ticks[0], t1 = ticks[ticks.length - 1];
  const yOf = (v) => box.y1 - ((v - t0) / ((t1 - t0) || 1)) * (box.y1 - box.y0);

  for (const v of ticks) {
    const y = yOf(v);
    svg.append(el('line', { class: 'grid', x1: box.x0, x2: box.x1, y1: y, y2: y }));
    const label = el('text', { class: 'axis', x: box.x0 - 6, y: y + 3, 'text-anchor': 'end' });
    label.textContent = series[0]?.format ? series[0].format(v) : String(Math.round(v * 10) / 10);
    svg.append(label);
  }

  // X 轴时间刻度
  const firstTs = rows[0].ts, lastTs = rows[rows.length - 1].ts;
  for (const ts of timeTicks(firstTs, lastTs, 5)) {
    const i = rows.findIndex((r) => r.ts >= ts);
    if (i < 0) continue;
    const x = box.x0 + ((box.x1 - box.x0) * (ts - firstTs)) / ((lastTs - firstTs) || 1);
    const label = el('text', { class: 'axis', x, y: height - 6, 'text-anchor': 'middle' });
    label.textContent = clockLabel(ts, hours);
    svg.append(label);
  }

  // 曲线：空值处断开（分成多段），而不是跨过缺口拉一条直线
  for (const s of series) {
    const pts = project(rows, s.key, box, { min: t0, max: t1 });
    if (!pts.length) continue;
    let d = '';
    let prevIndex = -1;
    for (const p of pts) {
      const i = Math.round(((p.x - box.x0) / ((box.x1 - box.x0) || 1)) * (rows.length - 1));
      d += `${prevIndex >= 0 && i === prevIndex + 1 ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)} `;
      prevIndex = i;
    }
    const path = el('path', { class: 'line', d: d.trim(), stroke: s.color, fill: 'none' });
    svg.append(path);
  }

  if (marker && marker.index >= 0 && marker.index < rows.length) {
    const x = box.x0 + ((box.x1 - box.x0) * marker.index) / Math.max(1, rows.length - 1);
    const last = series[0];
    const v = rows[marker.index]?.[last?.key];
    if (typeof v === 'number') svg.append(el('circle', { class: 'live-dot', cx: x, cy: yOf(v), r: 2.6 }));
  }

  // 悬停：一根竖线 + 一个读数条（数值放在 SVG 外面，跟着鼠标走）
  const hoverLine = el('line', { class: 'hover', x1: 0, x2: 0, y1: box.y0, y2: box.y1, opacity: 0 });
  svg.append(hoverLine);
  const readout = document.createElement('div');
  readout.className = 'chart-readout hidden';
  host.append(svg, readout);

  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const k = Math.min(1, Math.max(0, (x - box.x0) / ((box.x1 - box.x0) || 1)));
    const i = Math.round(k * (rows.length - 1));
    const row = rows[i];
    if (!row) return;
    hoverLine.setAttribute('x1', String(box.x0 + k * (box.x1 - box.x0)));
    hoverLine.setAttribute('x2', String(box.x0 + k * (box.x1 - box.x0)));
    hoverLine.setAttribute('opacity', '1');
    readout.classList.remove('hidden');
    readout.replaceChildren();
    const head = document.createElement('div');
    head.className = 'ro-time';
    head.textContent = new Date(row.ts).toLocaleString('zh-CN', { hour12: false });
    readout.append(head);
    for (const s of series) {
      const v = row[s.key];
      const line = document.createElement('div');
      line.className = 'ro-line';
      const dot = document.createElement('i');
      dot.style.background = s.color;
      const name = document.createElement('span');
      name.textContent = s.label;
      const val = document.createElement('b');
      val.textContent = typeof v === 'number' ? (s.format ? s.format(v) : String(v)) : '—';
      line.append(dot, name, val);
      readout.append(line);
    }
    const left = Math.min(rect.width - 150, Math.max(0, (e.clientX - rect.left) + 12));
    readout.style.left = `${left}px`;
  };
  const onLeave = () => {
    hoverLine.setAttribute('opacity', '0');
    readout.classList.add('hidden');
  };
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerleave', onLeave);
}

/** 迷你曲线（卡片上用）：没有坐标轴，只表达趋势。 */
export function renderSpark(host, rows, key, color) {
  const width = Math.max(60, host.clientWidth || 120);
  const height = 26;
  host.replaceChildren();
  const svg = el('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
  const pts = project(rows, key, { x0: 1, y0: 3, x1: width - 1, y1: height - 3 });
  if (pts.length > 1) {
    svg.append(el('path', {
      class: 'line',
      d: pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      stroke: color,
      fill: 'none',
    }));
  } else {
    svg.append(el('line', { class: 'grid', x1: 1, x2: width - 1, y1: height / 2, y2: height / 2 }));
  }
  host.append(svg);
}