import { isDeepStrictEqual, types } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import type { LegacyRecord } from '../../shared/demography.js';
import type { Tile } from '../../shared/types.js';
import { syncFauna } from '../animals.js';
import { pruneBonds } from '../lineage.js';
import type { MateriaCheckpoint } from '../materia/tipos.js';
import type { Person, World, WorldContext } from '../mundo/tipos.js';
import { paramsOf, setParams, type WorldParams } from '../params.js';
import { residentBackingArray } from '../soa/topologia.js';
import { bindWorldContext } from '../spatial.js';
import { recordSample } from '../statistics.js';
import type { Migrante } from './contexto.js';
import type { TipoId } from './contadores.js';
import { TipoIntento, type Instantanea, type Intento } from './contratos.js';
import { crearCorteGuardado } from './corte-sellado.js';
import { faunaCorteDe, faunaVerificadaDe, vincularFaunaCorte, vincularFaunaVerificada,
  type TramoFaunaCorte, type TramoFaunaVerificada } from './fauna-corte.js';
import { decodificarCorteRemoto, transferiblesCorteRemoto, type CorteRemotoBinario } from './mensajes-corte.js';
import { personasVerificadasDe, vincularPersonasVerificadas, type TramoPersonasVerificadas } from './personas-corte.js';
import { baseReunionDe, reunir, sinCheckpointTecnologia, type BaseReunion, type ParteMundo } from './reunir.js';
import { teselasVerificadasDe, vincularTeselasVerificadas, type TramoTeselasVerificadas } from './teselas-corte.js';

export interface IdentidadCorteTransferido {
  readonly solicitud: bigint;
  readonly epoca: number;
  readonly tick: number;
  readonly eventCounter: number;
}

export interface OpcionesReunionCorte {
  readonly prepararFauna: boolean | 'directa';
  readonly prepararTeselas: boolean;
  readonly prepararPersonas: boolean;
}

interface DatosLocales {
  readonly coordinador: World;
  readonly cabecera: BaseReunion;
  readonly siguientes: Record<TipoId, number>;
  readonly params: WorldParams;
  readonly bajasPrevias: readonly LegacyRecord[];
}

export interface CorteTransferido extends IdentidadCorteTransferido {
  readonly local: Uint8Array;
  readonly remoto: CorteRemotoBinario;
  readonly migrantes: readonly Uint8Array[];
  readonly materia: MateriaCheckpoint | null;
  readonly opciones: OpcionesReunionCorte;
  readonly comprobarTecnologia: boolean;
}

export interface CapturaCorteTransferido {
  readonly corte: CorteTransferido;
  readonly transferibles: ArrayBuffer[];
}

/** Recibo del persistidor tras COMMIT, limitado a lo necesario para confirmar el estado vivo. */
export interface AcuseCorteTransferido extends IdentidadCorteTransferido {
  readonly guardadoEn: number;
  readonly snapshotBytes: number;
  readonly cronica: World['chronicleJournal'];
  readonly historia: World['history'];
  readonly tecnologia: World['technology'];
  readonly tecnologiaRemotaEquivalente: boolean;
  readonly bajas: LegacyRecord[];
}

export function migrantesDelCorte(pendientes: readonly Intento[]): Uint8Array[] {
  const migrantes: Uint8Array[] = [];
  for (const intento of pendientes) {
    if (intento.tipo !== TipoIntento.Migrante) continue;
    if (!intento.bytes) throw new Error('El corte contiene un migrante sin cuerpo.');
    migrantes.push(intento.bytes);
  }
  return migrantes;
}

/** El backing residente solo se lee durante la serialización y nunca sale del hilo. */
function teselasClonables(tiles: Tile[]): Tile[] {
  const backing = residentBackingArray(tiles) as Tile[];
  if (!types.isProxy(backing) && !backing.some(types.isProxy)) return backing;
  return backing.map(tile => types.isProxy(tile) ? { ...tile } : tile);
}

