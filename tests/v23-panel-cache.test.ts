import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { biologia, confirmar, correrPanel, correrPanelAsync, crearRaiz, leerFilas, leerTexto, PANEL, sinMarca, temporal } from './v23-panel-ayuda.js';

const base = temporal();
test.after(() => rmSync(base, { recursive: true, force: true }));

const raiz = crearRaiz(base, 'raiz');
const entradas = (cache: string): string[] => !existsSync(cache) ? [] : readdirSync(cache).flatMap(clave => readdirSync(join(cache, clave)).map(f => join(clave, f))).sort();
let contador = 0;
/** Una petición de panel de una semilla y una réplica; devuelve el resultado y la ruta del JSONL. */
function pedir(cache: string, extra: string[] = [], opciones: { raiz?: string; semilla?: number; dias?: number; salida?: string } = {}) {
  const salida = opciones.salida ?? join(base, `salida-${++contador}`), r = opciones.raiz ?? raiz, semilla = opciones.semilla ?? 7;
  const resultado = correrPanel(['--brazo', r, '--semillas', String(semilla), '--replicas', '1', '--dias', String(opciones.dias ?? 4), '--paralelo', '1', '--cache', cache, '--salida', salida, ...extra]);
  return { ...resultado, jsonl: join(salida, `1-${r.split('/').at(-1)}-${semilla}-1.jsonl`), inicio: () => leerFilas(join(salida, `1-${r.split('/').at(-1)}-${semilla}-1.jsonl`))[0]! };
}

test('la segunda petición de la misma corrida sale de la caché con el mismo JSONL salvo la marca de la fila de inicio', t => {
  const cache = join(base, 'cache-a'), salida = join(base, 'repetida');
  const primera = pedir(cache, [], { salida }), textoPrimera = leerTexto(primera.jsonl);
  assert.equal(primera.codigo, 0, primera.stderr);
  assert.equal(primera.inicio().cache.estado, 'fallo');
  assert.deepEqual(entradas(cache).map(e => e.split('/')[1]), ['4-completo.jsonl']);
  rmSync(salida, { recursive: true });
  const segunda = pedir(cache, [], { salida });
  assert.equal(segunda.codigo, 0, segunda.stderr);
  assert.equal(segunda.inicio().cache.estado, 'acierto');
  assert.equal(segunda.salida.cache.aciertos, 1);
  assert.equal(segunda.salida.cache.fallos, 0);
  // La única diferencia es la marca: el resto de los bytes, la carga y la memoria del inicio incluidas, son los de la corrida que se simuló.
  assert.equal(sinMarca(leerTexto(segunda.jsonl)), sinMarca(textoPrimera));
  assert.notEqual(leerTexto(segunda.jsonl), textoPrimera);
  t.diagnostic(`segunda petición: ${segunda.ms} ms; la que simuló: ${primera.ms} ms`);
});

test('el panel decide igual con una corrida servida de la caché que con la simulada', () => {
  const cache = join(base, 'cache-veredicto');
  const simulada = pedir(cache), servida = pedir(cache);
  assert.equal(servida.inicio().cache.estado, 'acierto');
  assert.deepEqual(servida.salida.brazos, simulada.salida.brazos);
});

test('cambiar cualquier parte de la clave da fallo de caché y no pisa la entrada anterior', () => {
  const cache = join(base, 'cache-b'), paramsRuta = join(base, 'params-b.json');
  writeFileSync(paramsRuta, JSON.stringify({ mundo: { natalidad: 3 } }));
  const claveBase = pedir(cache).inicio().cache.clave;
  assert.equal(pedir(cache).inicio().cache.estado, 'acierto', 'control: la petición idéntica sí acierta');
  const variantes: [string, string[], { semilla?: number; dias?: number }][] = [
    ['semilla', [], { semilla: 8 }], ['tope de mortales', ['--tope-mortales', '500'], {}], ['régimen', ['--regimen', 'defecto'], {}],
    ['parámetros', ['--params', paramsRuta], {}], ['cadencia del censo', ['--cada-ticks', '240'], {}],
  ];
  const vistas = new Set([claveBase]);
  for (const [nombre, extra, opciones] of variantes) {
    const r = pedir(cache, extra, opciones), marca = r.inicio().cache;
    assert.equal(r.codigo, 0, r.stderr);
    assert.equal(marca.estado, 'fallo', `${nombre} no debía acertar`);
    assert.ok(!vistas.has(marca.clave), `${nombre}: la clave no cambió`);
    vistas.add(marca.clave);
    assert.equal(pedir(cache, extra, opciones).inicio().cache.estado, 'acierto', `${nombre}: repetida sí acierta`);
  }
  assert.equal(entradas(cache).length, vistas.size);
  // Otro árbol de código (otro tree de git) tampoco acierta, aunque todo lo demás sea igual.
  const otro = crearRaiz(base, 'otro-arbol');
  confirmar(otro, 'src/world/diversidad.ts', 'export const indiceDiversidad = (mundo: any) => ({ total: mundo.people.length / 20 });\n');
  const r = pedir(cache, [], { raiz: otro });
  assert.equal(r.inicio().cache.estado, 'fallo');
  assert.ok(!vistas.has(r.inicio().cache.clave));
});

