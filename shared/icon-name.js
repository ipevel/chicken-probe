// 图标名 → sprite 符号 id。协议里的 icon 是任意短字符串，映射只收在这一处。
//
// 为什么要放 shared/：两端都要用 —— theme/js/icons.js（DOM 与 canvas）与
// shared/plate.js（3D 名牌）都吃它，而 shared/ 里的模块浏览器和 node 都能加载。
//
// 纯函数、无 DOM、无全局状态：别名表与三级降级都能直接单测。

const ALIAS = new Map(Object.entries({
  // 协议名 → 符号 id
  chicken: 'i-chicken',
  logo: 'i-logo',
  // 符号 id 原样进来也要认（调用方可能已经把 iconIdOf 的结果存回了协议字段）
  'i-chicken': 'i-chicken',
  'i-logo': 'i-logo',
  // 老客户端（0.4.0 之前）存的是 emoji，也按原样发给服务端，所以这条别名必须留着。
  // 写成 \u 转义而不是字面字形：这个文件属于「不许出现 emoji」的范围
  // （theme/ 与 shared/ 只允许 flag.js/flags.js 的说明性注释），
  // 而它只是一条兼容用的键，不是要画出去的东西。U+1F414。
  '\u{1F414}': 'i-chicken',
  // 预留：以后想加别的动物，未登记的统统退到鸡
  cat: 'i-chicken',
}));

/**
 * 三级降级：
 *   ① 别名表命中 → 对应的符号 id；
 *   ② 1–2 个「非 emoji 的可见字符」→ null（调用方当文字画，保留个性化）；
 *   ③ 其他（emoji / 空 / 过长 / 控制字）→ 兜底 i-chicken，**永不把 emoji 画出去**。
 *
 * ⚠ 会返回 null。所有调用点要么用 theme/js/icons.js 的 iconEl（内部兜成 i-chicken），
 * 要么自己处理 null（例如 3D 名牌降级成纯文字）。
 *
 * @param {unknown} raw 协议里的 icon 字段（任意短字符串）
 * @returns {string|null} 符号 id；null 表示「这个名字应该当文字画」
 */
export function iconIdOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'i-chicken';
  const hit = ALIAS.get(s);
  if (hit) return hit;
  // Extended_Pictographic 抓的是图形字符，Emoji_Presentation 兜住那些默认就带 emoji
  // 呈现的字符（如 ⌚︎ 这类）。两者都不命中才算「可以当文字画」。
  if (s.length <= 2 && !/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(s)) return null;
  return 'i-chicken';
}
