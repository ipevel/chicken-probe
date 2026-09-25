import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 主题里用到的浏览器全局：如果哪个模块 import 了一个同名的绑定，就会把它们遮蔽掉。
// 面板里就踩过：`import { history } from './history.js'` 遮蔽了 window.history，
// 于是 writeUrl() 里的 history.replaceState 抛 TypeError，表现为「点关闭没反应」——
// 关不掉是因为它在抛错处中断了，错误还很容易被当成"按钮没绑上"。
const GLOBALS = ['history', 'location', 'document', 'window', 'fetch', 'performance', 'navigator', 'localStorage', 'sessionStorage', 'console'];

const files = (await readdir('theme/js')).filter((f) => f.endsWith('.js'));

test('theme 的模块不许 import 浏览器全局的同名绑定', async () => {
  const bad = [];
  for (const f of files) {
    const src = await readFile(join('theme/js', f), 'utf8');
    // 只看 import 语句里的具名绑定：import { a, b as c } from '…'
    for (const m of src.matchAll(/import\s*(?:\*\s*as\s*(\w+)|\{([^}]*)\})\s*from/g)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
      for (const n of names) {
        if (GLOBALS.includes(n)) bad.push(`${f}: import ${n}`);
      }
    }
  }
  assert.deepEqual(bad, [], `这些 import 会遮蔽浏览器全局，改用别名：\n  ${bad.join('\n  ')}`);
});

test('共享模块也不许遮蔽（shared/ 同样会被浏览器加载）', async () => {
  const shared = (await readdir('shared')).filter((f) => f.endsWith('.js'));
  const bad = [];
  for (const f of shared) {
    const src = await readFile(join('shared', f), 'utf8');
    for (const m of src.matchAll(/import\s*(?:\*\s*as\s*(\w+)|\{([^}]*)\})\s*from/g)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
      for (const n of names) if (GLOBALS.includes(n)) bad.push(`${f}: import ${n}`);
    }
  }
  assert.deepEqual(bad, []);
});