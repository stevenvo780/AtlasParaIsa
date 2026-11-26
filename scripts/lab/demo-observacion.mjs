import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [copia, salida, ...otros] = process.argv.slice(2);
assert.ok(copia && salida && otros.length === 0, 'Uso: node observar-demo.mjs WORKTREE_COMPILADO DIRECTORIO_NUEVO');
const raiz = resolve(copia);
const { chromium, expect } = createRequire(join(raiz, 'package.json'))('@playwright/test');
const { createWorkerGateway } = await import(pathToFileURL(join(raiz, 'dist/server/server/gateway.js')));
mkdirSync(salida, { mode: 0o700 });
process.env.CARTA_OPEN_WORLD = '1';
process.env.CARTA_MOTOR_HILOS = '1';
process.env.CARTA_MOTOR_GPU = '';
process.env.CARTA_PARAMS = 'persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true,' +
  'v23.guardadoCompleto=true,v23.fotograma=true,v23.cohesion=true,v23.natalidad=true,v23.comunidades=true,' +
  'v23.materia=true,v23.cuerpos=true,v23.fauna=true,v23.tecnica=true,v23.obra=true,v23.intentos=true';

const sonda = createServer();
sonda.listen(0, '127.0.0.1');
await once(sonda, 'listening');
const { port } = sonda.address();
await new Promise(ok => sonda.close(ok));
const origen = `http://127.0.0.1:${port}`;
const mundo = mkdtempSync('/tmp/atlas-v24-demo-');
const acceso = 'AtlasLab-' + randomBytes(16).toString('hex');
const crearPasarela = () => createWorkerGateway({ worldPath: join(mundo, 'world.sqlite'), manual: true, deployment: true,
  password: acceso, origin: origen, turbo: true, tape: true, observerOnly: true,
  staticDir: join(raiz, 'dist/client'), seed: 51926 });
let app = crearPasarela();
async function abrir() {
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  await app.ready;
}
async function clienteCinta() {
  const login = await fetch(`${origen}/api/login`, { method: 'POST', headers: { Origin: origen, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: acceso }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return async ruta => {
    const respuesta = await fetch(`${origen}${ruta}`, { headers: { Cookie: cookie } });
    assert.equal(respuesta.status, 200);
    return respuesta.json();
  };
}
let navegador;
try {
  await abrir();
  app.start();
  navegador = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--disable-gpu'] });
  const vistas = [];
  for (const [nombre, ancho, alto] of [['escritorio', 1440, 900], ['movil', 390, 844]]) {
    const contexto = await navegador.newContext({ viewport: { width: ancho, height: alto }, reducedMotion: 'reduce', hasTouch: nombre === 'movil' });
    try {
      const pagina = await contexto.newPage();
      const errores = [];
      pagina.on('pageerror', error => errores.push(error.message));
      await pagina.goto(origen);
      await pagina.getByLabel('Contraseña privada').fill(acceso);
      await pagina.getByRole('button', { name: 'Entrar a la carta' }).click();
      await pagina.locator('#letter-dialog').waitFor({ state: 'hidden', timeout: 10_000 });
      await pagina.locator('#map-loading').waitFor({ state: 'hidden', timeout: 10_000 });
      const rango = pagina.locator('[data-dvr-range]');
      await expect(rango).toBeVisible({ timeout: 12_000 });
      await pagina.screenshot({ path: join(salida, `${nombre}-mundo.png`) });
      await pagina.locator('#population-toggle').click();
      await pagina.locator('#population-list .population-person').nth(2).click();
      const historia = pagina.locator('#inspector-tab-story');
      await historia.click();
      await expect(historia).toHaveAttribute('aria-selected', 'true');
      await expect(rango).toBeVisible();
      const play = pagina.locator('[data-dvr-play]');
      const activo = await play.getAttribute('aria-pressed');
      await play.click();
      await expect(play).toHaveAttribute('aria-pressed', String(activo !== 'true'));
      await expect.poll(() => rango.evaluate(n => Number(n.max) - Number(n.min)), { timeout: 10_000 }).toBeGreaterThan(25);
      const presente = pagina.locator('[data-dvr-live]');
      await rango.press('Home');
      await expect(presente).toHaveAttribute('aria-pressed', 'false');
      await pagina.screenshot({ path: join(salida, `${nombre}-historia.png`) });
      await presente.click();
      await expect(presente).toHaveAttribute('aria-pressed', 'true');
      await expect(historia).toHaveAttribute('aria-selected', 'true');
      assert.equal(await pagina.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errores, []);
      vistas.push({ nombre, ancho, alto, controlesConHistoria: true });
    } finally { await contexto.close(); }
  }
  await expect.poll(() => app.salud().ultimoTickGuardado, { timeout: 10_000 }).toBeGreaterThan(0);
  const respuesta = await fetch(`${origen}/health`);
  const salud = await respuesta.json();
  assert.ok(respuesta.ok && salud.tick > 0 && salud.ultimoTickGuardado > 0);
  await app.flushTape();
  const leerAntes = await clienteCinta();
  const meta = await leerAntes('/api/cinta/meta');
  const ultimoDurableEnCinta = Math.min(meta.t1, salud.ultimoTickGuardado);
  assert.ok(ultimoDurableEnCinta > meta.t0);
  const tickCorte = Math.floor((ultimoDurableEnCinta + meta.t0) / 2);
  const consulta = `/api/cinta/chunk?t=${tickCorte}&n=1&nivel=auto&epoca=${meta.epoca}`;
  const huella = corte => createHash('sha256').update(JSON.stringify(corte.baseFrame)).digest('hex');
  const anterior = await leerAntes(consulta);
  assert.ok(anterior.baseFrame);
  await app.close();
  app = crearPasarela();
  await abrir();
  const leerDespues = await clienteCinta();
  const recuperado = await leerDespues(consulta);
  assert.ok(recuperado.baseFrame);
  assert.equal(huella(recuperado), huella(anterior));
  const evidencia = { tick: salud.tick, ultimoTickGuardado: salud.ultimoTickGuardado, vistas,
    recargaCinta: { tick: recuperado.baseFrame.tick, epoca: recuperado.epoca, huellaExacta: true } };
  writeFileSync(join(salida, 'observacion.json'), JSON.stringify(evidencia, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidencia));
} finally {
  await navegador?.close();
  await app.close();
  rmSync(mundo, { recursive: true, force: true });
}
