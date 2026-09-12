import { describe, expect, it } from 'vitest';
import {
  crossrefAuth,
  enrichAuth,
  openAlexAuth,
  parseEnvAuth,
  pdfAuth,
  s2Auth,
  unpaywallAuth,
  zoteroAuth,
} from '../core/auth.js';

describe('parseEnvAuth', () => {
  it('读取并 trim 各键，空串忽略', () => {
    const auth = parseEnvAuth({
      LIT_SEARCH_OPENALEX_API_KEY: ' k1 ',
      LIT_SEARCH_MAILTO: 'm@x',
      LIT_SEARCH_S2_API_KEY: '',
      LIT_SEARCH_ZOTERO_URL: 'http://z',
    });
    expect(auth).toEqual({ apiKey: 'k1', mailto: 'm@x', zoteroUrl: 'http://z' });
  });

  it('空 env → 空对象', () => {
    expect(parseEnvAuth({})).toEqual({});
  });
});

describe('auth builders', () => {
  const auth = parseEnvAuth({
    LIT_SEARCH_OPENALEX_API_KEY: 'k',
    LIT_SEARCH_MAILTO: 'm',
    LIT_SEARCH_S2_API_KEY: 's2',
    LIT_SEARCH_ZOTERO_KEY: 'zk',
    LIT_SEARCH_ZOTERO_URL: 'zu',
  });

  it('openAlexAuth：apiKey + mailto', () => expect(openAlexAuth(auth)).toEqual({ apiKey: 'k', mailto: 'm' }));
  it('s2Auth：apiKey（来自 s2Key）', () => expect(s2Auth(auth)).toEqual({ apiKey: 's2' }));
  it('crossrefAuth / unpaywallAuth：mailto / email', () => {
    expect(crossrefAuth(auth)).toEqual({ mailto: 'm' });
    expect(unpaywallAuth(auth)).toEqual({ email: 'm' });
  });
  it('enrichAuth / pdfAuth：富集链与 PDF 发现选项', () => {
    expect(enrichAuth(auth)).toEqual({ openAlexApiKey: 'k', s2ApiKey: 's2', mailto: 'm' });
    expect(pdfAuth(auth)).toEqual({ openAlexApiKey: 'k', mailto: 'm' });
  });
  it('zoteroAuth：apiKey + baseUrl', () => expect(zoteroAuth(auth)).toEqual({ apiKey: 'zk', baseUrl: 'zu' }));
  it('缺键时不出现该属性', () => expect(openAlexAuth(parseEnvAuth({}))).toEqual({}));
});