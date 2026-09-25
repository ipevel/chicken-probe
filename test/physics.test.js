import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONF, WORLD_HALF, OBSTACLES, ST, groundHeight, resolveCircle, stepBody, separate,
  turnToward, inPeckArc, JUMP_CHAIN_CEILING, JUMP_CHAIN_FLOOR,
} from '../shared/physics.js';

// 默认出生在场地正中：离围栏最远（WORLD_HALF=26），且不在山坡上 —— 位移类用例
// 若贴着围栏起步，跑 1.5 秒会被边界截断，看起来像"速度不对"
const mkBody = (over = {}) => ({ x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0, ...over });
// 空障碍表：位移/跳跃类用例不该被场地里的箱子干扰
const NONE = [];

function sim(b, inp, seconds, dt = 1 / 60, obs = NONE) {
  const evs = [];
  for (let i = 0, n = Math.round(seconds / dt); i < n; i++) evs.push(stepBody(b, inp, obs, dt));
  return evs;
}
const heightOf = (b) => b.y - groundHeight(b.x, b.z);   // 山坡上量绝对 y 会差出地面高度

test('重力：悬空的鸡落到地面高度', () => {
  const b = mkBody({ y: 6 });
  sim(b, {}, 2);
  assert.ok(Math.abs(b.y - groundHeight(b.x, b.z)) < 1e-6, `落点 ${b.y}`);
  assert.equal(b.vy, 0);
});

test('走：1.5 秒走出约 walkSpeed×1.5 米，疾跑按 runSpeed 算', () => {
  // kx/kz 只表示击退冲量，位移才是走路的结果 —— 所以量位移，不量 kx
  const w = mkBody();
  const x0 = w.x;
  sim(w, { mx: 1, mz: 0 }, 1.5);
  const walked = w.x - x0;
  assert.ok(Math.abs(walked - CONF.walkSpeed * 1.5) < 0.15, `走了 ${walked.toFixed(2)}m，理论 ${(CONF.walkSpeed * 1.5).toFixed(2)}m`);

  const r = mkBody();
  const rx0 = r.x;
  sim(r, { mx: 1, mz: 0, run: true }, 1.5);
  const ran = r.x - rx0;
  assert.ok(Math.abs(ran - CONF.runSpeed * 1.5) < 0.3, `跑了 ${ran.toFixed(2)}m，理论 ${(CONF.runSpeed * 1.5).toFixed(2)}m`);
});

test('输入方向会被归一化：斜着走不会比直着走快', () => {
  const a = mkBody(), b = mkBody();
  sim(a, { mx: 1, mz: 0 }, 1.2);
  sim(b, { mx: 1, mz: 1 }, 1.2);
  const da = Math.hypot(a.x, a.z);
  const db = Math.hypot(b.x, b.z);
  assert.ok(Math.abs(da - db) < 0.15, `直行 ${da.toFixed(2)}m vs 斜行 ${db.toFixed(2)}m`);
});

test('击退按指数衰减：被啄出去一段后自己站稳', () => {
  const b = mkBody({ kx: CONF.peckKnock });
  const x0 = b.x;
  sim(b, {}, 1.5);
  assert.equal(b.kx, 0, '冲量应衰减到 0');
  const pushed = b.x - x0;
  assert.ok(pushed > 0.4 && pushed < 1.6, `被推开 ${pushed.toFixed(2)}m`);
});

test('跳跃：一段跳是全幅高度（约 1.2m）', () => {
  const b = mkBody();
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    stepBody(b, { jump: i === 0 }, NONE, 1 / 60);
    peak = Math.max(peak, heightOf(b));
  }
  assert.ok(Math.abs(peak - JUMP_CHAIN_CEILING) < 0.1, `离地峰值 ${peak.toFixed(3)}，理论 ${JUMP_CHAIN_CEILING.toFixed(3)}`);
});

test('站在坡上的鸡也跳得起来（不会被同一步的落地钳制吃掉起跳速度）', () => {
  const b = mkBody({ x: 14, z: 13, y: 0 });          // 山顶：地面 2.4m，而它 y=0
  assert.ok(groundHeight(b.x, b.z) > 2, '用例本身要站在坡上');
  let peak = 0;
  for (let i = 0; i < 90; i++) {
    stepBody(b, { jump: i === 0 }, NONE, 1 / 60);
    peak = Math.max(peak, heightOf(b));
  }
  assert.ok(peak > 1.0, `坡上起跳离地峰值只有 ${peak.toFixed(3)}`);
});

test('跳跃缓冲：落地前按的跳会在触地那一刻补上，不会白按', () => {
  const b = mkBody({ y: 2, vy: 0 });
  // 一路自由落体，在离地不远时按一下跳；记录过程里的最大离地高度（2 秒后它早落地了）
  let pressed = false, peak = 0;
  for (let i = 0; i < 120; i++) {
    const low = heightOf(b) < 0.3 && b.vy < 0;
    const jump = low && !pressed;
    if (jump) pressed = true;
    stepBody(b, { jump }, NONE, 1 / 60);
    peak = Math.max(peak, heightOf(b));
  }
  assert.ok(pressed, '用例本身要能触发那次按下');
  assert.ok(b._jumpSeq >= 1, '缓冲应被消费成一次正式起跳');
  assert.ok(peak > 0.8, `补跳后应跳到接近全幅高度，实际离地峰值 ${peak.toFixed(3)}`);
});

