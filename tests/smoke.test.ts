import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../core/types.js';

describe('scaffold', () => {
  it('core types are importable', () => {
    const item: WorkItem = {
      title: 'placeholder',
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
    };
    expect(item.abstractStatus).toBe('pending');
  });
});
