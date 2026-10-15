// ─── DeepSeek 客户端（OpenAI 兼容，JSON Mode） ────────────────────
// 环境变量兜底：BASE_URL 被误填（缺协议头/混入其他值/带引号）时回退官方地址，
// 避免因配置录入错误导致线上接口整体不可用。
const DEFAULT_BASE = 'https://api.deepseek.com';
function resolveBase(): string {
  const raw = (process.env.DEEPSEEK_BASE_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!/^https?:\/\//i.test(raw)) return DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}
const BASE = resolveBase();

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
  const key = (process.env.DEEPSEEK_API_KEY || '').trim().replace(/\s+/g, '');
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
