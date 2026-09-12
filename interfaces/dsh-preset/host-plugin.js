/**
 * 文献调研助手 Host 插件
 *
 * 注册 7 个 model 工具：lit_search / lit_abstract / lit_cited_by /
 * lit_download_pdf / pdf_extract_text / zotero_search / zotero_save。
 *
 * 工具体 = literature-search-agent core 薄包装 + 结果裁剪防上下文爆炸。
 */

import { pathToFileURL } from 'node:url';

/** 默认 core 入口（本机开发路径）。分发后可设环境变量 LIT_SEARCH_CORE_URL 覆盖（绝对路径或 file:// URL）。 */
const DEFAULT_CORE_URL = 'file:///D:/AI%20Programs/literature-search-agent/dist/core/index.js';

/** 解析 core 入口：LIT_SEARCH_CORE_URL 优先（接受绝对路径或 URL），缺省回退本机开发路径。 */
function resolveCoreUrl() {
  const env = process.env.LIT_SEARCH_CORE_URL?.trim();
  if (!env) return DEFAULT_CORE_URL;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(env) ? env : pathToFileURL(env).href;
}

const CORE_URL = resolveCoreUrl();

/** 从环境变量解析认证配置。 */
function authFromEnv() {
  const auth = {};
  const openAlexApiKey = process.env.LIT_SEARCH_OPENALEX_API_KEY?.trim();
  const s2ApiKey = process.env.LIT_SEARCH_S2_API_KEY?.trim();
  const mailto = process.env.LIT_SEARCH_MAILTO?.trim();
  const zoteroKey = process.env.LIT_SEARCH_ZOTERO_KEY?.trim();
  const zoteroUrl = process.env.LIT_SEARCH_ZOTERO_URL?.trim();
  if (openAlexApiKey) auth.openAlexApiKey = openAlexApiKey;
  if (s2ApiKey) auth.s2ApiKey = s2ApiKey;
  if (mailto) auth.mailto = mailto;
  if (zoteroKey) auth.zoteroKey = zoteroKey;
  if (zoteroUrl) auth.zoteroUrl = zoteroUrl;
  return auth;
}

/** 创建 ZoteroClient 实例。 */
function createZoteroClient(auth) {
  return new core.ZoteroClient({
    ...(auth.zoteroUrl ? { baseUrl: auth.zoteroUrl } : {}),
    ...(auth.zoteroKey ? { apiKey: auth.zoteroKey } : {}),
    autoAuthorize: true,
    appName: 'dsh-lit-research',
  });
}

/** 裁剪 WorkItem 为精简格式（防上下文爆炸）。 */
function trimWorkItem(item) {
  return {
    title: item.title,
    authors: item.authors.slice(0, 5),
    year: item.year,
    venue: item.venue,
    doi: item.doi,
    citationCount: item.citationCount,
    abstract: item.abstract ? item.abstract.slice(0, 2000) : '',
    abstractStatus: item.abstractStatus,
    oaPdfUrl: item.oaPdfUrl,
    source: item.source,
    url: item.url,
  };
}

/** 裁剪 SearchResult 为精简格式。 */
function trimSearchResult(result) {
  return {
    items: result.items.map(trimWorkItem),
    diagnostics: result.diagnostics,
  };
}

/** 通用错误处理：将异常转为工具错误结果。 */
function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, error: { message } };
}

/** 延迟加载 core 模块（避免顶层 import 失败导致插件无法加载）。 */
let corePromise;
async function loadCore() {
  if (!corePromise) {
    corePromise = import(CORE_URL).catch((err) => {
      throw new Error(`无法加载 literature-search-agent core 库：${err instanceof Error ? err.message : String(err)}。请先运行 npm run build，或设置 LIT_SEARCH_CORE_URL 指向 dist/core/index.js。`);
    });
  }
  return corePromise;
}

