// 共享物理与玩法数值。客户端本地预测、服务端 NPC 模拟、单测三处共用同一份。
//
// 这一版照参考站（chicken.ggboom.de）的数值逐条对齐：走速、重力、起跳、啄击扇形、
// 击退、软分离、以及 5~10 段的空中扑腾连跳。自己拍数值手感会完全不同 —— 上一版
// 就是「速度偏快、重力偏大、啄击扇形太窄、扇翅只是个动画、被啄不会后退」。
//
// CONF.peckArc 是**整个扇形的张角**（弧度），判定时取一半比较：参考站用的是约
// 110° 的宽扇形，不是 cos 阈值。

export const CONF = {
  walkSpeed: 2.8,        // 慢走 m/s
  runSpeed: 5.4,         // 疾跑 m/s
  gravity: 16,
  jumpVel: 6.2,          // 一段跳初速：满幅高度约 1.2m
  radius: 0.38,          // 鸡的碰撞半径
  peckRange: 1.7,        // 啄击中心距
  peckArc: 1.9,          // 啄击扇形张角（≈109°）
  peckCooldown: 0.5,
  peckDamage: 12,
  peckKnock: 4.5,        // 击退冲量：被啄会被推出去，而不是原地掉血
  wingRange: 1.35,       // 扇翅范围更短，但无方向限制 —— 它也是攻击
  wingCooldown: 0.8,
  wingDamage: 8,
  wingKnock: 6.5,
  wingAnim: 0.45,
  maxHp: 100,
  koTime: 3.0,           // 被啄晕到起身
  peckAnim: 0.35,
  separation: 30,        // 实体间软分离：重叠能挤过去，但不会卡死
  SNAP_HZ: 20,
  RENDER_DELAY: 130,     // 远端插值缓冲，抗抖动的核心参数
};

export const WORLD_HALF = 26;

// 跳跃链：一段跳 = 全幅高度；二段以后是空中扑腾 —— 离地超过「下沿」时按，
// 固定回升 0.25m（被天花板封住，绝不超越一段跳顶点）。段数上限 5~10，按
// 「玩家 id + 本局第几次起跳」哈希决定，同样的输入两端必然算出同一个值。
export const JUMP_CHAIN_MIN = 5;
export const JUMP_CHAIN_MAX = 10;
export const JUMP_CHAIN_CEILING = (CONF.jumpVel * CONF.jumpVel) / (2 * CONF.gravity);
export const JUMP_CHAIN_FLOOR = JUMP_CHAIN_CEILING * 0.5;   // 贴地不扑腾，防抽搐
export const JUMP_CHAIN_HOP = 0.25;
export const JUMP_BUFFER = 0.15;   // 落地前按的跳补在触地那一帧，不会「按了没反应」

// 状态：客户端与服务端都用字符串，JSON 直传、日志可读
export const ST = {
  IDLE: 'idle',
  WALK: 'walk',
  RUN: 'run',
  AIR: 'air',
  PECK: 'peck',
  FLAP: 'flap',
  DEAD: 'dead',
  SLEEP: 'sleep',   // 未接入节点的鸡：趴着睡
  ALERT: 'alert',   // 指标超阈：膨起来发抖
};

// 小山坡：高斯包络。服务端与客户端共用同一个高度场，否则鸡会浮在半空或陷进土里
export const HILL = { x: 14, z: 13, h: 2.4, sigma2: 30 };

export function groundHeight(x, z) {
  const dx = x - HILL.x, dz = z - HILL.z;
  return HILL.h * Math.exp(-(dx * dx + dz * dz) / HILL.sigma2);
}

/**
 * 静态障碍（轴对齐盒子）。客户端据此渲染场景，物理也据此推挤 ——
 * 渲染与碰撞读同一份数据，另写一份坐标迟早会让画出来的东西和撞到的东西对不上。
 */
