import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { passwordRecord } from '../src/server/auth.js';
import { Store } from '../src/server/store.js';
process.umask(0o077);
const data = resolve(process.env.CARTA_DATA_DIR ?? 'data');
async function readPassword(): Promise<string> {
  if (process.env.CARTA_PASSWORD) return process.env.CARTA_PASSWORD;
  if (!process.stdin.isTTY) {
    let value = ''; for await (const chunk of process.stdin) value += chunk;
    return value.trimEnd();
  }
  process.stdout.write('Elige una contraseña de 12 caracteres o más (no se mostrará): ');
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((yes, no) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003' || c === '\r' || c === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n');
          if (c === '\u0003') no(new Error('Cancelado.')); else yes(value); return;
        }
        if (c === '\u007f') value = value.slice(0, -1); else if (c >= ' ' && value.length < 257) value += c;
      }
    }; process.stdin.on('data', onData);
  });
}
try {
  if (process.argv[2] === 'init') {
    const file = resolve(data, 'access.scrypt');
    if (existsSync(file)) throw new Error('Ya existe una credencial. Se conserva; para rotar usa un directorio/archivo revisado y reinicia el servicio.');
    const record = passwordRecord(await readPassword());
    mkdirSync(data, { recursive: true, mode: 0o700 }); writeFileSync(file, record + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Acceso privado configurado. La contraseña no se guardó en texto plano.');
  } else if (process.argv[2] === 'revoke') {
    const dbPath = resolve(data, 'world.sqlite');
    if (!existsSync(dbPath)) throw new Error('El mundo todavía no existe.');
    const store = new Store(dbPath); store.revoke(); store.close();
    console.log('Todas las sesiones fueron revocadas.');
  } else throw new Error('Uso: npm run access -- init | revoke');
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
