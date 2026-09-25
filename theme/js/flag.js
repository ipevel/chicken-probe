// 国旗渲染：一次挂载雪碧图，之后每面旗都是一个 <use>。
//
// 用 SVG 而不是 emoji 的原因见 flags.js 顶部：Windows 没有国旗字形。
// hub 的 country 可能不在素材集里（自定地区码），那就退回两位大写字母的纯文本角标 ——
// 有素材就画旗，没有就写字，但不能什么都不显示。

import { FLAG_CODES, FLAG_SPRITE } from './flags.js';

const NS = 'http://www.w3.org/2000/svg';
let mounted = false;

/** 把雪碧图塞进文档一次：零尺寸的 SVG，不占位、不可见。 */
export function mountFlagSprite() {
  if (mounted || document.getElementById('flag-sprite')) return;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('id', 'flag-sprite');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  // 这里是素材本身，不含任何外部输入，可以整体灌进 innerHTML
  svg.innerHTML = FLAG_SPRITE;
  document.body.prepend(svg);
  mounted = true;
}

export function hasFlag(code) {
  return FLAG_CODES.has(String(code || '').trim().toUpperCase());
}

/**
 * 一面旗（或它的文字替身）。比例 3:2 + 一道极细描边：
 * 日本、波兰的旗子有一边是白的，而卡片底也是白的，不描边就糊在一起。
 */
export function flagEl(code, { size = 13 } = {}) {
  const key = String(code || '').trim().toUpperCase();
  if (!hasFlag(key)) {
    const badge = document.createElement('span');
    badge.className = 'flag-text';
    badge.textContent = key || '—';
    badge.title = key || '未知地区';
    return badge;
  }
  const wrap = document.createElement('span');
  wrap.className = 'flag';
  wrap.title = key;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 30 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(Math.round(size * 1.5)));
  svg.setAttribute('height', String(size));
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#flag-${key.toLowerCase()}`);
  svg.append(use);
  wrap.append(svg);
  return wrap;
}

/** 3D 标签用不了 SVG，退回地区码文本 —— 总比画不出字的 emoji 强。 */
export function flagText(code) {
  const key = String(code || '').trim().toUpperCase();
  return key || '';
}