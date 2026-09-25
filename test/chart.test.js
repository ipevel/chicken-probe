import test from 'node:test';
import assert from 'node:assert/strict';
import {
  niceTicks, timeTicks, project, stats, alignByTs, downsample, clockLabel,
} from '../shared/chart.js';

test('刻度落在 1/2/5 的倍数上，且覆盖数据范围', () => {
  const t = niceTicks(0, 97, 4);
  assert.ok(t[0] <= 0 && t[t.length - 1] >= 97, `覆盖范围：${t[0]}~${t[t.length - 1]}`);
  for (const v of t) assert.equal(Number(v.toFixed(6)), v, `不该出现浮点毛刺：${v}`);
  assert.deepEqual(niceTicks(0, 100, 4), [0, 20, 40, 60, 80, 100], 'raw=25 应取步长 20 而不是 50');
  assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
});

test('全平的数据只给一条基准线，不给 NaN', () => {
  assert.deepEqual(niceTicks(5, 5, 4), [5]);
  assert.deepEqual(niceTicks(NaN, 3, 4), [0, 1]);
});

test('时间轴刻度等分且端点对齐', () => {
  const t = timeTicks(0, 1000, 5);
  assert.deepEqual(t, [0, 250, 500, 750, 1000]);
  assert.deepEqual(timeTicks(5, 5, 3), [], '零跨度不给刻度');
});

test('投影：线性映射到画布，最小值贴底最大值贴顶', () => {
  const rows = [{ ts: 1, cpu: 0 }, { ts: 2, cpu: 50 }, { ts: 3, cpu: 100 }];
  const pts = project(rows, 'cpu', { x0: 0, y0: 0, x1: 100, y1: 50 });
  assert.deepEqual(pts.map(p => p.x), [0, 50, 100]);
  assert.equal(pts[0].y, 50, '最小值在底部');
  assert.equal(pts[2].y, 0, '最大值在顶部');
});

test('投影：null 直接跳过（曲线断开），而不是当成 0', () => {
  const rows = [{ cpu: 10 }, { cpu: null }, { cpu: 30 }];
  const pts = project(rows, 'cpu', { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert.equal(pts.length, 2, '空值不该画成点');
  assert.deepEqual(pts.map(p => Math.round(p.v)), [10, 30]);
});

test('投影：整列为空时返回空数组，调用方不必自己判', () => {
  assert.deepEqual(project([{ cpu: null }], 'cpu', { x0: 0, y0: 0, x1: 10, y1: 10 }), []);
  assert.deepEqual(project([], 'cpu', { x0: 0, y0: 0, x1: 10, y1: 10 }), []);
});

test('统计：跳过 null，给出当前/均值/峰值', () => {
  const s = stats([10, null, 30, 20]);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.avg, 20);
  assert.equal(s.last, 20);
  assert.equal(s.count, 3);
  assert.deepEqual(stats([null, undefined]), { min: null, max: null, avg: null, last: null, count: 0 });
});

test('多探测线按 ts 对齐：缺的留 null，不把曲线拉直', () => {
  const points = [
    { task_id: 1, ts: 100, latency: 20 },
    { task_id: 2, ts: 100, latency: 60 },
    { task_id: 1, ts: 200, latency: 22 },
    { task_id: 3, ts: 200, latency: 180 },
  ];
  const rows = alignByTs(points, [1, 2, 3]);
  assert.deepEqual(rows.map(r => r.ts), [100, 200]);
  assert.deepEqual(rows[0], { ts: 100, p1: 20, p2: 60 });
  assert.deepEqual(rows[1], { ts: 200, p1: 22, p3: 180 });
  assert.equal(rows[1].p2, undefined, '缺的探测线在这一行没有值');
});

test('降采样保均值也保极值：尖峰不能被抹掉', () => {
  const values = Array.from({ length: 100 }, (_, i) => (i === 50 ? 95 : 10));
  const out = downsample(values, 10);
  assert.equal(out.length, 10);
  assert.equal(Math.max(...out.map(b => b.max)), 95, '尖峰必须在某一桶里留下');
  assert.ok(Math.abs(out[0].avg - 10) < 1e-9);
});

test('降采样：目标点数不少于原数据时原样返回', () => {
  const values = [1, 2, 3];
  const out = downsample(values, 10);
  assert.deepEqual(out.map(b => b.avg), [1, 2, 3]);
  assert.deepEqual(out.map(b => b.min), [1, 2, 3]);
});

test('时间标签：24 小时内给时:分，超过给月-日', () => {
  const ts = Date.UTC(2026, 0, 15, 8, 30);
  assert.match(clockLabel(ts, 6), /^\d\d:\d\d$/);
  assert.match(clockLabel(ts, 168), /^\d+-\d\d$/);
});