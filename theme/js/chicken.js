// 程序化的鸡：全部用 Box / Cone 拼，不依赖任何模型或贴图文件 ——
// 主题包里塞不进 glb 资产管线，而且这样每只鸡的毛色、体型、名牌都能由节点 id 推出来。
//
// 这一版的尺寸、配色、动作是从参考站（chicken.ggboom.de）逐条抄的：躯干 0.5×0.42×0.62、
// 头组挂在 (0,0.16,0.28)、侧翻 1.45rad、名牌画布与字号、走/跑/啄/扇翅的相位与幅度。
// 自己拍一套比例也「是只鸡」，但一眼就看得出不是同一个场子里的鸡。

import * as THREE from 'three';
import { ST, CONF } from '/shared/physics.js';

const ORANGE = 0xd98a2b;          // 喙 / 脚，固定不随毛色变
const RED = 0xc93434;             // 冠 / 肉垂
const EYE = 0x1a1a1a;
const OFFLINE_TINT = new THREE.Color(0x6b6b6b);
const PLATE_LIFT = 1.3;           // 侧翻时名牌的抬升上限
const TILT_MAX = 1.45;            // 倒地的倾角
const BODY_Y = 0.42;              // bodyG 的站立高度
const PECK_DUR = 0.35;            // 一次啄的时长（与 CONF.peckAnim 同量级，但动作本身固定 0.35）

/** 5 套毛色，每套三档依次给 躯干 / 头 / 尾·翅。 */
const PALETTES = [
  [0xf5f0e6, 0xe8e0d0, 0xd8cfc0],   // 白羽
  [0xb5793a, 0xa3682c, 0x8a5522],   // 黄褐
  [0x3a3a3a, 0x2c2c2c, 0x1f1f1f],   // 乌骨
  [0xe0b34a, 0xd0a038, 0xb98a2c],   // 油鸡金
  [0x8a6a52, 0x7a5a44, 0x6a4a38],   // 麻鸡
].map((p) => p.map((h) => new THREE.Color(h)));

// 名牌的四套版式。数字全是参考站的实测值：画布尺寸、sprite 缩放与高度、
// 字号、血条的 x/宽/高。改这里等于改全场的观感，所以集中放一处。
const PLATES = {
  player: { w: 256, h: 76, sx: 1.5, sy: 0.45, y: 1.16, title: 21, sub: 13, barH: 9, barY: 60, titleY: 30, subY: 52, flagW: 30, flagH: 20 },
  probe: { w: 380, h: 170, sx: 2.9, sy: 1.3, y: 1.45, title: 22, sub: 14, barH: 7, barY: 140, titleY: 56, subY: 90, flagW: 34, flagH: 24 },
  web: { w: 280, h: 110, sx: 2.2, sy: 0.86, y: 1.3, title: 21, sub: 14, barH: 8, barY: 82, titleY: 38, subY: 62, flagW: 30, flagH: 20 },
};
const PLATE_OFFLINE = { w: 260, h: 76, sx: 2.0, sy: 0.58, y: 0.85, title: 22, sub: 13, barH: 9, barY: 60, titleY: 32, subY: 54, flagW: 30, flagH: 20 };

const NAME_FONT = (px) => `bold ${px}px "Microsoft YaHei","PingFang SC",sans-serif`;
const SUB_FONT = (px) => `${px}px "Microsoft YaHei","PingFang SC",sans-serif`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 自己解析颜色：derive 那边吐出来的是 CSS 空格写法 `hsl(210 34% 60%)`，
 * 而 three 的 setStyle 只认逗号写法（不认识的写法会 warning 之后保留原色），
 * 直接用会把整批机器的毛色悄悄退化成白色 —— 这里先把两种写法都吃下来。
 */
function parseColor(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? new THREE.Color(v) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  let m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i.exec(s);
  if (m) return new THREE.Color().setHSL(+m[1] / 360, +m[2] / 100, +m[3] / 100, THREE.SRGBColorSpace);
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return new THREE.Color(+m[1] / 255, +m[2] / 255, +m[3] / 255);
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return new THREE.Color(s);
  if (THREE.Color.NAMES && THREE.Color.NAMES[s.toLowerCase()]) return new THREE.Color(s);
  return null;
}

