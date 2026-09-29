// 窄屏探针的**判定逻辑**，单独成模块。
//
// 为什么要抽出来：判定必须能被独立自证（喂退化数据进去，看它是否真的判废），
// 而不是只能靠「跑一次真页面、祈祷故障会发生」。一个永远不亮的判据和会误报的判据一样坏。
// 抽成纯函数后，探针与敏感性自证**共用同一份实现** —— 测的不是另一份代码。
//
// 背景（两种「假通过」，都表现为「明明没量到，却报 ✅ 无重叠」）：
//   ① override 未落地 —— 请求 520×900，window.innerWidth 读回 1440。
//      此时量的是别的视口的布局，却记在「520 档」名下。
//   ② #farm 被隐藏 —— display:none 时其内部一切矩形 0×0，inter() 对 0 面积返回 null，
//      于是**永远**报「无重叠」。

/**
 * 判定一档读数是否可用。
 *
 * @param {object} m 一档量测结果（见 tools/hud-top-probe.mjs 的 MEASURE）
 * @param {{w:number,h:number}} requested 本档请求的视口
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function validateSample(m, requested) {
  const reasons = [];

  // ① 视口必须就是本档请求的那个
  if (!m || m.vw !== requested.w || m.vh !== requested.h) {
    reasons.push(`视口未落地：请求 ${requested.w}\u00d7${requested.h}，页面读回 ${m?.vw}\u00d7${m?.vh}`);
  }

  // ② 鸡场必须存在且可见 —— 隐藏时一切矩形归零，重叠判定会恒报「无」
  if (!m?.farmPresent) reasons.push('#farm 不存在');
  else if (!m.farmVisible) reasons.push('#farm 处于隐藏态（display:none）→ 所有矩形归零，重叠判定无意义');

  // ③ 参与比对的元素必须存在，且矩形不能退化（宽或高 ≤ 0）
  for (const key of ['hudStats', 'backBtn', 'roomState', 'board']) {
    const rect = m?.[key];
    if (!rect) { reasons.push(`${key} 取不到矩形`); continue; }
    if (!(rect.w > 0) || !(rect.h > 0)) {
      reasons.push(`${key} 矩形退化（${rect.w}\u00d7${rect.h}）→ 与它相关的重叠判定恒为「无重叠」，属假通过`);
    }
  }

  // ④ 顶栏行数必须是真实数出来的（0 行说明顶栏根本没渲染）
  if (!(m?.topRows >= 1)) reasons.push(`#hud-top 行数 = ${m?.topRows}（顶栏未渲染）`);

  return { valid: reasons.length === 0, reasons };
}

/**
 * 判定一批档的总体结论，给出退出码。
 *
 * @param {Array} results 各档读数（须含 verdict / overlaps / vw）
 * @returns {{exitCode:number, invalid:Array, valid:Array, overlapping:number[]}}
 */
export function summarize(results) {
  const invalid = results.filter((m) => m.verdict === 'invalid');
  const valid = results.filter((m) => m.verdict === 'ok');
  const overlapping = valid
    .filter((m) => m.overlaps['backBtn\u00d7board'] || m.overlaps['roomState\u00d7board'] || m.overlaps['hudStats\u00d7board'])
    .map((m) => m.vw);
  // 有效档全挂但无效档存在 → 判据不可用（2），不能报「通过」（0）
  const exitCode = invalid.length ? 2 : (overlapping.length ? 1 : 0);
  return { exitCode, invalid, valid, overlapping };
}
