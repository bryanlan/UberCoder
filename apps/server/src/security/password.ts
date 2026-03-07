import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function verifyPasswordHash(password: string, encodedHash: string): boolean {
  const [scheme, salt, hash] = encodedHash.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generateSessionId(): string {
  return randomBytes(24).toString('base64url');
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

export function sealCookieValue(sessionId: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${signature}`;
}

export function unsealCookieValue(cookieValue: string | undefined, secret: string): string | undefined {
  if (!cookieValue) return undefined;
  const lastDot = cookieValue.lastIndexOf('.');
  if (lastDot <= 0) return undefined;
  const sessionId = cookieValue.slice(0, lastDot);
  const signature = cookieValue.slice(lastDot + 1);
  const expected = createHmac('sha256', secret).update(sessionId).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return undefined;
  return timingSafeEqual(actualBuffer, expectedBuffer) ? sessionId : undefined;
}
