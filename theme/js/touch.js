// 触屏操控：左摇杆移动（推到底疾跑）、拖屏幕转视角、轻点啄、右下三个按钮（啄/疾跑/跳）。
//
// DOM 契约由 style.css 的 .tc-* 规则固定：容器 pointer-events:none，只有控件自己吃手势，
// 落在空白处的拖动会穿透到画布变成「拖动转视角」—— 这正是想要的手感。

export function isTouchDevice() {
  return (navigator.maxTouchPoints || 0) > 0 && 'ontouchstart' in window;
}

export function createTouchControls(host, { onPeck, onFlap, onJump } = {}) {
  const move = { x: 0, y: 0, run: false };
  const look = { x: 0, y: 0 };
  let stickId = null, stickRect = null;
  let lookId = null, lookLast = null;
  let tap = null;
  let running = false;

  const stick = host.querySelector('.tc-stick');
  const knob = host.querySelector('.tc-stick-knob');
  const peckBtn = host.querySelector('.tc-btn-peck');
  const runBtn = host.querySelector('.tc-btn-run');
  const jumpBtn = host.querySelector('.tc-btn-jump');

  if (!stick || !knob || !peckBtn || !runBtn || !jumpBtn) {
    throw new Error('触屏控件节点缺失：检查 index.html 里的 .tc-stick / .tc-btn-* 是否被改动');
  }

  // ---- 摇杆 ----
  const R = () => stick.getBoundingClientRect().width * 0.42;   // 有效行程 ≈ 半径的 42%

  function knobTo(dx, dy) {
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  stick.addEventListener('pointerdown', (e) => {
    stickId = e.pointerId;
    stickRect = stick.getBoundingClientRect();
    stick.classList.add('active');
    stick.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId || !stickRect) return;
    const cx = stickRect.left + stickRect.width / 2;
    const cy = stickRect.top + stickRect.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const r = R();
    const d = Math.hypot(dx, dy);
    if (d > r) { dx = dx / d * r; dy = dy / d * r; }
    knobTo(dx, dy);
    move.x = dx / r;
    move.y = -dy / r;
    move.run = d > r * 0.88;      // 推到底算疾跑：省一个按钮，手指够用就好
  });
  const endStick = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null; stickRect = null;
    move.x = 0; move.y = 0; move.run = running;
    knobTo(0, 0);
    stick.classList.remove('active');
  };
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);

  // ---- 空白处拖动转视角 ----
  host.addEventListener('pointerdown', (e) => {
    if (e.target !== host) return;
    lookId = e.pointerId;
    lookLast = { x: e.clientX, y: e.clientY };
    tap = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  host.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId || !lookLast) return;
    look.x += e.clientX - lookLast.x;
    look.y += e.clientY - lookLast.y;
    lookLast = { x: e.clientX, y: e.clientY };
  });
  const endLook = (e) => {
    if (e.pointerId !== lookId) return;
    lookId = null; lookLast = null;
  };
  host.addEventListener('pointerup', endLook);
  host.addEventListener('pointercancel', endLook);

  // ---- 轻点 = 啄（拖动过就不算轻点） ----
  host.addEventListener('pointerup', (e) => {
    if (!tap || e.target !== host) { tap = null; return; }
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y);
    if (moved < 12 && performance.now() - tap.t < 300) onPeck?.();
    tap = null;
  });

  // ---- 按钮 ----
  const press = (btn, fn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('press');
      fn?.();
      setTimeout(() => btn.classList.remove('press'), 120);
    });
  };
  press(peckBtn, onPeck);
  press(jumpBtn, onJump);
  press(runBtn, () => {
    running = !running;
    runBtn.classList.toggle('on', running);
    move.run = running || move.run;
    if (!running && stickId == null) move.run = false;
  });

  return {
    move,
    get running() { return running; },
    /** 每帧取走视角增量并清零：增量语义，不取走会一直累积。 */
    takeLook() {
      const x = look.x, y = look.y;
      look.x = 0; look.y = 0;
      return { x, y };
    },
  };
}