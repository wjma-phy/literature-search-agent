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

## 实施路线

见 `docs/PLAN.md`（短期 4 个阶段：核心检索 → 富集/PDF → Zotero 归档 → DSH preset；长期：MCP、滚雪球调研、语义检索、工作流模板、缓存、反哺 Deep Read）。

## 致谢

检索与富集链的实现模式移植自 Idea-Studio（`core/retrieval/providers.ts`、`core/literature-mining/graph.ts`）；Zotero 本地 API 交互移植自 Read-Studio（`server/lib/zoteroApi.js`）。

## License

MIT