/** 一个颜色推三档：参考站的 5 套配色都是「同色相、明度递减」，单色进来也保持这个关系，头身才不会割裂。 */
function shadesFrom(color) {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, THREE.SRGBColorSpace);
  const at = (f) => new THREE.Color().setHSL(hsl.h, hsl.s, clamp01(hsl.l * f), THREE.SRGBColorSpace);
  return [color.clone(), at(0.93), at(0.855)];
}

let paletteCursor = 0;

/**
 * colors.body 有两种形态：数字索引（挑第几套配色）或任意 CSS 颜色（当第一档）。
 * 两者都推不出来时按顺序轮着发 —— 一排鸡各自不同色，比整场白鸡更像「一批机器」。
 */
function resolvePalette(colors = {}) {
  const src = colors && colors.body;
  if (typeof src === 'number' && Number.isFinite(src)) {
    return PALETTES[((Math.floor(src) % PALETTES.length) + PALETTES.length) % PALETTES.length];
  }
  const base = parseColor(src);
  if (base) return shadesFrom(base);
  return PALETTES[paletteCursor++ % PALETTES.length];
}

function resolveColor(v, fallbackHex) {
  return parseColor(v) || new THREE.Color(fallbackHex);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 名字超长时从尾部按两字一截地砍：一个字一砍会在中文里切出「探针鸡·东京 Or」这种半截英文。 */
function fitName(ctx, text, font, maxW) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 2 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -2);
  return s + '…';
}

/** 国旗不引外部图片：两位国家码就地画个圆角牌 + 两个大写字母。 */
function drawFlag(ctx, code, x, y, w, h) {
  roundRect(ctx, x, y, w, h, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
  ctx.font = 'bold 15px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(code.toUpperCase(), x + w / 2, y + h / 2 + 1);
}

/** 小圆环：环内不写字，颜色本身就是读数（绿=CPU，蓝=内存）。 */
function drawGauge(ctx, cx, cy, r, value, color) {
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const v = clamp01(Number(value) || 0);
  if (v <= 0) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 2);
  ctx.stroke();
}

