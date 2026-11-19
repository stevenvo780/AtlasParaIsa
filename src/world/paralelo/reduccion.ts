/**
 * T145 (núcleo): fase B de solo lectura y fase C de confirmación ordenada.
 *
 * Fase B: cada actor decide sin escribir el mundo y emite `Intent`. Fase C: el coordinador
 * ordena todos los intentos por `(celda, actorSlot, secuenciaLocal)` y los aplica sobre
 * stocks finitos sin bajar de 0. Ni el orden de llegada de los workers, ni el número de
 * hilos, ni la geometría de partición (128/256/512) entran en el orden: solo el contenido.
 * Este módulo es puro: no lee `motor.*`, no usa `Math.random`/`Date.now` ni `Atomics`, y no
 * muta sus entradas. El cableado en `bodyAndAction`/`choose` queda fuera (Gate E.1).
 */
import type { World } from '../index.js';
import { createDecisionReadOnlyProxy, withReadOnlyDecisionGuard } from './guardia.js';
import { mortonCode } from '../gpu/reparto.js';

/** Recursos finitos típicos: 'cosecha'|'agua'|'caza'|'construccion'|'reparacion'|'intercambio'|'compartir'. */
export type TipoRecurso = string;

export interface Intent {
  fase: string;
  tipoRecurso: TipoRecurso;
  recursoId: string;
  celdaX: number;
  celdaY: number;
  actorSlot: number;
  secuenciaLocal: number;
  cantidad: number;
  payload?: unknown;
}

export interface ResultadoIntento {
  intent: Intent;
  concedido: number;
  denegado: number;
  /** true si esta copia es una reemisión idéntica de un intento ya confirmado (no se aplica dos veces). */
  duplicado: boolean;
}

export interface ResultadoConfirmacion {
  /** Todos los intentos únicos, en orden canónico de confirmación. */
  ordenados: readonly Intent[];
  /** Un resultado por intento recibido (incluidas las reemisiones), en orden canónico. */
  resultados: readonly ResultadoIntento[];
  /** Stocks finales por `recursoId`; nunca negativos. */
  stocksFinales: ReadonlyMap<string, number>;
}

function enteroSeguro(valor: number, campo: string): number {
  if (!Number.isSafeInteger(valor)) throw new TypeError(`Intent.${campo} debe ser un entero seguro.`);
  return valor;
}

/** Clave determinista del payload (claves de objeto ordenadas, `-0` distinguido en números hoja). */
export function clavePayload(payload: unknown): string {
  const vistos = new Set<object>();
  const codificar = (valor: unknown): string => {
    if (valor === null) return 'null';
    if (typeof valor === 'number') return Object.is(valor, -0) ? 'n:-0' : `n:${valor}`;
    if (typeof valor === 'string') return `s:${JSON.stringify(valor)}`;
    if (typeof valor === 'boolean') return `b:${valor}`;
    if (typeof valor === 'undefined') return 'u';
    if (typeof valor === 'bigint') return `i:${valor}`;
    if (typeof valor !== 'object') throw new TypeError('payload de Intent no serializable para el orden canónico.');
    if (vistos.has(valor)) throw new TypeError('payload de Intent circular no serializable para el orden canónico.');
    vistos.add(valor);
    try {
      if (Array.isArray(valor)) return `[${valor.map(codificar).join(',')}]`;
      const claves = Object.keys(valor).sort();
      return `{${claves.map(clave => `${JSON.stringify(clave)}:${codificar((valor as Record<string, unknown>)[clave])}`).join(',')}}`;
    } finally { vistos.delete(valor); }
  };
  return codificar(payload);
}

