import type { Person } from '../index.js';
import type { Action } from '../../shared/types.js';

/**
 * T147: SoA caliente de persona (`PersonStore`) conservando el orden de iteración.
 *
 * Página caliente fija por slot (columnas `Float64`/`Int32`/`Uint8` + banderas) y piscinas
 * variables tras ella: `visited` como pares `Int32`, `skills`/`activity`/`values` y la
 * competencia tecnológica como registros `(clave internada, orden de inserción, valor)`,
 * `bonds` como aristas indexadas `(destino internado, orden, valor)`, experiencias,
 * hábitos y tecnología en piscinas propias. Lo que no tiene forma cerrada (el proyecto
 * tecnológico en curso y claves ajenas a `Person`) viaja por referencia en el spill:
 * el almacén no lo duplica y su índice ocupa una columna caliente.
 *
 * El orden de inserción es dato, no un accidente del `Record`: cada registro guarda su
 * `orden` explícito y `unpack` reinserta las claves en ese orden, así que el desempate
 * por valor máximo (estable en JS) elige la misma habilidad antes y después.
 */

export const HOT_BUDGET_BYTES = 1024;
export const TOTAL_BUDGET_BYTES = 4096;

const ACTIONS: readonly Action[] = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'];
const ORDERS: readonly string[] = ['move', 'explore', 'forage', 'gather', 'farm', 'build', 'hunt', 'drink', 'rest', 'cooperate', 'invent', 'repair', 'research', 'craft'];
const ROLES: readonly Person['role'][] = ['S', 'I', 'neighbor'];
const INTENTS: readonly Person['intentContext'][] = ['hungry', 'thirsty', 'tired', 'ready'];
const MODES: readonly Person['controlMode'][] = ['auto', 'directed'];
const DEATHS: readonly (string | null)[] = [null, 'starvation', 'dehydration', 'exposure', 'senescence'];
const TRAITS = ['curiosity', 'sociability', 'industriousness', 'care', 'resilience'] as const;
const CULTURE = ['sharing', 'stewardship', 'openness'] as const;
const PROPERTIES = ['hardness', 'toughness', 'porosity', 'flexibility', 'edge', 'containment', 'insulation', 'leverage', 'cohesion', 'temperature', 'alignment', 'firing'] as const;

// Columnas calientes Float64 (índice de columna, no de campo suelto).
const F = {
  x: 0, y: 1, energy: 2, hunger: 3, fatigue: 4, thirst: 5, inventory: 6, curiosity: 7,
  sociability: 8, generosity: 9, closeness: 10, socialLoad: 11, heading: 12, targetX: 13, targetY: 14,
  trait0: 15, trait1: 16, trait2: 17, trait3: 18, trait4: 19,
  culture0: 20, culture1: 21, culture2: 22, wood: 23, stone: 24,
  learningRate: 25, cooperation: 26,
  allele0: 27, allele1: 28, allele2: 29, allele3: 30, allele4: 31, allele5: 32, allele6: 33,
  allele7: 34, allele8: 35, allele9: 36, allele10: 37, allele11: 38, allele12: 39, allele13: 40,
  demographyAge: 41, health: 42, vitality: 43,
  decisionAt: 44, lastMeeting: 45, lastShared: 46, work: 47, lastOutcome: 48, bornAt: 49,
  lastBirth: 50, lastSocial: 51, lastDispute: 52, lastPracticeMemory: 53, lastInvention: 54,
  homeX: 55, homeY: 56, homeQuality: 57, homeObservedAt: 58, waterX: 59, waterY: 60,
  conflictX: 61, conflictY: 62, conflictTick: 63, commandX: 64, commandY: 65,
  residueWood: 66, residueStone: 67, residueWater: 68, techAttempts: 69, techLastAttempt: 70,
  waterActionAt: 71, waterCarryAt: 72, prepInitial: 73, prepTarget: 74, prepSourceX: 75, prepSourceY: 76, prepStartedAt: 77,
} as const;
const NF64 = 78;
// Columnas calientes Int32: referencias internadas y rangos [inicio, cuenta) de cada piscina.
const I = {
  id: 0, name: 1, color: 2, reason: 3, need: 4, recentMemory: 5, community: 6, blueprint: 7,
  visitedStart: 8, visitedCount: 9, skillsStart: 10, skillsCount: 11, activityStart: 12, activityCount: 13,
  valuesStart: 14, valuesCount: 15, bondsStart: 16, bondsCount: 17, expStart: 18, expCount: 19,
  habitStart: 20, habitCount: 21, knownStart: 22, knownCount: 23, learnedStart: 24, learnedCount: 25,
  itemsStart: 26, itemsCount: 27, competenceStart: 28, competenceCount: 29,
  parent0: 30, parent1: 31, generation: 32, mutations: 33, parentCount: 34, spill: 35, prepItem: 36,
} as const;
const NI32 = 37;
const NU8 = 6; // role, action, intentContext, controlMode, commandOrder, deathCause
export const HOT_BYTES_PER_PERSON = NF64 * 8 + NI32 * 4 + NU8 + 4;

const FLAG = { lastInvention: 1, home: 2, waterMemory: 4, conflictMemory: 8, blueprint: 16, spill: 32,
  waterAction: 64, waterCarry: 128, waterPrep: 256, recentMemory: 512, thirst: 1024, community: 2048 } as const;

