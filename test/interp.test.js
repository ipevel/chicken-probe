import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuffer, push, sample, latestT, ids, DEFAULT_MAX } from '../shared/interp.js';

const mk = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { y: 0, yaw: 0, st: 'idle', hp: 100, ...v }]));

test('两帧之间线性插值：中点取中值', () => {
  const buf = createBuffer();
  push(buf, 1000, mk({ a: { x: 0, z: 0 } }));
  push(buf, 1100, mk({ a: { x: 10, z: -4 } }));
  const s = sample(buf, 1050, 'a');
  assert.equal(s.x, 5);
  assert.equal(s.z, -2);
});

test('角度走最短弧：从 3.0 到 -3.0 不该甩一整圈', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: { yaw: 3.0 } }));
  push(buf, 100, mk({ a: { yaw: -3.0 } }));
  const mid = sample(buf, 50, 'a').yaw;
  // 等价于 3.0 → 3.28（越过 π），中点应在 3.14 附近而不是 0
  assert.ok(mid > 3.0 && mid < 3.29, `得到 ${mid}`);
});

test('状态与血量取新帧，不插值', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: { x: 0, st: 'walk', hp: 100 } }));
  push(buf, 100, mk({ a: { x: 10, st: 'dead', hp: 0 } }));
  const s = sample(buf, 50, 'a');
  assert.equal(s.st, 'dead');
  assert.equal(s.hp, 0);
  assert.equal(s.x, 5, '位置仍然插值');
});

test('只有一帧时直接用它：刚进场的瞬间也得能画', () => {
  const buf = createBuffer();
  push(buf, 1000, mk({ a: { x: 7, z: 8, yaw: 1 } }));
  assert.deepEqual({ x: sample(buf, 1200, 'a').x, z: sample(buf, 1200, 'a').z }, { x: 7, z: 8 });
  assert.equal(sample(buf, 500, 'a').x, 7, '早于最早的一帧也用第一帧');
});

test('超出最新时间用最后一帧，不会外推', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: { x: 0 } }));
  push(buf, 100, mk({ a: { x: 10 } }));
  assert.equal(sample(buf, 99999, 'a').x, 10, '不该外推到 1000 以外');
});

test('缓冲里的 id 不与别的采样混起来，取不存在的 id 得到 null', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: { x: 1 }, b: { x: 2 } }));
  push(buf, 100, mk({ a: { x: 3 }, b: { x: 4 } }));
  assert.equal(sample(buf, 50, 'b').x, 3);
  assert.equal(sample(buf, 50, '不存在'), null);
});

test('中间帧缺了这个 id：退回存在的相邻帧，不返回 null', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: { x: 0 } }));
  push(buf, 100, new Map());          // 这一帧没他（丢包/刚离场）
  push(buf, 200, mk({ a: { x: 20 } }));
  const s = sample(buf, 150, 'a');
  assert.ok(s && Number.isFinite(s.x), '应拿到一个可画的坐标');
});

test('乱序到达的旧帧被丢掉：时间必须单调', () => {
  const buf = createBuffer();
  push(buf, 1000, mk({ a: { x: 1 } }));
  push(buf, 900, mk({ a: { x: 999 } }));   // 迟到的旧帧
  assert.equal(buf.items.length, 1);
  assert.equal(sample(buf, 1000, 'a').x, 1);
  assert.equal(latestT(buf), 1000);
});

test('缓冲有上限，不会无限长大', () => {
  const buf = createBuffer(5);
  for (let i = 0; i < 50; i++) push(buf, i * 50, mk({ a: { x: i } }));
  assert.equal(buf.items.length, 5);
  assert.equal(DEFAULT_MAX, 24);
});

test('ids() 汇总出现过的人，供清理离场者', () => {
  const buf = createBuffer();
  push(buf, 0, mk({ a: {}, b: {} }));
  push(buf, 50, mk({ b: {}, c: {} }));
  assert.deepEqual([...ids(buf)].sort(), ['a', 'b', 'c']);
});