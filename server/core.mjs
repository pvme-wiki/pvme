import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}
export const fail = (status, code, message, details) => {
  throw new ServiceError(status, code, message, details);
};
export const randomToken = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
// Canonical hashing survives jsonb key reordering while preserving every AST leaf.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const documentHash = value => hash(canonical(value));
export const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length <= 1024 && b.length <= 1024 && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function integer(value, name = 'expectedVersion') {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'invalid_input', `${name} must be a nonnegative integer.`);
  return value;
}
export function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'invalid_input', 'Unexpected request fields.');
}
export function boundedText(value, max, name, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400, 'invalid_input', `${name} must be 1–${max} characters.`);
  return value.trim();
}
export const iso = value => value ? new Date(value).toISOString() : null;

// Two full documents (snapshot + baseline) must fit Vercel's response budget.
export const HOSTED_DOCUMENT_LIMIT_BYTES = 1_750_000;
