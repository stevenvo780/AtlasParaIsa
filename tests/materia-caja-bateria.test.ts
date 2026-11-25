// Subconjunto rápido de la batería de cajas de la validación de los ciclos (enmienda 3): tests/lib/caja-param.ts es la caja
// del auditor con piezas reales (arena de A, química de Q, pasoLote y fluir de P, copiar, crearPlantilla, desprender y
// quemar de L) y un registro bigint; la batería entera (74 cajas, horas de CPU) es `npx tsx scripts/lab-materia.mts --cajas`.
// Una caja de 40 recambios por modo de fallo conocido, cada una con su control que muestra que la medida lo distingue:
// el sumidero de HCN del fuego pobre en O₂, el H₂ y el agua con poros ÷100, el N fijado a N₂ con fuego y el P bloqueado.
// Umbrales: UMBRALES_CAJA.
import assert from 'node:assert/strict';
import test from 'node:test';
import { UMBRALES_CAJA, cajaParam, medirCaja, type MedidaCaja } from './lib/caja-param.js';
import type { Reaccion, ServicioQuimico } from '../src/world/materia/tipos.js';

const N2P = { nitrogenos: ['NH3', 'N2'], fosfatos: ['H3PO4', 'CaHPO4', 'HPO3u', 'P2O5u', 'P2O5g'] };
const envolver = (f: (x: Reaccion) => Reaccion) => (q: ServicioQuimico): ServicioQuimico => ({
  internar: (e) => q.internar(e), sustancia: (id) => q.sustancia(id),
  reaccion: (a, b, n) => { const x = q.reaccion(a, b, n); return x ? f(x) : x; },
});
const diag = (t: { diagnostic(m: string): void }, m: MedidaCaja) => t.diagnostic(`${m.nombre}: ${m.recambios} recambios, ${m.ticks} ticks, ${(m.ms / 1000).toFixed(0)} s; agua ${(100 * m.aguaMin).toFixed(1)} % (bruta ${(100 * m.aguaMinBruta).toFixed(1)}); H₂ ${(100 * m.h2Max).toFixed(4)} % del H${m.h2Sube ? ' (sube)' : ''}; HCN ${(100 * m.hcnFinal).toFixed(2)} % del C (máx ${(100 * m.hcnMax).toFixed(2)}); N fijado ×${m.nFijado.toFixed(3)}; P accesible ${(100 * m.pAccesible).toFixed(1)} %; biomasa ${m.biomasa.join(' → ')}; fallos: ${m.fallos.join('; ') || 'ninguno'}`);

test('batería rápida, HCN: el fuego pobre en O₂ ya no deja HCN; sin la catálisis por pares se acumula (la prueba distingue)', async (t) => {
  // Validación, hallazgo 3: fuego cada 2 recambios con la mitad del O₂ estequiométrico → HCN 46,8 % del C a 400 recambios,
  // inerte por debajo de una llama (ea = GAMMA·D(C≡N) = 311,8 contra κ = 105). Con la enmienda 3 el suelo lo oxida
  // (3·KAPPA_SUELO ≥ 311,8). El H₂ de ese fuego (~0,5 % del H, el mismo con y sin la enmienda) no es de este hallazgo.
  const cfg = { ...N2P, recambios: 40, cadaFuego: 2, o2Fuego: 0.5 };
  const m = medirCaja(await cajaParam({ nombre: 'fuegopobre-40', ...cfg }), { exigeH2Estable: false });
  diag(t, m);
  assert.ok(m.exacto, 'balance exacto');
  assert.ok(m.hcnMax < UMBRALES_CAJA.hcnTecho && !m.hcnSube, `HCN ${(100 * m.hcnMax).toFixed(2)} % del C`);
  assert.deepEqual(m.sumideros, []);
  assert.ok(m.biomasaMin >= UMBRALES_CAJA.biomasaMin && m.aguaMin >= UMBRALES_CAJA.aguaMin);
  const c = medirCaja(await cajaParam({ nombre: 'fuegopobre-40-porEnlace', ...cfg,
    cinetica: envolver((x) => (x.paresCatalisis > 1 ? { ...x, paresCatalisis: 1 } : x)) }), { exigeH2Estable: false });
  diag(t, c);
  assert.ok(c.hcnFinal > 0.03 && c.hcnSube, `control: HCN ${(100 * c.hcnFinal).toFixed(2)} % del C`);
  assert.ok(c.fallos.some((f) => f.startsWith('HCN')), 'el control falla por HCN');
});

test('batería rápida, H₂ y agua: con poros ÷100 y sin herbívoro el H₂ se estabiliza; sin la familia H–H sube', async (t) => {
  const cfg = { recambios: 40, fTubo: 0, capSuelo: 0.1 };
  const m = medirCaja(await cajaParam({ nombre: 'denso-sinherb-40', ...cfg }));
  diag(t, m);
  assert.deepEqual(m.fallos, []);
  assert.ok(m.aguaMinBruta >= UMBRALES_CAJA.aguaMin, `agua bruta ${m.aguaMinBruta}`);
  const c = medirCaja(await cajaParam({ nombre: 'denso-sinherb-40-sinHH', ...cfg,
    cinetica: envolver((x) => (x.catalisis === 3 ? { ...x, catalisis: -1, paresCatalisis: 0 } : x)) }));
  diag(t, c);
  assert.ok(c.h2Sube && c.h2Max > 2 * m.h2Max, 'control: sin la familia H–H el H₂ sigue subiendo');
});

test('batería rápida, N a N₂ con fuego: plantas que fijan N₂ cierran; las que solo toman NH₃ pierden el N (la prueba distingue)', async (t) => {
  const m = medirCaja(await cajaParam({ nombre: 'fuego-N2P-40', ...N2P, recambios: 40, cadaFuego: 4 }));
  diag(t, m);
  assert.deepEqual(m.fallos, []);
  const c = medirCaja(await cajaParam({ nombre: 'fuego-NH3-40', recambios: 40, cadaFuego: 4 }));
  diag(t, c);
  assert.ok(c.nFijado < 0.5 && c.fallos.some((f) => f.includes('N fijado')), `control: N fijado ×${c.nFijado.toFixed(3)}`);
});

test('batería rápida, P bloqueado: con los fosfatos del suelo cierra; si la planta solo toma H₃PO₄ el P se bloquea', async (t) => {
  const m = medirCaja(await cajaParam({ nombre: 'base-40', recambios: 40 }));
  diag(t, m);
  assert.deepEqual(m.fallos, []);
  assert.ok(m.pAccesible > 0.99, `P accesible ${m.pAccesible}`);
  const c = medirCaja(await cajaParam({ nombre: 'estricta-40', recambios: 40, fosfatos: ['H3PO4'] }));
  diag(t, c);
  assert.ok(c.pAccesible < 0.05 && c.fallos.some((f) => f.includes('P accesible')), `control: P accesible ${c.pAccesible}`);
});
