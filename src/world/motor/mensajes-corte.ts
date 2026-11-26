import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { LegacyRecord } from '../../shared/demography.js';
import type { World } from '../mundo/tipos.js';
import { abrirLectorBasePesos, type DescriptorBasePesosCorte } from './base-pesos-corte.js';
import type { TokenLegadoCorte } from './custodia-legado.js';
import { prepararFaunaCorte, prepararFaunaDirecta, recibirFaunaDirecta, validarFaunaCorte, vincularFaunaCorte,
  type BloqueFaunaCorte } from './fauna-corte.js';
import type { ParteFotoDueno } from './fotograma-dueno.js';
import { prepararPersonasDirectas, recibirPersonasDirectas, RechazoBasePesosError,
  type BasePesosActiva, type BloquePersonasCorte } from './personas-corte.js';
import { parteCorteDe, type ParteMundo } from './reunir.js';
import { prepararTeselasDirectas, recibirTeselasDirectas, type BloqueTeselasCorte } from './teselas-corte.js';

export type SolicitudCorte = BigUint64Array<SharedArrayBuffer>;
const SOLICITUD = 0, PREPARAR_FAUNA = 1, PREPARAR_TESELAS = 2, PREPARAR_PERSONAS = 3, COMPROBAR_SOLAPE = 4;
const CUSTODIA_SOLICITUD = 5, CUSTODIA_EPOCA = 6, CUSTODIA_TICK = 7, USAR_BASE_PESOS = 8;
const SIN_FAUNA = 0n, FAUNA_SOMBRA = 1n, FAUNA_DIRECTA = 2n;

interface ParteCorte {
  solicitud: bigint;
  epoca: number;
  tick: number;
  dueno: number;
  bytes: Uint8Array;
  fauna?: readonly BloqueFaunaCorte[];
  faunaSustituida?: { cantidad: number } | null;
  teselas?: readonly BloqueTeselasCorte[];
  teselasSustituidas?: { cantidad: number } | null;
  personas?: readonly BloquePersonasCorte[];
  personasSustituidas?: { cantidad: number } | null;
  preparacionPersonasMs?: number;
  legadoSolape?: readonly LegacyRecord[];
}

/** Sobres ordenados por dueño que ya salieron de los puertos de una solicitud. */
export interface CorteRemotoBinario {
  readonly solicitud: bigint;
  readonly epoca: number;
  readonly tick: number;
  readonly modoFauna: bigint;
  readonly teselasDirectas: boolean;
  readonly personasDirectas: boolean;
  readonly duenosRemotos: number;
  readonly sobres: ParteCorte[];
}

interface DiagnosticoTeselasCorte {
  bytesV8: number; v8Ms: number; bytesTuplas: number; tuplasMs: number; duenosTuplas: number; duenosV8: number;
}

export interface DiagnosticoPersonasCorte {
  bytesV8: number; v8Ms: number; bytesFilas: number; filasMs: number; duenosFilas: number; duenosV8: number;
  bytesCuerpo: number; bytesPesos: number; bytesRefs: number; personasRef: number; personasFull: number;
  preparacionMaxMs: number; preparacionSumaMs: number;
}

interface MensajeBasePesos {
  tipo: 'basePesos';
  descriptor: DescriptorBasePesosCorte | undefined;
}

interface FotoTransferida {
  tipo: 'foto';
  epoca: number;
  parte: ParteFotoDueno;
}

function ocupaSuBuffer(bytes: unknown): bytes is Uint8Array<ArrayBuffer> {
  return bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
}

function vistaOcupaSuBuffer(vista: unknown): vista is (Uint8Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) {
  return (vista instanceof Uint8Array || vista instanceof Uint32Array)
    && vista.buffer instanceof ArrayBuffer
    && vista.byteOffset === 0 && vista.byteLength === vista.buffer.byteLength;
}

function agregarTransferibles(parte: ParteCorte, transferibles: Set<ArrayBuffer>): void {
  const agregar = (bytes: Uint8Array | Uint32Array): void => {
    if (!vistaOcupaSuBuffer(bytes)) throw new Error('Cada bloque del corte debe ocupar su propio ArrayBuffer.');
    if (bytes.byteLength === 0) return;
    if (transferibles.has(bytes.buffer)) throw new Error('Buffer repetido en el corte.');
    transferibles.add(bytes.buffer);
  };
  agregar(parte.bytes);
  for (const bloques of [parte.fauna, parte.teselas, parte.personas]) {
    if (bloques) for (const { cuerpo } of bloques) agregar(cuerpo);
  }
  if (parte.personas) {
    for (const bloque of parte.personas) {
      agregar(bloque.pesos);
      if (bloque.refs) agregar(bloque.refs.pares);
    }
  }
}

