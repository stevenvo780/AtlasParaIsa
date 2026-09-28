/** Calibración descriptiva de C8 en CTRLV4. Solo lee datos; nunca decide una lectura v4.
 * Uso: npx tsx scripts/analysis/calibracion-v4-ctrlv4.mts [--muestra] [--panel 40|48|56|60|65]
 * Sin --muestra exige todos los días 1..60 y escribe JSON y Markdown en balance/.
 */
import { readFileSync, existsSync, lstatSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { evaluarConjunto, evaluarSerieDiversidad, mannKendall, UMBRALES_POR_DEFECTO,
  COBERTURA_MIN, TOLERANCIA_PLANA, type ResultadoCriterio } from '../lab/criterio-terminado.mjs';

const RAIZ = '/datos/tmp-atlas-lab/datos-lab/ctrlv4';
const RAIZ_B = '/datos/tmp-atlas-lab/datos-lab/ctrlv4b';
const RAIZ_C = '/datos/tmp-atlas-lab/datos-lab/ctrlv4c-portatil';
const RAIZ_D = '/datos/tmp-atlas-lab/datos-lab/ctrlv4d-portatil';
const RAIZ_D_TORRE = '/datos/tmp-atlas-lab/datos-lab/ctrlv4d-torre';
const RAIZ_E = '/datos/tmp-atlas-lab/datos-lab/ctrlv4e';
const RAIZ_F = '/datos/tmp-atlas-lab/datos-lab/ctrlv4f';
const SALIDA = '/datos/tmp-atlas-lab/balance';
const SHA_CTRLV4 = '667454d5e0232885d78c37775d6a5619f516872d';
const TICKS_POR_DIA = 2400;
const argumentos = process.argv.slice(2);
const MUESTRA = argumentos.includes('--muestra');
const PANEL = argumentos.includes('--panel') ? Number(argumentos[argumentos.indexOf('--panel') + 1]) : 20;
const esperados = PANEL === 40 || PANEL === 48 || PANEL === 56 || PANEL === 60 || PANEL === 65 ? ['--panel', String(PANEL), ...(MUESTRA ? ['--muestra'] : [])] : MUESTRA ? ['--muestra'] : [];
if (argumentos.length !== esperados.length || argumentos.filter(x => x === '--panel').length > 1
  || argumentos.filter(x => x === '--muestra').length > 1
  || argumentos.some(x => !esperados.includes(x)) || ![20, 40, 48, 56, 60, 65].includes(PANEL)) throw new Error('Uso: script [--muestra] [--panel 40|48|56|60|65]');
type Dia = Record<string, unknown>;
type Estado = 'cumple' | 'falla' | 'desconocido';
type Medida = { estado: Estado; base: number; campo: string; puntos: number; media: number | null;
  p: number | null; subida: number | null; umbral: number | null; motivo?: string };
const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const objeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sub = (x: unknown, ...camino: string[]): unknown => camino.reduce<unknown>((a, k) =>
  a !== null && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>)[k] : undefined, x);
const referencia = JSON.parse(readFileSync(join(RAIZ, 'CTRLV4-6001', 'replica.json'), 'utf8')) as unknown;
if (!objeto(referencia) || referencia.seed !== 6001 || referencia.sha !== SHA_CTRLV4 || referencia.dias !== 60
  || !objeto(referencia.params) || typeof referencia.digest !== 'string' || !/^[0-9a-f]{64}$/.test(referencia.digest)
  || sub(referencia.params, 'persistencia', 'cadaTicks') !== 300
  || sub(referencia.params, 'limites', 'teselasActivas') !== 1303552
  || sub(referencia.params, 'limites', 'chunks') !== 5092
  || sub(referencia.params, 'limites', 'fauna') !== 7821312
  || sub(referencia.params, 'poblacion', 'natalidadLocal') !== 0
  || sub(referencia.params, 'conducta', 'vocacion') !== 0
  || sub(referencia.params, 'social', 'hogarTrabajo') !== 0)
  throw new Error('Manifiesto de referencia CTRLV4-6001 incompatible con brazo.txt y control sin leyes');
const digestReferencia = referencia.digest;
const paramsReferencia = referencia.params;

/** El manifiesto se escribe después del día 60. Los JSON diarios no llevan seed: los
 * contadores acumulados y el resumen final añaden controles contra mezclas accidentales. */
