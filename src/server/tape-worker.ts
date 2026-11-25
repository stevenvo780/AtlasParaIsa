import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CINTA, type Apertura, type Corte, type Hito, type SeriePunto } from '../shared/cinta.js';
import { CONTROL_ENLACE_BYTES, RANURA_F64, enlaceCinta, type DescriptorEnlace, type EnlaceCinta } from '../shared/fotograma.js';
import type { WorldView } from '../shared/types.js';
import { EscritorCinta, PASO_MAXIMO, type OpcionesEscritor } from './cinta/escritor.js';
import { estadoVista, fotogramaAVista, leerFotograma, type EstadoVista } from './cinta/vista.js';

/** V24: the costly, slow-moving summaries of a view (each walks every tile or a whole catalogue). A turbo
 * frame between two live mirror posts may leave them out: this writer carries the previous frame's values,
 * so they (and the terrain) are SAMPLED at the mirror's cadence, ≤ `TURBO_MIRROR_MS` of wall time behind.
 * What must agree with the people of the same tick — communities, demography (deaths), places and
 * memories — is projected on every frame and never carried. */
export const CARRIED_VIEW_FIELDS = ['blueprints', 'stats', 'technology', 'organization', 'chemistry'] as const;
const carriedFields: ReadonlySet<string> = new Set(CARRIED_VIEW_FIELDS);
/** A carried frame completed with the previous frame's summaries, in the previous frame's key order. */
export function withCarriedFields(view: WorldView, previous: WorldView): WorldView {
  const current = view as unknown as Record<string, unknown>, before = previous as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(before)) {
    if (carriedFields.has(key)) out[key] = before[key];
    else if (key in current) out[key] = current[key];
  }
  for (const key of Object.keys(current)) if (!(key in out)) out[key] = current[key];
  return out as unknown as WorldView;
}

const CREDITOS_CORTES = 16;
const FLUSH_MS = 1000;
const SONDEO_RANURAS_MS = 2;

export function crearEnlaceCortes(): DescriptorEnlace {
  // En ola 1 el crédito corresponde a un Corte en vuelo por el puerto. M6 añade las ranuras binarias.
  const descriptor = { control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES), ranuras: [], sucesos: null };
  const enlace = enlaceCinta(descriptor);
  Atomics.store(enlace.creditos, 0, CREDITOS_CORTES);
  Atomics.store(enlace.cadencia, 0, CINTA.pasos[0]);
  return descriptor;
}

export function ajustarCadencia(enlace: EnlaceCinta, leidos: bigint, ahora: number, ultimoAtraso: number): number {
  const paso = Atomics.load(enlace.cadencia, 0);
  const atraso = Atomics.load(enlace.entregados, 0) - leidos;
  const umbral = enlace.ranuras.length ? Math.max(1, Math.min(8, Math.floor(enlace.ranuras.length / 2))) : 8;
  if (atraso > BigInt(umbral)) {
    Atomics.store(enlace.cadencia, 0, Math.min(PASO_MAXIMO, paso * 2));
    return ahora;
  }
  if (atraso === 0n && ahora - ultimoAtraso >= 2000 && paso > CINTA.pasos[0]) {
    Atomics.store(enlace.cadencia, 0, Math.max(CINTA.pasos[0], paso / 2));
    return ahora;
  }
  return ultimoAtraso;
}

export type TapeWorkerRequest = { type: 'abrir'; apertura: Apertura; hitosPrevios: readonly Hito[] } | { type: 'corte'; corte: Corte }
  | { type: 'serie'; epoca: number; punto: SeriePunto }
  | { type: 'flush' | 'close'; id: number };
export type TapeWorkerReply = { type: 'reply'; id: number; frames: number; latestTick: number; error?: string };
export type TapeWorkerStatus = { type: 'estado'; estado: 'ok'; epoca: number }
  | { type: 'estado'; estado: 'error'; motivo: string; reiniciarEnlace: boolean };
export type TapeWorkerMessage = TapeWorkerReply | TapeWorkerStatus;

