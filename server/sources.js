// 联机服务的两个数据源：
//   探针鸡 ← monitor hub 的公开接口（默认读本机 127.0.0.1，因为联机服务与主控同机部署）
//   网站鸡 ← 配置里的 URL 列表，服务自己定期探测（hub 不管网站，这里补上）
//
// 探针鸡用的是 hub 的公开读接口，匿名可读；这也意味着主控那边的「公开页」要是关的，
// 这里就读不到，README 里写明了。

const NODE_POLL_MS = 2000;
const WEB_POLL_MS = 15000;
const WEB_TIMEOUT_MS = 6000;
const WEB_SLOW_MS = 1500;

/** 读 hub 的节点列表。失败不清空上一份数据：网络抖一下不该让满场鸡消失。 */
export function createHubSource({ url, intervalMs = NODE_POLL_MS, onNodes, log = console } = {}) {
  let nodes = [];
  let timer = null;
  let stopped = false;
  let failures = 0;

  async function poll() {
    try {
      const res = await fetch(new URL('/api/nodes', url), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(3000, intervalMs - 500)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.nodes)) {
        nodes = data.nodes;
        failures = 0;
        onNodes?.(nodes);
      }
    } catch (e) {
      failures++;
      // 每 15 次失败报一句（约半分钟），别把日志刷满
      if (failures === 1 || failures % 15 === 0) {
        log.warn(`[hub] 读取 ${url} 失败 ${failures} 次：${e.message}（继续用上一份数据）`);
      }
    }
  }

  return {
    get nodes() { return nodes; },
    get failures() { return failures; },
    start() {
      stopped = false;
      void poll();
      timer = setInterval(() => { if (!stopped) void poll(); }, intervalMs);
      return this;
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}

/**
 * 网站鸡：探测配置里的 URL，量延迟、判存活。
 * 空列表就一只网站鸡都没有 —— 不拿第三方站点当默认值。
 */
export function createWebSource({ sites = [], intervalMs = WEB_POLL_MS, onUpdate, log = console } = {}) {
  const state = sites.map((s, i) => ({
    id: `w${i}`,
    name: s.name || new URL(s.url, 'http://x').hostname,
    url: s.url,
    ok: null,
    latency: null,
    checkedAt: 0,
  }));
  let timer = null;

  async function probe(one) {
    const t0 = performance.now();
    try {
      const res = await fetch(one.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
        headers: { 'user-agent': 'chicken-probe/0.1 (+monitor theme website check)' },
      });
      one.latency = Math.round(performance.now() - t0);
      // 4xx/5xx 也算「站点应答了但状态不对」：能连上就不算死，但要点出来
      one.ok = res.status < 400;
      one.status = res.status;
    } catch (e) {
      one.ok = false;
      one.latency = null;
      one.status = 0;
      one.error = e.name === 'TimeoutError' ? '超时' : e.message;
    }
    one.checkedAt = Date.now();
  }

  async function pollAll() {
    await Promise.all(state.map(probe));
    onUpdate?.(state);
  }

  return {
    get sites() { return state; },
    get summary() {
      const online = state.filter(s => s.ok === true).length;
      return { total: state.length, online };
    },
    start() {
      if (!state.length) return this;
      void pollAll();
      timer = setInterval(() => void pollAll(), intervalMs);
      return this;
    },
    stop() { clearInterval(timer); },
  };
}

export const WEB_SLOW_MS_REF = WEB_SLOW_MS;