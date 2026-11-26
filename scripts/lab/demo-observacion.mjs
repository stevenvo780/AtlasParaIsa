import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [copia, salida, ...otros] = process.argv.slice(2);
assert.ok(copia && salida && otros.length === 0, 'Uso: node scripts/lab/demo-observacion.mjs WORKTREE_COMPILADO DIRECTORIO_NUEVO');
const segundos = process.env.ATLAS_DEMO_OBSERVACION_SEGUNDOS;
const duracionMs = segundos === undefined ? 0 : Number(segundos) * 1000;
assert.ok(segundos === undefined || (/^[1-9]\d*$/.test(segundos) && Number.isSafeInteger(duracionMs)),
  'ATLAS_DEMO_OBSERVACION_SEGUNDOS debe ser un entero positivo');
const raizCinta = process.env.ATLAS_DEMO_CINTA_RAIZ;
assert.ok(raizCinta === undefined || isAbsolute(raizCinta) && statSync(raizCinta, { throwIfNoEntry: false })?.isDirectory(),
  'ATLAS_DEMO_CINTA_RAIZ debe apuntar a un directorio absoluto existente');
const dosHorasMs = 120 * 60 * 1000;
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
const mundo = mkdtempSync(duracionMs ? join(resolve(salida), 'mundo-sostenida-') : join(tmpdir(), 'atlas-v24-demo-'));
const acceso = 'AtlasLab-' + randomBytes(16).toString('hex');
let directorioCinta;
const crearPasarela = () => createWorkerGateway({ worldPath: join(mundo, 'world.sqlite'), manual: true, deployment: true,
  password: acceso, origin: origen, turbo: true, tape: true, observerOnly: true,
  tapeDirectory: directorioCinta,
  staticDir: join(raiz, 'dist/client'), seed: 51926 });
