// 打包主题：把 theme/ 组装成 hub 要的 dist/ 布局，并出一个 theme.tar.gz。
//
// hub 的硬规矩（从 monitor hub 的 frontend.rs 读出来的）：
//   包内必须有 dist/index.html 与 theme.json；theme.json 里 short 只能 ASCII 字母数字 - _；
//   单文件 ≤ 8MiB、解压后 ≤ 64MiB、上传 ≤ 32MiB；同名重装是整体替换（旧 assets 会消失）。
//
//   node tools/build-theme.mjs            # 出到 build/
//   node tools/build-theme.mjs --no-tar   # 只组 dist，方便本地起服务看

import { mkdir, rm, cp, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const THEME = join(ROOT, 'theme');
const OUT = join(ROOT, 'build');
const DIST = join(OUT, 'dist');
const STAGE = join(OUT, 'stage');
const THREE_BUILD = join(ROOT, 'node_modules', 'three', 'build');

const MAX_FILE = 8 * 1024 * 1024;
const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_UPLOAD = 32 * 1024 * 1024;

const noTar = process.argv.includes('--no-tar');

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push({ full, rel: relative(base, full).replace(/\\/g, '/'), size: (await stat(full)).size });
  }
  return out;
}

const manifest = JSON.parse(await readFile(join(THEME, 'theme.json'), 'utf8'));
if (!/^[A-Za-z0-9_-]+$/.test(manifest.short)) throw new Error(`theme.json 的 short 不合法：${manifest.short}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

// dist 的布局就是 hub 站点根目录的布局：/js、/shared、/vendor、/style.css、/index.html
await cp(join(THEME, 'index.html'), join(DIST, 'index.html'));
await cp(join(THEME, 'style.css'), join(DIST, 'style.css'));
await cp(join(THEME, 'theme.json'), join(DIST, 'theme.json'));
await cp(join(THEME, 'js'), join(DIST, 'js'), { recursive: true });
await cp(join(ROOT, 'shared'), join(DIST, 'shared'), { recursive: true });
await mkdir(join(DIST, 'vendor'), { recursive: true });
// three 从 node_modules 复制：仓库里不存 1.2MB 的第三方库副本
await cp(join(THREE_BUILD, 'three.module.js'), join(DIST, 'vendor', 'three.module.js'));
// three.module.js 依赖 three.core.js（three 的模块化拆分），漏了会导致浏览器动态 import 失败、鸡场进不去
await cp(join(THREE_BUILD, 'three.core.js'), join(DIST, 'vendor', 'three.core.js'));

const files = await walk(DIST);
const unpacked = files.reduce((s, f) => s + f.size, 0);
const biggest = files.reduce((a, b) => (a.size > b.size ? a : b));

console.log(`📦 dist 组装完成：${files.length} 个文件，解压 ${(unpacked / 1024 / 1024).toFixed(2)} MiB`);
console.log(`   最大文件 ${biggest.rel} ${(biggest.size / 1024 / 1024).toFixed(2)} MiB`);

const problems = [];
if (biggest.size > MAX_FILE) problems.push(`单文件超 8MiB：${biggest.rel}`);
if (unpacked > MAX_UNPACKED) problems.push(`解压后超 64MiB`);
if (!files.some(f => f.rel === 'index.html')) problems.push('缺 dist/index.html');
if (!files.some(f => f.rel === 'theme.json')) problems.push('缺 theme.json');
if (!files.some(f => f.rel === 'vendor/three.module.js')) problems.push('缺 vendor/three.module.js');
if (!files.some(f => f.rel === 'vendor/three.core.js')) problems.push('缺 vendor/three.core.js（three.module.js 的依赖，漏了鸡场进不去）');
if (!files.some(f => f.rel === 'shared/physics.js')) problems.push('缺 shared/physics.js（客户端按根路径引用它）');
for (const f of files) {
  if (/\s/.test(f.rel)) problems.push(`文件名含空格，hub 的静态服务要按 URL 编码处理：${f.rel}`);
}
if (problems.length) {
  console.error('\n❌ 不合规：\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('✅ hub 包规矩校验通过（体积、入口、必需文件、路径）');

if (!noTar) {
  // 包的根目录就是「一个可安装的主题目录」：dist/ + theme.json 平铺在根上。
  // hub 的 publish() 直接读 staging/theme.json 与 staging/dist/index.html，
  // 多套一层 <short>/ 会让它认不出来。
  await cp(DIST, join(STAGE, 'dist'), { recursive: true });
  await cp(join(THEME, 'theme.json'), join(STAGE, 'theme.json'));
  // cwd 放在 stage、只用相对路径：Windows 的 GNU tar 见到 E:\... 里的冒号会
  // 把路径当成 host:path，报「Cannot connect to E」；用 --force-local 又不被 macOS 的 bsdtar 认
  // 连输出路径也用相对写法：参数里只要出现 "E:\..." 这种带冒号的绝对路径，
  // Windows 的 GNU tar 就会把它当成 host:path，报「Cannot connect to E」
  execFileSync('tar', ['-czf', '../theme.tar.gz', 'dist', 'theme.json'], { stdio: 'inherit', cwd: STAGE });
  const tarball = join(OUT, 'theme.tar.gz');
  const size = (await stat(tarball)).size;
  if (size > MAX_UPLOAD) { console.error(`❌ 包超过 32MiB：${(size / 1024 / 1024).toFixed(2)} MiB`); process.exit(1); }
  console.log(`✅ ${relative(ROOT, tarball)}  ${(size / 1024).toFixed(0)} KiB —— 传到 hub 面板「主题 → 上传」即可`);
}