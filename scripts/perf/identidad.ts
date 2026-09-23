/**
 * Control de identidad del sprint noche-perf2 (2026-09-22): `digestoCanonico` en cortes fijos de las
 * semillas de control, con el mismo régimen que `replica.ts` (`digestosControl`: Store temporal
 * guardado antes del primer paso y cada `persistencia.cadaTicks`).
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/identidad.ts <caso> [--salida j.json]
 *
 * Casos:
 *   d51926   semilla 51926, params históricos (guarda en cada paso), cortes 1200 y 2400. `digestosControl`
 *            aplica los params sobre `HISTORICAL_PARAMS`, que en un árbol anterior a reglas 10 eran los
 *            defaults: base vieja y rama nueva simulan el mismo mundo.
 *   s7       semilla 7, leyes de la etapa 1 (LEYES_CANDIDATAS), cortes 1200…4800
 *   s42      semilla 42, leyes de la etapa 1, cortes 1200…4800
 *
 * El mundo de población alta (~230 habitantes, semilla 3, día 12,25) se controla con
 * `scripts/perf/fases.ts --db <mundo> --pasos 600` (su `digestoFinal`). Para comparar contra la base,
 * este script y fases.ts se copian a un `git archive` del commit base (nunca contra el propio árbol) y
 * se corren allí con el mismo caso; los digestos deben ser idénticos.
 */
import { writeFileSync } from 'node:fs';
import { digestosControl, LEYES_CANDIDATAS } from '../lab/rendimiento.js';

const CASOS: Record<string, { seed: number; params?: string; cortes: number[] }> = {
  d51926: { seed: 51926, cortes: [1200, 2400] },
  s7: { seed: 7, params: LEYES_CANDIDATAS, cortes: [1200, 2400, 3600, 4800] },
  s42: { seed: 42, params: LEYES_CANDIDATAS, cortes: [1200, 2400, 3600, 4800] },
};

if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
const caso = process.argv[2], definicion = caso ? CASOS[caso] : undefined;
if (!definicion) throw new Error(`Uso: identidad.ts ${Object.keys(CASOS).join('|')} [--salida j.json]`);
const salidaIndex = process.argv.indexOf('--salida'), salida = salidaIndex === -1 ? undefined : process.argv[salidaIndex + 1];
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const inicio = cpuMs();
const digestos = digestosControl(definicion.seed, definicion.params, definicion.cortes);
const resultado = { caso, seed: definicion.seed, params: definicion.params ?? 'historicos', digestos,
  cpuS: Math.round(cpuMs() - inicio) / 1000 };
const texto = JSON.stringify(resultado, null, 2);
if (salida) writeFileSync(salida, texto + '\n');
console.log(texto);
