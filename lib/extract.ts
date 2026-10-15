// ─── 论断拆解与合规初扫（DeepSeek，仅做拆解与判定，不做数值比对） ──
import { deepseekJson } from './deepseek';
import { Claim, ClaimType, ComplianceFinding } from './types';

const SYSTEM_PROMPT = `你是投研内容核查系统的论断拆解引擎。任务：把用户给出的研报/点评/文章文本拆解为可独立核验的论断（claims），并扫描合规风险表述（compliance）。只输出一个 JSON 对象，不要输出任何其他文字。

【claims 要求】
- 每条 claim 是一个可单独核验的事实性断言；quote 必须逐字摘自原文（必须是原文中连续出现的文字片段）。
- 含数字、日期、百分比、排名、价格、事件陈述的句子必须拆出；主观判断、逻辑推演、展望性表述归为 opinion，不要遗漏明显的事实句。
- type 取值（只能这些值）：
  market_quote: 股价、涨跌幅、成交量、成交额、指数点位
  valuation: PE、PB、PS、总市值、流通市值
  financial: 营收、净利润、增速、ROE、毛利率、净利率、资产负债率等财务指标
  macro: CPI、GDP、PMI、社融、M2、行业产量/价格等宏观或行业经济指标
  sector: 行业板块表现、板块涨跌幅、资金流向
  news_event: 事件存在性陈述（如"公司发布XX公告""获XX批准""与XX签署协议"）
  opinion: 主观观点/展望/逻辑判断
  other: 含事实断言但上述类型无法覆盖
- metric 标准化枚举（尽量命中，无法命中用 other_x_简称）：
  close_price, last_price, price_change_pct, volume, turnover,
  pe_ttm, pb, ps_ttm, total_mv, circ_mv,
  operating_income_yoy, net_profit_yoy, roe, roe_deducted, gross_margin, net_margin, debt_ratio, total_assets_yoy,
  cpi_yoy, gdp_yoy, pmi
- metric_label：中文指标名。macro 类必须贴近 EDB 宏观指标库命名，如 "CPI:当月同比"、"GDP:不变价:当月同比"、"制造业PMI"、"社会融资规模:当月值"。
- value：论断中的数值（保留原文的数字本身）。unit 只能取：元 / 亿元 / 万亿元 / 万 / % / 空字符串。原文"1.6万亿"→ value=1.6, unit="万亿元"；"涨1.3%"→ value=1.3, unit="%"。
- as_of：论断对应的交易日/日期 YYYY-MM-DD；"最新/今日/近日"传 null。period：报告期，只能取 "YYYYQ1"/"YYYYQ2"/"YYYYH1"/"YYYYQ3"/"YYYYQ4"/"YYYY年报" 或 null。
- comparison：approx（约/为/达到，默认）/ gte（超过/超/高于/大于）/ lte（低于/小于/不足）。
- subject_name：公司简称/板块名/指数名/事件主体名称；若原文出现 6 位证券代码，推断为 subject_code（如 600519.SH、000001.SZ），否则 null。
- 一句话含两个可核验数值 → 拆成两条 claim；最多 15 条，不为凑数硬拆；没有可核验论断时 claims 为空数组。

【compliance 要求】
扫描文本中疑似违规表述：收益承诺/保本承诺、确定性买卖建议（建议买入/卖出/目标价）、夸大误导（稳赚/翻倍/躺赢/财富密码等）、无依据的确定性预测。rule 给出规则类别名，basis 给出监管依据（如《证券法》第161条、《发布证券研究报告暂行规定》），note 说明原因。没有则空数组。

【输出 JSON 格式】
{"claims":[{"id":"c1","quote":"...","type":"financial","subject_name":"贵州茅台","subject_code":null,"metric":"operating_income_yoy","metric_label":"营业总收入同比","value":9.1,"unit":"%","as_of":null,"period":"2025H1","comparison":"approx","confidence":0.9}],"compliance":[{"quote":"...","rule":"收益承诺","basis":"《证券法》第161条","note":"..."}]}`;

interface RawExtract {
  claims?: Partial<Claim>[];
  compliance?: Partial<ComplianceFinding>[];
}

const CLAIM_TYPES: ClaimType[] = ['market_quote', 'valuation', 'financial', 'macro', 'sector', 'news_event', 'opinion', 'other'];
const COMPARISONS = ['approx', 'gte', 'lte'];

function normalizeClaim(raw: Partial<Claim>, i: number, text: string): Claim | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = CLAIM_TYPES.includes(raw.type as ClaimType) ? (raw.type as ClaimType) : 'other';
  const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : null;
  const comparison = COMPARISONS.includes(String(raw.comparison)) ? String(raw.comparison) : 'approx';
  const quote = String(raw.quote ?? '').trim();
  if (!quote) return null;
  return {
    id: String(raw.id ?? `c${i + 1}`),
    quote: quote.slice(0, 200),
    type,
    subject_name: raw.subject_name ? String(raw.subject_name).slice(0, 40) : null,
    subject_code: raw.subject_code ? String(raw.subject_code).slice(0, 12) : null,
    metric: String(raw.metric ?? 'other').slice(0, 40),
    metric_label: String(raw.metric_label ?? '').slice(0, 60),
    value,
    unit: ['元', '亿元', '万亿元', '万', '%', ''].includes(String(raw.unit)) ? String(raw.unit) : '',
    as_of: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.as_of)) ? String(raw.as_of) : null,
    period: /^(?:\d{4}(?:Q[1-4]|H1|年报))$/.test(String(raw.period)) ? String(raw.period) : null,
    comparison: comparison as 'approx' | 'gte' | 'lte',
    confidence: typeof raw.confidence === 'number' ? Math.min(1, Math.max(0, raw.confidence)) : 0.7,
  };
}

export interface ExtractOutput {
  ok: boolean;
  error?: string;
  claims: Claim[];
  compliance: ComplianceFinding[];
}

export async function extractClaims(text: string): Promise<ExtractOutput> {
  const trimmed = text.trim().slice(0, 6000);
  const r = await deepseekJson(SYSTEM_PROMPT, `待拆解文本：\n${trimmed}`, { maxTokens: 6000, temperature: 0.1 });
  if (!r.ok || !r.content) return { ok: false, error: r.error ?? '拆解失败', claims: [], compliance: [] };
  let parsed: RawExtract;
  try {
    let s = r.content.trim();
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(s);
  } catch {
    return { ok: false, error: 'DeepSeek 返回内容无法解析为 JSON', claims: [], compliance: [] };
  }
  const claims = (parsed.claims ?? [])
    .map((c, i) => normalizeClaim(c, i, trimmed))
    .filter((c): c is Claim => c !== null)
    .slice(0, 15);
  const compliance = (parsed.compliance ?? [])
    .filter((f) => f && typeof f.quote === 'string' && f.quote.trim())
    .map((f) => ({
      quote: String(f.quote).trim().slice(0, 200),
      rule: String(f.rule ?? '合规风险'),
      basis: String(f.basis ?? '证券监管相关法规'),
      note: String(f.note ?? '').slice(0, 300),
      origin: 'llm' as const,
      reviewed: null,
      review_note: null,
    }))
    .slice(0, 10);
  return { ok: true, claims, compliance };
}
