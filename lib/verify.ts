// ─── 核验引擎：论断 → 工具调用 → 确定性比对 → 证据 ────────────────
// 原则：LLM 不参与数值比对；解析失败/数据缺失一律 unverifiable，绝不猜测。
import type { Claim, ClaimResult, Evidence, EvidenceField, Verdict } from './types';
import { tickersSearch, pricesSnapshot, pricesHistorical, financialIndicators, type HistoricalItem } from './fuyao';
import { ifindCall } from './ifind';

const D = 86400000;

const UNIT_MULT: Record<string, number> = {
  '元': 1, '': 1, '亿': 1e8, '亿元': 1e8, '万亿元': 1e12, '万亿': 1e12, '万': 1e4, '万元': 1e4, '%': 1,
};

function toBase(v: number | null, unit: string): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return v * (UNIT_MULT[unit] ?? 1);
}

function fmtDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(ms));
}

function ev(source: Evidence['source'], api: string, params: Record<string, unknown> | null, raw: string, fields: EvidenceField[], requestId?: string | null): Evidence {
  return {
    source, api, params: params ?? undefined, request_id: requestId ?? null,
    retrieved_at: new Date().toISOString(),
    raw_excerpt: raw.slice(0, 4000), fields,
  };
}

interface Opts { actual?: number | null; actualDisplay?: string | null; deviation?: number | null; evidence?: Evidence | null }

function res(claim: Claim, verdict: Verdict, reason: string, o: Opts = {}): ClaimResult {
  return {
    claim, verdict, reason,
    actual: o.actual ?? null,
    actual_display: o.actualDisplay ?? null,
    deviation_pct: o.deviation ?? null,
    evidence: o.evidence ?? null,
    reviewed: null, review_note: null,
  };
}

function judge(claim: Claim, actual: number, tolRel: number, unitNote: string, evidence: Evidence, dateNote: string): ClaimResult {
  const cmp: string = claim.comparison ?? 'approx';
  const expectedBase = toBase(claim.value, claim.unit);
  if (expectedBase === null) return res(claim, 'unverifiable', '论断中未提取到可比数值', { evidence, actual, actualDisplay: `${actual}${unitNote}（${dateNote}）` });
  const deviation = expectedBase === 0 ? (actual === 0 ? 0 : Infinity) : (expectedBase - actual) / Math.abs(actual);
  const devTxt = Number.isFinite(deviation) ? `${(deviation * 100).toFixed(2)}%` : '∞';
  const actualDisplay = `${actual}${unitNote}（${dateNote}）`;
  if (cmp === 'gte') {
    return actual >= expectedBase
      ? res(claim, 'verified', `论断为"不低于/超过 ${claim.value}${claim.unit}"，实际 ${actual}${unitNote}，满足（${dateNote}）`, { actual, actualDisplay, deviation, evidence })
      : res(claim, 'conflict', `论断称"超过 ${claim.value}${claim.unit}"，实际 ${actual}${unitNote}，未达到（${dateNote}）`, { actual, actualDisplay, deviation, evidence });
  }
  if (cmp === 'lte') {
    return actual <= expectedBase
      ? res(claim, 'verified', `论断为"低于/不超过 ${claim.value}${claim.unit}"，实际 ${actual}${unitNote}，满足（${dateNote}）`, { actual, actualDisplay, deviation, evidence })
      : res(claim, 'conflict', `论断称"低于 ${claim.value}${claim.unit}"，实际 ${actual}${unitNote}，超出（${dateNote}）`, { actual, actualDisplay, deviation, evidence });
  }
  const hit = Math.abs(deviation) <= tolRel;
  return hit
    ? res(claim, 'verified', `论断 ${claim.value}${claim.unit} 与数据源 ${actual}${unitNote} 一致（容差 ${(tolRel * 100).toFixed(1)}%，${dateNote}）`, { actual, actualDisplay, deviation, evidence })
    : res(claim, 'conflict', `论断 ${claim.value}${claim.unit} 与数据源 ${actual}${unitNote} 不一致，偏差 ${devTxt}（${dateNote}）`, { actual, actualDisplay, deviation, evidence });
}