const KNOWN_KEYS = new Set(['id', 'name', 'role', 'x', 'y', 'color', 'action', 'reason', 'energy', 'hunger', 'fatigue', 'need',
  'recentMemory', 'inventory', 'curiosity', 'sociability', 'generosity', 'closeness', 'socialLoad', 'target', 'decisionAt',
  'lastMeeting', 'lastShared', 'experiences', 'habits', 'traits', 'skills', 'materials', 'activity', 'values', 'visited',
  'heading', 'command', 'work', 'lastOutcome', 'intentContext', 'controlMode', 'thirst', 'genome', 'bornAt', 'lastBirth',
  'lastSocial', 'lastDispute', 'lastPracticeMemory', 'culture', 'communityId', 'bonds', 'technology', 'demography',
  'blueprintId', 'lastInvention', 'home', 'waterMemory', 'conflictMemory']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function grow<T extends Int32Array | Float64Array | Uint8Array>(array: T, ctor: new (n: number) => T, need: number): T {
  if (array.length >= need) return array;
  const next = new ctor(Math.max(need, array.length * 2, 64)) as unknown as T;
  (next as unknown as Int32Array).set(array as unknown as Int32Array);
  return next;
}
type I32 = Int32Array<ArrayBuffer>; type F64 = Float64Array<ArrayBuffer>; type U8 = Uint8Array<ArrayBuffer>;
const cutI = (a: Int32Array, n: number): I32 => a.slice(0, n) as unknown as I32;
const cutF = (a: Float64Array, n: number): F64 => a.slice(0, n) as unknown as F64;
const cutU = (a: Uint8Array, n: number): U8 => a.slice(0, n) as unknown as U8;
const i32 = (a: Int32Array, n: number): I32 => grow(a, Int32Array, n) as unknown as I32;
const f64 = (a: Float64Array, n: number): F64 => grow(a, Float64Array, n) as unknown as F64;
const u8 = (a: Uint8Array, n: number): U8 => grow(a, Uint8Array, n) as unknown as U8;

function code(values: readonly (string | null)[], value: string | null, field: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new RangeError(`Persona no representable en el SoA: ${field}=${String(value)}.`);
  return index;
}
function num(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new RangeError(`Persona no representable en el SoA: ${field} no es un número.`);
  return value;
}
function int32(value: unknown, field: string): number {
  const n = num(value, field);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) throw new RangeError(`Persona no representable en el SoA: ${field} fuera de Int32.`);
  return n;
}

class StringPool {
  blob: U8 = new Uint8Array(0); offsets: I32 = new Int32Array(0); lengths: I32 = new Int32Array(0);
  private map = new Map<string, number>(); private cache: (string | undefined)[] = []; used = 0; count = 0;
  intern(value: string): number {
    const hit = this.map.get(value);
    if (hit !== undefined) return hit;
    const bytes = encoder.encode(value), index = this.count++;
    this.offsets = i32(this.offsets, this.count); this.lengths = i32(this.lengths, this.count);
    this.blob = u8(this.blob, this.used + bytes.length);
    this.blob.set(bytes, this.used);
    this.offsets[index] = this.used; this.lengths[index] = bytes.length; this.used += bytes.length;
    this.map.set(value, index); this.cache.push(undefined);
    return index;
  }
  get(index: number): string {
    const hit = this.cache[index];
    if (hit !== undefined) return hit;
    const value = decoder.decode(this.blob.subarray(this.offsets[index]!, this.offsets[index]! + this.lengths[index]!));
    this.cache[index] = value; return value;
  }
  compact(): void { this.blob = cutU(this.blob, this.used); this.offsets = cutI(this.offsets, this.count); this.lengths = cutI(this.lengths, this.count); }
  get bytes(): number { return this.blob.byteLength + this.offsets.byteLength + this.lengths.byteLength; }
}

interface RecordPool { keys: I32; orders: I32; values: F64; used: number; }
const newRecordPool = (): RecordPool => ({ keys: new Int32Array(0), orders: new Int32Array(0), values: new Float64Array(0), used: 0 });
function recordPush(pool: RecordPool, key: number, order: number, value: number): void {
  pool.keys = i32(pool.keys, pool.used + 1); pool.orders = i32(pool.orders, pool.used + 1); pool.values = f64(pool.values, pool.used + 1);
  pool.keys[pool.used] = key; pool.orders[pool.used] = order; pool.values[pool.used] = value; pool.used++;
}
function recordCompact(pool: RecordPool): void { pool.keys = cutI(pool.keys, pool.used); pool.orders = cutI(pool.orders, pool.used); pool.values = cutF(pool.values, pool.used); }
const recordBytes = (pool: RecordPool): number => pool.keys.byteLength + pool.orders.byteLength + pool.values.byteLength;

export class PersonStore {
  private capacity = 0; private loaded = 0;
  private hotF = new Float64Array(0); private hotI = new Int32Array(0); private hotU = new Uint8Array(0); private flags = new Uint32Array(0);
  private strings = new StringPool();
  private visited = new Int32Array(0); private visitedUsed = 0;
  private skills = newRecordPool(); private activity = newRecordPool(); private values = newRecordPool(); private bonds = newRecordPool();
  private competenceKeys = new Int32Array(0); private competenceOrders = new Int32Array(0); private competenceInts = new Int32Array(0); private competenceFloats = new Float64Array(0); private competenceUsed = 0;
  private expInts = new Int32Array(0); private expUsed = 0; // por experiencia: tick, texto, causa, lugar
  private habitInts = new Int32Array(0); private habitFloats = new Float64Array(0); private habitUsed = 0; // ints: lugar, demostrador, fuente, observaciones, repeticiones, evidenciaInicio, evidenciaCuenta
  private evidenceInts = new Int32Array(0); private evidenceFloats = new Float64Array(0); private evidenceUsed = 0; // ints: evento, tick, demostrador, receptor
  private known = new Int32Array(0); private knownUsed = 0;
  private learned = new Int32Array(0); private learnedUsed = 0; // receta, maestro, tick
  private itemInts = new Int32Array(0); private itemFloats = new Float64Array(0); private itemFlags = new Uint8Array(0); private itemUsed = 0; // ints: id, receta, generación, hechoEn, padresInicio, padresCuenta, contenidoTick
  private parents = new Int32Array(0); private parentsUsed = 0;
  private spillRefs: unknown[] = [];

