import test from 'node:test';
import assert from 'node:assert/strict';
import { hash32, appearance, spotFor, poseOf, chickenFor, chickenFlock } from '../shared/node-map.js';
import { CONF, OBSTACLES, WORLD_HALF } from '../shared/physics.js';

const NOW = 1_800_000_000;
const GB = 1024 ** 3;

const node = (over = {}) => ({
  id: 1, name: '东京 · Oracle', country: 'JP', online: true, last_seen: NOW,
  cpu_cores: 4, mem_total: 8 * GB, traffic_limit: 100 * GB, traffic_mode: 'sum', month_used: 10 * GB,
  metrics: { cpu: 20, mem_used: 2 * GB, mem_total: 8 * GB, disk_used: 10 * GB, disk_total: 40 * GB, load: [0.5, 0.4, 0.3] },
  ...over,
});

test('哈希稳定且分散：同样的输入永远同样的输出', () => {
  assert.equal(hash32('app:1'), hash32('app:1'));
  assert.notEqual(hash32('app:1'), hash32('app:2'));
  const vals = new Set(['a', 'b', 'c', '东京', 'node-99'].map(s => hash32(s)));
  assert.equal(vals.size, 5);
  assert.ok([...vals].every(v => v >= 0 && v <= 0xffffffff));
});

test('位置只由 id 决定：节点列表变了，别的鸡也不许挪窝', () => {
  const one = spotFor(node({ id: 7 }));
  const same = spotFor(node({ id: 7, name: '换了个名字' }));
  assert.deepEqual(one, same, '名字/状态变了不该改变站位');
  // 列表里加几台机器，也不影响第 7 台的位置 —— 这是各端一致的前提
  const flockA = chickenFlock([node({ id: 1 }), node({ id: 7 })], NOW);
  const flockB = chickenFlock([node({ id: 1 }), node({ id: 3 }), node({ id: 7 }), node({ id: 9 })], NOW);
  const pick = (f) => f.find(c => c.id === 7);
  assert.deepEqual({ x: pick(flockA).x, z: pick(flockA).z }, { x: pick(flockB).x, z: pick(flockB).z });
});

test('同一个人两次算出来完全一样（跨端一致）', () => {
  const a = chickenFor(node({ id: 42, name: '法兰克福 · Hetzner' }), NOW);
  const b = chickenFor(node({ id: 42, name: '法兰克福 · Hetzner' }), NOW);
  assert.deepEqual(a, b);
});

test('鸡不会叠在一起：13 台两两间距足够', () => {
  const flock = chickenFlock(Array.from({ length: 13 }, (_, i) => node({ id: i + 1 })), NOW);
  let min = Infinity;
  for (let i = 0; i < flock.length; i++) {
    for (let j = i + 1; j < flock.length; j++) {
      min = Math.min(min, Math.hypot(flock[i].x - flock[j].x, flock[i].z - flock[j].z));
    }
  }
  assert.ok(min > 1.4, `最近的两只鸡相距 ${min.toFixed(2)}m，会糊在一起`);
});

test('鸡不会站进鸡舍/草垛/树里，也不会站到场地外', () => {
  for (let id = 1; id <= 260; id++) {
    const { x, z } = spotFor(node({ id }));
    assert.ok(Math.hypot(x, z) < WORLD_HALF, `id=${id} 站到场地外了`);
    for (const o of OBSTACLES) {
      if (o.type === 'fence') continue;   // 围栏就是边界，上面那条已经管住了
      const insideX = Math.abs(x - o.x) < o.w / 2 + CONF.radius - 1e-6;
      const insideZ = Math.abs(z - o.z) < o.d / 2 + CONF.radius - 1e-6;
      assert.ok(!(insideX && insideZ), `id=${id} 站进了 ${o.type}（dx=${(x - o.x).toFixed(2)} dz=${(z - o.z).toFixed(2)}）`);
    }
  }
});

test('站位铺得开：往里加机器，圈子会变大而不是挤成一团', () => {
  const near = spotFor(node({ id: 2 }));
  const far = spotFor(node({ id: 60 }));
  assert.ok(Math.hypot(far.x, far.z) > Math.hypot(near.x, near.z) + 2, '靠后的 id 应该站得更外圈');
});

test('姿态：离线倒地、未接入趴睡、超阈告警、陈旧保持站立但发灰', () => {
  assert.equal(poseOf(node({ online: false }), NOW).state, 'dead');
  assert.equal(poseOf(node({ cpu_cores: 0, mem_total: 0, online: false }), NOW).state, 'sleep');
  assert.equal(poseOf(node({ metrics: { ...node().metrics, cpu: 97 } }), NOW).state, 'alert');
  assert.equal(poseOf(node({ last_seen: NOW - 900 }), NOW).state, 'idle');
  assert.equal(poseOf(node({ last_seen: NOW - 900 }), NOW).tone, 'muted');
  assert.equal(poseOf(node(), NOW).state, 'idle');
  assert.equal(poseOf(node(), NOW).tone, 'ok');
});

test('羽色只给调色板编号（0~4 的 5 套羽色），同一台机器永远同一套', () => {
  const a = appearance(node({ id: 3 }));
  const b = appearance(node({ id: 3 }));
  assert.deepEqual(a, b, '同一台机器两次必须一样');
  assert.equal(a.palette, b.palette);
  assert.ok(Number.isInteger(a.palette) && a.palette >= 0 && a.palette <= 4, `调色板编号 ${a.palette} 越界`);
  assert.ok(a.scale > 0.85 && a.scale < 1.3, `体型 ${a.scale} 应在合理区间`);

  // 相邻 id 不该全落在同一套羽色上（否则满场一个颜色）
  const set = new Set(Array.from({ length: 12 }, (_, i) => appearance(node({ id: i + 1 })).palette));
  assert.ok(set.size >= 3, `12 台机器只用到 ${set.size} 套羽色`);
});

test('鸡身上带着面板要用的读数：CPU、内存占比、流量、告警标记', () => {
  const c = chickenFor(node({ metrics: { ...node().metrics, cpu: 95, mem_used: 7 * GB, mem_total: 8 * GB } }), NOW);
  assert.equal(c.cpu, 95);
  assert.equal(Math.round(c.mem), 88);
  assert.equal(c.attention, true, '告警鸡要能被立刻认出来');
  assert.equal(c.label, '告警');
  const ok = chickenFor(node(), NOW);
  assert.equal(ok.attention, false);
  assert.equal(ok.used, 10 * GB);
});

test('鸡群顺序按 id，各端渲染顺序一致', () => {
  const flock = chickenFlock([node({ id: 9 }), node({ id: 2 }), node({ id: 5 })], NOW);
  assert.deepEqual(flock.map(c => c.id), [2, 5, 9]);
});