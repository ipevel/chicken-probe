// 监控面板：总览条 + 筛选/排序/搜索 + 节点卡 + 详情抽屉。
//
// 两条贯穿始终的规矩：
// 1) 卡片按 id 增量更新，不整片重建 —— hub 每 2 秒推一次，重建会把 hover、
//    焦点和排序动画一起弄没。
// 2) 所有来自 hub 的文本走 textContent，绝不拼 HTML。机器名是别人能填的字段。

import {
  statusOf, summary, sortNodes, matchesFilter, SORTS, STATUS_LABEL, ATTENTION,
  formatBytes, formatSpeed, formatAge, formatDays, statusNote, toneOf, pct, loadTone,
  monthUsage, expiringIn, staleFor, nowSec, formatBytesShort,
} from '/shared/derive.js';
import { flagEl, mountFlagSprite } from './flag.js';
import { nodeHistory } from './history.js';
import { renderChart, renderSpark } from './chart.js';
import { stats as seriesStats, alignByTs } from '/shared/chart.js';

const $ = (id) => document.getElementById(id);

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'alert', label: '告警' },
  { key: 'offline', label: '离线' },
  { key: 'stale', label: '陈旧' },
  { key: 'expiring', label: '即将到期' },
  { key: 'unconnected', label: '未接入' },
];

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createPanel({ onEnterFarm } = {}) {
  const gridEl = $('grid');
  const summaryEl = $('summary');
  const chipsEl = $('chips');
  const emptyEl = $('empty');
  const countryEl = $('country');
  const sortEl = $('sort');
  const qEl = $('q');

  const state = { nodes: [], filter: 'all', country: '', sort: 'problem', q: '', view: 'grid', open: null };
  const cards = new Map();          // id -> {el, parts}
  const sparks = new Map();         // id -> 卡片上那条 1 小时 CPU 曲线的数据
  const sparkQueue = [];            // 待抓的卡片曲线（限流，别一屏几十个请求）
  let sparkBusy = 0;

  // ---- URL 状态：筛完能直接分享，刷新也不丢 ----
  function readUrl() {
    const u = new URLSearchParams(location.search);
    state.filter = u.get('status') || 'all';
    state.country = u.get('country') || '';
    state.sort = SORTS[u.get('sort')] ? u.get('sort') : 'problem';
    state.q = u.get('q') || '';
    state.view = u.get('view') === 'list' ? 'list' : 'grid';
    if (u.get('node')) state.open = Number(u.get('node')) || null;
    if (u.get('tab') === 'latency') detail.tab = 'latency';
    if (RANGES.some(r => r.hours === Number(u.get('hours')))) detail.hours = Number(u.get('hours'));
  }
  function writeUrl() {
    const u = new URLSearchParams();
    if (state.filter !== 'all') u.set('status', state.filter);
    if (state.country) u.set('country', state.country);
    if (state.sort !== 'problem') u.set('sort', state.sort);
    if (state.q) u.set('q', state.q);
    if (state.view !== 'grid') u.set('view', state.view);
    if (state.open != null) {
      u.set('node', String(state.open));
      if (detail.tab !== 'resources') u.set('tab', detail.tab);
      if (detail.hours !== 6) u.set('hours', String(detail.hours));
    }
    const qs = u.toString();
    // replaceState 而不是 pushState：每 2 秒一次的状态不该堆满浏览器的后退栈。
    // 必须带上 hash —— 在鸡场里啄开详情时，抹掉 #farm 会让人下次刷新掉回面板
    history.replaceState(null, '', `${qs ? `?${qs}` : location.pathname}${location.hash}`);
  }

  // ---- 总览条 ----
  function renderSummary() {
    const s = summary(state.nodes, nowSec());
    summaryEl.replaceChildren();
    const cell = (k, v, sub, opts = {}) => {
      const c = el('div', 'cell' + (opts.cls ? ' ' + opts.cls : '') + (opts.onClick ? ' clickable' : ''));
      c.append(el('div', 'k', k), el('div', 'v', v));
      if (sub) c.append(el('div', 'sub', sub));
      if (opts.onClick) {
        c.tabIndex = 0;
        c.setAttribute('role', 'button');
        c.onclick = opts.onClick;
        c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onClick(); } };
      }
      return c;
    };

    summaryEl.append(
      cell('节点', String(s.total), `${s.countries.length} 个地区`),
      cell('告警', String(s.alerts), s.alerts ? '点击查看' : '全部正常', {
        cls: s.alerts ? 'hot' : '', onClick: () => { setFilter('alert'); },
      }),
      cell('最忙', s.busiestCpu >= 0 ? `${s.busiestCpu.toFixed(1)}%` : '—',
        s.busiest ? s.busiest.name : '没有可读读数',
        { cls: s.busiestCpu >= 92 ? 'hot' : s.busiestCpu >= 80 ? 'warm' : '', onClick: s.busiest ? () => openDetail(s.busiest.id) : null }),
      cell('本月流量', formatBytes(s.monthBytes, 1), '全部机器合计'),
      cell('7 天内到期', String(s.expiringSoon), s.expiringSoon ? '点击查看' : '暂无', {
        cls: s.expiringSoon ? 'warm' : '', onClick: () => setFilter('expiring'),
      }),
    );
  }

  // ---- 筛选条 ----
  function renderChips() {
    const now = nowSec();
    chipsEl.replaceChildren();
    for (const f of FILTERS) {
      const n = state.nodes.filter(x => matchesFilter(x, f.key, now)).length;
      const b = el('button', 'chip', f.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.filter === f.key));
      if (f.key !== 'all') b.append(el('span', 'n', String(n)));
      b.onclick = () => setFilter(f.key);
      chipsEl.append(b);
    }
  }

  function renderCountryOptions() {
    const cur = state.country;
    const list = summary(state.nodes, nowSec()).countries;
    if (countryEl.dataset.filled === list.join(',')) return;   // 别每 2 秒重置下拉
    countryEl.dataset.filled = list.join(',');
    countryEl.replaceChildren(el('option', null, '全部地区'));
    countryEl.firstChild.value = '';
    for (const c of list) {
      const o = el('option', null, c);
      o.value = c;
      countryEl.append(o);
    }
    countryEl.value = cur;
  }

  function renderSortOptions() {
    if (sortEl.childElementCount) return;
    for (const [key, s] of Object.entries(SORTS)) {
      const o = el('option', null, s.label);
      o.value = key;
      sortEl.append(o);
    }
  }

  // ---- 卡片 ----
  function buildCard(node) {
    const root = el('article', 'card');
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.onclick = () => openDetail(node.id);
    root.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(node.id); }
      if (e.key === 'Escape') closeDetail();
    };

    const head = el('div', 'card-head');
    const flag = el('span', 'card-flag');
    const name = el('span', 'card-name');
    const pill = el('span', 'pill');
    head.append(flag, name, pill);

    const nums = el('div', 'nums');
    const mk = (k) => {
      const box = el('div', 'num');
      const v = el('div', 'v');
      const bar = el('div', 'bar');
      const fill = el('i');
      bar.append(fill);
      box.append(el('div', 'k', k), v, bar);
      nums.append(box);
      return { v, fill };
    };
    const cpu = mk('CPU'), mem = mk('内存'), disk = mk('硬盘');

    const mid = el('div', 'card-mid');
    const mkMid = (k) => {
      const box = el('div', 'mid');
      const key = el('div', 'k');
      const label = el('span', null, k);
      const b = el('b');
      key.append(label, b);
      const bar = el('div', 'bar half');
      const fill = el('i');
      bar.append(fill);
      box.append(key, bar);
      mid.append(box);
      return { b, fill };
    };
    const load = mkMid('负载');
    const net = mkMid('速率');

    const quota = el('div', 'quota');
    const qbar = el('div', 'bar');
    const qfill = el('i');
    qbar.append(qfill);
    quota.append(qbar);

    const foot = el('div', 'card-foot');
    const traffic = el('span', 'traffic');
    const note = el('span', 'note');
    foot.append(traffic, note);

    const sparkHost = el('div', 'spark-host');
    root.append(head, nums, mid, quota, sparkHost, foot);
    return { el: root, sparkHost, parts: { flag, name, pill, cpu, mem, disk, load, net, quota, qfill, traffic, note } };
  }

  function updateCard(card, node, now) {
    const p = card.parts;
    const st = statusOf(node, now);
    const dead = st === 'offline' || st === 'unconnected';

    card.el.dataset.status = st;
    const attention = ATTENTION.includes(st);
    card.el.dataset.attention = attention ? (st === 'stale' || st === 'quota' || st === 'alert' ? 'warn' : '1') : '';
    if (st === 'alert' || st === 'unreadable' || st === 'offline') card.el.dataset.attention = '1';
    card.el.classList.toggle('dead', dead);
    card.el.setAttribute('aria-label', `${node.name} ${STATUS_LABEL[st]}`);

    // 国旗用 SVG：每 2 秒重建一个 <use> 没必要，地区没变就不动
    if (card.lastFlag !== node.country) {
      card.lastFlag = node.country;
      p.flag.replaceChildren(flagEl(node.country));
    }
    p.name.textContent = node.name;
    p.pill.textContent = STATUS_LABEL[st];
    p.pill.className = `pill ${st}`;

    const m = node.metrics;
    const set = (part, value, pctVal) => {
      part.v.textContent = value;
      const t = toneOf(pctVal);
      part.v.className = `v${dead ? ' muted' : t === 'ok' ? '' : ' ' + t}`;
      part.fill.style.width = pctVal == null ? '0' : `${Math.min(100, Math.max(0, pctVal))}%`;
      part.fill.className = dead ? '' : (t === 'ok' ? '' : t);
    };

    set(p.cpu, m?.cpu == null ? '—' : `${m.cpu.toFixed(1)}%`, dead ? null : m?.cpu ?? null);
    const memP = pct(m?.mem_used, m?.mem_total);
    const diskP = pct(m?.disk_used, m?.disk_total);
    set(p.mem, memP == null ? '—' : `${memP.toFixed(0)}%`, dead ? null : memP);
    set(p.disk, diskP == null ? '—' : `${diskP.toFixed(0)}%`, dead ? null : diskP);

    // 负载按核数读：load1 是核数多少倍才是关键，光给数值没有意义
    const load1 = m?.load?.[0];
    p.load.b.textContent = load1 == null ? '—' : `${load1.toFixed(2)} / ${node.cpu_cores || '?'} 核`;
    const lt = dead ? 'ok' : loadTone(node);
    p.load.b.className = lt === 'ok' ? '' : lt;
    p.load.fill.style.width = load1 == null || !node.cpu_cores ? '0' : `${Math.min(100, (load1 / node.cpu_cores) * 50)}%`;
    p.load.fill.className = lt === 'ok' ? '' : lt;

    const rx = m?.net_rx, tx = m?.net_tx;
    const busy = (rx ?? 0) + (tx ?? 0) > 100 * 1024;
    p.net.b.textContent = dead || rx == null ? '—' : `↑${formatBytesShort(tx)} ↓${formatBytesShort(rx)}`;
    p.net.b.className = dead ? '' : (busy ? 'live' : '');
    p.net.fill.style.width = dead || rx == null ? '0' : `${Math.min(100, ((rx + tx) / (8 * 1024 * 1024)) * 100)}%`;
    p.net.fill.className = '';

    const used = monthUsage(node);
    const limit = node.traffic_limit || 0;
    if (limit > 0) {
      p.quota.classList.remove('hidden');
      const r = (used / limit) * 100;
      p.qfill.style.width = `${Math.min(100, r)}%`;
      p.qfill.className = r > 100 ? 'danger' : r > 80 ? 'warn' : '';
    } else {
      p.quota.classList.add('hidden');
    }

    p.traffic.textContent = `本月 ${formatBytes(used, 1)}${limit > 0 ? ` / ${formatBytes(limit, 0)}` : '（无限）'}`;
    const exp = expiringIn(node, now);
    // 两段用 · 连接：没有到期信息时不能留下一个孤零零的分隔符
    const parts = [];
    if (exp != null) parts.push(`到期 ${formatDays(exp)}`);
    const note = statusNote(node, now) || (node.traffic_reset_day ? `流量 ${node.traffic_reset_day} 号重置` : '');
    if (note) parts.push(note);
    p.note.textContent = parts.join(' · ');
    p.note.className = 'note' + (st === 'offline' || st === 'alert' || st === 'unreadable' ? ' danger' : (st === 'stale' || st === 'quota' || st === 'expiring') ? ' warn' : '');
  }

  const SPARK_CONCURRENCY = 3;
  const SPARK_LIMIT = 14;          // 一次最多排这么多：一屏几十个请求既慢又没必要

  function pumpSparks() {
    while (sparkBusy < SPARK_CONCURRENCY && sparkQueue.length) {
      const id = sparkQueue.shift();
      sparkBusy++;
      nodeHistory.metrics(id, 1, 80)
        .then((m) => {
          sparks.set(id, { t: Date.now(), rows: m.rows });
          const node = state.nodes.find(n => n.id === id);
          const card = cards.get(id);
          if (node && card?.sparkHost) renderSpark(card.sparkHost, withPct(m.rows, node), 'cpu', 'var(--c-cpu)');
        })
        .catch((e) => {
          // 历史读不到就静默跳过（卡片其余信息照常），但渲染出错必须留痕 ——
          // 早先这里一律吞掉，结果「卡片上一直没曲线」查了半天
          if (e instanceof TypeError || e instanceof ReferenceError) console.warn('[spark] 渲染卡片曲线失败：', e);
        })
        .finally(() => { sparkBusy--; pumpSparks(); });
    }
  }

  function wantSpark(id) {
    const hit = sparks.get(id);
    const fresh = hit && Date.now() - hit.t < 300_000;   // 5 分钟内不重复抓
    if (fresh) {
      const node = state.nodes.find(n => n.id === id);
      const card = cards.get(id);
      if (node && card?.sparkHost && !card.sparkHost.childElementCount) {
        renderSpark(card.sparkHost, withPct(hit.rows, node), 'cpu', 'var(--c-cpu)');
      }
      return;
    }
    if (sparkQueue.includes(id) || sparkBusy + sparkQueue.length >= SPARK_LIMIT) return;
    sparkQueue.push(id);
    pumpSparks();
  }

  function renderList() {
    const now = nowSec();
    const q = state.q.trim().toLowerCase();
    const visible = sortNodes(state.nodes, state.sort, now).filter(n => {
      if (!matchesFilter(n, state.filter, now)) return false;
      if (state.country && n.country !== state.country) return false;
      if (q && !(`${n.name}`.toLowerCase().includes(q) || `${n.country}`.toLowerCase().includes(q))) return false;
      return true;
    });

    const ids = new Set(visible.map(n => n.id));
    for (const [id, card] of cards) {
      if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    }

    let prev = null;
    for (const node of visible) {
      let card = cards.get(node.id);
      if (!card) {
        card = buildCard(node);
        cards.set(node.id, card);
      }
      updateCard(card, node, now);
      if (!document.body.classList.contains('in-farm')) wantSpark(node.id);
      // 顺序变了才搬 DOM；顺序没变时不动，避免每 2 秒重排一次
      const want = prev ? prev.nextElementSibling : gridEl.firstElementChild;
      if (want !== card.el) gridEl.insertBefore(card.el, want);
      prev = card.el;
    }
    emptyEl.classList.toggle('hidden', visible.length > 0);
  }

  // ---- 详情抽屉 ----
  const drawer = el('aside', 'drawer closed');
  drawer.setAttribute('aria-label', '节点详情');
  document.body.append(drawer);

  function facts(node, now) {
    const m = node.metrics;
    const rows = [];
    const add = (k, v) => rows.push([k, v]);
    add('状态', `${STATUS_LABEL[statusOf(node, now)]}${statusNote(node, now) ? ' · ' + statusNote(node, now) : ''}`);
    add('系统', `${node.os || '—'} · ${node.kernel || '—'}`);
    add('处理器', `${node.cpu_name || '—'} · ${node.cpu_cores || 0} 核`);
    add('内存', m?.mem_total ? `${formatBytes(m.mem_used)} / ${formatBytes(m.mem_total)}` : '—');
    add('交换', m?.swap_total ? `${formatBytes(m.swap_used)} / ${formatBytes(m.swap_total)}` : '—');
    add('硬盘', m?.disk_total ? `${formatBytes(m.disk_used)} / ${formatBytes(m.disk_total)}` : '—');
    add('架构', `${node.arch || '—'} · ${node.virt || '—'}`);
    add('负载', m?.load ? m.load.map(x => x.toFixed(2)).join('  ') : '—');
    add('实时速率', m?.net_rx != null ? `↑ ${formatSpeed(m.net_tx)}  ↓ ${formatSpeed(m.net_rx)}` : '—');
    add('今日流量', `↑ ${formatBytes(node.day_tx)}  ↓ ${formatBytes(node.day_rx)}`);
    add('本月流量', `${formatBytes(monthUsage(node), 1)}${node.traffic_limit > 0 ? ` / ${formatBytes(node.traffic_limit, 0)}` : '（无限）'}`);
    add('累计流量', `↑ ${formatBytes(node.total_tx)}  ↓ ${formatBytes(node.total_rx)}`);
    add('续费', node.price > 0 ? `${node.price} ${node.currency} · ${node.billing_cycle}${expiringIn(node, now) != null ? ` · 还有 ${formatDays(expiringIn(node, now))}` : ''}` : '—');
    add('探针版本', node.agent_version || '未接入');
    add('连接数', m && (m.tcp != null || m.udp != null) ? `TCP ${m.tcp ?? '—'} · UDP ${m.udp ?? '—'} · 进程 ${m.procs ?? '—'}` : '—');
    add('运行时长', m?.uptime != null ? formatAge(m.uptime) : '—');
    if (staleFor(node, now)) add('读数停止', `${formatAge(staleFor(node, now))}前`);

    const dl = el('dl', 'facts');
    for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, v));
    return dl;
  }

  // ---- 详情抽屉：资源与延迟的历史曲线 ----
  //
  // 真探针页的核心是「历史」：当前值只能说明此刻，值班要看的是趋势与峰值。
  // 数据全部来自 hub 的历史接口（不加任何自己的推测），范围切换用缓存，60 秒内不重复请求。
  const RANGES = [
    { hours: 1, label: '1 小时' },
    { hours: 6, label: '6 小时' },
    { hours: 24, label: '24 小时' },
    { hours: 168, label: '7 天' },
  ];
  const detail = { tab: 'resources', hours: 6, loadedKey: '', loading: false, error: '', lastTryAt: 0, fetchedAt: 0, metrics: null, ping: null };
  const RETRY_AFTER_MS = 30_000;

  const PROBE_COLORS = ['var(--c-ping-1)', 'var(--c-ping-2)', 'var(--c-ping-3)', 'var(--c-ping-4)'];
  const RES_CHARTS = [
    { key: 'cpu', label: 'CPU', color: 'var(--c-cpu)', format: (v) => `${v.toFixed(0)}%`, yMax: 100 },
    { key: 'mem', label: '内存', color: 'var(--c-mem)', format: (v) => `${v.toFixed(0)}%`, yMax: 100 },
    { key: 'disk', label: '硬盘', color: 'var(--c-disk)', format: (v) => `${v.toFixed(0)}%`, yMax: 100 },
    { key: 'net', label: '网络', color: 'var(--c-up)', format: (v) => formatSpeed(v), net: true },
  ];

  /** 历史行只有 used 没有 total，百分比得用节点当前的 total 算（总量基本不变）。 */
  function withPct(rows, node) {
    const memTotal = node.metrics?.mem_total || node.mem_total || 0;
    const diskTotal = node.metrics?.disk_total || node.disk_total || 0;
    return rows.map(r => ({
      ...r,
      mem: r.mem_used != null && memTotal ? (r.mem_used / memTotal) * 100 : null,
      disk: r.disk_used != null && diskTotal ? (r.disk_used / diskTotal) * 100 : null,
    }));
  }

  /** 把实时推送的当前值接到历史尾巴上，并标记出来（陈旧读数不混进来）。 */
  function withLive(rows, node) {
    const m = node.metrics;
    if (!m || staleFor(node, nowSec())) return { rows, liveIndex: -1 };
    const last = rows[rows.length - 1];
    if (last && Date.now() - last.ts < 60_000) return { rows, liveIndex: -1 };   // 刚有的点，别叠
    const memTotal = node.metrics?.mem_total || node.mem_total || 0;
    const diskTotal = node.metrics?.disk_total || node.disk_total || 0;
    const row = {
      ts: Date.now(),
      cpu: m.cpu ?? null,
      net_rx: m.net_rx ?? null,
      net_tx: m.net_tx ?? null,
      mem: m.mem_used != null && memTotal ? (m.mem_used / memTotal) * 100 : null,
      disk: m.disk_used != null && diskTotal ? (m.disk_used / diskTotal) * 100 : null,
    };
    return { rows: [...rows, row], liveIndex: rows.length };
  }

  /** 一块统计条：每个序列一格，颜色点 + 名称 + 当前/均值/峰值 —— 它同时充当图例。 */
  function statsStrip(series, rows, liveIndex) {
    const box = el('div', 'series-stats');
    for (const s of series) {
      const vals = rows.map(r => r[s.key]);
      const st = seriesStats(vals);
      const cur = liveIndex >= 0 ? rows[liveIndex][s.key] : st.last;
      const cell = el('div', 'sstat');
      const head = el('div', 'sstat-h');
      const dot = el('i');
      dot.style.background = s.color;
      head.append(dot, el('span', null, s.label));
      const nums = el('div', 'sstat-n');
      nums.append(
        el('b', null, cur == null ? '—' : s.format(cur)),
        el('span', null, `均值 ${st.avg == null ? '—' : s.format(st.avg)}`),
        el('span', null, `峰值 ${st.max == null ? '—' : s.format(st.max)}`),
      );
      cell.append(head, nums);
      box.append(cell);
    }
    return box;
  }

  function chartsArea(node) {
    const area = el('div', 'charts');
    const width = Math.max(300, drawer.clientWidth - 34);

    if (detail.loading) {
      area.append(el('p', 'sub', '正在读历史数据…'));
      return area;
    }
    if (detail.error) {
      area.append(el('p', 'sub err', `历史接口读不到：${detail.error}（当前值仍然实时）`));
      return area;
    }

    if (detail.tab === 'latency') {
      const p = detail.ping;
      if (!p) { area.append(el('p', 'sub', '延迟数据未加载')); return area; }
      if (!p.ids.length) { area.append(el('p', 'sub', '这台机器没有延迟探测数据')); return area; }
      const rows = alignByTs(p.points, p.ids);
      const series = p.ids.map((id, i) => ({
        key: `p${id}`,
        label: p.probes[id] || `探测线 ${id}`,
        color: PROBE_COLORS[i % PROBE_COLORS.length],
        format: (v) => `${v.toFixed(0)}ms`,
      }));
      const wrap = el('div', 'chart-block');
      wrap.append(el('h3', null, `延迟（${detail.hours} 小时${detail.windowNote || ''}）`));
      const host = el('div', 'chart-host');
      wrap.append(host, statsStrip(series, rows, -1));
      // 丢包：hub 给的是每条线的整体比值
      const losses = p.ids
        .map(id => `${p.probes[id] || id} ${p.loss[id] == null ? '丢包 —' : `${(p.loss[id] * 100).toFixed(1)}%`}`)
        .join(' · ');
      wrap.append(el('p', 'sub', `丢包：${losses}`));
      area.append(wrap);
      renderChart(host, { rows, series, hours: detail.hours, height: 140 });
      return area;
    }

    const m = detail.metrics;
    if (!m) { area.append(el('p', 'sub', '历史数据未加载')); return area; }
    const { rows: withLiveRows, liveIndex } = withLive(withPct(m.rows, node), node);
    if (!withLiveRows.length) {
      area.append(el('p', 'sub', '这段时间没有历史数据（机器可能一直没上报）'));
      return area;
    }
    for (const c of RES_CHARTS) {
      const block = el('div', 'chart-block');
      const host = el('div', 'chart-host');
      const series = c.net
        ? [
          { key: 'net_tx', label: '上行', color: 'var(--c-up)', format: (v) => formatSpeed(v) },
          { key: 'net_rx', label: '下行', color: 'var(--c-down)', format: (v) => formatSpeed(v) },
        ]
        : [{ key: c.key, label: c.label, color: c.color, format: c.format }];
      block.append(el('h3', null, `${c.label}（${detail.hours} 小时${detail.windowNote || ''}）`), host,
        statsStrip(series, withLiveRows, liveIndex));
      area.append(block);
      renderChart(host, { rows: withLiveRows, series, hours: detail.hours, height: c.net ? 130 : 120, yMax: c.yMax, marker: { index: liveIndex } });
    }
    area.append(el('p', 'sub', `曲线来自 hub 的历史接口；末端的圆点是最近一次实时推送。${m.rows.some(r => r.cpu == null) ? ' 有空档说明当时没有上报。' : ''}`));
    return area;
  }

  const rangeFor = () => (detail.tab === 'latency' ? RANGES.filter(r => r.hours <= 24) : RANGES);

  /** 只在「节点 + 页签 + 范围」这个组合变了的时候才去拉数据。 */
  async function ensureDetailLoaded(node) {
    const key = `${node.id}|${detail.tab}|${detail.hours}`;
    if (detail.loadedKey === key && !detail.error) return false;
    detail.loadedKey = key;
    detail.loading = true;
    detail.error = '';
    detail.windowNote = '';
    detail.lastTryAt = Date.now();
    const width = Math.max(300, drawer.clientWidth - 34);
    try {
      if (detail.tab === 'latency') {
        detail.ping = await nodeHistory.ping(node.id, detail.hours, width);
        if (detail.ping.hours !== detail.hours) detail.windowNote = `，主控只给了 ${detail.ping.hours} 小时`;
      } else {
        detail.metrics = await nodeHistory.metrics(node.id, detail.hours, width);
        if (detail.metrics.hours !== detail.hours) detail.windowNote = `，主控只给了 ${detail.metrics.hours} 小时`;
      }
    } catch (e) {
      detail.error = e.message || '读取失败';
    }
    detail.loading = false;
    if (!detail.error) detail.fetchedAt = Date.now();
    return true;
  }

  /**
   * 该不该去拉历史。两种情形：换了节点/页签/范围（key 变了），或者上次失败了
   * 但已经过了退避时间 —— 失败后每 2 秒的推送都重试一次会变成重试风暴。
   */
  function detailKeyChanged(node) {
    const key = `${node.id}|${detail.tab}|${detail.hours}`;
    if (detail.loadedKey !== key) return true;
    return !!detail.error && Date.now() - detail.lastTryAt > RETRY_AFTER_MS;
  }

  function renderDrawer({ refresh = true } = {}) {
    const node = state.nodes.find(n => n.id === state.open);
    if (!node) { drawer.classList.add('closed'); return; }
    const now = nowSec();

    const head = el('header');
    const flag = el('span', 'card-flag');
    flag.append(flagEl(node.country));
    const h2 = el('h2', null, node.name);
    const pill = el('span', `pill ${statusOf(node, now)}`, STATUS_LABEL[statusOf(node, now)]);
    const reload = el('button', 'ghost icon', '⟳');
    reload.type = 'button';
    reload.title = '重新读取历史';
    reload.disabled = detail.loading;
    reload.onclick = () => {
      // 假 hub 的历史是确定性的（同参数同结果），所以「看起来没变」是正常的 ——
      // 刷新必须给出可见反馈：「更新于 hh:mm:ss」那行会变，按钮也会转成禁用态
      nodeHistory.invalidate(node.id);
      detail.loadedKey = '';
      void renderDrawer();
    };
    const close = el('button', 'ghost icon', '✕');
    close.type = 'button';
    close.title = '关闭';
    close.onclick = closeDetail;
    head.append(flag, h2, pill, reload, close);

    const tabs = el('div', 'tabs');
    for (const [key, label] of [['resources', '资源'], ['latency', '网络延迟']]) {
      const b = el('button', 'tab', label);
      b.type = 'button';
      b.setAttribute('aria-selected', String(detail.tab === key));
      b.onclick = () => {
        if (detail.tab === key) return;
        detail.tab = key;
        if (key === 'latency' && detail.hours > 24) detail.hours = 24;
        detail.loadedKey = '';
        writeUrl();
        void renderDrawer();
      };
      tabs.append(b);
    }

    const ranges = el('div', 'ranges');
    for (const r of rangeFor()) {
      const b = el('button', 'range', r.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(detail.hours === r.hours));
      b.onclick = () => {
        if (detail.hours === r.hours) return;
        detail.hours = r.hours;
        detail.loadedKey = '';
        writeUrl();
        void renderDrawer();
      };
      ranges.append(b);
    }

    const stamp = el('p', 'sub fetched');
    if (detail.loading) stamp.textContent = '正在读取历史…';
    else if (detail.error) stamp.textContent = `历史读取失败：${detail.error}`;
    else if (detail.fetchedAt) stamp.textContent = `历史更新于 ${new Date(detail.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}（点右上角 ⟳ 重新读取）`;
    else stamp.textContent = '尚未读取历史';

    const body = el('div', 'body');
    body.append(tabs, ranges, stamp, chartsArea(node), facts(node, now));

    drawer.replaceChildren(head, body);
    drawer.classList.remove('closed');

    // 打开或切换范围/页签时才请求历史；2 秒一次的推送只走重画
    if (refresh && detailKeyChanged(node)) {
      void ensureDetailLoaded(node).then((changed) => { if (changed) void renderDrawer({ refresh: false }); });
    }
  }

  function openDetail(id) {
    state.open = id;
    writeUrl();
    renderDrawer();
  }
  function closeDetail() {
    state.open = null;
    writeUrl();
    drawer.classList.add('closed');
  }

  function setFilter(f) {
    state.filter = f;
    writeUrl();
    renderChips();
    renderList();
  }

  // ---- 对外 ----
  function setNodes(nodes) {
    state.nodes = nodes;
    renderSummary();
    renderChips();
    renderCountryOptions();
    renderList();
    if (state.open != null) renderDrawer();
  }

  function setConn(stateName, detail) {
    const c = $('conn');
    const label = {
      live: '实时', polling: '轮询', connecting: '连接中', reconnecting: '重连中',
      error: '连接失败', closed: '公开页已关闭',
    }[stateName] || stateName;
    c.textContent = detail && stateName === 'reconnecting' ? `${label} · ${detail}` : label;
    c.className = `conn ${stateName}`;
    c.title = `数据来源：${label}${detail ? ' · ' + detail : ''}`;
  }

  function setSiteName(name) {
    if (name) $('site-name').textContent = `🐔 ${name}`;
  }

  function init() {
    mountFlagSprite();
    readUrl();
    renderSortOptions();
    sortEl.value = state.sort;
    qEl.value = state.q;
    if (state.view === 'list') gridEl.classList.add('list');
    for (const b of document.querySelectorAll('.viewtoggle button')) {
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
    }

    chipsEl.addEventListener('click', () => {});
    countryEl.onchange = () => { state.country = countryEl.value; writeUrl(); renderList(); };
    sortEl.onchange = () => { state.sort = sortEl.value; writeUrl(); renderList(); };
    let qt = null;
    qEl.oninput = () => {
      clearTimeout(qt);
      // 每敲一个字就全量重排会让输入变卡，等手停一下再排
      qt = setTimeout(() => { state.q = qEl.value; writeUrl(); renderList(); }, 140);
    };
    for (const b of document.querySelectorAll('.viewtoggle button')) {
      b.onclick = () => {
        state.view = b.dataset.view;
        gridEl.classList.toggle('list', state.view === 'list');
        for (const x of document.querySelectorAll('.viewtoggle button')) {
          x.setAttribute('aria-pressed', String(x.dataset.view === state.view));
        }
        writeUrl();
      };
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });
    $('farm-btn').onclick = () => onEnterFarm?.();
    const themeBtn = $('theme-btn');
    themeBtn.onclick = () => {
      const dark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('chicken-probe:theme', dark ? 'dark' : 'light');
    };
    if (state.open != null) renderDrawer();
  }

  init();
  // 调试缝（与鸡场同一套做法）：只有带 ?dbg=1 打开才暴露，常态页面不留全局
  if (location.search.includes('dbg=1')) {
    window.__panelDebug = () => ({
      detail: { tab: detail.tab, hours: detail.hours, key: detail.loadedKey, loading: detail.loading, error: detail.error,
        hasMetrics: !!detail.metrics, hasPing: !!detail.ping, windowNote: detail.windowNote || '' },
      open: state.open,
      sparks: [...sparks.entries()].slice(0, 3).map(([id, v]) => ({ id, at: v.t, rows: v.rows?.length ?? -1 })),
      sparkHosts: [...cards.entries()].slice(0, 3).map(([id, c]) => ({ id, hasHost: !!c.sparkHost, children: c.sparkHost?.childElementCount ?? -1 })),
      sparkQueue: sparkQueue.length,
    });
  }
  return { setNodes, setConn, setSiteName, openDetail, closeDetail, refresh: renderList };
}