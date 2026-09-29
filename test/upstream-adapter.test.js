// hub 上游更新的适配回归。
//
// 覆盖三件事，都对应 hub v1.3.1 的实际行为（对着上游 Rust 源码核过）：
//   1. net_rx_max / net_tx_max —— 每分钟的峰值网速，旧 hub 没有这两个字段
//   2. hub 的错误正文改成了一句中文，且是 text/plain
//   3. 主题设置：theme.json 声明 config，hub 原样存值、不做校验
//
// 不测实现细节，只锁住「上游发什么、我们怎么反应」这条契约。

import test from 'node:test';
import assert from 'node:assert/strict';

import { hubText, pick, normalizeRows } from '../theme/js/history.js';

// ---- 峰值网速字段 ----

test('峰值字段缺失时归一成 null，曲线自然断开而不是画成 0', () => {
  // 旧 hub 的响应：没有 net_rx_max / net_tx_max
  const rows = normalizeRows(
    [{ ts: 100, cpu: 1, net_rx: 500, net_tx: 200 }],
    ['cpu', 'net_rx', 'net_tx', 'net_rx_max', 'net_tx_max'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].net_rx, 500);
  // 关键：缺失 ≠ 0。画成 0 会在图上拉出一条贴底的峰值线，
  // 读起来是「这台机器网速一直很低」，而事实是「hub 没给这个数据」。
  assert.equal(rows[0].net_rx_max, null);
  assert.equal(rows[0].net_tx_max, null);
});

test('峰值字段存在时原样保留，且不小于同行的均值', () => {
  const rows = normalizeRows(
    [{ ts: 100, net_rx: 500, net_tx: 200, net_rx_max: 4000, net_tx_max: 3000 }],
    ['net_rx', 'net_tx', 'net_rx_max', 'net_tx_max'],
  );
  assert.equal(rows[0].net_rx_max, 4000);
  assert.equal(rows[0].net_tx_max, 3000);
  // 上游的 SQL 是 MAX(MAX(net_rx, net_rx_max))，峰值永远 ≥ 均值。
  assert.ok(rows[0].net_rx_max >= rows[0].net_rx);
});

test('非数字的峰值按缺失处理', () => {
  const rows = normalizeRows(
    [{ ts: 1, net_rx_max: 'lots', net_tx_max: NaN }],
    ['net_rx_max', 'net_tx_max'],
  );
  assert.equal(rows[0].net_rx_max, null);
  assert.equal(rows[0].net_tx_max, null);
});

test('缺 ts 的行整行丢掉，峰值也不例外', () => {
  const rows = normalizeRows(
    [{ net_rx_max: 999 }, { ts: 5, net_rx_max: 1 }],
    ['net_rx_max'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ts, 5);
});

// ---- 错误文案 ----

test('放行 hub 的中文短句', () => {
  // 上游 #63 之后，报错正文就是这种句子。
  assert.equal(hubText('主题包校验失败，请重新下载'), '主题包校验失败，请重新下载');
  assert.equal(hubText('  没有这个接口：/api/x  '), '没有这个接口：/api/x');
});

test('旧 hub 的英文原始错误、HTML 页面、空响应都不放行', () => {
  // 关键：长度分不开新旧 hub —— "unauthorized" 和中文短句一样短、一样单行。
  // 分开它们的是有没有中文字符。
  assert.equal(hubText('unauthorized'), '', '旧 hub 的原始英文错误不该显示给访客');
  assert.equal(hubText('forbidden'), '');
  assert.equal(hubText('Internal Server Error'), '');
  // 反代/CDN 的错误页
  assert.equal(hubText('<!DOCTYPE html>\n<html>404</html>'), '');
  assert.equal(hubText('<html><body>Not Found</body></html>'), '');
  // 空与超长
  assert.equal(hubText(''), '');
  assert.equal(hubText('   '), '');
  assert.equal(hubText('中'.repeat(300)), '');
  assert.equal(hubText(null), '');
  assert.equal(hubText(undefined), '');
});

// ---- 主题设置 ----

test('设置按声明类型取值', () => {
  const f = { key: 'k', type: 'boolean', default: true };
  assert.equal(pick({ k: false }, f), false);
  assert.equal(pick({ k: true }, f), true);
});

test('缺失或类型不对时回落到默认，而不做真值转换', () => {
  const f = { key: 'k', type: 'boolean', default: true };
  assert.equal(pick({}, f), true);
  assert.equal(pick({ k: null }, f), true);
  // 关键：Boolean('false') 是 true，字符串 "false" 绝不能被读成开启。
  // hub 原样存面板写进去的值，所以这里必须是类型判断而不是强转。
  assert.equal(pick({ k: 'false' }, f), true);
  assert.equal(pick({ k: 0 }, f), true);
  assert.equal(pick({ k: {} }, f), true);
});

test('数字与字符串字段同样只收同类型', () => {
  const n = { key: 'n', type: 'number', default: 5 };
  assert.equal(pick({ n: 7 }, n), 7);
  assert.equal(pick({ n: NaN }, n), 5);
  assert.equal(pick({ n: Infinity }, n), 5);
  assert.equal(pick({ n: '7' }, n), 5);

  const s = { key: 's', type: 'string', default: '默认' };
  assert.equal(pick({ s: '改过' }, s), '改过');
  assert.equal(pick({ s: 12 }, s), '默认');
});

test('设置读不到时（旧 hub / 匿名访客）默认值就是全部功能开启', () => {
  // themeConfig 对 404 / 401 返回 {}，所以这里模拟那个结果：
  // 两个默认值都是 true，最坏情况是多出一个鸡场按钮，而不是功能看起来没了。
  const showPeaks = { key: 'show_peaks', type: 'boolean', default: true };
  const showFarm = { key: 'show_farm', type: 'boolean', default: true };
  assert.equal(pick({}, showPeaks), true);
  assert.equal(pick({}, showFarm), true);
});
