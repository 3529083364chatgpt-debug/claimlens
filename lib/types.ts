// ─── 论断与核验结果类型 ───────────────────────────

export type ClaimType =
  | 'market_quote'   // 行情：股价/涨跌幅/点位
  | 'valuation'      // 估值：PE/PB/市值
  | 'financial'      // 财务：营收/净利/ROE/毛利率等
  | 'macro'          // 宏观：CPI/GDP/PMI 等
  | 'sector'         // 板块/指数
  | 'news_event'     // 事件存在性
  | 'opinion'        // 主观观点
  | 'other';         // 无对应数据源

export type Verdict =
  | 'verified' | 'conflict' | 'unverifiable' | 'error' | 'violation' | 'opinion' | 'pending';

export interface Claim {
  id: string;
  quote: string;              // 原文论断（逐字引用）
  type: ClaimType;
  subject_name: string | null; // 主体：股票/指数/板块/宏观指标所属名称
  subject_code: string | null; // 若原文含代码：600519.SH
  metric: string;              // 标准化指标 key
  metric_label: string;        // 中文指标名（macro 类需贴近 EDB 命名）
  value: number | null;        // 论断数值
  unit: string;                // 元 | 亿元 | 万亿元 | 万 | % | ''
  as_of: string | null;        // YYYY-MM-DD
  period: string | null;       // YYYYQn / YYYYHn / YYYY年报
  comparison?: 'approx' | 'gte' | 'lte'; // 约 / 超过 / 低于
  confidence: number;
}

export interface EvidenceField {
  label: string;
  value: string;
  unit?: string;
  date?: string;
}

// 人工审核意见（可与确认/驳回并存，可累积多条）
export interface ReviewComment {
  text: string;   // 审核意见正文：问题描述、正确数据等
  at: string;     // ISO 时间戳
}

export interface Evidence {
  source: 'fuyao' | 'ifind';
  api: string;                  // 端点路径或 MCP 工具名
  params?: Record<string, unknown>;
  request_id?: string | null;   // 扶摇返回的 request_id，可回溯
  retrieved_at: string;         // ISO 时间
  raw_excerpt: string;          // 原始返回截断（≤4000 字符）
  fields: EvidenceField[];      // 提炼的关键字段（来源/时点/单位/口径）
}

export interface ClaimResult {
  claim: Claim;
  verdict: Verdict;
  reason: string;               // 中文判定说明
  actual: number | null;        // 数据源实际值（基础单位）
  actual_display: string | null;// 展示用（带单位/时点）
  deviation_pct: number | null; // (论断-实际)/|实际| 百分比
  evidence: Evidence | null;
  reviewed: 'confirmed' | 'rejected' | null;
  review_note: string | null;
  comments?: ReviewComment[];   // 人工审核意见（可累积，与裁决并存）
}

export interface ComplianceFinding {
  quote: string;
  rule: string;
  basis: string;       // 监管依据提示
  note: string;
  origin: 'rule' | 'llm';
  reviewed: 'confirmed' | 'rejected' | null;
  review_note: string | null;
  comments?: ReviewComment[];   // 人工审核意见（可累积，与裁决并存）
}

export interface ReportStats {
  total: number; verified: number; conflict: number; unverifiable: number;
  error: number; violation: number; opinion: number;
}

export interface AnalysisReport {
  report_id: string;
  input_text: string;
  created_at: string;
  results: ClaimResult[];
  compliance: ComplianceFinding[];
  stats: ReportStats;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: '已核实',
  conflict: '与数据源冲突',
  unverifiable: '无法核实',
  error: '取证失败',
  violation: '合规违规',
  opinion: '观点表述',
  pending: '核验中',
};