export const OBSTACLES = (() => {
  const o = [];
  const box = (type, x, z, w, d, h) => o.push({ type, x, z, w, d, h });
  const t = 0.4;
  box('fence', 0, -WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', 0, WORLD_HALF, WORLD_HALF * 2 + t, t, 1.1);
  box('fence', -WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('fence', WORLD_HALF, 0, t, WORLD_HALF * 2 + t, 1.1);
  box('coop', -11, -9, 7, 5.5, 3.2);
  box('trough', 9, 11, 2.6, 0.9, 0.55);
  box('hay', 6, -12, 1.7, 1.7, 1.5);
  box('hay', -15, 10, 1.7, 1.7, 1.5);
  box('hay', 13, 3, 1.7, 1.7, 1.5);
  for (const [x, z] of [[16, 15], [-18, -15], [19, -7], [-6, 17], [-19, 4]]) {
    box('tree', x, z, 0.7, 0.7, 2.6);
  }
  box('rock', 1, 15, 1.6, 1.4, 0.9);
  box('rock', -8, -1, 1.2, 1.1, 0.7);
  box('rock', 11, -16, 1.8, 1.5, 1.0);
  return o;
})();

/** 圆（鸡）对轴对齐盒子的推出，迭代两轮处理角落。 */
export function resolveCircle(p, r, obs = OBSTACLES) {
  for (let iter = 0; iter < 2; iter++) {
    for (const o of obs) {
      const minX = o.x - o.w / 2, maxX = o.x + o.w / 2;
      const minZ = o.z - o.d / 2, maxZ = o.z + o.d / 2;
      const cx = Math.max(minX, Math.min(p.x, maxX));
      const cz = Math.max(minZ, Math.min(p.z, maxZ));
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), push = (r - d) / d;
        p.x += dx * push;
        p.z += dz * push;
      } else {
        // 圆心陷进盒子里：沿最浅的一边推出，别在原地抖
        const px = Math.min(p.x - minX, maxX - p.x);
        const pz = Math.min(p.z - minZ, maxZ - p.z);
        if (px < pz) p.x += (p.x >= (minX + maxX) / 2 ? px + r : -(px + r));
        else p.z += (p.z >= (minZ + maxZ) / 2 ? pz + r : -(pz + r));
      }
    }
  }
}

/**
 * 单个实体的一步模拟。
 * @param {object} b 身体 {x,y,z,vy,kx,kz}
 * @param {object} inp 输入 {mx,mz,run,jump,jumpPress,pid,speed,radius}
 *   mx/mz 是**世界空间**方向，由调用方按相机朝向换算好
 * @param {Array} obs 障碍表
 * @param {number} dt 步长（秒）
 */