  get count(): number { return this.loaded; }
  get hotBytesPerPerson(): number { return HOT_BYTES_PER_PERSON; }
  /** Bytes reales de los buffers que posee el almacén (caliente + piscinas + spill por referencia a 16 B/índice). */
  get bytes(): number {
    return this.hotF.byteLength + this.hotI.byteLength + this.hotU.byteLength + this.flags.byteLength + this.strings.bytes
      + this.visited.byteLength + recordBytes(this.skills) + recordBytes(this.activity) + recordBytes(this.values) + recordBytes(this.bonds)
      + this.competenceKeys.byteLength + this.competenceOrders.byteLength + this.competenceInts.byteLength + this.competenceFloats.byteLength
      + this.expInts.byteLength + this.habitInts.byteLength + this.habitFloats.byteLength + this.evidenceInts.byteLength + this.evidenceFloats.byteLength
      + this.known.byteLength + this.learned.byteLength + this.itemInts.byteLength + this.itemFloats.byteLength + this.itemFlags.byteLength
      + this.parents.byteLength + this.spillRefs.length * 16;
  }
  get bytesPerPerson(): number { return this.loaded ? this.bytes / this.loaded : 0; }

  pack(people: readonly Person[]): void {
    this.capacity = people.length; this.loaded = people.length;
    this.hotF = new Float64Array(NF64 * this.capacity); this.hotI = new Int32Array(NI32 * this.capacity);
    this.hotU = new Uint8Array(NU8 * this.capacity); this.flags = new Uint32Array(this.capacity);
    this.strings = new StringPool(); this.visited = new Int32Array(0); this.visitedUsed = 0;
    this.skills = newRecordPool(); this.activity = newRecordPool(); this.values = newRecordPool(); this.bonds = newRecordPool();
    this.competenceKeys = new Int32Array(0); this.competenceOrders = new Int32Array(0); this.competenceInts = new Int32Array(0); this.competenceFloats = new Float64Array(0); this.competenceUsed = 0;
    this.expInts = new Int32Array(0); this.expUsed = 0; this.habitInts = new Int32Array(0); this.habitFloats = new Float64Array(0); this.habitUsed = 0;
    this.evidenceInts = new Int32Array(0); this.evidenceFloats = new Float64Array(0); this.evidenceUsed = 0;
    this.known = new Int32Array(0); this.knownUsed = 0; this.learned = new Int32Array(0); this.learnedUsed = 0;
    this.itemInts = new Int32Array(0); this.itemFloats = new Float64Array(0); this.itemFlags = new Uint8Array(0); this.itemUsed = 0;
    this.parents = new Int32Array(0); this.parentsUsed = 0; this.spillRefs = [];
    for (let slot = 0; slot < people.length; slot++) this.packPerson(slot, people[slot]!);
    // Compactar: los bytes medidos son los buffers finales, sin holgura de crecimiento.
    this.visited = cutI(this.visited, this.visitedUsed * 2);
    recordCompact(this.skills); recordCompact(this.activity); recordCompact(this.values); recordCompact(this.bonds);
    this.competenceKeys = cutI(this.competenceKeys, this.competenceUsed); this.competenceOrders = cutI(this.competenceOrders, this.competenceUsed);
    this.competenceInts = cutI(this.competenceInts, this.competenceUsed * 2); this.competenceFloats = cutF(this.competenceFloats, this.competenceUsed * 2);
    this.expInts = cutI(this.expInts, this.expUsed * 4);
    this.habitInts = cutI(this.habitInts, this.habitUsed * 7); this.habitFloats = cutF(this.habitFloats, this.habitUsed);
    this.evidenceInts = cutI(this.evidenceInts, this.evidenceUsed * 4); this.evidenceFloats = cutF(this.evidenceFloats, this.evidenceUsed);
    this.known = cutI(this.known, this.knownUsed); this.learned = cutI(this.learned, this.learnedUsed * 3);
    this.itemInts = cutI(this.itemInts, this.itemUsed * 7); this.itemFloats = cutF(this.itemFloats, this.itemUsed * 19); this.itemFlags = cutU(this.itemFlags, this.itemUsed);
    this.parents = cutI(this.parents, this.parentsUsed); this.strings.compact();
  }

  private setF(slot: number, col: number, value: number): void { this.hotF[col * this.capacity + slot] = value; }
  private getF(slot: number, col: number): number { return this.hotF[col * this.capacity + slot]!; }
  private setI(slot: number, col: number, value: number): void { this.hotI[col * this.capacity + slot] = value; }
  private getI(slot: number, col: number): number { return this.hotI[col * this.capacity + slot]!; }
  private setU(slot: number, col: number, value: number): void { this.hotU[col * this.capacity + slot] = value; }
  private getU(slot: number, col: number): number { return this.hotU[col * this.capacity + slot]!; }

  private packRecord(pool: RecordPool, slot: number, startCol: number, countCol: number, record: Record<string, number>, field: string): void {
    this.setI(slot, startCol, pool.used);
    const entries = Object.entries(record);
    this.setI(slot, countCol, entries.length);
    for (let order = 0; order < entries.length; order++) {
      const [key, value] = entries[order]!;
      recordPush(pool, this.strings.intern(key), order, num(value, `${field}.${key}`));
    }
  }
  private unpackRecord(pool: RecordPool, slot: number, startCol: number, countCol: number): Record<string, number> {
    const start = this.getI(slot, startCol), count = this.getI(slot, countCol), entries: [number, number, number][] = [];
    for (let n = 0; n < count; n++) entries.push([pool.keys[start + n]!, pool.orders[start + n]!, pool.values[start + n]!]);
    entries.sort((a, b) => a[1] - b[1]);
    const record: Record<string, number> = {};
    for (const [key, , value] of entries) record[this.strings.get(key)] = value;
    return record;
  }