// 工具定义
const toolDefinitions = [
  {
    name: 'lit_search',
    description: '多源学术文献检索（OpenAlex / Semantic Scholar / Crossref）。返回去重后的结构化文献列表。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词或短语' },
      source: { type: 'string', description: '数据源：openalex（默认）| s2 | crossref' },
      limit: { type: 'integer', description: '结果上限（默认 10，最大 200）' },
      yearFrom: { type: 'integer', description: '起始年份（含）' },
      yearTo: { type: 'integer', description: '结束年份（含）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        diagnostics: { type: 'object' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 200);
      const opts = {
        limit,
        ...(args.yearFrom ? { yearFrom: args.yearFrom } : {}),
        ...(args.yearTo ? { yearTo: args.yearTo } : {}),
        ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
        ...(auth.mailto ? { mailto: auth.mailto } : {}),
        ...(auth.s2ApiKey ? { apiKey: auth.s2ApiKey } : {}),
      };
      let result;
      const source = (args.source || 'openalex').toLowerCase();
      if (source === 's2') {
        result = await core.searchSemanticScholar(args.query, opts);
      } else if (source === 'crossref') {
        result = await core.searchCrossref(args.query, opts);
      } else {
        result = await core.searchOpenAlex(args.query, opts);
      }
      return trimSearchResult(result);
    },
    render(args, value) {
      const lines = [];
      for (const item of value.items) {
        const authors = item.authors.join(', ');
        const year = item.year ?? '?';
        const cited = item.citationCount !== null ? `被引 ${item.citationCount}` : '';
        const doi = item.doi ? `DOI: ${item.doi}` : '';
        lines.push(`- **${item.title}** (${authors}, ${year}) ${cited} ${doi}\n  来源: ${item.source} | ${item.url}`);
      }
      const diag = Object.entries(value.diagnostics)
        .map(([k, v]) => `${k}: ${v.ok ? `✓ ${v.count} 条` : `✗ ${v.error}`}`)
        .join(' | ');
      return [{ type: 'text', text: `检索「${args.query}」结果：\n\n${lines.join('\n\n')}\n\n---\n${diag}` }];
    },
  },
  {
    name: 'lit_abstract',
    description: '通过 DOI 或标题获取文献摘要。多源兜底：OpenAlex → Crossref → S2 → EuropePMC → arXiv → OA HTML → Unpaywall。',
    parameters: {
      doi: { type: 'string', description: '文献 DOI（优先）' },
      title: { type: 'string', description: '文献标题（无 DOI 时用标题检索）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        abstract: { type: 'string' },
        source: { type: 'string' },
        status: { type: 'string' },
        doi: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      if (!args.doi && !args.title) {
        throw new Error('必须提供 doi 或 title 之一。');
      }
      const result = await core.enrichAbstract(
        { doi: args.doi, title: args.title || '' },
        {
          ...(auth.openAlexApiKey ? { openAlexApiKey: auth.openAlexApiKey } : {}),
          ...(auth.s2ApiKey ? { s2ApiKey: auth.s2ApiKey } : {}),
          ...(auth.mailto ? { mailto: auth.mailto } : {}),
        },
      );
      return {
        abstract: result.abstract.slice(0, 2000),
        source: result.source,
        status: result.status,
        doi: result.doi,
      };
    },
    render(args, value) {
      if (value.status === 'missing') {
        return [{ type: 'text', text: `未找到摘要（DOI: ${value.doi || '未知'}）。` }];
      }
      return [{ type: 'text', text: `摘要（来源: ${value.source}，DOI: ${value.doi}）：\n\n${value.abstract}` }];
    },
  },
  {
    name: 'lit_cited_by',
    description: '查询一篇文献的被引列表（OpenAlex cited-by）。传 DOI 或 OpenAlex work ID。',
    parameters: {
      identifier: { type: 'string', required: true, description: '文献 DOI 或 OpenAlex work ID（如 W1234567890）' },
      limit: { type: 'integer', description: '结果上限（默认 25）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        diagnostics: { type: 'object' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
      const result = await core.citedByOpenAlex(args.identifier, {
        limit,
        ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
        ...(auth.mailto ? { mailto: auth.mailto } : {}),
      });
      return trimSearchResult(result);
    },
    render(args, value) {
      const lines = [];
      for (const item of value.items) {
        const authors = item.authors.join(', ');
        const year = item.year ?? '?';
        lines.push(`- **${item.title}** (${authors}, ${year})`);
      }
      return [{ type: 'text', text: `被引列表（${value.items.length} 条）：\n\n${lines.join('\n')}` }];
    },
  },
  {
    name: 'lit_download_pdf',
    description: '发现 OA PDF 链接并下载到本地。自动校验 %PDF 魔数、30MB 上限。',
    parameters: {
      doi: { type: 'string', description: '文献 DOI' },
      oaPdfUrl: { type: 'string', description: '已知的 OA PDF URL（有则跳过发现）' },
      outPath: { type: 'string', description: '下载保存路径（默认 ./pdfs/<doi>.pdf）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        bytes: { type: 'integer' },
        url: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      let pdfUrl = args.oaPdfUrl || '';
      if (!pdfUrl && args.doi) {
        pdfUrl = await core.discoverOaPdfUrl(
          { doi: args.doi, oaPdfUrl: '' },
          {
            ...(auth.openAlexApiKey ? { openAlexApiKey: auth.openAlexApiKey } : {}),
            ...(auth.mailto ? { mailto: auth.mailto } : {}),
          },
        );
      }
      if (!pdfUrl) {
        throw new Error('未找到 OA PDF 链接。可尝试提供 oaPdfUrl 参数。');
      }
      const outPath = args.outPath || `./pdfs/${(args.doi || 'download').replace(/[/\\:*?"<>|]/g, '_')}.pdf`;
      const result = await core.downloadPdf(pdfUrl, outPath);
      return { path: result.path, bytes: result.bytes, url: result.url };
    },
    render(args, value) {
      return [{ type: 'text', text: `PDF 已下载：${value.path}（${value.bytes} 字节）\n来源：${value.url}` }];
    },
  },
  {
    name: 'pdf_extract_text',
    description: '从本地 PDF 提取全文文本。支持页数/字符数截断，防上下文爆炸。',
    parameters: {
      pdfPath: { type: 'string', required: true, description: '本地 PDF 文件路径' },
      maxPages: { type: 'integer', description: '最多解析页数（默认全部）' },
      maxChars: { type: 'integer', description: '返回文本字符数上限（默认 100000）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        pageCount: { type: 'integer' },
        parsedPages: { type: 'integer' },
        truncated: { type: 'boolean' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const result = await core.extractPdfText(args.pdfPath, {
        ...(args.maxPages ? { maxPages: args.maxPages } : {}),
        ...(args.maxChars ? { maxChars: args.maxChars } : {}),
      });
      return {
        text: result.text.slice(0, 100000),
        pageCount: result.pageCount,
        parsedPages: result.parsedPages,
        truncated: result.truncated,
      };
    },
    render(args, value) {
      const note = value.truncated ? '\n\n（文本已截断）' : '';
      return [{ type: 'text', text: `PDF 共 ${value.pageCount} 页，已解析 ${value.parsedPages} 页。${note}\n\n${value.text}` }];
    },
  },
  {
    name: 'zotero_search',
    description: '检索本地 Zotero 库（需 Zotero 10+ 运行中，已开启本地 API）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词' },
      limit: { type: 'integer', description: '结果上限（默认 20）' },
      qmode: { type: 'string', description: '检索模式：titleCreatorYear（默认）| everything（查 DOI 用）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      const client = createZoteroClient(auth);
      const items = await client.searchItems(args.query, {
        limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
        ...(args.qmode ? { qmode: args.qmode } : {}),
      });
      return { items };
    },
    render(args, value) {
      if (!value.items || value.items.length === 0) {
        return [{ type: 'text', text: `Zotero 中未找到「${args.query}」相关条目。` }];
      }
      const lines = value.items.map((item) => {
        const authors = item.authors ? item.authors.join(', ') : '未知作者';
        const year = item.year ?? '?';
        return `- **${item.title}** (${authors}, ${year}) [key: ${item.key}]`;
      });
      return [{ type: 'text', text: `Zotero 检索结果（${value.items.length} 条）：\n\n${lines.join('\n')}` }];
    },
  },
  {
    name: 'zotero_save',
    description: '将文献归档到 Zotero：DOI 查重 → 建条目 → 挂 PDF → 收藏夹 → 笔记。幂等，重复执行不会重复建条目。',
    parameters: {
      doi: { type: 'string', description: '文献 DOI（优先）' },
      title: { type: 'string', description: '文献标题（无 DOI 时用标题检索）' },
      pdfPath: { type: 'string', description: '已下载的本地 PDF 路径（可选，有则上传附件）' },
      collectionKey: { type: 'string', description: '目标收藏夹 key（可选）' },
      note: { type: 'string', description: 'AI 生成的关联笔记（可选，HTML 格式）' },
    },
    outputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        itemKey: { type: 'string' },
        attachmentKey: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = authFromEnv();
      const client = createZoteroClient(auth);

      // 解析文献元数据
      let workItem;
      if (args.doi) {
        workItem = await core.lookupOpenAlexByDoi(args.doi, {
          ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
          ...(auth.mailto ? { mailto: auth.mailto } : {}),
        }).catch(() => undefined);
        if (!workItem) {
          workItem = await core.lookupCrossrefByDoi(args.doi, {
            ...(auth.mailto ? { mailto: auth.mailto } : {}),
          }).catch(() => undefined);
        }
      }
      if (!workItem && args.title) {
        const result = await core.searchOpenAlex(args.title, {
          limit: 1,
          ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
          ...(auth.mailto ? { mailto: auth.mailto } : {}),
        });
        workItem = result.items[0];
      }
      if (!workItem) {
        throw new Error('无法解析文献元数据，请提供有效 DOI 或标题。');
      }

      const result = await core.saveWork(client, {
        item: workItem,
        ...(args.pdfPath ? { pdfPath: args.pdfPath } : {}),
        ...(args.collectionKey ? { collectionKey: args.collectionKey } : {}),
        ...(args.note ? { note: args.note } : {}),
      });
      return result;
    },
    render(args, value) {
      const labels = { created: '已创建', attached: '已附加', exists: '已存在' };
      const label = labels[value.outcome] || value.outcome;
      return [{ type: 'text', text: `Zotero 归档结果：${label}\n条目 key: ${value.itemKey}${value.attachmentKey ? `\n附件 key: ${value.attachmentKey}` : ''}` }];
    },
  },
];

// Cordis 插件定义
const name = 'lit-research-tools';
const inject = ['tools', 'systemPrompt'];

function apply(ctx) {
  // 注册每个工具
  for (const def of toolDefinitions) {
    const tool = ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: {
        schema: def.outputSchema,
        render: def.render,
      },
      async execute(args, exec) {
        try {
          return await def.execute(args, exec);
        } catch (error) {
          return toolError(error);
        }
      },
    });
    ctx.effect(() => tool, `lit-research-tools.${def.name}`);
  }

  // 注册 system prompt section，指导模型如何使用这些工具
  const section = ctx.systemPrompt.section({
    name: 'tool:lit-research',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH'),
    text: `你有 7 个文献调研工具可用：

- lit_search: 多源学术检索（OpenAlex/S2/Crossref）。支持 source/limit/yearFrom/yearTo 参数。
- lit_abstract: 通过 DOI 或标题获取摘要（多源兜底）。
- lit_cited_by: 查询被引列表（OpenAlex）。
- lit_download_pdf: 发现 OA PDF 并下载到本地。
- pdf_extract_text: 从本地 PDF 提取文本（支持 maxPages/maxChars 截断）。
- zotero_search: 检索本地 Zotero 库。
- zotero_save: 归档文献到 Zotero（DOI 查重 → 建条目 → 挂 PDF → 收藏夹 → 笔记）。

典型流程：lit_search 检索 → lit_abstract 读摘要 → lit_cited_by 扩展引用 → lit_download_pdf + pdf_extract_text 读全文 → zotero_save 归档。
环境变量：LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_S2_API_KEY / LIT_SEARCH_MAILTO / LIT_SEARCH_ZOTERO_KEY。`,
  });
  ctx.effect(() => section, 'lit-research-tools.section');
}

export { name, inject, apply };
