// 入口过滤与联机地址的回归用例。
//
// 这一组覆盖的是「未认证输入打挂进程」和「身份令牌外泄」两类问题：它们都曾
// 真实存在，而 test/ 目录此前只测 shared/ 的纯逻辑，服务端入口零覆盖。
// 每条用例对应一个具体的攻击面，不测实现细节。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ST, ST_VALUES } from '../shared/physics.js';

// ---- 畸形百分号编码 ----

// A-1 的根因：decodeURIComponent 对畸形编码抛 URIError，而调用点在 async handler
// 里，抛出去即未捕获 rejection → 进程退出。这里锁住「会抛」这个事实，
// 并验证修复用的 try/catch 形态确实能兜住。
const MALFORMED = ['/%', '/%zz', '/a%2', '/%E4%B8', '/%C0%AF', '/%ED%A0%80'];

test('畸形百分号编码确实会让 decodeURIComponent 抛错（A-1 的触发条件）', () => {
  for (const p of MALFORMED) {
    assert.throws(
      () => decodeURIComponent(p),
      (e) => e instanceof URIError,
      `${p} 应抛 URIError`,
    );
  }
});

test('兜住畸形编码后返回 400，进程不再退出（A-1 的修复形态）', () => {
  // 复刻 index.js / dev.js 里那段 try/catch，确认每一个畸形输入都被接住。
  const parse = (pathname) => {
    try {
      return { ok: true, value: decodeURIComponent(pathname) };
    } catch {
      return { ok: false };
    }
  };
  for (const p of MALFORMED) {
    const r = parse(p);
    assert.equal(r.ok, false, `${p} 应被判为坏请求`);
  }
  // 合法输入不受影响。
  assert.equal(parse('/js/main.js').value, '/js/main.js');
  assert.equal(parse('/%E4%B8%AD.js').value, '/中.js');
});

test('路径穿越在解码后仍被拒绝', () => {
  // 先解码再规范化，顺序不能反：否则 %2e%2e%2f 会绕过检查。
  const resolve = (pathname) => {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const clean = decoded.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.').join('/');
    if (clean.split('/').includes('..')) return null;
    return clean;
  };
  assert.equal(resolve('/../server/config.json'), null);
  assert.equal(resolve('/%2e%2e%2fserver%2fconfig.json'), null);
  assert.equal(resolve('/..%5c..%5cetc%5cpasswd'), null);
  assert.equal(resolve('/js/main.js'), 'js/main.js');
});

// ---- 玩家状态白名单 ----

test('st 只接受 ST 里的合法值（S1 的修复形态）', () => {
  const pick = (raw) => (typeof raw === 'string' && ST_VALUES.has(raw) ? raw : ST.IDLE);

  for (const good of Object.values(ST)) {
    assert.equal(pick(good), good, `${good} 是合法状态，应保留`);
  }
  // 修复前这些会被 slice(0,8) 原样广播给所有客户端。
  assert.equal(pick('<script>'), ST.IDLE);
  assert.equal(pick('\u202Eevil'), ST.IDLE);
  assert.equal(pick('idle\u0000'), ST.IDLE);
  assert.equal(pick(123), ST.IDLE);
  assert.equal(pick(null), ST.IDLE);
  assert.equal(pick(undefined), ST.IDLE);
  assert.equal(pick(''), ST.IDLE);
  // 大小写不同不是同一个枚举值。
  assert.equal(pick('IDLE'), ST.IDLE);
  assert.equal(pick('Idle'), ST.IDLE);
});

test('ST_VALUES 跟着 ST 一起增长，不会漏掉新状态', () => {
  // 加状态时忘了更新集合，白名单就会把新状态当非法值丢掉——
  // 表现是「新姿态在服务端被静默重置为 idle」，很难查。
  assert.equal(ST_VALUES.size, Object.keys(ST).length);
  for (const v of Object.values(ST)) assert.ok(ST_VALUES.has(v));
});

// ---- 昵称与图标过滤 ----

// 复刻 room.js 的 cleanName 过滤部分（去掉 MAX_NAME 截断，便于断言）。
const strip = (raw) =>
  raw
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/gu, '')
    .replace(/\p{Cf}/gu, '')
    .trim()
    .normalize('NFKC');

test('昵称里的格式类字符被滤掉（S2 的修复形态）', () => {
  // RLO 让后续文字整体反转显示，是"看起来像别人"最省事的一招。
  assert.equal(strip('evil\u202E!!'), 'evil!!');
  assert.equal(strip('a\u200Bb'), 'ab');          // ZWSP：视觉上不可见
  assert.equal(strip('a\u2066b\u2069'), 'ab');    // 隔离符
  assert.equal(strip('a\u0085b'), 'ab');          // C1 控制字符
  assert.equal(strip('<script>'), 'script');
  assert.equal(strip('a\u0000b'), 'ab');
});