function verificarReplica(raiz: string, semilla: number, dias: Map<number, Dia>): string[] {
  const ruta = join(raiz, `CTRLV4-${semilla}`, 'replica.json');
  if (!existsSync(ruta)) return ['falta replica.json final'];
  let manifiesto: unknown;
  try { manifiesto = JSON.parse(readFileSync(ruta, 'utf8')) as unknown; }
  catch { return ['replica.json ilegible']; }
  if (!objeto(manifiesto)) return ['replica.json no es un objeto'];
  const problemas: string[] = [];
  if (manifiesto.seed !== semilla) problemas.push(`seed de manifiesto ${String(manifiesto.seed)} != ${semilla}`);
  if (manifiesto.sha !== SHA_CTRLV4) problemas.push('SHA de código distinto del brazo CTRLV4');
  if (manifiesto.digest !== digestReferencia) problemas.push('digest de código distinto del control de referencia');
  if (manifiesto.dias !== 60) problemas.push(`dias de manifiesto ${String(manifiesto.dias)} != 60`);
  if (!isDeepStrictEqual(manifiesto.params, paramsReferencia)) problemas.push('params distintos del control CTRLV4');
  if (manifiesto.metricasVersion !== 2 || !String(manifiesto.instrumentos).startsWith('si;')
    || manifiesto.gobernador !== 'no-ejecutado; replica de leyes, no del servidor' || 'techoLab' in manifiesto)
    problemas.push('modo de réplica distinto del control instrumentado sin techo');
  const resumen = manifiesto.resumen;
  if (!objeto(resumen) || !Number.isSafeInteger(resumen.poblacionInicial)) {
    problemas.push('resumen final ausente o sin población inicial');
    return problemas;
  }
  let nacimientosPrevios = 0, cooperacionesPrevias = 0;
  const muertesPrevias = new Map<string, number>();
  for (let i = 1; i <= 60; i++) {
    const dia = dias.get(i)!;
    if (dia.tick !== i * TICKS_POR_DIA) problemas.push(`tick inválido en día ${i}: ${String(dia.tick)}`);
    const nacimientos = dia.nacimientos, cooperaciones = dia.cooperaciones;
    if (!Number.isSafeInteger(nacimientos) || (nacimientos as number) < nacimientosPrevios)
      problemas.push(`nacimientos acumulados inválidos en día ${i}`);
    else nacimientosPrevios = nacimientos as number;
    if (!Number.isSafeInteger(cooperaciones) || (cooperaciones as number) < cooperacionesPrevias)
      problemas.push(`cooperaciones acumuladas inválidas en día ${i}`);
    else cooperacionesPrevias = cooperaciones as number;
    if (!objeto(dia.muertesPorCausa)) { problemas.push(`muertesPorCausa inválido en día ${i}`); continue; }
    let muertes = 0;
    for (const [causa, valor] of Object.entries(dia.muertesPorCausa)) {
      if (!Number.isSafeInteger(valor) || (valor as number) < (muertesPrevias.get(causa) ?? 0))
        problemas.push(`muertes acumuladas inválidas en día ${i}, causa ${causa}`);
      else { muertes += valor as number; muertesPrevias.set(causa, valor as number); }
    }
    if (dia.poblacion !== (resumen.poblacionInicial as number) + (nacimientos as number) - muertes)
      problemas.push(`balance de población inválido en día ${i}`);
  }
  const ultimo = dias.get(60)!;
  for (const [campoDia, campoResumen] of [
    ['poblacion', 'poblacionFinal'], ['nacimientos', 'nacimientosTotal'],
    ['muertesPorCausa', 'muertesPorCausaTotal'], ['fundadoresVivos', 'fundadoresVivosFinal'],
    ['generacionesVivas', 'generacionesVivasFinal'], ['diversidadOficios', 'diversidadOficiosFinal'],
    ['recetasDistintasEnUso', 'recetasDistintasEnUsoFinal'], ['cooperaciones', 'cooperacionesTotal'],
    ['gini', 'gini'], ['fraccionComida', 'fraccionComida'], ['distanciaAgua', 'distanciaAgua'],
    ['regionesSinAgua', 'regionesSinAgua'],
  ] as const) if (!isDeepStrictEqual(ultimo[campoDia], resumen[campoResumen]))
    problemas.push(`día 60 no coincide con resumen.${campoResumen}`);
  return problemas;
}
const estadoC8 = (r: ResultadoCriterio, base: number, campo: string): Medida => ({
  estado: r.estado, base, campo, puntos: Number(r.valores.puntos ?? 0), media: null,
  p: n(r.valores.p) ? r.valores.p : null,
  subida: n(r.valores.subida) ? r.valores.subida : null,
  umbral: 0.02, motivo: r.estado === 'desconocido' ? r.motivo : undefined,
});

