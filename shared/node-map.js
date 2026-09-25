// 节点 → 鸡 的映射。纯函数 + 只依赖 node.id，这一点是联机能省掉一整套同步的原因：
// 每台机器在所有人屏幕上都是同一只鸡、站在同一个位置、同一个毛色，不需要服务端广播节点。
// 位置只由 id 决定，所以节点增删也不会让别的鸡乱跑。
//
//   位置：黄金角螺旋，id 顺序自然铺开、不叠在一起；
//   毛色/体型：id 哈希，同一台机器永远是同一只鸡；
//   姿态：探针状态（离线倒地、未接入趴睡、告警冒汗、陈旧半透明）。

import { CONF, OBSTACLES, ST, WORLD_HALF } from './physics.js';
import { statusOf, staleFor, expiringIn, monthUsage, quotaOver, ATTENTION } from './derive.js';

const GOLDEN = 2.399963229728653;   // 黄金角，螺旋靠它把点铺得最匀
const BASE_R = 3.4;
const RING_CAP = 96;                // 超过这么多台就按取模复用环位，再用哈希错开

/** FNV-1a：字符串 → 32 位无符号整数，纯函数、跨端一致。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const unit = (seed) => (seed >>> 8) / 0x1000000;   // 取中间位当 [0,1) 随机数

/**
 * 同一台机器永远是同一只鸡：体型与羽色都由 id 哈希决定。
 * 羽色只给**调色板编号**（0~4），真正的颜色在 chicken.js 里 —— 参考站就是 5 套克制的
 * 羽色（白羽/黄褐/乌骨/油鸡金/麻鸡），随机色相会出来一堆粉紫鸡，一眼就不像。
 */
export function appearance(node) {
  const h = hash32(`app:${node.id}`);
  const scale = 0.9 + unit(hash32(`size:${node.id}`)) * 0.35;
  const palette = h % 5;
  return { palette, comb: 0xc93434, scale };
}

/** 站哪儿：只由 id 决定，与列表里有哪些机器无关。 */
export function spotFor(node) {
  const k = ((Number(node.id) || 0) - 1) % RING_CAP;
  let r = BASE_R + 2.05 * Math.sqrt(k);
  let a = k * GOLDEN;
  // 哈希再抖一点，避免取模复用的两台机器站成同一点
  const jitter = unit(hash32(`ang:${node.id}`)) * 0.35;
  a += jitter;
  r += unit(hash32(`rad:${node.id}`)) * 0.8;
  let x = Math.cos(a) * r;
  let z = Math.sin(a) * r;

  // 别站进鸡舍/草垛/树里：从盒子中心往外推到盒子外（确定性，两端算出来一样）
  for (const o of OBSTACLES) {
    if (o.type === 'fence') continue;              // 围栏就是边界，后面统一按边界处理
    const halfW = o.w / 2 + CONF.radius + 0.35;
    const halfD = o.d / 2 + CONF.radius + 0.35;
    if (Math.abs(x - o.x) < halfW && Math.abs(z - o.z) < halfD) {
      if (halfW - Math.abs(x - o.x) < halfD - Math.abs(z - o.z)) x = o.x + Math.sign(x - o.x || 1) * halfW;
      else z = o.z + Math.sign(z - o.z || 1) * halfD;
    }
  }
  // 别越过场地边界
  const lim = WORLD_HALF - 2.5;
  const rr = Math.hypot(x, z);
  if (rr > lim) { x = x / rr * lim; z = z / rr * lim; }

  // 朝向场地中心，鸡群看起来像围着院子
  const yaw = Math.atan2(-x, -z);
  return { x, z, yaw };
}

/**
 * 姿态：面板上的状态判定结果，在鸡场上要变成一眼能看懂的动作。
 * 这里是「一处判定、两处呈现」的连接点 —— 鸡的姿态与卡片色条读的是同一个 statusOf。
 */
export function poseOf(node, now = Math.floor(Date.now() / 1000)) {
  const st = statusOf(node, now);
  switch (st) {
    case 'unconnected': return { state: ST.SLEEP, tone: 'muted', label: '未接入' };
    case 'offline': return { state: ST.DEAD, tone: 'danger', label: '离线' };
    case 'stale': return { state: ST.IDLE, tone: 'muted', label: `陈旧 ${staleFor(node, now)}s` };
    case 'unreadable': return { state: ST.IDLE, tone: 'danger', label: '数据不可读' };
    case 'quota': return { state: ST.IDLE, tone: 'warn', label: '流量超限' };
    case ST.ALERT: return { state: ST.ALERT, tone: 'danger', label: '告警' };
    case 'expiring': return { state: ST.IDLE, tone: 'warn', label: `${expiringIn(node, now)} 天到期` };
    default: return { state: ST.IDLE, tone: 'ok', label: '正常' };
  }
}

/** 一个节点在这帧里该长成什么样：鸡场渲染只吃这个结果。 */
export function chickenFor(node, now = Math.floor(Date.now() / 1000)) {
  const spot = spotFor(node);
  const look = appearance(node);
  const pose = poseOf(node, now);
  const m = node.metrics;
  return {
    id: node.id,
    kind: 'node',
    name: node.name,
    flag: node.country,
    x: spot.x, z: spot.z, yaw: spot.yaw,
    scale: look.scale,
    colors: { body: look.body, comb: look.comb },
    state: pose.state,
    tone: pose.tone,
    label: pose.label,
    cpu: m?.cpu ?? null,
    mem: m?.mem_total ? (m.mem_used / m.mem_total) * 100 : null,
    limit: node.traffic_limit || 0,
    used: monthUsage(node),
    attention: ATTENTION.includes(statusOf(node, now)),
  };
}

/** 全部节点鸡。排序按 id，保证各端渲染顺序一致（同一帧里不会有先后差异）。 */
export function chickenFlock(nodes, now = Math.floor(Date.now() / 1000)) {
  return [...nodes].sort((a, b) => a.id - b.id).map(n => chickenFor(n, now));
}

export { quotaOver };