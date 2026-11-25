// Subconjunto rápido de la batería de cajas de la validación de los ciclos (enmienda 3): tests/lib/caja-param.ts es la caja
// del auditor con piezas reales (arena de A, química de Q, pasoLote y fluir de P, copiar, crearPlantilla, desprender y
// quemar de L) y un registro bigint; la batería entera (80 cajas, minutos de pared con 16 en paralelo) es `npx tsx scripts/lab-materia.mts --cajas`.
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
const diag = (t: { diagnostic(m: string): void }, m: MedidaCaja) => t.diagnostic(`${m.nombre}: ${m.recambios} recambios, ${m.ticks} ticks, ${(m.ms / 1000).toFixed(0)} s; agua ${(100 * m.aguaMin).toFixed(1)} % (bruta ${(100 * m.aguaMinBruta).toFixed(1)}); H₂ ${(100 * m.h2Max).toFixed(4)} % del H${m.h2Sube ? ' (sube)' : ''}, previsto ${(100 * m.h2Previsto).toFixed(4)} %, suelo discreto ${(100 * m.h2Discreto).toFixed(3)} %; HCN ${(100 * m.hcnFinal).toFixed(2)} % del C (máx ${(100 * m.hcnMax).toFixed(2)}); N fijado ×${m.nFijado.toFixed(3)}; P accesible ${(100 * m.pAccesible).toFixed(1)} %; biomasa ${m.biomasa.join(' → ')}; fallos: ${m.fallos.join('; ') || 'ninguno'}`);

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

test('batería rápida, H₂ del suelo denso: el que nace en el suelo se oxida en el mismo paso, también de dos en dos', async (t) => {
  // Validación de la enmienda 3, hallazgo 7. Glicósido con poros ÷100: 2 glicósido → 2 H₂ + C + CO₂ en el suelo, y el H₂
  // salía por `fluir` antes de que el suelo lo oxidara en el paso siguiente (15,4 % del H en H₂, agua 83 % a los 600
  // recambios). Madera con aire ×100 y poros ÷100, con herbívoro: H₂O + 2 orgP → 2 H₂ + … nace de dos en dos, y la
  // integración dejaba sin dar la última vez de 2 H₂ + O₂ en el 22 % de los pasos (AGOTADO de medio cuanto), que con
  // tanto aire por poro no volvían (2,92 % a los 600 recambios, subiendo 1,65 H₂/tick; 0,15 % a los 200).
  // Lo que queda en esa caja no es del suelo: el H₂ del tubo sube hacia el suelo discreto (`h2Discreto`, 5,8 % del H), que
  // sigue abierto (pedido a W); aquí se comprueba que la fuente del suelo se cerró.
  const glic = medirCaja(await cajaParam({ nombre: 'denso-sinherb-glic-100', partes: [['glicosido', 20], ['CH2', 2], ['proteina', 2], ['orgP', 1]], recambios: 100, fTubo: 0, capSuelo: 0.1 }));
  diag(t, glic);
  assert.deepEqual(glic.fallos, []);
  assert.ok(glic.aguaMinBruta >= UMBRALES_CAJA.aguaMin, `agua bruta ${glic.aguaMinBruta}`);
  const aire = { capAire: 10_000, aire: { N2: 780_000_000, O2: 210_000_000, CO2: 20_000_000 } };
  const tubo = medirCaja(await cajaParam({ nombre: 'tubo-aire10000-denso-100', ...aire, recambios: 100, capSuelo: 0.1 }), { exigeH2Estable: false });
  diag(t, tubo);
  assert.ok(tubo.h2Max < UMBRALES_CAJA.h2Techo / 10, `H₂ ${(100 * tubo.h2Max).toFixed(4)} % del H`);
  assert.ok(tubo.aguaMinBruta >= UMBRALES_CAJA.aguaMin && tubo.biomasaMin >= UMBRALES_CAJA.biomasaMin);
  assert.ok(tubo.h2Discreto > UMBRALES_CAJA.h2Techo, `suelo discreto ${(100 * tubo.h2Discreto).toFixed(2)} % del H (abierto, pedido a W)`);
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
