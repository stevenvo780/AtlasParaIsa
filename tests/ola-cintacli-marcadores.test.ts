/**
 * Perfil y marcadores de la cinta, y la red `/api/cinta/*` del cliente (fetch simulado según `RutasCinta`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Marcador } from '../src/shared/cinta.js';
import { PerfilCinta, consultaChunk, crearRedCinta, esMarcador } from '../src/client/dvr-player.js';

function almacenEnMemoria() {
  const datos = new Map<string, string>();
  return { datos, getItem: (k: string) => datos.get(k) ?? null, setItem: (k: string, v: string) => { datos.set(k, v); } };
}
const marcador = (perfil: string, t: number, en: number): Marcador => ({ perfil, epoca: 2, t, nivel: 3, velocidad: 2, en });

test('perfil: el UUID se crea una vez, se guarda en localStorage y se reutiliza entre sesiones', () => {
  const almacen = almacenEnMemoria();
  let n = 0;
  const a = new PerfilCinta({ almacen, uuid: () => `uuid-${++n}` });
  assert.equal(a.perfil, 'uuid-1'); assert.equal(a.perfil, 'uuid-1');
  assert.equal(almacen.datos.get('carta.cinta.perfil'), 'uuid-1');
  const b = new PerfilCinta({ almacen, uuid: () => `uuid-${++n}` });
  assert.equal(b.perfil, 'uuid-1', 'otra sesión del mismo navegador es el mismo perfil');
});

test('perfil sin almacén o con almacén que lanza: sigue funcionando durante la página', async () => {
  const roto = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };
  const p = new PerfilCinta({ almacen: roto, uuid: () => 'abc' });
  assert.equal(p.perfil, 'abc');
  await p.guardar({ epoca: 1, t: 5, nivel: 0, velocidad: 1 });
  assert.equal(await p.ultimo(), null);
  const sin = new PerfilCinta({ almacen: null, uuid: () => 'def' });
  assert.equal(sin.perfil, 'def');
});

test('el UUID por defecto tiene la forma que exige el servidor', () => {
  const p = new PerfilCinta({ almacen: null });
  assert.match(p.perfil, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
});

test('ultimo: manda el más reciente entre servidor y local; ignora lo de otros perfiles y lo inválido', async () => {
  const almacen = almacenEnMemoria();
  let reloj = 100;
  const sinRed = new PerfilCinta({ almacen, uuid: () => 'yo', ahora: () => reloj });
  await sinRed.guardar({ epoca: 2, t: 1000, nivel: 3, velocidad: 2 });
  reloj = 300;
  const conRed = new PerfilCinta({ almacen, uuid: () => 'yo', ahora: () => reloj, red: {
    leer: async () => [marcador('yo', 7777, 200), marcador('otro', 1, 999), { basura: true } as unknown as Marcador],
    escribir: async () => true,
  } });
  assert.equal((await conRed.ultimo())!.t, 7777, 'el del servidor (200) es más reciente que el local (100)');
  await conRed.guardar({ epoca: 2, t: 2000, nivel: 4, velocidad: 1 });
  assert.equal((await conRed.ultimo())!.t, 2000, 'lo recién guardado (300) manda');
});

test('guardar: los tiempos van enteros, se guardan los 5 últimos y se escribe en el servidor con alSalir', async () => {
  const almacen = almacenEnMemoria();
  const escritas: { m: Marcador; alSalir: boolean }[] = [];
  let reloj = 1;
  const p = new PerfilCinta({ almacen, uuid: () => 'yo', ahora: () => reloj, red: { leer: async () => [], escribir: async (m, alSalir) => { escritas.push({ m, alSalir }); return true; } } });
  for (let i = 0; i < 7; i++) { reloj = 10 + i; await p.guardar({ epoca: 2.9, t: 100.7 + i, nivel: 1, velocidad: 5 }, i === 6); }
  assert.equal(escritas.length, 7); assert.equal(escritas[0]!.m.t, 100); assert.equal(escritas[0]!.m.epoca, 2);
  assert.equal(escritas[6]!.alSalir, true); assert.equal(escritas[5]!.alSalir, false);
  const locales = JSON.parse(almacen.datos.get('carta.cinta.marcadores')!) as Marcador[];
  assert.equal(locales.length, 5); assert.equal(locales[0]!.t, 106);
});

test('ruta de marcadores inexistente (404): solo localStorage y no se vuelve a preguntar al servidor', async () => {
  let lecturas = 0, escrituras = 0;
  const p = new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'yo', ahora: () => 5, red: { leer: async () => { lecturas++; return null; }, escribir: async () => { escrituras++; return false; } } });
  assert.equal(await p.ultimo(), null);
  await p.guardar({ epoca: 1, t: 50, nivel: 2, velocidad: 1 });
  await p.guardar({ epoca: 1, t: 60, nivel: 2, velocidad: 1 });
  assert.equal(lecturas, 1); assert.equal(escrituras, 0, 'tras el 404 del GET tampoco se intenta el PUT');
  assert.equal((await p.ultimo())!.t, 60, 'lo local sigue mandando');
  let puts = 0;
  const q = new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'yo', ahora: () => 5, red: { leer: async () => [], escribir: async () => { puts++; return false; } } });
  await q.guardar({ epoca: 1, t: 1, nivel: 0, velocidad: 1 }); await q.guardar({ epoca: 1, t: 2, nivel: 0, velocidad: 1 });
  assert.equal(puts, 1, 'un PUT 404 también desactiva la ruta');
});

test('un servidor que falla (no 404) no tira el marcador local ni desactiva la ruta', async () => {
  let intentos = 0;
  const p = new PerfilCinta({ almacen: almacenEnMemoria(), uuid: () => 'yo', ahora: () => 5, red: { leer: async () => { intentos++; throw new Error('500'); }, escribir: async () => true } });
  await p.guardar({ epoca: 1, t: 70, nivel: 0, velocidad: 1 });
  assert.equal((await p.ultimo())!.t, 70); assert.equal((await p.ultimo())!.t, 70);
  assert.equal(intentos, 2, 'se vuelve a intentar');
});

test('esMarcador valida la forma que el servidor guarda', () => {
  assert.equal(esMarcador(marcador('x', 1, 1)), true);
  assert.equal(esMarcador({ ...marcador('x', 1, 1), nivel: 7 }), false);
  assert.equal(esMarcador({ ...marcador('x', 1, 1), t: NaN }), false);
  assert.equal(esMarcador(null), false);
});

/* ------------------------------------------------------------------ */
/* Red                                                                */
/* ------------------------------------------------------------------ */

