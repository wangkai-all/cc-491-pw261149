import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return scrypt(password, salt, 32).then(hash => ({ salt, hash: hash.toString('hex') }));
}

export function verifyPassword(password, salt, expectedHex) {
  return hashPassword(password, salt).then(({ hash }) => {
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expectedHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Deterministic, non-reversible pseudonymisation used for exports at
// restricted clearance levels. Keyed so that two exports are still joinable
// within the same installation but cannot be brute-forced from an account id.
const PSEUDO_KEY = crypto.createHash('sha256').update('tracelink::pseudo::v1').digest();

export function pseudonym(value) {
  if (value == null) return value;
  const mac = crypto.createHmac('sha256', PSEUDO_KEY).update(String(value)).digest('base64url');
  return `anon_${mac.slice(0, 10)}`;
}

export function stableId(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}
