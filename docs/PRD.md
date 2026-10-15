# ClaimLens 论断核验工作台 — 产品需求文档（PRD）

> 命题 14：AI Native 投资产品创新 · 方向 1「投研内容事实核查与合规治理工作台」
> 版本：v1.0（2026-10-15）

## 1. 定位

面向**投研人员 / 合规审核岗 / 财经内容编辑**的事实核查工作台：粘贴一段研报、点评或财经文章，系统自动拆解其中的**可核验论断**，逐一调用真实金融数据源取证，输出「核实 / 冲突 / 无法核实 / 合规违规 / 观点」五类结论，每条结论**附原始证据**（数据源、时点、单位、口径、原始返回），并支持人工确认/驳回形成审计留痕。

**产品红线（不可妥协）**
1. 不输出涨跌预测、收益承诺、买卖建议；只回答"这段话里的数据/事实是否与权威数据源一致"。
2. 一切结论可回溯：证据卡片必须包含 来源 + 时点 + 单位 + 口径 + 原始返回摘要。
3. 数据缺失 / 冲突 / 过期 / 接口失败必须显式标注（`unverifiable` / `conflict` / `error`），**严禁静默生成"正常"结论**。
4. LLM 只负责论断拆解与报告措辞；**数值比对由代码计算**，杜绝幻觉。
5. 全站显著位置放置免责声明。

## 2. 目标用户与核心工作流

| 角色 | 痛点 | ClaimLens 价值 |
|---|---|---|
| 投研/研究员 | 交叉验证数据耗时 | 30 秒内完成逐条论断取证 |
| 合规审核 | 人工筛查违规表述易漏 | 规则引擎 + LLM 双重扫描，逐条定位原文 |
| 内容编辑 | 不确定引用数据是否可靠 | 每条数据附权威来源与原始返回 |

**主工作流**
```
粘贴文本 → [合规扫描（规则引擎，即时）]
        → [论断拆解（DeepSeek，结构化 JSON）]
        → [逐条取证（扶摇 REST / iFinD MCP，代码规划工具调用）]
        → [数值比对（代码，容差判定）]
        → [核验报告（五色标签 + 证据卡片 + 统计）]
        → [人工确认/驳回 → 审计留痕 → 导出报告(JSON/Markdown)]
```

## 3. 论断类型 → 数据源工具映射表（代码级硬编码）

| 论断类型 | 指标举例 | 数据源 | 接口/工具 | 返回形态 | 解析方式 |
|---|---|---|---|---|---|
| `market_quote` 行情 | 某日收盘价、最新价、涨跌幅 | 扶摇 | `GET /api/a-share/prices/historical`（有日期）/ `prices/snapshot`（最新） | 结构化 JSON（date_ms/close_price、last_price/price_change_ratio_pct） | 代码直读字段 |
| `valuation` 估值 | PE(TTM)、PB、总市值 | iFinD | `stock.get_stock_summary` | markdown 表 | 确定性 md 表格解析（指标列名精确匹配） |
| `financial` 财务 | 营收/净利同比、ROE、毛利率、资产负债率 | 扶摇 | `GET /api/a-share/financials/indicators?thscode=&report=YYYY-Q` | 结构化 JSON（ability/index_id/value） | index_id 映射表直读 |
| `macro` 宏观 | CPI、GDP、PMI、社融等 | iFinD | `edb.get_edb_data`（可先 `search_edb`） | 结构化数组 [日期,值] + attrs(unit/data_source/index_id) | 代码直读 |
| `sector` 板块/指数 | 板块涨跌幅、指数点位 | iFinD | `index.sector_data` / `index.index_data` | markdown/结构化 | md 表格解析，解析失败→无法核实 |
| `news_event` 事件 | "某公司发布某公告/发生某事" | iFinD | `news.search_news` / `news.search_notice`（必传 time_start/time_end） | 语义检索结果列表 | 存在性判定（不比对数值） |
| `opinion` 观点 | "看好""逻辑顺畅" | — | 不取数 | — | 直接标 `opinion`，不判真伪 |
| `other` 其他 | 无对应数据源 | — | — | — | 显式标 `unverifiable`（数据源缺失） |
| 合规违规 | 收益承诺/买卖建议/夸大表述 | 本地规则库 | 正则+关键词规则引擎（LLM 复扫兜底） | 命中规则 + 原文定位 | 代码判定 |

