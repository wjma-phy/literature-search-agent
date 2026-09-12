# CONTEXT.md — literature-search-agent 领域词汇与架构约定

> 给未来会话与架构审查用的单一词汇来源。新概念入册后才算可命名。

## 领域概念

- **文献条目（WorkItem）**：一篇文献在所有数据源间的统一表示（标题/作者/年份/期刊/DOI/被引/摘要/OA PDF/来源/外部 ID）。
- **检索结果（SearchResult）**：条目列表 + 每源诊断（ok/count/error）。
- **数据源（provider）**：OpenAlex / Semantic Scholar / Crossref / Unpaywall / Europe PMC / arXiv。
- **摘要富集链（enrich）**：DOI（或标题）→ 多源兜底取摘要，任何单源失败只降级不抛。
- **OA PDF 链路（pdf）**：发现直链 → 下载（魔数校验）→ pdf-parse 全文提取。
- **Zotero 归档（zotero）**：DOI 查重 → 建条目 → 挂 PDF → 收藏夹 → 笔记（幂等）。
- **引用图（cited-by）**：OpenAlex `cites:` 过滤（目前只单页，无滚雪球）。

## 架构深 module（core 内，重构后的事实来源）

| module | 职责 | 谁消费 |
|---|---|---|
| `core/pipeline` | **检索管线**：fetch 一页 → map → dedupe → slice → diagnostics；`clampLimit` | 全部检索类 provider |
| `core/auth` | **环境认证**：`parseEnvAuth(env)` 一次解析 + 各源选项装配（`*Auth`） | CLI / preset / 插件接口层 |
| `core/clean` | **标记清洗**：HTML/JATS 实体+标签；`extraEntities` 区分变体 | 富集源与 Crossref |
| `core/present` | **展示投影**：`toSearchView(item, opts)` 预算策略唯一来源 | preset 与 4b 插件对外输出 |
| `core/json` | **松解析小工具**：`record`/`text` | 各 provider 映射层 |

## 约定

- **core 是纯库**：不读 `process.env`、不 import 框架——环境经 `parseEnvAuth` 由接口层注入。
- **「数据源认哪些键」只在 `core/auth` 住一份**；接口层调用 `parseEnvAuth` 一次后用 `*Auth` 装配。
- **上下文预算策略只在 `core/present`**（作者上限/摘要字符数），接口层差异 = 参数。
- **provider 只写「URL 构造 + 原始映射」两样**，其余归 `pipeline`。
- 接口层三兄弟：CLI（调试全量 JSON）、DSH preset（薄工具包装 + 裁剪）、4b 插件（面板路由 + 裁剪）。