import { describe, expect, it } from 'vitest';
import { cleanMarkup } from '../core/clean.js';

describe('cleanMarkup', () => {
  it('默认：去标签 + nbsp + 基础实体 + 折叠空白', () => {
    expect(cleanMarkup('  <p>A&nbsp;&amp;&nbsp;B</p> ')).toBe('A & B');
    expect(cleanMarkup('<jats:p>We report <b>ion</b> acceleration.</jats:p>')).toBe('We report ion acceleration.');
  });

  it('crossref 变体：extraEntities 追加 quot / 39，nbsp 关闭', () => {
    expect(cleanMarkup('<p>He said &quot;hi&quot; &amp; &#39;bye&#39;</p>', { nbsp: false, extraEntities: true })).toBe(
      'He said "hi" & \'bye\'',
    );
  });

  it('undefined / 空 → 空串', () => {
    expect(cleanMarkup(undefined)).toBe('');
    expect(cleanMarkup('')).toBe('');
  });
});