// ── 主体解析：代码直接用，否则名称 → 扶摇消歧 ────────────────────
async function resolveCode(claim: Claim): Promise<string | null> {
  if (claim.subject_code && /^\d{6}\.(SH|SZ|BJ)$/i.test(claim.subject_code)) return claim.subject_code.toUpperCase();
  if (!claim.subject_name) return null;
  const r = await tickersSearch(claim.subject_name, 'a-share');
  if (r.ok && r.data?.item?.length) {
    const hit = r.data.item.find((i) => i.name === claim.subject_name) ?? r.data.item[0];
    if (hit?.thscode) return hit.thscode;
  }
  return null;
}

// ── markdown 表格解析（iFinD 返回） ──────────────────────────────
interface MdTable { headers: string[]; rows: string[][] }
function parseMdTables(text: string): MdTable[] {
  const lines = text.split('\n');
  const tables: MdTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
        i++;
      }
      if (rows.length >= 2) tables.push({ headers: rows[0], rows: rows.slice(1) });
    } else i++;
  }
  return tables;
}

function num(s: string): number | null {
  const v = Number(String(s).replace(/[,，%\s]/g, ''));
  return Number.isFinite(v) ? v : null;
}

// ── 各类型核验 ──────────────────────────────────────────────────

async function verifyMarketQuote(claim: Claim): Promise<ClaimResult> {
  const code = await resolveCode(claim);
  if (!code) return res(claim, 'unverifiable', '无法定位证券主体（名称未能消歧且原文无代码）');
  const m = claim.metric;
  if (m === 'close_price' || (m === 'last_price' && claim.as_of)) {
    if (!claim.as_of) return res(claim, 'unverifiable', '论断未指明日期，无法回溯历史收盘价');
    const t = Date.parse(claim.as_of + 'T00:00:00+08:00');
    if (!Number.isFinite(t)) return res(claim, 'unverifiable', `日期无法解析: ${claim.as_of}`);
    const r = await pricesHistorical(code, t - 4 * D, t + 4 * D);
    const evidence = ev('fuyao', 'GET /api/a-share/prices/historical', { thscode: code, interval: '1d', around: claim.as_of }, r.raw, [
      { label: '数据源', value: '扶摇 A 股历史K线（前复权）' },
      { label: '查询代码', value: code },
      { label: '论断日期', value: claim.as_of },
    ], r.request_id);
    if (!r.ok) return res(claim, 'error', `行情接口失败：${r.message ?? '未知'}`, { evidence });
    const items: HistoricalItem[] = r.data?.item ?? [];
    const hit = items.find((i) => fmtDate(i.date_ms) === claim.as_of);
    if (!hit) return res(claim, 'unverifiable', '该日期无交易数据（非交易日或超出数据范围）', { evidence, actual: null, actualDisplay: '无数据' });
    return judge(claim, hit.close_price, 0.005, '元', evidence, `${claim.as_of} 收盘价，前复权`);
  }
  if (m === 'last_price' || m === 'price_change_pct' || m === 'volume' || m === 'turnover') {
    const r = await pricesSnapshot(code);
    const item = r.data?.item?.[0];
    const snapTime = r.data?.timestamp ? new Date(r.data.timestamp).toISOString() : new Date().toISOString();
    const evidence = ev('fuyao', 'GET /api/a-share/prices/snapshot', { thscodes: code }, r.raw, [
      { label: '数据源', value: '扶摇 A 股实时行情快照' },
      { label: '查询代码', value: code },
      { label: '快照时间', value: snapTime },
    ], r.request_id);
    if (!r.ok) return res(claim, 'error', `行情接口失败：${r.message ?? '未知'}`, { evidence });
    if (!item) return res(claim, 'unverifiable', '快照无该标的数据', { evidence });
    if (m === 'price_change_pct') {
      if (claim.as_of) {
        // 历史涨跌幅：用日 K 收盘价与前收计算
        const t = Date.parse(claim.as_of + 'T00:00:00+08:00');
        const hr = await pricesHistorical(code, t - 5 * D, t + D);
        const its: HistoricalItem[] = hr.ok ? hr.data?.item ?? [] : [];
        const idx = its.findIndex((i) => fmtDate(i.date_ms) === claim.as_of);
        if (idx > 0) {
          const chg = (its[idx].close_price / its[idx - 1].close_price - 1) * 100;
          return judge(claim, Number(chg.toFixed(4)), 0.05, '%', evidence, `${claim.as_of} 涨跌幅（据前收盘计算）`);
        }
        return res(claim, 'unverifiable', '无法取得该日期及前收盘数据，无法计算涨跌幅', { evidence });
      }
      return judge(claim, item.price_change_ratio_pct, 0.05, '%', evidence, `快照涨跌幅，时点 ${snapTime}`);
    }
    if (m === 'last_price') return judge(claim, item.last_price, 0.005, '元', evidence, `快照最新价，时点 ${snapTime}`);
    if (m === 'volume') return judge(claim, item.volume, 0.1, '股', evidence, `快照成交量（单位：股），时点 ${snapTime}`);
    return judge(claim, item.turnover, 0.1, '元', evidence, `快照成交额（单位：元），时点 ${snapTime}`);
  }
  return res(claim, 'unverifiable', `暂不支持该行情指标: ${claim.metric_label || claim.metric}`);
}