  /** Claves de `skills` en el orden de inserción guardado en la columna de orden. */
  skillsOrder(slot: number): string[] {
    const start = this.getI(slot, I.skillsStart), count = this.getI(slot, I.skillsCount), entries: [number, number][] = [];
    for (let n = 0; n < count; n++) entries.push([this.skills.orders[start + n]!, this.skills.keys[start + n]!]);
    return entries.sort((a, b) => a[0] - b[0]).map(([, key]) => this.strings.get(key));
  }
  /** Habilidad más practicada desde el SoA: valor máximo y, en empate, menor orden de inserción. */
  topSkill(slot: number): string | undefined {
    const start = this.getI(slot, I.skillsStart), count = this.getI(slot, I.skillsCount);
    let best = -1;
    for (let n = 0; n < count; n++) {
      if (best < 0 || this.skills.values[start + n]! > this.skills.values[start + best]!
        || (this.skills.values[start + n]! === this.skills.values[start + best]! && this.skills.orders[start + n]! < this.skills.orders[start + best]!)) best = n;
    }
    return best < 0 ? undefined : this.strings.get(this.skills.keys[start + best]!);
  }
  bondsOrder(slot: number): string[] {
    const start = this.getI(slot, I.bondsStart), count = this.getI(slot, I.bondsCount), entries: [number, number][] = [];
    for (let n = 0; n < count; n++) entries.push([this.bonds.orders[start + n]!, this.bonds.keys[start + n]!]);
    return entries.sort((a, b) => a[0] - b[0]).map(([, key]) => this.strings.get(key));
  }

