import { isDeepStrictEqual } from 'node:util';
import { crc32, gzipSync, gunzipSync } from 'node:zlib';
import type { Nivel } from '../../shared/cinta.js';
import type { TapeClientDelta, TapeEntityPatch, TapeIdentified, TapeObjectPatch, TapePartialUpsert, TapeTechPatch } from '../../shared/tape-delta.js';
import type { Tile, WorldView } from '../../shared/types.js';

const CABECERA = 33;
const CRC = 25;
const LONGITUD_KF = 29;
const CABECERA_DELTA = 12;

export interface MetadatosBloque {
  nivel: Nivel;
  t0: number;
  t1: number;
  fotogramas: number;
  crc: number;
}

export interface BloqueDecodificado extends MetadatosBloque {
  baseFrame: WorldView;
  deltas: TapeClientDelta[];
}

const comprimir = (v: unknown): Buffer => gzipSync(JSON.stringify(v), { level: 1 });
const descomprimir = <T>(datos: Buffer): T => JSON.parse(gunzipSync(datos).toString()) as T;
const tickValido = (t: number): boolean => Number.isSafeInteger(t) && t >= 0;
const nivelValido = (n: number): n is Nivel => Number.isInteger(n) && n >= 0 && n <= 4;

// El CRC abarca la cabecera y el contenido comprimido. Solo se excluyen los cuatro bytes del propio CRC.
function suma(datos: Buffer): number {
  return crc32(datos.subarray(LONGITUD_KF), crc32(datos.subarray(0, CRC)));
}

/** CNT1: números little-endian, clave completa y deltas JSON comprimidos por separado. */
export function codificarBloque(nivel: Nivel, base: WorldView, deltas: readonly TapeClientDelta[]): Buffer {
  if (!nivelValido(nivel) || !tickValido(base.tick)) throw new Error('Nivel o tick inicial inválido en CNT1.');
  const clave = comprimir(base);
  const partes = [Buffer.alloc(CABECERA), clave];
  let t1 = base.tick;
  for (const delta of deltas) {
    if (!tickValido(delta.tick) || delta.tick <= t1) throw new Error('Ticks fuera de orden en CNT1.');
    t1 = delta.tick;
    const cuerpo = comprimir(delta);
    const cabecera = Buffer.alloc(CABECERA_DELTA);
    cabecera.writeDoubleLE(delta.tick, 0);
    cabecera.writeUInt32LE(cuerpo.length, 8);
    partes.push(cabecera, cuerpo);
  }
  const cabecera = partes[0]!;
  cabecera.write('CNT1', 0, 'ascii');
  cabecera.writeUInt8(nivel, 4);
  cabecera.writeUInt32LE(deltas.length + 1, 5);
  cabecera.writeDoubleLE(base.tick, 9);
  cabecera.writeDoubleLE(t1, 17);
  cabecera.writeUInt32LE(clave.length, LONGITUD_KF);
  const bloque = Buffer.concat(partes);
  bloque.writeUInt32LE(suma(bloque), CRC);
  return bloque;
}

function examinar(datos: Buffer) {
  if (datos.length < CABECERA || datos.toString('ascii', 0, 4) !== 'CNT1') throw new Error('Cabecera CNT1 inválida.');
  const nivel = datos.readUInt8(4), fotogramas = datos.readUInt32LE(5);
  const t0 = datos.readDoubleLE(9), t1 = datos.readDoubleLE(17), crc = datos.readUInt32LE(CRC);
  const longitudClave = datos.readUInt32LE(LONGITUD_KF);
  let offset = CABECERA + longitudClave;
  if (!nivelValido(nivel) || !fotogramas || !tickValido(t0) || !tickValido(t1) || t0 > t1
      || !longitudClave || offset > datos.length) throw new Error('Metadatos CNT1 inválidos.');
  if (suma(datos) !== crc) throw new Error('CRC32 CNT1 inválido.');
  const clave = datos.subarray(CABECERA, offset);
  const deltas: { tick: number; bytes: Buffer }[] = [];
  let anterior = t0;
  for (let i = 1; i < fotogramas; i++) {
    if (offset + CABECERA_DELTA > datos.length) throw new Error('Cabecera de delta CNT1 truncada.');
    const tick = datos.readDoubleLE(offset), longitud = datos.readUInt32LE(offset + 8);
    offset += CABECERA_DELTA;
    if (!tickValido(tick) || tick <= anterior || !longitud || offset + longitud > datos.length) {
      throw new Error('Tick o longitud de delta CNT1 inválido.');
    }
    deltas.push({ tick, bytes: datos.subarray(offset, offset + longitud) });
    offset += longitud;
    anterior = tick;
  }
  if (offset !== datos.length || anterior !== t1) throw new Error('Fin de bloque CNT1 inválido.');
  return { meta: { nivel, t0, t1, fotogramas, crc }, clave, deltas };
}

/** Comprueba la trama y el CRC sin descomprimir, también durante la apertura del catálogo. */
export function verificarBloque(datos: Buffer): MetadatosBloque {
  return examinar(datos).meta;
}

export function decodificarBloque(datos: Buffer): BloqueDecodificado {
  const { meta, clave, deltas } = examinar(datos);
  const baseFrame = descomprimir<WorldView>(clave);
  if (baseFrame.tick !== meta.t0) throw new Error('Tick de clave CNT1 distinto de la cabecera.');
  return { ...meta, baseFrame, deltas: deltas.map(({ tick, bytes }) => {
    const delta = descomprimir<TapeClientDelta>(bytes);
    if (delta.tick !== tick) throw new Error('Tick de delta CNT1 distinto de la cabecera.');
    return delta;
  }) };
}

function igual(a: unknown, b: unknown): boolean {
  return a === b || isDeepStrictEqual(a, b);
}

