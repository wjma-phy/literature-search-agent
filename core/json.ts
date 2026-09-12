/**
 * JSON 松解析小工具：provider / 富集源对未知形状响应做安全收窄时的统一样板。
 */

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}