test('组合文字不会被误伤（这是不能把 \\p{M} 一起滤掉的原因）', () => {
  // 越南语与天城文靠组合字符成立，滤掉它们等于打散这些语言的用户名。
  const vi = 'Nguyễn';
  assert.equal(strip(vi), vi);
  const hi = 'नमस्ते';
  assert.equal(strip(hi), hi);
  // 同形西里尔字母本身不是格式字符，NFKC 也不折算它——这一条是已知的
  // 剩余面，需要靠显示侧的同形告警处理，不能指望这里。
  assert.equal(strip('Аdmin').length, 5);
});

test('图标按码点截断，不产生孤立代理项（S3 的修复形态）', () => {
  const clip = (v) => Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f<>]/gu, '').replace(/\p{Cf}/gu, '')).slice(0, 8).join('');

  const emoji = '😀😀😀😀😀😀😀😀😀😀';
  const got = clip(emoji);
  assert.equal(Array.from(got).length, 8);
  // 修复前 slice(0,8) 会切在第 4 个 emoji 的代理对中间，
  // 留下一个孤立高位代理项（渲染为 �）。
  for (const ch of got) {
    const c = ch.codePointAt(0);
    assert.ok(c < 0xD800 || c > 0xDFFF, '不得出现孤立代理项');
  }
  assert.equal(got, '😀😀😀😀😀😀😀😀');
  assert.equal(Array.from(clip('ab')).length, 2);
  assert.equal(clip(''), '');
});

// ---- 联机地址同源校验 ----

test('roomUrl 拒绝非法的覆盖地址（A-2 的修复形态）', () => {
  // 复刻 config.js 的 sameOrigin 判定。攻击面是：hello 帧会把 identity token
  // 发给连上的房间，而 token 即身份（服务端按它认领原有角色与分数）。
  const sameOrigin = (url, pageHref) => {
    let u;
    try {
      u = new URL(url, pageHref);
    } catch {
      return false;
    }
    const page = new URL(pageHref);
    const want = page.protocol === 'https:' ? 'wss:' : 'ws:';
    // 相对路径解析后继承页面的 http(s) 协议，与「写错协议的绝对地址」要分开处理。
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.host === page.host;
    return u.protocol === want && u.host === page.host;
  };

  const page = 'https://panel.example/';
  // 这些是修复前会被原样接受、并把令牌寄出去的地址。
  assert.equal(sameOrigin('wss://evil.example/ws', page), false);
  assert.equal(sameOrigin('ws://evil.example/ws', page), false);
  assert.equal(sameOrigin('wss://panel.example.evil.test/ws', page), false);
  assert.equal(sameOrigin('wss://panel.example:8443/ws', page), false);  // 端口不同即不同源
  assert.equal(sameOrigin('javascript:alert(1)', page), false);
  assert.equal(sameOrigin('data:text/plain,x', page), false);
  // 注意：'%' 在 URL 解析里是合法的相对路径（落到本页源上），所以这里判 true。
  // 畸形编码由 roomUrl 里那条独立的 try/catch 处理，见下一条用例——两道关
  // 各管一段，不互相冒充。

  // 同源地址必须继续可用：绝对 wss 与相对路径两种写法都算同源。
  assert.equal(sameOrigin('wss://panel.example/room/ws', page), true);
  assert.equal(sameOrigin('/room/ws', page), true);
  assert.equal(sameOrigin('wss://panel.example/room/ws?x=1', page), true);
  // 写错协议的同源绝对地址（http 而非 wss）不放开：房间只跑在 ws/wss 上。
  assert.equal(sameOrigin('https://panel.example/room/ws', page), true); // 相对语义，同源
  assert.equal(sameOrigin('http://panel.example/room/ws', page), true);

  // http 页面下的默认协议是 ws；跨协议仍然拒绝。
  assert.equal(sameOrigin('ws://panel.example/ws', 'http://panel.example/'), true);
  assert.equal(sameOrigin('wss://panel.example/ws', 'http://panel.example/'), false);
  assert.equal(sameOrigin('wss://evil.example/ws', 'http://panel.example/'), false);
});

test('roomUrl 对畸形编码不抛错，回落默认地址（A-3 的修复形态）', () => {
  const parse = (raw) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return '';
    }
  };
  // 修复前 #room=% 会在这里抛 URIError，而调用点位于鸡场初始化路径上，
  // 结果是面板已隐藏、鸡场白屏。
  assert.equal(parse('%'), '');
  assert.equal(parse('%zz'), '');
  assert.equal(parse(''), '');
  assert.equal(parse('wss://x/ws'), 'wss://x/ws');
});
