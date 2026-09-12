# dsh-literature-search

DeepSeek Harness **Web 插件**：文献检索面板 + 预设说明页，进程内调用
literature-search-agent core（OpenAlex 检索/去重/节流）。

## 功能

- **侧栏入口**（`sidebar.footer.action`）：📚 文献检索——打开右侧浮动面板，输入关键词
  调 `GET /lit-search/api/search` 实时检索 OpenAlex，结果含标题/作者/年份/期刊/被引/DOI/OA PDF 标记。
- **设置页**（`settings.section`）：文献调研助手 · 说明——展示 Agent 功能、7 个模型工具清单
  （lit_search / lit_abstract / lit_cited_by / lit_download_pdf / pdf_extract_text /
  zotero_search / zotero_save）、核心原则、典型流程、环境变量与仓库链接。
- core 以**自包含 bundle**（`lib/vendor/lit-core.bundle.js`）随包分发，安装后无需
  literature-search-agent 源码或 `dist/` 目录。

## 安装

```bash
# npm 已发布时：
dsh plugin --profile web add dsh-literature-search@0.1.0

# GitHub Release tarball：
dsh plugin --profile web add https://github.com/wjma-phy/literature-search-agent/releases/download/v0.1.0/dsh-literature-search-0.1.0.tgz
```

安装后**重启 DSH**，侧栏底部出现「📚 文献检索」，设置抽屉出现「文献调研助手 · 说明」。

## 环境变量（可选）

- `LIT_SEARCH_OPENALEX_API_KEY` — OpenAlex 账户额度（无则回落 mailto 池 / 匿名池）
- `LIT_SEARCH_MAILTO` — OpenAlex polite pool 联系邮箱

## 开发

```bash
# 1. 在 literature-search-agent 仓库根目录构建 dist/：
npm run build

# 2. 重新生成自包含 bundle（esbuild 来自仓库 node_modules）：
node node_modules/esbuild/bin/esbuild dist/core/index.js --bundle --format=esm \
  --platform=node --target=node18 --external:pdf-parse \
  --outfile=interfaces/dsh-plugin/lib/vendor/lit-core.bundle.js

# 3. 打包验证：
cd interfaces/dsh-plugin && npm pack --dry-run
```

> `pdf-parse` 在 bundle 内为惰性导入（仅 `extractPdfText` 调用时才加载），
> 因此本插件不把它列为硬依赖；如需在面板内做 PDF 全文提取，请先行
> `npm i pdf-parse` 或将其加入本包 `dependencies`。

## 来源

基于 [literature-search-agent](https://github.com/wjma-phy/literature-search-agent)
核心库封装。License: MIT