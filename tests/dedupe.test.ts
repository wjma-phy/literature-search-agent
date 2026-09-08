import { describe, expect, it } from 'vitest';
import { dedupeWorks, extractDoi, foldForMatch, normalizeDoi, titlesAlign } from '../core/dedupe.js';
import type { WorkItem } from '../core/types.js';

function work(partial: Partial<WorkItem> & { title: string }): WorkItem {
  return {
    authors: [],
    year: null,
    venue: '',
    doi: '',
    url: '',
    citationCount: null,
    abstract: '',
    abstractStatus: 'pending',
    oaPdfUrl: '',
    source: 'test',
    externalIds: {},
    ...partial,
  };
}

describe('normalizeDoi', () => {
  it('去 https://doi.org/ 前缀并小写', () => {
    expect(normalizeDoi('https://doi.org/10.1038/NATURE12373')).toBe('10.1038/nature12373');
  });
  it('去 http、dx.doi.org、doi: 前缀', () => {
    expect(normalizeDoi('http://dx.doi.org/10.1103/PhysRevLett.100.125003')).toBe('10.1103/physrevlett.100.125003');
    expect(normalizeDoi('doi: 10.1063/1.4978251')).toBe('10.1063/1.4978251');
  });
  it('去尾部标点与空白', () => {
    expect(normalizeDoi('10.1038/nature12373.')).toBe('10.1038/nature12373');
    expect(normalizeDoi('  10.1038/nature12373), ')).toBe('10.1038/nature12373');
  });
  it('处理 URL 编码', () => {
    expect(normalizeDoi('10.1002%2Fanie.201000001')).toBe('10.1002/anie.201000001');
  });
});

describe('extractDoi', () => {
  it('从参考文献文本中提取 DOI', () => {
    expect(extractDoi('Smith et al., Nature 500, 123 (2013). https://doi.org/10.1038/nature12373')).toBe('10.1038/nature12373');
  });
  it('找不到返回 undefined', () => {
    expect(extractDoi('no doi here')).toBeUndefined();
  });
});

describe('foldForMatch / titlesAlign', () => {
  it('忽略大小写、变音符与标点', () => {
    expect(foldForMatch('Café-au-Lait: A Study!')).toBe('cafe au lait a study');
  });
  it('大小写与标点差异视为同一标题', () => {
    expect(titlesAlign('Plasma-Based Ion Acceleration', 'plasma based ion acceleration.')).toBe(true);
  });
  it('包含关系视为对齐（副标题差异）', () => {
    expect(titlesAlign('Deep Learning', 'Deep Learning: A Survey')).toBe(true);
  });
  it('不同标题不对齐', () => {
    expect(titlesAlign('Ion acceleration in plasmas', 'Electron transport in solids')).toBe(false);
  });
  it('空标题不对齐', () => {
    expect(titlesAlign('', 'anything')).toBe(false);
  });
});

describe('dedupeWorks', () => {
  it('按 DOI 去重，DOI 优先于标题', () => {
    const a = work({ title: 'Same Paper', doi: '10.1/abc' });
    const b = work({ title: 'Same Paper (revised title)', doi: '10.1/abc' });
    const c = work({ title: 'Same Paper', doi: '' });
    expect(dedupeWorks([a, b, c])).toHaveLength(2);
  });
  it('无 DOI 时按 折叠标题+年份 去重', () => {
    const a = work({ title: 'My Title!', year: 2020 });
    const b = work({ title: 'my title', year: 2020 });
    const c = work({ title: 'my title', year: 2021 });
    expect(dedupeWorks([a, b, c])).toHaveLength(2);
  });
  it('保序：保留首次出现的条目', () => {
    const a = work({ title: 'T', doi: '10.1/x', citationCount: 5 });
    const b = work({ title: 'T', doi: '10.1/x', citationCount: 99 });
    expect(dedupeWorks([a, b])[0]?.citationCount).toBe(5);
  });
});
