// Caja cerrada de materia (enmiendas 1 y 2, «ciclos cerrados»): solo piezas reales (arena de A, química de Q, pasoLote
// y fluir de P, copiar, desprender y quemar de L); ver tests/lib/caja-cerrada.ts. En ≥ 40 recambios de biomasa, con y sin
// fuego: el agua no se agota, el H₂ no se acumula (se estabiliza) y átomos y energía cuadran al entero en cada recambio.
// La enmienda 2 añade lo que encontró la validación de los ciclos: geometrías que se secaban (hallazgo 1), el suelo frío
// que hacía HCN (hallazgo 3) y el fuego a 400 recambios con plantillas que aceptan N₂ y el P₂O₅ gaseoso (hallazgo 2).
import assert from 'node:assert/strict';
import test from 'node:test';
import { cajaCerrada, mesetaH2, type FotoCaja, type ResultadoCaja } from './lib/caja-cerrada.js';
import type { ServicioQuimico } from '../src/world/materia/tipos.js';

const media = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const tramo = (f: FotoCaja[], desde: number, hasta: number) => f.filter((x) => x.recambio >= desde && x.recambio <= hasta);
const fijo = (f: FotoCaja) => (f.n.NH3 ?? 0) + (f.n.proteina ?? 0);
const AIRE_100 = { N2: 780_000_000, O2: 210_000_000, CO2: 20_000_000 };
/** Control: la química que ve la cinética sin la catálisis H–H en las reacciones del H₂ (como antes de la enmienda 1). */
const sinHH = (q: ServicioQuimico): ServicioQuimico => ({
  internar: (e) => q.internar(e), sustancia: (id) => q.sustancia(id),
  reaccion: (a, b, n) => {
    const x = q.reaccion(a, b, n);
    const esH2 = (id: number) => id > 0 && q.sustancia(id).atomos.every((v, e) => (e === 0 ? v === 2 : v === 0)); // H es el elemento 0
    return x && (esH2(a) || esH2(b)) && x.catalisis === 3 ? { ...x, catalisis: -1 as const } : x;
  },
});

/** `techoH2`: fracción del H que el H₂ no pasa en ningún recambio ni en su meseta prevista (`mesetaH2`: extrapolación de
 * primer orden de la segunda mitad, infinita si sube sin frenar o no hay sumidero); `estable`: la media de los últimos 10 recambios no pasa de 1,15 la
 * de los 10 anteriores. Revisión de la enmienda 3, hallazgo 6: antes se miraban siempre los recambios 21–30 y 31–40 (en
 * la caja de 400 con fuego, nada del final) y solo el techo en lo corrido, que una caja con aire ×100 sin sumidero de
 * H₂ pasaba a los 40 recambios mientras se secaba. */
function comprobar(r: ResultadoCaja, etiqueta: string, { techoH2 = 0.005, estable = true } = {}): void {
  const f = r.fotos, r0 = f.find((x) => x.recambio === 0)!, fin = f[f.length - 1]!;
  assert.ok(fin.recambio >= 40, `${etiqueta}: ${fin.recambio} recambios`);
  // Átomos y energía: saldo = fuentes − sumideros (luz, termostatos, chispa) al entero en cada recambio.
  for (const x of f) assert.ok(x.exacto, `${etiqueta}: descuadre en el recambio ${x.recambio}`);
  // Agua: no baja del 97 % de la del arranque en ningún recambio (lo que falta está en la biomasa y el H₂).
  for (const x of f) assert.ok(x.agua >= 0.97 * f[0]!.agua, `${etiqueta}: agua ${x.agua} en el recambio ${x.recambio}`);
  // H₂: acotado (< 0,5 % del H) en lo corrido y en la meseta prevista, y estabilizado al final.
  for (const x of f) assert.ok(x.hH2 < techoH2 * x.hTotal, `${etiqueta}: H₂ ${x.h2} en el recambio ${x.recambio}`);
  const meseta = mesetaH2(f);
  assert.ok(meseta < techoH2, `${etiqueta}: meseta prevista de H₂ ${(100 * meseta).toFixed(3)} % del H`);
  const n = fin.recambio, tarde = media(tramo(f, n - 9, n).map((x) => x.h2)), antes = media(tramo(f, n - 19, n - 10).map((x) => x.h2));
  // Suelo absoluto de 10⁻⁵ del H (el de medirCaja): por debajo, unas decenas de cuantos de ruido no son crecer.
  if (estable) assert.ok(tarde <= 1.15 * antes + 1e-5 * fin.hTotal / 2, `${etiqueta}: H₂ sigue creciendo (${antes.toFixed(0)} → ${tarde.toFixed(0)})`);
  assert.ok(r0.agua > 0 && fin.hTotal === f[0]!.hTotal, `${etiqueta}: el H total no cambia`);
}