function campo(o: Record<string, unknown>, clave: string): boolean {
  return Object.hasOwn(o, clave) && o[clave] !== undefined;
}

function cambiosObjeto(cur: Record<string, unknown>, prev: Record<string, unknown>): TapeObjectPatch {
  const set = Object.fromEntries(Object.entries(cur).filter(([k, v]) => v !== undefined && !igual(v, prev[k])));
  const unset = Object.keys(prev).filter(k => campo(prev, k) && !campo(cur, k));
  return unset.length ? { set, unset } : { set };
}

function entidades<T extends TapeIdentified>(current: T[], previous: T[]): TapeEntityPatch<T> {
  const old = new Map(previous.map(v => [v.id, v]));
  const ids = new Set(current.map(v => v.id));
  const upserts: (T | TapePartialUpsert)[] = [];
  for (const v of current) {
    const prev = old.get(v.id);
    if (!prev) { upserts.push(v); continue; }
    if (v === prev) continue;
    const { set, unset } = cambiosObjeto(v as Record<string, unknown>, prev as Record<string, unknown>);
    if (Object.keys(set).length || unset) upserts.push({ ...set, id: v.id, _p: 1, ...(unset ? { _u: unset } : {}) });
  }
  const removed = previous.filter(v => !ids.has(v.id)).map(v => v.id);
  const natural = previous.filter(v => ids.has(v.id)).map(v => v.id)
    .concat(current.filter(v => !old.has(v.id)).map(v => v.id));
  const actual = current.map(v => v.id);
  return igual(natural, actual) ? { upserts, removed } : { upserts, removed, order: actual };
}

const conCambios = (p: TapeEntityPatch<TapeIdentified>): boolean =>
  !!(p.upserts.length || p.removed.length || p.order);
const coord = (t: Tile): string => `${t.x},${t.y}`;

function cambiosTeselas(previous: Tile[], current: Tile[], delta: TapeClientDelta): void {
  const antes = new Map(previous.map((t, i) => [coord(t), { t, i }]));
  const vigentes = new Set<string>();
  const movidas = new Set<string>();
  const changed: Tile[] = [];
  let indice = -1, alFinal = false;
  for (const t of current) {
    const k = coord(t), vieja = antes.get(k);
    vigentes.add(k);
    // El cliente conserva el orden previo e inserta al final. Reinsertar solo el sufijo que no cabe en ese orden.
    alFinal ||= !vieja || vieja.i <= indice;
    if (alFinal && vieja) movidas.add(k);
    if (alFinal || !igual(t, vieja?.t)) changed.push(t);
    if (vieja) indice = vieja.i;
  }
  const removed = [...antes.keys()].filter(k => !vigentes.has(k) || movidas.has(k));
  if (changed.length) delta.tilesPatch = changed;
  if (removed.length) delta.removedTiles = removed;
}

const listas = ['people', 'animals', 'structures', 'places', 'blueprints', 'communities'] as const;
const especiales = new Set<string>([...listas, 'tiles', 'technology', 'stats', 'events']);

/** Parche público exacto, incluidas colecciones opcionales, bajas y orden. */
export function clientDelta(previous: WorldView, current: WorldView): TapeClientDelta {
  const delta: TapeClientDelta = { tick: current.tick, sequence: current.sequence,
    day: current.day, phase: current.phase, weather: current.weather };
  const changes = delta as unknown as Record<string, unknown>;
  const prev = previous as unknown as Record<string, unknown>;
  const cur = current as unknown as Record<string, unknown>;
  const unset = Object.keys(prev).filter(k => campo(prev, k) && !campo(cur, k));
  for (const [key, value] of Object.entries(cur)) {
    if (value !== undefined && !especiales.has(key) && !igual(value, prev[key])) changes[key] = value;
  }
  if (unset.length) delta.unset = unset;
  for (const nombre of listas) {
    const valores = current[nombre];
    if (!valores) continue;
    const p = entidades<TapeIdentified>(valores, previous[nombre] ?? []);
    if (!previous[nombre] || conCambios(p)) changes[`${nombre}Patch`] = p;
  }
  const tech = current.technology, antes = previous.technology;
  if (tech && antes && (!antes.dynamics || tech.dynamics) && (!antes.budgets || tech.budgets)) {
    const p: TapeTechPatch = {};
    const items = entidades(tech.items, antes.items), recipes = entidades(tech.recipes, antes.recipes);
    if (conCambios(items)) p.itemsPatch = items;
    if (conCambios(recipes)) p.recipesPatch = recipes;
    if (!igual(tech.knowledge, antes.knowledge)) {
      if (tech.knowledge === undefined) p.unsetKnowledge = true;
      else p.knowledge = tech.knowledge;
    }
    if (!igual(tech.dynamics, antes.dynamics)) p.dynamics = tech.dynamics;
    if (!igual(tech.budgets, antes.budgets)) p.budgets = tech.budgets;
    if (Object.keys(p).length) delta.techPatch = p;
  } else if (tech) delta.technology = tech;
  if (current.stats && previous.stats) {
    const p = cambiosObjeto(current.stats as unknown as Record<string, unknown>, previous.stats as unknown as Record<string, unknown>);
    if (Object.keys(p.set).length || p.unset) delta.statsPatch = p;
  } else if (current.stats) delta.stats = current.stats;
  const events = new Map(previous.events.map(event => [event.id, event]));
  const nuevos = current.events.filter(event => !igual(event, events.get(event.id)));
  if (nuevos.length) delta.newEvents = nuevos;
  const orden = current.events.map(event => event.id);
  if (!igual(orden, previous.events.map(event => event.id))) delta.eventOrder = orden;
  cambiosTeselas(previous.tiles, current.tiles, delta);
  return delta;
}
