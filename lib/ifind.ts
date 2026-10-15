// ─── iFinD MCP 客户端（JSON-RPC over HTTP，免费档限 2 QPS） ───────
const BASE = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers';
const SERVERS: Record<string, string> = {
  stock: `${BASE}/hexin-ifind-ds-stock-mcp`,
  edb: `${BASE}/hexin-ifind-ds-edb-mcp`,
  news: `${BASE}/hexin-ifind-ds-news-mcp`,
  index: `${BASE}/hexin-ifind-ds-index-mcp`,
};

const sessions = new Map<string, string>();
const reqIds = new Map<string, number>();
let lastCallAt = 0;

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function validateParams(p: unknown): void {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new TypeError('params must be object');
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    for (const k of Object.keys(v as object)) {
      if (BLOCKED_KEYS.has(k)) throw new TypeError('blocked field');
      walk((v as Record<string, unknown>)[k]);
    }
  };
  walk(p);
}

function nextId(t: string) {
  const n = (reqIds.get(t) || 0) + 1;
  reqIds.set(t, n);
  return n;
}

// 免费档 2 QPS 节流：全局串行 + ≥650ms 间隔
async function throttle() {
  const gap = 650 - (Date.now() - lastCallAt);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
  lastCallAt = Date.now();
}

function parseBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('data:')) {
    // SSE 帧：取最后一段 data JSON
    const lines = trimmed.split('\n').filter((l) => l.startsWith('data:'));
    const last = lines[lines.length - 1]?.slice(5).trim();
    return last ? JSON.parse(last) : null;
  }
  return trimmed ? JSON.parse(trimmed) : null;
}

async function post(serverType: string, payload: object, timeoutMs = 60000) {
  await throttle();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: process.env.IFIND_TOKEN || '',
  };
  const sid = sessions.get(serverType);
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(SERVERS[serverType], {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs), cache: 'no-store',
  });
  const sid2 = res.headers.get('mcp-session-id');
  if (sid2) sessions.set(serverType, sid2);
  const text = await res.text();
  let data: unknown = null;
  try { data = parseBody(text); } catch { data = null; }
  return { status: res.status, data, text };
}

async function ensureInit(serverType: string) {
  if (sessions.has(serverType)) return;
  const { status, data } = await post(serverType, {
    jsonrpc: '2.0', id: nextId(serverType), method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claimlens', version: '1.0.0' } },
  }, 30000);
  if (status >= 400 || !data || typeof data !== 'object') throw new Error(`iFinD initialize 失败 HTTP ${status}`);
  if (!sessions.has(serverType)) throw new Error('iFinD initialize 未返回 Mcp-Session-Id');
  await post(serverType, { jsonrpc: '2.0', method: 'notifications/initialized' }, 15000);
}

export interface IfindResult {
  ok: boolean;
  message?: string;
  /** 内层业务 JSON：{code:1,msg:'success',data:...} */
  payload: { code?: number; msg?: string; data?: unknown } | null;
  raw: string;
}

export async function ifindCall(serverType: string, toolName: string, params: Record<string, unknown>): Promise<IfindResult> {
  if (!SERVERS[serverType]) return { ok: false, message: `未知 iFinD 服务: ${serverType}`, payload: null, raw: '' };
  if (!process.env.IFIND_TOKEN) return { ok: false, message: 'IFIND_TOKEN 未配置', payload: null, raw: '' };
  try {
    validateParams(params);
    await ensureInit(serverType);
    const { status, data, text } = await post(serverType, {
      jsonrpc: '2.0', id: nextId(serverType), method: 'tools/call',
      params: { name: toolName, arguments: params },
    });
    const d = data as { error?: unknown; result?: { content?: { type: string; text: string }[] } } | null;
    if (d && typeof d === 'object' && 'error' in d && d.error) {
      const e = d.error as { message?: string };
      return { ok: false, message: `iFinD 错误: ${e?.message ?? '未知'}`, payload: null, raw: text.slice(0, 4000) };
    }
    if (status >= 400) return { ok: false, message: `HTTP ${status}`, payload: null, raw: text.slice(0, 4000) };
    const innerText = d?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    let payload: { code?: number; msg?: string; data?: unknown } | null = null;
    try { payload = JSON.parse(innerText); } catch { payload = null; }
    if (!payload || payload.code !== 1) {
      return { ok: false, message: `iFinD 业务失败: ${payload?.msg ?? (innerText.slice(0, 200) || '空返回')}`, payload, raw: text.slice(0, 4000) };
    }
    return { ok: true, payload, raw: text.slice(0, 4000) };
  } catch (e) {
    const err = e as Error;
    const msg = err?.name === 'TimeoutError' ? 'iFinD 请求超时' : `iFinD 异常: ${String(err?.message || e)}`;
    return { ok: false, message: msg, payload: null, raw: '' };
  }
}
