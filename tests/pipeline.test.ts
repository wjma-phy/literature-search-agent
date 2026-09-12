import { describe, expect, it } from 'vitest';
import { clampLimit, errorDiagnostics, okDiagnostics, runSearchPipeline } from '../core/pipeline.js';
import type { WorkItem } from '../core/types.js';

const item = (title: string): WorkItem => ({
  title,
  authors: [],
  year: null,
  venue: '',
  doi: '',
  url: '',
  citationCount: null,
  abstract: '',
  abstractStatus: 'pending',
  oaPdfUrl: '',
  source: 'x',
  externalIds: {},
});

describe('clampLimit', () => {
  it('按 fallback 与 max 钳制', () => {
    expect(clampLimit(undefined, 10)).toBe(10);
    expect(clampLimit(5, 10)).toBe(5);
    expect(clampLimit(999, 10, 200)).toBe(200);
    expect(clampLimit(0, 10)).toBe(1);
  });
});

describe('okDiagnostics / errorDiagnostics', () => {
  it('成功与失败两态', () => {
    expect(okDiagnostics('openalex', 3)).toEqual({ openalex: { ok: true, count: 3 } });
    expect(errorDiagnostics('openalex', new Error('boom'))).toEqual({ openalex: { ok: false, count: 0, error: 'boom' } });
  });
});

describe('runSearchPipeline', () => {
  it('映射 → 去重 → 截断 → 成功诊断', async () => {
    const result = await runSearchPipeline({
      source: 'demo',
      limit: 2,
      rawsOf: (v) => v as { t: string }[],
      mapItem: (r) => (r.t ? item(r.t) : undefined),
      fetch: async () => [{ t: 'a' }, { t: 'a' }, { t: 'b' }, { t: '' }],
    });
    expect(result.items.map((w) => w.title)).toEqual(['a', 'b']);
    expect(result.diagnostics).toEqual({ demo: { ok: true, count: 2 } });
  });

  it('fetch 失败 → 空结果 + 错误诊断（不向上抛）', async () => {
    const result = await runSearchPipeline({
      source: 'demo',
      limit: 10,
      rawsOf: () => [],
      mapItem: () => undefined,
      fetch: async () => {
        throw new Error('network down');
      },
    });
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual({ demo: { ok: false, count: 0, error: 'network down' } });
  });
});