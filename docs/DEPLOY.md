# 部署说明

## Vercel 部署（推荐）

1. 将本仓库导入 Vercel（Add New → Project → Import Git Repository）。
2. Framework Preset 选 **Next.js**（默认识别），无需改 Build 设置。
3. Project Settings → Environment Variables 添加（Production + Preview）：

   | 变量 | 说明 |
   |---|---|
   | `FUYAO_API_KEY` | 扶摇 A 股数据 API Key |
   | `IFIND_TOKEN` | iFinD MCP 密钥（原样粘贴） |
   | `DEEPSEEK_API_KEY` | DeepSeek API Key |
   | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
   | `NODE_OPTIONS` | `--dns-result-order=ipv4first`（强烈建议添加；部分数据源域名会解析出不可达的 IPv6 地址，导致 `fetch failed`） |

4. Deploy，得到 `https://<project>.vercel.app`。

注意事项：
- `.env.local` 不会入库，也不会被 Vercel 读取——线上密钥只能走 Environment Variables。
- 分析接口为 SSE 流式（`/api/analyze`），Vercel 原生支持；单次分析约 30–90s，Hobby 计划函数上限 60s，若超时建议 Pro 或拆分。样例文本建议 ≤ 6000 字符。
- iFinD 免费档 2 QPS，客户端已内置 650ms 全局节流；多用户并发时建议升级 iFinD 套餐。
- 网络容错：`lib/fuyao.ts` 对网络抖动与限流（HTTP 429 / 业务码 4001）内置 3 次退避重试；`lib/deepseek.ts` 在 `DEEPSEEK_BASE_URL` 缺失或不合法的 URL 时自动回退官方地址。

## 本地开发

```bash
npm install
cp .env.example .env.local   # 填入三个密钥
npm run dev                  # http://localhost:3000
npm run build && npm start   # 生产模式自检
```
