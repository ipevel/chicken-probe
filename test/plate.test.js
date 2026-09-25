// 鸡名牌文案的回归用例。
//
// 起因：小鸡倒下时，牌子还写着「在线」——两个状态叠在一起。
// 两条路径都要钉住：
//   1) 网站鸡失联、服务端没给 reason（status 0 的兜底）时，不能再写出「网站在线」；
//   2) 探针鸡被啄倒、离线、未接入，牌面必须跟着姿态，倒下就不许出现「在线」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { npcPlate } from '../shared/plate.js';
import { ST } from '../shared/physics.js';

const probe = (over = {}) => ({
  id: 'p1', kind: 'probe', name: '首尔 · 中转', country: 'KR',
  state: ST.IDLE, tone: 'ok', label: '正常', offline: false, ko: false,
  hp: 100, maxHp: 100, up: 3 * 86400, reason: '', latency: null,
  netIn: 1024, netOut: 2048, cpu: 0.12, mem: 0.45,
  ...over,
});

const web = (over = {}) => ({
  id: 'w1', kind: 'web', name: '公司官网', country: '',
  state: ST.IDLE, tone: 'ok', label: '正常 88ms', offline: false, ko: false,
  hp: 100, maxHp: 100, up: null, reason: '', latency: 88,
  netIn: null, netOut: null, cpu: null, mem: null,
  ...over,
});

test('在线探针鸡：牌面带在线时长与流量，量规开着', () => {
  const p = npcPlate(probe());
  assert.match(p.sub, /在线 /);
  assert.equal(p.offline, false);
  assert.equal(p.gauges, true);
  assert.equal(p.title, '探针鸡·首尔 · 中转');
});

test('离线的探针鸡：牌面说离线，绝不出现「在线」', () => {
  const p = npcPlate(probe({ state: ST.DEAD, tone: 'danger', label: '离线', offline: true, up: null, netIn: null, netOut: null }));
  assert.equal(p.sub, '离线');
  assert.ok(!p.sub.includes('在线'), `倒下时牌面不该出现「在线」：${p.sub}`);
  assert.equal(p.offline, true);
  assert.equal(p.gauges, false);
});

test('被啄倒的探针鸡：牌面说被啄倒，而不是笼统的离线', () => {
  const p = npcPlate(probe({ state: ST.DEAD, tone: 'danger', label: '被啄倒', offline: true, ko: true, hp: 0, up: null }));
  assert.equal(p.sub, '被啄倒');
  assert.ok(!p.sub.includes('在线'), `倒下时牌面不该出现「在线」：${p.sub}`);
  assert.equal(p.hp, 0);
});

test('未接入探针的鸡：趴睡，牌面说未接入探针', () => {
  const p = npcPlate(probe({ state: ST.SLEEP, tone: 'muted', label: '未接入', offline: true, up: null }));
  assert.equal(p.sub, '未接入探针');
  assert.equal(p.offline, true);
});

test('服务端还没给指标的在线探针鸡：牌面只留标签，不硬凑在线时长', () => {
  const p = npcPlate(probe({ up: null, netIn: null, netOut: null, label: '流量超限' }));
  assert.equal(p.sub, '流量超限');
  assert.equal(p.offline, false);
});

test('网站鸡失联且没有 reason：牌面说网站离线（曾经错误地写成「网站在线」）', () => {
  const p = npcPlate(web({ state: ST.DEAD, tone: 'danger', label: '网站不可达', offline: true, latency: null, reason: '' }));
  assert.equal(p.sub, '网站离线');
  assert.ok(!p.sub.includes('在线'), `倒下时牌面不该出现「在线」：${p.sub}`);
  assert.equal(p.offline, true);
  assert.equal(p.gauges, false);
});

test('网站鸡失联且带 reason/HTTP 码：牌面带上原因', () => {
  assert.equal(npcPlate(web({ state: ST.DEAD, label: '网站不可达 HTTP 500', offline: true, latency: null, reason: 'HTTP 500' })).sub, '网站离线 HTTP 500');
  assert.equal(npcPlate(web({ state: ST.DEAD, label: '网站不可达', offline: true, latency: null, reason: '超时' })).sub, '网站离线 超时');
});

test('网站鸡未探测（趴睡）：牌面说未探测，不说离线也不说在线', () => {
  const p = npcPlate(web({ state: ST.SLEEP, tone: 'muted', label: '未探测', offline: true, latency: null }));
  assert.equal(p.sub, '未探测');
  assert.ok(!p.sub.includes('在线'));
});

test('在线的网站鸡：牌面带延迟', () => {
  const p = npcPlate(web());
  assert.equal(p.sub, '网站在线 88ms');
  assert.equal(p.offline, false);
  assert.equal(p.gauges, false);   // 网站鸡没有量规
});

test('网站鸡还没测出延迟：牌面说检测中，不算在线', () => {
  const p = npcPlate(web({ latency: null, label: '正常' }));
  assert.equal(p.sub, '检测网站中…');
  assert.ok(!p.sub.includes('在线'));
});

test('姿态判死但名册还没跟上（offline 仍是 false）：牌面照样说倒下', () => {
  // 这正是「鸡躺下、牌子还写在线」的一拍差：判定只看 offline 就会漏
  const stale = npcPlate(probe({ offline: false, label: '正常', up: 3 * 86400 }));
  assert.match(stale.sub, /在线 /, '名册没更新时它会说在线——这正是要修的差拍');
  const fixed = npcPlate(probe({ offline: false, state: ST.DEAD, label: '离线', up: 3 * 86400 }));
  assert.equal(fixed.sub, '离线');
  assert.equal(fixed.offline, true);
  assert.ok(!fixed.sub.includes('在线'), `实时姿态说死了，牌面就不能说在线：${fixed.sub}`);
});
