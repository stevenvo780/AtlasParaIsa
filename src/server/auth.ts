import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

export const hashToken = (s: string) => createHash('sha256').update(s).digest('hex');
export const makeToken = () => randomBytes(32).toString('base64url');
export function passwordRecord(password: string) {
  if (password.length < 12 || password.length > 256) throw new Error('La contraseña debe tener entre 12 y 256 caracteres.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordVerifier(options: { password?: string; credentialPath?: string }) {
  let record: string;
  if (options.password) record = passwordRecord(options.password);
  else if (options.credentialPath && existsSync(options.credentialPath)) record = readFileSync(options.credentialPath, 'utf8').trim();
  else throw new Error('Falta configurar el acceso privado. Ejecuta npm run access -- init, o define CARTA_PASSWORD fuera del repositorio.');
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(record)) throw new Error('Formato de credencial no válido.');
  const [, salt, digest] = record.split(':');
  const expected = Buffer.from(digest, 'hex');
  return (password: string) => {
    if (password.length > 256) return false;
    return timingSafeEqual(expected, scryptSync(password, salt, 64));
  };
}
export function sessionHash(req: IncomingMessage): string | null {
  const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('carta_session='))?.slice(14);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : null;
}
export function cookie(token: string, secure: boolean, seconds = 60 * 60 * 24 * 14) {
  return `carta_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
}
