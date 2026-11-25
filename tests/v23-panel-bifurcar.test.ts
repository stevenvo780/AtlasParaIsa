import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { biologia, correrPanel, crearRaiz, leerFilas, temporal } from './v23-panel-ayuda.js';

const base = temporal();
test.after(() => rmSync(base, { recursive: true, force: true }));


/** Una corrida que guarda su punto en `dia` y sigue hasta `dias`, y otra que arranca de ese punto y llega al mismo horizonte. */
function bifurcar(raiz: string, semillas: number[], dias: number, dia: number, nombre: string, extra: string[] = []) {
  const puntos = join(base, `${nombre}-puntos`), comun = ['--brazo', raiz, '--semillas', semillas.join(','), '--replicas', '1', '--dias', String(dias), '--paralelo', '2', '--cache', 'sin'];
  const seguida = correrPanel([...comun, '--guardar-dia', String(dia), '--guardar-en', puntos, '--salida', join(base, `${nombre}-seguida`)]);
  const retomada = correrPanel([...comun, '--desde', puntos, '--salida', join(base, `${nombre}-retomada`), ...extra]);
  const filas = (cual: string, semilla: number) => leerFilas(join(base, `${nombre}-${cual}`, `1-${raiz.split('/').at(-1)}-${semilla}-1.jsonl`));
  return { seguida, retomada, puntos, filas };
}

test('una corrida seguida de 8 días y otra que guarda en el día 4, recarga y sigue dan exactamente las mismas filas de censo, en 2 semillas', () => {
  const raiz = crearRaiz(base, 'raiz'), { seguida, retomada, puntos, filas } = bifurcar(raiz, [7, 9], 8, 4, 'identidad');
  assert.equal(seguida.codigo, 0, seguida.stderr);
  assert.equal(retomada.codigo, 0, retomada.stderr);
  for (const semilla of [7, 9]) {
    assert.ok(existsSync(join(puntos, `${semilla}-1.punto`)));
    assert.deepEqual(biologia(filas('retomada', semilla)), biologia(filas('seguida', semilla)), `semilla ${semilla}`);
    assert.equal(filas('retomada', semilla).filter(f => f.tipo === 'censo').length, 9);
    const inicio = filas('retomada', semilla)[0]!;
    assert.equal(inicio.bifurcacion.dia, 4);
    assert.equal(inicio.bifurcacion.tick, 4 * 2400);
    assert.equal(inicio.bifurcacion.origen.arbol.length, 40);
    assert.equal(filas('seguida', semilla)[0]!.bifurcacion, undefined);
    assert.equal(filas('retomada', semilla).at(-1)!.estado, 'completo');
  }
  assert.deepEqual(retomada.salida.brazos, seguida.salida.brazos);
});

test('arrancar de un punto con otros parámetros deja los días guardados como estaban y cambia lo que viene después', () => {
  const raiz = crearRaiz(base, 'otros-params'), params = join(base, 'otros.json');
  writeFileSync(params, JSON.stringify({ mundo: { natalidad: 9, mortalidad: 0 } }));
  const { retomada, seguida, filas } = bifurcar(raiz, [7], 8, 4, 'otros', ['--params', params]);
  assert.equal(retomada.codigo, 0, retomada.stderr);
  const antes = biologia(filas('seguida', 7)), despues = biologia(filas('retomada', 7));
  assert.deepEqual(despues.filter(f => f.dia <= 4), antes.filter(f => f.dia <= 4));
  assert.notDeepEqual(despues.filter(f => f.dia > 4), antes.filter(f => f.dia > 4));
  assert.ok(despues.at(-1)!.mortales > antes.at(-1)!.mortales, 'con natalidad 9 y sin mortalidad hay más gente');
  assert.equal(filas('retomada', 7)[0]!.params.mundo.natalidad, 9);
  assert.equal(filas('retomada', 7)[0]!.params.mundo.gente, 8, 'lo no tocado se hereda del punto, no del régimen');
  assert.equal(seguida.codigo, 0);
});

