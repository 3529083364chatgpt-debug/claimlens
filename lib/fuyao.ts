// ─── 扶摇 REST 客户端（确定性 JSON 数据源，首选） ─────────────────
const BASE = process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn';

export interface FuyaoResult<T = unknown> {
  ok: boolean;
  status: number;
  request_id?: string | null;
  message?: string;
  data: T | null;
  raw: string; // 原始返回截断，用于证据卡片
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 网络抖动 / 限流属可恢复故障：退避重试，避免单次失败直接污染核验结论
const MAX_ATTEMPTS = 3;

export async function fuyaoGet<T = unknown>(
  pathname: string,
  params: Record<string, string | number | undefined | null>,
): Promise<FuyaoResult<T>> {
  const key = process.env.FUYAO_API_KEY || '';
  if (!key) {
    return { ok: false, status: 0, message: 'FUYAO_API_KEY 未配置', data: null, raw: '' };
  }
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let last: FuyaoResult<T> = { ok: false, status: 0, message: '未发起请求', data: null, raw: '' };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(700 * attempt); // 退避 700ms / 1400ms
    try {
      const res = await fetch(url, {
        headers: { 'X-api-key': key },
        signal: AbortSignal.timeout(20000),
        cache: 'no-store',
      });
      const text = await res.text();
      let json: { code?: number; message?: string; request_id?: string; data?: T } | null = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      // HTTP 429 或业务码 4001（限流）：退避后重试
      if ((res.status === 429 || json?.code === 4001) && attempt < MAX_ATTEMPTS - 1) {
        last = { ok: false, status: res.status, request_id: json?.request_id ?? null, message: `code=${json?.code ?? res.status} ${json?.message ?? '限流'}`, data: (json?.data as T) ?? null, raw: text.slice(0, 4000) };
        continue;
      }
      if (!res.ok || !json || typeof json.code !== 'number') {
        return { ok: false, status: res.status, message: `HTTP ${res.status}`, data: (json?.data as T) ?? null, raw: text.slice(0, 4000) };
      }
      if (json.code !== 0) {
        // 2001 无 key / 2003 无权限 / 1001 缺参 / 4001 限流
        return { ok: false, status: res.status, request_id: json.request_id ?? null, message: `code=${json.code} ${json.message ?? ''}`, data: (json.data as T) ?? null, raw: text.slice(0, 4000) };
      }
      return { ok: true, status: res.status, request_id: json.request_id ?? null, message: json.message, data: json.data ?? null, raw: text.slice(0, 4000) };
    } catch (e) {
      const err = e as Error;
      const msg = err?.name === 'TimeoutError' ? '请求超时(20s)' : `网络异常: ${String(err?.message || e)}`;
      last = { ok: false, status: 0, message: msg, data: null, raw: '' };
      if (attempt < MAX_ATTEMPTS - 1) continue; // 连接失败：退避后重试
      return last;
    }
  }
  return last;
}

// 名称/简称 → thscode 消歧
export async function tickersSearch(q: string, asset_type = 'a-share') {
  return fuyaoGet<{ item?: { thscode: string; name: string; asset_type: string }[] }>(
    '/api/meta/tickers/search', { q, asset_type, limit: 5 },
  );
}

// 最新行情快照
export interface PriceSnapshotItem {
  thscode: string; last_price: number; price_change: number;
  price_change_ratio_pct: number; open_price: number; high_price: number;
  low_price: number; prev_price: number; volume: number; turnover: number;
}
export async function pricesSnapshot(thscodes: string) {
  return fuyaoGet<{ timestamp: number; item: PriceSnapshotItem[] }>(
    '/api/a-share/prices/snapshot', { thscodes },
  );
}

// 历史日 K（原始价，不复权）
export interface HistoricalItem { date_ms: number; close_price: number; open_price: number; high_price: number; low_price: number; volume: number }
export async function pricesHistorical(thscode: string, startMs: number, endMs: number) {
  return fuyaoGet<{ item: HistoricalItem[]; thscode: string; interval: string }>(
    '/api/a-share/prices/historical', { thscode, interval: '1d', start: startMs, end: endMs },
  );
}

// 财务指标（report 形如 2025-2 表示 2025 中报）
export interface FinancialAbilities { ability: string; indicators: { index_id: string; value: string | number | null }[] }
export async function financialIndicators(thscode: string, report: string) {
  return fuyaoGet<{ thscode: string; report: string; abilities: FinancialAbilities[] }>(
    '/api/a-share/financials/indicators', { thscode, report },
  );
}
