// 远端插值：把收到的快照按时间轴采样，渲染时永远落后一点点（默认 130ms）。
//
// 为什么不直接画最新一帧：网络抖动会让别人一卡一顿地跳。落后一个固定延迟，
// 就有两帧可以夹住当前时刻做线性插值，动作是连续的。这是纯函数，能单测。

export const DEFAULT_MAX = 24;   // 约 1 秒的 20Hz 快照

export function createBuffer(max = DEFAULT_MAX) {
  return { items: [], max };
}

/**
 * @param {{items:Array,max:number}} buf
 * @param {number} t 服务端时间戳（毫秒，比较用，不带绝对含义）
 * @param {Map<string, object>} map 这一帧里每个 id 的状态
 */
export function push(buf, t, map) {
  // 乱序到达的旧帧丢掉：插值的前提是时间单调
  const last = buf.items[buf.items.length - 1];
  if (last && t < last.t) return;
  buf.items.push({ t, map });
  while (buf.items.length > buf.max) buf.items.shift();
}

/** 遍历缓冲里出现过的所有 id（用于清理离场的人）。 */
export function ids(buf) {
  const set = new Set();
  for (const it of buf.items) for (const id of it.map.keys()) set.add(id);
  return set;
}

function lerp(a, b, k) { return a + (b - a) * k; }

/** 角度按最短弧插值：直接 lerp 会在 ±π 处甩一圈。 */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * 采样：找夹住 targetMs 的两帧插值。
 * 只有一帧（刚进来）就用它自己，超出现在就用最后一帧，早于最早就用第一帧 ——
 * 任何情况下都返回一个可画的状态，不返回 null 让调用方去处理边界。
 */
export function sample(buf, targetMs, id) {
  const items = buf.items;
  if (!items.length) return null;

  if (items.length === 1 || targetMs <= items[0].t) return clone(items[0].map.get(id));
  const last = items[items.length - 1];
  if (targetMs >= last.t) return clone(last.map.get(id));

  for (let i = items.length - 1; i > 0; i--) {
    const b = items[i], a = items[i - 1];
    if (targetMs >= a.t && targetMs <= b.t) {
      const A = a.map.get(id), B = b.map.get(id);
      if (!A) return clone(B);
      if (!B) return clone(A);
      const span = b.t - a.t;
      const k = span > 0 ? (targetMs - a.t) / span : 0;
      return {
        x: lerp(A.x, B.x, k),
        y: lerp(A.y ?? 0, B.y ?? 0, k),
        z: lerp(A.z, B.z, k),
        yaw: lerpAngle(A.yaw, B.yaw, k),
        // 状态与血量取新的那一帧：它们不是连续量，插值没有意义
        st: B.st, hp: B.hp ?? A.hp,
        name: B.name ?? A.name, icon: B.icon ?? A.icon,
      };
    }
  }
  return clone(last.map.get(id));
}

/** 缓冲里最新一帧的时间戳，用来算「现在该采样到哪个时刻」。 */
export function latestT(buf) {
  const last = buf.items[buf.items.length - 1];
  return last ? last.t : 0;
}

function clone(o) { return o ? { ...o } : null; }