/** Valida y devuelve una copia normalizada e inmutable del intento; no muta la entrada. */
export function validarIntent(intent: Intent): Intent {
  if (intent === null || typeof intent !== 'object') throw new TypeError('Intent debe ser un objeto.');
  if (typeof intent.fase !== 'string' || intent.fase.length === 0) throw new TypeError('Intent.fase debe ser una cadena no vacía.');
  if (typeof intent.tipoRecurso !== 'string' || intent.tipoRecurso.length === 0) throw new TypeError('Intent.tipoRecurso debe ser una cadena no vacía.');
  if (typeof intent.recursoId !== 'string' || intent.recursoId.length === 0) throw new TypeError('Intent.recursoId debe ser una cadena no vacía.');
  const celdaX = enteroSeguro(intent.celdaX, 'celdaX');
  const celdaY = enteroSeguro(intent.celdaY, 'celdaY');
  const actorSlot = enteroSeguro(intent.actorSlot, 'actorSlot');
  const secuenciaLocal = enteroSeguro(intent.secuenciaLocal, 'secuenciaLocal');
  if (actorSlot < 0) throw new RangeError('Intent.actorSlot debe ser >= 0.');
  if (secuenciaLocal < 0) throw new RangeError('Intent.secuenciaLocal debe ser >= 0.');
  if (typeof intent.cantidad !== 'number' || !Number.isFinite(intent.cantidad) || intent.cantidad < 0) {
    throw new RangeError('Intent.cantidad debe ser finita y >= 0.');
  }
  const copia: Intent = {
    fase: intent.fase, tipoRecurso: intent.tipoRecurso, recursoId: intent.recursoId,
    celdaX, celdaY, actorSlot, secuenciaLocal, cantidad: intent.cantidad + 0,
    ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
  };
  return Object.freeze(copia);
}

const cmpTexto = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const cmpNumero = (a: number, b: number): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * Orden total de confirmación: `(celdaX, celdaY, actorSlot, secuenciaLocal)` y, como desempate
 * de contenido, `(fase, tipoRecurso, recursoId, cantidad, payload)`. Nunca orden de llegada.
 */
export function compararIntentos(a: Intent, b: Intent): number {
  return cmpNumero(a.celdaX, b.celdaX) || cmpNumero(a.celdaY, b.celdaY)
    || cmpNumero(a.actorSlot, b.actorSlot) || cmpNumero(a.secuenciaLocal, b.secuenciaLocal)
    || cmpTexto(a.fase, b.fase) || cmpTexto(a.tipoRecurso, b.tipoRecurso) || cmpTexto(a.recursoId, b.recursoId)
    || cmpNumero(a.cantidad, b.cantidad) || cmpTexto(clavePayload(a.payload), clavePayload(b.payload));
}

/** Identidad exactly-once de un intento dentro de un paso: quién lo emitió y su secuencia local. */
export function claveIdentidad(intent: Intent): string {
  return `${intent.actorSlot}:${intent.secuenciaLocal}`;
}

function mismaEmision(a: Intent, b: Intent): boolean {
  return a.fase === b.fase && a.tipoRecurso === b.tipoRecurso && a.recursoId === b.recursoId
    && a.celdaX === b.celdaX && a.celdaY === b.celdaY && Object.is(a.cantidad, b.cantidad)
    && clavePayload(a.payload) === clavePayload(b.payload);
}

/** Orden canónico de fase C. Devuelve un arreglo nuevo de copias validadas; no muta la entrada. */
export function ordenarIntentos(intentos: readonly Intent[]): Intent[] {
  return intentos.map(validarIntent).sort(compararIntentos);
}

function leerStocks(stocks: ReadonlyMap<string, number> | Readonly<Record<string, number>>): Map<string, number> {
  const copia = new Map<string, number>();
  const entradas: Iterable<readonly [string, number]> = stocks instanceof Map ? stocks.entries() : Object.entries(stocks);
  for (const [recursoId, cantidad] of entradas) {
    if (typeof recursoId !== 'string' || recursoId.length === 0) throw new TypeError('Stock con recursoId vacío.');
    if (typeof cantidad !== 'number' || !Number.isFinite(cantidad) || cantidad < 0) {
      throw new RangeError(`Stock de ${recursoId} debe ser finito y >= 0.`);
    }
    copia.set(recursoId, cantidad + 0);
  }
  return copia;
}

