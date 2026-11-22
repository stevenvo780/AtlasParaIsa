import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';

function req(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

test('V17 extraOrigins: empareja estrictamente Host <-> Origin en público, VPN y LAN sin permitir cruces ni HTTP inseguro', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-extra-origins-'));
  const store = new Store(join(dir, 'world.sqlite'));
  try {
    // 1. Fail-closed: rechaza orígenes HTTP no seguros cuando secure=true.
    assert.throws(() => createApp({
      store, manual: true, password: 'clave-super-segura-1234',
      origin: 'https://atlas.humanizar.tech',
      extraOrigins: ['http://192.168.78.211:8443'],
      secure: true,
    }), /HTTPS/i);

    // 2. Arranca con 3 orígenes HTTPS (público + VPN + LAN).
    const app = createApp({
      store, manual: true, password: 'clave-super-segura-1234',
      origin: 'https://atlas.humanizar.tech',
      extraOrigins: ['https://100.64.0.1:8443', 'https://192.168.78.211:8443'],
      secure: true,
    });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const port = (app.server.address() as { port: number }).port;
    try {
      // Todos los hosts autorizados responden 200 en /health.
      for (const host of ['atlas.humanizar.tech', '100.64.0.1:8443', '192.168.78.211:8443']) {
        const res = await req(port, { path: '/health', headers: { Host: host } });
        assert.equal(res.status, 200, `health falló para ${host}`);
      }
      // Host desconocido -> 403.
      assert.equal((await req(port, { path: '/health', headers: { Host: 'evil.example:8443' } })).status, 403);

      // Cruce Host <-> Origin entre dos orígenes permitidos -> 403 (nunca cross-origin).
      const cross = await req(port, {
        method: 'POST', path: '/api/login',
        headers: { Host: 'atlas.humanizar.tech', Origin: 'https://192.168.78.211:8443', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'clave-super-segura-1234' }),
      });
      assert.equal(cross.status, 403);

      // Login válido en origen LAN devuelve cookie Secure y permite /api/world y WebSocket pareado.
      const login = await req(port, {
        method: 'POST', path: '/api/login',
        headers: { Host: '192.168.78.211:8443', Origin: 'https://192.168.78.211:8443', 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'clave-super-segura-1234' }),
      });
      assert.equal(login.status, 200);
      const setCookie = String(login.headers['set-cookie']?.[0] ?? '');
      assert.match(setCookie, /Secure/);
      const cookieHeader = setCookie.split(';')[0]!;

      const worldRes = await req(port, {
        path: '/api/world',
        headers: { Host: '192.168.78.211:8443', Cookie: cookieHeader },
      });
      assert.equal(worldRes.status, 200);

      // WebSocket con Host/Origin cruzados -> rechazado.
      await assert.rejects(new Promise<void>((resolve, reject) => {
        const wsBad = new WebSocket(`ws://127.0.0.1:${port}/ws?ack=1`, {
          headers: { Host: '100.64.0.1:8443', Origin: 'https://192.168.78.211:8443', Cookie: cookieHeader },
        });
        wsBad.once('open', () => { wsBad.close(); resolve(); });
        wsBad.once('error', reject);
      }));

      // WebSocket con Host/Origin VPN pareados -> aceptado.
      await new Promise<void>((resolve, reject) => {
        const wsOk = new WebSocket(`ws://127.0.0.1:${port}/ws?ack=1`, {
          headers: { Host: '100.64.0.1:8443', Origin: 'https://100.64.0.1:8443', Cookie: cookieHeader },
        });
        wsOk.once('open', () => { wsOk.close(); resolve(); });
        wsOk.once('error', reject);
      });
    } finally {
      await app.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