test('caja cerrada sin fuego: 40 recambios con agua, H₂ estable, N fijado intacto y balance exacto', (t) => {
  const r = cajaCerrada({ recambios: 40 });
  comprobar(r, 'sin fuego');
  const f = r.fotos, r0 = f.find((x) => x.recambio === 0)!, fin = f[f.length - 1]!;
  // Sin fuego ni fijadores, el N fijado (NH₃ + proteína) no se pierde a N₂: < 0,1 %.
  assert.ok(fijo(r0) - fijo(fin) < 0.001 * fijo(r0), `N fijado ${fijo(r0)} → ${fijo(fin)}`);
  // La planta sostiene su biomasa (limitada por la luz) en los últimos 10 recambios.
  const bio = tramo(f, 31, 40).map((x) => x.biomasa);
  assert.ok(Math.min(...bio) >= 0.9 * Math.max(...f.map((x) => x.biomasa)), `biomasa ${bio}`);
  t.diagnostic(`${r.ticks} ticks en ${r.ms.toFixed(0)} ms; agua ${f[0]!.agua} → ${fin.agua}; H₂ ${fin.h2} (${(100 * fin.hH2 / fin.hTotal).toFixed(3)} % del H)`);
  t.diagnostic(`H₂ neto por proceso: ${Object.entries(r.flujos).map(([k, v]) => `${k} ${v.H2}`).join(', ')}`);
  t.diagnostic(`P al final: ${JSON.stringify(fin.p)}`);
});

test('caja cerrada con fuego cada 4 recambios, 400 recambios: plantas que aceptan N₂ y P₂O₅ gas sostienen la biomasa', (t) => {
  // Hallazgo 2: el fuego deja el N fijado como N₂ y el P como P₂O₅ molecular (gas); con plantillas que solo toman NH₃ y
  // los fosfatos del suelo la biomasa cae a ~5.000 en 100 recambios (ver el control). Con N₂ y P₂O₅ gas entre sus
  // entradas (crearPlantilla las balancea) la planta se sostiene: es un pedido a W, B y T1, no una ley de la materia.
  const r = cajaCerrada({ recambios: 400, cadaFuego: 4, fraccionFuego: 0.3, nitrogenos: ['NH3', 'N2'], fosfatoGas: true });
  comprobar(r, 'con fuego');
  assert.ok(r.fuegos.length >= 99, `${r.fuegos.length} fuegos`);
  const bio = r.fotos.map((x) => x.biomasa), tarde = tramo(r.fotos, 361, 400).map((x) => x.biomasa);
  const temprano = tramo(r.fotos, 21, 40).map((x) => x.biomasa);
  assert.ok(Math.min(...tarde) >= 0.6 * Math.max(...bio), `biomasa mínima de los recambios 361–400: ${Math.min(...tarde)}`);
  assert.ok(media(tarde) >= 0.9 * media(temprano), `biomasa media ${media(temprano).toFixed(0)} → ${media(tarde).toFixed(0)}`);
  const suma = (x: Record<string, number>) => Object.values(x).reduce((s, v) => s + v, 0);
  let nFijado = 0, nAN2 = 0, pOrg = 0;
  const pDestino: Record<string, number> = {};
  for (const g of r.fuegos) {
    // La hoguera conserva cada átomo de P; de N solo gana el del N₂ del aire que entra.
    const nAire = suma(g.nDespues) - suma(g.nAntes);
    assert.ok(nAire >= 0 && suma(g.pDespues) === suma(g.pAntes), `fuego del tick ${g.tick}`);
    nFijado += suma(g.nAntes) - (g.nAntes.N2 ?? 0);
    nAN2 += (g.nDespues.N2 ?? 0) - nAire - (g.nAntes.N2 ?? 0);
    pOrg += suma(g.pAntes);
    for (const [k, v] of Object.entries(g.pDespues)) pDestino[k] = (pDestino[k] ?? 0) + v;
  }
  const f = r.fotos, r0 = f.find((x) => x.recambio === 0)!, fin = f[f.length - 1]!;
  t.diagnostic(`${r.fuegos.length} fuegos, T máx ${Math.max(...r.fuegos.map((g) => g.tMax)).toFixed(0)} K; N fijado quemado ${nFijado}, a N₂ ${nAN2} (${(100 * nAN2 / nFijado).toFixed(1)} %)`);
  t.diagnostic(`P quemado ${pOrg}: ${JSON.stringify(pDestino)}`);
  t.diagnostic(`N fijado de la caja ${fijo(r0)} → ${fijo(fin)}; biomasa ${r0.biomasa} → ${fin.biomasa}; P final ${JSON.stringify(fin.p)}`);
  t.diagnostic(`H₂ neto por proceso: ${Object.entries(r.flujos).map(([k, v]) => `${k} ${v.H2}`).join(', ')}; ${r.ticks} ticks en ${r.ms.toFixed(0)} ms`);
});