/**
 * Fase C: confirma los intentos en orden canónico sobre stocks finitos.
 * Cada intento único concede `min(cantidad, stockRestante)`; el resto se deniega, nunca se
 * pierde: `concedido + denegado === cantidad` y todo intento recibido aparece en `resultados`.
 * Una reemisión idéntica `(actorSlot, secuenciaLocal)` se marca `duplicado` y concede 0; una
 * reemisión conflictiva (misma identidad, distinto contenido) lanza. El stock nunca baja de 0.
 */
export function confirmarIntentos(
  intentos: readonly Intent[],
  stocks: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): ResultadoConfirmacion {
  const restantes = leerStocks(stocks);
  const ordenadosEntrada = ordenarIntentos(intentos);
  // Consistencia recurso↔celda: un mismo recursoId no puede nombrar dos celdas en un paso.
  const celdaDe = new Map<string, string>();
  for (const intent of ordenadosEntrada) {
    const clave = `${intent.celdaX},${intent.celdaY}`;
    const previa = celdaDe.get(intent.recursoId);
    if (previa !== undefined && previa !== clave) {
      throw new Error(`recursoId ${intent.recursoId} en dos celdas (${previa} y ${clave}) en el mismo paso.`);
    }
    celdaDe.set(intent.recursoId, clave);
    if (!restantes.has(intent.recursoId)) throw new RangeError(`Stock desconocido para recursoId ${intent.recursoId}.`);
  }
  const unicos: Intent[] = [];
  const resultados: ResultadoIntento[] = [];
  const porIdentidad = new Map<string, Intent>();
  for (const intent of ordenadosEntrada) {
    const identidad = claveIdentidad(intent);
    const previo = porIdentidad.get(identidad);
    if (previo) {
      if (!mismaEmision(previo, intent)) {
        throw new Error(`Reemisión conflictiva de (actorSlot ${intent.actorSlot}, secuenciaLocal ${intent.secuenciaLocal}).`);
      }
      resultados.push(Object.freeze({ intent, concedido: 0, denegado: 0, duplicado: true }));
      continue;
    }
    porIdentidad.set(identidad, intent);
    unicos.push(intent);
    const restante = restantes.get(intent.recursoId)!;
    const concedido = Math.min(intent.cantidad, restante);
    const nuevoRestante = restante - concedido;
    restantes.set(intent.recursoId, nuevoRestante === 0 ? 0 : nuevoRestante);
    resultados.push(Object.freeze({ intent, concedido, denegado: intent.cantidad - concedido, duplicado: false }));
  }
  return Object.freeze({
    ordenados: Object.freeze(unicos),
    resultados: Object.freeze(resultados),
    stocksFinales: restantes,
  });
}

// ── Geometría de partición (solo quién calcula; nunca qué sale) ─────────────────────────

function validarRegionSide(regionSide: number): number {
  if (!Number.isSafeInteger(regionSide) || regionSide < 1) throw new RangeError('regionSide debe ser un entero >= 1.');
  return regionSide;
}

const divPiso = (valor: number, divisor: number): number => Math.floor(valor / divisor);

export function regionDeCelda(celdaX: number, celdaY: number, regionSide: number): { x: number; y: number } {
  enteroSeguro(celdaX, 'celdaX'); enteroSeguro(celdaY, 'celdaY');
  const lado = validarRegionSide(regionSide);
  return { x: divPiso(celdaX, lado), y: divPiso(celdaY, lado) };
}

/** Orden Morton de una región (coordenadas de región, no de celda), como bigint sin truncar. */
export function mortonDeRegion(regionX: number, regionY: number): bigint {
  return mortonCode(regionX, regionY);
}

/**
 * Reparte los intentos entre `workers` colas por región Morton (reparto contiguo, sin stealing)
 * y devuelve el orden de llegada simulado. Es solo un modelo de llegada para pruebas: la
 * confirmación posterior debe dar lo mismo con cualquier `orden`/`workers`/`regionSide`.
 */
