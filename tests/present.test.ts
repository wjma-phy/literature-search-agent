import { describe, expect, it } from 'vitest';
import { toSearchView } from '../core/present.js';
import type { WorkItem } from '../core/types.js';

const full: WorkItem = {
  title: 'T',
  authors: ['a', 'b', 'c', 'd', 'e', 'f'],
  year: 2020,
  venue: 'V',
  doi: '10.x/y',
  url: 'u',
  citationCount: 3,
  abstract: 'x'.repeat(5000),
  abstractStatus: 'complete',
  oaPdfUrl: 'p',
  source: 'openalex',
  externalIds: {},
};

describe('toSearchView', () => {
  it('默认：作者 ≤5、摘要 ≤2000、含 abstract 与状态、无 authorsTotal', () => {
    const v = toSearchView(full);
    expect(v.authors).toHaveLength(5);
    expect(v.abstract).toHaveLength(2000);
    expect(v.abstractStatus).toBe('complete');
    expect(v.authorsTotal).toBeUndefined();
  });

  it('面板形态：author ≤4、authorsTotal、不输出 abstract', () => {
    const v = toSearchView(full, { maxAuthors: 4, includeAuthorsTotal: true, includeAbstract: false });
    expect(v.authors).toHaveLength(4);
    expect(v.authorsTotal).toBe(6);
    expect(v.abstract).toBeUndefined();
    expect(v.abstractStatus).toBeUndefined();
  });

  it('maxAbstractChars = 0 不裁剪', () => {
    expect(toSearchView(full, { maxAbstractChars: 0 }).abstract).toHaveLength(5000);
  });
});