if (!isMainThread && workerData?.role === 'carta-tape') {
  const port = parentPort!;
  const opciones = workerData.options as OpcionesEscritor;
  const enlace = enlaceCinta(workerData.descriptor as DescriptorEnlace);
  const cabeceras = enlace.ranuras.map(r => new Float64Array(r, 0, RANURA_F64.sucesosHasta + 1));
  let escritor: EscritorCinta | undefined;
  let apertura: Apertura | undefined;
  let vista: EstadoVista | undefined;
  let ultimoError: string | undefined;
  let enlaceRoto = false;
  let cerrado = false;
  let previoBinario = -1;
  let leidos = 0n;
  let ultimoAtraso = performance.now();
  let sondeo: NodeJS.Timeout | undefined;
  let desahogo: NodeJS.Immediate | undefined;

  function fallar(error: unknown): void {
    try { escritor?.close(false); } catch { /* conserva el fallo original de la cinta */ }
    escritor = undefined;
    vista = undefined;
    ultimoError = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'estado', estado: 'error', motivo: ultimoError,
      reiniciarEnlace: enlaceRoto } satisfies TapeWorkerStatus);
  }

  function ejecutar(accion: () => void): void {
    try { accion(); } catch (error) { fallar(error); }
  }

  function leerRanuras(): boolean {
    if (!apertura || enlaceRoto) return false;
    const actual = apertura;
    const hasta = Atomics.load(enlace.entregados, 0);
    let avance = false;
    while (leidos < hasta) {
      const i = Number(leidos % BigInt(cabeceras.length));
      // El mensaje de apertura y el SAB usan canales distintos: una base nueva puede llegar primero al SAB.
      if (escritor && cabeceras[i]![RANURA_F64.epoca]! > actual.epoca) break;
      ultimoAtraso = ajustarCadencia(enlace, leidos, performance.now(), ultimoAtraso);
      try {
        const disponible = leerFotograma(enlace, leidos, (f, sucesos) => ejecutar(() => {
          if (!escritor || f.epoca !== actual.epoca || f.tick < actual.tMundo) return;
          if (!vista && !f.completo) return;
          if (f.completo) vista = estadoVista(f.epoca);
          const corte = fotogramaAVista(vista!, f, sucesos, Number(leidos + 1n));
          if (previoBinario >= 0 && f.completo) corte.tilesCambiadas = corte.vista.tiles;
          if (previoBinario >= 0 && f.saltados && corte.t - previoBinario <= PASO_MAXIMO) {
            corte.hitos.push({ t: corte.t, importancia: 1, tipo: 'laguna', laguna: { t0: previoBinario, t1: corte.t } });
          }
          escritor.registrar(corte, false);
          previoBinario = corte.t;
        }));
        if (!disponible) break;
      } catch (error) {
        // Si falla el protocolo del anillo, el productor necesita un enlace nuevo, incluso si el escritor se reabre.
        enlaceRoto = true;
        fallar(error);
        break;
      }
      leidos++;
      avance = true;
    }
    return avance;
  }

  function bucle(): void {
    if (cerrado || enlaceRoto) return;
    if (leerRanuras()) desahogo = setImmediate(bucle);
    else sondeo = setTimeout(bucle, SONDEO_RANURAS_MS);
  }
  if (cabeceras.length) bucle();
  const timer = setInterval(() => ejecutar(() => {
    escritor?.flush();
    ultimoAtraso = ajustarCadencia(enlace, leidos, performance.now(), ultimoAtraso);
  }), FLUSH_MS);

  port.on('message', (message: TapeWorkerRequest) => ejecutar(() => {
    if (message.type === 'abrir') {
      if (enlaceRoto) throw new Error('La cinta binaria necesita un enlace nuevo.');
      if (cabeceras.length && escritor) leerRanuras();
      if (enlaceRoto) return;
      apertura = message.apertura;
      const hitosPrevios = escritor ? message.hitosPrevios : [];
      escritor ??= new EscritorCinta(opciones);
      const epoca = escritor.abrir(apertura, hitosPrevios);
      previoBinario = -1;
      vista = undefined;
      ultimoError = undefined;
      Atomics.store(enlace.cadencia, 0, CINTA.pasos[0]);
      if (cabeceras.length) Atomics.store(enlace.pedirCompleto, 0, 1);
      ultimoAtraso = performance.now();
      port.postMessage({ type: 'estado', estado: 'ok', epoca } satisfies TapeWorkerStatus);
    } else if (message.type === 'corte') {
      if (cabeceras.length) throw new Error('Un enlace por ranuras no acepta cortes por el puerto.');
      ultimoAtraso = ajustarCadencia(enlace, leidos, performance.now(), ultimoAtraso);
      try { escritor?.registrar(message.corte); }
      finally { leidos++; Atomics.add(enlace.creditos, 0, 1); }
    } else if (message.type === 'serie') {
      escritor?.registrarSerie(message.epoca, message.punto);
    } else {
      try {
        let estado = { frames: 0, latestTick: -1 };
        ejecutar(() => {
          if (cabeceras.length) leerRanuras();
          if (escritor) { escritor.flush(); estado = escritor.estado(); }
        });
        const respuesta: TapeWorkerReply = { type: 'reply', id: message.id, ...estado,
          ...(ultimoError === undefined ? {} : { error: ultimoError }) };
        port.postMessage(respuesta);
      } finally {
        if (message.type === 'close') {
          cerrado = true;
          clearTimeout(sondeo);
          clearImmediate(desahogo);
          clearInterval(timer);
          try { escritor?.close(false); } finally { escritor = undefined; port.close(); }
        }
      }
    }
  }));
}
