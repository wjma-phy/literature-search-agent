import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkItem } from '../core/types.js';
import { ZoteroClient } from '../core/zotero/client.js';
import { itemTypeFor, saveWork, splitAuthorName, workToZoteroFields } from '../core/zotero/save.js';

const SERVER_ID = 'TESTSRVID';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface FakeZoteroConfig {
  /** quicksearch 命中的条目（Zotero API 形状） */
  searchHits?: Array<Record<string, unknown>>;
  /** 上传授权响应：exists → 重复；否则 uploadKey/url */
  uploadAuth?: { exists?: boolean; uploadKey?: string; url?: string };
  /** 让指定写请求返回错误（key 为 method+path 前缀） */
  failOn?: { match: RegExp; status: number; body?: string };
  /** 匹配请求仅第一次返回 401（验证 autoAuthorize 重授权重试） */
  oneTime401On?: RegExp;
}

/** 模拟 Zotero 本地 API 的状态化 fake。 */
function fakeZotero(config: FakeZoteroConfig = {}) {
  const calls: Call[] = [];
  let nextKey = 1000;
  let oneTime401Consumed = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'Zotero-Server-ID': SERVER_ID, 'X-Zotero-Version': '10.0.1' } });

  const fetchImpl = async (input: URL | string | Request, init?: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const method = init?.method ?? 'GET';
    const apiPath = url.hostname === 'upload.example.org' ? url.pathname : url.pathname.replace(/^\/api/, '');
    const path = apiPath + url.search;
    calls.push({ method, path, headers: init?.headers ?? {}, body: init?.body });

    if (config.failOn && config.failOn.match.test(`${method} ${path}`)) {
      return new Response(config.failOn.body ?? 'error', { status: config.failOn.status, headers: { 'Zotero-Server-ID': SERVER_ID } });
    }

    if (apiPath === '/') return new Response('ok', { status: 200, headers: { 'Zotero-Server-ID': SERVER_ID, 'X-Zotero-Version': '10.0.1' } });

    if (method === 'POST' && apiPath === '/local/authorize') {
      return json({ key: 'FRESHKEY', remember: false });
    }

    if (config.oneTime401On && !oneTime401Consumed && config.oneTime401On.test(`${method} ${path}`)) {
      oneTime401Consumed = true;
      return new Response('Invalid or expired API key', { status: 401, headers: { 'Zotero-Server-ID': SERVER_ID } });
    }

    if (method === 'GET' && apiPath === '/users/0/items' && url.searchParams.has('q')) {
      return json(config.searchHits ?? []);
    }

    if (method === 'POST' && apiPath === '/users/0/items') {
      const items = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>;
      const successful: Record<string, unknown> = {};
      items.forEach((item, i) => {
        const key = `K${nextKey++}`;
        successful[String(i)] = { key, version: 1, item };
      });
      return json({ successful, failed: {}, unchanged: {} });
    }

    if (method === 'POST' && /\/items\/K\d+\/file$/.test(url.pathname) && String(init?.body).startsWith('upload=')) {
      return new Response(null, { status: 204, headers: { 'Zotero-Server-ID': SERVER_ID } });
    }
    if (method === 'POST' && /\/items\/K\d+\/file$/.test(url.pathname)) {
      const auth = config.uploadAuth ?? { uploadKey: 'UPKEY1' };
      if (auth.exists) return json({ exists: true });
      return json({ uploadKey: auth.uploadKey ?? '', url: auth.url ?? '', contentType: 'application/pdf', prefix: '', suffix: '' });
    }
    // 直传（无 auth.url 时 PUT 到 /file；有 url 时 POST 到绝对 URL）
    if ((method === 'PUT' || method === 'POST') && (/\/items\/K\d+\/file$/.test(url.pathname) || url.hostname === 'upload.example.org')) {
      return new Response(null, { status: 201 });
    }

    if (method === 'GET' && /\/items\/K\d+$/.test(url.pathname)) {
      return json({ key: url.pathname.split('/').pop(), version: 7, data: { collections: [] } });
    }
    if (method === 'PATCH' && /\/items\/K\d+$/.test(url.pathname)) {
      return json({ version: 8 });
    }
    if (method === 'DELETE' && /\/items\/K\d+$/.test(url.pathname)) {
      return new Response(null, { status: 204, headers: { 'Zotero-Server-ID': SERVER_ID } });
    }

    return json({ message: 'not found' }, 404);
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function sampleWork(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    title: 'Plasma channel ion acceleration',
    authors: ['Alice B. Smith', 'Bob Jones', 'Madonna'],
    year: 2013,
    venue: 'Nature',
    doi: '10.1038/nature12373',
    url: 'https://doi.org/10.1038/nature12373',
    citationCount: 42,
    abstract: 'An abstract.',
    abstractStatus: 'complete',
    oaPdfUrl: '',
    source: 'openalex',
    externalIds: { openalex: 'https://openalex.org/W1', doi: '10.1038/nature12373' },
    ...overrides,
  };
}

