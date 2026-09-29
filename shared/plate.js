// 鸡名牌的文案：谁在线、谁倒下，只在这里判一次。
//
// 这里踩过两个坑，所以判定被收到一处：
//   1) 网站鸡失联、服务端又没给 reason 时，兜底分支写出来的是「网站在线」——
//      鸡躺在地上、牌子写着在线，两个状态叠在一起；
//   2) 牌面原来只看名册里的 offline 标记，而鸡的姿态来自每帧的实时采样，
//      两者差一拍同样会出现「鸡已经倒下、牌子还写着在线」。
// 现在：offline 标记 / 姿态 / ko 任一命中即算「倒下」，倒下就绝不出现「在线」字样。

import { ST } from './physics.js';
import { formatAge, formatBytesShort } from './derive.js';

/**
 * @param {object} meta 服务端名册条目（或按实时姿态修正过的同形对象）
 *   { kind, name, country, state, tone, label, offline, ko, hp, maxHp, up, reason, latency, netIn, netOut, cpu, mem }
 * @returns {{title:string,sub:string,flag:string,hp:number,cpu:number|null,mem:number|null,offline:boolean,gauges:boolean}}
 *   Chicken.setPlate 吃的数据（纯函数：没有 DOM、没有全局状态，两端可共用）
 */
export function npcPlate(meta) {
  const web = meta.kind === 'web';
  const title = `${web ? '网站鸡' : '探针鸡'}·${meta.name}`;
  const sleeping = meta.state === ST.SLEEP;
  const down = !!meta.offline || meta.state === ST.DEAD || sleeping;

  let sub;
  if (down) {
    if (web) sub = sleeping ? '未探测' : (meta.reason ? `网站离线 ${meta.reason}` : '网站离线');
    else if (meta.ko) sub = '被啄倒';
    else sub = sleeping ? '未接入探针' : '离线';
  } else if (web) {
    sub = meta.latency == null ? '检测网站中…' : `网站在线 ${meta.latency}ms`;
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
    offline: down,
    gauges: meta.kind === 'probe' && !down,
  };
}
