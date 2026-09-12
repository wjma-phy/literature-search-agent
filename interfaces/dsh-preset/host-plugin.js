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

/**
 * 认证统一走 core.parseEnvAuth（单一实现），各源选项由 core.*Auth 装配——
 * 「环境变量命名 → provider 选项键名」的知识只住在 core/auth.ts。
 */

/** 创建 ZoteroClient 实例。 */
function createZoteroClient(core, auth) {
  return new core.ZoteroClient({
    autoAuthorize: true,
    appName: 'dsh-lit-research',
    ...core.zoteroAuth(auth),
  });
}

/** 检索结果投影为精简格式（预算策略在 core/toSearchView）。 */
function toTrimmedResult(result, core) {
  return {
    items: result.items.map((item) => core.toSearchView(item)),
    diagnostics: result.diagnostics,
  };
}

/**
 * 通用错误处理：把底层异常包装成带工具名的清晰错误。
 *
 * 必须 **抛出**，不能返回信封对象：DSH 的 ToolRuntime 把 execute 的返回值一律当作
 * 「符合 output.schema 的成功值」交给 render，出错路径只认抛出的异常
 * （dsh-tools: `const returned = await tool.execute(...); createSuccessResult(exec, tool, returned)`
 * 外层 `catch (error) { return toolErrorResult(error) }`）。
 * 若在此返回 {isError:true,...}，该信封会被当成成功值送进 render，
 * 报出误导性的 "output.render failed"，把真实错误原因完全掩盖。
 */
