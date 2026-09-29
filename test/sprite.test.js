// 图标 sprite 回归测试 —— 每条断言都对应一个真实发生过的「静默故障」。
//
// 背景：主题把 23 个图标以内联 <symbol> 的形式放在 theme/index.html 的 #icon-sprite 里
// （为什么必须内联，见 README 第七章）。这份 sprite 是**手工同步**的：源头在
// docs/icons/sprite.svg，改完要重新内联进 index.html。手工同步的链路一旦漏掉一步，
// 页面不会报错、也不会缺图标，只是形状/颜色悄悄不对 —— 所以必须由测试兜住。
//
// 本文件只读仓库文件，不改任何已验代码。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_HTML = path.join(ROOT, 'theme', 'index.html');
const SPRITE_SVG = path.join(ROOT, 'docs', 'icons', 'sprite.svg');
const README = path.join(ROOT, 'README.md');

/** 严禁出现 emoji / 图形字形的目录（README 第七章口径：只允许 flag.js / flags.js 的说明性注释）。 */
const EMOJI_FREE_DIRS = ['theme', 'shared'];
const EMOJI_FREE_SKIP = new Set(['flags.js', 'flag.js']);

// ─────────────────────────────────────────────────────────────
// 极简解析器：够用即可，不引依赖。

/** 去掉 HTML/SVG 注释。注释里会出现文档示例（如 <use href="#id">），不能当真实引用扫。 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * 去掉 JS 行注释与块注释。JSDoc 里常写用法示例（`<use href="#i-x"/>`），
 * 那是文档不是引用 —— 不剥掉会误报悬空 <use>。
 * 只服务于本测试的静态扫描，不追求词法完备（不处理字符串/正则里的 // ）。
 */
function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** 源码静态扫描前统一预处理：去掉两种注释。 */
function stripAllComments(text, file) {
  const base = stripComments(text);
  return /\.(js|mjs)$/.test(file || '') ? stripJsComments(base) : base;
}