  private packPerson(slot: number, person: Person): void {
    const spill: { project?: unknown; extras?: Record<string, unknown> } = {};
    const extras: Record<string, unknown> = {};
    for (const key of Object.keys(person)) if (!KNOWN_KEYS.has(key)) extras[key] = (person as unknown as Record<string, unknown>)[key];
    if (Object.keys(extras).length) spill.extras = extras;
    let flags = 0;
    const str = (value: unknown, field: string): number => {
      if (typeof value !== 'string') throw new RangeError(`Persona no representable en el SoA: ${field} no es una cadena.`);
      return this.strings.intern(value);
    };
    this.setI(slot, I.id, str(person.id, 'id')); this.setI(slot, I.name, str(person.name, 'name'));
    this.setI(slot, I.color, str(person.color, 'color')); this.setI(slot, I.reason, str(person.reason, 'reason'));
    this.setI(slot, I.need, str(person.need, 'need'));
    if ('recentMemory' in person) { flags |= FLAG.recentMemory; this.setI(slot, I.recentMemory, person.recentMemory === null ? -1 : str(person.recentMemory, 'recentMemory')); }
    if ('communityId' in person) { flags |= FLAG.community; this.setI(slot, I.community, person.communityId === null ? -1 : str(person.communityId, 'communityId')); }
    if ('blueprintId' in person) { flags |= FLAG.blueprint; this.setI(slot, I.blueprint, person.blueprintId == null ? -1 : str(person.blueprintId, 'blueprintId')); }
    this.setU(slot, 0, code(ROLES, person.role, 'role')); this.setU(slot, 1, code(ACTIONS, person.action, 'action'));
    this.setU(slot, 2, code(INTENTS, person.intentContext, 'intentContext')); this.setU(slot, 3, code(MODES, person.controlMode, 'controlMode'));
    this.setU(slot, 4, person.command === null ? 0 : code(ORDERS, person.command.order, 'command.order') + 1);
    this.setU(slot, 5, code(DEATHS, person.demography.deathCause, 'demography.deathCause'));
    const scalars: [number, unknown, string][] = [
      [F.x, person.x, 'x'], [F.y, person.y, 'y'], [F.energy, person.energy, 'energy'], [F.hunger, person.hunger, 'hunger'],
      [F.fatigue, person.fatigue, 'fatigue'], [F.inventory, person.inventory, 'inventory'], [F.curiosity, person.curiosity, 'curiosity'],
      [F.sociability, person.sociability, 'sociability'], [F.generosity, person.generosity, 'generosity'], [F.closeness, person.closeness, 'closeness'],
      [F.socialLoad, person.socialLoad, 'socialLoad'], [F.heading, person.heading, 'heading'],
      [F.targetX, person.target?.x, 'target.x'], [F.targetY, person.target?.y, 'target.y'],
      [F.wood, person.materials?.wood, 'materials.wood'], [F.stone, person.materials?.stone, 'materials.stone'],
      [F.decisionAt, person.decisionAt, 'decisionAt'], [F.lastMeeting, person.lastMeeting, 'lastMeeting'], [F.lastShared, person.lastShared, 'lastShared'],
      [F.work, person.work, 'work'], [F.lastOutcome, person.lastOutcome, 'lastOutcome'], [F.bornAt, person.bornAt, 'bornAt'],
      [F.lastBirth, person.lastBirth, 'lastBirth'], [F.lastSocial, person.lastSocial, 'lastSocial'], [F.lastDispute, person.lastDispute, 'lastDispute'],
      [F.lastPracticeMemory, person.lastPracticeMemory, 'lastPracticeMemory'],
      [F.learningRate, person.genome?.learningRate, 'genome.learningRate'], [F.cooperation, person.genome?.cooperation, 'genome.cooperation'],
      [F.demographyAge, person.demography?.age, 'demography.age'], [F.health, person.demography?.health, 'demography.health'], [F.vitality, person.demography?.vitality, 'demography.vitality'],
      [F.residueWood, person.technology?.residue.wood, 'technology.residue.wood'], [F.residueStone, person.technology?.residue.stone, 'technology.residue.stone'],
      [F.residueWater, person.technology?.residue.water, 'technology.residue.water'], [F.techAttempts, person.technology?.attempts, 'technology.attempts'],
      [F.techLastAttempt, person.technology?.lastAttempt, 'technology.lastAttempt'], [F.commandX, person.command?.x ?? 0, 'command.x'], [F.commandY, person.command?.y ?? 0, 'command.y'],
    ];
    for (const [col, value, field] of scalars) this.setF(slot, col, num(value, field));
    if ('thirst' in person) { flags |= FLAG.thirst; this.setF(slot, F.thirst, num(person.thirst, 'thirst')); }
    for (let n = 0; n < TRAITS.length; n++) this.setF(slot, F.trait0 + n, num(person.traits?.[TRAITS[n]!], `traits.${TRAITS[n]}`));
    for (let n = 0; n < CULTURE.length; n++) this.setF(slot, F.culture0 + n, num(person.culture?.[CULTURE[n]!], `culture.${CULTURE[n]}`));
    const alleles = person.genome?.alleles;
    if (!Array.isArray(alleles) || alleles.length !== 14) throw new RangeError('Persona no representable en el SoA: genome.alleles debe tener 14 valores.');
    for (let n = 0; n < 14; n++) this.setF(slot, F.allele0 + n, num(alleles[n], `genome.alleles.${n}`));
    const parents = person.genome.parents;
    if (!Array.isArray(parents) || parents.length > 2) throw new RangeError('Persona no representable en el SoA: genome.parents debe tener como mucho 2 valores.');
    this.setI(slot, I.parentCount, parents.length);
    this.setI(slot, I.parent0, parents[0] === undefined ? -1 : str(parents[0], 'genome.parents.0'));
    this.setI(slot, I.parent1, parents[1] === undefined ? -1 : str(parents[1], 'genome.parents.1'));
    this.setI(slot, I.generation, int32(person.genome.generation, 'genome.generation')); this.setI(slot, I.mutations, int32(person.genome.mutations, 'genome.mutations'));
    if ('lastInvention' in person) { flags |= FLAG.lastInvention; this.setF(slot, F.lastInvention, num(person.lastInvention, 'lastInvention')); }
    if (person.home) { flags |= FLAG.home; this.setF(slot, F.homeX, num(person.home.x, 'home.x')); this.setF(slot, F.homeY, num(person.home.y, 'home.y')); this.setF(slot, F.homeQuality, num(person.home.quality, 'home.quality')); this.setF(slot, F.homeObservedAt, num(person.home.observedAt, 'home.observedAt')); }
    if (person.waterMemory) { flags |= FLAG.waterMemory; this.setF(slot, F.waterX, num(person.waterMemory.x, 'waterMemory.x')); this.setF(slot, F.waterY, num(person.waterMemory.y, 'waterMemory.y')); }
    if (person.conflictMemory) { flags |= FLAG.conflictMemory; this.setF(slot, F.conflictX, num(person.conflictMemory.x, 'conflictMemory.x')); this.setF(slot, F.conflictY, num(person.conflictMemory.y, 'conflictMemory.y')); this.setF(slot, F.conflictTick, num(person.conflictMemory.tick, 'conflictMemory.tick')); }
    // visited: pares Int32, en el orden del array.
    this.setI(slot, I.visitedStart, this.visitedUsed); this.setI(slot, I.visitedCount, person.visited.length);
    for (const entry of person.visited) {
      const match = /^(-?\d+),(-?\d+)$/.exec(entry);
      if (!match) throw new RangeError(`Persona no representable en el SoA: visited «${entry}» no es un par entero.`);
      this.visited = i32(this.visited, (this.visitedUsed + 1) * 2);
      this.visited[this.visitedUsed * 2] = Number(match[1]); this.visited[this.visitedUsed * 2 + 1] = Number(match[2]); this.visitedUsed++;
    }
    this.packRecord(this.skills, slot, I.skillsStart, I.skillsCount, person.skills, 'skills');
    this.packRecord(this.activity, slot, I.activityStart, I.activityCount, person.activity, 'activity');
    this.packRecord(this.values, slot, I.valuesStart, I.valuesCount, person.values, 'values');
    this.packRecord(this.bonds, slot, I.bondsStart, I.bondsCount, person.bonds, 'bonds');
    // Experiencias en piscina: tick + tres cadenas internadas por experiencia.
    this.setI(slot, I.expStart, this.expUsed); this.setI(slot, I.expCount, person.experiences.length);
    for (const experience of person.experiences) {
      this.expInts = i32(this.expInts, (this.expUsed + 1) * 4); const base = this.expUsed * 4;
      this.expInts[base] = int32(experience.tick, 'experiences.tick'); this.expInts[base + 1] = str(experience.text, 'experiences.text');
      this.expInts[base + 2] = str(experience.causeId, 'experiences.causeId'); this.expInts[base + 3] = str(experience.placeId, 'experiences.placeId'); this.expUsed++;
    }
    // Hábitos y su evidencia en piscinas.
    this.setI(slot, I.habitStart, this.habitUsed); this.setI(slot, I.habitCount, person.habits.length);
    for (const habit of person.habits) {
      this.habitInts = i32(this.habitInts, (this.habitUsed + 1) * 7); this.habitFloats = f64(this.habitFloats, this.habitUsed + 1);
      const base = this.habitUsed * 7;
      this.habitInts[base] = str(habit.placeId, 'habits.placeId'); this.habitInts[base + 1] = str(habit.demonstrator, 'habits.demonstrator');
      this.habitInts[base + 2] = str(habit.sourceEvent, 'habits.sourceEvent'); this.habitInts[base + 3] = int32(habit.observations, 'habits.observations');
      this.habitInts[base + 4] = int32(habit.repetitions, 'habits.repetitions'); this.habitInts[base + 5] = this.evidenceUsed; this.habitInts[base + 6] = habit.evidence.length;
      this.habitFloats[this.habitUsed] = num(habit.strength, 'habits.strength'); this.habitUsed++;
      for (const evidence of habit.evidence) {
        this.evidenceInts = i32(this.evidenceInts, (this.evidenceUsed + 1) * 4); this.evidenceFloats = f64(this.evidenceFloats, this.evidenceUsed + 1);
        const ebase = this.evidenceUsed * 4;
        this.evidenceInts[ebase] = str(evidence.eventId, 'habits.evidence.eventId'); this.evidenceInts[ebase + 1] = int32(evidence.tick, 'habits.evidence.tick');
        this.evidenceInts[ebase + 2] = str(evidence.demonstrator, 'habits.evidence.demonstrator'); this.evidenceInts[ebase + 3] = str(evidence.recipient, 'habits.evidence.recipient');
        this.evidenceFloats[this.evidenceUsed] = num(evidence.food, 'habits.evidence.food'); this.evidenceUsed++;
      }
    }
    this.packTechnology(slot, person, str, spill, flags => { flagsHolder.value = flags; });
    // Las banderas de tecnología se suman dentro de packTechnology vía el titular.
    flags |= flagsHolder.value;
    if (spill.extras || spill.project !== undefined) { flags |= FLAG.spill; this.setI(slot, I.spill, this.spillRefs.length); this.spillRefs.push(spill); }
    else this.setI(slot, I.spill, -1);
    this.flags[slot] = flags;
  }