function wrapToolError(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${toolName} 执行失败：${message}`);
  wrapped.cause = error;
  return wrapped;
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

/**
 * 把作者参数 DSL 编译成 DSH 工具注册所需的 JSON Schema。
 *
 * `ctx.tools.register()` 接收的是**已编译**的 ToolDefinition——它只校验 output，
 * 不再处理 parameters（编译是 dsh-tools 里 `defineTool()` 的职责）。
 * 若直接把 DSL `{ query: { type: 'string', required: true } }` 交给 register，
 * 这个对象会被原样发给模型 API 并触发校验失败：
 *   Invalid schema for function 'lit_search': {"type":"string",...} is not of type "string"
 *
 * 这里复刻 `parameterSchemaSpecToJsonSchema()` 的行为：
 * 属性表 → { type:'object', properties, required? }，并把各属性的 required:true
 * 收集到根 required 数组里。参数根保持开放（不写 additionalProperties）。
 *
 * @param spec 作者 DSL：{ 参数名: { type, description?, required? } }
 * @returns 可注册的 JSON Schema
 */
function compileParams(spec) {
  const properties = {};
  const required = [];
  for (const [key, def] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = def ?? {};
    properties[key] = rest;
    if (isRequired === true) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
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
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diagnostics: { type: 'object', additionalProperties: true },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 200);
      const source = (args.source || 'openalex').toLowerCase();
      const opts = {
        limit,
        ...(args.yearFrom ? { yearFrom: args.yearFrom } : {}),
        ...(args.yearTo ? { yearTo: args.yearTo } : {}),
        ...(source === 's2' ? core.s2Auth(auth) : core.openAlexAuth(auth)),
      };
      let result;
      if (source === 's2') {
        result = await core.searchSemanticScholar(args.query, opts);
      } else if (source === 'crossref') {
        result = await core.searchCrossref(args.query, opts);
      } else {
        result = await core.searchOpenAlex(args.query, opts);
      }
      return toTrimmedResult(result, core);
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      const diagnostics = value?.diagnostics && typeof value.diagnostics === 'object' ? value.diagnostics : {};
      const lines = [];
      for (const item of items) {
        const authors = Array.isArray(item.authors) ? item.authors.join(', ') : '';
        const year = item.year ?? '?';
        const cited = item.citationCount !== null && item.citationCount !== undefined ? `被引 ${item.citationCount}` : '';
        const doi = item.doi ? `DOI: ${item.doi}` : '';
        lines.push(`- **${item.title}** (${authors}, ${year}) ${cited} ${doi}\n  来源: ${item.source} | ${item.url}`);
      }
      const diag = Object.entries(diagnostics)
        .map(([k, v]) => `${k}: ${v.ok ? `✓ ${v.count} 条` : `✗ ${v.error}`}`)
        .join(' | ');
      if (items.length === 0) {
        return [{ type: 'text', text: `检索「${args.query}」无结果。${diag ? `\n\n---\n${diag}` : ''}` }];
      }
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
      additionalProperties: false,
      properties: {
        abstract: { type: 'string' },
        source: { type: 'string' },
        status: { type: 'string' },
        doi: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      if (!args.doi && !args.title) {
        throw new Error('必须提供 doi 或 title 之一。');
      }
      const result = await core.enrichAbstract(
        { doi: args.doi, title: args.title || '' },
        core.enrichAuth(auth),
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
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diagnostics: { type: 'object', additionalProperties: true },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      const limit = Math.min(Math.max(args.limit ?? 25, 1), 200);
      const result = await core.citedByOpenAlex(args.identifier, { limit, ...core.openAlexAuth(auth) });
      return toTrimmedResult(result, core);
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      if (items.length === 0) {
        return [{ type: 'text', text: `未找到「${args.identifier}」的被引记录。` }];
      }
      const lines = [];
      for (const item of items) {
        const authors = Array.isArray(item.authors) ? item.authors.join(', ') : '';
        const year = item.year ?? '?';
        lines.push(`- **${item.title}** (${authors}, ${year})`);
      }
      return [{ type: 'text', text: `被引列表（${items.length} 条）：\n\n${lines.join('\n')}` }];
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
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        bytes: { type: 'integer' },
        url: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      let pdfUrl = args.oaPdfUrl || '';
      if (!pdfUrl && args.doi) {
        pdfUrl = await core.discoverOaPdfUrl({ doi: args.doi, oaPdfUrl: '' }, core.pdfAuth(auth));
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
      additionalProperties: false,
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
      additionalProperties: false,
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      const client = createZoteroClient(core, auth);
      const items = await client.searchItems(args.query, {
        limit: Math.min(Math.max(args.limit ?? 20, 1), 100),
        ...(args.qmode ? { qmode: args.qmode } : {}),
      });
      return { items };
    },
    render(args, value) {
      const items = Array.isArray(value?.items) ? value.items : [];
      if (items.length === 0) {
        return [{ type: 'text', text: `Zotero 中未找到「${args.query}」相关条目。` }];
      }
      const lines = items.map((item) => {
        const authors = Array.isArray(item.authors) && item.authors.length > 0 ? item.authors.join(', ') : '未知作者';
        const year = item.year ?? '?';
        return `- **${item.title}** (${authors}, ${year}) [key: ${item.key}]`;
      });
      return [{ type: 'text', text: `Zotero 检索结果（${items.length} 条）：\n\n${lines.join('\n')}` }];
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
      additionalProperties: false,
      properties: {
        outcome: { type: 'string' },
        itemKey: { type: 'string' },
        attachmentKey: { type: 'string' },
      },
    },
    async execute(args) {
      const core = await loadCore();
      const auth = core.parseEnvAuth(process.env);
      const client = createZoteroClient(core, auth);

      // 解析文献元数据
      let workItem;
      if (args.doi) {
        workItem = await core.lookupOpenAlexByDoi(args.doi, core.openAlexAuth(auth)).catch(() => undefined);
        if (!workItem) {
          workItem = await core.lookupCrossrefByDoi(args.doi, core.crossrefAuth(auth)).catch(() => undefined);
        }
      }
      if (!workItem && args.title) {
        const result = await core.searchOpenAlex(args.title, { limit: 1, ...core.openAlexAuth(auth) });
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
      parameters: compileParams(def.parameters),
      output: {
        schema: def.outputSchema,
        render: def.render,
      },
      async execute(args, exec) {
        try {
          return await def.execute(args, exec);
        } catch (error) {
          // 抛异常（而非返回信封）——见 wrapToolError 的说明。
          throw wrapToolError(def.name, error);
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