export function simularLlegada(
  intentos: readonly Intent[],
  opciones: { regionSide: number; workers: number; orden: 'natural' | 'inverso' | 'adversarial' | 'mezclado' },
): Intent[] {
  const lado = validarRegionSide(opciones.regionSide);
  if (!Number.isSafeInteger(opciones.workers) || opciones.workers < 1) throw new RangeError('workers debe ser un entero positivo.');
  if (!['natural', 'inverso', 'adversarial', 'mezclado'].includes(opciones.orden)) throw new TypeError('orden de llegada inválido.');
  const validados = intentos.map(validarIntent);
  const porRegion = new Map<string, { morton: bigint; intentos: Intent[] }>();
  for (const intent of validados) {
    const region = regionDeCelda(intent.celdaX, intent.celdaY, lado);
    const clave = `${region.x},${region.y}`;
    const grupo = porRegion.get(clave) ?? { morton: mortonDeRegion(region.x, region.y), intentos: [] };
    grupo.intentos.push(intent);
    porRegion.set(clave, grupo);
  }
  const regiones = [...porRegion.values()].sort((a, b) => a.morton < b.morton ? -1 : a.morton > b.morton ? 1 : 0);
  for (const grupo of regiones) grupo.intentos.sort((a, b) => cmpNumero(a.actorSlot, b.actorSlot) || cmpNumero(a.secuenciaLocal, b.secuenciaLocal));
  const colas: Intent[][] = Array.from({ length: opciones.workers }, (_, w) =>
    regiones.slice(Math.floor(regiones.length * w / opciones.workers), Math.floor(regiones.length * (w + 1) / opciones.workers))
      .flatMap(grupo => grupo.intentos));
  if (opciones.orden === 'natural') return colas.flat();
  if (opciones.orden === 'inverso') return colas.reverse().flatMap(cola => cola.reverse());
  // Adversarial/mezclado: barajado determinista (LCG de semilla fija), sin reloj ni azar del proceso.
  const llegada = colas.flat();
  let semilla = 0x9e3779b9;
  const siguiente = (): number => { semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0; return semilla / 4294967296; };
  for (let i = llegada.length - 1; i > 0; i--) {
    const j = Math.floor(siguiente() * (i + 1));
    [llegada[i], llegada[j]] = [llegada[j]!, llegada[i]!];
  }
  return llegada;
}

// ── Migración entre regiones tras la barrera ────────────────────────────────────────────

export interface SolicitudMigracion {
  actorSlot: number;
  destinoX: number;
  destinoY: number;
  entidadId?: string;
}

export interface Migracion extends SolicitudMigracion {
  regionDestinoX: number;
  regionDestinoY: number;
  regionDestinoMorton: bigint;
}

/** Orden de migración `(regionDestinoMorton, actorSlot)`; el `actorSlot` se conserva tal cual. */
export function ordenarMigraciones(solicitudes: readonly SolicitudMigracion[], regionSide: number): Migracion[] {
  const lado = validarRegionSide(regionSide);
  const vistos = new Set<number>();
  const migraciones = solicitudes.map(solicitud => {
    const actorSlot = enteroSeguro(solicitud.actorSlot, 'actorSlot');
    if (actorSlot < 0) throw new RangeError('SolicitudMigracion.actorSlot debe ser >= 0.');
    if (vistos.has(actorSlot)) throw new Error(`Migración duplicada para actorSlot ${actorSlot}.`);
    vistos.add(actorSlot);
    const destinoX = enteroSeguro(solicitud.destinoX, 'destinoX');
    const destinoY = enteroSeguro(solicitud.destinoY, 'destinoY');
    const region = regionDeCelda(destinoX, destinoY, lado);
    return Object.freeze({
      actorSlot, destinoX, destinoY, ...(solicitud.entidadId !== undefined ? { entidadId: solicitud.entidadId } : {}),
      regionDestinoX: region.x, regionDestinoY: region.y, regionDestinoMorton: mortonDeRegion(region.x, region.y),
    }) as Migracion;
  });
  return migraciones.sort((a, b) =>
    a.regionDestinoMorton < b.regionDestinoMorton ? -1 : a.regionDestinoMorton > b.regionDestinoMorton ? 1
      : cmpNumero(a.actorSlot, b.actorSlot));
}

