// 主题里的几处地址与开关。改这里就够了，不用翻代码。
//
// 联机服务与探针主控跑在同一台机器上（见 README「联机服务」），由那台机器上的
// 反向代理把 /room/ 转到联机服务的端口，所以这里默认就是同域的 /room/ws。
// 三个覆盖途径，优先级从高到低：
//   1. 地址栏 #room=wss://other-host/ws      （临时试别的服务，刷新即失效）
//   2. localStorage['chicken-probe:room']    （本机长期改，控制台里设置）
//   3. 本文件的 ROOM_PATH                    （改源码，随主题一起发布）
export const ROOM_PATH = '/room/ws';

/** 解析出联机服务地址；返回空串表示「不联机」（鸡场只画自己，不装假人）。
 *
 * 覆盖地址必须与页面同源。这不是洁癖：hello 帧会把 sessionStorage 里的身份令牌
 * 发给连上的那个房间，而令牌即身份（服务端按令牌认领原有角色、分数与位置）。
 * 一个 #room=wss://evil.example/ws 的链接就能把访问者的令牌寄出去，对方拿到后
 * hello 一次即可顶号。同源校验把这条路彻底堵死，代价只是不能跨域联机——
 * 而联机服务本来就由同一台机器的反代挂在 /room/ 下（见 README）。
 */
export function roomUrl() {
  const hash = /[#&]room=([^&]+)/.exec(location.hash);   // 允许 #farm&room=... 这样写
  const saved = localStorage.getItem('chicken-probe:room');
  // 畸形编码（#room=%）会让 decodeURIComponent 抛错，而这里在鸡场初始化路径上：
  // 抛出去就是白屏。解不出来就当没设置，回落默认地址。
  let raw = '';
  try {
    raw = decodeURIComponent(hash?.[1] || saved || '');
  } catch {
    raw = '';
  }
  if (raw && sameOrigin(raw)) return raw;
  if (!ROOM_PATH) return '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${ROOM_PATH}`;
}

/**
 * 这个地址是不是本页的同源。
 *
 * 接受两种写法：
 *   1. 同源的 ws:/wss: 绝对地址（host 含端口必须与 location.host 一致）；
 *   2. 相对路径（/room/ws）——它本来就只能落在本页源上，按同源算。
 * 其余一律拒绝：跨源 ws/wss、http(s)、以及 javascript:/data: 这类根本不是房间地址的
 * 协议。放过去只会把错误推给 WebSocket 构造函数，而 A-2 的代价是令牌外泄。
 */
function sameOrigin(url) {
  let u;
  try {
    u = new URL(url, location.href);
  } catch {
    return false;
  }
  const want = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // 相对路径经 URL 解析后会继承页面的 https:/http: 协议，所以要把它与
  // 「写错了协议的绝对地址」区分开：前者按同源接受，后者拒绝。
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.host === location.host;
  return u.protocol === want && u.host === location.host;
}

/** 玩家状态上报频率（次/秒）。20 与服务端的快照同频，再高只是白耗流量。 */
export const REPORT_HZ = 20;