/** 从一段 SVG/HTML 文本里按出现顺序取出 <symbol> 的 id。 */
function symbolIds(text) {
  return [...stripComments(text).matchAll(/<symbol\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
}

/**
 * 取出每个 <symbol> 的开标签属性与其内部 <path> 的 d 集合。
 * @returns {Map<string, {attrs: Map<string,string>, ds: string[], html: string}>}
 */
function parseSymbols(text) {
  const out = new Map();
  const re = /<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g;
  for (const m of stripComments(text).matchAll(re)) {
    const attrs = new Map();
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs.set(a[1], a[2]);
    const id = attrs.get('id');
    const ds = [...m[2].matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((p) => p[1]);
    out.set(id, { attrs, ds, html: m[0] });
  }
  return out;
}

/** 路径数据归一化：只比形状，忽略空白与数字书写差异（1.0 ≡ 1）。 */
function normPath(d) {
  return String(d)
    .replace(/(\d)\.(\d)/g, (_, a, b) => `${a}.${b}`) // 占位，保持可读
    .replace(/[,\s]+/g, ' ')
    .trim()
    .replace(/\s*([A-Za-z])\s*/g, ' $1 ')
    .replace(/-?\d*\.?\d+/g, (n) => String(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 递归列出目录下的文本类文件。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html|css|json)$/.test(name)) out.push(full);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 最小 DOM 桩：让 theme/js/icons.js 能在 node 里被 import。
//
// 目的是**真的执行** resolveSymbol，而不是把它的逻辑在测试里抄一遍 ——
// 抄一遍等于测了个假的。icons.js 只需要 document.createElementNS /
// getElementById，以及全局 Path2D（只有 canvas 路径用到，DOM 侧不碰）。

function installDomStub() {
  const stubDoc = {
    getElementById: () => null, // sprite 不存在 → 全走 iconIdOf 降级
    createElementNS: (_ns, tag) => {
      const el = {
        localName: tag,
        tagName: tag.toUpperCase(),
        attrs: new Map(),
        children: [],
        setAttribute(k, v) { this.attrs.set(k, String(v)); },
        getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
        append(child) { this.children.push(child); },
        querySelectorAll: () => [],
      };
      return el;
    },
  };
  const prevDoc = globalThis.document;
  const prevPath2D = globalThis.Path2D;
  globalThis.document = stubDoc;
  globalThis.Path2D = class Path2D { addPath() {} };
  return () => {
    globalThis.document = prevDoc;
    globalThis.Path2D = prevPath2D;
  };
}

/**
 * icons.js 里写的是绝对路径 import '/shared/icon-name.js'（浏览器里由 dev/prod
 * 服务器的静态根解析）。node 的 ESM 解析器会把它当成盘符根 —— 在 Windows 上变成
 * 'E:\shared\icon-name.js'，直接 ERR_MODULE_NOT_FOUND。
 *
 * 用自定义 loader 把这个浏览器绝对路径改写到仓库根，这样测试跑的是**真源码**，
 * 而不是把 resolveSymbol 的逻辑在测试里抄一遍（抄一遍等于测了个假的）。
 */
const DOM_STUB_LOADER = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/shared/')) {
    const { pathToFileURL } = await import('node:url');
    const path = await import('node:path');
    const root = ${JSON.stringify(ROOT)};
    const target = path.join(root, specifier.slice(1));
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

/** 在改写 loader 下 import 一个模块（每次都用新 query 绕开模块缓存）。 */
async function importWithLoader(relPath, tag) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sprite-test-'));
  const loaderPath = path.join(dir, `loader-${tag}.mjs`);
  writeFileSync(loaderPath, DOM_STUB_LOADER, 'utf8');
  // ⚠ register() 必须收 file:// URL：传 Windows 盘符路径会被当成 'c:' 协议，
  //    loader 静默不生效，'/shared/...' 直接落到默认解析器上报 ERR_MODULE_NOT_FOUND。
  register(pathToFileURL(loaderPath).href);
  const fileUrl = pathToFileURL(path.join(ROOT, relPath));
  fileUrl.searchParams.set('t', tag);
  return import(fileUrl.href);
}

// ─────────────────────────────────────────────────────────────
// 断言 1 —— 内联 sprite 与源头 sprite 集合相等、顺序一致、逐路径一致

test('内联 sprite 与 docs/icons/sprite.svg 的符号集合、顺序、路径完全一致', () => {
  const inline = readFileSync(INDEX_HTML, 'utf8');
  const source = readFileSync(SPRITE_SVG, 'utf8');

  const a = symbolIds(inline);
  const b = symbolIds(source);

  // 集合相等
  assert.deepEqual(
    [...a].sort(), [...b].sort(),
    '内联 sprite 与 docs/icons/sprite.svg 的符号集合不一致 —— 改了源头忘了重新内联，或反过来',
  );
  // 数量相等（集合相等已蕴含，但数量单独报错更直白）
  assert.equal(a.length, b.length, '符号数量不一致');
  // 顺序一致：canvas 侧与人工核对都依赖这个顺序
  assert.deepEqual(a, b, '符号顺序不一致（内联时被打乱了）');

  // 逐个符号比路径：只看数量会漏掉「换了形状但数量没变」
  const ia = parseSymbols(inline);
  const ib = parseSymbols(source);
  for (const id of b) {
    const pa = ia.get(id);
    const pb = ib.get(id);
    assert.ok(pa && pb, `符号 ${id} 解析失败`);
    assert.deepEqual(
      pa.ds.map(normPath), pb.ds.map(normPath),
      `符号 ${id} 的 <path d> 与源头不一致 —— 内联没有同步`,
    );
    // viewBox 也必须一致，否则图标会被拉伸
    assert.equal(pa.attrs.get('viewBox'), pb.attrs.get('viewBox'), `符号 ${id} 的 viewBox 不一致`);
  }
});

// ─────────────────────────────────────────────────────────────
// 断言 2 —— 表现属性写在每个 <symbol> 自己身上
// 写错的表现：21 个描边符号全部渲染成实心黑块，且不报任何错。

test('每个 symbol 自带表现属性（防「写在根 svg 上 → 全渲染成黑块」）', () => {
  const inline = readFileSync(INDEX_HTML, 'utf8');
  const syms = parseSymbols(inline);
  assert.equal(syms.size, 23, `内联 symbol 数量应为 23，实际 ${syms.size}`);

  for (const [id, { attrs, html }] of syms) {
    const mode = attrs.get('data-mode'); // 'fill' 的实心符号（i-logo / i-hit）
    const fill = attrs.get('fill');
    const stroke = attrs.get('stroke');

    // ① 表现属性必须能被 <use> 的 shadow tree 拿到。
    //    继承链是「use 元素 + 文档祖先」，不包含 symbol 的祖先 —— 所以要么写在
    //    <symbol> 自己身上，要么写在它的每个子 <path> 上；两处都没有就是黑块。
    const pathCount = (html.match(/<path\b/g) || []).length;
    const pathsWithFill = (html.match(/<path\b[^>]*\bfill="/g) || []).length;
    const selfHasPaint = fill != null || stroke != null;
    const pathsAllHaveFill = pathCount > 0 && pathsWithFill === pathCount;

    assert.ok(
      selfHasPaint || pathsAllHaveFill,
      `符号 ${id} 既没在 <symbol> 上写 fill/stroke，也不是每个 <path> 都自带 fill —— ` +
      '靠继承拿不到，会渲染成黑块',
    );

    if (mode === 'fill') {
      // 实心符号：不能整体 fill="none"，也不能有任何一个 path 是 fill="none" 而没别的兜底
      assert.notEqual(fill, 'none', `实心符号 ${id}（data-mode="fill"）不能 fill="none"`);
      assert.ok(
        pathsWithFill > 0,
        `实心符号 ${id} 的 <path> 必须自带 fill（否则整块消失）`,
      );
    } else {
      // 描边符号：根上必须有 fill="none"，否则闭合子路径被填充成实心块
      assert.equal(fill, 'none', `描边符号 ${id} 必须自带 fill="none"（否则会变成实心黑块）`);
      assert.ok(stroke, `描边符号 ${id} 必须自带 stroke="currentColor" 之类的取值`);
      assert.ok(attrs.get('stroke-width'), `描边符号 ${id} 必须自带 stroke-width`);
      // 颜色必须走 currentColor，不许硬编码 —— 硬编码会让暗色主题不跟随
      assert.equal(
        stroke, 'currentColor',
        `描边符号 ${id} 的 stroke 应为 currentColor，实际「${stroke}」—— 硬编码颜色会让暗色主题不跟随`,
      );
    }

    // ② 任何显式的 fill/stroke 取值都只能是 currentColor / none，不许硬编码颜色
    for (const m of html.matchAll(/\b(fill|stroke)\s*=\s*"([^"]+)"/g)) {
      assert.match(
        m[2], /^(currentColor|none)$/,
        `符号 ${id} 出现硬编码颜色 ${m[1]}="${m[2]}" —— 暗色主题不会跟随`,
      );
    }

    // ③ 图形只用 <path>：canvas 侧靠 querySelectorAll('path') 拼 Path2D，
    //    出现 <circle>/<rect> 等会让 3D 名牌上少画图形且不报错
    const otherShapes = html.match(/<(circle|rect|ellipse|line|polygon|polyline)\b/g);
    assert.equal(
      otherShapes, null,
      `符号 ${id} 用了 <${otherShapes?.[0]?.match(/<(\w+)/)?.[1]}> —— 约定是只用 <path>（canvas 侧要拼 Path2D）`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
// 断言 3 —— 所有引用都能解析到符号（防悬空 <use>）

test('全仓 <use href="#x"> 与 icons.js 里的符号名都能解析到 sprite 符号', () => {
  const inline = readFileSync(INDEX_HTML, 'utf8');
  const ids = new Set(symbolIds(inline));

  const files = walk(path.join(ROOT, 'theme')).concat(
    walk(path.join(ROOT, 'shared')),
    walk(path.join(ROOT, 'server')),
  );
  let uses = 0;
  for (const f of files) {
    const text = stripAllComments(readFileSync(f, 'utf8'), f);
    for (const m of text.matchAll(/<use\b[^>]*\bhref\s*=\s*"#([^"]+)"/g)) {
      uses++;
      assert.ok(ids.has(m[1]), `${path.relative(ROOT, f)} 引用了不存在的符号 #${m[1]}（悬空 <use>）`);
    }
  }
  assert.ok(uses > 0, '没有扫描到任何 <use href="#...">，扫描逻辑可能失效');
});

// ─────────────────────────────────────────────────────────────
// 断言 4 —— 内部符号名不退化成鸡头
//
// 历史真 bug：iconEl('sound-off') 被 iconIdOf 兜底成 i-chicken，
// 于是 KO 横幅上是鸡头而不是眩晕脸、静音提示上是鸡头而不是喇叭。
// 不报错、尺寸和颜色全对，静态 HTML 里的图标却都是对的，所以一开始没暴露。

test('icons.js / farm.js 等调用点传的字面量符号名都真实存在（不退化成鸡头）', () => {
  const inline = readFileSync(INDEX_HTML, 'utf8');
  const ids = new Set(symbolIds(inline));

  const callFiles = [
    'theme/js/icons.js',
    'theme/js/farm.js',
    'theme/js/chicken.js',
    'theme/js/main.js',
    'theme/js/panel.js',
  ];

  let checked = 0;
  for (const rel of callFiles) {
    const text = stripJsComments(readFileSync(path.join(ROOT, rel), 'utf8'));
    // 抓 iconEl('x') / iconPath('x') / drawIcon(ctx,'x',...) 的字面量
    for (const m of text.matchAll(/\b(?:iconEl|iconPath|drawIcon)\s*\(([^)]*)\)/g)) {
      for (const s of m[1].matchAll(/'([A-Za-z][\w-]*)'/g)) {
        const name = s[1];
        const id = name.startsWith('i-') ? name : `i-${name}`;
        checked++;
        assert.ok(
          ids.has(id),
          `${rel} 传了「${name}」，但 sprite 里没有 ${id} —— 会被 iconIdOf 兜底成鸡头且不报错`,
        );
      }
    }
  }
  assert.ok(checked > 0, '没有扫描到任何字面量图标名，扫描逻辑可能失效');
});

// ─────────────────────────────────────────────────────────────
// 断言 5 —— iconIdOf 三级降级（纯函数，直接 import 真源码）

test('iconIdOf 三级降级：别名命中 / 短可见字当文字 / 其余兜底成鸡头', async () => {
  const { iconIdOf } = await import('../shared/icon-name.js');

  // ① 别名表命中
  assert.equal(iconIdOf('chicken'), 'i-chicken');
  assert.equal(iconIdOf('logo'), 'i-logo');
  assert.equal(iconIdOf('i-chicken'), 'i-chicken');
  assert.equal(iconIdOf('i-logo'), 'i-logo');
  assert.equal(iconIdOf('\u{1F414}'), 'i-chicken', '旧客户端的 emoji 必须映射，不许画出去');
  assert.equal(iconIdOf('cat'), 'i-chicken', '未登记别名退到鸡');

  // ② 1–2 个非 emoji 可见字符 → null（当文字画，保留个性化）
  assert.equal(iconIdOf('甲'), null);
  assert.equal(iconIdOf('AB'), null);
  assert.equal(iconIdOf(' 甲 '), null, '两端空白应被 trim 后再判定');

  // ③ 其余 → i-chicken
  assert.equal(iconIdOf(''), 'i-chicken', '空串兜底');
  assert.equal(iconIdOf('   '), 'i-chicken', '纯空白兜底');
  assert.equal(iconIdOf(null), 'i-chicken');
  assert.equal(iconIdOf(undefined), 'i-chicken');
  assert.equal(iconIdOf('abc'), 'i-chicken', '长度 > 2 兜底');
  assert.equal(iconIdOf('🐔🐔'), 'i-chicken', 'emoji 永不画出去');
  assert.equal(iconIdOf('\u231A\uFE0E'), 'i-chicken', 'Emoji_Presentation 字符兜底');
});

// ─────────────────────────────────────────────────────────────
// 断言 6 —— icons.js 的降级链行为（真的执行 resolveSymbol，不抄逻辑）

test('icons.js：内部名直取原符号；未知长串走 iconIdOf 兜成鸡头；emoji 不进 DOM', async () => {
  const restore = installDomStub();
  try {
    const mod = await importWithLoader('theme/js/icons.js', 'nostub');
    assert.equal(typeof mod.iconEl, 'function');
    assert.equal(typeof mod.iconPath, 'function');
    assert.equal(typeof mod.drawIcon, 'function');

    const hrefOf = (name) => {
      const svg = mod.iconEl(name);
      const use = svg.children[0];
      assert.ok(use, `iconEl(${name}) 没产生 <use>`);
      return use.getAttribute('href');
    };

    // 内部名 ①：走「i-」前缀直取，命中即为符号名 —— 这一步不走 iconIdOf，
    // 所以 'sound-off' 不会退化成 i-chicken（DOM 桩里 getElementById 返回 null，
    // 说明 knownSymbols 未命中时会落到 iconIdOf，这里断言它最终仍是 i-chicken
    // 的**唯一正确含义**：桩里没有 sprite，属于「sprite 还没挂上」的降级路径）。
    assert.equal(hrefOf('chicken'), '#i-chicken');
    assert.equal(hrefOf('logo'), '#i-logo');
    assert.equal(hrefOf('甲'), '#i-chicken', 'DOM 侧无文字位，null 必须兜成 i-chicken 而不是 "#null"');
    assert.equal(hrefOf('🐔'), '#i-chicken');
    assert.equal(hrefOf(''), '#i-chicken');

    // 绝不产生 "#null" 或 "#undefined"
    for (const bad of ['甲', '🐔', '', null, undefined, 'cat', 'unknown-name']) {
      const href = hrefOf(bad);
      assert.doesNotMatch(href, /#(null|undefined)/, `iconEl(${String(bad)}) 生成了 ${href}`);
    }
  } finally {
    restore();
  }
});

test('icons.js：真实 sprite 挂上后，内部符号名直取、未知名才走降级', async () => {
  const restore = installDomStub();
  const inlineIds = new Set(symbolIds(readFileSync(INDEX_HTML, 'utf8')));
  // 这次让桩「有 sprite」：模拟页面里 sprite 已经挂上的真实情境
  globalThis.document.getElementById = (id) =>
    (id === 'icon-sprite'
      ? { localName: 'svg' }
      : (inlineIds.has(id) ? { localName: 'symbol' } : null));

  try {
    const mod = await importWithLoader('theme/js/icons.js', 'withstub');
    const hrefOf = (name) => mod.iconEl(name).children[0].getAttribute('href');

    // 内部名必须直取到真符号，而不是被 iconIdOf 兜成鸡头
    assert.equal(hrefOf('sound-off'), '#i-sound-off', '静音图标退化成鸡头就是那个历史 bug');
    assert.equal(hrefOf('gear'), '#i-gear');
    assert.equal(hrefOf('i-dizzy'), '#i-dizzy');
    assert.equal(hrefOf('trophy'), '#i-trophy');
    // 协议名仍走 iconIdOf
    assert.equal(hrefOf('chicken'), '#i-chicken');
    assert.equal(hrefOf('甲'), '#i-chicken');
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────
// 断言 7 —— README 里写的符号数必须与实测一致（防两处漂移）

test('README 写的「N 个 <symbol>」与实测符号数一致', () => {
  const inline = readFileSync(INDEX_HTML, 'utf8');
  const count = symbolIds(inline).length;
  const readme = readFileSync(README, 'utf8');

  const m = readme.match(/(\d+)\s*个\s*[`'"]*<symbol>/);
  assert.ok(m, 'README 里找不到「N 个 <symbol>」的表述 —— 第七章的图标说明被改掉了？');
  assert.equal(
    Number(m[1]), count,
    `README 写「${m[1]} 个 <symbol>」，实际 ${count} 个 —— 两处已漂移`,
  );
});

// ─────────────────────────────────────────────────────────────
// 断言 8 —— theme/ 与 shared/ 不许出现会渲染的 emoji（README 第七章硬约束）

test('theme/ 与 shared/ 不存在可渲染的 emoji / 图形字形', () => {
  const offenders = [];
  for (const rel of EMOJI_FREE_DIRS) {
    for (const f of walk(path.join(ROOT, rel))) {
      if (EMOJI_FREE_SKIP.has(path.basename(f))) continue;
      const text = readFileSync(f, 'utf8');
      // 去掉注释后再扫：说明性注释是允许的（flags.js 例外已跳过）
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
      for (const m of stripped.matchAll(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu)) {
        const line = stripped.slice(0, m.index).split('\n').length;
        offenders.push(`${path.relative(ROOT, f)}:${line} 「${m[0]}」`);
      }
    }
  }
  assert.deepEqual(offenders, [], `theme/shared 出现可渲染 emoji：\n${offenders.join('\n')}`);
});
