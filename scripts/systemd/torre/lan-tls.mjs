#!/usr/bin/env node
// Proxy TLS ligero de acceso directo por LAN y VPN (Tailscale) hacia `atlas-publico.service` (100.64.0.1:3000).
// Sin dependencias externas: usa `node:https`, `node:http`, `node:net` y `openssl` para generar una sola vez
// un certificado autofirmado persistente en `~/.local/state/atlas-para-isa/lan-tls/` (fuera del repositorio).
// No reescribe `Host`, `Origin` ni cookies: la validación estricta pareada Host↔Origin de `app.ts` manda siempre.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

process.umask(0o077);

const LISTEN_HOSTS = (process.env.LAN_TLS_HOSTS ?? '100.64.0.1,192.168.78.211')
  .split(',').map(s => s.trim()).filter(Boolean);
const LISTEN_PORT = Number(process.env.LAN_TLS_PORT ?? 3443);
const UP_HOST = process.env.LAN_TLS_UPSTREAM_HOST ?? '100.64.0.1';
const UP_PORT = Number(process.env.LAN_TLS_UPSTREAM_PORT ?? 3000);
const STATE_DIR = process.env.LAN_TLS_CERT_DIR ?? join(homedir(), '.local', 'state', 'atlas-para-isa', 'lan-tls');
const CERT_PATH = join(STATE_DIR, 'cert.pem');
const KEY_PATH = join(STATE_DIR, 'key.pem');

if (!Number.isInteger(LISTEN_PORT) || LISTEN_PORT < 1 || LISTEN_PORT > 65535) throw new Error('LAN_TLS_PORT inválido.');
if (!Number.isInteger(UP_PORT) || UP_PORT < 1 || UP_PORT > 65535) throw new Error('LAN_TLS_UPSTREAM_PORT inválido.');
if (LISTEN_HOSTS.length === 0) throw new Error('Configura al menos una dirección en LAN_TLS_HOSTS.');

function ensureCert() {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const san = [
      ...LISTEN_HOSTS.map(h => (net.isIP(h) ? `IP:${h}` : `DNS:${h}`)),
      'DNS:kratos',
      'DNS:kratos.vpn.stev',
    ].join(',');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-days', '3650', '-subj', '/CN=atlas-lan.local',
      '-addext', `subjectAltName=${san}`,
      '-keyout', KEY_PATH, '-out', CERT_PATH,
    ], { stdio: 'ignore' });
    chmodSync(KEY_PATH, 0o600);
    chmodSync(CERT_PATH, 0o644);
  }
  return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) };
}

function clientIp(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function forwardHttp(req, res) {
  const headers = { ...req.headers };
  const ip = clientIp(req);
  if (ip) headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${ip}` : ip;
  headers['x-forwarded-proto'] = 'https';

  const upstream = http.request({
    host: UP_HOST,
    port: UP_PORT,
    method: req.method,
    path: req.url,
    headers,
  }, upRes => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'El servicio principal no está disponible.' }));
    } else {
      res.end();
    }
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function forwardUpgrade(req, socket, head) {
  const ip = clientIp(req);
  const upstream = net.connect(UP_PORT, UP_HOST);
  const closeBoth = () => { socket.destroy(); upstream.destroy(); };
  socket.on('error', closeBoth);
  upstream.on('error', closeBoth);
  upstream.on('connect', () => {
    const raw = req.rawHeaders;
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    let existingXff = '';
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i], v = raw[i + 1];
      if (k.toLowerCase() === 'x-forwarded-for') {
        existingXff = existingXff ? `${existingXff}, ${v}` : v;
        continue;
      }
      if (k.toLowerCase() === 'x-forwarded-proto') continue;
      lines.push(`${k}: ${v}`);
    }
    if (ip) lines.push(`X-Forwarded-For: ${existingXff ? `${existingXff}, ${ip}` : ip}`);
    lines.push('X-Forwarded-Proto: https', '', '');
    upstream.write(lines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

const creds = ensureCert();
const servers = LISTEN_HOSTS.map(host => {
  const srv = https.createServer(creds, forwardHttp);
  srv.requestTimeout = 15_000;
  srv.headersTimeout = 10_000;
  srv.on('upgrade', forwardUpgrade);
  srv.on('error', err => {
    console.error(`lan-tls (${host}:${LISTEN_PORT}): ${err.message}`);
    process.exit(1);
  });
  srv.listen(LISTEN_PORT, host, () => {
    console.log(`lan-tls https://${host}:${LISTEN_PORT} -> http://${UP_HOST}:${UP_PORT}`);
  });
  return srv;
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  let pending = servers.length;
  for (const srv of servers) {
    srv.close(() => {
      if (--pending === 0) process.exit(0);
    });
  }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
