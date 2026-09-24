/**
 * Decisión C8 de «Revisión 1 (antes de correr ningún brazo)»,
 * docs/preregistros/2026-09-23-c8-linaje-hogar.md.
 * Se congela antes de leer datos de VOC, HOG, VOCHOG y CTRL2.
 * Uso: npx tsx scripts/lab/decision-c8-linaje.mts --entrada <dir> --corte 20|60 [--salida informe.json]
 */
import { deepStrictEqual } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluarConjunto, evaluarSerieDiversidad, pendienteSen, TIPOS_COOPERACION,
  UMBRALES_POR_DEFECTO, type EvaluacionReplica, type ResultadoCriterio,
} from './criterio-terminado.mjs';

type Dia = Record<string, unknown>;
type Brazo = 'VOC' | 'HOG' | 'VOCHOG';
const BRAZOS: readonly Brazo[] = ['VOC', 'HOG', 'VOCHOG'];
const PANEL = Array.from({ length: 12 }, (_, i) => 2001 + i);
const FUERA = [2013, 2014, 2015, 2016];
const NUEVAS = new Set(['vocacionVarianza', 'vocacionEntropiaArgmax', 'vocacionCoincidencia',
  'diversidadConductaVentanaGen1', 'approachHogar', 'maderaMediaAdultos', 'piedraMediaAdultos',
  'muertesMenores8Dias', 'cambiosHogar', 'diversidadPerfilesJS', 'linajesVivos', 'linajesHerfindahl']);
const IGNORADAS_IDENTIDAD = new Set(['p50Ms', 'p95Ms', 'rss', ...NUEVAS]);

interface Datos { nombre: string; dias: Map<number, Dia>; errores: string[] }
export interface FilaSemilla {
  semilla: number; presente: boolean; estado: string | null; criterios: EvaluacionReplica['criterios'];
  gen1: ResultadoCriterio | null; pendienteTardia: number | null; exito: boolean;
  segura: boolean; seguridad: Record<string, unknown>; subida: number | null; incompletos: string[];
}
export interface ResultadoBrazo {
  brazo: Brazo; semillas: FilaSemilla[]; seguras: number; exitos: number; extinciones: number;
  ausentes: number[]; incompletos: string[]; decision: string; refutado: boolean;
  diagnosticoDia20?: Record<string, unknown>; componenteHogActuo?: boolean | null;
  contraste?: Record<string, unknown>; alcance?: Record<string, unknown>;
}