/** Esta lista permite mover los bloques a otro hilo antes de consumir el corte. */
export function transferiblesCorteRemoto(corte: CorteRemotoBinario): ArrayBuffer[] {
  const transferibles = new Set<ArrayBuffer>();
  for (const sobre of corte.sobres) agregarTransferibles(sobre, transferibles);
  return [...transferibles];
}

function comprobarIdentidad(parte: ParteCorte | undefined, corte: CorteRemotoBinario, dueno: number): asserts parte is ParteCorte {
  if (!parte || parte.dueno !== dueno || parte.solicitud !== corte.solicitud || parte.epoca !== corte.epoca || parte.tick !== corte.tick
    || !ocupaSuBuffer(parte.bytes) || parte.bytes.byteLength === 0)
    throw new Error(`Instantánea incompleta o incoherente para el dueño ${dueno}.`);
}

const MARCAS_DIRECTAS = {
  fauna: { clave: 'faunaSustituida', error: 'Fauna directa inválida' },
  teselas: { clave: 'teselasSustituidas', error: 'Teselas directas inválidas' },
  personas: { clave: 'personasSustituidas', error: 'Personas directas inválidas' },
} as const;

function comprobarMarca(parte: ParteCorte, campo: keyof typeof MARCAS_DIRECTAS, directa: boolean, sombra = false): void {
  const { clave, error } = MARCAS_DIRECTAS[campo];
  const hayBloques = Object.hasOwn(parte, campo);
  if (!directa) {
    if (Object.hasOwn(parte, clave) || hayBloques && !sombra)
      throw new Error(`Modo de ${campo} incoherente para el dueño ${parte.dueno}.`);
    return;
  }
  const marca = parte[clave];
  if (marca === null && !hayBloques) return;
  if (marca && typeof marca === 'object' && Number.isSafeInteger(marca.cantidad)
    && marca.cantidad >= 0 && marca.cantidad <= 0xffff_ffff && Array.isArray(parte[campo])) return;
  throw new Error(`${error} para el dueño ${parte.dueno}.`);
}

export function enviarParteFoto(puerto: MessagePort, epoca: number, parte: ParteFotoDueno): void {
  const bloques = new Set<ArrayBuffer>();
  for (const grupo of [parte.bajasBloques, parte.altasBloques]) {
    for (const bytes of grupo) {
      if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength)
        throw new Error('El bloque de fotograma debe ocupar su propio ArrayBuffer.');
      bloques.add(bytes.buffer);
    }
  }
  const entrega: FotoTransferida = { tipo: 'foto', epoca, parte };
  puerto.postMessage(entrega, [...bloques]);
}

/** Drena los avisos de base F64 enviados por el coordinador en la dirección de confianza del puerto. */
export function recibirBasePesosEnDueno(
  puerto: MessagePort,
  actual: BasePesosActiva | undefined,
  epoca: number,
): BasePesosActiva | undefined {
  let vigente = actual;
  for (let entrega = receiveMessageOnPort(puerto); entrega !== undefined; entrega = receiveMessageOnPort(puerto)) {
    const mensaje = entrega.message as Partial<MensajeBasePesos> | undefined;
    if (mensaje?.tipo !== 'basePesos') continue;
    const descriptor = mensaje.descriptor;
    if (descriptor === undefined) {
      vigente = undefined;
      continue;
    }
    try {
      if (descriptor.epoca !== epoca) {
        vigente = undefined;
        continue;
      }
      const lector = abrirLectorBasePesos(descriptor);
      vigente = lector.estaPublicada()
        ? {
          lector,
          contexto: {
            instancia: descriptor.instancia,
            epoca: descriptor.epoca,
            secuencia: descriptor.secuencia,
            publicacion: descriptor.publicacion,
          },
        }
        : undefined;
    } catch {
      vigente = undefined;
    }
  }
  if (vigente && (vigente.contexto.epoca !== epoca || !vigente.lector.estaPublicada())) return undefined;
  return vigente;
}

