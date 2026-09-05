import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createServer, isIPv4 } from 'node:net';
import { get } from 'node:https';
import { passwordRecord, passwordVerifier } from '../src/server/auth.js';

process.umask(0o077);
const runtime = resolve(homedir(), '.local/state/atlas-para-isa-preview');
const worldDir = resolve(runtime, 'world');
const passwordFile = resolve(runtime, 'password');
const cert = resolve(runtime, 'certificate.pem');
const key = resolve(runtime, 'private-key.pem');
const configFile = resolve(runtime, 'preview.json');
const sessions = ['carta-isa-world', 'carta-isa-https'];
const action = process.argv[2] ?? 'start';
const command = (name: string, args: string[]) => spawnSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const active = (name: string) => command('tmux', ['has-session', '-t', `=${name}`]).status === 0;
function checked(name: string, args: string[]) {
  const result = command(name, args);
  if (result.status !== 0) throw new Error(`No se pudo ejecutar ${name}. Revisa sus dependencias o las sesiones de revisión.`);
}
async function available(host: string, port: number) {
  await new Promise<void>((yes, no) => {
    const server = createServer(); server.once('error', no);
    server.listen(port, host, () => server.close(error => error ? no(error) : yes()));
  });
}
async function health(origin: string): Promise<boolean> {
  return new Promise(yes => {
    const request = get(origin + '/health', { ca: readFileSync(cert), timeout: 1500 }, response => {
      response.resume(); yes(response.statusCode === 200);
    });
    request.on('error', () => yes(false)); request.on('timeout', () => { request.destroy(); yes(false); });
  });
}
function report(origin: string) {
  console.log(`URL de revisión: ${origin}`);
  console.log(`Contraseña privada: archivo ${passwordFile} (no se imprime en logs).`);
  console.log('HTTPS usa un certificado local autofirmado; el navegador pedirá aceptar ese certificado.');
}

try {
  if (!['start', 'stop', 'status'].includes(action)) throw new Error('Uso: npm run preview:local -- start | stop | status');
  if (action === 'stop') {
    for (const session of [...sessions].reverse()) if (active(session)) checked('tmux', ['send-keys', '-t', `=${session}:0.0`, 'C-c']);
    console.log('Cierre ordenado solicitado a las dos sesiones de esta carta. El mundo guardado se conserva.');
  } else if (action === 'status' || sessions.every(active)) {
    if (!existsSync(configFile)) throw new Error('Todavía no existe una revisión configurada.');
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { origin: string };
    report(config.origin);
    if (!sessions.every(active) || !await health(config.origin)) throw new Error('La revisión no está disponible.');
    console.log('Servidor, TLS y salud: disponibles.');
  } else {
    if (sessions.some(active)) throw new Error('Hay una sesión parcial. Usa preview:local -- stop antes de volver a arrancar.');
    if (!existsSync('dist/server/server/main.js') || !existsSync('dist/client/index.html')) throw new Error('Ejecuta npm run build primero.');
    const ip = process.env.CARTA_PREVIEW_IP ?? Object.values(networkInterfaces()).flat().find(n => n?.family === 'IPv4' && !n.internal)?.address;
    if (!ip || !isIPv4(ip) || !/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) throw new Error('Configura CARTA_PREVIEW_IP con una IPv4 privada del contenedor.');
    const origin = `https://${ip}:3443`;
    await available(ip, 3443); await available('127.0.0.1', 3123);
    mkdirSync(worldDir, { recursive: true, mode: 0o700 });
    if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(24).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    const password = readFileSync(passwordFile, 'utf8').trim();
    const credential = resolve(worldDir, 'access.scrypt');
    if (!existsSync(credential)) writeFileSync(credential, passwordRecord(password) + '\n', { mode: 0o600, flag: 'wx' });
    if (!passwordVerifier({ credentialPath: credential })(password)) throw new Error('La credencial existente no coincide; se conserva sin reemplazarla.');
    if (!existsSync(cert) || !existsSync(key) || command('openssl', ['x509', '-in', cert, '-checkip', ip, '-noout']).status !== 0) {
      checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '30', '-keyout', key, '-out', cert, '-subj', '/CN=Carta para Isa - revision local', '-addext', `subjectAltName=IP:${ip}`]);
    }
    writeFileSync(configFile, JSON.stringify({ origin, worldDir, appPort: 3123, sessions }, null, 2) + '\n', { mode: 0o600 });
    checked('tmux', ['new-session', '-d', '-s', sessions[0], '-c', process.cwd(), '-e', `CARTA_DATA_DIR=${worldDir}`, '-e', `CARTA_ORIGIN=${origin}`, '-e', 'HOST=127.0.0.1', '-e', 'PORT=3123', process.execPath, 'dist/server/server/main.js']);
    checked('tmux', ['new-session', '-d', '-s', sessions[1], '-c', process.cwd(), 'socat', `OPENSSL-LISTEN:3443,bind=${ip},reuseaddr,fork,cert=${cert},key=${key},verify=0`, 'TCP:127.0.0.1:3123']);
    let ready = false;
    // Bounded service readiness check, not a background monitoring job.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await health(origin)) { ready = true; break; }
      await new Promise<void>(yes => setTimeout(yes, 100));
    }
    if (!ready) throw new Error('La revisión no alcanzó el estado disponible. Revisa las sesiones carta-isa-world y carta-isa-https.');
    report(origin);
    console.log('Servidor y TLS verificados. El proceso sigue funcionando al cerrar esta terminal.');
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