test('la bifurcada puede guardar a su vez otro punto y la extinción también termina una corrida retomada', () => {
  const raiz = crearRaiz(base, 'extincion'), params = join(base, 'extincion.json'), puntos = join(base, 'extincion-puntos'), otros = join(base, 'extincion-otros');
  writeFileSync(params, JSON.stringify({ mundo: { extincionDia: 6 } }));
  const comun = ['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--paralelo', '1', '--cache', 'sin'];
  assert.equal(correrPanel([...comun, '--dias', '4', '--guardar-dia', '2', '--guardar-en', puntos, '--salida', join(base, 'extincion-a')]).codigo, 0);
  const b = correrPanel([...comun, '--dias', '9', '--desde', puntos, '--params', params, '--guardar-dia', '4', '--guardar-en', otros, '--salida', join(base, 'extincion-b')]);
  assert.equal(b.codigo, 0, b.stderr);
  const filas = leerFilas(join(base, 'extincion-b', '1-extincion-7-1.jsonl'));
  assert.deepEqual(filas.filter(f => f.tipo === 'censo').map(f => f.dia), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(filas.at(-1)!.estado, 'extinta');
  assert.ok(existsSync(join(otros, '7-1.punto')));
  const c = correrPanel([...comun, '--dias', '9', '--desde', otros, '--params', params, '--salida', join(base, 'extincion-c')]);
  assert.equal(c.codigo, 0, c.stderr);
  assert.deepEqual(biologia(leerFilas(join(base, 'extincion-c', '1-extincion-7-1.jsonl'))), biologia(filas));
});

test('las opciones de punto se rechazan cuando no pueden dar un resultado exacto', () => {
  const raiz = crearRaiz(base, 'rechazos'), puntos = join(base, 'rechazos-puntos'), comun = ['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--paralelo', '1', '--cache', 'sin'];
  // Los errores de argumentos salen por stderr del panel; los del proceso que simula, en la fila `proceso-error` de su JSONL.
  let n = 0;
  const rechazo = (args: string[], patron: RegExp) => {
    const salida = join(base, `rechazo-${++n}`), r = correrPanel([...comun, ...args, '--salida', salida]);
    assert.notEqual(r.codigo, 0);
    const jsonl = join(salida, '1-rechazos-7-1.jsonl');
    assert.match(r.stderr + (existsSync(jsonl) ? readFileSync(jsonl, 'utf8') : ''), patron);
  };
  rechazo(['--dias', '4', '--guardar-dia', '2'], /van juntos/);
  rechazo(['--dias', '4', '--guardar-dia', '9', '--guardar-en', puntos], /no puede pasar de --dias/);
  rechazo(['--dias', '4', '--guardar-dia', '2', '--guardar-en', puntos, '--hilos', '2'], /--hilos 1/);
  rechazo(['--dias', '4', '--desde', puntos], /No hay punto guardado/);
  assert.equal(correrPanel([...comun, '--dias', '4', '--guardar-dia', '2', '--guardar-en', puntos, '--salida', join(base, 'rechazos-ok')]).codigo, 0);
  rechazo(['--dias', '2', '--desde', puntos], /--dias debe ser mayor/);
  const otra = correrPanel(['--brazo', raiz, '--semillas', '8', '--replicas', '1', '--dias', '4', '--desde', puntos, '--cache', 'sin', '--salida', join(base, 'rechazo-semilla')]);
  assert.notEqual(otra.codigo, 0, 'sin punto de esa semilla no se arranca');
  const dosBrazos = correrPanel(['--comparar', `${raiz},${raiz}x`, '--dias', '4', '--guardar-dia', '2', '--guardar-en', puntos, '--salida', join(base, 'rechazo-brazos')]);
  assert.match(dosBrazos.stderr, /dos brazos|un solo brazo/i);
});

/** Opt-in: la prueba con el mundo real tarda minutos por día simulado. `CARTA_PANEL_REAL=1` la activa;
 * `CARTA_PANEL_REAL_DIAS` y `CARTA_PANEL_REAL_PUNTO` fijan el horizonte y el día guardado (el experimento de aceptación usa 20 y 10). */
test('mundo real: guardar en el día N, recargar en otro proceso y seguir da las mismas filas de censo, en 2 semillas', { skip: process.env.CARTA_PANEL_REAL ? false : 'actívese con CARTA_PANEL_REAL=1 (tarda minutos por día simulado)', timeout: 24 * 3600_000 }, () => {
  const dias = Number(process.env.CARTA_PANEL_REAL_DIAS ?? 2), dia = Number(process.env.CARTA_PANEL_REAL_PUNTO ?? 1);
  const raiz = process.env.CARTA_PANEL_REAL_RAIZ ?? dirname(dirname(fileURLToPath(import.meta.url)));
  const { seguida, retomada, filas } = bifurcar(raiz, [51926, 19104], dias, dia, 'real');
  assert.equal(seguida.codigo, 0, seguida.stderr);
  assert.equal(retomada.codigo, 0, retomada.stderr);
  for (const semilla of [51926, 19104]) assert.deepEqual(biologia(filas('retomada', semilla)), biologia(filas('seguida', semilla)), `semilla ${semilla}`);
});