test('dos raíces con el mismo árbol de código comparten entrada y la corrida servida lleva las etiquetas de su brazo', () => {
  const cache = join(base, 'cache-gemelas'), gemela = crearRaiz(base, 'gemela');
  const primera = pedir(cache), segunda = pedir(cache, [], { raiz: gemela });
  assert.equal(segunda.inicio().cache.estado, 'acierto');
  assert.deepEqual(biologia(leerFilas(segunda.jsonl)).map(f => f.brazo), Array(5).fill('1-gemela'));
  assert.deepEqual(biologia(leerFilas(segunda.jsonl)).map(({ brazo, ...resto }) => resto), biologia(leerFilas(primera.jsonl)).map(({ brazo, ...resto }) => resto));
});

test('un árbol con cambios sin commitear no lee ni escribe la caché', () => {
  const cache = join(base, 'cache-sucia'), sucia = crearRaiz(base, 'sucia');
  assert.equal(pedir(cache, [], { raiz: sucia }).inicio().cache.estado, 'fallo');
  const antes = entradas(cache);
  const ensuciar: [string, () => void, () => void][] = [
    ['fichero versionado modificado', () => writeFileSync(join(sucia, 'src/world/diversidad.ts'), 'export const indiceDiversidad = (mundo: any) => ({ total: 99 });\n'), () => execFileSync('git', ['-C', sucia, 'checkout', '--', '.'])],
    ['fichero nuevo sin seguimiento', () => writeFileSync(join(sucia, 'nuevo-sin-seguimiento.txt'), 'x\n'), () => rmSync(join(sucia, 'nuevo-sin-seguimiento.txt'))],
  ];
  for (const [nombre, ensuciarla, limpiar] of ensuciar) {
    ensuciarla();
    const r = pedir(cache, [], { raiz: sucia });
    assert.equal(r.codigo, 0, r.stderr);
    assert.equal(r.inicio().cache.estado, 'sin-cache', nombre);
    assert.match(r.inicio().cache.motivo, /sin commitear/);
    assert.equal(r.salida.cache.sinCache, 1);
    assert.deepEqual(entradas(cache), antes, `${nombre}: una corrida de un árbol sucio no escribe`);
    limpiar();
  }
  assert.equal(pedir(cache, [], { raiz: sucia }).inicio().cache.estado, 'acierto', 'limpio otra vez, la entrada anterior sigue sirviendo');
  const motor = pedir(cache, ['--hilos', '2']);
  assert.equal(motor.inicio().cache.estado, 'sin-cache');
  assert.match(motor.inicio().cache.motivo, /reproducible/);
});

test('45 días en caché sirven una petición de 30 sin simular, con las mismas filas que una corrida directa', () => {
  const cache = join(base, 'cache-prefijo');
  const larga = pedir(cache, [], { dias: 9 });
  assert.equal(larga.inicio().cache.estado, 'fallo');
  const corta = pedir(cache, [], { dias: 5 });
  assert.equal(corta.inicio().cache.estado, 'acierto');
  assert.equal(corta.inicio().cache.prefijo, true);
  assert.equal(corta.inicio().cache.diasOrigen, 9);
  assert.equal(corta.inicio().dias, 5);
  const directa = pedir('sin', [], { dias: 5 });
  assert.equal(directa.inicio().cache, undefined, 'sin caché pedida, la fila de inicio no cambia de forma');
  assert.deepEqual(biologia(leerFilas(corta.jsonl)), biologia(leerFilas(directa.jsonl)));
  const fin = leerFilas(corta.jsonl).at(-1)!, finDirecto = leerFilas(directa.jsonl).at(-1)!;
  assert.deepEqual({ ...fin, maxRssMiB: 0 }, { ...finDirecto, maxRssMiB: 0 });
  // Un horizonte más largo que cualquier entrada completa no se puede servir.
  assert.equal(pedir(cache, [], { dias: 12 }).inicio().cache.estado, 'fallo');
  // Entre dos entradas que sirven, se toma la más corta.
  assert.equal(pedir(cache, [], { dias: 7 }).inicio().cache.diasOrigen, 9);
  assert.equal(pedir(cache, [], { dias: 10 }).inicio().cache.diasOrigen, 12);
});