/** Misma prueba exportada por el evaluador congelado; la escala de B/C impide usar su
 * evaluarSerieDiversidad, que exige valores en [0,1]. Conservamos sus reglas de cobertura,
 * bloques extremos y tolerancia. Sin huecos interiores para un aprobado: desconocido. */
function medir(dias: Map<number, Dia>, base: number, campo: string,
  leer: (d: Dia) => unknown, umbral: 'relativo' | 'absoluto'): Medida {
  const vacio = (motivo: string, puntos = 0): Medida => ({ estado: 'desconocido', base, campo,
    puntos, media: null, p: null, subida: null, umbral: null, motivo });
  if (60 - base < 25) return vacio('Tramo menor de 25 días, mínimo explorado por la auditoría');
  const puntos: [number, number][] = [], faltan: number[] = [];
  for (let i = base; i <= 60; i++) {
    const v = leer(dias.get(i)!);
    if (v === null || v === undefined) faltan.push(i);
    else if (!n(v)) return vacio(`Valor no numérico/no finito en día ${i}`, puntos.length);
    else puntos.push([i, v]);
  }
  const total = 61 - base, k = Math.min(10, Math.floor(total / 2));
  if (puntos.length / total < COBERTURA_MIN) return vacio(`Cobertura ${puntos.length}/${total} < 80 %`, puntos.length);
  if (faltan.some(i => i < base + k || i > 60 - k)) return vacio(`Faltan extremos: ${faltan.join(',')}`, puntos.length);
  if (puntos.length < 10) return vacio('Menos de 10 puntos', puntos.length);
  // La cota pesimista de S del evaluador no está exportada. Exigir serie completa
  // evita dar un falso positivo por huecos interiores y deja visible la omisión.
  if (faltan.length) return vacio(`Huecos interiores: ${faltan.join(',')}`, puntos.length);
  const valores = puntos.map(p => p[1]);
  const tolerancia = TOLERANCIA_PLANA * Math.max(1, ...valores.map(Math.abs));
  const mk = mannKendall(puntos, tolerancia, 'hamed-rao-ar1');
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const subida = mk.pendienteSen === null ? null : mk.pendienteSen * (60 - base);
  const limite = umbral === 'relativo' ? 0.05 * media : 0.02;
  if (umbral === 'relativo' && !(media > 0)) return vacio(`Media ${media} no positiva`, puntos.length);
  return { estado: mk.p < 0.05 && subida !== null && subida >= limite ? 'cumple' : 'falla',
    base, campo, puntos: puntos.length, media, p: mk.p, subida, umbral: limite };
}

/** Wilson bilateral 95 % para la proporción entre resultados conocidos. */
function wilson(exitos: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054, q = exitos / total, zz = z * z;
  const centro = (q + zz / (2 * total)) / (1 + zz / total);
  const radio = z * Math.sqrt(q * (1 - q) / total + zz / (4 * total * total)) / (1 + zz / total);
  return [Math.max(0, centro - radio), Math.min(1, centro + radio)];
}

