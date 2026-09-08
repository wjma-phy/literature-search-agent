# literature-search-agent

免费的、面向 Agent 的学术文献调研能力包：批量检索、摘要富集、引用图扩展、PDF 获取与全文提取、Zotero 归档。

- **零付费依赖**：数据源全部为免费 API（OpenAlex / Semantic Scholar / Crossref / Unpaywall / arXiv）
- **零服务依赖**：不需要 Deep Read 后端、不需要 paper-search-mcp、不需要 Python（PDF 提取用纯 JS 的 pdf-parse）
- **面向 Agent**：核心是纯 TypeScript 库，接口层适配 DSH preset / CLI /（未来）MCP

## 架构

```
core/          核心能力库（纯 TS，vitest 覆盖）
  providers/   数据源客户端：openalex / semanticscholar / crossref / unpaywall / arxiv
  enrich/      摘要富集链（OpenAlex → S2 → EuropePMC → arXiv → OA HTML → Unpaywall）
  graph/       引用图（cited-by / references 滚雪球）
  zotero/      Zotero 本地 API 客户端（检索 / 建条目 / 挂 PDF / 收藏夹 / 笔记）
  pdf/         OA 链接发现 → 下载 → 全文提取
  dedupe.ts    DOI / 标题归一化与去重
  ratelimit.ts 每源节流 + 重试 + polite pool
interfaces/
  cli/         调试与手动使用
  dsh-preset/  DSH agent preset（cordis 插件 + persona）
  mcp/         （长期）MCP stdio server
tests/         vitest 单测
docs/PLAN.md   实施计划
```

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

### CLI（阶段 1–3 已可用）

```bash
npm run build
node dist/interfaces/cli/index.js search "plasma channel ion acceleration" --limit 10 --pretty
node dist/interfaces/cli/index.js search "ion acceleration" --source s2 --limit 5
node dist/interfaces/cli/index.js lookup 10.1103/revmodphys.85.751 --source crossref
node dist/interfaces/cli/index.js cited-by 10.1063/1.873242 --limit 25
node dist/interfaces/cli/index.js abstract 10.1103/revmodphys.85.751 --pretty   # 摘要富集链
node dist/interfaces/cli/index.js pdf 10.1371/journal.pcbi.1003285              # OA PDF 发现+下载
node dist/interfaces/cli/index.js extract ./pdfs/<file>.pdf --max-pages 3       # 全文提取（截断）

# Zotero（需 Zotero 10+ 运行中）
node dist/interfaces/cli/index.js zotero-auth          # 弹窗点「始终允许」拿持久 key
node dist/interfaces/cli/index.js zotero-search "ion acceleration"
node dist/interfaces/cli/index.js zotero-save 10.1371/journal.pcbi.1003285 --note "<p>笔记</p>"
```

可选环境变量（密钥只走环境变量，不入库）：
- `LIT_SEARCH_OPENALEX_API_KEY`：OpenAlex 账户额度；无则退回 `LIT_SEARCH_MAILTO` polite pool，再退匿名池
- `LIT_SEARCH_MAILTO`：OpenAlex polite pool / Crossref / Unpaywall 共用联系邮箱
- `LIT_SEARCH_S2_API_KEY`：Semantic Scholar 独享 1 rps；无 key 走匿名共享池（429 频发）
- `LIT_SEARCH_ZOTERO_KEY`：Zotero 持久写 key（`zotero-auth` 弹窗点「始终允许」获得）
- `LIT_SEARCH_ZOTERO_URL`：Zotero 本地 API 地址（默认 `http://localhost:23119/api`）

## 实施路线

见 `docs/PLAN.md`（短期 4 个阶段：核心检索 → 富集/PDF → Zotero 归档 → DSH preset；长期：MCP、滚雪球调研、语义检索、工作流模板、缓存、反哺 Deep Read）。

## 致谢

检索与富集链的实现模式移植自 Idea-Studio（`core/retrieval/providers.ts`、`core/literature-mining/graph.ts`）；Zotero 本地 API 交互移植自 Read-Studio（`server/lib/zoteroApi.js`）。

## License

MIT
