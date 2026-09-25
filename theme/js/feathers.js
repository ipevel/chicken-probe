// 羽毛粒子：啄中的瞬间炸几片毛，池化复用 —— 每次 new 几何体会让 GC 在打斗时抖帧。

import * as THREE from 'three';

const POOL = 60;
const LIFE = 0.9;

export function createFeathers(scene) {
  const geo = new THREE.PlaneGeometry(0.16, 0.05);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, depthWrite: false });
  const items = [];
  for (let i = 0; i < POOL; i++) {
    const mesh = new THREE.Mesh(geo, mat.clone());
    mesh.visible = false;
    mesh.userData = { life: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
    scene.add(mesh);
    items.push(mesh);
  }
  let cursor = 0;

  return {
    burst(x, y, z, color = '#f7f2e6', count = 8) {
      for (let i = 0; i < count; i++) {
        const mesh = items[cursor++ % POOL];
        const a = Math.random() * Math.PI * 2;
        const up = 1.2 + Math.random() * 1.8;
        mesh.userData.life = LIFE * (0.7 + Math.random() * 0.5);
        mesh.userData.vx = Math.cos(a) * (0.6 + Math.random());
        mesh.userData.vz = Math.sin(a) * (0.6 + Math.random());
        mesh.userData.vy = up;
        mesh.userData.spin = (Math.random() - 0.5) * 8;
        mesh.position.set(x, y, z);
        mesh.material.color.set(color);
        mesh.material.opacity = 1;
        mesh.visible = true;
      }
    },

    update(dt) {
      for (const mesh of items) {
        const u = mesh.userData;
        if (u.life <= 0) continue;
        u.life -= dt;
        if (u.life <= 0) { mesh.visible = false; continue; }
        u.vy -= 3.2 * dt;                 // 比鸡轻，落得慢，飘一会儿
        u.vx *= 1 - 1.6 * dt;
        u.vz *= 1 - 1.6 * dt;
        mesh.position.x += u.vx * dt;
        mesh.position.y += u.vy * dt;
        mesh.position.z += u.vz * dt;
        mesh.rotation.z += u.spin * dt;
        mesh.rotation.y += u.spin * 0.5 * dt;
        mesh.material.opacity = Math.min(1, u.life / (LIFE * 0.5));
      }
    },

    dispose() {
      geo.dispose();
      for (const mesh of items) { scene.remove(mesh); mesh.material.dispose(); }
    },
  };
}