/** El dueño 0 congela sus datos en la barrera y cede los buffers que acaba de producir. */
export function prepararCorteTransferido(datos: Omit<DatosLocales, 'params' | 'cabecera'> & {
  cabecera: World;
  remoto: CorteRemotoBinario;
  migrantes: readonly Uint8Array[];
  materia: MateriaCheckpoint | null;
  opciones: OpcionesReunionCorte;
  comprobarTecnologia: boolean;
}): CapturaCorteTransferido {
  const { coordinador, cabecera, siguientes, bajasPrevias, remoto, migrantes, materia, opciones, comprobarTecnologia } = datos;
  const { eventCounter, tick } = coordinador;
  const tiles = teselasClonables(coordinador.tiles);
  const retiredChunks = coordinador.retiredChunks.map(chunk => {
    const tiles = teselasClonables(chunk.tiles);
    return tiles === chunk.tiles ? chunk : { ...chunk, tiles };
  });
  const local = serialize({
    coordinador: { ...coordinador, tiles, retiredChunks, technology: sinCheckpointTecnologia(coordinador.technology)! },
    cabecera: baseReunionDe(cabecera), siguientes, params: paramsOf(coordinador), bajasPrevias,
  } satisfies DatosLocales);
  if (!(local.buffer instanceof ArrayBuffer) || local.byteOffset !== 0 || local.byteLength !== local.buffer.byteLength)
    throw new Error('V8 no entregó un bloque transferible para el coordinador.');
  const transferibles = new Set(transferiblesCorteRemoto(remoto));
  transferibles.add(local.buffer);
  const incluir = ({ buffer }: Uint8Array): void => {
    if (!(buffer instanceof ArrayBuffer)) throw new Error('El corte requiere buffers privados para migrantes y materia.');
    if (buffer.byteLength > 0) transferibles.add(buffer);
  };
  for (const migrante of migrantes) incluir(migrante);
  if (materia) {
    incluir(materia.sustancias);
    incluir(materia.registro);
    incluir(materia.enVuelo);
    for (const bloque of materia.paginas instanceof Uint8Array ? [materia.paginas] : materia.paginas.tramos) incluir(bloque);
  }
  const copiaMateria = materia && { ...materia,
    inicial: [...materia.inicial], fuentes: [...materia.fuentes], sumideros: [...materia.sumideros] };
  const corte: CorteTransferido = { solicitud: remoto.solicitud, epoca: remoto.epoca, tick, eventCounter,
    local, remoto, migrantes, materia: copiaMateria, opciones, comprobarTecnologia };
  return { corte, transferibles: [...transferibles] };
}

/** El persistidor conserva las capacidades de su propio Store y las filas verificadas por el decodificador. */
export function materializarCorteTransferido(corte: CorteTransferido, contexto: WorldContext) {
  const { solicitud, epoca, tick, eventCounter, local, remoto, migrantes, materia, opciones, comprobarTecnologia } = corte;
  if (solicitud !== remoto.solicitud || epoca !== remoto.epoca || tick !== remoto.tick
    || !remoto.sobres.length || remoto.sobres.length !== remoto.duenosRemotos
    || materia !== null && (materia.tick !== tick || materia.epoca !== epoca))
    throw new Error('Identidad incoherente o corte de guardado ya consumido.');
  const { coordinador, cabecera, siguientes, params, bajasPrevias } = deserialize(local) as DatosLocales;
  if (coordinador.tick !== tick || coordinador.eventCounter !== eventCounter)
    throw new Error('El coordinador no pertenece al corte de guardado.');
  const { partes } = decodificarCorteRemoto(remoto);
  const tecnologiaRemotaEquivalente = comprobarTecnologia && partes.every(parte =>
    isDeepStrictEqual(sinCheckpointTecnologia(parte.technology), cabecera.technology));
  setParams(coordinador, params);
  bindWorldContext(coordinador, contexto);
  const { world, bajas } = reunirCorte(coordinador, cabecera, partes, siguientes, migrantes, bajasPrevias, opciones, true);
  recordSample(world);
  const instantanea = { world, materia };
  return { sello: crearCorteGuardado(() => instantanea), instantanea, bajas, tecnologiaRemotaEquivalente };
}

/**
 * Reúne en orden de dueño y después incorpora los migrantes aún en vuelo. Los tramos
 * verificados apuntan a filas intactas o se excluyen cuando la proyección las modifica.
 */