const VALUATION_COL: Record<string, string> = {
  pe_ttm: '市盈率', pb: '市净率', ps_ttm: '市销率', total_mv: '总市值', circ_mv: '流通市值',
};

async function verifyValuation(claim: Claim): Promise<ClaimResult> {
  if (!claim.subject_name && !claim.subject_code) return res(claim, 'unverifiable', '论断未指明证券主体');
  const name = claim.subject_name || claim.subject_code || '';
  const r = await ifindCall('stock', 'get_stock_summary', { query: `${name}的市盈率、市净率、总市值` });
  const mdText = typeof r.payload?.data === 'string' ? r.payload.data : '';
  const evidence = ev('ifind', 'iFinD stock.get_stock_summary', { query: `${name}的市盈率、市净率、总市值` }, mdText || r.raw, [
    { label: '数据源', value: '同花顺 iFinD 股票摘要（最新估值/市值）' },
    { label: '口径说明', value: 'iFinD 返回的最新快照估值，PE 为 TTM 口径' },
  ]);
  if (!r.ok) return res(claim, 'error', `估值接口失败：${r.message ?? '未知'}`, { evidence });
  const keyword = VALUATION_COL[claim.metric];
  if (!keyword) return res(claim, 'unverifiable', `暂不支持该估值指标: ${claim.metric_label || claim.metric}`, { evidence });
  const tables = parseMdTables(mdText);
  for (const t of tables) {
    const colIdx = t.headers.findIndex((h) => h.includes(keyword));
    if (colIdx < 0) continue;
    const nameIdx = t.headers.findIndex((h) => h.includes('证券简称'));
    const codeIdx = t.headers.findIndex((h) => h.includes('证券代码'));
    const row = t.rows.find((rw) =>
      (claim.subject_code && codeIdx >= 0 && rw[codeIdx]?.toUpperCase() === claim.subject_code?.toUpperCase()) ||
      (claim.subject_name && nameIdx >= 0 && rw[nameIdx]?.includes(claim.subject_name)),
    ) ?? (t.rows.length === 1 ? t.rows[0] : undefined);
    if (!row) continue;
    const actual = num(row[colIdx] ?? '');
    if (actual === null) continue;
    const unitNote = claim.metric === 'total_mv' || claim.metric === 'circ_mv' ? '元' : '';
    return judge(claim, actual, 0.01, unitNote, evidence, 'iFinD 最新估值快照');
  }
  return res(claim, 'unverifiable', '估值摘要返回中未能定位该指标（口径或主体不匹配）', { evidence });
}

