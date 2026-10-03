// 范围按钮的取值逻辑：保留期怎么变成按钮、选中项怎么收、小时数怎么说成人话。
//
// 这块单独成模块的理由就是能这样测：它决定按钮列表、请求窗口、以及「主控只给了
// N 天」那句话，而 hub 的保留期是运行时才知道的（v1.3.2 起才有 history_days）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_RANGES, rangesFor, rangesOn, spanFor, spanLabel, minutesLabel } from '../shared/ranges.js';

const hours = (offers) => offers.map((r) => r.hours);

test('拿不到保留期（老 hub）就是基础列表，兜底 7 天', () => {
  for (const days of [undefined, null, NaN, 0, -3, 'x']) {
    assert.deepEqual(hours(rangesFor(days)), [1, 6, 24, 168], `days=${String(days)}`);
  }
});

test('保留期不比 7 天长时不多给按钮', () => {
  for (const days of [1, 3, 7]) {
    assert.deepEqual(hours(rangesFor(days)), [1, 6, 24, 168], `days=${days}`);
  }
});

test('保留期比 7 天长时补一个最宽窗口，且基础四项不变', () => {
  const offers = rangesFor(30);
  assert.deepEqual(hours(offers), [1, 6, 24, 168, 720]);
  assert.equal(offers[4].label, '30 天');
  assert.deepEqual(hours(offers).slice(0, 4), hours(BASE_RANGES));
});

test('保留期是小数时向下取整（多给一天没有意义）', () => {
  assert.deepEqual(hours(rangesFor(30.9)), [1, 6, 24, 168, 720]);
});

test('一年以上说成「1 年」，一年以内说天数', () => {
  assert.equal(rangesFor(365)[4].label, '1 年');
  assert.equal(rangesFor(400)[4].label, '1 年');
  assert.equal(rangesFor(364)[4].label, '364 天');
});

test('延迟页签滤掉长窗口，资源页签原样', () => {
  const offers = rangesFor(30);
  assert.deepEqual(hours(rangesOn(offers, 'latency')), [1, 6, 24]);
  assert.equal(rangesOn(offers, 'resources'), offers);
});

test('选中的窗口还在列表里就保留', () => {
  assert.equal(spanFor(BASE_RANGES, 6), 6);
  assert.equal(spanFor(rangesFor(30), 720), 720);
});

test('选中的窗口没了就退到最宽的那个，而不是第一个', () => {
  assert.equal(spanFor(rangesOn(rangesFor(30), 'latency'), 720), 24);
  // 深链写了 720、但主控只留 3 天：退到 168
  assert.equal(spanFor(rangesFor(3), 720), 168);
});

test('小时数：不足两天按小时说，够了按天说', () => {
  assert.equal(spanLabel(1), '1 小时');
  assert.equal(spanLabel(24), '24 小时');
  assert.equal(spanLabel(48), '2 天');
  assert.equal(spanLabel(168), '7 天');
  assert.equal(spanLabel(720), '30 天');
});

/*
 * 覆盖度那句话里的数是分钟，不是小时。踩过的坑：曾经直接用 spanLabel 去说它，
 * 60 分钟被当成 60 小时换算，界面上写出来是「每点覆盖 3 天」。
 */
test('分钟数走 minutesLabel，60 分钟是 1 小时而不是 3 天', () => {
  assert.equal(minutesLabel(5), '5 分钟');
  assert.equal(minutesLabel(60), '1 小时');
  assert.equal(minutesLabel(90), '2 小时');
  assert.equal(minutesLabel(1440), '24 小时');
  assert.notEqual(minutesLabel(60), spanLabel(60));
});
