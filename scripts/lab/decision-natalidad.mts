/** Decisión congelada de docs/preregistros/2026-09-23-natalidad-local.md, Revisión 1.
 * Uso: npx tsx scripts/lab/decision-natalidad.mts --entrada <dir> --etapa 1|2 [--salida json]
 * Percentiles recibidos son los del instrumento. Las medianas de series se calculan ordenando
 * los valores no nulos; con n par se promedian los dos centrales. Los límites son inclusivos
 * salvo las desigualdades estrictas escritas en el preregistro.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRITERIOS, evaluarConjunto, type Informe, type EvaluacionReplica } from './criterio-terminado.mjs';

type Obj = Record<string, unknown>;
type Evaluador = (entrada: string, opciones: { dia: number }) => Pick<Informe, 'replicas'>;
const PANEL = Array.from({ length: 12 }, (_, i) => 4001 + i);
const FUERA = [4013, 4014, 4015, 4016];
const CRIBADO = [4101, 4102, 4103, 4104];
const nombreDia = (d: number) => `dia-${String(d).padStart(3, '0')}.json`;
const obj = (x: unknown): Obj | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : null;
const num = (x: unknown): number | null => typeof x === 'number' && Number.isFinite(x) ? x : null;
const media = (xs: number[]): number | null => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const entre = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

interface Replica { nombre: string; dias: Map<number, Obj>; meta: Obj | null; errores: string[]; extinta: boolean; ultimo: number; alarma: boolean }
function leer(raiz: string, brazo: string, semilla: number, corte: number): Replica {
  const nombre = `${brazo}-${semilla}`, dir = join(raiz, nombre);
  const dias = new Map<number, Obj>(), errores: string[] = [];
  let meta: Obj | null = null;
  if (!existsSync(dir)) errores.push('directorio ausente');
  else {
    const rutaMeta = join(dir, 'replica.json');
    if (existsSync(rutaMeta)) {
      try { meta = obj(JSON.parse(readFileSync(rutaMeta, 'utf8'))); if (!meta) errores.push('replica.json: objeto ausente'); }
      catch { errores.push('replica.json: JSON ilegible'); }
    } else errores.push('replica.json ausente');
    for (const d of entre(1, corte)) {
      const ruta = join(dir, nombreDia(d));
      if (!existsSync(ruta)) continue;
      try { const x = obj(JSON.parse(readFileSync(ruta, 'utf8'))); if (x) dias.set(d, x); else errores.push(`${nombreDia(d)}: objeto ausente`); }
      catch { errores.push(`${nombreDia(d)}: JSON ilegible`); }
    }
  }
  const ultimo = Math.max(0, ...dias.keys());
  // Extinción = 0 vecinos mortales, como el evaluador congelado de C1–C8 (S e I son inmortales y cuentan
  // en `poblacion`, que nunca baja de 2). Sin `vecinosMortales`, poblacion − 2.
  const extinta = [...dias.values()].some(x => mortales(x) === 0);
  const techo = obj(meta?.techoLabDetalle);
  const alarma = [...dias.values()].some(x => (num(x.poblacion) ?? 0) > 5000 || (num(x.poblacionMaximaDia) ?? 0) >= 5000)
    || (num(techo?.poblacionMaxima) ?? 0) >= 5000;
  return { nombre, dias, meta, errores, extinta, ultimo, alarma };
}
function mortales(x: Obj | undefined): number | null {
  if (!x) return null;
  const v = num(x.vecinosMortales);
  if (v !== null) return v;
  const p = num(x.poblacion);
  return p === null ? null : Math.max(0, p - 2);
}
const dia = (r: Replica, d: number) => r.dias.get(d);
const local = (r: Replica, d: number) => obj(dia(r, d)?.natalidadLocal);
const valor = (r: Replica, d: number, campo: string) => num(dia(r, d)?.[campo]);
const locNum = (r: Replica, d: number, campo: string) => num(local(r, d)?.[campo]);
const percentil = (r: Replica, d: number, campo: 'xFertiles' | 'xNacimientos') => num(obj(local(r, d)?.[campo])?.p50);
const causa = (r: Replica, campo: string) => num(obj(dia(r, r.ultimo)?.muertesPorCausa)?.[campo]);
function faltantes(r: Replica, corte: number): string[] {
  const f = [...r.errores];
  const fin = r.extinta ? Math.min(r.ultimo, corte) : corte;
  for (const d of entre(1, fin)) {
    const x = dia(r, d), n = nombreDia(d);
    if (!x) { f.push(`${n} ausente`); continue; }
    for (const k of ['tick', 'poblacion', 'nacimientos', 'vecinosMortales', 'muertesPorCausa', 'natalidadLocal', 'faunaTotal'])
      if (!Object.hasOwn(x, k)) f.push(`${n}: ${k} ausente`);
    const m = obj(x.muertesPorCausa), l = obj(x.natalidadLocal);
    for (const k of ['starvation', 'dehydration', 'exposure', 'senescence']) if (!m || !Object.hasOwn(m, k)) f.push(`${n}: muertesPorCausa.${k} ausente`);
    for (const k of ['nacimientosDia', 'xNacimientos', 'xFertiles', 'bloqueadasPorLey', 'kOcupado', 'nSobreKOcupado', 'limitante'])
      if (!l || !Object.hasOwn(l, k)) f.push(`${n}: natalidadLocal.${k} ausente`);
    for (const k of ['xNacimientos', 'xFertiles']) {
      const p = obj(l?.[k]);
      if (l && Object.hasOwn(l, k) && l[k] !== null) for (const q of ['p10', 'p50', 'p90']) if (!p || !Object.hasOwn(p, q)) f.push(`${n}: natalidadLocal.${k}.${q} ausente`);
    }
    for (const k of ['kOcupado', 'limitante']) {
      const p = obj(l?.[k]);
      for (const q of ['agua', 'comida']) if (!p || !Object.hasOwn(p, q)) f.push(`${n}: natalidadLocal.${k}.${q} ausente`);
    }
  }
  if (!r.extinta && !r.dias.has(corte)) f.push(`${nombreDia(corte)} ausente sin extinción`);
  if (corte === 60 && !r.extinta) {
    const requerir = (d: number, claves: string[]) => {
      const x = dia(r, d);
      if (!x) return;
      for (const k of claves) if (!Object.hasOwn(x, k)) f.push(`${nombreDia(d)}: ${k} ausente para C1–C8`);
    };
    for (const d of entre(51, 60)) requerir(d, ['poblacion', 'usosUtiles', 'usosDeInventorAjeno', 'usosSinAutorResuelto']);
    for (const d of [50, 60]) requerir(d, ['nacimientos', 'cooperacionAcumuladaPorTipo', 'conflictosAcumulados']);
    requerir(60, ['fundadoresMortalesVivos', 'generacionesMortalesVivas']);
    for (const d of entre(5, 60)) {
      const x = dia(r, d);
      if (x && !['diversidadConductaActiva', 'diversidadConductaTiempo', 'diversidadConducta'].some(k => Object.hasOwn(x, k)))
        f.push(`${nombreDia(d)}: diversidadConducta ausente para C8`);
    }
  }
  return f;
}
function fraccion(r: Replica, campo: string): number | null {
  const m = obj(dia(r, r.ultimo)?.muertesPorCausa);
  if (!m) return null;
  const total = Object.values(m).reduce<number>((s, x) => s + (num(x) ?? 0), 0);
  const c = num(m[campo]);
  return c === null ? null : total === 0 ? 0 : c / total;
}
function cv(xs: number[]): number | null {
  const mu = media(xs);
  return mu === null || mu === 0 ? null : Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / xs.length) / mu;
}
function brecha(r: Replica): { diasValidos: number; valor: number | null; bloqueadas: number } {
  const xs: number[] = [];
  let bloqueadas = 0;
  for (const d of entre(30, 60)) {
    const f = percentil(r, d, 'xFertiles'), n = percentil(r, d, 'xNacimientos');
    if (f !== null && n !== null) xs.push(f - n);
    if ((locNum(r, d, 'bloqueadasPorLey') ?? 0) > 0) bloqueadas++;
  }
  return { diasValidos: xs.length, valor: mediana(xs), bloqueadas };
}
function regulacion(r: Replica): { regulada: boolean; amplitud: number | null; nulos: number; mediaN: number | null } {
  const puntos: [number, number][] = [];
  for (const d of entre(30, 60)) {
    const poblaciones = entre(d - 4, d).map(i => valor(r, i, 'poblacion'));
    if (poblaciones.some(p => p === null || p <= 0)) continue;
    puntos.push([d, Math.log(media(poblaciones as number[])!)]);
  }
  let amplitud: number | null = null;
  if (puntos.length === 31) {
    const xm = media(puntos.map(p => p[0]))!, ym = media(puntos.map(p => p[1]))!;
    const pendiente = puntos.reduce((s, [x, y]) => s + (x - xm) * (y - ym), 0) / puntos.reduce((s, [x]) => s + (x - xm) ** 2, 0);
    const residuos = puntos.map(([x, y]) => y - (ym + pendiente * (x - xm)));
    amplitud = Math.max(...residuos) - Math.min(...residuos);
  }
  const ns = entre(45, 60).map(d => locNum(r, d, 'nSobreKOcupado'));
  const validos = ns.filter((x): x is number => x !== null), mu = media(validos);
  return { regulada: !r.extinta && !r.alarma && [...r.dias.values()].every(x => (num(x.poblacion) ?? Infinity) < 5000)
    && puntos.length === 31 && amplitud !== null && amplitud < 0.15
    && ns.length - validos.length <= 4 && mu !== null && validos.every(x => x >= 0.9 * mu && x <= 1.1 * mu),
    amplitud, nulos: ns.length - validos.length, mediaN: mu };
}
function seguridad(nat: Replica, ctrl: Replica): boolean {
  const sed = fraccion(nat, 'dehydration'), sedC = fraccion(ctrl, 'dehydration');
  const hambre = fraccion(nat, 'starvation'), hambreC = fraccion(ctrl, 'starvation');
  // Una extinción temprana aceptada en ambos brazos usa el cierre terminal de cada réplica.
  const fauna = valor(nat, nat.extinta ? nat.ultimo : 60, 'faunaTotal');
  const faunaC = valor(ctrl, ctrl.extinta ? ctrl.ultimo : 60, 'faunaTotal');
  return (!nat.extinta || ctrl.extinta) && !nat.alarma && [...nat.dias.values()].every(x => (num(x.poblacion) ?? Infinity) < 5000)
    && sed !== null && sedC !== null && hambre !== null && hambreC !== null
    && sed <= Math.max(1.5 * sedC, sedC + 0.03) && hambre <= hambreC + 0.01
    && fauna !== null && faunaC !== null && fauna >= 0.5 * faunaC;
}
function fila(nat: Replica, ctrl: Replica, criterios: Map<string, EvaluacionReplica>) {
  const bn = brecha(nat), bc = brecha(ctrl), reg = regulacion(nat);
  // Revisión 1, punto 3: la brecha se mide igual en los dos brazos y cada uno necesita ≥ 20 días válidos;
  // si cualquiera no llega, la semilla NO cumple mecanismo (sin umbral alternativo).
  const mecanismo = bn.diasValidos >= 20 && bc.diasValidos >= 20 && bn.valor !== null && bc.valor !== null
    && bn.valor > bc.valor && bn.bloqueadas >= 15;
  // Nivel = media de vecinos mortales de los días 50–60; una réplica extinta aporta 0 (no desaparece del cociente).
  const nivel = (r: Replica) => r.extinta && r.ultimo < 50 ? 0
    : media(entre(50, 60).map(d => mortales(dia(r, d))).filter((x): x is number => x !== null));
  const nivelNat = nivel(nat), nivelCtrl = nivel(ctrl);
  const ev = criterios.get(nat.nombre), ec = criterios.get(ctrl.nombre);
  const incompletos = [...faltantes(nat, 60).map(x => `${nat.nombre}: ${x}`), ...faltantes(ctrl, 60).map(x => `${ctrl.nombre}: ${x}`)];
  if (!ev || !ec) incompletos.push('evaluador C1–C8: réplica ausente');
  if (ev?.estado === 'ilegible' || ec?.estado === 'ilegible') incompletos.push('evaluador C1–C8: réplica ilegible');
  return { semilla: Number(nat.nombre.split('-').at(-1)), segura: seguridad(nat, ctrl), mecanismo, regulada: reg.regulada,
    extintaNat: nat.extinta, extintaCtrl: ctrl.extinta, alarmaNat: nat.alarma, incompletos,
    brechaNat: bn, brechaCtrl: bc, regulacion: reg,
    criteriosNat: ev?.criterios ?? null, criteriosCtrl: ec?.criterios ?? null,
    cvNacimientosNat: cv(entre(30, 60).map(d => locNum(nat, d, 'nacimientosDia')).filter((x): x is number => x !== null)),
    cvNacimientosCtrl: cv(entre(30, 60).map(d => locNum(ctrl, d, 'nacimientosDia')).filter((x): x is number => x !== null)),
    medianaLimitanteAguaNat: mediana(entre(30, 60).map(d => num(obj(local(nat, d)?.limitante)?.agua)).filter((x): x is number => x !== null)),
    medianaLimitanteAguaCtrl: mediana(entre(30, 60).map(d => num(obj(local(ctrl, d)?.limitante)?.agua)).filter((x): x is number => x !== null)),
    poblacionMediaNat: nivelNat, poblacionMediaCtrl: nivelCtrl,
    cocientePoblacion: nivelNat === null || nivelCtrl === null ? null
      : nivelCtrl > 0 ? nivelNat / nivelCtrl : nivelNat > 0 ? Infinity : null };
}
function criterioCumple(r: ReturnType<typeof fila>, brazo: 'Nat' | 'Ctrl', indice: number): boolean {
  const c = brazo === 'Nat' ? r.criteriosNat : r.criteriosCtrl;
  return c?.[CRITERIOS[indice]!]?.estado === 'cumple';
}
function evaluarC1C8(raiz: string, nombres: string[], evaluador: Evaluador): Pick<Informe, 'replicas'> {
  // El evaluador congelado descubre todos los archivos: se le entrega una vista limitada al día 60.
  const temporal = mkdtempSync(join(tmpdir(), 'nat-criterio-'));
  try {
    for (const nombre of nombres) {
      const origen = join(raiz, nombre), destino = join(temporal, nombre);
      if (!existsSync(origen)) continue;
      mkdirSync(destino);
      for (const archivo of readdirSync(origen)) {
        const m = /^dia-(\d+)\.json$/.exec(archivo);
        if ((m && Number(m[1]) <= 60) || archivo === 'replica.json') copyFileSync(join(origen, archivo), join(destino, archivo));
      }
    }
    return evaluador(temporal, { dia: 60 });
  } finally { rmSync(temporal, { recursive: true, force: true }); }
}

export function evaluarDecision(entrada: string, etapa: 1 | 2, evaluador: Evaluador = evaluarConjunto) {
  const raiz = resolve(entrada);
  if (!existsSync(raiz)) throw new Error(`Entrada ausente: ${raiz}`);
  if (etapa === 1) {
    const motivos: string[] = [], semillas = CRIBADO.map(semilla => {
      const ctrl = leer(raiz, 'CTRL', semilla, 20), nat = leer(raiz, 'NAT', semilla, 20);
      const sensibles = (['NATR12', 'NATR24'] as const).map(b => leer(raiz, b, semilla, 20));
      const nacNat = entre(1, 20).reduce((s, d) => s + (locNum(nat, d, 'nacimientosDia') ?? 0), 0);
      const nacCtrl = entre(1, 20).reduce((s, d) => s + (locNum(ctrl, d, 'nacimientosDia') ?? 0), 0);
      const sedNat = causa(nat, 'dehydration'), sedCtrl = causa(ctrl, 'dehydration');
      const x = mediana(entre(10, 20).map(d => percentil(nat, d, 'xNacimientos')).filter((v): v is number => v !== null));
      const incompletos = [ctrl, nat].flatMap(r => faltantes(r, 20).map(f => `${r.nombre}: ${f}`));
      if (incompletos.length) motivos.push(`semilla ${semilla}: datos incompletos (${incompletos.join('; ')})`);
      if (nat.extinta && !ctrl.extinta) motivos.push(`semilla ${semilla}: NAT extinta y CTRL viva`);
      if (nacNat < 0.5 * nacCtrl) motivos.push(`semilla ${semilla}: nacimientos ${nacNat} < 0,5 × ${nacCtrl}`);
      if (sedNat !== null && sedCtrl !== null && sedNat > sedCtrl + 3) motivos.push(`semilla ${semilla}: sed ${sedNat} > CTRL ${sedCtrl} + 3`);
      for (const r of [ctrl, nat, ...sensibles]) if (r.alarma) motivos.push(`${r.nombre}: alarma 5 000`);
      return { semilla, nacimientosNat: nacNat, nacimientosCtrl: nacCtrl, sedNat, sedCtrl, xNacimientosMediana: x,
        extintaNat: nat.extinta, extintaCtrl: ctrl.extinta, incompletos,
        sensibilidad: sensibles.map(r => ({ brazo: r.nombre, poblacionDia20: valor(r, 20, 'poblacion'),
          nacimientos: entre(1, 20).reduce((s, d) => s + (locNum(r, d, 'nacimientosDia') ?? 0), 0),
          sed: causa(r, 'dehydration'), xNacimientosMediana: mediana(entre(10, 20).map(d => percentil(r, d, 'xNacimientos')).filter((v): v is number => v !== null)),
          extinta: r.extinta, alarma: r.alarma, incompletos: faltantes(r, 20) })) };
    });
    if (semillas.filter(s => s.xNacimientosMediana === null || s.xNacimientosMediana >= 0.75).length > 1)
      motivos.push('xNacimientos.p50: menos de 3/4 medianas < 0,75');
    return { etapa, entrada: raiz, decision: motivos.length ? 'DETENER' : 'SEGUIR', motivos, semillas };
  }
  const nombres = [...PANEL, ...FUERA].flatMap(s => [`CTRL-${s}`, `NAT-${s}`]);
  const congelado = evaluarC1C8(raiz, nombres, evaluador);
  const criterios = new Map(congelado.replicas.map(r => [r.nombre, r]));
  const crear = (s: number) => fila(leer(raiz, 'NAT', s, 60), leer(raiz, 'CTRL', s, 60), criterios);
  const panel = PANEL.map(crear);
  const incompletos = panel.flatMap(f => f.incompletos);
  const seguras = panel.filter(f => f.segura).length, mecanismos = panel.filter(f => f.mecanismo).length;
  const reguladas = panel.filter(f => f.regulada).length;
  const extNat = panel.filter(f => f.extintaNat).length, extCtrl = panel.filter(f => f.extintaCtrl).length;
  const todos = (brazo: 'Nat' | 'Ctrl') => panel.filter(f => entre(0, 6).every(i => criterioCumple(f, brazo, i))).length;
  const c1c7 = { NAT: todos('Nat'), CTRL: todos('Ctrl') };
  const porCriterio = CRITERIOS.map((id, i) => ({ id, NAT: panel.filter(f => criterioCumple(f, 'Nat', i)).length, CTRL: panel.filter(f => criterioCumple(f, 'Ctrl', i)).length }));
  let decision: string;
  if (incompletos.length) decision = 'DATOS INCOMPLETOS';
  else if (seguras < 10 || extNat > extCtrl + 1) decision = 'INSEGURO';
  else if (mecanismos >= 10 && reguladas >= 9 && c1c7.NAT >= c1c7.CTRL - 1
    && porCriterio.every(c => c.NAT >= c.CTRL - 1)) decision = 'VÁLIDA EN PANEL';
  else decision = 'NO VÁLIDA';
  const fuera = decision === 'VÁLIDA EN PANEL' ? FUERA.map(crear) : [];
  const confirmada = fuera.length === 4 && fuera.every(f => f.incompletos.length === 0)
    // Conjunto por semilla, como el resto de la campaña: mecanismo Y seguridad en la misma semilla.
    && fuera.filter(f => f.mecanismo && f.segura).length >= 3;
  const nivel = mediana(panel.map(f => f.cocientePoblacion).filter((x): x is number => x !== null));
  const adopcion = decision === 'VÁLIDA EN PANEL' && confirmada && nivel !== null && nivel >= 0.8;
  const resultado = decision === 'VÁLIDA EN PANEL' && confirmada && !adopcion ? 'VÁLIDA SIN ADOPCIÓN' : decision;
  return { etapa, entrada: raiz, decision, resultado, adopcion, confirmada, nivel, seguras, mecanismos, reguladas,
    extinciones: { NAT: extNat, CTRL: extCtrl }, c1c7, porCriterio, incompletos, panel, fueraDeMuestra: fuera };
}

export function informeTexto(inf: ReturnType<typeof evaluarDecision>): string {
  if (inf.etapa === 1) return [`NATALIDAD LOCAL — ETAPA 1: ${inf.decision}`, ...inf.motivos.map(m => `  ${m}`),
    ...inf.semillas.map(s => `  ${s.semilla}: nacimientos NAT/CTRL ${s.nacimientosNat}/${s.nacimientosCtrl}; sed ${s.sedNat}/${s.sedCtrl}; mediana x ${s.xNacimientosMediana}`)].join('\n');
  return [`NATALIDAD LOCAL — ETAPA 2: ${inf.resultado}`, `Panel: seguras ${inf.seguras}/12; mecanismo ${inf.mecanismos}/12; reguladas ${inf.reguladas}/12`,
    `C1–C7 simultáneos NAT/CTRL ${inf.c1c7.NAT}/${inf.c1c7.CTRL}; ${inf.porCriterio.map((c, i) => `C${i + 1} ${c.NAT}/${c.CTRL}`).join('; ')}`,
    `Fuera de muestra: ${inf.confirmada ? 'confirmada' : 'no confirmada'}; nivel ${inf.nivel ?? 'sin dato'}; adopción ${inf.adopcion ? 'sí' : 'no'}`,
    ...inf.incompletos.map(m => `  ${m}`)].join('\n');
}

function main(argv: string[]): void {
  let entrada: string | null = null, etapa: 1 | 2 | null = null, salida: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[++i];
    if (!v) throw new Error(`Falta valor para ${k}`);
    if (k === '--entrada') entrada = v;
    else if (k === '--etapa' && (v === '1' || v === '2')) etapa = Number(v) as 1 | 2;
    else if (k === '--salida') salida = v;
    else throw new Error(`Argumento inválido: ${k} ${v}`);
  }
  if (!entrada || !etapa) throw new Error('Uso: npx tsx scripts/lab/decision-natalidad.mts --entrada <dir> --etapa 1|2 [--salida json]');
  const inf = evaluarDecision(entrada, etapa);
  console.log(informeTexto(inf));
  if (salida) { mkdirSync(dirname(resolve(salida)), { recursive: true }); writeFileSync(salida, JSON.stringify(inf, null, 2) + '\n'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e); process.exitCode = 1; }
}