const incompletas: { semilla: number; diasFaltantes: number[]; problemas: string[] }[] = [];
const datos = new Map<number, Map<number, Dia>>();
if (PANEL >= 48) for (const [etiqueta, raiz, primera, cantidad] of [
  ['T1c', RAIZ_C, 6041, 8], ...(PANEL >= 56 ? [
    ['T1d portátil', RAIZ_D, 6049, 6], ['T1d torre', RAIZ_D_TORRE, 6055, 2]] : []),
  ...(PANEL >= 60 ? [['T1e', RAIZ_E, 6057, 4]] : []),
  ...(PANEL === 65 ? [['T1f', RAIZ_F, 6061, 5]] : []),
] as [string, string, number, number][]) {
  if (!existsSync(raiz) || !lstatSync(raiz).isDirectory())
    throw new Error(`Panel ${PANEL} incompleto: falta directorio real ${etiqueta} ${raiz}; no se escriben salidas`);
  const directorios = readdirSync(raiz, { withFileTypes: true }).filter(e =>
    /^CTRLV4-\d+$/.test(e.name)).map(e => e.name).sort();
  const requeridos = Array.from({ length: cantidad }, (_, i) => `CTRLV4-${primera + i}`).sort();
  if (!isDeepStrictEqual(directorios, requeridos) || requeridos.some(nombre =>
    !lstatSync(join(raiz, nombre)).isDirectory()))
    throw new Error(`Panel ${PANEL}: membresía ${etiqueta} inválida; se exigen exactamente ${requeridos.length} directorios reales ${requeridos.join(', ')}, sin extras; hallados: ${directorios.join(', ') || 'ninguno'}`);
}
for (let s = 6001; s < 6001 + PANEL; s++) {
  const dias = new Map<number, Dia>(), faltantes: number[] = [], problemas: string[] = [];
  const raiz = s <= 6020 ? RAIZ : s <= 6040 ? RAIZ_B : s <= 6048 ? RAIZ_C : s <= 6054 ? RAIZ_D : s <= 6056 ? RAIZ_D_TORRE : s <= 6060 ? RAIZ_E : RAIZ_F;
  if (PANEL >= 40) {
    const directorio = join(raiz, `CTRLV4-${s}`);
    if (!existsSync(directorio) || !lstatSync(directorio).isDirectory()) {
      incompletas.push({ semilla: s, diasFaltantes: Array.from({ length: 60 }, (_, i) => i + 1),
        problemas: ['falta directorio real CTRLV4 de la semilla'] });
      datos.set(s, dias);
      continue;
    }
  }
  for (let i = 1; i <= 60; i++) {
    const f = join(raiz, `CTRLV4-${s}`, `dia-${String(i).padStart(3, '0')}.json`);
    if (!existsSync(f)) { faltantes.push(i); continue; }
    if (PANEL >= 48 && !lstatSync(f).isFile()) { problemas.push(`día ${i} no es archivo regular`); continue; }
    try {
      const dia = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      if (!objeto(dia)) problemas.push(`día ${i} no es un objeto`);
      else dias.set(i, dia);
    } catch { problemas.push(`día ${i} ilegible`); }
  }
  if (!faltantes.length && !problemas.length) {
    if (PANEL >= 48 && !existsSync(join(raiz, `CTRLV4-${s}`, 'replica.json')))
      problemas.push('falta replica.json final');
    else if (PANEL >= 48 && !lstatSync(join(raiz, `CTRLV4-${s}`, 'replica.json')).isFile())
      problemas.push('replica.json no es archivo regular');
    else problemas.push(...verificarReplica(raiz, s, dias));
  }
  if (faltantes.length || problemas.length) incompletas.push({ semilla: s, diasFaltantes: faltantes, problemas });
  datos.set(s, dias);
}
if (incompletas.length && (!MUESTRA || PANEL >= 48)) throw new Error(`Panel incompleto o no verificado; no se escriben salidas: ${incompletas.map(x => `${x.semilla}: faltan ${x.diasFaltantes.length}, problemas ${x.problemas.join(', ') || 'ninguno'}`).join('; ')}`);

