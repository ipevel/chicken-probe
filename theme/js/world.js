// 场景与场地：地形、光照、以及按 OBSTACLES 长出来的鸡场物件。
// 这里只读物理层给的坐标与尺寸，不自己维护第二份 —— 画出来的盒子和客户端/服务端
// 用的碰撞体必须是同一组数，否则玩家会撞到看不见的墙、或者穿进看得到的鸡舍里。

import * as THREE from 'three';
import { WORLD_HALF, groundHeight, OBSTACLES } from '/shared/physics.js';

const SKY = 0xa8d8f0;

// 装饰物（山丘、草叶、草地贴图）不参与碰撞，不必与服务端同步，
// 但固定种子能让每次进场的画面一模一样，否则草和山丘每次刷新都在跳。
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7fae46';
  g.fillRect(0, 0, 512, 512);
  const rand = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = rand() * 512, y = rand() * 512, r = 4 + rand() * 26;
    g.fillStyle = rand() < 0.5 ? 'rgba(106,154,60,0.35)' : 'rgba(148,190,90,0.3)';
    g.beginPath();
    g.ellipse(x, y, r, r * (0.5 + rand() * 0.5), rand() * Math.PI, 0, 6.29);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;  // repeat > 1 必须配 RepeatWrapping，否则只在角上铺一块
  tex.repeat.set(6, 6);
  // canvas 里的颜色是 sRGB 值：不声明的话会被当成线性色，草地会脏成一团
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 一个场地一份材质表，物件之间共用（同一块地面上一百多个 mesh，逐个 new 材质会多出一堆
// shader program）。放在函数里而不是模块顶层：disposeWorld 会把材质释放掉，
// 第二次进场必须拿到全新的，模块级的会被复用成已销毁的材质。
function createMaterials() {
  return {
    fence: new THREE.MeshLambertMaterial({ color: 0x9a6a3a }),
    fenceTop: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
    coopWall: new THREE.MeshLambertMaterial({ color: 0xb5553d }),
    coopRoof: new THREE.MeshLambertMaterial({ color: 0x6b4a3a }),
    coopDoor: new THREE.MeshLambertMaterial({ color: 0x3a2a20 }),
    coopTrim: new THREE.MeshLambertMaterial({ color: 0xf0e6d0 }),
    trough: new THREE.MeshLambertMaterial({ color: 0x8a7a5a }),
    water: new THREE.MeshLambertMaterial({ color: 0x5aa7d6 }),
    hay: new THREE.MeshLambertMaterial({ color: 0xd8b95a }),
    trunk: new THREE.MeshLambertMaterial({ color: 0x7a5230 }),
    leaf: new THREE.MeshLambertMaterial({ color: 0x4e8f3a }),
    leaf2: new THREE.MeshLambertMaterial({ color: 0x5da344 }),
    // flatShading：石头是多面体，平滑法线会让它看起来像颗球
    rock: new THREE.MeshLambertMaterial({ color: 0x9a9a92, flatShading: true }),
    hill: new THREE.MeshLambertMaterial({ color: 0x6f9e4b }),
    grass: new THREE.MeshLambertMaterial({ color: 0x6da33f }),
  };
}

/** 一件障碍物 → 一个 Group（内部坐标以「地面」为 0，调用方负责贴地）。 */
function buildObstacle(o, MAT) {
  const grp = new THREE.Group();
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
    return m;
  };

  switch (o.type) {
    case 'fence': {
      // 长边是 w 还是 d 决定这排围栏的走向，横向那一条的厚度固定 0.12
      const horizontal = o.w > o.d;
      const len = horizontal ? o.w : o.d;
      add(new THREE.BoxGeometry(horizontal ? len : 0.12, o.h, horizontal ? 0.12 : len),
        MAT.fence, 0, o.h / 2, 0);
      add(new THREE.BoxGeometry(horizontal ? len : 0.08, 0.09, horizontal ? 0.08 : len),
        MAT.fenceTop, 0, o.h - 0.05, 0);
      // 立柱每 3 米一根，含两端；同一排围栏的所有柱子共用一份几何体
      const n = Math.max(2, Math.round(len / 3));
      const postGeo = new THREE.BoxGeometry(0.18, o.h + 0.15, 0.18);
      for (let i = 0; i <= n; i++) {
        const t = -len / 2 + (len / n) * i;
        add(postGeo, MAT.fenceTop, horizontal ? t : 0, (o.h + 0.15) / 2, horizontal ? 0 : t);
      }
      break;
    }
    case 'coop': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.coopWall, 0, o.h / 2, 0);
      // 两片坡屋顶：绕 z 反向各倾 0.5 弧度，接着的一边压在另一边上做成屋脊
      const roofGeo = new THREE.BoxGeometry(o.w * 0.62, 0.18, o.d + 0.5);
      add(roofGeo, MAT.coopRoof, -o.w * 0.24, o.h + 0.42, 0).rotation.z = 0.5;
      add(roofGeo, MAT.coopRoof, o.w * 0.24, o.h + 0.42, 0).rotation.z = -0.5;
      add(new THREE.BoxGeometry(1.1, 1.6, 0.1), MAT.coopDoor, 0, 0.8, o.d / 2 + 0.02);
      add(new THREE.BoxGeometry(o.w + 0.2, 0.16, o.d + 0.2), MAT.coopTrim, 0, 0.08, 0);
      break;
    }
    case 'trough': {
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.trough, 0, o.h / 2, 0);
      // 水面贴在槽口高度上（略高于槽体顶面），远看就是一槽水
      add(new THREE.BoxGeometry(o.w - 0.3, 0.06, o.d - 0.3), MAT.water, 0, o.h, 0);
      break;
    }
    case 'hay':
      add(new THREE.BoxGeometry(o.w, o.h, o.d), MAT.hay, 0, o.h / 2, 0);
      break;
    case 'tree': {
      add(new THREE.CylinderGeometry(0.22, 0.3, o.h, 7), MAT.trunk, 0, o.h / 2, 0);
      add(new THREE.IcosahedronGeometry(1.5, 0), MAT.leaf, 0, o.h + 0.7, 0);
      add(new THREE.IcosahedronGeometry(1.05, 0), MAT.leaf2, 0.5, o.h + 1.4, 0.3);
      add(new THREE.IcosahedronGeometry(0.9, 0), MAT.leaf2, -0.55, o.h + 1.2, -0.35);
      break;
    }
    case 'rock': {
      // 半径取宽度的一半，再单独压 y：石头的高矮和胖瘦是两回事
      add(new THREE.DodecahedronGeometry(o.w / 2, 0), MAT.rock, 0, o.h / 2, 0)
        .scale.y = (o.h / (o.w / 2)) * 0.6;
      break;
    }
    default:
      break;
  }

  // 土丘上的东西不能按 y = 0 摆，否则一半埋进坡里、一半浮在坡上
  grp.position.set(o.x, groundHeight(o.x, o.z), o.z);
  return grp;
}

