/**
 * Criptografia de senha — usada tanto pelo servidor local (server.ts)
 * quanto pelo Cloudflare Worker (worker-entry.ts).
 *
 * Não importa de server.ts para evitar arrastar Express + body-parser
 * para o bundle do Worker.
 *
 * Usa scrypt com work factor elevado e salt aleatório por senha.
 * Formato armazenado: `scrypt:<saltHex>:<hashHex>`.
 */

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;

export function hashPassword(pass: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(pass, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(pass: string, stored: string): boolean {
  try {
    const parts = String(stored).split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    const derived = crypto.scryptSync(pass, salt, SCRYPT_KEYLEN);
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