interface Llamada { url: string; init: RequestInit }
function redSimulada(respuesta: (url: string, init: RequestInit) => Response, opciones: { sesion?: () => void } = {}) {
  const llamadas: Llamada[] = [];
  const red = crearRedCinta({ fetch: async (url, init) => { llamadas.push({ url: String(url), init: init ?? {} }); return respuesta(String(url), init ?? {}); }, ...(opciones.sesion ? { alSesionTerminada: opciones.sesion } : {}) });
  return { red, llamadas };
}
const json = (valor: unknown, status = 200): Response => new Response(JSON.stringify(valor), { status, headers: { 'content-type': 'application/json' } });

test('consultaChunk: t, n y nivel siempre; época y cámara solo si existen', () => {
  assert.equal(consultaChunk({ t: 10.9, n: 90 }), 't=10&n=90&nivel=auto');
  assert.equal(consultaChunk({ t: 5, n: 1, nivel: 3, epoca: 2, x: 1, y: 2, w: 30, h: 20 }), 't=5&n=1&nivel=3&epoca=2&x=1&y=2&w=30&h=20');
  assert.equal(consultaChunk({ t: 5, n: 1, nivel: 0 }), 't=5&n=1&nivel=0');
});

test('red: meta y chunk van a /api/cinta/* con la sesión de la página y sin caché', async () => {
  const { red, llamadas } = redSimulada(url => json(url.includes('/meta') ? { version: 3 } : { nivel: 2, deltas: [] }));
  assert.deepEqual(await red.fetchMeta(), { version: 3 });
  const señal = new AbortController().signal;
  await red.fetchChunk({ t: 100, n: 50, nivel: 'auto', x: 1, y: 2, w: 3, h: 4, signal: señal });
  assert.equal(llamadas[0]!.url, '/api/cinta/meta');
  assert.equal(llamadas[1]!.url, '/api/cinta/chunk?t=100&n=50&nivel=auto&x=1&y=2&w=3&h=4');
  assert.equal(llamadas[1]!.init.signal, señal, 'el aborto del reproductor llega a la petición');
  assert.ok(llamadas.every(l => l.init.credentials === 'same-origin' && l.init.cache === 'no-store'));
  assert.ok(!llamadas.some(l => l.url.includes('/api/tape/')), 'ya no se usa /api/tape/*');
});

test('red: 401/403 avisa que la sesión terminó; otro error es «cinta no disponible»', async () => {
  let sesiones = 0;
  const { red } = redSimulada((_, init) => json({}, init.method === 'PUT' ? 500 : 401), { sesion: () => { sesiones++; } });
  await assert.rejects(red.fetchMeta(), /Sesión terminada/);
  assert.equal(sesiones, 1);
  const caida = redSimulada(() => json({}, 503));
  await assert.rejects(caida.red.fetchMeta(), /no está disponible/);
  await assert.rejects(caida.red.fetchChunk({ t: 0, n: 1, signal: new AbortController().signal }), /no está disponible/);
});

test('red de marcadores: GET con el perfil codificado, PUT con JSON, 404 = ruta ausente, keepalive al salir', async () => {
  const guardados: Marcador[] = [marcador('a b', 10, 1)];
  const { red, llamadas } = redSimulada((url, init) => {
    if (init.method === 'PUT') return json({ ok: true });
    return url.includes('perfil=ausente') ? json({}, 404) : json([...guardados, { basura: 1 }]);
  });
  assert.deepEqual(await red.marcadores.leer('a b'), guardados);
  assert.equal(llamadas[0]!.url, '/api/cinta/marcador?perfil=a%20b');
  assert.equal(await red.marcadores.leer('ausente'), null);
  assert.equal(await red.marcadores.escribir(marcador('a b', 20, 2), false), true);
  assert.equal(llamadas[2]!.init.method, 'PUT'); assert.equal(llamadas[2]!.url, '/api/cinta/marcador');
  assert.deepEqual(JSON.parse(String(llamadas[2]!.init.body)), marcador('a b', 20, 2));
  assert.equal(llamadas[2]!.init.keepalive, undefined);
  await red.marcadores.escribir(marcador('a b', 30, 3), true);
  assert.equal(llamadas[3]!.init.keepalive, true, 'al salir de la página sobrevive con keepalive (sendBeacon no puede hacer PUT)');
});

test('red de marcadores: PUT con 404 devuelve false y un 500 lanza', async () => {
  const ausente = redSimulada(() => json({}, 404));
  assert.equal(await ausente.red.marcadores.escribir(marcador('x', 1, 1), false), false);
  const caida = redSimulada(() => json({}, 500));
  await assert.rejects(caida.red.marcadores.escribir(marcador('x', 1, 1), false), /no se guardó/);
  await assert.rejects(caida.red.marcadores.leer('x'), /no respondieron/);
});