const numero = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const objeto = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const media = (xs: number[]): number | null => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function mediana(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function leer(raiz: string, brazo: string, semilla: number): Datos | null {
  const nombre = `${brazo}-${semilla}`, dir = join(raiz, nombre);
  if (!existsSync(dir)) return null;
  const dias = new Map<number, Dia>(), errores: string[] = [];
  for (const fichero of readdirSync(dir).filter(f => /^dia-\d{3}\.json$/.test(f))) {
    const d = Number(fichero.slice(4, 7));
    try {
      const valor = objeto(JSON.parse(readFileSync(join(dir, fichero), 'utf8')));
      if (valor) dias.set(d, valor); else errores.push(`${fichero}: no es objeto`);
    } catch { errores.push(`${fichero}: JSON ilegible`); }
  }
  return { nombre, dias, errores };
}
const dia = (r: Datos | null, d: number): Dia | undefined => r?.dias.get(d);
function campo(r: Datos | null, d: number, clave: string): number | null { return numero(dia(r, d)?.[clave]); }
function serie(r: Datos | null, desde: number, hasta: number, clave: string): number | null {
  const puntos: [number, number][] = [];
  for (let d = desde; d <= hasta; d++) {
    const v = campo(r, d, clave);
    if (v === null) return null;
    puntos.push([d, v]);
  }
  return pendienteSen(puntos);
}
function mediaCampo(r: Datos | null, desde: number, hasta: number, clave: string): number | null {
  const xs: number[] = [];
  for (let d = desde; d <= hasta; d++) {
    const v = campo(r, d, clave);
    if (v === null) return null;
    xs.push(v);
  }
  return media(xs);
}
function cooperaciones(r: Datos | null, d: number): number | null {
  const actual = objeto(dia(r, d)?.cooperacionAcumuladaPorTipo);
  const previo = d <= 10 ? null : objeto(dia(r, d - 10)?.cooperacionAcumuladaPorTipo);
  if (!actual || (d > 10 && !previo)) return null;
  let suma = 0;
  for (const tipo of TIPOS_COOPERACION) {
    if (!Object.hasOwn(actual, tipo)) continue;
    const a = numero(actual[tipo]);
    const b = d <= 10 ? 0 : numero(previo?.[tipo]);
    if (a === null || b === null) return null;
    suma += a - b;
  }
  // El evaluador congelado admite foodShared como contador separado.
  const alimento = campo(r, d, 'foodShared');
  if (alimento !== null) {
    const antes = d <= 10 ? 0 : campo(r, d - 10, 'foodShared');
    if (antes === null) return null;
    suma += alimento - antes - ((numero(actual.foodShared) ?? 0) - (d <= 10 ? 0 : (numero(previo?.foodShared) ?? 0)));
  }
  return suma;
}
function seguridad(r: Datos | null, ctrl: Datos | null, d: number, extinta: boolean, ctrlExtinta: boolean): { segura: boolean; detalle: Record<string, unknown>; faltantes: string[] } {
  if (!r || !ctrl) return { segura: false, detalle: {}, faltantes: ['réplica o CTRL2 ausente'] };
  if (extinta) return { segura: false, detalle: { extinta: true }, faltantes: [] };
  if (!r.dias.has(d)) return { segura: false, detalle: { extinta: false }, faltantes: [`dia-${String(d).padStart(3, '0')}.json ausente: seguridad no comprobable`] };
  if (ctrlExtinta) return { segura: true, detalle: { ctrl2Extinta: true, extinta: false }, faltantes: [] };
  const n = campo(r, d, 'nacimientos'), nc = campo(ctrl, d, 'nacimientos');
  const m = campo(r, d, 'muertesMenores8Dias'), mc = campo(ctrl, d, 'muertesMenores8Dias');
  const c = cooperaciones(r, d), cc = cooperaciones(ctrl, d);
  const faltantes = [n, nc, m, mc, c, cc].some(x => x === null) ? [`seguridad día ${d}: nacimientos, muertesMenores8Dias o cooperaciones`] : [];
  const razon = n === null || m === null ? null : n === 0 ? (m === 0 ? 0 : Infinity) : m / n;
  const razonCtrl = nc === null || mc === null ? null : nc === 0 ? (mc === 0 ? 0 : Infinity) : mc / nc;
  const segura = faltantes.length === 0 && n! >= 0.8 * nc! && razon! <= 1.5 * razonCtrl! + 0.02 && c! >= (d === 60 ? 0.5 : 0.6) * cc!;
  return { segura, detalle: { extinta: false, nacimientos: n, nacimientosCtrl2: nc, razonMuertes: Number.isFinite(razon) ? razon : null,
    razonMuertesCtrl2: Number.isFinite(razonCtrl) ? razonCtrl : null, cooperaciones: c, cooperacionesCtrl2: cc }, faltantes };
}
/** «Campo requerido» = la clave existe en cada dia-NNN.json de 5..d (y el fichero existe). Un valor null legítimo (p. ej.
 * cohorte de generación ≥ 1 vacía ese día) NO es un dato incompleto: lo trata la regla congelada de la serie (cobertura
 * ≥ 80 %, extremos completos), que lo convierte en «desconocido» y la semilla no aprueba. */
function faltanCampos(r: Datos, d: number, claves: string[]): string[] {
  const faltan: string[] = [];
  for (let n = 5; n <= d; n++) {
    const x = dia(r, n);
    if (!x) { faltan.push(`dia-${String(n).padStart(3, '0')}.json ausente`); continue; }
    for (const clave of claves) if (!Object.hasOwn(x, clave)) faltan.push(`dia-${String(n).padStart(3, '0')}.json: ${clave}`);
  }
  return faltan;
}
function binomialUnilateral(n: number, positivos: number): number {
  let combinacion = 1, suma = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= positivos) suma += combinacion;
    combinacion *= (n - k) / (k + 1);
  }
  return suma / 2 ** n;
}
function identidad(raiz: string, semillas: number[]): { comparadas: number; diferencias: string[] } {
  let comparadas = 0;
  const diferencias: string[] = [];
  for (const semilla of semillas) {
    const a = leer(raiz, 'CTRL', semilla), b = leer(raiz, 'CTRL2', semilla);
    if (!a || !b) continue;
    for (const [d, x] of a.dias) {
      const y = b.dias.get(d);
      if (!y) continue;
      comparadas++;
      for (const clave of Object.keys(x).filter(k => Object.hasOwn(y, k) && !IGNORADAS_IDENTIDAD.has(k))) {
        try { deepStrictEqual(x[clave], y[clave]); }
        catch { diferencias.push(`${semilla}/dia-${String(d).padStart(3, '0')}.json: ${clave}`); }
      }
    }
  }
  return { comparadas, diferencias };
}

