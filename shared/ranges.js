// 历史范围按钮的取值：主控保留多久，按钮就铺到多久。
//
// 单独一个模块而不是塞在 panel.js 里，因为这三件事都是纯函数、都值得直接测：
// 保留期怎么变成按钮、选中的窗口在按钮列表变了之后落到哪、以及小时数怎么说成
// 人话。面板与抽屉两处都要用同一份判断，抄两遍必然出现「按钮写 30 天、图里 7 天」。

/*
 * 兜底是 7 天，这不是随便挑的：hub 从 v1.0.0 起就把匿名访客的历史窗口夹在
 * 7 天（168 小时），而 history_days 这个字段要到 v1.3.2 才有。也就是说「拿不到
 * 保留期」的那些 hub，真实保留期恰好就是 7 天 —— 兜底值同时是老 hub 的正解。
 */
export const BASE_RANGES = [
  { hours: 1, label: '1 小时' },
  { hours: 6, label: '6 小时' },
  { hours: 24, label: '24 小时' },
  { hours: 168, label: '7 天' },
];

/**
 * 按主控的保留期生成范围按钮。保留期不比 7 天长时不多给按钮：多出来的那个
 * 窗口请求出去只会被主控夹回来，按钮写着 30 天、图里 7 天，比不给这个按钮更糟。
 * 保留期是垃圾值（缺字段、0、负数、NaN）时同样退回基础列表。
 */
export function rangesFor(days) {
  const kept = Math.floor(Number(days));
  if (!Number.isFinite(kept) || kept < 1) return BASE_RANGES;
  const hours = kept * 24;
  if (hours <= 168) return BASE_RANGES;
  return [...BASE_RANGES, { hours, label: kept >= 365 ? '1 年' : `${kept} 天` }];
}

/** 延迟页签看不了长窗口：一次探测是几十毫秒的事，摊到 7 天里只是一条平线。 */
export function rangesOn(offers, tab) {
  return tab === 'latency' ? offers.filter((r) => r.hours <= 24) : offers;
}

/**
 * 选中的窗口不在列表里时（页签把长窗口滤掉了、主控的保留期缩了、深链写了个
 * 别的数）退到最宽的那个 —— 退到最宽而不是第一个，因为用户当初挑的就是「尽量
 * 长」，缩水比换成 1 小时更贴近他的意思。
 */
export function spanFor(offers, picked) {
  return offers.some((r) => r.hours === picked) ? picked : offers[offers.length - 1].hours;
}

/** 小时数说成人话：168 说成 7 天，读的人不用自己去除。 */
export function spanLabel(hours) {
  return hours >= 48 ? `${Math.round(hours / 24)} 天` : `${hours} 小时`;
}

/*
 * 覆盖度那句话里的时长是**分钟**（step/60），不是小时，所以不能拿 spanLabel 说：
 * 60 分钟会被它当成 60 小时去换算，说成「3 天」。单位不同的两个数不能共用一个
 * 格式化函数 —— 这个错只有真跑起来看那句话才会暴露。
 */
export function minutesLabel(mins) {
  return mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${Math.round(mins)} 分钟`;
}