// 扶摇 financials/indicators 指标映射
const FIN_INDEX: Record<string, string> = {
  operating_income_yoy: 'calculate_operating_income_yoy_growth_ratio',
  net_profit_yoy: 'calculate_parent_holder_net_profit_yoy_growth_ratio',
  roe: 'index_weighted_avg_roe',
  roe_deducted: 'index_deduct_weighted_avg_roe',
  gross_margin: 'sale_gross_margin',
  net_margin: 'sale_net_interest_ratio',
  debt_ratio: 'assets_debt_ratio',
  total_assets_yoy: 'total_assets_growth_ratio',
};

function periodToReport(period: string | null): string | null {
  if (!period) return null;
  const m = period.match(/^(\d{4})/);
  if (!m) return null;
  const y = m[1];
  if (period.endsWith('Q1')) return `${y}-1`;
  if (period.endsWith('H1') || period.endsWith('Q2')) return `${y}-2`;
  if (period.endsWith('Q3')) return `${y}-3`;
  if (period.endsWith('Q4') || period.endsWith('年报')) return `${y}-4`;
  return null;
}

async function verifyFinancial(claim: Claim): Promise<ClaimResult> {
  const report = periodToReport(claim.period);
  if (!report) return res(claim, 'unverifiable', '财务论断缺少报告期（period），无法确定数据口径');
  const indexId = FIN_INDEX[claim.metric];
  if (!indexId) return res(claim, 'unverifiable', `暂无该财务指标的标准化映射: ${claim.metric_label || claim.metric}`);
  const code = await resolveCode(claim);
  if (!code) return res(claim, 'unverifiable', '无法定位证券主体');
  const r = await financialIndicators(code, report);
  const evidence = ev('fuyao', 'GET /api/a-share/financials/indicators', { thscode: code, report }, r.raw, [
    { label: '数据源', value: '扶摇 A 股财务指标（整体合并口径）' },
    { label: '标的', value: code },
    { label: '报告期', value: report },
    { label: '指标 index_id', value: indexId },
  ], r.request_id);
  if (!r.ok) return res(claim, 'error', `财务接口失败：${r.message ?? '未知'}`, { evidence });
  for (const ab of r.data?.abilities ?? []) {
    for (const ind of ab.indicators) {
      if (ind.index_id === indexId) {
        const actual = typeof ind.value === 'number' ? ind.value : ind.value !== null ? num(String(ind.value)) : null;
        if (actual === null) return res(claim, 'unverifiable', '该报告期暂无此指标数据（可能未披露）', { evidence, actual: null, actualDisplay: '未披露' });
        return judge(claim, actual, 0.01, '%', evidence, `${report} 报告期，${ab.ability} 类指标`);
      }
    }
  }
  return res(claim, 'unverifiable', '财务指标返回中未包含该 index_id', { evidence });
}