  private packTechnology(slot: number, person: Person, str: (value: unknown, field: string) => number,
    spill: { project?: unknown }, applyFlags: (flags: number) => void): void {
    let flags = 0;
    const technology = person.technology;
    this.setI(slot, I.knownStart, this.knownUsed); this.setI(slot, I.knownCount, technology.knownRecipes.length);
    for (const id of technology.knownRecipes) { this.known = i32(this.known, this.knownUsed + 1); this.known[this.knownUsed++] = str(id, 'technology.knownRecipes'); }
    this.setI(slot, I.learnedStart, this.learnedUsed); this.setI(slot, I.learnedCount, technology.learnedFrom.length);
    for (const learned of technology.learnedFrom) {
      this.learned = i32(this.learned, (this.learnedUsed + 1) * 3); const base = this.learnedUsed * 3;
      this.learned[base] = str(learned.recipeId, 'technology.learnedFrom.recipeId'); this.learned[base + 1] = str(learned.teacherId, 'technology.learnedFrom.teacherId');
      this.learned[base + 2] = int32(learned.tick, 'technology.learnedFrom.tick'); this.learnedUsed++;
    }
    this.setI(slot, I.itemsStart, this.itemUsed); this.setI(slot, I.itemsCount, technology.items.length);
    for (const item of technology.items) {
      this.itemInts = i32(this.itemInts, (this.itemUsed + 1) * 7); this.itemFloats = f64(this.itemFloats, (this.itemUsed + 1) * 19); this.itemFlags = u8(this.itemFlags, this.itemUsed + 1);
      const base = this.itemUsed * 7, fbase = this.itemUsed * 19;
      this.itemInts[base] = str(item.id, 'technology.items.id'); this.itemInts[base + 1] = item.recipeId === null ? -1 : str(item.recipeId, 'technology.items.recipeId');
      this.itemInts[base + 2] = int32(item.generation, 'technology.items.generation'); this.itemInts[base + 3] = int32(item.madeAt, 'technology.items.madeAt');
      this.itemInts[base + 4] = this.parentsUsed; this.itemInts[base + 5] = item.parentItems.length;
      this.itemInts[base + 6] = item.contents ? int32(item.contents.lastTick, 'technology.items.contents.lastTick') : 0;
      this.itemFlags[this.itemUsed] = item.contents ? 1 : 0;
      this.itemFloats[fbase] = num(item.composition.wood, 'composition.wood'); this.itemFloats[fbase + 1] = num(item.composition.stone, 'composition.stone');
      this.itemFloats[fbase + 2] = num(item.composition.water, 'composition.water'); this.itemFloats[fbase + 3] = num(item.mass, 'items.mass');
      this.itemFloats[fbase + 4] = num(item.initialMass, 'items.initialMass');
      for (let n = 0; n < PROPERTIES.length; n++) this.itemFloats[fbase + 5 + n] = num(item.properties[PROPERTIES[n]!], `properties.${PROPERTIES[n]}`);
      this.itemFloats[fbase + 17] = item.contents ? num(item.contents.water, 'contents.water') : 0;
      this.itemFloats[fbase + 18] = item.contents ? num(item.contents.leakRemainder, 'contents.leakRemainder') : 0;
      this.itemUsed++;
      for (const parent of item.parentItems) { this.parents = i32(this.parents, this.parentsUsed + 1); this.parents[this.parentsUsed++] = str(parent, 'technology.items.parentItems'); }
    }
    // Competencia: registro con orden explícito, como skills.
    this.setI(slot, I.competenceStart, this.competenceUsed);
    const competence = Object.entries(technology.competence);
    this.setI(slot, I.competenceCount, competence.length);
    for (let order = 0; order < competence.length; order++) {
      const [key, value] = competence[order]!;
      this.competenceKeys = i32(this.competenceKeys, this.competenceUsed + 1); this.competenceOrders = i32(this.competenceOrders, this.competenceUsed + 1);
      this.competenceInts = i32(this.competenceInts, (this.competenceUsed + 1) * 2); this.competenceFloats = f64(this.competenceFloats, (this.competenceUsed + 1) * 2);
      this.competenceKeys[this.competenceUsed] = str(key, 'technology.competence'); this.competenceOrders[this.competenceUsed] = order;
      this.competenceInts[this.competenceUsed * 2] = int32(value.attempts, 'competence.attempts'); this.competenceInts[this.competenceUsed * 2 + 1] = int32(value.successes, 'competence.successes');
      this.competenceFloats[this.competenceUsed * 2] = num(value.work, 'competence.work'); this.competenceFloats[this.competenceUsed * 2 + 1] = num(value.benefit, 'competence.benefit');
      this.competenceUsed++;
    }
    if (technology.project !== null) spill.project = technology.project;
    if ('waterActionAt' in technology) { flags |= FLAG.waterAction; this.setF(slot, F.waterActionAt, num(technology.waterActionAt, 'technology.waterActionAt')); }
    if ('waterCarryAt' in technology) { flags |= FLAG.waterCarry; this.setF(slot, F.waterCarryAt, num(technology.waterCarryAt, 'technology.waterCarryAt')); }
    if (technology.waterPreparation) {
      flags |= FLAG.waterPrep;
      this.setI(slot, I.prepItem, str(technology.waterPreparation.itemId, 'technology.waterPreparation.itemId'));
      this.setF(slot, F.prepInitial, num(technology.waterPreparation.initialQuanta, 'waterPreparation.initialQuanta'));
      this.setF(slot, F.prepTarget, num(technology.waterPreparation.targetQuanta, 'waterPreparation.targetQuanta'));
      this.setF(slot, F.prepSourceX, num(technology.waterPreparation.sourceX, 'waterPreparation.sourceX'));
      this.setF(slot, F.prepSourceY, num(technology.waterPreparation.sourceY, 'waterPreparation.sourceY'));
      this.setF(slot, F.prepStartedAt, num(technology.waterPreparation.startedAt, 'waterPreparation.startedAt'));
    }
    applyFlags(flags);
  }