export class Chicken {
  /**
   * @param {{colors?: {body?: string|number, comb?: string}, scale?: number, kind?: 'player'|'probe'|'web', label?: string}} opts
   */
  constructor({ colors = {}, scale = 1, kind = 'player', label = '' } = {}) {
    this.kind = PLATES[kind] ? kind : 'player';
    this.scale = scale;
    this.state = ST.IDLE;
    this.tone = 'ok';
    this.toneEmissive = 0;
    this.offline = false;
    this.actionT = 0;
    this.walkPhase = 0;
    this.clock = 0;
    this.tilt = 0;         // root 绕 z 的倾角（倒地/起身共用一条收敛曲线）
    this.crouch = 0;       // 沉身量：倒地 0.1，趴睡另算
    this.flashT = 0;
    this.idlePeckT = 0;
    this.idleWait = 2.5 + Math.random() * 4;
    this.plateSig = '';
    this.posY = 0;         // setTransform 给的基准高度，update 的贴地补偿叠在它上面而不是覆盖它
    this.phase = Math.random() * Math.PI * 2;   // 各只鸡的动作错开，否则一排鸡同步点头很假

    this.root = new THREE.Group();
    this.root.scale.setScalar(1.18 * scale);    // 整体系数照抄参考站

    // 材质必须每只鸡独立：离线压暗是在材质颜色上做插值，共享材质会把「离线」
    // 涂到全场每一只鸡身上；顺带给受击红闪留出可以单独改的自发光。
    const pal = resolvePalette(colors);
    const mk = (c) => new THREE.MeshLambertMaterial({ color: c.clone() });
    this.matBody = mk(pal[0]);
    this.matHead = mk(pal[1]);
    this.matDeep = mk(pal[2]);
    this.matComb = mk(resolveColor(colors.comb, RED));
    this.matOrange = mk(new THREE.Color(ORANGE));
    this.matEye = mk(new THREE.Color(EYE));
    this.tintables = [
      { mat: this.matBody, base: pal[0].clone() },
      { mat: this.matHead, base: pal[1].clone() },
      { mat: this.matDeep, base: pal[2].clone() },
      { mat: this.matComb, base: this.matComb.color.clone() },
    ];

    const bodyG = new THREE.Group();
    bodyG.position.y = BODY_Y;
    this.bodyG = bodyG;

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.62), this.matBody);
    torso.castShadow = true;
    bodyG.add(torso);

    // 尾羽三片：中间那片不歪，两侧各偏 0.3，尾尖靠 rotation.x = -0.55 挑起来
    const tailGeo = new THREE.BoxGeometry(0.06, 0.26, 0.04);
    for (const dz of [0, 0.06, -0.06]) {
      const f = new THREE.Mesh(tailGeo, this.matDeep);
      f.position.set(dz * 0.9, 0.16, -0.34);
      f.rotation.x = -0.55;
      f.rotation.z = dz === 0 ? 0 : dz > 0 ? 0.3 : -0.3;
      f.castShadow = true;
      bodyG.add(f);
    }

    const headG = new THREE.Group();
    headG.position.set(0, 0.16, 0.28);
    this.headG = headG;
    bodyG.add(headG);

    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 0.24), this.matHead);
    skull.position.set(0, 0.22, 0.05);
    skull.castShadow = true;
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.14), this.matHead);
    neck.position.set(0, 0.05, 0.03);
    const comb = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.18), this.matComb);
    comb.position.set(0, 0.37, 0.03);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 4), this.matOrange);
    beak.position.set(0, 0.2, 0.24);
    beak.rotation.x = Math.PI / 2;
    const wattle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.05), this.matComb);
    wattle.position.set(0, 0.12, 0.2);
    headG.add(neck, skull, comb, beak, wattle);
    const eyeGeo = new THREE.BoxGeometry(0.035, 0.05, 0.035);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, this.matEye);
      eye.position.set(sx * 0.125, 0.26, 0.1);
      headG.add(eye);
    }

    // 枢轴必须在肩上：几何体先向下平移 0.14，mesh 挂在肩点，rotation.z 才是「扇翅」
    // 而不是「绕身体中心转一圈」，否则一扇翅翅膀就从背上飞出去了。
    const wingGeo = new THREE.BoxGeometry(0.06, 0.28, 0.42);
    wingGeo.translate(0, -0.14, 0);
    this.wings = [];
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo, this.matDeep);
      w.position.set(sx * 0.27, 0.1, -0.02);
      w.castShadow = true;
      bodyG.add(w);
      this.wings.push(w);
    }

    const thighGeo = new THREE.BoxGeometry(0.055, 0.24, 0.055);
    thighGeo.translate(0, -0.12, 0);
    const footGeo = new THREE.BoxGeometry(0.1, 0.03, 0.14);
    this.legs = [];
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(sx * 0.11, -0.2, 0.02);
      const thigh = new THREE.Mesh(thighGeo, this.matDeep);   // 腿毛跟着毛色，脚掌才是橙的
      const foot = new THREE.Mesh(footGeo, this.matOrange);
      foot.position.set(0, -0.235, 0.04);
      leg.add(thigh, foot);
      bodyG.add(leg);
      this.legs.push(leg);
    }

    this.root.add(bodyG);

    // 名牌单挂一层：鸡倒地时 root 绕 z 转 1.45rad，牌子跟着转就躺平了 —— 这一层
    // 用 -tilt 反向补偿（见 update），再按 |tilt| 抬起来，侧躺时名字仍然竖直可读。
    this.plateAnchor = new THREE.Group();
    this.root.add(this.plateAnchor);
    this.sprite = null;
    this.plateCtx = null;

    if (label) this.setPlate({ title: label });
  }

  /** 让调用方不用自己拼 canvas：给个名字就行。 */
  setLabel(text) {
    this.setPlate({ title: String(text || '').split('\n')[0] });
  }

  /**
   * 名牌内容。data: {title, sub, flag, hp, cpu, mem, offline, gauges}
   * 只有内容真的变了才重画 canvas：重画 = 一次光栅化 + 一次纹理上传，
   * 每帧重画在手机上直接掉帧，而探针指标千分位抖动本来就不值得反映到牌子上。
   */
  setPlate(data = {}) {
    const title = String(data.title ?? '');
    const sub = data.sub ? String(data.sub) : '';
    const flag = /^[a-zA-Z]{2}$/.test(String(data.flag || '')) ? String(data.flag) : '';
    const hp = Number.isFinite(data.hp) ? clamp01(data.hp) : null;
    const cpu = Number.isFinite(data.cpu) ? clamp01(data.cpu) : null;
    const mem = Number.isFinite(data.mem) ? clamp01(data.mem) : null;
    const gauges = !!data.gauges;
    const offline = !!data.offline;

    const sig = [
      this.kind, offline ? 1 : 0, title, sub, flag, gauges ? 1 : 0,
      hp == null ? '-' : hp.toFixed(2),
      cpu == null ? '-' : cpu.toFixed(2),
      mem == null ? '-' : mem.toFixed(2),
    ].join('|');
    if (sig === this.plateSig) return;
    this.plateSig = sig;
    this.offline = offline;
    this.drawPlate({ title, sub, flag, hp, cpu, mem, gauges, offline });
  }

  /** 受击红闪：给躯干加自发光再自己衰减，比叠一层贴图便宜，也不影响别的鸡。 */
  flash() {
    this.flashT = 0.18;
    this.matBody.emissive.setHex(0x882222);
  }

  drawPlate({ title, sub, flag, hp, cpu, mem, gauges, offline }) {
    const L = offline ? PLATE_OFFLINE : PLATES[this.kind] || PLATES.player;
    if (!this.ensurePlate(L.w, L.h, L.sx, L.sy, L.y)) return;
    const ctx = this.plateCtx;
    const W = L.w, H = L.h;
    ctx.clearRect(0, 0, W, H);

    roundRect(ctx, 1, 1, W - 2, H - 2, 14);
    ctx.fillStyle = offline ? 'rgba(28,28,30,0.78)' : 'rgba(15,25,10,0.55)';
    ctx.fill();
    if (offline) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(200,90,90,0.55)';
      ctx.stroke();
    }

    let x0 = 14;
    if (flag) {
      drawFlag(ctx, flag, 14, 12, L.flagW, L.flagH);
      x0 = 14 + L.flagW + 8;
    }

    // 名字留白的阈值：探针卡右侧要放两个圆环，网站卡窄，所以三套宽度各不相同
    const maxW = offline ? W - 78 : this.kind === 'probe' ? 246 : this.kind === 'web' ? W - 70 : W - 78;
    const nameFont = NAME_FONT(L.title);
    const name = fitName(ctx, title, nameFont, maxW - (x0 - 14));
    ctx.font = nameFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, x0, L.titleY);

    if (sub) {
      const subFont = SUB_FONT(L.sub);
      const s = fitName(ctx, sub, subFont, maxW - (x0 - 14));
      ctx.font = subFont;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(s, x0, L.subY);
    }

    if (hp != null) {
      const bw = W - 28, bh = L.barH, by = L.barY;
      roundRect(ctx, 14, by, bw, bh, bh / 2);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fill();
      if (hp > 0) {
        roundRect(ctx, 14, by, Math.max(bh, bw * hp), bh, bh / 2);
        ctx.fillStyle = hp > 0.5 ? '#7ec850' : hp > 0.25 ? '#e8b23a' : '#e05252';
        ctx.fill();
      }
    }

    if (gauges && !offline) {
      const r = this.kind === 'probe' ? 20 : 16;
      const cy = L.titleY - 6;
      const cx2 = W - 34;
      drawGauge(ctx, cx2 - (r * 2 + 10), cy, r, cpu, '#7ec850');
      drawGauge(ctx, cx2, cy, r, mem, '#5aa7d6');
    }

    this.plateTex.needsUpdate = true;
  }

  /** canvas / texture / sprite 都懒建：没有内容时不该有一块空白牌子悬在鸡头上。 */
  ensurePlate(w, h, sx, sy, y) {
    if (!this.plateCtx) {
      if (typeof document === 'undefined') return false;
      const canvas = document.createElement('canvas');
      this.plateCanvas = canvas;
      this.plateCtx = canvas.getContext('2d');
      this.plateTex = new THREE.CanvasTexture(canvas);
      this.plateTex.colorSpace = THREE.SRGBColorSpace;
      this.plateTex.anisotropy = 2;
      this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.plateTex, transparent: true, depthTest: false,
      }));
      this.sprite.renderOrder = 5;   // 牌子永远画在鸡身前，不然前排的鸡会挡住后排的名字
      this.plateAnchor.add(this.sprite);
    }
    if (this.plateCanvas.width !== w || this.plateCanvas.height !== h) {
      this.plateCanvas.width = w;
      this.plateCanvas.height = h;
      this.plateTex.needsUpdate = true;
    }
    this.sprite.scale.set(sx, sy, 1);
    this.sprite.position.y = y;
    return true;
  }

  /** 状态与色调：姿态由 update 演，这里只记状态 + 上色。 */
  setState(state, tone = 'ok') {
    if (state !== this.state) {
      this.state = state;
      this.actionT = 0;
      if (state === ST.IDLE) {
        this.idlePeckT = 0;
        this.idleWait = 2.5 + Math.random() * 4;
      }
    }
    this.tone = tone;
    this.toneEmissive = { ok: 0x000000, muted: 0x000000, warn: 0x5a3a00, danger: 0x5a1005 }[tone] || 0;
    if (this.flashT <= 0) this.matBody.emissive.setHex(this.toneEmissive);
    this.matComb.emissive.setHex(tone === 'danger' ? 0x4a0d04 : 0x000000);
    // 读数陈旧的机器半透明：它还在场上，但读数已经不可信了
    const ghost = tone === 'muted';
    for (const { mat } of this.tintables) {
      mat.transparent = ghost;
      mat.opacity = ghost ? 0.55 : 1;
    }
  }

  setTransform(x, y, z, yaw) {
    this.posY = y;
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;   // 朝向只由调用方给：鸡自己转头会和移动方向打架
  }

  /** @param {number} dt 秒 @param {boolean} moving 是否在移动 */
  update(dt, moving = false) {
    const step = Math.min(0.1, Math.max(0, dt));   // 后台切回来时 dt 可能很大，别让相位跳一大步
    const t = (this.clock += step) + this.phase;
    const st = this.state;
    const bodyG = this.bodyG, headG = this.headG;

    // 先复位到站姿再按状态叠加：状态切换时不会残留上一种动作的骨骼角度
    headG.position.y = 0.16;
    headG.rotation.x = 0;
    bodyG.position.x = 0;
    bodyG.rotation.x = 0;
    bodyG.rotation.z = 0;
    bodyG.scale.set(1, 1, 1);
    this.legs[0].rotation.x = 0;
    this.legs[1].rotation.x = 0;
    this.wings[0].rotation.z = 0;
    this.wings[1].rotation.z = 0;

    // 倒地 / 起身共用一个收敛量：直接置位会在状态切换那一帧瞬移
    const k = Math.min(1, step * 8);
    this.tilt += ((st === ST.DEAD ? TILT_MAX : 0) - this.tilt) * k;
    if (this.tilt < 0.001) this.tilt = 0;
    this.crouch += ((st === ST.DEAD ? 0.1 : 0) - this.crouch) * k;

    // 调用方不传本帧位移，用状态速度反推摆腿幅度：WALK/RUN 之外一律不动腿
    const speed = st === ST.RUN ? CONF.runSpeed : st === ST.WALK ? CONF.walkSpeed : 0;
    const moveAmp = Math.min(1, speed / 2.8);

    if (st === ST.FLAP) {
      // 扇翅优先级最高：它同时是一次攻击，动作不能被走路的姿态盖掉
      const flap = Math.sin(t * 40) * 0.85 + 0.8;
      this.wings[0].rotation.z = -flap;
      this.wings[1].rotation.z = flap;
      bodyG.position.y = BODY_Y - this.crouch;
    } else if (st === ST.DEAD) {
      headG.rotation.x = 0.25;
      this.legs[0].rotation.x = -0.3;
      this.legs[1].rotation.x = -0.3;   // 腿蹬直，像被啄翻而不是站着躺平
      bodyG.position.y = BODY_Y - this.crouch;
    } else if (st === ST.AIR) {
      const flap = Math.sin(t * 24) * 0.55 + 0.75;
      this.wings[0].rotation.z = -flap;
      this.wings[1].rotation.z = flap;
      this.legs[0].rotation.x = -0.9;
      this.legs[1].rotation.x = -0.9;
      headG.rotation.x = -0.12;
      bodyG.position.y = BODY_Y - this.crouch;
    } else if (st === ST.ALERT) {
      bodyG.scale.set(1.09, 1.09, 1.09);
      bodyG.position.x = Math.sin(t * 26) * 0.012;
      headG.position.y = 0.16 + Math.sin(t * 9) * 0.02;
      this.wings[0].rotation.z = -0.5;
      this.wings[1].rotation.z = 0.5;
      bodyG.position.y = BODY_Y - this.crouch;
    } else if (st === ST.SLEEP) {
      bodyG.scale.set(1.04, 0.82, 1.04);
      headG.rotation.x = 0.55;
      headG.position.y = 0.08;
      bodyG.position.y = BODY_Y - 0.03 - this.crouch;
    } else if (st === ST.PECK) {
      this.actionT += step;
      const ph = clamp01(1 - this.actionT / PECK_DUR);
      headG.rotation.x = Math.sin(ph * Math.PI) * 1.15;
      bodyG.position.y = BODY_Y - this.crouch;
    } else {
      // 走 / 跑 / 站着：同一套摆腿，幅度由 moveAmp 收放
      const moved = (moving ? 1 : 0) * moveAmp;
      this.walkPhase += moved * 3.6;
      const swing = Math.sin(this.walkPhase) * 0.75 * moveAmp;
      this.legs[0].rotation.x = swing;
      this.legs[1].rotation.x = -swing;   // 左右反相才是走路，同相是蹬腿
      bodyG.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.09 * moveAmp;
      bodyG.rotation.x = moveAmp * 0.08;
      headG.position.y = 0.16 + Math.sin(this.walkPhase) * 0.02 * moveAmp;
      if (st === ST.RUN) {
        const flap = Math.sin(t * 18) * 0.18 + 0.22;
        this.wings[0].rotation.z = -flap;
        this.wings[1].rotation.z = flap;
      } else {
        this.wings[0].rotation.z = -0.06 - moveAmp * 0.12;
        this.wings[1].rotation.z = 0.06 + moveAmp * 0.12;
      }
      // 闲逛时偶尔低头啄一下地：间隔带随机，一群鸡才不会像同一个节拍器
      if (!moving) {
        this.idleWait -= step;
        if (this.idleWait <= 0) {
          this.idlePeckT = PECK_DUR;
          this.idleWait = 2.5 + Math.random() * 4;
        }
        if (this.idlePeckT > 0) {
          this.idlePeckT -= step;
          headG.rotation.x = Math.sin(clamp01(1 - this.idlePeckT / PECK_DUR) * Math.PI) * 1.0;
        }
      }
      bodyG.position.y = BODY_Y + Math.sin(t * 2.2) * 0.012 * (1 - moveAmp) - this.crouch;
    }

    // 侧翻贴地补偿：root 绕 z 转到 1.45rad 时鸡身会沉到地面以下 0.3 左右，
    // 按 sin(|tilt|)*0.314 抬回来，躺倒的鸡才不会半个身子插进草地
    this.root.rotation.z = this.tilt;
    this.root.position.y = this.posY + Math.sin(Math.abs(this.tilt)) * 0.314;

    // 名牌跟着 root 转，所以要把 tilt 反向补掉；同时按倾角抬升，倒地时名字还在鸡上方
    this.plateAnchor.rotation.z = -this.tilt;
    this.plateAnchor.position.y = (Math.abs(this.tilt) / TILT_MAX) * PLATE_LIFT;

    // 离线压暗：在材质颜色上向灰插值，恢复在线时插回原色
    const kc = Math.min(1, step * 6);
    for (const { mat, base } of this.tintables) {
      if (this.offline) mat.color.lerp(OFFLINE_TINT, kc);
      else mat.color.lerp(base, kc);
    }

    if (this.flashT > 0) {
      this.flashT -= step;
      this.matBody.emissive.setHex(this.flashT > 0 ? 0x882222 : this.toneEmissive);
    }
  }

  dispose(scene) {
    if (scene) scene.remove(this.root);
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}