# literature-search-agent 实施计划

> 制定于 2026-08-06（在 Read-Studio 会话中评审通过）。本文档是新项目的单一事实来源：每个阶段开工前重读本文件，范围变化时更新本文件。

## 定位与目标

独立项目：一个**免费的、面向 Agent 的学术文献调研能力包**——批量检索、摘要富集、引用图扩展、PDF 获取与全文提取、Zotero 归档。

明确**不做**的事（属于 Deep Read 的职责，不搬过来）：
- 单篇精读（MinerU PDF→MD 云解析、五维度概览、图表 Vision 分析）
- PDF 对照阅读 UI、项目库管理 UI

约束：
- 数据源全部免费：OpenAlex（mailto polite pool，无需 key）、Semantic Scholar Graph API（~1 rps 节流）、Crossref、Unpaywall、arXiv；dblp 长期再补
- 不依赖 paper-search-mcp、Deep Read 后端、任何付费 API
- Zotero 仅走本地 API（localhost:23119）：读免认证、写复用已授权 key、写入前 DOI 查重

## 架构

```
literature-search-agent/
├── core/                    # 核心能力库（纯 TS，无宿主依赖，vitest 覆盖）
│   ├── providers/           # openalex / semanticscholar / crossref / unpaywall / arxiv
│   ├── enrich/              # 摘要富集链（OpenAlex→S2→EuropePMC→arXiv→OA HTML→Unpaywall）
│   ├── graph/               # 引用图（cited-by / references 遍历，滚雪球）
│   ├── zotero/              # Zotero 本地 API 客户端
│   ├── pdf/                 # OA 链接发现 → 下载 → pdf-parse 全文提取
│   ├── dedupe.ts            # DOI/标题归一化与去重（含 titlesAlign）
│   ├── ratelimit.ts         # 每源节流 + 重试 + polite pool（mailto）
│   └── types.ts
├── interfaces/
│   ├── cli/                 # lit-search CLI：调试与手动使用
│   ├── dsh-preset/          # DSH agent preset：cordis.yml + Host 插件 + persona
│   └── mcp/                 # （长期）MCP stdio server
├── tests/                   # vitest
└── docs/PLAN.md             # 本文件
```

## 技术决策

- TypeScript + ESM + Node ≥ 18；ESLint flat config；vitest
- PDF 提取默认 npm `pdf-parse`（纯 JS）；保留外部提取器注入口（可挂 PyMuPDF）
- 复用方式 = **移植并精简**（不 import 原仓库）：
  - Idea-Studio `core/retrieval/providers.ts`：OpenAlex/S2/Crossref/Unpaywall 调用、摘要富集链、`titlesAlign` 去重
  - Idea-Studio `core/literature-mining/graph.ts`：OpenAlex 引用图遍历
  - Read-Studio `server/lib/zoteroApi.js`：Zotero 本地 API 读写全流程（附件三段上传、If-Unmodified-Since-Version 乐观锁）
- DSH preset：cordis 插件 Host 半注册 model Tools，工具体 = core 薄包装 + 结果裁剪（防上下文爆炸）；中文 persona「文献调研助手」

## 短期计划（MVP，约 4 个会话）

### 阶段 1：核心检索 ✅（2026-09 完成）
- [x] `core/types.ts`、`ratelimit.ts`、`dedupe.ts`
- [x] `providers/openalex.ts`：search / lookup by DOI / cited-by
- [x] 单测：mock fetch 覆盖映射、去重、节流（48 例全绿）
- [x] CLI `search` 子命令（另有 `lookup` / `cited-by` 便于调试）
- **验收**：`lit-search search "plasma channel ion acceleration" --limit 10` 输出去重后的结构化结果 ✅（真实网络验证通过）

环境变量约定（本阶段定名，后续阶段沿用；密钥只走环境变量，不入库）：
- `LIT_SEARCH_OPENALEX_API_KEY`：有 key → `api_key` 参数 + 10 rps；无 key 有 mailto → polite pool 10 rps；都没有 → 匿名池 2 rps 保守档
- `LIT_SEARCH_MAILTO`：OpenAlex polite pool / Crossref / Unpaywall 共用
- `LIT_SEARCH_S2_API_KEY`：阶段 2 semanticscholar provider 用；有 key → `x-api-key` + 1 rps 独享，无 key → 匿名共享池保守节流