export function buildScene(renderer, { lowPower = false } = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  // 雾用同一个天蓝色：场地边缘和远山正好溶进天里，看不出地面到哪儿结束
  scene.fog = new THREE.Fog(SKY, 45, 110);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 220);

  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x8a9a5a, 0.95);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(24, 34, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(lowPower ? 1024 : 2048, lowPower ? 1024 : 2048);
  sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
  sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
  sun.shadow.camera.far = 90;
  // 视锥是手改的，投影矩阵要自己重算一遍：three 只在阴影贴图新建那一刻顺手算过
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lowPower ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  return { scene, camera, sun };
}

// lowPower 在这个函数里没有降档项：草丛是一次实例化 draw、山丘只有 9 个，
// 都不值得为低配砍掉；参数留着是为了和 buildScene 的签名一致。
export function buildWorld(scene, { lowPower = false } = {}) {
  const MAT = createMaterials();
  const world = new THREE.Group();
  const half = WORLD_HALF;

  // 地面：顶点按 groundHeight 抬起来，鸡的落地判定用的就是这条曲线，
  // 平铺一块板子的话鸡会悬在土丘上方或者陷进去。
  const geo = new THREE.PlaneGeometry(half * 2 + 60, 110, 110, 110);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // 此刻还在 XY 平面上：位移写进本地 z，等下面绕 x 转 -90° 之后它就成了世界高度；
    // 本地 y 翻转后是世界 z（所以取 -y），这样高度取到的正是脚下那一点。
    pos.setZ(i, groundHeight(pos.getX(i), -pos.getY(i)));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: groundTexture() }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  world.add(ground);

  for (const o of OBSTACLES) world.add(buildObstacle(o, MAT));

  // 场外远景：9 座压扁的球，落在场地边界外那圈下沉的地形上，当成远处的山
  const rand = mulberry32(42);  // 山丘与草叶共用这条随机流，撒点位置于是固定
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2 + rand() * 0.5;
    const dist = half + 14 + rand() * 18;
    const hill = new THREE.Mesh(new THREE.SphereGeometry(7 + rand() * 8, 12, 8), MAT.hill);
    hill.position.set(Math.cos(ang) * dist, -2.5, Math.sin(ang) * dist);
    hill.scale.y = 0.55;
    hill.receiveShadow = true;
    world.add(hill);
  }

  // 草叶：240 个实例合一次 draw。不投影 —— 阴影要多画一遍这 240 个实例，
  // 而草叶的影子贴在地面上几乎看不见，这笔账不划算。
  const blades = new THREE.InstancedMesh(new THREE.ConeGeometry(0.05, 0.34, 4), MAT.grass, 240);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 240; i++) {
    const gx = (rand() * 2 - 1) * (half - 1.5);
    const gz = (rand() * 2 - 1) * (half - 1.5);
    dummy.position.set(gx, groundHeight(gx, gz) + 0.16, gz);
    dummy.rotation.y = rand() * Math.PI;
    dummy.scale.setScalar(0.7 + rand() * 0.9);
    dummy.updateMatrix();
    blades.setMatrixAt(i, dummy.matrix);
  }
  blades.castShadow = false;
  world.add(blades);

  scene.add(world);
  return world;
}

export function disposeWorld(scene, world) {
  if (!world) return;
  scene.remove(world);

  // 材质和几何体在物件之间是共用的，先收进 Set 再逐个释放，避免同一份被反复 dispose
  const geos = new Set();
  const mats = new Set();
  world.traverse((o) => {
    // 实例矩阵的 GPU buffer 挂在 mesh 自己身上，不会跟着 geometry 一起释放
    if (o.isInstancedMesh) o.dispose();
    if (o.geometry) geos.add(o.geometry);
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
    }
  });
  for (const g of geos) g.dispose();
  for (const m of mats) {
    // 贴图（草地 canvas）挂在材质上，不单独释放的话每次进场都会漏一张 GPU 纹理
    for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
    m.dispose();
  }
}