const oficial = evaluarConjunto(RAIZ, { dia: 60, diversidadCampo: 'diversidadConductaVentana' });
const oficialB = PANEL >= 40 ? evaluarConjunto(RAIZ_B, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
if (oficialB) for (const [informe, primero] of [[oficial, 6001], [oficialB, 6021]] as const) {
  const replicas = informe.replicas.filter(x => x.brazo === 'CTRLV4');
  const semillas = Array.from({ length: 20 }, (_, i) => primero + i);
  if (replicas.length !== 20 || semillas.some(s =>
    replicas.filter(x => x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error(`Membresía CTRLV4 inválida en ${informe.conjunto}: se exigen exactamente ${primero}..${primero + 19}, sin duplicados`);
}
const oficialC = PANEL >= 48 ? evaluarConjunto(RAIZ_C, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
if (oficialC) {
  const replicas = oficialC.replicas;
  if (replicas.length !== 8 || Array.from({ length: 8 }, (_, i) => 6041 + i).some(s =>
    replicas.filter(x => x.brazo === 'CTRLV4' && x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error('Membresía CTRLV4 T1c inválida: se exigen exactamente 6041..6048, sin extras ni duplicados');
}
const oficialD = PANEL >= 56 ? evaluarConjunto(RAIZ_D, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
const oficialDTorre = PANEL >= 56 ? evaluarConjunto(RAIZ_D_TORRE, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
if (oficialD) {
  const replicas = oficialD.replicas;
  if (replicas.length !== 6 || Array.from({ length: 6 }, (_, i) => 6049 + i).some(s =>
    replicas.filter(x => x.brazo === 'CTRLV4' && x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error('Membresía CTRLV4 T1d portátil inválida: se exigen exactamente 6049..6054, sin extras ni duplicados');
}
if (oficialDTorre) {
  const replicas = oficialDTorre.replicas;
  if (replicas.length !== 2 || [6055, 6056].some(s =>
    replicas.filter(x => x.brazo === 'CTRLV4' && x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error('Membresía CTRLV4 T1d torre inválida: se exigen exactamente 6055..6056, sin extras ni duplicados');
}
const oficialE = PANEL >= 60 ? evaluarConjunto(RAIZ_E, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
if (oficialE) {
  const replicas = oficialE.replicas;
  if (replicas.length !== 4 || Array.from({ length: 4 }, (_, i) => 6057 + i).some(s =>
    replicas.filter(x => x.brazo === 'CTRLV4' && x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error('Membresía CTRLV4 T1e inválida: se exigen exactamente 6057..6060, sin extras ni duplicados');
}
const oficialF = PANEL === 65 ? evaluarConjunto(RAIZ_F, { dia: 60, diversidadCampo: 'diversidadConductaVentana' }) : null;
if (oficialF) {
  const replicas = oficialF.replicas;
  if (replicas.length !== 5 || Array.from({ length: 5 }, (_, i) => 6061 + i).some(s =>
    replicas.filter(x => x.brazo === 'CTRLV4' && x.semilla === s && x.nombre === `CTRLV4-${s}`).length !== 1))
    throw new Error('Membresía CTRLV4 T1f inválida: se exigen exactamente 6061..6065, sin extras ni duplicados');
}
const porSemilla = new Map((oficialB ? [...oficial.replicas.filter(x => x.brazo === 'CTRLV4'),
  ...oficialB.replicas.filter(x => x.brazo === 'CTRLV4'), ...(oficialC?.replicas ?? []),
  ...(oficialD?.replicas ?? []), ...(oficialDTorre?.replicas ?? []), ...(oficialE?.replicas ?? []), ...(oficialF?.replicas ?? [])] : oficial.replicas).map(x => [x.semilla, x]));
const filas: Record<string, unknown>[] = [];
for (const [semilla, dias] of datos) {
  if (incompletas.some(x => x.semilla === semilla)) continue;
  const extinta = [...dias.values()].some(d => d.vecinosMortales === 0);
  const base = [...dias].find(([, d]) => d.fundadoresMortalesVivos === 0)?.[0];
  const replica = porSemilla.get(semilla);
  if (!replica?.criterios || !replica.terminada || replica.ultimoDia !== 60
    || (replica.estado !== 'evaluada' && replica.estado !== 'extinguida'))
    throw new Error(`Evaluador sin réplica completa y legible para ${semilla}: ${replica?.estado ?? 'ausente'} (${replica?.nota ?? 'sin nota'})`);
  const v3 = estadoC8(replica.criterios.diversidad, 5, 'diversidadConductaVentana');
  const a = base === undefined ? null : estadoC8(evaluarSerieDiversidad(
    i => dias.get(i)?.diversidadConductaVentana, 60, { ...UMBRALES_POR_DEFECTO, diaBaseDiversidad: base,
      diversidadCampo: 'diversidadConductaVentana' }), base, 'diversidadConductaVentana');
  const ap = base === undefined ? null : estadoC8(evaluarSerieDiversidad(
    i => sub(dias.get(i), 'diversidadConductaVentanaComponentes', 'conducta'), 60,
    { ...UMBRALES_POR_DEFECTO, diaBaseDiversidad: base }), base, 'diversidadConductaVentanaComponentes.conducta');
  const alt: Record<string, Medida | null> = { v3, A: a, 'A_prima': ap };
  for (const [etiqueta, leer, tipo] of [
    ['B_clasesR100', (d: Dia) => sub(d, 'repertorioAbierto', 'clasesR100'), 'relativo'],
    ['C_comunidades', (d: Dia) => sub(d, 'diversidadEntreGrupos', 'comunidades'), 'absoluto'],
    ['C_linajes', (d: Dia) => sub(d, 'diversidadEntreGrupos', 'linajes'), 'absoluto'],
  ] as const) {
    alt[`${etiqueta}_base5`] = medir(dias, 5, etiqueta, leer, tipo);
    alt[`${etiqueta}_sinFundadores`] = base === undefined ? null : medir(dias, base, etiqueta, leer, tipo);
  }
  // Igual que el evaluador congelado: una réplica extinta falla C8 al corte, aunque
  // los instrumentos de los días siguientes sean nulos. Se conserva el dato crudo
  // de cada lectura para auditar por qué el test numérico habría sido desconocido.
  const lecturas = extinta ? Object.fromEntries(Object.entries(alt).map(([clave, valor]) =>
    [clave, { ...valor, estado: 'falla', motivo: 'Extinción antes o en el día 60',
      estadoSerieSinReglaExtincion: valor?.estado ?? 'desconocido' }])) : alt;
  filas.push({ semilla, extinta, baseSinFundadores: base ?? null, lecturas });
}
const claves = Object.keys((filas[0]?.lecturas ?? {}) as Record<string, unknown>);
if (PANEL === 40 && !MUESTRA && (filas.length !== 40 || filas.some((f, i) => f.semilla !== 6001 + i)))
  throw new Error('El panel 40 debe contener exactamente las semillas 6001..6040, una vez cada una');
if (PANEL === 48 && (filas.length !== 48 || filas.some((f, i) => f.semilla !== 6001 + i)))
  throw new Error('El panel 48 debe contener exactamente las semillas 6001..6048, una vez cada una');
if (PANEL === 56 && (filas.length !== 56 || filas.some((f, i) => f.semilla !== 6001 + i)))
  throw new Error('El panel 56 debe contener exactamente las semillas 6001..6056, una vez cada una');
if (PANEL === 60 && (filas.length !== 60 || filas.some((f, i) => f.semilla !== 6001 + i)))
  throw new Error('El panel 60 debe contener exactamente las semillas 6001..6060, una vez cada una');
if (PANEL === 65 && (filas.length !== 65 || filas.some((f, i) => f.semilla !== 6001 + i)))
  throw new Error('El panel 65 debe contener exactamente las semillas 6001..6065, una vez cada una');
if (PANEL >= 48) for (const [etiqueta, archivo, raiz] of [
  ['T1c', 'verificar-ctrlv4c.py', RAIZ_C],
  ...(PANEL >= 56 ? [['T1d', 'verificar-ctrlv4d.py', RAIZ_D]] : []),
  ...(PANEL >= 60 ? [['T1e', 'verificar-ctrlv4e.py', RAIZ_E]] : []),
  ...(PANEL === 65 ? [['T1f', 'verificar-ctrlv4f.py', RAIZ_F]] : []),
] as [string, string, string][]) {
  const carpetaScripts = fileURLToPath(new URL('.', import.meta.url));
  const verificador = fileURLToPath(new URL(`./${archivo}`, import.meta.url));
  const proceso = spawnSync('python3', [verificador, '--root', raiz, '--require-complete'],
    { cwd: carpetaScripts, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (proceso.error) throw new Error(`Auditoría ${etiqueta} no ejecutada; no se escriben salidas: ${proceso.error.message}`);
  let auditoria: unknown;
  try { auditoria = JSON.parse(proceso.stdout) as unknown; }
  catch { throw new Error(`Auditoría ${etiqueta} sin JSON válido; no se escriben salidas: ${proceso.stderr.trim() || `salida ${String(proceso.status)}`}`); }
  if (proceso.status !== 0 || !objeto(auditoria) || auditoria.estado !== 'completo' || auditoria.completo !== true)
    throw new Error(`Auditoría ${etiqueta} incompleta o inválida; no se escriben salidas: ${objeto(auditoria) && Array.isArray(auditoria.errores) ? auditoria.errores.join('; ') : `estado ${objeto(auditoria) ? String(auditoria.estado) : 'ilegible'}, salida ${String(proceso.status)}`}`);
}
function resumir(subconjunto: Record<string, unknown>[], totalPanel?: number) {
  return Object.fromEntries(claves.map(clave => {
    const resultados = subconjunto.map(f => (f.lecturas as Record<string, Medida | null>)[clave]);
    const cumple = resultados.filter(x => x?.estado === 'cumple').length;
    const falla = resultados.filter(x => x?.estado === 'falla').length;
    const desconocido = resultados.length - cumple - falla;
    const sinCompletar = totalPanel === undefined ? 0 : totalPanel - resultados.length;
    if (sinCompletar < 0) throw new Error(`Total del panel menor que las semillas completas: ${totalPanel}`);
    return [clave, { cumple, falla, desconocido, totalCompletas: resultados.length,
      fraccionConocida: cumple + falla ? cumple / (cumple + falla) : null,
      intervaloWilson95Conocidos: wilson(cumple, cumple + falla),
      fraccionCompletasIdentificada: resultados.length ? [cumple / resultados.length, (cumple + desconocido) / resultados.length] : null,
      ...(totalPanel === undefined ? {} : { totalPanel, incompletas: sinCompletar,
        desconocidoPanel: desconocido + sinCompletar,
        fraccionPanelIdentificada: [cumple / totalPanel, (cumple + desconocido + sinCompletar) / totalPanel] }) }];
  }));
}
const resumen = resumir(filas, PANEL), resumenVivos = resumir(filas.filter(x => !x.extinta));
const resumenAdicionales = PANEL >= 48 ? resumir(filas.filter(x => Number(x.semilla) >= 6041 && Number(x.semilla) <= 6048), 8) : undefined;
const resumenT1d = PANEL >= 56 ? resumir(filas.filter(x => Number(x.semilla) >= 6049 && Number(x.semilla) <= 6056), 8) : undefined;
const resumenT1e = PANEL >= 60 ? resumir(filas.filter(x => Number(x.semilla) >= 6057 && Number(x.semilla) <= 6060), 4) : undefined;
const resumenT1f = PANEL === 65 ? resumir(filas.filter(x => Number(x.semilla) >= 6061), 5) : undefined;
const resultado = { tipo: 'calibracion_descriptiva_control', panel: `CTRLV4 6001..${6000 + PANEL}`, corte: 60,
  estado: incompletas.length ? 'muestra_provisional' : 'panel_completo', incompletas,
  metodo: { v3: 'evaluarConjunto congelado, campo ventana', A: 'mismo evaluador, base primer día sin fundadores mortales',
    A_prima: 'A con solo componente conducta y mismo umbral absoluto 0.02; elimina la entropía agregada de oficios, pero el vector de conducta conserva un one-hot del oficio dominante',
    B: 'clasesR100, subida Sen >= 5% de media del tramo', C: 'comunidades y linajes separados, Sen >= 0.02',
    variantes: 'base 5 y base sin fundadores para B/C; ninguna elegida',
    faltantes: 'desconocido; aprobado exige serie completa, cobertura >=80% y extremos completos; el panel exige 60 JSON con ticks válidos y manifiesto final de SHA, seed, días y params correctos',
    intervalos: `Wilson bilateral 95% entre clasificados; fracción de completas y fracción del panel de ${PANEL} separadas; esta última cuenta incompletas y desconocidos como 0 o 1` },
  resumen, resumenVivos, ...(resumenAdicionales ? { resumenAdicionales } : {}),
  ...(resumenT1d ? { resumenT1d } : {}), ...(resumenT1e ? { resumenT1e } : {}),
  ...(resumenT1f ? { resumenT1f } : {}), semillas: filas };
if (MUESTRA) console.log(JSON.stringify(resultado, null, 2));
else {
  mkdirSync(SALIDA, { recursive: true });
  const nombreSalida = PANEL === 65 ? 'calibracion-v4-ctrlv4-65' : PANEL === 60 ? 'calibracion-v4-ctrlv4-60' : PANEL === 56 ? 'calibracion-v4-ctrlv4-56' : PANEL === 48 ? 'calibracion-v4-ctrlv4-48' : PANEL === 40 ? 'calibracion-v4-ctrlv4-40' : 'calibracion-v4-ctrlv4';
  writeFileSync(resolve(SALIDA, `${nombreSalida}.json`), JSON.stringify(resultado, null, 2) + '\n');
  const lineas = ['# Calibración descriptiva CTRLV4 a 60 días', '',
    `Solo controles, sin elección de lectura ni preregistro. Wilson 95 % se calcula entre resultados conocidos. La fracción identificada del panel usa siempre ${PANEL} semillas: una incompleta o desconocida puede fallar o aprobar.`, '',
    `| Lectura | Aprueban / ${PANEL} | n conocido | Desconocido completo | Incompletas | Cota panel / ${PANEL} | Fracción conocida | Wilson 95 % conocidos |`, '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [k, v] of Object.entries(resumen)) {
    const x = v;
    if (x.incompletas === undefined || !x.fraccionPanelIdentificada) throw new Error(`Resumen del panel ausente: ${k}`);
    lineas.push(`| ${k} | ${x.cumple}/${PANEL} | ${x.cumple + x.falla} | ${x.desconocido} | ${x.incompletas} | ${x.fraccionPanelIdentificada.map(n => n.toFixed(3)).join('–')} | ${x.fraccionConocida?.toFixed(3) ?? '—'} | ${x.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  if (resumenAdicionales) {
    lineas.push('', '## Sensibilidad suplementaria T1c, semillas 6041–6048', '',
      'Brazo exploratorio adicional: ocho controles completos. Se informa por separado; no selecciona lectura v4 ni constituye preregistro.', '',
      '| Lectura | Aprueban / 8 | n conocido | Desconocido completo | Wilson 95 % conocidos |', '|---|---:|---:|---:|---:|');
    for (const [k, v] of Object.entries(resumenAdicionales))
      lineas.push(`| ${k} | ${v.cumple}/8 | ${v.cumple + v.falla} | ${v.desconocido} | ${v.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  if (resumenT1d) {
    lineas.push('', '## Sensibilidad suplementaria T1d, semillas 6049–6056', '',
      'Brazo exploratorio adicional: ocho controles completos. Se informa por separado; no selecciona lectura v4 ni constituye preregistro.', '',
      '| Lectura | Aprueban / 8 | n conocido | Desconocido completo | Wilson 95 % conocidos |', '|---|---:|---:|---:|---:|');
    for (const [k, v] of Object.entries(resumenT1d))
      lineas.push(`| ${k} | ${v.cumple}/8 | ${v.cumple + v.falla} | ${v.desconocido} | ${v.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  if (resumenT1e) {
    lineas.push('', '## Sensibilidad suplementaria T1e, semillas 6057–6060', '',
      'Brazo exploratorio adicional: cuatro controles completos. Se informa por separado; no selecciona lectura v4 ni constituye preregistro.', '',
      '| Lectura | Aprueban / 4 | n conocido | Desconocido completo | Wilson 95 % conocidos |', '|---|---:|---:|---:|---:|');
    for (const [k, v] of Object.entries(resumenT1e))
      lineas.push(`| ${k} | ${v.cumple}/4 | ${v.cumple + v.falla} | ${v.desconocido} | ${v.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  if (resumenT1f) {
    lineas.push('', '## Sensibilidad suplementaria T1f, semillas 6061–6065', '',
      'Brazo exploratorio adicional: cinco controles completos. Se informa por separado; no selecciona lectura v4 ni constituye preregistro.', '',
      '| Lectura | Aprueban / 5 | n conocido | Desconocido completo | Wilson 95 % conocidos |', '|---|---:|---:|---:|---:|');
    for (const [k, v] of Object.entries(resumenT1f))
      lineas.push(`| ${k} | ${v.cumple}/5 | ${v.cumple + v.falla} | ${v.desconocido} | ${v.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  lineas.push('', '## Solo controles vivos al día 60', '',
    'Desglose de sensibilidad: las extinciones no prueban especificidad de la lectura entre mundos vivos.', '',
    '| Lectura | Cumple | Falla | Desconocido | Fracción conocida | Wilson 95 % |', '|---|---:|---:|---:|---:|---:|');
  for (const [k, v] of Object.entries(resumenVivos)) {
    const x = v as { cumple: number; falla: number; desconocido: number; fraccionConocida: number | null; intervaloWilson95Conocidos: [number, number] | null };
    lineas.push(`| ${k} | ${x.cumple} | ${x.falla} | ${x.desconocido} | ${x.fraccionConocida?.toFixed(3) ?? '—'} | ${x.intervaloWilson95Conocidos?.map(n => n.toFixed(3)).join('–') ?? '—'} |`);
  }
  lineas.push('', '## Decisiones de implementación y límites', '',
    '- A y A′ empiezan en el primer día con cero fundadores mortales. Si falta ese día, quedan desconocidas. A′ elimina la entropía agregada de oficios, pero el componente conducta todavía contiene un one-hot del oficio dominante.',
    '- B informa clases funcionales rarificadas a 100 usos. C informa comunidad y linaje por separado. Base 5 y base sin fundadores son variantes descriptivas, sin seleccionar una.',
    '- B exige subida relativa de 5 % de la media del tramo; C exige subida absoluta de 0,02. Se usa Mann–Kendall exportado por el evaluador, con Hamed–Rao + AR(1).',
    '- Una réplica extinta falla todas las lecturas al corte, como en C8 v3; se conserva el estado de la serie sin esa regla en el JSON.',
    '- Los valores B pueden exceder 1 y C puede ser negativo por corrección de permutaciones. Por eso no pasan por la validación [0,1] de C8 v3.',
    '- Una serie con nulos o huecos interiores no puede aprobar: queda desconocida. El evaluador congelado aplica además una cota pesimista a esos huecos, que aquí no está exportada.',
    '- Los intervalos de Wilson son descriptivos y no corrigen la selección de alternativas ni prueban generalización. Hay que atender también a los desconocidos.',
    '- Esta tabla no prueba potencia frente a leyes nuevas ni reemplaza un preregistro v4 decidido por Steven.', '');
  writeFileSync(resolve(SALIDA, `${nombreSalida}.md`), lineas.join('\n'));
  console.log(`Escritos ${resolve(SALIDA, `${nombreSalida}.json`)} y .md`);
}
