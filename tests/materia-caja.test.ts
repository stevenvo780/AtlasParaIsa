// Caja cerrada de materia (enmienda 1, «ciclos cerrados»): solo piezas reales (arena de A, química de Q, pasoLote y
// fluir de P, copiar, desprender y quemar de L); ver tests/lib/caja-cerrada.ts. En ≥ 40 recambios de biomasa, con y sin
// fuego: el agua no se agota, el H₂ no se acumula (se estabiliza) y átomos y energía cuadran al entero en cada recambio.
// Dónde acaban el N y el P tras el fuego se informa (diagnóstico), no se fija: es un pedido abierto a Q, W, B y F.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cajaCerrada, type FotoCaja, type ResultadoCaja } from './lib/caja-cerrada.js';

const media = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const tramo = (f: FotoCaja[], desde: number, hasta: number) => f.filter((x) => x.recambio >= desde && x.recambio <= hasta);
const fijo = (f: FotoCaja) => (f.n.NH3 ?? 0) + (f.n.proteina ?? 0);

function comprobar(r: ResultadoCaja, etiqueta: string): void {
  const f = r.fotos, r0 = f.find((x) => x.recambio === 0)!, fin = f[f.length - 1]!;
  assert.ok(fin.recambio >= 40, `${etiqueta}: ${fin.recambio} recambios`);
  // Átomos y energía: saldo = fuentes − sumideros (luz, termostatos, chispa) al entero en cada recambio.
  for (const x of f) assert.ok(x.exacto, `${etiqueta}: descuadre en el recambio ${x.recambio}`);
  // Agua: no baja del 97 % de la del arranque en ningún recambio (lo que falta está en la biomasa y el H₂).
  for (const x of f) assert.ok(x.agua >= 0.97 * f[0]!.agua, `${etiqueta}: agua ${x.agua} en el recambio ${x.recambio}`);
  // H₂: acotado (< 0,5 % del H) y estabilizado: la media de los recambios 31–40 no pasa de 1,15 la de los 21–30.
  for (const x of f) assert.ok(x.hH2 < 0.005 * x.hTotal, `${etiqueta}: H₂ ${x.h2} en el recambio ${x.recambio}`);
  const tarde = media(tramo(f, 31, 40).map((x) => x.h2)), antes = media(tramo(f, 21, 30).map((x) => x.h2));
  assert.ok(tarde <= 1.15 * antes, `${etiqueta}: H₂ sigue creciendo (${antes.toFixed(0)} → ${tarde.toFixed(0)})`);
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

test('caja cerrada con fuego cada 4 recambios: agua, H₂ estable y balance exacto; informa N y P tras el fuego', (t) => {
  const r = cajaCerrada({ recambios: 40, cadaFuego: 4, fraccionFuego: 0.3 });
  comprobar(r, 'con fuego');
  assert.ok(r.fuegos.length >= 9, `${r.fuegos.length} fuegos`);
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

test('control: sin la catálisis H–H de la enmienda 1, la misma caja acumula H₂ (la prueba distingue)', (t) => {
  // El suelo deja de oxidar el H₂ (2 H₂ + O₂ → 2 H₂O sin familia catalizable, como antes de la enmienda): el H₂ crece
  // sin estabilizarse y el agua baja con él.
  const r = cajaCerrada({ recambios: 40, cinetica: (q) => ({
    internar: (e) => q.internar(e), sustancia: (id) => q.sustancia(id),
    reaccion: (a, b, n) => {
      const x = q.reaccion(a, b, n);
      const esH2 = (id: number) => id > 0 && q.sustancia(id).atomos.every((v, e) => (e === 0 ? v === 2 : v === 0)); // H es el elemento 0
      return x && (esH2(a) || esH2(b)) && x.catalisis === 2 ? { ...x, catalisis: -1 as const } : x;
    },
  }) });
  const f = r.fotos, fin = f[f.length - 1]!;
  const tarde = media(tramo(f, 31, 40).map((x) => x.h2)), antes = media(tramo(f, 21, 30).map((x) => x.h2));
  t.diagnostic(`H₂ ${antes.toFixed(0)} → ${tarde.toFixed(0)}; final ${fin.h2} (${(100 * fin.hH2 / fin.hTotal).toFixed(3)} % del H); agua ${f[0]!.agua} → ${fin.agua}`);
  assert.ok(tarde > 1.15 * antes, 'sin la catálisis H–H el H₂ seguiría creciendo');
});