### 阶段 2：摘要富集 + S2/Crossref + PDF ✅（2026-09 完成）
- [x] `providers/semanticscholar.ts`（search + DOI 查摘要；有 key 1 rps 独享，无 key 3s 保守档）
- [x] `providers/crossref.ts`（bibliographic + title/author 检索、DOI lookup）
- [x] `providers/unpaywall.ts`；`enrich/` 富集链（OpenAlex→Crossref→S2/EuropePMC/arXiv 并发→doi.org HTML→Unpaywall）
- [x] `pdf/`：OA 链接发现 → 下载（https/30MB/%PDF 魔数校验）→ pdf-parse v2 提取（maxPages/maxChars 截断，外部提取器注入口）
- [x] CLI 新增 `abstract` / `pdf` / `extract`；`search`/`lookup` 支持 `--source openalex|s2|crossref`
- **验收**：给定 DOI 能拿到摘要（链式兜底）与可下载 OA PDF 的全文文本 ✅（真实网络验证：enrich 命中 OpenAlex；PLOS OA PDF 下载 131KB 并提取前 2 页文本）

注意：pdf-parse 实际安装为 v2 重写版（pdfjs 内核，`PDFParse` 类 API），与计划中的 v1 API 不同但满足"纯 JS 无 Python"约束。S2 匿名池实测 429 频发，需 `LIT_SEARCH_S2_API_KEY` 生效后才稳定。

### 阶段 3：Zotero 归档
- [ ] `zotero/`：关键词检索、DOI 查重、建条目、附件上传、收藏夹、笔记
- [ ] CLI `--save-zotero`
- **验收**：搜索结果一键存 Zotero（带 PDF）；重复执行不产生重复条目；真实 Zotero 验证后清理测试条目

### 阶段 4：DSH preset 封装
- [ ] `interfaces/dsh-preset/`：cordis 组合 + Host 插件注册 7 个工具（lit_search / lit_abstract / lit_cited_by / lit_download_pdf / pdf_extract_text / zotero_search / zotero_save）+ persona
- [ ] 实机验收：DSH 会话内「调研 X 方向 → 筛 8 篇 → 读全文 → 写综述 md → 存 Zotero」
- **前置实查**：preset 挂载机制以 `editing-cordis-compositions` skill 为准；若 preset 不适合，降级为动态插件 import 本库

## 长期计划

1. **MCP server 接口**：同一 core 包成 stdio MCP（与 DSH preset 并列，不改核心）
2. **滚雪球调研**：种子文献 → 参考文献 + 被引 → 评分筛选 → 迭代（借鉴 Idea-Studio `literature-mining/` planning/scoring）
3. **语义检索**：可选 ZotSeek MCP（本地库）；或本地 embedding 索引（sqlite-vec）以文找文
4. **调研工作流模板**：系统综述 / 开题调研 / 竞品技术扫描；批量编排（并发、断点续跑、缓存）
5. **缓存与配额**：检索结果磁盘缓存；每源配额仪表盘
6. **反哺 Deep Read**：以本库替换 paper-search-mcp 依赖；调研产物可作 Deep Read 项目附件
7. **dblp / Europe PMC 全量**：按需补源

## 风险与对策

| 风险 | 对策 |
|---|---|
| S2 无认证限流（~1 rps）拖慢批量 | ✅ 已缓解：用户持有 `LIT_SEARCH_S2_API_KEY`（独享 1 rps）；工具内节流 + 结果缓存；S2 仅作 OpenAlex 补充源 |
| OpenAlex 检索式能力弱于 Scopus 布尔检索 | 多查询组合并发（title / title+author / bibliographic）+ LLM 后置筛选 |
| OA PDF 覆盖率不全 | Unpaywall 兜底；拿不到的降级为"摘要可用、全文缺失" |
| DSH preset 挂载机制不确定 | 阶段 4 先实查；备用路径为动态插件 |