test('control: con fuego y plantillas que solo toman NH₃ y los fosfatos del suelo, la biomasa colapsa (la prueba distingue)', (t) => {
  const r = cajaCerrada({ recambios: 80, cadaFuego: 4, fraccionFuego: 0.3 });
  const bio = r.fotos.map((x) => x.biomasa), tarde = tramo(r.fotos, 61, 80).map((x) => x.biomasa);
  t.diagnostic(`biomasa máxima ${Math.max(...bio)}, media de los recambios 61–80 ${media(tarde).toFixed(0)}; ${r.ticks} ticks en ${r.ms.toFixed(0)} ms`);
  assert.ok(media(tarde) < 0.5 * Math.max(...bio), 'sin N₂ ni P₂O₅ gas entre las entradas, el fuego vacía la caja');
});

test('geometría (hallazgo 1): con aire 100 veces mayor y sin herbívoro, o con poros 100 veces menores, el agua y el H₂ aguantan', (t) => {
  // Antes de la enmienda 2 el único retorno del H₂ era 2 H₂ + O₂ en el suelo a ~10⁻³ L/(cuanto·tick) y la meseta crecía
  // como 1 + capAire/capSuelo: con razón 1.000 y la hojarasca entera al suelo (CH₂ → H₂ + C catalizada) la caja tenía el
  // 2,6 % del H en H₂ a los 10 recambios y el 96 % del agua; acababa seca. Con la familia H–H sin barrera, las endotérmicas
  // sin catálisis y (revisión de la enmienda 3) el H₂ que nace en el suelo oxidado en el mismo paso, la meseta prevista es
  // del ~0,003 % del H con aire ×100 y del ~0,04 % con poros ÷100 (40 recambios; antes de los pases encadenados, ~0,06 %
  // a 1.000 recambios). Se exige < 0,2 % en lo corrido y en la meseta prevista (el control de abajo distingue).
  for (const [etiqueta, op] of [
    ['aire ×100, sin herbívoro', { aire: AIRE_100, capAire: 10_000, fTubo: 0 }],
    ['poros ÷100, sin herbívoro', { capSuelo: 0.1, fTubo: 0 }],
  ] as const) {
    const r = cajaCerrada({ recambios: 40, ...op });
    comprobar(r, etiqueta, { techoH2: 0.002 });
    const fin = r.fotos[r.fotos.length - 1]!;
    t.diagnostic(`${etiqueta}: agua ${r.fotos[0]!.agua} → ${fin.agua}; H₂ ${fin.h2} (${(100 * fin.hH2 / fin.hTotal).toFixed(4)} % del H, meseta prevista ${(100 * mesetaH2(r.fotos)).toFixed(4)} %); ${r.ticks} ticks en ${r.ms.toFixed(0)} ms`);
  }
});

