import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertWorld, createWorld, stepWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { demographicTraits } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf } from '../src/world/params.js';
import { tileAt } from '../src/world/spatial.js';
import { crearComprobador } from '../src/world/invariantes.js';
import { agrupar, agruparEspacio, archivoDeChunks, cargarPunto, celdasDeTierra, clavePersona, guardarPunto, medir, paramsDeCorrida, poblar, ventana, type Grupo, type Registro, type Zona } from '../scripts/lab/poblacion.mjs';

// Pruebas con el mundo de verdad (régimen abierto del panel, un hilo, sin tarjeta). Sondas cortas: la torre va cargada.
const ZONA: Zona = { x: 0, y: 0, ancho: 48, alto: 32 };
const abierto = () => paramsDeCorrida({ regimen: 'abierto', hilos: 1, gpu: [] });
const sembrado = (semilla: number, n: number, siembra = semilla) => {
  const mundo = createWorld(semilla, abierto());
  return { mundo, ...poblar(mundo, { n, zona: ZONA, siembra }) };
};

const sinTiempos = (r: Registro) => JSON.stringify({ ...r, dias: r.dias.map(({ msPared, ticksPorSegundo, carga, ...d }) => d) });

test('(a) poblar y medir es reproducible con un hilo y semilla, y cada sembrado pasa las validaciones del mundo', { timeout: 1_200_000 }, () => {
  const correrSonda = () => {
    const { mundo, sembrados, caminables } = sembrado(7, 40);
    assert.equal(sembrados.length, 40);
    assert.equal(mundo.people.filter(p => p.role === 'neighbor').length, 40, 'los vecinos fundadores se sustituyen');
    assertWorld(mundo);
    assert.deepEqual(crearComprobador()(mundo).filter(v => v.gravedad === 'dura'), []);
    const inicial = digestoCanonico(mundo), totales = { ...mundo.totals }, muertes = { ...mundo.demographyDynamics.causes };
    const { archivar } = archivoDeChunks(mundo);
    const registro = medir(mundo, { dias: 1, ticks: 600, zona: ZONA, caminables, archivar, cadaInvariantes: 300 });
    assertWorld(mundo);
    assert.equal(registro.violaciones.duras, 0);
    // El registro cuadra con la contabilidad del propio mundo.
    const nacidos = registro.individuos.filter(i => i.origen === 'nacido');
    assert.equal(nacidos.length, (mundo.totals.births ?? 0) - (totales.births ?? 0));
    for (const causa of ['starvation', 'dehydration', 'exposure', 'senescence'] as const)
      assert.equal(registro.individuos.filter(i => i.causa === causa).length, mundo.demographyDynamics.causes[causa] - muertes[causa]);
    assert.equal(registro.individuos.filter(i => i.hasta === null).length, mundo.people.filter(p => p.role === 'neighbor').length);
    assert.equal(registro.individuos.reduce((s, i) => s + i.hijos.length, 0), 2 * nacidos.length);
    // Lo anotado por bloques, donde ocurrió, suma lo mismo que lo anotado por persona.
    const [ti, tf] = ventana(registro, 0), espacio = agruparEspacio(registro, ti, tf, 16), personas = agrupar(registro.individuos, ti, tf, clavePersona);
    const total = (gs: Grupo[]) => gs.reduce((t, g) => ({ e: t.e + g.exposicion, b: t.b + g.nacimientos, m: t.m + Object.values(g.muertes).reduce((a, x) => a + x, 0), p: t.p + g.parejas }), { e: 0, b: 0, m: 0, p: 0 });
    const te = total(espacio), tp = total(personas), muertos = registro.individuos.filter(i => i.hasta !== null).length;
    assert.equal(te.b, tp.b); assert.equal(te.m, tp.m); assert.equal(te.p, tp.p);
    // Por persona cuenta (desde, hasta]; por bloque, cada paso en que está viva: difieren en un paso por nacimiento o muerte.
    assert.ok(Math.abs(te.e - tp.e) * TICKS_PER_DAY <= muertos + nacidos.length + 1e-6, `exposición ${te.e} frente a ${tp.e}`);
    return { inicial, final: digestoCanonico(mundo), registro };
  };
  const a = correrSonda(), b = correrSonda();
  assert.equal(a.inicial, b.inicial, 'misma siembra: mismo mundo poblado');
  assert.equal(a.final, b.final, 'mismo mundo tras 600 pasos');
  assert.equal(sinTiempos(a.registro), sinTiempos(b.registro), 'mismo registro');
  const otra = createWorld(7, abierto());
  poblar(otra, { n: 40, zona: ZONA, siembra: 8 });
  assert.notEqual(digestoCanonico(otra), a.inicial, 'otra siembra: otra población');
});