function zoteroHit(doi: string, key = 'EXISTING1'): Record<string, unknown> {
  return {
    key,
    version: 3,
    data: {
      itemType: 'journalArticle',
      title: 'Existing paper',
      creators: [{ firstName: 'Alice', lastName: 'Smith', creatorType: 'author' }],
      date: '2013',
      DOI: doi.toUpperCase(), // 大小写不同也应匹配
      url: '',
    },
  };
}

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'lit-search-zotero-test-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function makePdf(): Promise<string> {
  const path = join(dir, 'paper.pdf');
  await writeFile(path, new TextEncoder().encode('%PDF-1.4 fake test pdf body'));
  return path;
}

describe('splitAuthorName / workToZoteroFields / itemTypeFor', () => {
  it('双名拆分 firstName/lastName，单名用 name', () => {
    expect(splitAuthorName('Alice B. Smith')).toEqual({ firstName: 'Alice B.', lastName: 'Smith' });
    expect(splitAuthorName('Madonna')).toEqual({ name: 'Madonna' });
  });

  it('字段映射：journalArticle + extra 记录被引与 OpenAlex id', () => {
    const fields = workToZoteroFields(sampleWork());
    expect(fields).toMatchObject({
      title: 'Plasma channel ion acceleration',
      date: '2013',
      publicationTitle: 'Nature',
      DOI: '10.1038/nature12373',
      abstractNote: 'An abstract.',
    });
    expect(String(fields.extra)).toContain('Citations (openalex): 42');
    expect(String(fields.extra)).toContain('OpenAlex: https://openalex.org/W1');
  });

  it('arXiv 条目 → preprint + repository', () => {
    const work = sampleWork({ externalIds: { arxiv: '2001.00001' } });
    expect(itemTypeFor(work)).toBe('preprint');
    expect(workToZoteroFields(work).repository).toBe('Nature');
  });
});

