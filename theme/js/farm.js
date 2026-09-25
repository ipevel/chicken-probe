// 鸡场：第三人称操控 + 联机 + HUD。
//
// 场上有什么鸡由联机服务说了算（探针鸡/网站鸡是服务端 NPC，真人由服务端转发），
// 这里负责：本地手感（自己对自己权威，立刻响应再上报）、远端 130ms 插值、以及
// 参考站那套 HUD（三行在线数、啄倒榜、事件流、倒地横幅、改名浮层、静音）。
//
// 操控与数值全部对齐参考站：走 2.8 / 疾跑 5.4、重力 16、啄击 110° 扇形、被啄有击退、
// 扇翅也是攻击、实体之间软分离、空格可连按 5~10 段空中扑腾。

import * as THREE from 'three';
import {
  CONF, ST, OBSTACLES, stepBody, turnToward, groundHeight,
} from '/shared/physics.js';
import { buildScene, buildWorld } from './world.js';
import { Chicken } from './chicken.js';
import { createNet } from './net.js';
import { createSfx } from './sfx.js';
import { createFeathers } from './feathers.js';
import { createTouchControls, isTouchDevice } from './touch.js';
import { appearance } from '/shared/node-map.js';
import { formatAge, formatBytesShort } from '/shared/derive.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 60;
const PEER_TIMEOUT_MS = 2500;
const FLASH_MS = 1600;