const detener = new AbortController();
const interrumpir = () => detener.abort(new Error('Observación interrumpida.'));
let app;
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
let inicioVentana;
async function medirSalud(fase, registrar = true) {
  const muestra = { fase, fecha: new Date().toISOString(), transcurridosMs: Math.round(performance.now() - inicioVentana) };
  try {
    const signal = AbortSignal.any([detener.signal, AbortSignal.timeout(5000)]);
    const respuesta = await fetch(`${origen}/health`, { signal });
    muestra.http = respuesta.status;
    const { estado, tick, ultimoTickGuardado, ultimoGuardado, segundosDesdeUltimoPaso, ticksPorSegundo, recargas, epoca,
      operacion, diagnostico } = await respuesta.json();
    Object.assign(muestra, { estado, tick, ultimoTickGuardado, ultimoGuardado, segundosDesdeUltimoPaso,
      ticksPorSegundo, recargas, epoca, operacion, diagnostico });
    assert.equal(muestra.http, 200, `HTTP de salud en ${fase}`);
    assert.ok(estado === 'ok' || estado === 'degradado', `Simulación parada en ${fase}`);
    assert.ok(Number.isSafeInteger(tick) && tick > 0, `Falta un tick válido en ${fase}`);
    assert.ok(Number.isSafeInteger(ultimoTickGuardado) && ultimoTickGuardado > 0 && Number.isFinite(ultimoGuardado),
      `Falta un guardado válido en ${fase}`);
    return muestra;
  } catch (error) {
    muestra.error = error.message;
    throw error;
  } finally {
    if (registrar || muestra.error) appendFileSync(join(salida, 'salud.ndjson'), JSON.stringify(muestra) + '\n', { mode: 0o600 });
  }
}
async function observarSostenida() {
  inicioVentana = performance.now();
  const inicio = await medirSalud('inicio');
  const desde = performance.now();
  const intervaloMs = Math.min(30_000, Math.max(1000, duracionMs / 4));
  let fin = inicio, muestras = 1;
  do {
    await esperar(intervaloMs, undefined, { signal: detener.signal });
    const actual = await medirSalud('turbo');
    assert.ok(actual.tick > fin.tick, `El tick no avanzó entre ${fin.tick} y ${actual.tick}`);
    assert.ok(actual.ultimoTickGuardado >= fin.ultimoTickGuardado, 'El último tick guardado retrocedió');
    fin = actual;
    muestras++;
  } while (performance.now() - desde < duracionMs);
  const duracionObservadaMs = Math.floor(performance.now() - desde);
  const ticksGuardados = fin.ultimoTickGuardado - inicio.ultimoTickGuardado;
  if (duracionMs >= dosHorasMs) assert.ok(ticksGuardados > 0, 'El guardado no avanzó durante la observación');
  return { inicio, fin, muestras, duracionSolicitadaMs: duracionMs, duracionObservadaMs,
    cumple120Minutos: duracionMs >= dosHorasMs && duracionObservadaMs >= dosHorasMs, ticksGuardados };
}
let navegador;
if (duracionMs) {
  process.on('SIGINT', interrumpir);
  process.on('SIGTERM', interrumpir);
}
try {
  if (raizCinta) directorioCinta = mkdtempSync(join(raizCinta, 'atlas-v24-cinta-'));
  app = crearPasarela();
  await abrir();
  app.start();
  navegador = await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ['--disable-gpu'] });
  const vistas = [];
  for (const [nombre, ancho, alto] of [['escritorio', 1440, 900], ['movil', 390, 844], ['movil-compacto', 320, 720]]) {
    const tactil = nombre !== 'escritorio';
    const contexto = await navegador.newContext({ viewport: { width: ancho, height: alto }, reducedMotion: 'reduce', hasTouch: tactil });
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
      const play = pagina.locator('[data-dvr-play]');
      if (await play.getAttribute('aria-pressed') === 'true') await play.click();
      await expect(play).toHaveAttribute('aria-pressed', 'false');
      await pagina.locator('#population-toggle').click();
      await pagina.locator('#population-list .population-person').nth(2).click();
      const historia = pagina.locator('#inspector-tab-story');
      await historia.click();
      await expect(historia).toHaveAttribute('aria-selected', 'true');
      await expect(rango).toBeVisible();
      const activo = await play.getAttribute('aria-pressed');
      await play.click();
      await expect(play).toHaveAttribute('aria-pressed', String(activo !== 'true'));
      await expect.poll(() => rango.evaluate(n => Number(n.max) - Number(n.min)), { timeout: 10_000 }).toBeGreaterThan(25);
      const presente = pagina.locator('[data-dvr-live]');
      await rango.press('Home');
      await expect(presente).toHaveAttribute('aria-pressed', 'false');
      let cintaSeparaControles;
      if (tactil) {
        await expect(pagina.locator('[data-dvr-desfase]')).toContainText('de mundo hasta el presente');
        const geometria = await rango.evaluate(control => {
          const borde = getComputedStyle(control);
          const extension = parseFloat(borde.outlineWidth) + parseFloat(borde.outlineOffset);
          const caja = selector => document.querySelector(selector).getBoundingClientRect();
          const barra = caja('#dvr-bar');
          return { foco: control.matches(':focus-visible') && borde.outlineStyle !== 'none',
            focoFin: control.getBoundingClientRect().bottom + extension, etiquetasInicio: caja('.dvr-readout').top,
            fichaFin: caja('#inspector-drawer').bottom, cintaInicio: barra.top,
            cintaFin: barra.bottom, navegacionInicio: caja('#population-toggle').top };
        });
        cintaSeparaControles = geometria.foco && geometria.focoFin <= geometria.etiquetasInicio &&
          geometria.fichaFin <= geometria.cintaInicio && geometria.cintaFin <= geometria.navegacionInicio;
        assert.equal(cintaSeparaControles, true, `El foco, las etiquetas, la ficha y la navegación deben caber juntos: ${JSON.stringify({ nombre, ...geometria })}`);
      }
      await pagina.screenshot({ path: join(salida, `${nombre}-historia.png`) });
      await presente.click();
      await expect(presente).toHaveAttribute('aria-pressed', 'true');
      await expect(historia).toHaveAttribute('aria-selected', 'true');
      assert.equal(await pagina.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errores, []);
      vistas.push({ nombre, ancho, alto, controlesConHistoria: true, cintaSeparaControles });
    } finally { await contexto.close(); }
  }
  await navegador.close();
  navegador = undefined;
  await expect.poll(() => app.salud().ultimoTickGuardado, { timeout: 10_000 }).toBeGreaterThan(0);
  const observacion = duracionMs ? await observarSostenida() : undefined;
  const respuesta = await fetch(`${origen}/health`, { signal: AbortSignal.timeout(5000) });
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
  const sha256 = huella(anterior);
  await app.close();
  let guardado;
  const personasZstd = process.env.CARTA_SNAPSHOT_PERSONAS_ZSTD === '1';
  if (personasZstd || process.env.CARTA_SNAPSHOT_PACKED_PEOPLE === '1') {
    const db = new DatabaseSync(join(mundo, 'world.sqlite'), { readOnly: true });
    try {
      const { body } = db.prepare('SELECT body FROM main.snapshots WHERE slot=0').get();
      const { snapshotEncoding, people } = JSON.parse(body);
      assert.equal(snapshotEncoding, personasZstd ? 'snapshot-parts-v4' : 'snapshot-parts-v3');
      assert.ok(people.count > 0 && people.pages.length > 0);
      const pagina = db.prepare('SELECT body FROM main.snapshot_parts WHERE digest=?').get(people.pages[0].digest);
      assert.ok(pagina.body instanceof Uint8Array);
      const formatoPagina = Buffer.from(pagina.body.subarray(0, 4)).toString('ascii');
      assert.ok(formatoPagina === 'WPF1' || (personasZstd && formatoPagina === 'WZP1'));
      guardado = { formato: snapshotEncoding, personas: people.count, paginas: people.pages.length };
    } finally { db.close(); }
    // La pasarela que reabre prueba la lectura sin activar la opción de escritura experimental.
    delete process.env.CARTA_SNAPSHOT_PACKED_PEOPLE;
    delete process.env.CARTA_SNAPSHOT_PERSONAS_ZSTD;
  }
  app = crearPasarela();
  await abrir();
  const leerDespues = await clienteCinta();
  const recuperado = await leerDespues(consulta);
  assert.ok(recuperado.baseFrame);
  assert.equal(huella(recuperado), sha256);
  let reanudacion;
  if (observacion) {
    const reabierta = await medirSalud('reabierta');
    assert.ok(reabierta.tick >= salud.tick && reabierta.ultimoTickGuardado === reabierta.tick,
      'La pasarela debe reabrir el mundo desde el último guardado y conservar el avance observado');
    app.start();
    await expect.poll(async () => (await medirSalud('reanudada', false)).tick, { timeout: 15_000 }).toBeGreaterThan(reabierta.tick);
    reanudacion = { reabierta, reanudada: await medirSalud('reanudada') };
  }
  const evidencia = { tick: salud.tick, ultimoTickGuardado: salud.ultimoTickGuardado, vistas,
    recargaCinta: { tick: recuperado.baseFrame.tick, epoca: recuperado.epoca, sha256, huellaExacta: true },
    ...(guardado && { guardado }),
    ...(directorioCinta && { almacenamiento: { dispositivoMundo: statSync(mundo).dev,
      dispositivoCinta: statSync(directorioCinta).dev } }),
    ...(observacion && { sostenida: { ...observacion, reanudacion } }) };
  writeFileSync(join(salida, 'observacion.json'), JSON.stringify(evidencia, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidencia));
} finally {
  try { await navegador?.close(); }
  finally {
    try { await app?.close(); }
    finally {
      try {
        try { rmSync(mundo, { recursive: true, force: true }); }
        finally { if (directorioCinta) rmSync(directorioCinta, { recursive: true, force: true }); }
      } finally {
        process.off('SIGINT', interrumpir);
        process.off('SIGTERM', interrumpir);
      }
    }
  }
}