async function verifyMacro(claim: Claim): Promise<ClaimResult> {
  const label = claim.metric_label || claim.metric;
  const now = new Date();
  let start: Date, end: Date;
  if (claim.as_of) {
    const t = new Date(claim.as_of + 'T00:00:00+08:00');
    start = new Date(t.getFullYear(), t.getMonth() - 2, 1);
    end = new Date(t.getFullYear(), t.getMonth() + 1, 1);
  } else {
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    start = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  }
  const ym = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const query = `${label}（${ym(start)}-${ym(end)}）`;
  const r = await ifindCall('edb', 'get_edb_data', { query });
  const data = r.payload?.data as { answer?: string; datas?: { success?: boolean; data?: { data?: [string, string][]; attrs?: Record<string, { unit?: string; data_source?: string; freq?: string }> }; description?: string; source?: string }[] } | null;
  const evidence = ev('ifind', 'iFinD edb.get_edb_data', { query }, (r.payload ? JSON.stringify(r.payload).slice(0, 3500) : r.raw), [
    { label: '数据源', value: '同花顺 iFinD EDB 宏观经济数据库' },
    { label: '查询指标', value: label },
  ]);
  if (!r.ok) return res(claim, 'error', `宏观接口失败：${r.message ?? '未知'}`, { evidence });
  const ds = (data?.datas ?? []).find((x) => x.success && x.data?.data?.length) ?? (data?.datas ?? [])[0];
  const rows = ds?.data?.data ?? [];
  if (!rows.length) return res(claim, 'unverifiable', 'EDB 未返回该指标数据（指标名可能不匹配）', { evidence });
  const attr = ds?.data?.attrs ? Object.values(ds.data.attrs)[0] : undefined;
  const unit = attr?.unit ?? '';
  const src = attr?.data_source ?? ds?.source ?? 'EDB';
  let row = rows[rows.length - 1];
  if (claim.as_of) {
    const ymClaim = claim.as_of.slice(0, 7);
    const hit = rows.find(([d]) => d.slice(0, 7) === ymClaim);
    if (hit) row = hit;
  }
  const actual = num(row[1]);
  if (actual === null) return res(claim, 'unverifiable', 'EDB 返回值无法解析为数值', { evidence });
  evidence.fields.push({ label: '单位', value: unit || '—' }, { label: '数据来源机构', value: src });
  return judge(claim, actual, 0.01, unit, evidence, `${row[0]}，来源 ${src}${claim.as_of && row[0].slice(0, 7) !== claim.as_of.slice(0, 7) ? `（注：论断日期当期数据不可得，取最近可得期）` : ''}`);
}

async function verifySector(claim: Claim): Promise<ClaimResult> {
  const name = claim.subject_name || claim.metric_label || '';
  if (!name) return res(claim, 'unverifiable', '论断未指明板块/指数主体');
  const isIndex = /指数|综指|300|500|1000|科创|创业|上证|深证/.test(name);
  const tool = isIndex ? 'index_data' : 'sector_data';
  const query = claim.as_of ? `${name} ${claim.as_of} ${claim.metric_label || '涨跌幅'}` : `${name}最新${claim.metric_label || '涨跌幅'}`;
  const r = await ifindCall('index', tool, { query });
  const mdText = typeof r.payload?.data === 'string' ? r.payload.data : typeof r.payload?.data === 'object' && r.payload?.data !== null ? (r.payload.data as { answer?: string }).answer ?? JSON.stringify(r.payload.data) : '';
  const evidence = ev('ifind', `iFinD index.${tool}`, { query }, mdText || r.raw, [
    { label: '数据源', value: '同花顺 iFinD 指数/板块数据' },
    { label: '查询语句', value: query },
  ]);
  if (!r.ok) return res(claim, 'error', `板块/指数接口失败：${r.message ?? '未知'}`, { evidence });
  const tables = parseMdTables(mdText);
  for (const t of tables) {
    const row = t.rows.find((rw) => rw.some((c) => c.includes(name)));
    if (!row) continue;
    // 优先按表头关键词定位列，否则取行内唯一数值
    const kw = (claim.metric_label || '涨跌幅').replace(/[：:\s]/g, '');
    const colIdx = t.headers.findIndex((h) => kw.split('').some((_, i) => h.includes(kw.slice(0, Math.max(2, i + 2)))));
    const nums = row.map(num).filter((v): v is number => v !== null);
    if (colIdx >= 0) {
      const actual = num(row[colIdx] ?? '');
      if (actual !== null) return judge(claim, actual, 0.05, claim.metric.includes('pct') ? '%' : '', evidence, `iFinD ${isIndex ? '指数' : '板块'}数据`);
    }
    if (nums.length === 1) return judge(claim, nums[0], 0.05, claim.metric.includes('pct') ? '%' : '', evidence, `iFinD ${isIndex ? '指数' : '板块'}数据（行内唯一数值）`);
  }
  return res(claim, 'unverifiable', '板块/指数返回中未能定位该论断数值（自然语言取数解析失败）', { evidence });
}