/** Los denominadores 12 y 4 son fijos; una ausencia jamás reduce el denominador. */
export function evaluarDecision(entrada: string, corte: 20 | 60) {
  const raiz = resolve(entrada);
  const congelado = evaluarConjunto(raiz, { dia: corte, ventana: 10, diversidadCampo: 'diversidadConductaVentana' });
  const reps = new Map(congelado.replicas.map(r => [r.nombre, r]));
  const datos = new Map<string, Datos | null>();
  for (const b of [...BRAZOS, 'CTRL2', 'CTRL']) for (const s of [...PANEL, ...FUERA]) datos.set(`${b}-${s}`, leer(raiz, b, s));
  const get = (b: string, s: number) => datos.get(`${b}-${s}`) ?? null;
  const evaluarFila = (brazo: string, semilla: number): FilaSemilla => {
    const r = get(brazo, semilla), ctrl = get('CTRL2', semilla);
    const ev = reps.get(`${brazo}-${semilla}`) ?? null, ec = reps.get(`CTRL2-${semilla}`) ?? null;
    const extinta = ev?.estado === 'extinguida', ctrlExtinta = ec?.estado === 'extinguida';
    const incompletos = [...(r?.errores ?? []), ...(ctrl?.errores.map(e => `CTRL2: ${e}`) ?? [])];
    if (!r) incompletos.push('réplica ausente');
    if (!ctrl) incompletos.push('CTRL2 ausente');
    if (r && !extinta && !r.dias.has(corte)) incompletos.push(`dia-${String(corte).padStart(3, '0')}.json ausente`);
    if (ctrl && !ctrlExtinta && !ctrl.dias.has(corte)) incompletos.push(`CTRL2 dia-${String(corte).padStart(3, '0')}.json ausente`);
    if (ev?.estado === 'ilegible') incompletos.push(ev.nota ?? 'réplica ilegible');
    if (ec?.estado === 'ilegible') incompletos.push(`CTRL2: ${ec.nota ?? 'réplica ilegible'}`);
    const seg = seguridad(r, ctrl, corte, extinta, ctrlExtinta);
    incompletos.push(...seg.faltantes);
    let gen1: ResultadoCriterio | null = null, pendienteTardia: number | null = null, subida: number | null = null;
    if (corte === 60 && r && !extinta) {
      incompletos.push(...faltanCampos(r, 60, ['diversidadConductaVentana', 'diversidadConductaVentanaGen1']));
      gen1 = evaluarSerieDiversidad(d => dia(r, d)?.diversidadConductaVentanaGen1, 60,
        { ...UMBRALES_POR_DEFECTO, diversidadCampo: 'diversidadConductaVentana', dia: 60 });
      pendienteTardia = serie(r, 20, 60, 'diversidadConductaVentana');
      subida = serie(r, 5, 60, 'diversidadConductaVentana');
      subida = subida === null ? null : subida * 55;
    }
    if (corte === 60 && ctrl && !ctrlExtinta) incompletos.push(...faltanCampos(ctrl, 60, ['diversidadConductaVentana']).map(e => `CTRL2 ${e}`));
    if (corte === 60 && ev?.criterios) for (const [id, criterio] of Object.entries(ev.criterios)) {
      if (criterio.estado === 'desconocido' && /falta|ausente|sin dato|incoherente|no numérico/i.test(criterio.motivo)) incompletos.push(`${id}: ${criterio.motivo}`);
    }
    return { semilla, presente: !!r, estado: ev?.estado ?? null, criterios: ev?.criterios ?? null, gen1,
      pendienteTardia, exito: corte === 60 && ev?.todos === 'cumple' && gen1?.estado === 'cumple' && pendienteTardia !== null && pendienteTardia > 0 && incompletos.length === 0,
      segura: seg.segura, seguridad: seg.detalle, subida, incompletos };
  };
  const resultados: ResultadoBrazo[] = BRAZOS.map(brazo => {
    const semillas = PANEL.map(s => evaluarFila(brazo, s));
    const seguras = semillas.filter(s => s.segura).length, exitos = semillas.filter(s => s.exito).length;
    const extinciones = semillas.filter(s => s.estado === 'extinguida').length;
    const controlExtinciones = PANEL.filter(s => reps.get(`CTRL2-${s}`)?.estado === 'extinguida').length;
    const incompletos = semillas.flatMap(s => s.incompletos.map(e => `${s.semilla}: ${e}`));
    const decision = corte === 20 ? (seguras < 9 ? 'DETENER' : 'CONTINUAR') : incompletos.length ? 'DATOS_INCOMPLETOS' :
      seguras < 9 || extinciones >= controlExtinciones + 2 ? 'INSEGURO' : exitos >= 7 ? 'EXITO_PANEL' : 'NO_EXITO';
    const resultado: ResultadoBrazo = { brazo, semillas, seguras, exitos, extinciones, ausentes: semillas.filter(s => !s.presente).map(s => s.semilla),
      incompletos, decision, refutado: corte === 60 && (decision === 'INSEGURO' || decision === 'NO_EXITO' && exitos <= 4) };
    if (corte === 20) {
      const porSemilla = PANEL.map(s => {
        const r = get(brazo, s), c = get('CTRL2', s);
        const v10 = campo(r, 10, 'vocacionVarianza'), v20 = campo(r, 20, 'vocacionVarianza');
        const ventana = mediaCampo(r, 15, 20, 'diversidadConductaVentana'), base = mediaCampo(c, 15, 20, 'diversidadConductaVentana');
        const madera = mediaCampo(r, 15, 20, 'maderaMediaAdultos'), maderaCtrl = mediaCampo(c, 15, 20, 'maderaMediaAdultos');
        const coincidencias = Array.from({ length: 6 }, (_, i) => campo(r, 15 + i, 'vocacionCoincidencia')).filter((v): v is number => v !== null);
        return { semilla: s, vocacionVarianzaD10: v10, vocacionVarianzaD20: v20,
          vocacionVarianzaRelacion: v10 === null || v20 === null || v10 === 0 ? null : v20 / v10,
          medianaVocacionCoincidencia: mediana(coincidencias),
          maderaRelacionCtrl2: madera === null || maderaCtrl === null ? null : maderaCtrl === 0 ? null : madera / maderaCtrl,
          gananciaVentana: ventana === null || base === null ? null : ventana - base };
      });
      const coincidencias = PANEL.flatMap(s => Array.from({ length: 6 }, (_, i) => campo(get(brazo, s), 15 + i, 'vocacionCoincidencia')).filter((v): v is number => v !== null));
      resultado.diagnosticoDia20 = { porSemilla, medianaVocacionCoincidencia: mediana(coincidencias) };
    } else {
      if (brazo === 'VOCHOG') {
        const pares = PANEL.map(s => { const a = mediaCampo(get(brazo, s), 46, 60, 'approachHogar'), c = mediaCampo(get('CTRL2', s), 46, 60, 'approachHogar'); return a === null || c === null ? null : c - a; });
        const bajan = pares.filter(v => v !== null && v >= 0.02).length;
        const faltan = pares.filter(v => v === null).length;
        resultado.componenteHogActuo = bajan >= 5 ? true : bajan + faltan < 5 ? false : null;
        resultado.alcance = { ...(resultado.alcance ?? {}), approachHogarBaja002: bajan, approachHogarSinDato: faltan };
      }
      const diferencias = PANEL.map(s => {
        const a = semillas.find(x => x.semilla === s)?.subida ?? null;
        const c = serie(get('CTRL2', s), 5, 60, 'diversidadConductaVentana');
        return { semilla: s, diferencia: a === null || c === null ? null : a - c * 55 };
      });
      const positivos = diferencias.filter(x => x.diferencia !== null && x.diferencia > 0).length;
      resultado.contraste = { diferencias, positivos, pSignosUnilateral: binomialUnilateral(12, positivos), mejoraAtribuible: diferencias.every(x => x.diferencia !== null) && positivos >= 11 };
      const js = PANEL.map(s => ({ semilla: s, sen5a60: serie(get(brazo, s), 5, 60, 'diversidadPerfilesJS'), sen35a60: serie(get(brazo, s), 35, 60, 'diversidadPerfilesJS') }));
      const comparaciones = PANEL.map(s => {
        const a = get(brazo, s), c = get('CTRL2', s);
        const dif = (clave: string, desde: number, hasta: number) => { const x = mediaCampo(a, desde, hasta, clave), y = mediaCampo(c, desde, hasta, clave); return x === null || y === null ? null : x - y; };
        const linajesHerfindahl = dif('linajesHerfindahl', 60, 60);
        const cambiosHogar = dif('cambiosHogar', 60, 60);
        const maderaMediaAdultos = dif('maderaMediaAdultos', 60, 60);
        const piedraMediaAdultos = dif('piedraMediaAdultos', 60, 60);
        const approachHogar = dif('approachHogar', 46, 60);
        return { semilla: s, linajesHerfindahl, cambiosHogar, maderaMediaAdultos, piedraMediaAdultos, approachHogar,
          concentracionNoSube: linajesHerfindahl === null ? null : linajesHerfindahl <= 0,
          reubicacionProductiva: brazo === 'HOG' || brazo === 'VOCHOG' ?
            [cambiosHogar, maderaMediaAdultos, piedraMediaAdultos, approachHogar].some(v => v === null) ? null :
              cambiosHogar! > 0 && maderaMediaAdultos! >= 0 && piedraMediaAdultos! >= 0 && approachHogar! < 0 : null };
      });
      resultado.alcance = { ...resultado.alcance, diversidadPerfilesJS: js,
        sube: js.filter(x => x.sen5a60 !== null && x.sen5a60 > 0).length,
        sostenidaFinal: js.filter(x => x.sen35a60 !== null && x.sen35a60 > 0).length,
        conductaMasDiversa: js.filter(x => x.sen5a60 !== null && x.sen5a60 > 0).length >= 7,
        sostenidaAlFinal: js.filter(x => x.sen35a60 !== null && x.sen35a60 > 0).length >= 7,
        comparaciones };
    }
    return resultado;
  });
  const elegible = corte === 60 ? resultados.filter(r => r.decision === 'EXITO_PANEL').sort((a, b) => b.exitos - a.exitos || BRAZOS.indexOf(a.brazo) - BRAZOS.indexOf(b.brazo))[0] : undefined;
  const fuera = elegible ? FUERA.map(s => evaluarFila(elegible.brazo, s)) : [];
  // La lectura fuera de muestra se informa únicamente para el brazo elegido.
  const confirmacion = elegible ? { brazo: elegible.brazo, semillas: fuera, datosPresentes: fuera.every(f => f.presente && !!get('CTRL2', f.semilla)),
    exitos: fuera.filter(f => f.exito).length, seguras: fuera.filter(f => f.segura).length,
    adopcion: fuera.filter(f => f.exito).length >= 3 && fuera.every(f => f.segura && f.incompletos.length === 0) } : null;
  const factorial = corte === 60 ? Object.fromEntries((['VOC', 'HOG', 'interaccion'] as const).map(efecto => {
    const valores = PANEL.map(s => {
      const c = serie(get('CTRL2', s), 5, 60, 'diversidadConductaVentana');
      const v = serie(get('VOC', s), 5, 60, 'diversidadConductaVentana');
      const h = serie(get('HOG', s), 5, 60, 'diversidadConductaVentana');
      const vh = serie(get('VOCHOG', s), 5, 60, 'diversidadConductaVentana');
      if (efecto === 'VOC') return c === null || v === null ? null : (v - c) * 55;
      if (efecto === 'HOG') return c === null || h === null ? null : (h - c) * 55;
      return c === null || v === null || h === null || vh === null ? null : (vh - v - h + c) * 55;
    });
    return [efecto, { valores, media: valores.every(v => v !== null) ? media(valores as number[]) : null }];
  })) : null;
  return { entrada: raiz, corte, panel: PANEL, fueraDeMuestra: FUERA, brazos: resultados, factorial, confirmacion,
    identidadCtrlCtrl2: identidad(raiz, [...PANEL, ...FUERA]), avisosEvaluador: congelado.avisos, ignorados: congelado.ignorados };
}

