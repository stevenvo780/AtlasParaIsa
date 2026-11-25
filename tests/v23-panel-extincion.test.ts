import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { evaluarPanel, type CensoPanel, type CorridaPanel } from '../scripts/lab/panel.js';
import { biologia, confirmar, correrPanel, crearRaiz, leerFilas, leerTexto, temporal } from './v23-panel-ayuda.js';

const base = temporal();
test.after(() => rmSync(base, { recursive: true, force: true }));

const censo = (dia: number, mortales: number, extra: Partial<CensoPanel> = {}): CensoPanel => ({
  tipo: 'censo', brazo: 'a', semilla: 1, replica: 1, dia, tick: dia * 2400, mortales, nacimientos: Math.min(dia, 12), muertes: Math.min(dia, 12) + 14 - mortales,
  causas: { starvation: Math.floor((Math.min(dia, 12) + 14 - mortales) / 2), dehydration: Math.ceil((Math.min(dia, 12) + 14 - mortales) / 2), exposure: 0, senescence: 0 },
  fundadoresMortalesVivos: 0, comunidades: 0, estructuras: 0, fauna: 0, biomasaMedia: 0.5, diversidad: 1, duras: 0, blandas: 0, comprobacionesRegion: 10,
  ticksPorSegundo: 100, pasoP95Ms: 1, pasoMaxMs: 2, rssMiB: 100, ...extra });
const poblacion = (dia: number, extincion: number) => dia >= extincion ? 0 : dia <= 10 ? 14 + dia : Math.max(1, 24 - 3 * (dia - 10));
/** La corrida de siempre (sigue hasta el horizonte con el mundo vacío) y la que se detiene el día de la extinción. */
function corridas(extincion: number, horizonte = 30): { entera: CorridaPanel; temprana: CorridaPanel } {
  const todos = Array.from({ length: horizonte + 1 }, (_, dia) => censo(dia, poblacion(dia, extincion)));
  // Congelados en el día de la extinción: sin mortales no nace nadie ni muere nadie más.
  const congelado = todos[extincion]!;
  const entera: CorridaPanel = { brazo: 'a', semilla: 1, replica: 1, estado: 'completo', ramBytes: 1e12, maxRssMiB: 100, censos: todos.map(c => c.dia <= extincion ? c : { ...congelado, dia: c.dia, tick: c.tick }) };
  return { entera, temprana: { ...entera, censos: entera.censos.slice(0, extincion + 1), extinta: extincion } };
}

test('las puertas dan lo mismo con una corrida extinta que se detuvo ese día que con la que siguió hasta el horizonte', () => {
  for (const extincion of [6, 18, 24, 29, 30, 35]) {
    const { entera, temprana } = corridas(extincion, 36);
    const [a, b] = [evaluarPanel([entera]), evaluarPanel([temprana])];
    assert.deepEqual(b, a, `extinción el día ${extincion}`);
    if (extincion <= 30) assert.equal(b.M2.estado, 'falla', `extinción el día ${extincion}: M2 no puede quedar desconocida`);
  }
  const { temprana } = corridas(24);
  assert.equal(evaluarPanel([temprana]).M1.estado, 'falla');
  assert.equal(evaluarPanel([temprana]).M4.estado, 'falla');
});

test('una corrida con error o sin extinción declarada sigue sin dar por cumplido lo que no se midió', () => {
  const { entera } = corridas(24);
  const cortada: CorridaPanel = { ...entera, censos: entera.censos.slice(0, 20) };
  assert.equal(evaluarPanel([cortada]).M2.estado, 'desconocido');
});

test('la corrida se detiene el día en que no queda ningún mortal y termina con estado extinta', () => {
  const params = join(base, 'extincion.json'), raiz = crearRaiz(base, 'raiz');
  writeFileSync(params, JSON.stringify({ mundo: { extincionDia: 3 } }));
  const salida = join(base, 'extinta');
  const r = correrPanel(['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '8', '--paralelo', '1', '--params', params, '--cache', 'sin', '--salida', salida]);
  assert.equal(r.codigo, 0, r.stderr);
  const filas = leerFilas(join(salida, '1-raiz-7-1.jsonl')), censos = filas.filter(f => f.tipo === 'censo');
  assert.deepEqual(censos.map(c => c.dia), [0, 1, 2, 3]);
  assert.equal(censos.at(-1)!.mortales, 0);
  assert.ok(censos.slice(0, -1).every(c => c.mortales > 0));
  assert.deepEqual({ ...filas.at(-1), maxRssMiB: 0 }, { tipo: 'fin', estado: 'extinta', dia: 3, maxRssMiB: 0 });
  const informe = JSON.parse(leerTexto(join(salida, 'panel.json')));
  assert.equal(informe.corridas[0].estado, 'completo');
  assert.equal(informe.corridas[0].extinta, 3);
  assert.equal(r.salida.brazos['1-raiz'].M2.estado, 'falla');
  assert.equal(r.salida.brazos['1-raiz'].M1.estado, 'falla');
  // Mismas filas que dejaba la corrida que seguía hasta el horizonte, hasta el día de la extinción.
  const larga = correrPanel(['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '3', '--paralelo', '1', '--params', params, '--cache', 'sin', '--salida', join(base, 'hasta-3')]);
  assert.deepEqual(biologia(filas), biologia(leerFilas(join(base, 'hasta-3', '1-raiz-7-1.jsonl'))));
  assert.equal(larga.codigo, 0);
});

test('una corrida que no se extingue ni pasa del tope llega al horizonte como siempre', () => {
  const raiz = crearRaiz(base, 'viva'), salida = join(base, 'viva-salida');
  const r = correrPanel(['--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '5', '--paralelo', '1', '--cache', 'sin', '--salida', salida]);
  assert.equal(r.codigo, 0, r.stderr);
  const filas = leerFilas(join(salida, '1-viva-7-1.jsonl'));
  assert.deepEqual(filas.filter(f => f.tipo === 'censo').map(c => c.dia), [0, 1, 2, 3, 4, 5]);
  assert.equal(filas.at(-1)!.estado, 'completo');
  assert.equal(filas[0]!.cache, undefined);
});

test('comparar dos brazos con una corrida extinta compara mortales y nacimientos y no inventa biomasa ni diversidad', () => {
  const vivo = crearRaiz(base, 'brazo-vivo'), extinto = crearRaiz(base, 'brazo-extinto');
  confirmar(extinto, 'src/world/params.ts', readFileSync(join(extinto, 'src/world/params.ts'), 'utf8').replace('extincionDia: 0', 'extincionDia: 3'));
  const salida = join(base, 'comparacion');
  const r = correrPanel(['--comparar', `${vivo},${extinto}`, '--semillas', '7,9', '--replicas', '1', '--dias', '6', '--paralelo', '2', '--cache', 'sin', '--salida', salida]);
  assert.equal(r.codigo, 0, r.stderr);
  for (const metrica of ['mortales', 'nacimientos']) assert.ok(typeof r.salida.comparacion[metrica].p === 'number', `${metrica} se compara: ${JSON.stringify(r.salida.comparacion[metrica])}`);
  for (const metrica of ['biomasaMedia', 'diversidad']) {
    assert.equal(r.salida.comparacion[metrica].estado, 'desconocido');
    assert.match(r.salida.comparacion[metrica].motivo, /extinta/);
  }
  assert.equal(r.salida.brazos['2-brazo-extinto'].M2.estado, 'falla');
});