async function verifyNewsEvent(claim: Claim): Promise<ClaimResult> {
  const now = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);
  let timeStart: string, timeEnd: string;
  if (claim.as_of) {
    const t = Date.parse(claim.as_of + 'T00:00:00+08:00');
    timeStart = toStr(new Date(t - 30 * D));
    timeEnd = toStr(new Date(t + 30 * D));
  } else {
    timeStart = toStr(new Date(now.getTime() - 180 * D));
    timeEnd = toStr(now);
  }
  const query = [claim.subject_name, claim.metric_label].filter(Boolean).join(' ') || claim.quote.slice(0, 30);
  const useNotice = /公告|年报|季报|披露/.test(claim.quote);
  const tool = useNotice ? 'search_notice' : 'search_news';
  const params = { query, time_start: timeStart, time_end: timeEnd, size: 5 };
  const r = await ifindCall('news', tool, params);
  const data = r.payload?.data as unknown;
  let items: Record<string, unknown>[] | null = null;
  if (Array.isArray(data)) items = data as Record<string, unknown>[];
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['items', 'list', 'news_list', 'notice_list', 'data']) {
      if (Array.isArray(d[key])) { items = d[key] as Record<string, unknown>[]; break; }
      // iFinD 常见形态：data.data 为 JSON 字符串化的数组
      if (typeof d[key] === 'string') {
        try {
          const arr = JSON.parse(d[key] as string);
          if (Array.isArray(arr)) { items = arr as Record<string, unknown>[]; break; }
        } catch { /* 非 JSON */ }
      }
    }
    if (!items && typeof d.answer === 'string' && d.answer.trim().length > 5) items = [{ answer: d.answer.slice(0, 300) }];
  }
  // 过滤掉无标题的备注类条目
  const hasTitle = (it: Record<string, unknown>) =>
    ['资讯标题', '公告标题', 'title', 'notice_title', 'answer'].some((k) => typeof it[k] === 'string' && (it[k] as string).trim());
  items = items ? items.filter(hasTitle) : items;
  const evidence = ev('ifind', `iFinD news.${tool}`, params, r.payload ? JSON.stringify(r.payload).slice(0, 3500) : r.raw, [
    { label: '数据源', value: `同花顺 iFinD ${useNotice ? '公告' : '资讯'}语义检索` },
    { label: '检索窗口', value: `${timeStart} ~ ${timeEnd}` },
  ]);
  if (!r.ok) return res(claim, 'error', `资讯接口失败：${r.message ?? '未知'}`, { evidence });
  if (items && items.length) {
    const fields: EvidenceField[] = items.slice(0, 3).map((it, i) => ({
      label: `相关结果${i + 1}`,
      value: ([it['资讯标题'], it['公告标题'], it.title, it.notice_title, it.answer] as (string | undefined)[])
        .find((v) => typeof v === 'string' && v.trim())?.slice(0, 150) ?? JSON.stringify(it).slice(0, 120),
      date: ([it['日期'], it.date, it.publish_time, it.time] as (string | undefined)[])
        .find((v) => typeof v === 'string') as string | undefined,
    }));
    evidence.fields.push(...fields);
    return res(claim, 'verified', `检索到 ${items.length} 条相关${useNotice ? '公告' : '资讯'}（存在性核实，非真实性认定）`, { evidence });
  }
  return res(claim, 'unverifiable', '未检索到相关资讯/公告（注意：未检索到 ≠ 论断不成立）', { evidence });
}

// ── 总调度 ──────────────────────────────────────────────────────
export async function verifyClaim(claim: Claim): Promise<ClaimResult> {
  try {
    switch (claim.type) {
      case 'market_quote': return await verifyMarketQuote(claim);
      case 'valuation': return await verifyValuation(claim);
      case 'financial': return await verifyFinancial(claim);
      case 'macro': return await verifyMacro(claim);
      case 'sector': return await verifySector(claim);
      case 'news_event': return await verifyNewsEvent(claim);
      case 'opinion': return res(claim, 'opinion', '主观观点/展望性表述，不做事实核验');
      default: return res(claim, 'unverifiable', '该论断超出当前数据源覆盖范围（无对应取数工具）');
    }
  } catch (e) {
    return res(claim, 'error', `核验过程异常：${String((e as Error)?.message || e)}`);
  }
}