export function informeTexto(inf: ReturnType<typeof evaluarDecision>): string {
  const lineas = [`Decisión C8 — corte ${inf.corte}`, `Entrada: ${inf.entrada}`];
  const fmt = (n: number | null | undefined) => n === null || n === undefined ? 'sin dato' : Number(n.toPrecision(5)).toString();
  for (const b of inf.brazos) {
    lineas.push(`\n${b.brazo}: ${b.decision}${b.refutado ? ' (refutado)' : ''}; ${b.seguras}/12 seguras, ${b.exitos}/12 éxitos de semilla, ${b.extinciones} extinciones; ausentes: ${b.ausentes.join(', ') || 'ninguna'}; incompletos: ${b.incompletos.length}`);
    for (const s of b.semillas) lineas.push(`  ${s.semilla}: ${s.estado ?? 'ausente'}, segura=${s.segura}, C1–C8=${s.criterios ? Object.values(s.criterios).map(c => c.estado === 'cumple' ? '✓' : c.estado === 'falla' ? '×' : '?').join('') : 'sin dato'}, Gen1=${s.gen1?.estado ?? 'sin dato'}, Sen20..60=${fmt(s.pendienteTardia)}, éxito=${s.exito}${s.incompletos.length ? `; incompleto: ${s.incompletos.join(' | ')}` : ''}`);
    if (b.diagnosticoDia20) {
      lineas.push(`  Diagnóstico día 20: mediana coincidencia=${fmt(b.diagnosticoDia20.medianaVocacionCoincidencia as number | null)}`);
      for (const p of b.diagnosticoDia20.porSemilla as Record<string, unknown>[]) lineas.push(`    ${p.semilla}: varianza d20/d10=${fmt(p.vocacionVarianzaRelacion as number | null)}, coincidencia=${fmt(p.medianaVocacionCoincidencia as number | null)}, madera/CTRL2=${fmt(p.maderaRelacionCtrl2 as number | null)}, ganancia ventana=${fmt(p.gananciaVentana as number | null)}`);
    }
    if (b.contraste) {
      lineas.push(`  Contraste C8: ${b.contraste.positivos}/12 diferencias positivas, p unilateral=${fmt(b.contraste.pSignosUnilateral as number)}, mejora atribuible=${b.contraste.mejoraAtribuible}`);
      for (const x of b.contraste.diferencias as { semilla: number; diferencia: number | null }[]) lineas.push(`    ${x.semilla}: Δ subida C8=${fmt(x.diferencia)}`);
    }
    if (b.componenteHogActuo !== undefined) lineas.push(`  Componente HOG actuó: ${b.componenteHogActuo}; bajada ≥ 0,02 en ${b.alcance?.approachHogarBaja002}/12`);
    if (b.alcance) {
      lineas.push(`  Alcance: diversidadPerfilesJS sube en ${b.alcance.sube}/12 y al final en ${b.alcance.sostenidaFinal}/12`);
      for (const x of b.alcance.comparaciones as Record<string, unknown>[]) lineas.push(`    ${x.semilla}: ΔHerfindahl=${fmt(x.linajesHerfindahl as number | null)}, Δhogar=${fmt(x.cambiosHogar as number | null)}, Δmadera=${fmt(x.maderaMediaAdultos as number | null)}, Δpiedra=${fmt(x.piedraMediaAdultos as number | null)}, Δapproach=${fmt(x.approachHogar as number | null)}, reubicación=${x.reubicacionProductiva ?? 'sin dato'}`);
    }
  }
  if (inf.factorial) lineas.push(`\nEstimación factorial de la subida C8: VOC=${fmt(inf.factorial.VOC.media)}, HOG=${fmt(inf.factorial.HOG.media)}, interacción=${fmt(inf.factorial.interaccion.media)}`);
  if (inf.confirmacion) {
    lineas.push(`Fuera de muestra ${inf.confirmacion.brazo}: ${inf.confirmacion.exitos}/4 éxitos, ${inf.confirmacion.seguras}/4 seguras; datos presentes=${inf.confirmacion.datosPresentes}; adopción: ${inf.confirmacion.adopcion ? 'sí' : 'no'}`);
    for (const s of inf.confirmacion.semillas) lineas.push(`  ${s.semilla}: segura=${s.segura}, éxito=${s.exito}, incompletos=${s.incompletos.length}`);
  }
  lineas.push(`Identidad CTRL/CTRL2: ${inf.identidadCtrlCtrl2.comparadas} días comparados, ${inf.identidadCtrlCtrl2.diferencias.length} diferencias`);
  for (const x of inf.identidadCtrlCtrl2.diferencias) lineas.push(`  ${x}`);
  return lineas.join('\n');
}

function main(argv: string[]): void {
  let entrada: string | null = null, salida: string | null = null, corte: 20 | 60 | null = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[++i];
    if (!v) throw new Error(`Falta valor para ${k}`);
    if (k === '--entrada') entrada = v;
    else if (k === '--salida') salida = v;
    else if (k === '--corte' && (v === '20' || v === '60')) corte = Number(v) as 20 | 60;
    else throw new Error(`Argumento inválido: ${k} ${v}`);
  }
  if (!entrada || !corte) throw new Error('Uso: npx tsx scripts/lab/decision-c8-linaje.mts --entrada <dir> --corte 20|60 [--salida informe.json]');
  const inf = evaluarDecision(entrada, corte);
  console.log(informeTexto(inf));
  if (salida) { mkdirSync(dirname(resolve(salida)), { recursive: true }); writeFileSync(salida, JSON.stringify(inf, null, 2) + '\n'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e); process.exitCode = 1; }
}