test('空中扑腾：连按能回升，但绝不超越一段跳顶点，且段数有上限', () => {
  const b = mkBody();
  let peak = 0;
  for (let i = 0; i < 240; i++) {
    // 每 6 帧点一次，模拟连按
    const jump = i % 6 === 0;
    stepBody(b, { jump, pid: 7 }, NONE, 1 / 60);
    peak = Math.max(peak, heightOf(b));
  }
  assert.ok(peak <= JUMP_CHAIN_CEILING + 0.02, `离地峰值 ${peak.toFixed(3)} 不该超过一段跳顶点 ${JUMP_CHAIN_CEILING.toFixed(3)}`);
  assert.ok(b._jumps <= b._chainMax, `段数 ${b._jumps} 不该超过上限 ${b._chainMax}`);
  assert.ok(b._chainMax >= 5 && b._chainMax <= 10, `连跳上限应在 5~10，得到 ${b._chainMax}`);
});

test('贴地不扑腾：地面高度以下不给回升，防抽搐', () => {
  const b = mkBody();
  let lift = 0;
  for (let i = 0; i < 30; i++) {
    const before = b.vy;
    stepBody(b, { jump: true }, NONE, 1 / 60);
    if (heightOf(b) < JUMP_CHAIN_FLOOR && b.vy > before) lift++;
  }
  assert.ok(lift <= 1, `贴地期间不该反复回升，实际 ${lift} 次`);
});

test('障碍：朝鸡舍冲会被挡在外面（盒式碰撞）', () => {
  const coop = OBSTACLES.find(o => o.type === 'coop');
  const b = mkBody({ x: coop.x - 8, z: coop.z });
  sim(b, { mx: 1, mz: 0, run: true }, 3, 1 / 60, OBSTACLES);
  const insideX = Math.abs(b.x - coop.x) < coop.w / 2 + CONF.radius - 0.05;
  const insideZ = Math.abs(b.z - coop.z) < coop.d / 2 + CONF.radius - 0.05;
  assert.ok(!(insideX && insideZ), `不该进到鸡舍里：dx=${(b.x - coop.x).toFixed(2)} dz=${(b.z - coop.z).toFixed(2)}`);
});

test('障碍：圆心陷进盒子里也能沿最浅方向推出来', () => {
  const rock = OBSTACLES.find(o => o.type === 'rock');
  const p = { x: rock.x, z: rock.z };
  resolveCircle(p, CONF.radius, OBSTACLES);
  const outX = Math.abs(p.x - rock.x) >= rock.w / 2;
  const outZ = Math.abs(p.z - rock.z) >= rock.d / 2;
  assert.ok(outX || outZ, `应被推出盒子：${JSON.stringify(p)}`);
});

test('场地边界：冲出去会被挡在围栏内', () => {
  const b = mkBody({ x: WORLD_HALF - 3, z: 0 });
  sim(b, { mx: 1, mz: 0, run: true }, 4, 1 / 60, OBSTACLES);
  assert.ok(b.x <= WORLD_HALF - CONF.radius, `x=${b.x} 应被限制在场地内`);
});

test('软分离：两只叠在一起的鸡会被推开，且只推开到刚好不重叠', () => {
  const a = { x: 0, z: 0 }, c = { x: 0.1, z: 0 };
  for (let i = 0; i < 60; i++) separate([a, c], 1 / 60);
  const d = Math.hypot(c.x - a.x, c.z - a.z);
  assert.ok(d > CONF.radius * 2 - 0.02, `分开后距离 ${d.toFixed(3)} 应达到 ${(CONF.radius * 2).toFixed(2)}`);
  assert.ok(d < CONF.radius * 2 + 0.05, '不该被推得过远');
});

test('啄击判定：正对着命中，背后不行，太远不行，坡上坡下够不到', () => {
  const me = { x: 0, z: 0, y: 0 };
  assert.equal(inPeckArc(me, 0, { x: 0, z: 1.2 }), true, '正前方 1.2m 应该命中');
  assert.equal(inPeckArc(me, 0, { x: 0, z: -1.2 }), false, '背后不该命中');
  assert.equal(inPeckArc(me, 0, { x: 0, z: 3 }), false, '超出啄击距离');
  assert.equal(inPeckArc(me, 0, { x: 0, z: 1.2, y: 2.5 }), false, '高度差太大够不到');
  // 扇形张角约 109°：55° 侧向应该还在范围内（这是参考站的宽扇形，不是窄锥）
  const side = { x: Math.sin(0.9) * 1.2, z: Math.cos(0.9) * 1.2 };
  assert.equal(inPeckArc(me, 0, side), true, '约 50° 侧前方应命中');
  // 扇翅没有方向限制：背后的目标靠范围判定，这里只验啄击是有方向的
  assert.equal(inPeckArc(me, 0, { x: 0, z: 1.7 }), true, '边界距离应命中');
});

test('地形：山坡中心 2.4m，远处趋近 0', () => {
  assert.ok(Math.abs(groundHeight(14, 13) - 2.4) < 1e-9, '山顶');
  assert.ok(groundHeight(-20, -20) < 0.05, '远处接近平地');
});

test('转向：跨过 ±π 走短弧，不甩整圈', () => {
  const a = turnToward(3.0, -3.0, 1, 0.5);
  assert.ok(a > 3.0, `应正向逼近 π，得到 ${a}`);
});

test('状态常量齐全（服务端与客户端共用同一套字符串）', () => {
  for (const k of ['IDLE', 'WALK', 'RUN', 'AIR', 'PECK', 'FLAP', 'DEAD', 'SLEEP', 'ALERT']) {
    assert.equal(typeof ST[k], 'string');
  }
});