/** Se transfiere el bloque de V8 tal cual. Un runtime que no lo pueda mover falla antes de construir el corte. */
export function enviarParteCorte(puerto: MessagePort, solicitud: SolicitudCorte, epoca: number, dueno: number, mundo: World,
  legadoSolape?: (token: TokenLegadoCorte) => readonly LegacyRecord[] | undefined,
  basePesos?: BasePesosActiva): void {
  const contenido = parteCorteDe(mundo);
  const modo = Atomics.load(solicitud, PREPARAR_FAUNA);
  const fauna = modo === FAUNA_DIRECTA ? prepararFaunaDirecta(contenido) : undefined;
  const pideTeselas = Atomics.load(solicitud, PREPARAR_TESELAS) === 1n;
  const teselas = pideTeselas ? prepararTeselasDirectas(contenido) : undefined;
  const pidePersonas = Atomics.load(solicitud, PREPARAR_PERSONAS) === 1n;
  const usaBasePesos = pidePersonas && Atomics.load(solicitud, USAR_BASE_PESOS) === 1n;
  const inicioPersonas = pidePersonas ? performance.now() : 0;
  const personas = pidePersonas ? prepararPersonasDirectas(contenido, usaBasePesos ? basePesos : undefined) : undefined;
  const preparacionPersonasMs = pidePersonas ? performance.now() - inicioPersonas : undefined;
  const reducido = fauna || teselas || personas
    ? { ...contenido, ...(fauna && { animals: [] }), ...(teselas && { tiles: [] }), ...(personas && { people: [] }) } : contenido;
  const bytes = serialize(reducido), buffer = bytes.buffer;
  if (!(buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== buffer.byteLength)
    throw new Error('V8 no entregó un bloque de corte transferible entero.');
  const parte: ParteCorte = { solicitud: Atomics.load(solicitud, SOLICITUD), epoca, tick: mundo.tick, dueno, bytes };
  if (Atomics.load(solicitud, COMPROBAR_SOLAPE) === 1n) {
    const registros = legadoSolape?.({ solicitud: parte.solicitud, epoca, tick: parte.tick });
    if (registros) parte.legadoSolape = registros;
  }
  if (modo === FAUNA_DIRECTA) parte.faunaSustituida = fauna ? { cantidad: fauna.reduce((n, bloque) => n + bloque.filas, 0) } : null;
  if (fauna) parte.fauna = fauna;
  if (modo === FAUNA_SOMBRA) parte.fauna = prepararFaunaCorte(contenido.animals);
  if (pideTeselas) parte.teselasSustituidas = teselas ? { cantidad: teselas.reduce((n, bloque) => n + bloque.filas, 0) } : null;
  if (teselas) parte.teselas = teselas;
  if (pidePersonas) {
    parte.personasSustituidas = personas ? { cantidad: personas.reduce((n, bloque) => n + bloque.filas, 0) } : null;
    parte.preparacionPersonasMs = preparacionPersonasMs;
  }
  if (personas) parte.personas = personas;
  const transferibles = new Set<ArrayBuffer>();
  agregarTransferibles(parte, transferibles);
  puerto.postMessage(parte, [...transferibles]);
  for (const bloque of transferibles) if (bloque.byteLength !== 0) throw new Error('Un bloque de corte no se desprendió al enviarlo.');
}

/** Consume el corte retirado y libera cada sobre al decodificarlo. Los pesos verificados conservan sus buffers. */
export function decodificarCorteRemoto(corte: CorteRemotoBinario, basePesos?: BasePesosActiva): {
  partes: ParteMundo[];
  diagnosticoTeselasCorte: DiagnosticoTeselasCorte | undefined;
  diagnosticoPersonasCorte: DiagnosticoPersonasCorte | undefined;
} {
  if (corte.sobres.length !== corte.duenosRemotos) throw new Error('El corte remoto está incompleto o ya fue consumido.');
  const { modoFauna: modo, tick } = corte;
  const datos: DiagnosticoTeselasCorte | undefined = corte.teselasDirectas
    ? { bytesV8: 0, v8Ms: 0, bytesTuplas: 0, tuplasMs: 0, duenosTuplas: 0, duenosV8: 0 } : undefined;
  const datosPersonas: DiagnosticoPersonasCorte | undefined = corte.personasDirectas
    ? { bytesV8: 0, v8Ms: 0, bytesFilas: 0, filasMs: 0, duenosFilas: 0, duenosV8: 0,
      bytesCuerpo: 0, bytesPesos: 0, bytesRefs: 0, personasRef: 0, personasFull: 0,
      preparacionMaxMs: 0, preparacionSumaMs: 0 } : undefined;
  const decodificar = (parte: ParteCorte | undefined, dueno: number): ParteMundo => {
    comprobarIdentidad(parte, corte, dueno);
    const inicioV8 = datos || datosPersonas ? performance.now() : 0;
    const contenido = deserialize(parte.bytes) as ParteMundo;
    const v8Ms = datos || datosPersonas ? performance.now() - inicioV8 : 0;
    if (contenido.tick !== tick) throw new Error(`El mundo del dueño ${dueno} no pertenece al tick del corte.`);
    if (parte.legadoSolape !== undefined && !isDeepStrictEqual(parte.legadoSolape, contenido.retiredLegacy))
      throw new Error(`El legado del sobre no coincide con el del corte del dueño ${dueno}.`);
    if (datos) {
      datos.bytesV8 += parte.bytes.byteLength;
      datos.v8Ms += v8Ms;
      const sustituidas = parte.teselasSustituidas;
      try {
        if (!Array.isArray(contenido.tiles)) throw new Error('Falta el array de teselas en V8.');
        if (sustituidas === null && !Object.hasOwn(parte, 'teselas')) datos.duenosV8++;
        else {
          if (!sustituidas || typeof sustituidas !== 'object' || contenido.tiles.length !== 0
            || Object.keys(contenido.tiles).length !== 0 || !Array.isArray(parte.teselas))
            throw new Error('Sobre de teselas directas incoherente.');
          const inicioTuplas = performance.now();
          contenido.tiles = recibirTeselasDirectas(parte.teselas, sustituidas.cantidad);
          datos.tuplasMs += performance.now() - inicioTuplas;
          datos.bytesTuplas += parte.teselas.reduce((n, bloque) => n + bloque.cuerpo.byteLength, 0);
          datos.duenosTuplas++;
        }
      } catch (error) {
        throw new Error(`Teselas directas inválidas para el dueño ${dueno}.`, { cause: error });
      }
    } else if (Object.hasOwn(parte, 'teselasSustituidas') || Object.hasOwn(parte, 'teselas')) {
      throw new Error(`Modo de teselas incoherente para el dueño ${dueno}.`);
    }
    if (datosPersonas) {
      datosPersonas.bytesV8 += parte.bytes.byteLength;
      datosPersonas.v8Ms += v8Ms;
      const preparacionMs = parte.preparacionPersonasMs;
      if (typeof preparacionMs === 'number' && Number.isFinite(preparacionMs) && preparacionMs >= 0) {
        datosPersonas.preparacionMaxMs = Math.max(datosPersonas.preparacionMaxMs, preparacionMs);
        datosPersonas.preparacionSumaMs += preparacionMs;
      }
      const sustituidas = parte.personasSustituidas;
      try {
        if (!Array.isArray(contenido.people)) throw new Error('Falta el array de personas en V8.');
        if (sustituidas === null && !Object.hasOwn(parte, 'personas')) datosPersonas.duenosV8++;
        else {
          if (!sustituidas || typeof sustituidas !== 'object' || contenido.people.length !== 0
            || Object.keys(contenido.people).length !== 0 || !Array.isArray(parte.personas))
            throw new Error('Sobre de personas directas incoherente.');
          let bytesCuerpo = 0, bytesPesos = 0, bytesRefs = 0;
          for (const bloque of parte.personas) {
            bytesCuerpo += bloque.cuerpo.byteLength;
            bytesPesos += bloque.pesos.byteLength;
            if (bloque.refs) bytesRefs += bloque.refs.pares.byteLength;
          }
          const inicioFilas = performance.now();
          contenido.people = recibirPersonasDirectas(parte.personas, sustituidas.cantidad,
            { transferirCuerpo: true, transferirPesos: true, basePesos, diagnostico: datosPersonas });
          datosPersonas.filasMs += performance.now() - inicioFilas;
          datosPersonas.bytesCuerpo += bytesCuerpo;
          datosPersonas.bytesPesos += bytesPesos;
          datosPersonas.bytesRefs += bytesRefs;
          datosPersonas.bytesFilas += bytesCuerpo + bytesPesos + bytesRefs;
          datosPersonas.duenosFilas++;
        }
      } catch (error) {
        if (error instanceof RechazoBasePesosError) throw error;
        throw new Error(`Personas directas inválidas para el dueño ${dueno}.`, { cause: error });
      }
    } else if (Object.hasOwn(parte, 'personasSustituidas') || Object.hasOwn(parte, 'personas')) {
      throw new Error(`Modo de personas incoherente para el dueño ${dueno}.`);
    }
    if (modo === FAUNA_DIRECTA) {
      const sustituida = parte.faunaSustituida;
      try {
        if (!Array.isArray(contenido.animals)) throw new Error('Falta el array de fauna en V8.');
        if (sustituida === null && !Object.hasOwn(parte, 'fauna')) return contenido;
        if (!sustituida || typeof sustituida !== 'object' || contenido.animals.length !== 0
          || Object.keys(contenido.animals).length !== 0 || !Array.isArray(parte.fauna))
          throw new Error('Sobre de fauna directa incoherente.');
        contenido.animals = recibirFaunaDirecta(parte.fauna, sustituida.cantidad);
        return contenido;
      } catch (error) {
        throw new Error(`Fauna directa inválida para el dueño ${dueno}.`, { cause: error });
      }
    }
    if (Object.hasOwn(parte, 'faunaSustituida')) throw new Error(`Modo de fauna incoherente para el dueño ${dueno}.`);
    // Si falta la optimización, el guardado conserva las filas canónicas de este dueño.
    const bloques = modo === FAUNA_SOMBRA ? parte.fauna : undefined;
    if (Array.isArray(bloques) && bloques.length && Array.isArray(contenido.animals)
      && validarFaunaCorte(bloques, contenido.animals.length)) {
      vincularFaunaCorte(contenido.animals, [{ desde: 0, bloques }]);
    }
    return contenido;
  };
  const partes: ParteMundo[] = [];
  const sobres = corte.sobres.reverse();
  try {
    while (sobres.length) partes.push(decodificar(sobres.pop(), partes.length + 1));
  } finally { sobres.length = 0; }
  return { partes, diagnosticoTeselasCorte: datos, diagnosticoPersonasCorte: datosPersonas };
}

/** Identidad de la operación de custodia, independiente de la última reunión o vista solicitada. */
export function leerCustodiaLegado(memoria: SolicitudCorte): TokenLegadoCorte {
  return { solicitud: Atomics.load(memoria, CUSTODIA_SOLICITUD), epoca: Number(Atomics.load(memoria, CUSTODIA_EPOCA)),
    tick: Number(Atomics.load(memoria, CUSTODIA_TICK)) };
}

/** Un canal por dueño remoto, nuevo en cada apertura. Solo se elige F0 antes de abrir la piscina. */
export class CanalesCorte {
  readonly solicitud = new BigUint64Array(new SharedArrayBuffer(9 * BigUint64Array.BYTES_PER_ELEMENT));
  private readonly entradas: MessagePort[] = [];
  readonly puertosRemotos: MessagePort[] = [];
  private ultimaRecepcionTeselas?: DiagnosticoTeselasCorte;
  private ultimaRecepcionPersonas?: DiagnosticoPersonasCorte;

  get diagnosticoTeselasCorte(): Readonly<DiagnosticoTeselasCorte> | undefined {
    return this.ultimaRecepcionTeselas;
  }

  get diagnosticoPersonasCorte(): Readonly<DiagnosticoPersonasCorte> | undefined {
    return this.ultimaRecepcionPersonas;
  }

  private constructor() {}

  static abrir(remotos: number): CanalesCorte | undefined {
    const canales = new CanalesCorte();
    try {
      for (let i = 0; i < remotos; i++) {
        const { port1, port2 } = new MessageChannel();
        canales.entradas.push(port1);
        canales.puertosRemotos.push(port2);
        port1.unref();
      }
      return canales;
    } catch {
      canales.cerrar();
      return undefined;
    }
  }

  pedir(prepararFauna: boolean | 'directa' = false, prepararTeselas = false, prepararPersonas = false,
    comprobarSolape = false, usarBasePesos = false): bigint {
    Atomics.store(this.solicitud, PREPARAR_FAUNA, prepararFauna === 'directa' ? FAUNA_DIRECTA : prepararFauna ? FAUNA_SOMBRA : SIN_FAUNA);
    Atomics.store(this.solicitud, PREPARAR_TESELAS, prepararTeselas ? 1n : 0n);
    Atomics.store(this.solicitud, PREPARAR_PERSONAS, prepararPersonas ? 1n : 0n);
    Atomics.store(this.solicitud, COMPROBAR_SOLAPE, comprobarSolape ? 1n : 0n);
    Atomics.store(this.solicitud, USAR_BASE_PESOS, usarBasePesos ? 1n : 0n);
    return BigInt.asUintN(64, Atomics.add(this.solicitud, SOLICITUD, 1n) + 1n);
  }

  /** Publica o retira el descriptor de la base F64 compartida hacia los dueños remotos por el canal de confianza. */
  publicarBasePesos(descriptor: DescriptorBasePesosCorte | undefined): void {
    const mensaje: MensajeBasePesos = { tipo: 'basePesos', descriptor };
    for (const puerto of this.entradas) puerto.postMessage(mensaje);
  }

  fijarCustodiaLegado(token: TokenLegadoCorte): void {
    Atomics.store(this.solicitud, CUSTODIA_SOLICITUD, token.solicitud);
    Atomics.store(this.solicitud, CUSTODIA_EPOCA, BigInt(token.epoca));
    Atomics.store(this.solicitud, CUSTODIA_TICK, BigInt(token.tick));
  }

  /** Los dueños ya pasaron la barrera de reunión. Retira un sobre por puerto. */
  retirarCorte(solicitud: bigint, epoca: number, tick: number): CorteRemotoBinario {
    if (solicitud !== Atomics.load(this.solicitud, SOLICITUD)) throw new Error('La solicitud del corte ya no está vigente.');
    const sobres: ParteCorte[] = [];
    const corte: CorteRemotoBinario = {
      solicitud, epoca, tick, sobres, duenosRemotos: this.entradas.length,
      modoFauna: Atomics.load(this.solicitud, PREPARAR_FAUNA),
      teselasDirectas: Atomics.load(this.solicitud, PREPARAR_TESELAS) === 1n,
      personasDirectas: Atomics.load(this.solicitud, PREPARAR_PERSONAS) === 1n,
    };
    for (const [i, puerto] of this.entradas.entries()) {
      const dueno = i + 1;
      const parte = receiveMessageOnPort(puerto)?.message as ParteCorte | undefined;
      if (receiveMessageOnPort(puerto) !== undefined)
        throw new Error(`Instantánea incompleta o incoherente para el dueño ${dueno}.`);
      comprobarIdentidad(parte, corte, dueno);
      const sombra = corte.modoFauna === FAUNA_SOMBRA;
      comprobarMarca(parte, 'fauna', corte.modoFauna === FAUNA_DIRECTA, sombra);
      comprobarMarca(parte, 'teselas', corte.teselasDirectas);
      comprobarMarca(parte, 'personas', corte.personasDirectas);
      if (parte.legadoSolape !== undefined && (!Array.isArray(parte.legadoSolape) || Atomics.load(this.solicitud, COMPROBAR_SOLAPE) !== 1n))
        throw new Error(`Sobre de legado incoherente para el dueño ${dueno}.`);
      // Las filas de sombra son opcionales: si son inválidas se conserva el V8 canónico.
      if (sombra && (!Array.isArray(parte.fauna) || !parte.fauna.every(b => ocupaSuBuffer(b?.cuerpo)))) delete parte.fauna;
      sobres.push(parte);
    }
    return corte;
  }

  recibir(solicitud: bigint, epoca: number, tick: number): ParteMundo[] {
    this.ultimaRecepcionTeselas = undefined;
    this.ultimaRecepcionPersonas = undefined;
    const resultado = decodificarCorteRemoto(this.retirarCorte(solicitud, epoca, tick));
    this.ultimaRecepcionTeselas = resultado.diagnosticoTeselasCorte;
    this.ultimaRecepcionPersonas = resultado.diagnosticoPersonasCorte;
    return resultado.partes;
  }

  /** F6 ya terminó y el coordinador aún no puede pedir otro corte. Un dueño sin parte provoca el camino reunido. */
  recibirFotos(epoca: number, tick: number): ParteFotoDueno[] {
    const partes: ParteFotoDueno[] = [];
    for (const [i, puerto] of this.entradas.entries()) {
      const entrega = receiveMessageOnPort(puerto)?.message as FotoTransferida | undefined;
      let repetida = false;
      while (receiveMessageOnPort(puerto) !== undefined) repetida = true;
      if (repetida || entrega?.tipo !== 'foto' || entrega.epoca !== epoca || entrega.parte?.tick !== tick
        || entrega.parte.hilo !== i + 1 || !Array.isArray(entrega.parte.bajasBloques)
        || !Array.isArray(entrega.parte.altasBloques)
        || !entrega.parte.bajasBloques.every(b => b instanceof Uint8Array)
        || !entrega.parte.altasBloques.every(b => b instanceof Uint8Array)) continue;
      partes.push(entrega.parte);
    }
    return partes;
  }

  cerrar(): void {
    for (const puerto of this.entradas) puerto.close();
    for (const puerto of this.puertosRemotos) puerto.close();
  }
}