export function reunirCorte(coordinador: World, cabecera: BaseReunion, partes: readonly ParteMundo[],
  siguientes: Record<TipoId, number>, migrantes: readonly Uint8Array[], bajasPrevias: readonly LegacyRecord[],
  { prepararFauna, prepararTeselas, prepararPersonas }: OpcionesReunionCorte, adoptarCoordinador = false):
  { world: World; bajas: LegacyRecord[] } {
  let desdeFauna = coordinador.animals.length;
  let desdePersonas = coordinador.people.length;
  let desdeTeselas = coordinador.tiles.length;
  const world = reunir(coordinador, cabecera, partes, siguientes, adoptarCoordinador);
  if (prepararFauna) {
    const tramos: TramoFaunaCorte[] = [];
    const verificados: TramoFaunaVerificada[] = [];
    for (const parte of partes) {
      if (prepararFauna === 'directa') {
        for (const tramo of faunaVerificadaDe(parte.animals) ?? [])
          verificados.push({ desde: desdeFauna + tramo.desde, filas: tramo.filas });
      } else {
        for (const tramo of faunaCorteDe(parte.animals) ?? [])
          tramos.push({ desde: desdeFauna + tramo.desde, bloques: tramo.bloques });
      }
      desdeFauna += parte.animals.length;
    }
    if (tramos.length) vincularFaunaCorte(world.animals, tramos);
    if (verificados.length) vincularFaunaVerificada(world.animals, verificados);
  }
  const tramosPersonas: TramoPersonasVerificadas[] = [];
  if (prepararPersonas) {
    for (const parte of partes) {
      for (const tramo of personasVerificadasDe(parte.people)?.tramos ?? [])
        tramosPersonas.push({ desde: desdePersonas + tramo.desde, filas: tramo.filas });
      desdePersonas += parte.people.length;
    }
  }
  for (const bytes of migrantes) {
    const mig = deserialize(bytes) as Migrante;
    if (mig.tipo === 'chunk') {
      world.chunks[mig.key] = mig.meta;
      world.tiles.push(...mig.tiles);
      world.structures.push(...mig.structures);
      world.animals.push(...mig.animals);
      for (const p of mig.personas) world.people.push(p.persona);
    } else {
      if (mig.persona) world.people.push(mig.persona.persona);
      if (mig.animal) world.animals.push(mig.animal.animal);
    }
  }
  const personasModificadas = tramosPersonas.length ? new Set<Person>() : undefined;
  // El padrón de F0 aún puede contener bajas de F5, incluidas las archivadas antes en este tick.
  const bajasNuevas = world.retiredLegacy.filter(persona => persona.diedAt === world.tick);
  const bajas = bajasPrevias.length
    ? [...bajasPrevias, ...bajasNuevas.filter(p => !bajasPrevias.some(prev => prev.id === p.id))]
    : bajasNuevas;
  if (bajas.length) {
    pruneBonds(world.people, bajas, personasModificadas && (persona => personasModificadas.add(persona)));
    const ids = new Set(bajas.map(persona => persona.id));
    world.communities = world.communities.filter(comunidad => {
      if (!comunidad.members.some(id => ids.has(id))) return true;
      comunidad.members = comunidad.members.filter(id => !ids.has(id));
      if (comunidad.memberCount !== undefined) comunidad.memberCount = comunidad.members.length;
      return comunidad.members.length > 0;
    });
  }
  if (prepararTeselas) {
    const tramos: TramoTeselasVerificadas[] = [];
    for (const parte of partes) {
      for (const tramo of teselasVerificadasDe(parte.tiles)?.tramos ?? [])
        tramos.push({ desde: desdeTeselas + tramo.desde, filas: tramo.filas });
      desdeTeselas += parte.tiles.length;
    }
    const modificadas = new Set<Tile>();
    if (paramsOf(world).v23.fauna) syncFauna(world.tiles, world.animals, (_x, _y, tile) => modificadas.add(tile));
    if (tramos.length) vincularTeselasVerificadas(world.tiles, { tramos, modificadas });
  } else if (paramsOf(world).v23.fauna) syncFauna(world.tiles, world.animals);
  if (personasModificadas) vincularPersonasVerificadas(world.people, { tramos: tramosPersonas, modificadas: personasModificadas });
  return { world, bajas };
}