test('una corrida detenida por extinción o por tope sirve a cualquier horizonte posterior y a los anteriores como prefijo', () => {
  const cache = join(base, 'cache-parada'), paramsRuta = join(base, 'params-parada.json');
  writeFileSync(paramsRuta, JSON.stringify({ mundo: { extincionDia: 3 } }));
  const extra = ['--params', paramsRuta];
  const origen = pedir(cache, extra, { dias: 6 });
  assert.equal(leerFilas(origen.jsonl).at(-1)!.estado, 'extinta');
  for (const dias of [2, 3, 5, 9]) {
    const servida = pedir(cache, extra, { dias }), directa = pedir('sin', extra, { dias });
    assert.equal(servida.inicio().cache.estado, 'acierto', `${dias} días`);
    assert.deepEqual(biologia(leerFilas(servida.jsonl)), biologia(leerFilas(directa.jsonl)), `${dias} días`);
    const finServida = leerFilas(servida.jsonl).at(-1)!, finDirecto = leerFilas(directa.jsonl).at(-1)!;
    assert.deepEqual({ ...finServida, maxRssMiB: 0 }, { ...finDirecto, maxRssMiB: 0 }, `${dias} días`);
    assert.equal(finServida.estado, dias >= 3 ? 'extinta' : 'completo');
  }
  assert.deepEqual(entradas(cache).map(e => e.split('/')[1]), ['6-extinta-3.jsonl']);
  const crecer = join(base, 'params-tope.json');
  writeFileSync(crecer, JSON.stringify({ mundo: { natalidad: 8, mortalidad: 0 } }));
  const conTope = pedir(cache, ['--params', crecer, '--tope-mortales', '12'], { dias: 12 }), fin = leerFilas(conTope.jsonl).at(-1)!;
  assert.equal(fin.estado, 'tope');
  const servida = pedir(cache, ['--params', crecer, '--tope-mortales', '12'], { dias: 20 });
  assert.equal(servida.inicio().cache.estado, 'acierto');
  assert.deepEqual({ ...leerFilas(servida.jsonl).at(-1), maxRssMiB: 0 }, { ...fin, maxRssMiB: 0 });
  assert.deepEqual(biologia(leerFilas(servida.jsonl)), biologia(leerFilas(conTope.jsonl)));
});

test('dos procesos con la misma clave a la vez dejan una sola entrada válida y ningún temporal', async () => {
  const cache = join(base, 'cache-concurrente');
  const resultados = await Promise.all([0, 1, 2, 3].map(n => correrPanelAsync(['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '40', '--paralelo', '1', '--cache', cache, '--salida', join(base, `concurrente-${n}`)])));
  for (const r of resultados) assert.equal(r.codigo, 0, r.stderr);
  const claves = readdirSync(cache);
  assert.equal(claves.length, 1);
  assert.deepEqual(readdirSync(join(cache, claves[0]!)), ['40-completo.jsonl']);
  const censos = resultados.map((_, n) => biologia(leerFilas(join(base, `concurrente-${n}`, '1-raiz-7-1.jsonl'))));
  for (const c of censos) assert.deepEqual(c, censos[0]);
  assert.equal(pedir(cache, [], { dias: 40 }).inicio().cache.estado, 'acierto');
});

test('una corrida con error o interrumpida nunca entra en la caché', async () => {
  const cache = join(base, 'cache-error'), paramsRuta = join(base, 'params-error.json');
  writeFileSync(paramsRuta, JSON.stringify({ mundo: { fallaEnDia: 2 } }));
  const fallida = pedir(cache, ['--params', paramsRuta], { dias: 4 });
  assert.equal(fallida.codigo, 1);
  assert.deepEqual(entradas(cache), []);
  // Interrumpida: se mata el panel (y con él sus procesos) cuando la corrida ya escribió su inicio.
  const salida = join(base, 'interrumpida');
  const hijo = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), PANEL, '--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '100000', '--paralelo', '1', '--cache', cache, '--salida', salida], { env: { ...process.env, CARTA_PANEL_CACHE: '' } });
  const cierre = new Promise(cumplir => hijo.once('close', cumplir));
  const limite = Date.now() + 60_000;
  while (Date.now() < limite && !(existsSync(join(salida, '1-raiz-7-1.jsonl')) && leerTexto(join(salida, '1-raiz-7-1.jsonl')).includes('"tipo":"censo"'))) await new Promise(r => setTimeout(r, 100));
  hijo.kill('SIGTERM');
  await cierre;
  assert.deepEqual(entradas(cache), []);
});

test('con caché, las réplicas idénticas de una semilla se simulan una vez y las demás se sirven de su entrada', () => {
  const cache = join(base, 'cache-replicas'), salida = join(base, 'replicas');
  const r = correrPanel(['--brazo', raiz, '--semillas', '7,9', '--replicas', '3', '--dias', '4', '--paralelo', '4', '--cache', cache, '--salida', salida]);
  assert.equal(r.codigo, 0, r.stderr);
  assert.equal(r.salida.cache.fallos, 2);
  assert.equal(r.salida.cache.aciertos, 4);
  assert.deepEqual(r.salida.pseudorreplicas, ['1-raiz/7', '1-raiz/9']);
  for (const semilla of [7, 9]) for (const replica of [2, 3]) {
    const filas = leerFilas(join(salida, `1-raiz-${semilla}-${replica}.jsonl`));
    assert.equal(filas[0]!.cache.estado, 'acierto');
    assert.ok(biologia(filas).every(f => f.replica === replica));
  }
  const sin = correrPanel(['--brazo', raiz, '--semillas', '7', '--replicas', '3', '--dias', '4', '--paralelo', '4', '--cache', 'sin', '--salida', join(base, 'replicas-sin')]);
  assert.equal(sin.salida.cache, undefined);
});
