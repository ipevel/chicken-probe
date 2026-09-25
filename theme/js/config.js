// 主题里的几处地址与开关。改这里就够了，不用翻代码。
//
// 联机服务与探针主控跑在同一台机器上（见 README「联机服务」），由那台机器上的
// 反向代理把 /room/ 转到联机服务的端口，所以这里默认就是同域的 /room/ws。
// 三个覆盖途径，优先级从高到低：
//   1. 地址栏 #room=wss://other-host/ws      （临时试别的服务，刷新即失效）
//   2. localStorage['chicken-probe:room']    （本机长期改，控制台里设置）
//   3. 本文件的 ROOM_PATH                    （改源码，随主题一起发布）
export const ROOM_PATH = '/room/ws';

/** 解析出联机服务地址；返回空串表示「不联机」（鸡场只画自己，不装假人）。 */
export function roomUrl() {
  const hash = /[#&]room=([^&]+)/.exec(location.hash);   // 允许 #farm&room=... 这样写
  const saved = localStorage.getItem('chicken-probe:room');
  const raw = decodeURIComponent(hash?.[1] || saved || '');
  if (raw) return raw;
  if (!ROOM_PATH) return '';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${ROOM_PATH}`;
}

/** 玩家状态上报频率（次/秒）。20 与服务端的快照同频，再高只是白耗流量。 */
export const REPORT_HZ = 20;