export function createFarm({ identity, onChangeIdentity, onExit } = {}) {
  let renderer, scene, camera, world, feathers, sfx, net, touch;
  let raf = 0, last = 0, acc = 0, mounted = false, compact = false, frameSeq = 0;
  let camReady = false;

  const body = { x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0 };
  let yaw = 0, peckT = 0, peckCd = 0, flapT = 0, flapCd = 0;
  let camYaw = 0.6, camPitch = 0.42, camDist = 5;
  let dragging = false, dragMoved = 0, locked = false;
  let hp = CONF.maxHp, score = 0, ko = false, koStartT = 0;
  let lastIntended = ST.IDLE;   // 本帧「想走成什么样」：上报给别人与选动画都用它
  let lastEvent = null;         // 最近一条联机事件（调试缝会读它）
  let shake = 0;                // 受击时的镜头抖动余量
  let stats = { probeOnline: 0, webOnline: 0 };
  let myId = null;

  const keys = new Set();
  const peers = new Map();     // 真人 id -> {chicken, seenAt, name, plateKey}
  const npcs = new Map();      // NPC id -> {chicken, meta, plateKey}
  const board = new Map();     // 榜单：id -> {id, name, icon, score, me, off}
  let me = null;
  const camGoal = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const identityRef = { ...identity };

  // ---------------- 相机 ----------------
  function resize() {
    if (!renderer) return;
    compact = Math.min(innerWidth, innerHeight) < 720 || innerWidth < 820;
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(compact ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2));
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    camDist = Math.max(compact ? 3.2 : 2.4, Math.min(compact ? 11 : 9, camDist));
  }

  function updateCamera(dt) {
    camPitch = Math.max(0.06, Math.min(1.25, camPitch));
    camDist = Math.max(compact ? 3.2 : 2.4, Math.min(compact ? 11 : 9, camDist));
    // 相机挂在玩家身后：镜头看向的方向就是「前」，WASD 与触摸摇杆都相对它算
    camTarget.lerp(_t.set(body.x, body.y + 0.9, body.z), Math.min(1, dt * 14));
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    camGoal.set(
      camTarget.x + Math.sin(camYaw) * cp * camDist,
      camTarget.y + sp * camDist,
      camTarget.z + Math.cos(camYaw) * cp * camDist,
    );
    if (camGoal.y < 0.35) camGoal.y = 0.35;
    // 第一帧直接就位：从原点 lerp 过去会看到一段「镜头冲过来」的推镜
    if (camReady) camera.position.lerp(camGoal, Math.min(1, dt * 14));
    else { camera.position.copy(camGoal); camReady = true; }
    // 受击抖动：只抖相机、不动玩家坐标 —— 抖动不该影响我报给别人的位置
    if (shake > 0.001) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      camera.position.z += (Math.random() - 0.5) * shake;
      shake *= Math.exp(-7 * dt);
    } else {
      shake = 0;
    }
    camera.lookAt(camTarget);
  }
  const _t = new THREE.Vector3();

  // ---------------- 输入 ----------------
  function bindInput() {
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      sfx.unlock();
      // 拖动转视角**始终可用**；指针锁定只是「不想一直按着鼠标」的加分项。
      // 早先这里锁上就 return，一旦锁定失败（按过 Esc 后浏览器会短暂拒绝再锁、
      // 无头/受限环境也常直接失败），dragging 没置上 → 视角完全转不了。
      dragging = true; dragMoved = 0;
      el.setPointerCapture?.(e.pointerId);
      if (e.pointerType === 'mouse' && !locked && !isTouchDevice()) el.requestPointerLock?.();
    });
    el.addEventListener('pointermove', (e) => {
      // 锁定时不必按住也能转；未锁定时要按着拖
      if (!locked && !dragging) return;
      camYaw -= e.movementX * 0.0026;
      camPitch += e.movementY * 0.0026;
      if (!locked) dragMoved += Math.abs(e.movementX) + Math.abs(e.movementY);
    });
    el.addEventListener('pointerup', (e) => {
      const wasClick = dragMoved < 5;
      dragging = false;
      el.releasePointerCapture?.(e.pointerId);
      // 没锁指针时：按住拖动转视角，抬起时位移很小才算一次啄
      if (!locked && wasClick && e.button === 0) peck();
    });
    // 锁定失败不要影响任何别的东西（浏览器会在这里报错，我们只是转不了「免按住」模式）
    document.addEventListener('pointerlockerror', () => { locked = false; });
    // 右键始终是扇翅
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); flap(); });
    el.addEventListener('wheel', (e) => {
      camDist *= 1 + e.deltaY * 0.001;
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      locked = document.pointerLockElement === el;
      if (locked) dragging = false;   // 锁定后由 movementX 驱动，不必再按着
    });
    addEventListener('keydown', onKeyDown);
    addEventListener('keyup', onKeyUp);
    addEventListener('blur', () => keys.clear());
    addEventListener('resize', resize);
  }

  function onKeyDown(e) {
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'Space') e.preventDefault();
    if (e.code === 'KeyM') flash(sfx.toggle() ? '🔇 已静音' : '🔊 声音开启', 900);
    if (e.code === 'Escape' && !document.querySelector('.drawer:not(.closed)') && !locked) onExit?.();
    if (e.code === 'KeyE') peck();
    if (e.code === 'KeyF') flap();
  }
  function onKeyUp(e) { keys.delete(e.code); }

  // ---------------- 动作 ----------------
  function peck() {
    if (ko || peckCd > 0) return;
    peckCd = CONF.peckCooldown;
    peckT = CONF.peckAnim;
    sfx.peck();
    net?.peck();
  }

  function flap() {
    if (ko || flapCd > 0) return;
    flapCd = CONF.wingCooldown;
    flapT = CONF.wingAnim;
    sfx.flap();
    net?.flap();
  }

  /** 触屏的「跳」是点按：合成一次短促的空格（扑腾连跳靠连点）。 */
  function jump() {
    keys.add('Space');
    setTimeout(() => keys.delete('Space'), 90);
  }

  // ---------------- HUD ----------------
  function renderMe() {
    $('me-name').textContent = `${identityRef.icon} ${identityRef.name}`;
    const fill = $('hpfill');
    fill.style.width = `${Math.max(0, (hp / CONF.maxHp) * 100)}%`;
    fill.classList.toggle('low', hp <= 30);
    const left = ko ? Math.max(0, CONF.koTime - (performance.now() - koStartT) / 1000) : 0;
    $('score').textContent = left > 0
      ? `😵 被啄晕了，${Math.ceil(left)} 秒后满血复活…`
      : `🏆 啄倒 ${score} 只鸡`;
  }

  function renderTop() {
    $('online').textContent = String(stats.probeOnline);
    $('web-online').textContent = String(stats.webOnline);
    $('visitors').textContent = String([...board.values()].filter(r => !r.off).length);
  }

  function renderBoard() {
    const rows = [...board.values()].sort((a, b) => b.score - a.score).slice(0, 20);
    const box = $('board-rows');
    box.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'row' + (r.me ? ' me' : '') + (r.off ? ' off' : '');
      const name = document.createElement('span');
      // 名字来自别的玩家，一律 textContent —— 绝不拼 HTML
      name.textContent = `${r.icon || '🐔'} ${r.name}${r.me ? '（你）' : ''}`;
      const sc = document.createElement('b');
      sc.textContent = String(r.score);
      row.append(name, sc);
      box.append(row);
    }
  }

  let flashTimer = null, deadUntil = 0;
  function flash(text, ms = FLASH_MS) {
    const el = $('ko-banner');
    // 倒地提示优先接管：它比「已静音」这类瞬时报重要
    if (performance.now() < deadUntil && ms < 2000) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function flashDead(text, ms) {
    deadUntil = performance.now() + ms;
    flash(text, ms);
  }

  /** 命中飘字：给「打中了」一个明确反馈，位置贴在屏幕中心偏上，不做 3D 投影。 */
  function popDamage(container, amount) {
    const pos = container?.chicken?.root?.position;
    if (!pos) return;
    const el = document.createElement('div');
    el.className = 'dmg-pop';
    el.textContent = `-${amount}`;
    // 目标在屏幕上的大概位置：用相机投影算一次，比自己编坐标靠谱
    const v = new THREE.Vector3(pos.x, pos.y + 1.2, pos.z).project(camera);
    el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    document.body.append(el);
    setTimeout(() => el.remove(), 700);
  }

  function feed(text) {
    const box = $('feed');
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.textContent = text;
    box.append(item);
    while (box.childElementCount > 4) box.firstElementChild.remove();
    setTimeout(() => item.remove(), 4500);
  }

  function renderRoomState(state, detail) {
    const el = $('room-state');
    const label = { live: '联机', connecting: '连接中', reconnecting: '重连中', off: '未联机', idle: '未联机' }[state] || state;
    el.textContent = detail && state === 'reconnecting' ? `${label} · ${detail}` : label;
    el.className = `conn ${state}`;
    if (state === 'reconnecting') flash('🔗 连接断开，正在重连…', 5000);
    if (state === 'live' && hadDrop) { flash('🐔 欢迎回来，战绩已恢复！', 2200); hadDrop = false; }
    if (state === 'reconnecting') hadDrop = true;
  }
  let hadDrop = false;

  // ---------------- 身份 ----------------
  function cleanName(raw) {
    // 与服务端 room.js 的 cleanName 同规则：<> 也滤，本地预览才和全场看到的名字一致
    const s = String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    let out = '';
    for (const ch of s) {
      if (new TextEncoder().encode(out + ch).length > 24) break;
      out += ch;
    }
    return out;
  }

  function bindIdentityUi() {
    const editor = $('me-name-editor');
    $('me-edit').onclick = () => {
      const hidden = editor.classList.toggle('hidden');
      if (!hidden) {
        $('me-name-input').value = identityRef.name;
        $('me-name-input').focus();
        $('me-name-input').select?.();
      }
    };
    const commit = () => {
      const name = cleanName($('me-name-input').value);
      if (name) identityRef.name = name;
      try { localStorage.setItem('chicken-probe:me', JSON.stringify(identityRef)); } catch {}
      editor.classList.add('hidden');
      renderMe();
      onChangeIdentity?.(identityRef);
      net?.rename(identityRef.name, identityRef.icon);
    };
    $('me-name-ok').onclick = commit;
    $('me-name-input').onkeydown = (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') editor.classList.add('hidden');
    };
    $('board').onclick = () => {
      const collapsed = $('board').classList.toggle('collapsed');
      $('board-title').textContent = collapsed
        ? '🐔 啄倒榜'
        : '🐔 啄倒榜（高占用触发主动攻击 · 点击收起）';
    };
  }

  // ---------------- 鸡的增删 ----------------
  function ensurePeer(id, meta) {
    let p = peers.get(id);
    if (!p) {
      // 别人的羽色也按 id 定：各端看到的同一只鸡颜色一致
      const look = appearance({ id });
      const chicken = new Chicken({ kind: 'player', scale: 1, colors: { body: look.palette, comb: look.comb } });
      scene.add(chicken.root);
      p = { chicken, seenAt: performance.now(), name: meta?.name, icon: meta?.icon, plateKey: '' };
      peers.set(id, p);
    }
    p.seenAt = performance.now();
    if (meta) { p.name = meta.name; p.icon = meta.icon; }
    return p;
  }

  function npcPlate(meta) {
    const title = `${meta.kind === 'web' ? '网站鸡' : '探针鸡'}·${meta.name}`;
    let sub;
    if (meta.kind === 'web') {
      if (meta.offline) sub = meta.reason ? `网站离线 ${meta.reason}` : '网站在线';
      else if (meta.latency == null) sub = '检测网站中…';
      else sub = `网站在线 ${meta.latency}ms`;
    } else if (meta.offline) {
      sub = meta.state === ST.SLEEP ? '未接入探针' : '离线';
    } else {
      const bits = [];
      // 服务端的异常标签（逃跑中 / 流量超限 / 告警…）优先显示，正常时不给噪音
      if (meta.label && meta.label !== '正常') bits.push(meta.label);
      if (meta.up != null) bits.push(`在线 ${formatAge(meta.up)}`);
      if (meta.netOut != null) bits.push(`↑${formatBytesShort(meta.netOut)} ↓${formatBytesShort(meta.netIn)}`);
      sub = bits.join(' · ');
    }
    return {
      title, sub, flag: meta.country,
      // 服务端广播的 hp/maxHp：探针鸡被啄之后血条要真的掉下去
      hp: meta.maxHp ? Math.max(0, Math.min(1, meta.hp / meta.maxHp)) : (meta.ko ? 0 : 1),
      cpu: meta.cpu, mem: meta.mem,
      offline: meta.offline,
      gauges: meta.kind === 'probe' && !meta.offline,
    };
  }

  function ensureNpc(id, meta) {
    let n = npcs.get(id);
    if (!n) {
      const chicken = new Chicken({
        kind: meta.kind === 'web' ? 'web' : 'probe',
        scale: meta.scale,
        colors: { body: meta.palette, comb: meta.comb },
      });
      scene.add(chicken.root);
      n = { chicken, meta, plateKey: '' };
      npcs.set(id, n);
    }
    n.meta = meta;
    const plate = npcPlate(meta);
    n.chicken.setState(meta.state, meta.tone);
    n.chicken.setPlate(plate);
    return n;
  }

  function dropGonePeers(now) {
    for (const [id, p] of peers) {
      if (now - p.seenAt > PEER_TIMEOUT_MS) { p.chicken.dispose(scene); peers.delete(id); }
    }
  }

  // ---------------- 主循环 ----------------
  /** 姿态优先级：倒地 > 啄 > 扇翅 > 空中 > 走/站。传入的是 ST.* 字符串，不是布尔值。 */
  function myState(intended) {
    if (ko) return ST.DEAD;
    if (peckT > 0) return ST.PECK;
    if (flapT > 0) return ST.FLAP;
    if (body.y > groundHeight(body.x, body.z) + 0.02) return ST.AIR;
    return intended === ST.RUN ? ST.RUN : intended === ST.WALK ? ST.WALK : ST.IDLE;
  }

  function simulate(dt) {
    peckCd = Math.max(0, peckCd - dt);
    peckT = Math.max(0, peckT - dt);
    flapCd = Math.max(0, flapCd - dt);
    flapT = Math.max(0, flapT - dt);

    let fwd = 0, str = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) fwd += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) fwd -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) str += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) str -= 1;
    if (touch) { fwd += touch.move.y; str += touch.move.x; }

    // 输入换算到世界方向：右向量 = cross(forward, up) = (cos, -sin)。
    // 写成 (-cos, +sin) 就是左右镜像 —— 这是最容易写错的一行。
    const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
    const rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
    const mx = fx * fwd + rx * str;
    const mz = fz * fwd + rz * str;

    const run = keys.has('ShiftLeft') || keys.has('ShiftRight') || (touch?.move.run ?? false);
    const dead = ko;
    const wantX = dead ? 0 : mx, wantZ = dead ? 0 : mz;
    stepBody(body, {
      mx: wantX,
      mz: wantZ,
      run,
      jump: !dead && keys.has('Space'),
      pid: myId ? hashId(myId) : 1,
    }, OBSTACLES, dt);

    // 朝向与状态都看「想走的方向」：走路是运动学的（x += mx*speed*dt），
    // kx/kz 只是击退冲量，走路时恒为 0 —— 用它算朝向会让鸡一直倒着走，
    // 用它算状态会让站着的鸡永远停在 walk 状态（腿一直在摆，看着就是发抖）
    const wanting = Math.hypot(wantX, wantZ) > 1e-4;
    if (wanting) yaw = turnToward(yaw, Math.atan2(wantX, wantZ), dt);
    lastIntended = wanting ? (run ? ST.RUN : ST.WALK) : ST.IDLE;
    // 和别的真人互相挤开：只推自己 —— 别人的位置以服务端快照为准，本地不去改
    const minD = CONF.radius * 2;
    for (const [id, p] of peers) {
      if (id === (net?.id ?? myId)) continue;   // 自己的残影不是别人，绝不能拿它推自己
      const dx = body.x - p.chicken.root.position.x, dz = body.z - p.chicken.root.position.z;
      const d = Math.hypot(dx, dz);
      if (d >= minD || d < 1e-6) continue;
      const imp = (minD - d) * CONF.separation * dt;
      body.x += (dx / d) * imp;
      body.z += (dz / d) * imp;
    }
    return lastIntended;
  }
  const hashId = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!mounted) return;
    frameSeq++;
    const dtRaw = (now - last) / 1000;
    last = now;
    if (document.hidden) return;   // 后台标签页不跑物理：回来时不该瞬移一大步
    const dt = Math.min(0.05, dtRaw);
    acc += dt;
    let guard = 0;
    let moving = ST.IDLE;
    while (acc >= STEP && guard++ < 5) { moving = simulate(STEP); acc -= STEP; }

    if (touch) {
      const k = touch.takeLook();
      camYaw -= k.x * 0.005;
      camPitch += k.y * 0.004;
    }

    if (me) {
      const st = myState(moving);
      me.setTransform(body.x, body.y, body.z, yaw);
      me.setState(st, ko ? 'danger' : 'ok');
      me.setPlate({ title: `${identityRef.icon} ${identityRef.name}`, hp: hp / CONF.maxHp });
      me.update(dt, st === ST.WALK || st === ST.RUN);
    }

    // 远端真人：画出来的位置总比现在晚一点，网络抖一下也不会一跳一跳
    const sampled = net?.samplePlayers() || new Map();
    const selfId = net?.id ?? myId;   // 用联机层认到的 id，别依赖本地那副本
    for (const [id, s] of sampled) {
      if (id === selfId) continue;    // 自己的位置由本地物理说了算，不画也不推
      const p = ensurePeer(id, net?.roster.get(id));
      p.chicken.setTransform(s.x, s.y ?? 0, s.z, s.yaw);
      p.chicken.setState(s.st || ST.IDLE, s.st === ST.DEAD ? 'danger' : 'ok');
      p.chicken.setPlate({ title: `${p.icon || '🐔'} ${p.name || '访客'}`, hp: (s.hp ?? 100) / CONF.maxHp });
      p.chicken.update(dt, s.st === ST.WALK || s.st === ST.RUN);
    }
    dropGonePeers(now);

    const nSample = net?.sampleNpcs() || new Map();
    for (const [id, s] of nSample) {
      const meta = net?.npcInfo.get(id);
      if (!meta) continue;
      const n = ensureNpc(id, meta);
      n.chicken.setTransform(s.x, groundHeight(s.x, s.z), s.z, s.yaw);
      // 动作按**实际采样速度**选，不能永远传 false —— 否则跑步中的鸡腿不动，像在滑行。
      // 服务端给的 st 只负责特殊姿态（倒地/趴睡/告警），移动姿态由这里根据位移判。
      const prev = n.lastPos;
      const moved = prev ? Math.hypot(s.x - prev[0], s.z - prev[1]) / Math.max(1e-3, dt) : 0;
      n.lastPos = [s.x, s.z];
      n.shownSpeed = moved;
      const special = s.st === ST.DEAD || s.st === ST.SLEEP || s.st === ST.ALERT || s.st === ST.PECK;
      const speedNow = moved > 0.4 ? (moved > CONF.walkSpeed * 1.15 ? ST.RUN : ST.WALK) : ST.IDLE;
      n.chicken.setState(special ? s.st : speedNow, meta.tone);
      n.chicken.update(dt, speedNow === ST.WALK || speedNow === ST.RUN);
    }
    for (const [id, n] of npcs) {
      if (!nSample.has(id)) { n.chicken.dispose(scene); npcs.delete(id); }
    }

    feathers.update(dt);
    updateCamera(dt);
    renderer.render(scene, camera);
  }

  // ---------------- 联机事件 ----------------
  function bindNet() {
    net = createNet({
      identity: identityRef,
      onStatus: renderRoomState,
      onRoster: (list, probe, left) => {
        stats = probe;
        for (const p of list) {
          board.set(p.id, { id: p.id, name: p.name, icon: p.icon, score: p.score, me: p.id === myId, off: false });
        }
        // 离场的人留在榜上但灰显（参考站的规矩：分数归零的就不留了）
        for (const id of left) {
          const row = board.get(id);
          if (row) { row.off = true; if (row.score <= 0) board.delete(id); }
          const p = peers.get(id);
          if (p) { p.chicken.dispose(scene); peers.delete(id); }
        }
        renderTop();
        renderBoard();
        const mine = list.find(p => p.id === myId);
        if (mine) {
          hp = mine.hp;
          score = mine.score;
          if (mine.ko && !ko) { ko = true; koStartT = performance.now(); }
          if (!mine.ko) ko = false;
          renderMe();
        }
      },
      onEvent: onNetEvent,
      onWelcome: (m) => {
        myId = m.id;
        // 首帧快照可能先于 welcome 到达，那时「我」已经被当成别人建过鸡了 —— 拆掉它
        const ghost = peers.get(m.id);
        if (ghost) { ghost.chicken.dispose(scene); peers.delete(m.id); }
        renderTop();
        renderBoard();
      },
    });
    net.setReporter(() => ({
      x: body.x, y: body.y, z: body.z, yaw,
      st: myState(lastIntended),
    }));
    net.start();
  }

  /** 被啄/被扇翅：把服务端给的击退方向加到自己身上 —— 位置以我自己为准，服务端不硬拽。 */
  function applyKnock(knock) {
    if (!Array.isArray(knock)) return;
    body.kx += knock[0] || 0;
    body.kz += knock[1] || 0;
  }

  /** 受击镜头抖动：按指数衰减，幅度很小但能立刻感到「打实了」。 */
  function kick(amount) { shake = Math.max(shake, amount); }

  function burstAt(container, count, color) {
    const pos = container?.root?.position;
    if (pos) feathers.burst(pos.x, pos.y + 0.7, pos.z, color, count);
  }

  function onNetEvent(m) {
    lastEvent = m;
    switch (m.k) {
      case 'join':
        if (m.id !== myId) feed(`${m.name} 进场了`);
        sfx.join();
        break;
      case 'left':
        feed(`${m.name} 走了`);
        break;
      case 'peck':
      case 'wing': {
        const mine = m.to === myId;
        if (mine) {
          hp = m.hp;
          applyKnock(m.knock);
          renderMe();
          sfx.hurt();
          kick(0.16);
          flash(`${m.npc ? `${m.fName}（节点鸡）` : m.fName} ${m.k === 'wing' ? '扇了你一翅膀' : '啄了你一口'}`, 900);
        } else if (m.f === myId) {
          const target = peers.get(m.to);
          target?.chicken.flash();
          burstAt(target, 8, '#ffffff');
          sfx.hit();
          kick(0.1);
          popDamage(target, m.k === 'wing' ? CONF.wingDamage : CONF.peckDamage);
          feed(`你${m.k === 'wing' ? '扇' : '啄'}了 ${m.toName} 一口`);
        } else {
          // 别人打别人：只让看得到的那只闪一下，不做镜头反馈
          peers.get(m.to)?.chicken.flash();
        }
        break;
      }
      case 'npck': {
        const target = npcs.get(m.to);
        // 啄到节点鸡：红闪 + 羽毛 + 镜头轻抖 —— 打中了得有反馈
        target?.chicken.flash();
        if (m.f === myId) {
          burstAt(target, m.knocked ? 16 : 8, '#e6e6da');
          sfx.hit();
          kick(m.knocked ? 0.22 : 0.12);
          popDamage(target, CONF.peckDamage);
          if (m.knocked) feed(`💥 你把「${m.toName}」啄倒了`);
        }
        break;
      }
      case 'ko':
        if (m.to === myId) {
          ko = true;
          koStartT = performance.now();
          sfx.ko();
          flashDead('😵 你被啄晕了！', CONF.koTime * 1000);
          renderMe();
        } else if (m.f === myId) {
          flash(`你啄倒了 ${m.toName}`);
          feed(`你 🐔💥 啄倒了 ${m.toName}`);
        } else {
          feed(`${m.fName} 🐔💥 啄倒了 ${m.toName}`);
        }
        break;
      case 'respawn':
        ko = false;
        body.x = m.x; body.z = m.z; body.y = groundHeight(m.x, m.z); body.vy = 0;
        body.kx = 0; body.kz = 0;
        sfx.respawn();
        flash('🐔 站了起来', 1200);
        renderMe();
        break;
      case 'respawned':
        if (m.id === myId) { ko = false; renderMe(); }
        break;
      case 'replaced':
        feed('这个身份已在别处登录，已换一个新身份');
        break;
      case 'renamed':
        identityRef.name = m.name;
        identityRef.icon = m.icon;
        renderMe();
        break;
      default:
        break;
    }
  }

  // ---------------- 对外 ----------------
  return {
    mount() {
      if (mounted) return;
      compact = Math.min(innerWidth, innerHeight) < 720 || innerWidth < 820;
      if (compact) camDist = 6.4;
      camPitch = compact ? 0.58 : 0.42;

      renderer = new THREE.WebGLRenderer({ antialias: !compact, powerPreference: 'high-performance' });
      renderer.setPixelRatio(compact ? Math.min(devicePixelRatio, 1.5) : Math.min(devicePixelRatio, 2));
      renderer.setSize(innerWidth, innerHeight);
      $('app').replaceChildren(renderer.domElement);

      const built = buildScene(renderer, { lowPower: compact });
      scene = built.scene; camera = built.camera;
      world = buildWorld(scene, { lowPower: compact });
      feathers = createFeathers(scene);
      sfx = createSfx();

      me = new Chicken({ kind: 'player', scale: 1, colors: { body: 0, comb: 0xc93434 } });
      me.setTransform(0, groundHeight(0, 0), 0, 0);
      scene.add(me.root);

      renderMe();
      renderTop();
      renderBoard();

      bindInput();
      bindIdentityUi();
      if (isTouchDevice()) {
        document.body.classList.add('touch');
        touch = createTouchControls($('touch-ui'), { onPeck: peck, onFlap: flap, onJump: jump });
      }
      bindNet();

      // 调试缝：只有带 ?dbg 打开才暴露（tools/drift-probe.mjs 靠它量漂移）。
      // 常态页面不留全局对象 —— 这是给别人装的主题，不该在 window 上挂东西
      if (location.search.includes('dbg=1')) window.__farmDebug = () => ({
        camera: camera.position.toArray().map(v => +v.toFixed(2)),
        body: { x: +body.x.toFixed(3), z: +body.z.toFixed(3), kx: +body.kx.toFixed(3), kz: +body.kz.toFixed(3) },
        yaw: +yaw.toFixed(3), camYaw: +camYaw.toFixed(3),
        frames: frameSeq,
        locked, dragging,
        camYaw: +camYaw.toFixed(4), camPitch: +camPitch.toFixed(4), camDist: +camDist.toFixed(2),
        lastEvent: lastEvent ? { k: lastEvent.k, to: lastEvent.to, npc: !!lastEvent.npc, knock: lastEvent.knock } : null,
        meState: me ? me.state : null,
        meYaw: me ? +me.root.rotation.y.toFixed(4) : null,
        meTilt: me ? +me.root.rotation.z.toFixed(4) : null,
        mePos: me ? me.root.position.toArray().map(v => +v.toFixed(3)) : null,
        // 鸡身（第一个子节点）的局部位置：闲逛抖动、告警发抖都写在这里
        meBody: me && me.root.children[0] ? me.root.children[0].position.toArray().map(v => +v.toFixed(4)) : null,
        myId: myId, netId: net ? net.id : null,
        peers: [...peers.keys()],
        npcs: [...npcs.values()].map(n => ({
          id: n.meta.id,
          pos: n.chicken.root.position.toArray().map(v => +v.toFixed(2)),
          label: n.meta.label,
          hp: n.meta.hp ?? null,
          maxHp: n.meta.maxHp ?? null,
          state: n.chicken.state,
          speed: +(n.shownSpeed ?? 0).toFixed(2),
          // 名牌缓存签名里含「真正画上去的血量」，读它比读 meta 更能证明渲染那条链路通了
          plateSig: n.chicken.plateSig,
        })),
      });
      mounted = true;
      camReady = false;
      last = performance.now();
      acc = 0;
      raf = requestAnimationFrame(frame);
      renderRoomState('connecting');
    },

    unmount() {
      mounted = false;
      cancelAnimationFrame(raf);
      clearTimeout(flashTimer);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('resize', resize);
      document.body.classList.remove('touch');
      net?.stop(); net = null;
      for (const p of peers.values()) p.chicken.dispose(scene);
      peers.clear();
      for (const n of npcs.values()) n.chicken.dispose(scene);
      npcs.clear();
      feathers?.dispose();
      if (me) { me.dispose(scene); me = null; }
      if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); }
      $('app').replaceChildren();
      $('feed').replaceChildren();
      $('board-rows').replaceChildren();
      $('ko-banner').classList.remove('show');
      board.clear();
      renderer = null; scene = null;
    },
  };
}