  unpack(): Person[] { return Array.from({ length: this.loaded }, (_, slot) => this.unpackPerson(slot)); }

  unpackPerson(slot: number): Person {
    if (slot < 0 || slot >= this.loaded) throw new RangeError(`Slot de persona fuera de rango: ${slot}.`);
    const flags = this.flags[slot]!, get = (col: number): number => this.getF(slot, col), ref = (col: number): string => this.strings.get(this.getI(slot, col));
    const spill = (flags & FLAG.spill) ? this.spillRefs[this.getI(slot, I.spill)] as { project?: unknown; extras?: Record<string, unknown> } : undefined;
    const visited: string[] = [];
    const vstart = this.getI(slot, I.visitedStart), vcount = this.getI(slot, I.visitedCount);
    for (let n = 0; n < vcount; n++) visited.push(`${this.visited[(vstart + n) * 2]},${this.visited[(vstart + n) * 2 + 1]}`);
    const experiences: Person['experiences'] = [];
    const estart = this.getI(slot, I.expStart), ecount = this.getI(slot, I.expCount);
    for (let n = 0; n < ecount; n++) { const base = (estart + n) * 4; experiences.push({ tick: this.expInts[base]!, text: this.strings.get(this.expInts[base + 1]!), causeId: this.strings.get(this.expInts[base + 2]!), placeId: this.strings.get(this.expInts[base + 3]!) }); }
    const habits: Person['habits'] = [];
    const hstart = this.getI(slot, I.habitStart), hcount = this.getI(slot, I.habitCount);
    for (let n = 0; n < hcount; n++) {
      const base = (hstart + n) * 7, evStart = this.habitInts[base + 5]!, evCount = this.habitInts[base + 6]!, evidence: Person['habits'][number]['evidence'] = [];
      for (let e = 0; e < evCount; e++) { const ebase = (evStart + e) * 4; evidence.push({ eventId: this.strings.get(this.evidenceInts[ebase]!), tick: this.evidenceInts[ebase + 1]!, demonstrator: this.strings.get(this.evidenceInts[ebase + 2]!), recipient: this.strings.get(this.evidenceInts[ebase + 3]!), food: this.evidenceFloats[evStart + e]! }); }
      habits.push({ placeId: this.strings.get(this.habitInts[base]!), observations: this.habitInts[base + 3]!, strength: this.habitFloats[hstart + n]!, demonstrator: this.strings.get(this.habitInts[base + 1]!), sourceEvent: this.strings.get(this.habitInts[base + 2]!), repetitions: this.habitInts[base + 4]!, evidence });
    }
    const person = {
      id: ref(I.id), name: ref(I.name), role: ROLES[this.getU(slot, 0)]!, x: get(F.x), y: get(F.y), color: ref(I.color),
      action: ACTIONS[this.getU(slot, 1)]!, reason: ref(I.reason), energy: get(F.energy), hunger: get(F.hunger), fatigue: get(F.fatigue),
      need: ref(I.need), ...(flags & FLAG.recentMemory ? { recentMemory: this.getI(slot, I.recentMemory) < 0 ? null : ref(I.recentMemory) } : {}),
      inventory: get(F.inventory), curiosity: get(F.curiosity), sociability: get(F.sociability), generosity: get(F.generosity),
      closeness: get(F.closeness), socialLoad: get(F.socialLoad), target: { x: get(F.targetX), y: get(F.targetY) },
      decisionAt: get(F.decisionAt), lastMeeting: get(F.lastMeeting), lastShared: get(F.lastShared), experiences, habits,
      traits: { curiosity: get(F.trait0), sociability: get(F.trait1), industriousness: get(F.trait2), care: get(F.trait3), resilience: get(F.trait4) },
      skills: this.unpackRecord(this.skills, slot, I.skillsStart, I.skillsCount),
      materials: { wood: get(F.wood), stone: get(F.stone) },
      activity: this.unpackRecord(this.activity, slot, I.activityStart, I.activityCount),
      values: this.unpackRecord(this.values, slot, I.valuesStart, I.valuesCount), visited, heading: get(F.heading),
      command: this.getU(slot, 4) === 0 ? null : { order: ORDERS[this.getU(slot, 4) - 1] as Person['command'] extends { order: infer O } | null ? O : never, x: get(F.commandX), y: get(F.commandY) },
      work: get(F.work), lastOutcome: get(F.lastOutcome), intentContext: INTENTS[this.getU(slot, 2)]!, controlMode: MODES[this.getU(slot, 3)]!,
      ...(flags & FLAG.thirst ? { thirst: get(F.thirst) } : {}),
      genome: { alleles: Array.from({ length: 14 }, (_, n) => get(F.allele0 + n)), generation: this.getI(slot, I.generation),
        parents: Array.from({ length: this.getI(slot, I.parentCount) }, (_, n) => this.strings.get(this.getI(slot, n === 0 ? I.parent0 : I.parent1))),
        mutations: this.getI(slot, I.mutations), learningRate: get(F.learningRate), cooperation: get(F.cooperation) },
      bornAt: get(F.bornAt), lastBirth: get(F.lastBirth), lastSocial: get(F.lastSocial), lastDispute: get(F.lastDispute), lastPracticeMemory: get(F.lastPracticeMemory),
      culture: { sharing: get(F.culture0), stewardship: get(F.culture1), openness: get(F.culture2) },
      ...(flags & FLAG.community ? { communityId: this.getI(slot, I.community) < 0 ? null : ref(I.community) } : {}),
      bonds: this.unpackRecord(this.bonds, slot, I.bondsStart, I.bondsCount),
      technology: this.unpackTechnology(slot, flags, spill),
      demography: { age: get(F.demographyAge), health: get(F.health), vitality: get(F.vitality), deathCause: DEATHS[this.getU(slot, 5)] as Person['demography']['deathCause'] },
      ...(flags & FLAG.blueprint ? { blueprintId: this.getI(slot, I.blueprint) < 0 ? null : ref(I.blueprint) } : {}),
      ...(flags & FLAG.lastInvention ? { lastInvention: get(F.lastInvention) } : {}),
      ...(flags & FLAG.home ? { home: { x: get(F.homeX), y: get(F.homeY), quality: get(F.homeQuality), observedAt: get(F.homeObservedAt) } } : {}),
      ...(flags & FLAG.waterMemory ? { waterMemory: { x: get(F.waterX), y: get(F.waterY) } } : {}),
      ...(flags & FLAG.conflictMemory ? { conflictMemory: { x: get(F.conflictX), y: get(F.conflictY), tick: get(F.conflictTick) } } : {}),
      ...(spill?.extras ?? {}),
    } as unknown as Person;
    return person;
  }

