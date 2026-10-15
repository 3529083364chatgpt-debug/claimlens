// ─── DeepSeek 客户端（OpenAI 兼容，JSON Mode） ────────────────────
const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export interface DeepseekResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export async function deepseekJson(
  system: string,
  user: string,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<DeepseekResult> {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) return { ok: false, error: 'DEEPSEEK_API_KEY 未配置' };
  const body = {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4000,
    stream: false,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
        cache: 'no-store',
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status >= 500 && attempt === 0) continue; // 5xx 重试一次
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
      }
      const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content ?? '';
      if (!content) return { ok: false, error: 'DeepSeek 返回空内容' };
      return { ok: true, content };
    } catch (e) {
      const err = e as Error;
      if (attempt === 0) continue;
      const msg = err?.name === 'TimeoutError' ? 'DeepSeek 请求超时(90s)' : `DeepSeek 异常: ${String(err?.message || e)}`;
      return { ok: false, error: msg };
    }
  }
  return { ok: false, error: 'DeepSeek 请求失败' };
}