test('un punto guardado sigue igual que el mundo que no se detuvo', { timeout: 600_000 }, () => {
  mkdirSync('/tmp/atlas-v23-pob', { recursive: true });
  const dir = mkdtempSync('/tmp/atlas-v23-pob/test-'), ruta = join(dir, 'punto.v8');
  try {
    const continuo = sembrado(51926, 30).mundo, partido = sembrado(51926, 30).mundo;
    const archivoContinuo = archivoDeChunks(continuo), archivoPartido = archivoDeChunks(partido);
    // Hasta los ~300 pasos ningún chunk se retira: con menos, el archivo irá vacío y la prueba no probaría el archivo.
    for (let t = 0; t < 450; t++) { stepWorld(continuo); stepWorld(partido); }
    archivoContinuo.archivar(); archivoPartido.archivar();
    assert.ok(archivoPartido.archivo.size > 0, 'hay chunks retirados que guardar');
    guardarPunto(ruta, partido, archivoPartido.archivo);
    const { mundo: cargado, archivo } = cargarPunto(ruta);
    assert.deepEqual([...archivo.keys()].sort(), [...archivoPartido.archivo.keys()].sort());
    archivoDeChunks(cargado, archivo);
    assertWorld(cargado);
    assert.deepEqual(paramsOf(cargado), paramsOf(continuo));
    for (let t = 0; t < 300; t++) { stepWorld(continuo); stepWorld(cargado); }
    assert.equal(digestoCanonico(cargado), digestoCanonico(continuo));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('la densidad cuenta tierra, no agua: la zona con agua tiene menos celdas caminables y nadie se siembra en ella', { timeout: 600_000 }, () => {
  const zona: Zona = { x: -32, y: -32, ancho: 128, alto: 96 };
  const mundo = createWorld(7, abierto()), { sembrados, caminables } = poblar(mundo, { n: 30, zona, siembra: 7 });
  let tierra = 0;
  for (let y = zona.y; y < zona.y + zona.alto; y++) for (let x = zona.x; x < zona.x + zona.ancho; x++) if (tileAt(mundo, { x, y })?.terrain !== 'water') tierra++;
  assert.ok(tierra < zona.ancho * zona.alto, 'la zona elegida contiene agua');
  assert.equal(caminables, tierra);
  assert.equal(celdasDeTierra(mundo, zona).length, tierra);
  for (const p of sembrados) assert.notEqual(tileAt(mundo, { x: p.x, y: p.y })?.terrain, 'water');
});

test('cada muerte lleva su causa: el registro coincide con la contabilidad del mundo causa a causa', () => {
  const causas = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
  const { mundo, sembrados, caminables } = sembrado(7, causas.length);
  mundo.weather = 'rain';
  // Cuerpos vivos al borde de morir. La necesidad o el desgaste dominantes se resuelven en el paso real.
  for (const [i, causa] of causas.entries()) {
    const persona = sembrados[i]!;
    const rasgos = demographicTraits(persona.genome, paramsOf(mundo).cuerpo);
    const edad = causa === 'senescence' ? rasgos.maximumAge - 1 : rasgos.maturityAge;
    persona.bornAt = mundo.tick - edad;
    persona.lastBirth = mundo.tick - Math.min(edad, TICKS_PER_DAY);
    persona.demography = { age: edad, health: 1e-8, vitality: 0.1, deathCause: null };
    persona.hunger = causa === 'starvation' ? 1 : 0.2;
    persona.thirst = causa === 'dehydration' ? 1 : 0.2;
    persona.action = 'rest';
    persona.decisionAt = mundo.tick + 2;
  }
  assertWorld(mundo);
  const antes = { ...mundo.demographyDynamics.causes }, { archivar } = archivoDeChunks(mundo);
  const registro = medir(mundo, { dias: 1, ticks: 1, cadaInvariantes: 1, zona: ZONA, caminables, archivar });
  assertWorld(mundo);
  assert.deepEqual(registro.violaciones, { duras: 0, blandas: 0, comprobaciones: 2 });
  assert.equal(registro.individuos.length, causas.length);
  for (const [i, causa] of causas.entries()) {
    const baja = registro.individuos.find(individuo => individuo.id === sembrados[i]!.id);
    assert.equal(baja?.causa, causa);
    assert.equal(baja.hasta, 1);
    assert.equal(registro.individuos.filter(individuo => individuo.causa === causa).length, mundo.demographyDynamics.causes[causa] - antes[causa], causa);
  }
});

test('sustituir a los fundadores no deja vínculos ni comunidades que apunten a quien ya no existe', { timeout: 600_000 }, () => {
  for (const semilla of [7, 51926]) {
    const { mundo } = sembrado(semilla, 20), ids = new Set(mundo.people.map(p => p.id));
    for (const p of mundo.people) for (const otro of Object.keys(p.bonds)) assert.ok(ids.has(otro), `${p.id} → ${otro}`);
    for (const c of mundo.communities) for (const m of c.members) assert.ok(ids.has(m), `${c.id} → ${m}`);
    for (const p of mundo.people) assert.ok(p.communityId === null || mundo.communities.some(c => c.id === p.communityId));
  }
});