**主体解析**：论断中的股票名称/简称 → 扶摇 `GET /api/meta/tickers/search?q=&asset_type=a-share` 消歧为 thscode；解析失败 → 该条 `unverifiable`（主体无法定位），不猜测。

**已验证的指标 index_id 映射（扶摇 financials/indicators）**
- `calculate_operating_income_yoy_growth_ratio` 营收同比(%)
- `calculate_parent_holder_net_profit_yoy_growth_ratio` 归母净利同比(%)
- `index_weighted_avg_roe` 加权ROE(%) / `index_deduct_weighted_avg_roe` 扣非加权ROE(%)
- `sale_gross_margin` 毛利率(%) / `sale_net_interest_ratio` 净利率(%)
- `assets_debt_ratio` 资产负债率(%) / `total_assets_growth_ratio` 总资产同比(%)

## 4. 核验判定规则（代码实现）

| verdict | 触发条件 |
|---|---|
| `verified` 核实 | 取数成功、解析成功、`\|claim−actual\|/max(\|actual\|,ε) ≤ tolerance`（默认 1%；行情点位 0.5%；单位自动换算：亿/万亿/万 → 元，% 口径对齐） |
| `conflict` 冲突 | 取数成功、解析成功、超出容差（展示 论断值 vs 实际值 vs 偏差%） |
| `unverifiable` 无法核实 | 主体/指标/期间无法定位、解析失败、数据源不含该口径、返回空 |
| `error` 取证失败 | 接口异常/限流/超时（含失败原因，可重试按钮） |
| `violation` 违规 | 合规规则命中 |
| `opinion` 观点 | 主观表述，不判真伪 |

**news_event 特殊规则**：检索到相关报道 → `verified`（存在性核实，附标题/来源/日期）；未检索到 → `unverifiable` 并注明"未检索到 ≠ 不存在"。

## 5. 合规规则库（v1）

| 规则 | 模式示例 | 监管依据提示 |
|---|---|---|
| 买卖建议 | 建议买入/卖出、增持评级、目标价、抄底/清仓 | 《发布证券研究报告暂行规定》 |
| 收益承诺 | 稳赚/保本/翻倍/必涨/包赚/无风险收益 | 《证券法》第 161 条 |
| 夸大误导 | 涨停 assured、躺赢、错过再等十年 | 《证券期货投资者适当性管理办法》 |
| 预测承诺 | 预测涨跌/点位/市值翻倍类确定性表述 | 《证券分析师执业行为准则》 |

## 6. 人机协作闭环

- 每条核验卡片提供「确认无误 / 驳回（填理由）」；审核人、时间、理由写入审计记录。
- 一键导出：Markdown / JSON 审计报告（含全部原始证据 request_id、接口 URL、时间戳）。

## 7. 技术架构

- **Next.js 15（App Router，TS，Tailwind）**：前端 + API Routes 全栈，单仓部署 Vercel。
- **LLM**：DeepSeek（OpenAI 兼容，JSON Mode）仅用于论断拆解与合规复扫。
- **数据源客户端**：`lib/fuyao.ts`（REST，X-api-key）；`lib/ifind.ts`（JSON-RPC over HTTP MCP，会话缓存，免费档并发 2/s 内置节流）。
- **状态**：分析过程 SSE 流式返回；报告与审核记录存浏览器 localStorage，无需数据库。
- **密钥**：`.env.local` / Vercel Env，绝不入库。

## 8. 成功标准 / 失败条件

**成功标准**
1. 输入含 5+ 论断的研报段落，端到端 < 90s 输出全部核验结论；
2. 每条结论可点开证据卡片看到原始返回（来源/时点/单位/口径齐全）；
3. 故意注入的错误数据被标 `conflict`；合规违规表述全部被捕获并定位原文；
4. 断网/密钥失效时全部相关论断标 `error`/`unverifiable`，绝不输出"核实"。

**失败条件（即产品缺陷）**
- 任何"核实"结论无法回溯到原始返回；
- 数据缺失时出现默认"正常"文案；
- 输出任何形式的投资建议或预测。
