// 窄屏探针**判定逻辑**的敏感性自证 —— 证明它不是空门。
//
// 判据家族：「一个会自己误报的判据，比没有判据更坏。」
// 而一个**永远不会报**的判据同样坏 —— 它会让人把绿灯当成「没问题」。
//
// 所以这里两个方向都要证：
//   · 会亮：成因①（视口未落地）、成因②（#farm 隐藏 / 矩形退化）都必须真判废；
//   · 不乱亮：健康读数必须判有效（否则判据变成「永远报错」的另一个极端）。
//
// 为什么直接喂退化数据给纯函数，而不是起浏览器注入真页面：
//   首轮尝试用 Page.addScriptToEvaluateOnNewDocument 注入「隐藏 #farm」，
//   结果 #farm 被页面启动逻辑重新设回 display:block（矩形 390×844），注入被覆盖。
//   与页面启动逻辑争抢状态的自证**本身就不确定**（故障有没有发生都不知道），
//   那自证也就没有价值。改成构造退化读数喂纯函数：确定、可复现、不依赖时序、无外部依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSample, summarize } from '../tools/hud-top-verdict.mjs';

const REQ = { w: 520, h: 900 };
const rect = (l, t, w, h) => ({ l, r: l + w, t, b: t + h, w, h });
const ZERO = rect(0, 0, 0, 0);

/** 一档「健康」读数：字段齐备、矩形非退化、视口对得上。 */
function good(over = {}) {
  return {
    vw: REQ.w, vh: REQ.h,
    farmPresent: true, farmHidden: false, farmVisible: true,
    farmRect: rect(0, 0, 520, 900),
    hudStats: rect(16, 16, 106.4, 66),
    backBtn: rect(143.4, 16, 81, 44),
    roomState: rect(229.4, 16, 36, 28),
    board: rect(359.3, 16, 144.7, 65.5),
    topRows: 1,
    overlaps: {},
    ...over,
  };
}

test('正控：健康读数判有效（判据不乱报）', () => {
  const v = validateSample(good(), REQ);
  assert.equal(v.valid, true, `误判无效：${v.reasons.join('; ')}`);
  assert.deepEqual(v.reasons, []);
});

test('成因①：override 未落地（读回 1440）→ 判无效', () => {
  const v = validateSample(good({ vw: 1440 }), REQ);
  assert.equal(v.valid, false);
  assert.ok(v.reasons.some((s) => /视口未落地/.test(s)), v.reasons.join('; '));
});

test('成因②：#farm 隐藏 → 判无效（成因②的完整形态）', () => {
  const v = validateSample(good({
    farmHidden: true, farmVisible: false,
    farmRect: ZERO, hudStats: ZERO, backBtn: ZERO, roomState: ZERO, board: ZERO,
  }), REQ);
  assert.equal(v.valid, false);
  // 隐藏态与退化矩形两条理由都要出 —— 前者说不该量，后者说量了也没用
  assert.ok(v.reasons.some((s) => /隐藏态/.test(s)), '缺「#farm 隐藏态」理由');
  assert.ok(v.reasons.some((s) => /矩形退化/.test(s)), '缺「矩形退化」理由');
});

test('成因②变体：#farm 可见但个别矩形退化 → 仍判无效', () => {
  const v = validateSample(good({ board: ZERO }), REQ);
  assert.equal(v.valid, false);
  assert.ok(v.reasons.some((s) => /board 矩形退化/.test(s)), v.reasons.join('; '));
});

test('参与比对的元素缺失 → 判无效', () => {
  const v = validateSample(good({ hudStats: null }), REQ);
  assert.equal(v.valid, false);
  assert.ok(v.reasons.some((s) => /hudStats 取不到矩形/.test(s)), v.reasons.join('; '));
});

test('顶栏未渲染（0 行）→ 判无效', () => {
  const v = validateSample(good({ topRows: 0 }), REQ);
  assert.equal(v.valid, false);
  assert.ok(v.reasons.some((s) => /行数 = 0/.test(s)), v.reasons.join('; '));
});

test('汇总：全有效且无重叠 → exit 0', () => {
  const s = summarize([
    { verdict: 'ok', vw: 520, overlaps: {} },
    { verdict: 'ok', vw: 561, overlaps: {} },
  ]);
  assert.equal(s.exitCode, 0);
  assert.equal(s.invalid.length, 0);
  assert.deepEqual(s.overlapping, []);
});

test('汇总：存在无效档 → exit 2（不许拿其余档的绿灯当结论）', () => {
  const s = summarize([
    { verdict: 'ok', vw: 320, overlaps: {} },
    { verdict: 'invalid', vw: 520, overlaps: {} },
  ]);
  assert.equal(s.exitCode, 2);
  assert.equal(s.invalid.length, 1);
});

test('汇总：有效档真重叠 → exit 1', () => {
  const s = summarize([
    { verdict: 'ok', vw: 320, overlaps: { 'backBtn\u00d7board': { w: 3, h: 10 } } },
    { verdict: 'ok', vw: 561, overlaps: {} },
  ]);
  assert.equal(s.exitCode, 1);
  assert.deepEqual(s.overlapping, [320]);
});

test('汇总优先级：无效档压过重叠档 → exit 2（判据不可用优先于结论）', () => {
  const s = summarize([
    { verdict: 'ok', vw: 320, overlaps: { 'backBtn\u00d7board': { w: 3, h: 10 } } },
    { verdict: 'invalid', vw: 520, overlaps: {} },
  ]);
  assert.equal(s.exitCode, 2);
});
