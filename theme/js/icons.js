// 图标薄封装：DOM 与 canvas 共用的唯一入口。
//
// sprite 已经内联在 index.html 的 #icon-sprite 里，这里只做「图标名 → DOM 元素 /
// Path2D」的翻译，不新建 SVG 表现属性、也不改 sprite 内容。
//
// 两条约定：
//   1) 颜色永远来自 currentColor（DOM 侧）或调用方传的 color（canvas 侧）。
//      这里没有任何颜色字面量。
//   2) sprite 里的图形只用 <path>，所以 canvas 侧可以逐个取 d 拼一条 Path2D ——
//      不必依赖 SVGGeometryElement.getPathData()（兼容性至今不齐）。

import { iconIdOf } from '/shared/icon-name.js';

const NS = 'http://www.w3.org/2000/svg';
const pathCache = new Map();
// sprite 是静态的：一个 id 确认存在过就不用再查 DOM。反向（不存在）不缓存，
// 因为模块可能在 sprite 挂上之前就被 import。
const knownSymbols = new Set();

/**
 * 名字 → sprite 符号 id。
 *
 * 这里必须分清两条来源，混了会静默画错图标（不报错、也不缺图标，只是图形不对）：
 *   ① 内部调用点传的是**符号名**：'sound-off' / 'gear' / 'i-sound-off'；
 *   ② 协议传的是**客户端自定义的图标名**：'chicken' / '甲' / 一个 emoji —— 交给 iconIdOf 映射。
 *
 * 判据只能是「sprite 里到底有没有这个符号」，不能用字符串形状猜：
 * iconIdOf 会把任何长度 > 2 的陌生串兜底成 i-chicken，所以如果不先按 ① 试，
 * 'sound-off' 这种内部名字会被静默画成一只鸡 —— KO 横幅上是鸡头而不是眩晕脸、
 * 静音提示上是鸡头而不是喇叭，全都不会报错。
 *
 * @param {string} raw
 * @returns {string|null} 符号 id；null = 这个名字该画文字（协议里的 1–2 个可见字）
 */
function resolveSymbol(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return 'i-chicken';
  const direct = name.startsWith('i-') ? name : `i-${name}`;
  if (knownSymbols.has(direct)) return direct;
  if (document.getElementById('icon-sprite')) {
    const el = document.getElementById(direct);
    if (el && el.localName === 'symbol') {
      knownSymbols.add(direct);
      return direct;
    }
  }
  return iconIdOf(name);
}

/**
 * 行内图标：`<svg class="i i-20"><use href="#i-x"/></svg>`
 *
 * label 有值时给辅助技术（role=img + aria-label），否则整块 aria-hidden —— 别两样都不给：
 * 图标旁有文字时读屏该念文字，图标是控件唯一内容时名称要给控件本身。
 *
 * ⚠ resolveSymbol 可能返回 null（意思是「这个名字应该当文字画」）。DOM 里这里没有文字位，
 * 所以必须兜成 i-chicken —— 不兜的话 use 的 href 会写成 "#null"，
 * 得到一个空白方块，而且不报错，很难查。
 *
 * @param {string} name 符号名（'gear' / 'i-gear'）或协议来的图标名（'chicken' / '甲'）
 * @param {number} size 16 / 20 / 26（对应样式表里的 .i-16 / .i-20 / .i-26）
 * @param {string} [label] 可访问名；不传则 aria-hidden
 * @returns {SVGSVGElement}
 */
export function iconEl(name, size = 20, label) {
  const id = resolveSymbol(name) || 'i-chicken';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `i i-${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/**
 * canvas 侧：把 symbol 里所有 <path> 的 d 合成一条 Path2D（并缓存）。
 * 依赖 sprite「只用 <path>」这条约定，所以不需要 getPathData()。
 * fill 模式的符号（i-logo / i-hit）用 data-mode 区分：调用方据此决定 fill 还是 stroke。
 *
 * @param {string} name 符号名或协议来的图标名
 * @returns {{path: Path2D, mode: 'fill'|'stroke'}|null} null = 该画文字，或 sprite 还没挂上
 */
export function iconPath(name) {
  const id = resolveSymbol(name);
  if (!id) return null;                        // null = 该画文字，交给调用方
  if (pathCache.has(id)) return pathCache.get(id);
  const sym = document.getElementById(id);
  if (!sym) return null;                       // sprite 还没挂上：不缓存，调用方自己降级
  const path = new Path2D();
  for (const el of sym.querySelectorAll('path')) path.addPath(new Path2D(el.getAttribute('d')));
  const rec = { path, mode: sym.getAttribute('data-mode') === 'fill' ? 'fill' : 'stroke' };
  pathCache.set(id, rec);
  return rec;
}

/**
 * 3D 名牌用：在 canvas 上按 24 网格画一个图标。
 * 坐标语义是「左上角 + 边长」，内部负责把 24 网格缩放到 size。
 * 描边宽度沿用 sprite 的 1.75（在 24 网格坐标系里量），所以画出来的线宽与 DOM 侧一致。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name
 * @param {number} x 左上角
 * @param {number} y 左上角
 * @param {number} size 边长（px）
 * @param {string} color
 * @returns {boolean} 画了没有（false 时调用方该退回文字）
 */
export function drawIcon(ctx, name, x, y, size, color) {
  const ic = iconPath(name);
  if (!ic) return false;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  if (ic.mode === 'fill') {
    ctx.fillStyle = color;
    ctx.fill(ic.path, 'evenodd');
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(ic.path);
  }
  ctx.restore();
  return true;
}
