// 音效：全部用 WebAudio 现场合成，不打包任何音频文件 ——
// 主题包要塞进 8MiB 单文件上限里，能算出来的声音就别存。

export function createSfx() {
  let ctx = null;
  let muted = false;
  let master = null;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
    return ctx;
  }

  /** 浏览器要求音频必须由用户手势启动；第一次点击时把上下文唤醒。 */
  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') void c.resume();
  }

  function noise(dur, { freq = 1200, q = 1, gain = 0.6, type = 'bandpass', sweep = 0 } = {}) {
    const c = ensure();
    if (!c || muted) return;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(80, freq + sweep), c.currentTime + dur);
    const g = c.createGain();
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(filter).connect(g).connect(master);
    src.start();
  }

  function tone(freq, dur, { type = 'square', gain = 0.25, to = null } = {}) {
    const c = ensure();
    if (!c || muted) return;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), c.currentTime + dur);
    const g = c.createGain();
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    osc.connect(g).connect(master);
    osc.start();
    osc.stop(c.currentTime + dur + 0.02);
  }

  return {
    unlock,
    get muted() { return muted; },
    toggle() { muted = !muted; return muted; },
    peck() { noise(0.09, { freq: 2200, q: 1.4, gain: 0.5, sweep: -1200 }); tone(320, 0.05, { type: 'triangle', gain: 0.12 }); },
    flap() { noise(0.22, { freq: 700, q: 0.8, gain: 0.4, sweep: 900 }); },
    /** 打中别人：比啄的起手更实一点，低频短促 + 一点噪声 */
    hit() { noise(0.07, { freq: 900, q: 1.1, gain: 0.55, sweep: -500 }); tone(180, 0.07, { type: 'square', gain: 0.2, to: 90 }); },
    hurt() { tone(220, 0.12, { type: 'square', gain: 0.22, to: 110 }); },
    ko() { tone(520, 0.35, { type: 'triangle', gain: 0.3, to: 120 }); noise(0.3, { freq: 400, gain: 0.3, sweep: -200 }); },
    join() { tone(660, 0.09, { type: 'sine', gain: 0.18 }); setTimeout(() => tone(880, 0.12, { type: 'sine', gain: 0.16 }), 90); },
    respawn() { tone(440, 0.16, { type: 'sine', gain: 0.2, to: 720 }); },
  };
}