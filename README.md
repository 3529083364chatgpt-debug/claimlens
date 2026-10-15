# ClaimLens · 投研论断核验工作台

> 命题 14：AI Native 投资产品创新 · 方向 1「投研内容事实核查与合规治理工作台」

对研报 / 点评 / 财经文章做**逐条论断事实核查 + 合规治理**：

```
粘贴文本 → 合规规则引擎扫描（确定性）
        → DeepSeek 论断拆解（结构化 JSON）
        → 逐条调用真实数据源取证（扶摇 REST / 同花顺 iFinD MCP）
        → 数值确定性比对（代码计算，容差判定，LLM 不参与比对）
        → 核验报告（已核实 / 冲突 / 无法核实 / 取证失败 / 观点，附证据卡片）
        → 人工确认 / 驳回 / 审核意见（审计留痕）→ 导出 Markdown / JSON 报告
```

## 核心设计原则（合规红线）

1. **不输出任何投资建议**：不预测涨跌、不承诺收益、不给买卖建议；只回答"这段话与权威数据源是否一致"。
2. **结论可回溯**：每条结论附证据卡片——数据源、接口、请求参数、request_id、取证时间、单位、口径、原始返回截断。
3. **失败显式化**：数据缺失 / 冲突 / 主体无法定位 / 接口失败，一律输出 `无法核实` / `取证失败` 并说明原因，**绝不静默生成"正常"结论**。
4. **数值比对由代码完成**：LLM 只做论断拆解与合规复扫；比对偏差、容差（估值/财务 1%，价格 0.5%，涨跌幅 5%，宏观 1%）全部代码计算，杜绝幻觉。
5. **全站免责声明**。
6. **人工审核意见留痕**：每条论断与合规发现均可「确认无误 / 驳回 / 审核意见」。审核意见用于写明问题与正确数据（如"原文 95% 偏高，实际应为 91.30%"），可累积多条、带时间戳，并与裁决状态并存，一并写入 Markdown / JSON 导出报告。

## 数据源

| 数据源 | 用途 | 接口 |
|---|---|---|
| 扶摇 A 股数据 | 标的消歧、实时/历史行情、财务指标（确定性 JSON） | `/api/meta/tickers/search`、`/api/a-share/prices/*`、`/api/a-share/financials/indicators` |
| 同花顺 iFinD MCP | 估值摘要（PE/PB/市值）、宏观 EDB、板块/指数、资讯公告语义检索 | `stock.get_stock_summary`、`edb.get_edb_data`、`index.*`、`news.search_*` |
| DeepSeek | 论断拆解、合规复扫（JSON Mode） | OpenAI 兼容 `/chat/completions` |

论断类型 → 数据源工具完整映射见 [docs/PRD.md](docs/PRD.md) 第 3 节。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 填入三个密钥
npm run dev                  # http://localhost:3000
```

部署到 Vercel：导入仓库，在 Project Settings → Environment Variables 配置 `.env.example` 中的四个变量即可（见 [docs/DEPLOY.md](docs/DEPLOY.md)）。

## 测试

三个内置样例覆盖主链路、冲突检测、合规边界；接口失败 / 数据缺失场景见 [docs/TESTING.md](docs/TESTING.md)。

## 目录结构

```
app/
  page.tsx              # 主界面（SSE 消费、证据卡片、人工复核与审核意见、导出）
  api/analyze/route.ts  # 主链路 SSE：合规→拆解→取证→比对→汇总
lib/
  types.ts              # 论断/核验结果类型
  fuyao.ts              # 扶摇 REST 客户端
  ifind.ts              # iFinD JSON-RPC MCP 客户端（2QPS 节流）
  deepseek.ts           # DeepSeek 客户端（JSON Mode，5xx 重试）
  extract.ts            # 论断拆解提示词与结构化归一化
  compliance.ts         # 合规规则引擎（正则规则库）
  verify.ts             # 核验引擎：工具规划 + 确定性数值比对
docs/
  PRD.md                # 产品需求文档（含工具映射表、判定规则）
  TESTING.md            # 测试说明
  AI-USAGE.md           # AI 使用与验证记录
  DEPLOY.md             # 部署说明
```

## 免责声明

本工具仅对投研内容做事实核查与合规检查，不构成任何投资建议；核验结论以数据源原始返回为准，最终判断请以人工审核为准。