/**
 * Aplica las migraciones tras la barrera y devuelve las entidades migradas (copias nuevas) en
 * orden canónico de migración. La entidad de origen no se muta y su `actorSlot` no cambia.
 */
export function aplicarMigraciones<T extends { actorSlot: number; x: number; y: number }>(
  entidades: readonly T[], solicitudes: readonly SolicitudMigracion[], regionSide: number,
): { entidades: T[]; migraciones: readonly Migracion[] } {
  const migraciones = ordenarMigraciones(solicitudes, regionSide);
  const porSlot = new Map<number, T>();
  for (const entidad of entidades) {
    if (porSlot.has(entidad.actorSlot)) throw new Error(`actorSlot duplicado en entidades: ${entidad.actorSlot}.`);
    porSlot.set(entidad.actorSlot, entidad);
  }
  const migradas = migraciones.map(migracion => {
    const origen = porSlot.get(migracion.actorSlot);
    if (!origen) throw new RangeError(`Migración sin entidad para actorSlot ${migracion.actorSlot}.`);
    const copia = { ...origen, x: migracion.destinoX, y: migracion.destinoY, actorSlot: origen.actorSlot };
    if (copia.actorSlot !== origen.actorSlot) throw new Error('La migración no puede cambiar el actorSlot.');
    return copia;
  });
  return { entidades: migradas, migraciones: Object.freeze(migraciones) };
}

// ── Runner de fase B con guardia T148 ───────────────────────────────────────────────────

function recogerIntentos(
  emitidos: Iterable<Intent> | Intent | null | undefined, actorSlot: number,
): Intent[] {
  if (emitidos === null || emitidos === undefined) return [];
  const lista: Intent[] = typeof (emitidos as Intent).actorSlot === 'number' && !Array.isArray(emitidos)
    && !(Symbol.iterator in Object(emitidos)) ? [emitidos as Intent] : [...(emitidos as Iterable<Intent>)];
  return lista.map(intent => {
    const validado = validarIntent(intent);
    if (validado.actorSlot !== actorSlot) {
      throw new Error(`Intent de fase B con actorSlot ${validado.actorSlot} emitido por slot ${actorSlot}.`);
    }
    return validado;
  });
}

/**
 * Ejecuta la decisión de un actor sobre la vista de solo lectura de T148 y recoge sus intentos.
 * Con `motor.depuracion=true` cualquier escritura fugada lanza nombrando el slot (guardia.ts);
 * con `false` la vista es el propio mundo (coste cero) y este runner solo valida la emisión.
 */
export function ejecutarFaseB(
  world: World, actorSlot: number,
  decidir: (vista: World) => Iterable<Intent> | Intent | null | undefined,
): Intent[] {
  enteroSeguro(actorSlot, 'actorSlot');
  if (actorSlot < 0) throw new RangeError('actorSlot debe ser >= 0.');
  return withReadOnlyDecisionGuard(world, actorSlot, vista => recogerIntentos(decidir(vista), actorSlot));
}

/** Como `ejecutarFaseB` pero sobre un estado sintético: siempre pasa por el proxy de T148. */
export function ejecutarFaseBGenerica<T extends object>(
  estado: T, actorSlot: number,
  decidir: (vista: T) => Iterable<Intent> | Intent | null | undefined,
): Intent[] {
  enteroSeguro(actorSlot, 'actorSlot');
  if (actorSlot < 0) throw new RangeError('actorSlot debe ser >= 0.');
  const vista = createDecisionReadOnlyProxy(estado, actorSlot);
  return recogerIntentos(decidir(vista), actorSlot);
}