export function stepBody(b, inp, obs, dt) {
  let mx = Number(inp.mx) || 0, mz = Number(inp.mz) || 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const speed = Number(inp.speed) || (inp.run ? CONF.runSpeed : CONF.walkSpeed);
  const r = Number(inp.radius) || CONF.radius;

  // 击退冲量按指数衰减：被啄之后会被推出去一段，然后自己站稳
  b.kx *= Math.exp(-6 * dt);
  b.kz *= Math.exp(-6 * dt);
  if (Math.abs(b.kx) < 0.02) b.kx = 0;
  if (Math.abs(b.kz) < 0.02) b.kz = 0;

  const g = groundHeight(b.x, b.z);
  // 先落到地面再谈跳：出生点在山坡上（y=0 而地面 0.14）时，若把钳制留到本步末尾，
  // 起跳给的 vy 会被同一步的落地判定清零 —— 站在坡上的鸡跳不起来
  if (b.y < g) { b.y = g; if (b.vy < 0) b.vy = 0; }
  const air = b.y - g;                       // 离地高度：扑腾下沿判定用
  const onGround = b.y <= g + 0.001;
  if (onGround) {
    b._jumps = 0;
    const pid = Number(inp.pid) || 0;
    const h = (pid * 2654435761 + (b._jumpSeq || 0) * 2246822519) >>> 0;
    b._chainMax = JUMP_CHAIN_MIN + (h % (JUMP_CHAIN_MAX - JUMP_CHAIN_MIN + 1));
    // 触地那一帧消费跳跃缓冲：落地前按的跳不会被浪费
    if ((b._jumpBufT || 0) > 0) {
      b.vy = CONF.jumpVel;
      b._jumps = 1;
      b._jumpSeq = (b._jumpSeq || 0) + 1;   // 补上的也是一次正式起跳，连跳上限要跟着走
      b._jumpBufT = 0;
    }
  }

  // 跳跃「按下」判定：电平边沿，或服务端锁存的一次性按下次号（jumpPress）——
  // 后者是为了 50ms 一拍的采样不至于把一次短按整个丢掉
  const pressed = !!inp.jumpPress || (!!inp.jump && !b._prevJump);
  if (inp.jumpPress) inp.jumpPress = false;
  b._prevJump = !!inp.jump;
  if (pressed) b._jumpBufT = JUMP_BUFFER;
  else if ((b._jumpBufT || 0) > 0) b._jumpBufT = Math.max(0, b._jumpBufT - dt);

  if (pressed && onGround) {
    b.vy = CONF.jumpVel;
    b._jumps = 1;
    b._jumpSeq = (b._jumpSeq || 0) + 1;
    b._jumpBufT = 0;
  } else if (!onGround && pressed && (b._jumps || 0) < (b._chainMax || JUMP_CHAIN_MAX)) {
    // 空中扑腾：固定回升一段（被天花板封顶），顶点处按也能看到一扑，
    // 不会像「按高度差回弹」那样消耗一段却纹丝不动
    const room = Math.max(0, JUMP_CHAIN_CEILING - air);
    const hop = Math.min(JUMP_CHAIN_HOP, room);
    if (air >= JUMP_CHAIN_FLOOR && hop > 0.01) {
      b.vy = Math.sqrt(2 * CONF.gravity * hop);
      b._jumps = (b._jumps || 0) + 1;
      b._jumpBufT = 0;
    }
  }

  b.vy -= CONF.gravity * dt;
  b.y += b.vy * dt;
  if (b.y < g) { b.y = g; if (b.vy < 0) b.vy = 0; }

  b.x += (mx * speed + b.kx) * dt;
  b.z += (mz * speed + b.kz) * dt;
  resolveCircle(b, r, obs);

  const lim = WORLD_HALF - r - 0.1;
  if (b.x > lim) b.x = lim; else if (b.x < -lim) b.x = -lim;
  if (b.z > lim) b.z = lim; else if (b.z < -lim) b.z = -lim;
}

/**
 * 实体之间的软分离：重叠时互相推开，冲量式 —— 能挤过去，但不会卡死。
 * 只喂真人（离线躺倒的 NPC 不该挡路）。
 */
export function separate(bodies, dt) {
  const minD = CONF.radius * 2;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.skip) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const c = bodies[j];
      if (c.skip) continue;
      const dx = c.x - a.x, dz = c.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= minD || d < 1e-6) continue;
      const nx = dx / d, nz = dz / d;
      const imp = (minD - d) * CONF.separation * dt;
      a.x -= nx * imp; a.z -= nz * imp;
      c.x += nx * imp; c.z += nz * imp;
    }
  }
}

/** 朝向按最短弧插值：直接 lerp 角度会在 ±π 处甩一圈。 */
export function turnToward(cur, target, dt, rate = 12) {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + d * Math.min(1, rate * dt);
}

/**
 * 啄击是否命中：够近、高度差不大、且在朝向扇形的**一半**张角内。
 * 服务端判玩家与 NPC 都用这一个函数，免得两边各写一套角度。
 * @param {{x:number,z:number,y?:number}} from 出嘴的位置
 * @param {number} yaw 朝向（0 = +z）
 * @param {{x:number,z:number,y?:number}} to 目标
 */
export function inPeckArc(from, yaw, to, range = CONF.peckRange) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d > range || d < 1e-6) return false;
  if (Math.abs((to.y ?? 0) - (from.y ?? 0)) > 1.6) return false;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return (dx * fx + dz * fz) / d >= Math.cos(CONF.peckArc / 2);
}