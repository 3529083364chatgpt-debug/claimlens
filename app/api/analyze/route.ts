// ─── 分析主链路（SSE 流式）：拆解 → 合规 → 逐条核验 → 汇总 ─────────
import { extractClaims } from '@/lib/extract';
import { scanCompliance } from '@/lib/compliance';
import { verifyClaim } from '@/lib/verify';
import type { AnalysisReport, ClaimResult, ComplianceFinding } from '@/lib/types';

export const maxDuration = 120;

export async function POST(req: Request) {
  let text = '';
  try {
    const body = await req.json();
    text = String(body?.text ?? '').trim();
  } catch { /* ignore */ }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      try {
        if (!text || text.length < 10) {
          send({ type: 'fatal', message: '输入文本过短（至少 10 字），请粘贴研报/点评内容' });
          closed = true; controller.close(); return;
        }

        // 1. 合规规则引擎（确定性，先扫）
        const ruleFindings = scanCompliance(text);
        send({ type: 'status', message: `合规规则扫描完成：命中 ${ruleFindings.length} 条` });

        // 2. DeepSeek 拆解 + LLM 合规复扫
        send({ type: 'status', message: '正在调用 DeepSeek 拆解论断…' });
        const ex = await extractClaims(text);
        if (!ex.ok) {
          send({ type: 'fatal', message: `论断拆解失败：${ex.error ?? '未知原因'}（不影响合规扫描结果）` });
          closed = true; controller.close(); return;
        }
        send({ type: 'claims', claims: ex.claims });

        // 合规：规则 ∪ LLM（按 quote 去重）
        const seen = new Set(ruleFindings.map((f) => f.quote.slice(0, 80)));
        const llmExtra: ComplianceFinding[] = ex.compliance.filter((f) => !seen.has(f.quote.slice(0, 80)));
        const compliance = [...ruleFindings, ...llmExtra];
        send({ type: 'compliance', findings: compliance });

        // 3. 逐条核验（串行：iFinD 免费档 2 QPS 节流在客户端内实现）
        const results: ClaimResult[] = [];
        for (let i = 0; i < ex.claims.length; i++) {
          const claim = ex.claims[i];
          send({ type: 'status', message: `核验中 ${i + 1}/${ex.claims.length}：${claim.metric_label || claim.quote.slice(0, 20)}…` });
          const result = await verifyClaim(claim);
          results.push(result);
          send({ type: 'claim_result', result });
        }

        // 4. 汇总
        const stats = {
          total: results.length,
          verified: results.filter((r) => r.verdict === 'verified').length,
          conflict: results.filter((r) => r.verdict === 'conflict').length,
          unverifiable: results.filter((r) => r.verdict === 'unverifiable').length,
          error: results.filter((r) => r.verdict === 'error').length,
          violation: compliance.length,
          opinion: results.filter((r) => r.verdict === 'opinion').length,
        };
        const report: AnalysisReport = {
          report_id: `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          input_text: text.slice(0, 6000),
          created_at: new Date().toISOString(),
          results, compliance, stats,
        };
        send({ type: 'done', report });
      } catch (e) {
        send({ type: 'fatal', message: `分析异常：${String((e as Error)?.message || e)}` });
      }
      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
