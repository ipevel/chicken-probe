// 总装：面板是主界面，鸡场是 #farm 路由。
//
// 用 hash 路由而不是路径路由：hub 会把未知路径回落到 index.html，但 hash 切换
// 不会重新加载页面，进/出鸡场时面板状态（筛选、滚动位置）原样留着。

import { createPanel, loadSettings } from './panel.js';
import { createHub } from './data.js';

const $ = (id) => document.getElementById(id);

let farm = null;
let mounting = false;
let identity = loadIdentity();

/*
 * 设置必须在建面板之前读到：面板是按设置渲染的（鸡场入口显不显示、图表画不画
 * 峰值线），建完再补就要重画一遍。读设置失败不会抛 —— 拿不到就是全部用默认值。
 */
const settings = await loadSettings();

const panel = createPanel({
  onEnterFarm: () => { location.hash = '#farm'; },
  settings,
});

/** 玩家身份存本机：联机时随 hello 报给房间，断线重连回来还是同一只鸡。 */
function loadIdentity() {
  try {
    const raw = JSON.parse(localStorage.getItem('chicken-probe:me') || 'null');
    if (raw && typeof raw.name === 'string' && raw.name) return { name: raw.name, icon: raw.icon || '🐔' };
  } catch { /* 存坏了就当没存过 */ }
  return { name: `访客${Math.floor(Math.random() * 90 + 10)}`, icon: '🐔' };
}

const hub = createHub({
  // 场上的鸡由联机服务给，面板只吃 hub 的节点数据 —— 两条链路互不依赖
  onNodes: (next) => {
    panel.setNodes(next);
  },
  onState: (state, detail) => panel.setConn(state, detail),
  onMe: (me) => {
    panel.setSiteName(me.site_name);
    // 主控保留多少天历史（hub v1.3.2 起才有）。老 hub 没这个字段，面板按 7 天算。
    panel.setHistoryDays(me.history_days);
  },
});
hub.start();
document.body.classList.add('ready');

$('back-btn').onclick = () => { location.hash = ''; };

async function enterFarm() {
  mounting = true;
  const { createFarm } = await import('./farm.js');
  mounting = false;
  if (!/^#farm/.test(location.hash)) return;      // 加载期间用户已经退出去了
  $('panel').classList.add('hidden');
  $('farm').classList.remove('hidden');
  document.body.classList.add('in-farm');
  farm = createFarm({
    identity,
    onExit: () => { location.hash = ''; },
    onChangeIdentity: (id) => { identity = id; },
  });
  farm.mount();
}

function leaveFarm() {
  farm?.unmount();
  farm = null;
  $('farm').classList.add('hidden');
  $('panel').classList.remove('hidden');
  document.body.classList.remove('in-farm');
}

function syncRoute() {
  if (/^#farm(&|$)/.test(location.hash)) {   // 允许 #farm&room=... 带参数进来
    if (!farm && !mounting) void enterFarm();
    return;
  }
  if (farm) leaveFarm();
}

addEventListener('hashchange', syncRoute);
syncRoute();