test('control: con aire ×100 y sin la catálisis H–H, a los 40 recambios pasa el techo y el agua, pero no la meseta prevista', (t) => {
  // Revisión de la enmienda 3, hallazgo 6: sin sumidero de H₂ la caja se seca despacio (el revisor: 2,71 % del H en H₂ y
  // 96,17 % del agua a los 650 recambios), y a los 40 aún está bajo el 0,2 % y sobre el 97 %. La meseta prevista lo ve.
  const r = cajaCerrada({ recambios: 40, aire: AIRE_100, capAire: 10_000, fTubo: 0, cinetica: sinHH });
  const f = r.fotos, fin = f[f.length - 1]!;
  t.diagnostic(`H₂ ${(100 * fin.hH2 / fin.hTotal).toFixed(4)} % del H; agua mín ${(100 * Math.min(...f.map((x) => x.agua)) / f[0]!.agua).toFixed(2)} %; hecho ${fin.h2Hecho}, gastado ${fin.h2Gastado}`);
  assert.ok(f.every((x) => x.hH2 < 0.002 * x.hTotal && x.agua >= 0.97 * f[0]!.agua), 'el criterio de antes no distinguía');
  assert.equal(mesetaH2(f), Infinity);
  assert.throws(() => comprobar(r, 'control', { techoH2: 0.002, estable: false }), /meseta prevista/);
});

test('frío (hallazgo 3): a 275 K todo el tiempo y por estaciones de 200 ticks, el suelo devuelve el N sin hacer HCN', (t) => {
  // Por debajo de 282,84 K (nivel 1, calculado a 259,4 K) el NH₃ del modelo no es gas y el suelo catalizado hacía HCN, que
  // nada consume por debajo de una llama: a 275 K la caja perdía todo el NH₃ y colapsaba en 8–9 recambios. Con
  // NIVEL_CATALIZADO el suelo frío elige los productos del nivel 2, a la tasa de su T real.
  for (const [etiqueta, op] of [['275 K', { tAmbiente: 275 }], ['estaciones 295/275 K', { periodo: 200, tFrio: 275 }]] as const) {
    const r = cajaCerrada({ recambios: 40, ...op });
    comprobar(r, etiqueta);
    const f = r.fotos, r0 = f.find((x) => x.recambio === 0)!, fin = f[f.length - 1]!;
    const otros = Object.entries(fin.n).filter(([k]) => !['N2', 'NH3', 'proteina'].includes(k));
    assert.deepEqual(otros, [], `${etiqueta}: N fuera de N₂, NH₃ y proteína`);
    assert.ok(fijo(r0) - fijo(fin) < 0.001 * fijo(r0), `${etiqueta}: N fijado ${fijo(r0)} → ${fijo(fin)}`);
    const bio = tramo(f, 31, 40).map((x) => x.biomasa);
    assert.ok(Math.min(...bio) >= 0.9 * Math.max(...f.map((x) => x.biomasa)), `${etiqueta}: biomasa ${bio}`);
    t.diagnostic(`${etiqueta}: N fijado ${fijo(r0)} → ${fijo(fin)}; biomasa ${r0.biomasa} → ${fin.biomasa}; ${r.ticks} ticks en ${r.ms.toFixed(0)} ms`);
  }
});

test('control: sin la catálisis H–H (familia 3), la misma caja acumula H₂ (la prueba distingue)', (t) => {
  // El suelo deja de oxidar el H₂ (2 H₂ + O₂ → 2 H₂O sin familia catalizable, como antes de la enmienda 1): el H₂ crece
  // sin estabilizarse y el agua baja con él.
  const r = cajaCerrada({ recambios: 40, cinetica: sinHH });
  assert.equal(mesetaH2(r.fotos), Infinity, 'sin sumidero, la meseta prevista no tiene techo');
  const f = r.fotos, fin = f[f.length - 1]!;
  const tarde = media(tramo(f, 31, 40).map((x) => x.h2)), antes = media(tramo(f, 21, 30).map((x) => x.h2));
  t.diagnostic(`H₂ ${antes.toFixed(0)} → ${tarde.toFixed(0)}; final ${fin.h2} (${(100 * fin.hH2 / fin.hTotal).toFixed(3)} % del H); agua ${f[0]!.agua} → ${fin.agua}`);
  assert.ok(tarde > 1.15 * antes, 'sin la catálisis H–H el H₂ seguiría creciendo');
});

// El subconjunto rápido de la batería de 80 cajas de las validaciones (HCN, H₂ y agua, N a N₂ con fuego, P bloqueado; enmienda
// 3) está en tests/materia-caja-bateria.test.ts: con la caja de 400 recambios con fuego de este fichero, juntos pasaban
// de los 600 s que da el --test-timeout a cada fichero con la torre cargada; separados corren en paralelo.
