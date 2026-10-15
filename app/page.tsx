'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisReport, ClaimResult, ComplianceFinding, Evidence, ReviewComment, Verdict } from '@/lib/types';

// ─── 样例 ───────────────────────────────────────────────────
const SAMPLES: { label: string; text: string }[] = [
  {
    label: '混合研报（核实/观点/事件）',
    text: '贵州茅台2025年半年报显示，营业总收入同比增长9.1%，归母净利润同比增长8.9%，加权ROE达17.9%。2025年10月9日贵州茅台收盘价为1384.8元。近日有消息称，贵州茅台与某头部新能源车企签署战略合作协议，将联合推出定制款车载酒柜。从基本面看，公司品牌护城河深厚，提价能力强，长期投资价值突出。',
  },
  {
    label: '合规违规样本（收益承诺/荐股）',
    text: '这只票稳赚不赔，保本保收益，建议立即满仓买入，目标价3000元，涨停板近在眼前，错过再等十年，闭眼买入躺赢即可。',
  },
  {
    label: '错误数据样本（冲突检测）',
    text: '2025年9月CPI同比上涨2.5%，创年内新高，通胀压力巨大。贵州茅台2025年上半年归母净利润同比增长25%，毛利率高达95%，远超市场预期。',
  },
];

// ─── 结论样式 ───────────────────────────────────────────────
const VERDICT_STYLE: Record<Verdict, { chip: string; dot: string; text: string }> = {
  verified: { chip: 'bg-emerald-100 text-emerald-800 border-emerald-300', dot: 'bg-emerald-500', text: '已核实' },
  conflict: { chip: 'bg-red-100 text-red-800 border-red-300', dot: 'bg-red-500', text: '与数据源冲突' },
  unverifiable: { chip: 'bg-amber-100 text-amber-800 border-amber-300', dot: 'bg-amber-500', text: '无法核实' },
  error: { chip: 'bg-zinc-200 text-zinc-800 border-zinc-400', dot: 'bg-zinc-600', text: '取证失败' },
  violation: { chip: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-300', dot: 'bg-fuchsia-500', text: '合规违规' },
  opinion: { chip: 'bg-sky-100 text-sky-800 border-sky-300', dot: 'bg-sky-500', text: '观点表述' },
  pending: { chip: 'bg-zinc-100 text-zinc-600 border-zinc-300', dot: 'bg-zinc-400', text: '核验中' },
};

const TYPE_LABEL: Record<string, string> = {
  market_quote: '行情', valuation: '估值', financial: '财务', macro: '宏观',
  sector: '板块', news_event: '事件', opinion: '观点', other: '其他',
};

export default function Home() {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [fatal, setFatal] = useState('');
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 恢复上次报告（含人工审核记录，localStorage 持久化）
  useEffect(() => {
    try {
      const saved = localStorage.getItem('claimlens_last_report');
      if (saved) setReport(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  const persist = useCallback((r: AnalysisReport | null) => {
    setReport(r);
    try {
      if (r) localStorage.setItem('claimlens_last_report', JSON.stringify(r));
      else localStorage.removeItem('claimlens_last_report');
    } catch { /* ignore */ }
  }, []);

  // ─── SSE 主链路 ──────────────────────────────────────────────
  const run = useCallback(async () => {
    if (running || text.trim().length < 10) return;
    setRunning(true); setFatal(''); setStatus('连接分析服务…');
    persist(null);
    const ac = new AbortController();
    abortRef.current = ac;
    let acc: AnalysisReport | null = null;
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`服务响应异常 HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const line = p.trim();
          if (!line.startsWith('data:')) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
          switch (msg.type) {
            case 'status': setStatus(String(msg.message ?? '')); break;
            case 'fatal': setFatal(String(msg.message ?? '分析失败')); break;
            case 'claims': setStatus(`已拆解出 ${(msg.claims as unknown[]).length} 条论断，开始逐条取证…`); break;
            case 'claim_result': {
              const r = msg.result as ClaimResult;
              acc = acc ?? emptyReport(text);
              acc.results = acc.results.filter((x) => x.claim.id !== r.claim.id).concat(r);
              persist({ ...acc, results: [...acc.results], compliance: acc.compliance });
              setStatus(`已核验 ${acc.results.length} 条…`);
              break;
            }
            case 'compliance': {
              acc = acc ?? emptyReport(text);
              acc.compliance = msg.findings as ComplianceFinding[];
              persist({ ...acc, results: acc.results, compliance: acc.compliance });
              break;
            }
            case 'done': {
              const r = msg.report as AnalysisReport;
              setStatus('核验完成');
              persist(r);
              break;
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setFatal(`分析中断：${String((e as Error).message || e)}`);
    }
    setRunning(false);
    abortRef.current = null;
  }, [running, text, persist]);

  // ─── 人工审核 ────────────────────────────────────────────────
  const review = useCallback((kind: 'result' | 'compliance', idx: number, action: 'confirmed' | 'rejected', note = '') => {
    if (!report) return;
    const next: AnalysisReport = { ...report };
    if (kind === 'result') {
      next.results = report.results.map((r, i) => (i === idx ? { ...r, reviewed: action, review_note: note } : r));
    } else {
      next.compliance = report.compliance.map((r, i) => (i === idx ? { ...r, reviewed: action, review_note: note } : r));
    }
    persist(next);
  }, [report, persist]);

  // 人工审核意见：与裁决并存、可累积，带真实时间戳
  const addComment = useCallback((kind: 'result' | 'compliance', idx: number, commentText: string) => {
    if (!report) return;
    const entry: ReviewComment = { text: commentText, at: new Date().toISOString() };
    const next: AnalysisReport = { ...report };
    if (kind === 'result') {
      next.results = report.results.map((r, i) => (i === idx ? { ...r, comments: [...(r.comments ?? []), entry] } : r));
    } else {
      next.compliance = report.compliance.map((f, i) => (i === idx ? { ...f, comments: [...(f.comments ?? []), entry] } : f));
    }
    persist(next);
  }, [report, persist]);

  const exportReport = useCallback((fmt: 'json' | 'md') => {
    if (!report) return;
    let content: string; let mime: string; let ext: string;
    if (fmt === 'json') {
      content = JSON.stringify(report, null, 2); mime = 'application/json'; ext = 'json';
    } else {
      content = buildMarkdown(report); mime = 'text/markdown'; ext = 'md';
    }
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claimlens-${report.report_id}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [report]);

  const stats = report?.results.length ? countStats(report) : null;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      {/* 头部 */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">ClaimLens · 投研论断核验工作台</h1>
        <p className="mt-1 text-sm text-zinc-600">粘贴研报 / 点评 / 财经文章 → 逐条论断取证 → 确定性比对 → 可回溯证据 + 合规治理 + 人工审计留痕</p>
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          免责声明：本工具仅对投研内容做事实核查与合规检查，不构成任何投资建议；核验结论以数据源原始返回为准，最终判断请以人工审核为准。
        </div>
      </header>

      {/* 输入区 */}
      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴需要核验的研报段落、财经点评或文章…（至少 10 字）"
          rows={7}
          className="w-full resize-y rounded-lg border border-zinc-300 p-3 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {SAMPLES.map((s) => (
            <button key={s.label} onClick={() => setText(s.text)} disabled={running}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-40">
              {s.label}
            </button>
          ))}
          <span className="flex-1" />
          {running ? (
            <button onClick={() => abortRef.current?.abort()} className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100">终止</button>
          ) : (
            <button onClick={run} disabled={text.trim().length < 10}
              className="rounded-lg bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-40">
              开始核验
            </button>
          )}
          {report && !running && (
            <>
              <button onClick={() => { exportReport('md'); }} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100">导出 Markdown</button>
              <button onClick={() => { exportReport('json'); }} className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-100">导出 JSON</button>
            </>
          )}
        </div>
        {running && (
          <div className="mt-3 flex items-center gap-2 text-sm text-zinc-600">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
            <span>{status}</span>
          </div>
        )}
        {!running && status && !fatal && <div className="mt-3 text-sm text-zinc-500">{status}</div>}
        {fatal && <div className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{fatal}</div>}
      </section>

      {/* 统计 */}
      {stats && (
        <section className="mt-5 flex flex-wrap gap-2 text-xs">
          <Chip v={null} label={`论断 ${stats.total}`} />
          <Chip v="verified" label={`已核实 ${stats.verified}`} />
          <Chip v="conflict" label={`冲突 ${stats.conflict}`} />
          <Chip v="unverifiable" label={`无法核实 ${stats.unverifiable}`} />
          <Chip v="error" label={`取证失败 ${stats.error}`} />
          <Chip v="opinion" label={`观点 ${stats.opinion}`} />
          <Chip v="violation" label={`合规违规 ${stats.violation}`} />
        </section>
      )}

      {/* 论断卡片 */}
      {report?.results.length ? (
        <section className="mt-4 space-y-3">
          {report.results.map((r, i) => (
            <ClaimCard key={r.claim.id + i} r={r} idx={i} onReview={review} onComment={addComment} />
          ))}
        </section>
      ) : null}

      {/* 合规发现 */}
      {report?.compliance.length ? (
        <section className="mt-8">
          <h2 className="mb-3 text-base font-semibold">合规扫描发现（{report.compliance.length}）</h2>
          <div className="space-y-3">
            {report.compliance.map((f, i) => (
              <ComplianceCard key={i} f={f} idx={i} onReview={review} onComment={addComment} />
            ))}
          </div>
        </section>
      ) : null}

      {report && !report.results.length && !report.compliance.length && (
        <p className="mt-6 text-center text-sm text-zinc-500">未拆解出可核验论断，也未命中合规规则。可尝试更具体的事实性文本。</p>
      )}

      <footer className="mt-12 border-t border-zinc-200 pt-4 text-center text-xs text-zinc-400">
        ClaimLens · 命题14 方向1 投研内容事实核查与合规治理工作台 · 数据源：扶摇 A 股数据 / 同花顺 iFinD / DeepSeek
      </footer>
    </main>
  );
}

// ─── 子组件 ─────────────────────────────────────────────────
function Chip({ v, label }: { v: Verdict | null; label: string }) {
  const s = v ? VERDICT_STYLE[v] : { chip: 'bg-zinc-200 text-zinc-800 border-zinc-300', dot: 'bg-zinc-500' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${s.chip}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />{label}
    </span>
  );
}

type ReviewAction = 'confirmed' | 'rejected';
type ReviewTarget = 'result' | 'compliance';
type OnReview = (k: ReviewTarget, i: number, a: ReviewAction, note?: string) => void;
type OnComment = (k: ReviewTarget, i: number, text: string) => void;

function ReviewButtons({ kind, idx, onReview, onComment, reviewed, comments }: {
  kind: ReviewTarget; idx: number; onReview: OnReview; onComment: OnComment;
  reviewed: ReviewAction | null; comments: ReviewComment[];
}) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const submitComment = () => {
    const t = comment.trim();
    if (!t) return;
    onComment(kind, idx, t);
    setComment('');
    setCommenting(false);
  };
  return (
    <div className="mt-2 border-t border-zinc-100 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-400">人工复核：</span>
        <button onClick={() => onReview(kind, idx, 'confirmed')}
          className={`rounded border px-2 py-0.5 ${reviewed === 'confirmed' ? 'border-emerald-400 bg-emerald-100 text-emerald-800' : 'border-zinc-300 hover:bg-zinc-100'}`}>确认无误</button>
        <button onClick={() => setNoting(!noting)}
          className={`rounded border px-2 py-0.5 ${reviewed === 'rejected' ? 'border-red-400 bg-red-100 text-red-800' : 'border-zinc-300 hover:bg-zinc-100'}`}>驳回</button>
        <button onClick={() => setCommenting(!commenting)}
          className={`rounded border px-2 py-0.5 ${commenting ? 'border-sky-400 bg-sky-100 text-sky-800' : 'border-sky-300 text-sky-700 hover:bg-sky-50'}`}>
          审核意见{comments.length > 0 ? ` ${comments.length}` : ''}
        </button>
        {reviewed && <span className="text-zinc-400">已记录</span>}
      </div>
      {noting && (
        <div className="mt-2 flex gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="填写驳回理由（将写入审计记录）"
            className="flex-1 rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500" />
          <button onClick={() => { onReview(kind, idx, 'rejected', note); setNoting(false); }}
            className="rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-500">提交驳回</button>
        </div>
      )}
      {commenting && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
            placeholder="填写审核意见：例如「此处数据有误，2025H1 毛利率实际应为 91.30%，原文 95% 偏高」；也可写明存疑点与正确口径（将写入审计记录）"
            className="flex-1 resize-y rounded border border-sky-300 px-2 py-1 text-xs outline-none focus:border-sky-500" />
          <button onClick={submitComment} disabled={!comment.trim()}
            className="self-start rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-40">提交意见</button>
        </div>
      )}
      {comments.length > 0 && (
        <ul className="mt-2 space-y-1">
          {comments.map((c, i) => (
            <li key={i} className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs leading-relaxed text-sky-900">
              <span className="mr-1 font-medium text-sky-600">审核意见 · {new Date(c.at).toLocaleString('zh-CN')}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClaimCard({ r, idx, onReview, onComment }: { r: ClaimResult; idx: number; onReview: OnReview; onComment: OnComment }) {
  const s = VERDICT_STYLE[r.verdict];
  const c = r.claim;
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${s.chip}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />{s.text}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-600">{TYPE_LABEL[c.type] ?? c.type}</span>
        {c.metric_label && <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-600">{c.metric_label}</span>}
        {c.subject_name && <span className="rounded-full bg-zinc-100 px-2 py-1 text-zinc-600">{c.subject_name}{c.subject_code ? ` (${c.subject_code})` : ''}</span>}
        <span className="flex-1" />
        <span className="text-zinc-400">{c.id}</span>
      </div>
      <blockquote className="mt-2 border-l-4 border-zinc-300 pl-3 text-sm leading-relaxed text-zinc-800">“{c.quote}”</blockquote>
      <div className="mt-2 grid gap-1 text-xs text-zinc-600 sm:grid-cols-2">
        <div>论断数值：<b className="text-zinc-900">{c.value !== null ? `${c.value}${c.unit || '—'}` : '—'}</b></div>
        <div>数据源实际：<b className="text-zinc-900">{r.actual_display ?? '—'}</b></div>
      </div>
      {r.deviation_pct !== null && Number.isFinite(r.deviation_pct) && (
        <div className="mt-1 text-xs text-zinc-500">偏差：{(r.deviation_pct * 100).toFixed(2)}%</div>
      )}
      <p className="mt-2 text-sm leading-relaxed text-zinc-700">{r.reason}</p>
      {r.evidence && <EvidenceView e={r.evidence} />}
      <ReviewButtons kind="result" idx={idx} onReview={onReview} onComment={onComment} reviewed={r.reviewed} comments={r.comments ?? []} />
    </article>
  );
}

function ComplianceCard({ f, idx, onReview, onComment }: { f: ComplianceFinding; idx: number; onReview: OnReview; onComment: OnComment }) {
  const s = VERDICT_STYLE.violation;
  return (
    <article className="rounded-xl border border-fuchsia-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${s.chip}`}>
          <span className={`inline-block h-2 w-2 rounded-full ${s.dot}`} />{s.text}
        </span>
        <span className="rounded-full bg-fuchsia-50 px-2 py-1 text-fuchsia-700">{f.rule}</span>
        <span className="text-zinc-400">{f.origin === 'rule' ? '规则引擎命中' : 'LLM 复扫命中'}</span>
      </div>
      <blockquote className="mt-2 border-l-4 border-fuchsia-300 pl-3 text-sm text-zinc-800">“{f.quote}”</blockquote>
      <p className="mt-2 text-xs text-zinc-600">{f.note}</p>
      <p className="mt-1 text-xs text-zinc-500">依据：{f.basis}</p>
      <ReviewButtons kind="compliance" idx={idx} onReview={onReview} onComment={onComment} reviewed={f.reviewed} comments={f.comments ?? []} />
    </article>
  );
}

function EvidenceView({ e }: { e: Evidence }) {
  return (
    <details className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-600 hover:text-zinc-900">
        查看证据（{e.source === 'fuyao' ? '扶摇' : 'iFinD'} · {e.api}）
      </summary>
      <div className="border-t border-zinc-200 px-3 py-2 text-xs">
        <div className="grid gap-1 text-zinc-600">
          <div>取证时间：<code className="text-zinc-800">{e.retrieved_at}</code></div>
          {e.request_id && <div>request_id：<code className="text-zinc-800">{e.request_id}</code>（可用于回溯）</div>}
          {e.params && <div>请求参数：<code className="break-all text-zinc-800">{JSON.stringify(e.params)}</code></div>}
        </div>
        {e.fields.length > 0 && (
          <table className="mt-2 w-full border-collapse text-left">
            <tbody>
              {e.fields.map((f, i) => (
                <tr key={i} className="border-t border-zinc-200">
                  <td className="py-1 pr-3 align-top text-zinc-500">{f.label}</td>
                  <td className="py-1 text-zinc-800">{f.date ? <span className="mr-2 rounded bg-zinc-200 px-1 text-[10px]">{f.date}</span> : null}{f.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2">
          <div className="mb-1 text-zinc-500">原始返回（截断）：</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 text-[10px] leading-relaxed text-zinc-700">{e.raw_excerpt || '（无）'}</pre>
        </div>
      </div>
    </details>
  );
}

// ─── 工具函数 ───────────────────────────────────────────────
function emptyReport(text: string): AnalysisReport {
  return {
    report_id: `cl-${Date.now().toString(36)}`, input_text: text, created_at: new Date().toISOString(),
    results: [], compliance: [],
    stats: { total: 0, verified: 0, conflict: 0, unverifiable: 0, error: 0, violation: 0, opinion: 0 },
  };
}

function countStats(r: AnalysisReport) {
  return {
    total: r.results.length,
    verified: r.results.filter((x) => x.verdict === 'verified').length,
    conflict: r.results.filter((x) => x.verdict === 'conflict').length,
    unverifiable: r.results.filter((x) => x.verdict === 'unverifiable').length,
    error: r.results.filter((x) => x.verdict === 'error').length,
    opinion: r.results.filter((x) => x.verdict === 'opinion').length,
    violation: r.compliance.length,
  };
}

function buildMarkdown(r: AnalysisReport): string {
  const L: string[] = [];
  L.push(`# ClaimLens 核验报告 ${r.report_id}`);
  L.push(`- 生成时间：${r.created_at}`);
  L.push('');
  L.push('## 待核验原文');
  L.push('```'); L.push(r.input_text); L.push('```');
  L.push('');
  L.push('## 核验结论');
  for (const res of r.results) {
    const label = VERDICT_LABEL_CN[res.verdict];
    L.push(`### [${label}] ${res.claim.id} · ${TYPE_LABEL[res.claim.type] ?? res.claim.type} · ${res.claim.metric_label || ''}`);
    L.push(`> ${res.claim.quote}`);
    L.push(`- 论断数值：${res.claim.value ?? '—'}${res.claim.unit ?? ''}`);
    L.push(`- 数据源实际：${res.actual_display ?? '—'}`);
    if (res.deviation_pct !== null && Number.isFinite(res.deviation_pct)) L.push(`- 偏差：${(res.deviation_pct * 100).toFixed(2)}%`);
    L.push(`- 判定说明：${res.reason}`);
    if (res.evidence) {
      L.push(`- 证据：${res.evidence.source === 'fuyao' ? '扶摇' : 'iFinD'} ${res.evidence.api} @ ${res.evidence.retrieved_at}${res.evidence.request_id ? `（request_id: ${res.evidence.request_id}）` : ''}`);
    }
    L.push(`- 人工复核：${res.reviewed === 'confirmed' ? '确认无误' : res.reviewed === 'rejected' ? `驳回（${res.review_note || '未填理由'}）` : '未复核'}`);
    for (const cm of res.comments ?? []) L.push(`- 审核意见（${cm.at}）：${cm.text}`);
    L.push('');
  }
  if (r.compliance.length) {
    L.push('## 合规扫描发现');
    for (const f of r.compliance) {
      L.push(`### [合规违规] ${f.rule}（${f.origin === 'rule' ? '规则引擎' : 'LLM 复扫'}）`);
      L.push(`> ${f.quote}`);
      L.push(`- 说明：${f.note}`);
      L.push(`- 依据：${f.basis}`);
      L.push(`- 人工复核：${f.reviewed === 'confirmed' ? '确认无误' : f.reviewed === 'rejected' ? `驳回（${f.review_note || '未填理由'}）` : '未复核'}`);
      for (const cm of f.comments ?? []) L.push(`- 审核意见（${cm.at}）：${cm.text}`);
      L.push('');
    }
  }
  const st = countStats(r);
  L.push('## 统计');
  L.push(`论断 ${st.total}：已核实 ${st.verified} / 冲突 ${st.conflict} / 无法核实 ${st.unverifiable} / 取证失败 ${st.error} / 观点 ${st.opinion}；合规违规 ${st.violation}`);
  L.push('');
  L.push('> 免责声明：本报告仅对投研内容做事实核查与合规检查，不构成任何投资建议。');
  return L.join('\n');
}

const VERDICT_LABEL_CN: Record<Verdict, string> = {
  verified: '已核实', conflict: '与数据源冲突', unverifiable: '无法核实',
  error: '取证失败', violation: '合规违规', opinion: '观点表述', pending: '核验中',
};