  private unpackTechnology(slot: number, flags: number, spill: { project?: unknown } | undefined): Person['technology'] {
    const knownRecipes: string[] = [];
    const kstart = this.getI(slot, I.knownStart), kcount = this.getI(slot, I.knownCount);
    for (let n = 0; n < kcount; n++) knownRecipes.push(this.strings.get(this.known[kstart + n]!));
    const learnedFrom: Person['technology']['learnedFrom'] = [];
    const lstart = this.getI(slot, I.learnedStart), lcount = this.getI(slot, I.learnedCount);
    for (let n = 0; n < lcount; n++) { const base = (lstart + n) * 3; learnedFrom.push({ recipeId: this.strings.get(this.learned[base]!), teacherId: this.strings.get(this.learned[base + 1]!), tick: this.learned[base + 2]! }); }
    const items: Person['technology']['items'] = [];
    const istart = this.getI(slot, I.itemsStart), icount = this.getI(slot, I.itemsCount);
    for (let n = 0; n < icount; n++) {
      const index = istart + n, base = index * 7, fbase = index * 19, pstart = this.itemInts[base + 4]!, pcount = this.itemInts[base + 5]!;
      const parentItems = Array.from({ length: pcount }, (_, p) => this.strings.get(this.parents[pstart + p]!));
      const properties = Object.fromEntries(PROPERTIES.map((key, p) => [key, this.itemFloats[fbase + 5 + p]!])) as unknown as Person['technology']['items'][number]['properties'];
      items.push({ id: this.strings.get(this.itemInts[base]!), recipeId: this.itemInts[base + 1]! < 0 ? null : this.strings.get(this.itemInts[base + 1]!),
        composition: { wood: this.itemFloats[fbase]!, stone: this.itemFloats[fbase + 1]!, water: this.itemFloats[fbase + 2]! },
        mass: this.itemFloats[fbase + 3]!, properties, generation: this.itemInts[base + 2]!, madeAt: this.itemInts[base + 3]!, parentItems,
        initialMass: this.itemFloats[fbase + 4]!,
        ...(this.itemFlags[index] ? { contents: { version: 1 as const, water: this.itemFloats[fbase + 17]!, leakRemainder: this.itemFloats[fbase + 18]!, lastTick: this.itemInts[base + 6]! } } : {}) });
    }
    const competence: Person['technology']['competence'] = {};
    const cstart = this.getI(slot, I.competenceStart), ccount = this.getI(slot, I.competenceCount), centries: [number, number][] = [];
    for (let n = 0; n < ccount; n++) centries.push([this.competenceOrders[cstart + n]!, cstart + n]);
    for (const [, index] of centries.sort((a, b) => a[0] - b[0])) {
      competence[this.strings.get(this.competenceKeys[index]!)] = { attempts: this.competenceInts[index * 2]!, successes: this.competenceInts[index * 2 + 1]!, work: this.competenceFloats[index * 2]!, benefit: this.competenceFloats[index * 2 + 1]! };
    }
    return { knownRecipes, items, residue: { wood: this.getF(slot, F.residueWood), stone: this.getF(slot, F.residueStone), water: this.getF(slot, F.residueWater) },
      attempts: this.getF(slot, F.techAttempts), lastAttempt: this.getF(slot, F.techLastAttempt),
      project: (spill && 'project' in spill ? spill.project : null) as Person['technology']['project'], learnedFrom, competence,
      ...(flags & FLAG.waterAction ? { waterActionAt: this.getF(slot, F.waterActionAt) } : {}),
      ...(flags & FLAG.waterCarry ? { waterCarryAt: this.getF(slot, F.waterCarryAt) } : {}),
      ...(flags & FLAG.waterPrep ? { waterPreparation: { itemId: this.strings.get(this.getI(slot, I.prepItem)), sourceX: this.getF(slot, F.prepSourceX), sourceY: this.getF(slot, F.prepSourceY), initialQuanta: this.getF(slot, F.prepInitial), targetQuanta: this.getF(slot, F.prepTarget), startedAt: this.getF(slot, F.prepStartedAt) } } : {}) };
  }
}

// Titular mutable para recoger las banderas que `packTechnology` calcula dentro de `packPerson`.
const flagsHolder = { value: 0 };