describe('ZoteroClient', () => {
  it('写请求自动先 ping 获取 Server-ID，并携带防护头', async () => {
    const { fetchImpl, calls } = fakeZotero();
    const client = new ZoteroClient({ apiKey: 'KEY', fetchImpl });
    await client.createItem({ fields: { title: 'T' } });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/' });
    const write = calls.find((c) => c.method === 'POST' && c.path.startsWith('/users/0/items'))!;
    expect(write.headers['Zotero-Server-ID']).toBe(SERVER_ID);
    expect(write.headers['Zotero-API-Key']).toBe('KEY');
    const body = JSON.parse(String(write.body)) as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ itemType: 'journalArticle', title: 'T' });
  });

  it('searchItems 映射 + findByDoi 大小写归一精确匹配（qmode=everything）', async () => {
    const { fetchImpl, calls } = fakeZotero({ searchHits: [zoteroHit('10.1038/nature12373')] });
    const client = new ZoteroClient({ fetchImpl });
    const items = await client.searchItems('nature12373');
    expect(items[0]).toMatchObject({ key: 'EXISTING1', title: 'Existing paper', year: 2013, authors: ['Alice Smith'] });
    const found = await client.findByDoi('https://doi.org/10.1038/NATURE12373');
    expect(found?.key).toBe('EXISTING1');
    // DOI 查重必须走全字段检索（默认 titleCreatorYear 不含 DOI 字段）
    const doiQuery = calls.find((c) => c.path.includes('qmode=everything'));
    expect(doiQuery).toBeDefined();
    expect(await client.findByDoi('10.9999/other')).toBeUndefined();
  });

  it('401 写请求 → needs-auth；412 → conflict', async () => {
    const fail401 = fakeZotero({ failOn: { match: /^POST \/users\/0\/items/, status: 401 } });
    await expect(new ZoteroClient({ apiKey: 'BAD', fetchImpl: fail401.fetchImpl }).createItem({ fields: {} }))
      .rejects.toMatchObject({ name: 'ZoteroApiError', code: 'needs-auth' });

    const fail412 = fakeZotero({ failOn: { match: /^PATCH /, status: 412 } });
    await expect(new ZoteroClient({ apiKey: 'K', fetchImpl: fail412.fetchImpl }).addToCollection('K1000', 'COLL1'))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('autoAuthorize：401 → 弹窗授权 → 同进程换新 key 重试成功', async () => {
    const { fetchImpl, calls } = fakeZotero({ oneTime401On: /^POST \/users\/0\/items/ });
    const client = new ZoteroClient({ apiKey: 'STALE', autoAuthorize: true, fetchImpl });
    const { itemKey } = await client.createItem({ fields: { title: 'Retry works' } });
    expect(itemKey).toMatch(/^K\d+$/);
    const authorize = calls.find((c) => c.path === '/local/authorize');
    expect(authorize).toBeDefined();
    // 重试的写请求带的是新 key
    const retriedWrite = calls.filter((c) => c.method === 'POST' && c.path === '/users/0/items').at(-1)!;
    expect(retriedWrite.headers['Zotero-API-Key']).toBe('FRESHKEY');
  });

  it('连接失败 → offline', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(new ZoteroClient({ fetchImpl }).ping()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('uploadPdfAttachment 四段流程', () => {
  it('建附件 → 授权 → 直传 → 注册 uploadKey', async () => {
    const { fetchImpl, calls } = fakeZotero({ uploadAuth: { uploadKey: 'UPKEY1' } });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    const result = await client.uploadPdfAttachment(await makePdf(), 'PARENT1');
    expect(result).toEqual({ attachmentKey: expect.stringMatching(/^K\d+$/), duplicate: false });

    const authCall = calls.find((c) => c.method === 'POST' && /\/file$/.test(c.path) && !String(c.body).startsWith('upload='))!;
    expect(authCall.headers['If-None-Match']).toBe('*');
    expect(String(authCall.body)).toContain('md5=');
    expect(String(authCall.body)).toContain('filesize=');
    const upload = calls.find((c) => c.method === 'PUT')!;
    expect(upload.headers['Content-Type']).toBe('application/pdf');
    const register = calls.find((c) => String(c.body).startsWith('upload='))!;
    expect(String(register.body)).toBe('upload=UPKEY1');
  });

  it('auth.exists → duplicate，跳过直传', async () => {
    const { fetchImpl, calls } = fakeZotero({ uploadAuth: { exists: true } });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    const result = await client.uploadPdfAttachment(await makePdf(), 'PARENT1');
    expect(result.duplicate).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('auth.url 为绝对地址时 POST 到该地址', async () => {
    const { fetchImpl, calls } = fakeZotero({ uploadAuth: { url: 'https://upload.example.org/abc' } });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    await client.uploadPdfAttachment(await makePdf(), 'PARENT1');
    const upload = calls.find((c) => c.method === 'POST' && c.path === '/abc')!;
    expect(upload.method).toBe('POST');
  });
});

describe('saveWork 编排（幂等）', () => {
  it('DOI 已存在且无 PDF → exists，不发写请求', async () => {
    const { fetchImpl, calls } = fakeZotero({ searchHits: [zoteroHit('10.1038/nature12373')] });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    const result = await saveWork(client, { item: sampleWork() });
    expect(result).toEqual({ outcome: 'exists', itemKey: 'EXISTING1' });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/users/0/items')).toBe(false);
  });

  it('DOI 已存在 + 带 PDF → attached', async () => {
    const { fetchImpl } = fakeZotero({ searchHits: [zoteroHit('10.1038/nature12373')] });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    const result = await saveWork(client, { item: sampleWork(), pdfPath: await makePdf() });
    expect(result.outcome).toBe('attached');
    expect(result.itemKey).toBe('EXISTING1');
    expect(result.attachmentKey).toMatch(/^K\d+$/);
  });

  it('DOI 不存在 → created：建条目（含收藏夹）+ 附件 + 笔记', async () => {
    const { fetchImpl, calls } = fakeZotero({ searchHits: [] });
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    const result = await saveWork(client, {
      item: sampleWork(),
      pdfPath: await makePdf(),
      collectionKey: 'COLL9',
      note: '<p>AI 笔记</p>',
    });
    expect(result.outcome).toBe('created');

    const createCalls = calls.filter((c) => c.method === 'POST' && c.path === '/users/0/items');
    expect(createCalls).toHaveLength(3); // 条目 + 附件 + 笔记
    const itemBody = JSON.parse(String(createCalls[0]!.body)) as Array<Record<string, unknown>>;
    expect(itemBody[0]).toMatchObject({ itemType: 'journalArticle', title: 'Plasma channel ion acceleration', collections: ['COLL9'] });
    expect((itemBody[0]!.creators as unknown[])).toHaveLength(3);
    const noteBody = JSON.parse(String(createCalls[2]!.body)) as Array<Record<string, unknown>>;
    expect(noteBody[0]).toMatchObject({ itemType: 'note', note: '<p>AI 笔记</p>' });
  });
});

describe('deleteItem', () => {
  it('带乐观锁头发 DELETE', async () => {
    const { fetchImpl, calls } = fakeZotero();
    const client = new ZoteroClient({ apiKey: 'K', fetchImpl });
    await client.deleteItem('K1000');
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.headers['If-Unmodified-Since-Version']).toBe('7');
  });
});
