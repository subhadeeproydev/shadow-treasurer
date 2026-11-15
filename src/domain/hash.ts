import { createHash } from 'node:crypto';

/** Stable JSON (sorted keys) so the same object always hashes the same. */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

export const sha256 = (value: unknown): string =>
  createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');

export const shortHash = (value: unknown): string => sha256(value).slice(0, 12);
