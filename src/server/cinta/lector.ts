import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CINTA, type Bifurcacion, type ChunkReq, type ChunkResp, type CintaMeta, type Laguna, type Nivel, type SeriePunto } from '../../shared/cinta.js';
import { applyClientTapeDelta, type TapeClientDelta, type TapeEntityPatch } from '../../shared/tape-delta.js';
import type { TapeChunkEncoding, TapeChunkResponse, TapeMetaResponse, TapeTimelinePoint } from '../../shared/tape.js';
import type { Tile, Viewport, WorldView } from '../../shared/types.js';
import { phaseAt } from '../../world/mundo/crear.js';
import { TICKS_PER_DAY } from '../../world/mundo/tipos.js';
import { INDICE_CINTA, NIVELES, rutaSegmento, VERSION_CATALOGO } from './catalogo.js';
import { cabeceraCoincide, clientDelta, leerIndiceBloque, leerMarcoJson, sectoresVisibles, type IndiceBloque, type LeerBytes, type LeerTesela } from './formato.js';
import { reducirTesela } from './reducir.js';

/** Memoria de índices por lector (cinta-sonnet §6). */
export const CACHE_BYTES = 256 * 1024 ** 2;
/** Bytes por respuesta: una parte que lo pasaría no entra y el resto sigue con `hayMas`. Lo que lleva hasta el primer
 * fotograma ≥ t entra siempre, o el cliente no avanzaría. */
export const TOPE_RESPUESTA = 8 * 1024 ** 2;
const PUNTOS_SERIE = 400;

/** Pinta en el tick `t` lo que la cinta no grabó dentro de la cámara (terreno archivado o sin generar). */
export type Fondo = (x: number, y: number, t: number) => Tile | undefined;

interface Bloque { segmento: number; epoca: number; nivel: Nivel; t0: number; t1: number; offset: number; bytes: number; fotogramas: number; crc: number }
/** `fin`: el tick desde el que manda una época posterior (exclusivo). Lo que la época grabó desde ahí es huérfano. */
interface Epoca { id: number; instanciaId: string; tMundo: number; t1: number; fin: number }
/** Bloques seguidos de un nivel en una época, sin laguna ni hueco de la poda entre ellos: posiciones [i0, i1]. */
interface Intervalo { i0: number; i1: number; t0: number; t1: number }
interface Pista { bloques: Bloque[]; intervalos: Intervalo[] }
interface Sitio { e: Epoca; nivel: Nivel; iv: Intervalo }
interface Fotograma { vista: WorldView; teselas: Map<string, string>; delta?: TapeClientDelta; cambiadas?: Map<string, string> }
/** `contados`: fotogramas ≥ `desde`; `ultimo` es -1 si el tramo salió vacío. */
interface Tramo { base?: string; partes: string[]; t0: number; t1: number; ultimo: number; contados: number }
interface OpcionesTramo { clave: boolean; n: number; hasta: number; camara?: Viewport; fondo?: Fondo; completos?: boolean }

const PISTA_VACIA: Pista = { bloques: [], intervalos: [] };
/** Un error que se arregla releyendo el catálogo: el bloque ya no es el que el índice describe. */
const cambiada = (mensaje: string): Error => Object.assign(new Error(mensaje), { code: 'ESTALE' });

/**
 * Parche de una lista recortada a partir del grabado para el mundo entero: quien sigue a la vista lleva el mismo cambio,
 * quien entra va entero y quien sale se quita. Evita comparar campo a campo miles de entidades en cada fotograma.
 */
function parcheRecortado<T extends { id: string }>(antes: readonly T[], ahora: readonly T[], grabado?: TapeEntityPatch<T>): TapeEntityPatch<T> {
  const previos = new Set<string>(), actuales = new Set<string>();
  for (const v of antes) previos.add(v.id);
  for (const v of ahora) actuales.add(v.id);
  const upserts: TapeEntityPatch<T>['upserts'] = [], removed: string[] = [], natural: string[] = [];
  for (const u of grabado?.upserts ?? []) if (previos.has(u.id) && actuales.has(u.id)) upserts.push(u);
  for (const v of antes) if (actuales.has(v.id)) natural.push(v.id); else removed.push(v.id);
  for (const v of ahora) if (!previos.has(v.id)) { upserts.push(v); natural.push(v.id); }
  const r: TapeEntityPatch<T> = { upserts, removed };
  if (natural.some((id, i) => id !== ahora[i]!.id)) r.order = ahora.map(v => v.id);
  return r;
}

const RECORTE_RAPIDO = ['people', 'animals'] as const;

/** Durante un tramo se serializa cada vista antes de avanzar el mapa de entidades. */
class Entidades<T extends { id: string }> {
  private valores = new Map<string, T>();

  constructor(valores: readonly T[] = []) {
    for (const v of valores) this.valores.set(v.id, v);
  }

  aplicar(p: TapeEntityPatch<T>): T[] {
    for (const id of p.removed) this.valores.delete(id);
    for (const u of p.upserts) {
      if ('_p' in u && u._p === 1) {
        const v = (this.valores.get(u.id) ?? { id: u.id }) as Record<string, unknown>;
        for (const k in u) if (k !== '_p' && k !== '_u') v[k] = u[k];
        for (const k of u._u as string[] ?? []) delete v[k];
        this.valores.set(u.id, v as T);
      } else this.valores.set(u.id, u as T);
    }
    if (p.order) {
      const orden = new Map<string, T>();
      for (const id of p.order) {
        const v = this.valores.get(id);
        if (v) orden.set(id, v);
      }
      this.valores = orden;
    }
    return [...this.valores.values()];
  }
}

/** `clientDelta` entre dos cabeceras recortadas; personas y animales salen del delta grabado si lo hay. */
function deltaRecortado(previa: WorldView, actual: WorldView, grabado?: TapeClientDelta): TapeClientDelta {
  if (!grabado) return clientDelta(previa, actual);
  const listas = RECORTE_RAPIDO.filter(k => previa[k] && actual[k]);
  const vacias = Object.fromEntries(listas.map(k => [k, []]));
  const delta = clientDelta({ ...previa, ...vacias }, { ...actual, ...vacias });
  for (const k of listas) {
    const p = parcheRecortado<{ id: string }>(previa[k]!, actual[k]!, grabado[`${k}Patch`]);
    if (p.upserts.length || p.removed.length || p.order) (delta as Record<string, unknown>)[`${k}Patch`] = p;
  }
  return delta;
}

/** Recorta la cabecera. Las teselas conservan su JSON hasta formar la respuesta. */
function proyectar(vista: WorldView, camara?: Viewport): WorldView {
  const r: WorldView = { ...vista };
  delete (r as unknown as Record<string, unknown>).seed;
  if (!camara) return r;
  const { x, y, width, height } = camara;
  const visible = (p: { x: number; y: number }, margen = 0): boolean => p.x >= x - margen && p.y >= y - margen
    && p.x < x + width + margen && p.y < y + height + margen;
  r.originX = x; r.originY = y; r.width = width; r.height = height;
  r.people = r.people.filter(p => visible(p, 1));
  const ids = new Set(r.people.map(p => p.id));
  if (r.animals) r.animals = r.animals.filter(a => visible(a));
  if (r.structures) r.structures = r.structures.filter(s => {
    if (visible(s, 1) || s.cells?.some(c => visible(c, 1))) return true;
    const huella = s.footprint;
    return !!huella && s.x < x + width + 1 && s.y < y + height + 1 && s.x + huella.width > x - 1 && s.y + huella.height > y - 1;
  });
  r.places = r.places.filter(p => visible(p));
  const planos = new Set(r.structures?.map(s => s.blueprintId));
  if (r.blueprints) r.blueprints = r.blueprints.filter(b => planos.has(b.id));
  if (r.communities) r.communities = r.communities.map(c => ({ ...c, members: c.members.filter(id => ids.has(id)) }));
  if (r.technology) {
    r.technology = { ...r.technology, items: r.technology.items.filter(i => ids.has(i.ownerId)) };
    if (r.technology.knowledge) r.technology.knowledge = r.technology.knowledge.filter(k => ids.has(k.actorId));
  }
  return r;
}

/** JSON de un objeto con un campo más al final, ya serializado aparte (base y deltas se miden al serializarse). */
function conCampos(sobre: object, extra: string): string {
  const json = JSON.stringify(sobre);
  return json.length > 2 ? `${json.slice(0, -1)},${extra}}` : `{${extra}}`;
}

/** Última posición de `lista` cuyo valor es ≤ `t`, o -1. */
function ultimoHasta<T>(lista: readonly T[], t: number, valor: (v: T) => number): number {
  let lo = 0, hi = lista.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (valor(lista[m]!) <= t) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

/**
 * Lector de la cinta (cinta-sonnet §3, «Lectura y salto»): índice de bloques en RAM que se pone al día con lo que
 * confirma el escritor, búsqueda binaria por tick y caché LRU de índices CNT2. Es síncrono: corre en los
 * hilos de `lector-worker.ts`, nunca en el del HTTP. Con `instancia`, una cinta de otro mundo se lee como vacía.
 */
export class LectorCinta {
  private db?: DatabaseSync;
  private ino = -1;
  private version = -1;
  private ultimoRowid = 0;
  private epocas: Epoca[] = [];
  private segmentos = new Map<number, { nivel: Nivel; bytes: number }>();
  /** Por época, una pista por nivel. */
  private indice = new Map<number, Pista[]>();
  private lagunas: (Laguna & { epoca: number })[] = [];
  private lagunasPoda: (Laguna & { epoca: number; nivel: Nivel })[] = [];
  private cuarentena: (Laguna & { epoca: number; nivel: Nivel })[] = [];
  private bifurcaciones: Bifurcacion[] = [];
  private readonly cache = new Map<string, { indice: IndiceBloque; coste: number }>();
  private cacheUsado = 0;
  /** Último fotograma antes de `fin` de un bloque que lo cruza, que solo se sabe decodificándolo. */
  private readonly bordes = new Map<string, number>();

  constructor(readonly directorio: string, private readonly cacheBytes = CACHE_BYTES) {}

  private olvidar(): void {
    try { this.db?.close(); } finally {
      this.db = undefined; this.ino = -1; this.version = -1; this.ultimoRowid = 0;
      this.epocas = []; this.segmentos.clear(); this.indice.clear(); this.lagunas = []; this.bifurcaciones = [];
      this.lagunasPoda = [];
      this.cuarentena = [];
      this.cache.clear(); this.cacheUsado = 0; this.bordes.clear();
    }
  }

  /** Pone el índice al día. Falso mientras la cinta no tiene catálogo o es de otra instancia del mundo. */
  private refrescar(instancia?: string): boolean {
    const ruta = join(this.directorio, INDICE_CINTA);
    const ino = statSync(ruta, { throwIfNoEntry: false })?.ino;
    // Otra instancia del mundo aparta la cinta entera y empieza una nueva en el mismo sitio.
    if (ino !== this.ino) {
      this.olvidar();
      if (ino === undefined) return false;
      const db = new DatabaseSync(ruta, { readOnly: true });
      try {
        db.exec('PRAGMA busy_timeout=5000');
        const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
        if (version === 0) { db.close(); return false; }
        if (version !== VERSION_CATALOGO) throw new Error(`Versión de catálogo de cinta incompatible: ${version}.`);
      } catch (error) { db.close(); throw error; }
      this.db = db; this.ino = ino;
    }
    const db = this.db!;
    db.exec('BEGIN');
    try {
      const version = Number(db.prepare('PRAGMA data_version').get()!.data_version);
      if (version !== this.version) { this.cargar(db); this.version = version; }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); this.version = -1; throw error; }
    return instancia === undefined || this.epocas[0]?.instanciaId === instancia;
  }

  private cargar(db: DatabaseSync): void {
    const epocas = db.prepare('SELECT id,instanciaId,tMundo,t1 FROM epocas ORDER BY id').all() as unknown as Epoca[];
    let fin = Infinity;
    for (let i = epocas.length - 1; i >= 0; i--) { epocas[i]!.fin = fin; fin = Math.min(fin, epocas[i]!.tMundo); }
    this.epocas = epocas;
    const vivos = new Map((db.prepare('SELECT id,nivel,bytes FROM segmentos').all() as { id: number; nivel: Nivel; bytes: number }[])
      .map(s => [s.id, { nivel: s.nivel, bytes: s.bytes }]));
    const cuarentena = db.prepare("SELECT 1 FROM sqlite_master WHERE name='cuarentena'").get()
      ? db.prepare('SELECT epoca,nivel,t0,t1 FROM cuarentena ORDER BY t0').all() as unknown as typeof this.cuarentena : [];
    // La fila más nueva es del último segmento de su nivel, que la poda nunca borra: si baja, el catálogo es otro.
    const maximo = Number(db.prepare('SELECT coalesce(max(rowid),0) AS r FROM bloques').get()!.r);
    if (maximo < this.ultimoRowid || cuarentena.length !== this.cuarentena.length) {
      this.indice.clear(); this.ultimoRowid = 0;
    }
    else if ([...this.segmentos.keys()].some(id => !vivos.has(id))) {
      for (const pistas of this.indice.values()) for (const p of pistas) p.bloques = p.bloques.filter(b => vivos.has(b.segmento));
    }
    this.segmentos = vivos;
    this.cuarentena = cuarentena;
    // El escritor añade los bloques de cada época y nivel en orden de tick, así que el rowid conserva ese orden.
    const sinAislados = cuarentena.length
      ? 'AND NOT EXISTS (SELECT 1 FROM cuarentena c WHERE c.segmento=b.segmento AND c.offset=b.offset)' : '';
    const nuevos = db.prepare(`SELECT segmento,epoca,nivel,t0,t1,offset,bytes,fotogramas,crc FROM bloques b
      WHERE rowid>? ${sinAislados} ORDER BY rowid`).all(this.ultimoRowid) as unknown as Bloque[];
    for (const b of nuevos) {
      let pistas = this.indice.get(b.epoca);
      if (!pistas) this.indice.set(b.epoca, pistas = NIVELES.map(() => ({ bloques: [], intervalos: [] })));
      pistas[b.nivel]!.bloques.push(b);
    }
    this.ultimoRowid = maximo;
    this.lagunas = db.prepare('SELECT epoca,t0,t1 FROM lagunas ORDER BY t0').all().map(l => ({ ...l })) as unknown as (Laguna & { epoca: number })[];
    this.lagunasPoda = db.prepare('SELECT epoca,nivel,t0,t1 FROM lagunas_poda ORDER BY t1').all() as unknown as typeof this.lagunasPoda;
    this.bifurcaciones = db.prepare('SELECT epoca,desde,hasta,motivo FROM bifurcaciones ORDER BY epoca').all()
      .map(b => ({ ...b })) as unknown as Bifurcacion[];
    for (const [epoca, pistas] of this.indice) pistas.forEach((p, nivel) => { p.intervalos = this.intervalos(epoca, nivel as Nivel, p.bloques); });
  }

  /** Cada laguna de poda corta solo la pista que perdió los segmentos. */
  private intervalos(epoca: number, nivel: Nivel, bloques: readonly Bloque[]): Intervalo[] {
    const lagunas = this.lagunas.filter(l => l.epoca === epoca)
      .concat(this.lagunasPoda.filter(l => l.epoca === epoca && l.nivel === nivel),
        this.cuarentena.filter(l => l.epoca === epoca && l.nivel === nivel)).sort((a, b) => a.t0 - b.t0);
    let cursor = 0, finLaguna = -Infinity;
    const r: Intervalo[] = [];
    bloques.forEach((b, i) => {
      const a = bloques[i - 1], ultimo = r.at(-1);
      while (cursor < lagunas.length && lagunas[cursor]!.t0 < b.t0) finLaguna = Math.max(finLaguna, lagunas[cursor++]!.t1);
      if (a && ultimo && finLaguna <= a.t1) { ultimo.i1 = i; ultimo.t1 = b.t1; }
      else r.push({ i0: i, i1: i, t0: b.t0, t1: b.t1 });
    });
    return r;
  }

  /** Un segmento podado o apartado entre la carga del índice y la lectura: se recarga el índice y se intenta otra vez. */
  private reintentar<T>(leer: () => T): T {
    try { return leer(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESTALE') throw error;
      this.version = -1;
      return leer();
    }
  }

  private indiceBloque(b: Bloque, leer: LeerBytes): IndiceBloque {
    const k = `${b.segmento}:${b.offset}`;
    const guardado = this.cache.get(k);
    const indice = guardado?.indice ?? leerIndiceBloque(leer, b.bytes);
    // Con la cinta apartada por otra instancia, el mismo nombre de segmento puede ser ya de la cinta nueva.
    if (indice.crc !== b.crc || indice.nivel !== b.nivel || indice.t0 !== b.t0 || indice.t1 !== b.t1 || indice.fotogramas !== b.fotogramas) {
      throw cambiada(`El bloque ${b.segmento}/${b.offset} no es el del catálogo.`);
    }
    if (guardado) {
      if (!cabeceraCoincide(leer, indice)) {
        this.cache.delete(k); this.cacheUsado -= guardado.coste;
        throw cambiada(`La cabecera del bloque ${k} cambió desde la última lectura.`);
      }
      this.cache.delete(k);
      this.cache.set(k, guardado);
      return indice;
    }
    // El índice retiene solo los descriptores de extensión fija, sin JSON ni cargas comprimidas.
    const coste = indice.bytesIndice * 12;
    if (coste > this.cacheBytes) return indice;
    this.cache.set(k, { indice, coste });
    this.cacheUsado += coste;
    for (const [viejo, { coste: c }] of this.cache) {
      if (this.cacheUsado <= this.cacheBytes) break;
      this.cache.delete(viejo); this.cacheUsado -= c;
    }
    return indice;
  }

  private *abrirBloque(b: Bloque): Generator<{
    indice: IndiceBloque; json: (i: number, sectores?: ReadonlySet<number>, tesela?: LeerTesela) => string;
  }> {
    const fd = openSync(rutaSegmento(this.directorio, b.nivel, b.segmento), 'r');
    const leer: LeerBytes = (offset, bytes) => {
      const datos = Buffer.allocUnsafe(bytes);
      for (let cursor = 0; cursor < bytes;) {
        const n = readSync(fd, datos, cursor, bytes - cursor, b.offset + offset + cursor);
        if (!n) throw cambiada(`Bloque de cinta incompleto: ${b.segmento}/${b.offset}.`);
        cursor += n;
      }
      return datos;
    };
    const protegido = <T>(f: () => T): T => {
      try { return f(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESTALE') throw error;
        throw cambiada(`Bloque de cinta ilegible: ${b.segmento}/${b.offset} (${error instanceof Error ? error.message : error}).`);
      }
    };
    try {
      const indice = protegido(() => this.indiceBloque(b, leer));
      yield { indice, json: (i, sectores, tesela) => protegido(() => leerMarcoJson(indice, i, leer, sectores, tesela)) };
    } finally { closeSync(fd); }
  }

  private pista(epoca: number, nivel: Nivel): Pista { return this.indice.get(epoca)?.[nivel] ?? PISTA_VACIA; }

  /**
   * La época que se ve en `t`: la más nueva que empezó en o antes de `t` (la primera si `t` es anterior). Una restauración
   * puede volver más atrás que la época anterior, así que `tMundo` no crece con la época: no vale una búsqueda binaria.
   */
  private epocaEn(t: number): number {
    let i = this.epocas.length - 1;
    while (i > 0 && this.epocas[i]!.tMundo > t) i--;
    return Math.max(0, i);
  }

  /** Último fotograma de un intervalo; sin `todo`, el último anterior a `fin` (−1 si no tiene ninguno visible). */
  private ultimo(e: Epoca, nivel: Nivel, iv: Intervalo, todo: boolean): number {
    if (todo || iv.t1 < e.fin) return iv.t1;
    if (iv.t0 >= e.fin) return -1;
    const { bloques } = this.pista(e.id, nivel);
    let j = iv.i1;
    while (bloques[j]!.t0 >= e.fin) j--;
    const b = bloques[j]!;
    if (b.t1 < e.fin) return b.t1;
    const k = `${b.segmento}:${b.offset}:${e.fin}`;
    let t = this.bordes.get(k);
    if (t === undefined) {
      for (const { indice } of this.abrirBloque(b)) {
        t = indice.marcos[ultimoHasta(indice.marcos, e.fin - 1, m => m.tick)]!.tick;
      }
      if (t === undefined) throw cambiada('Índice sin fotogramas.');
      this.bordes.set(k, t);
    }
    return t;
  }

  /** El intervalo de un nivel que contiene `t` (sin `todo`, solo su parte visible). */
  private intervaloEn(e: Epoca, nivel: Nivel, t: number, todo: boolean): Intervalo | undefined {
    const { intervalos } = this.pista(e.id, nivel);
    const iv = intervalos[ultimoHasta(intervalos, t, x => x.t0)];
    return iv && t <= this.ultimo(e, nivel, iv, todo) ? iv : undefined;
  }

  /** El primer intervalo de un nivel que empieza después de `t` (sin `todo`, que se vea). */
  private siguiente(e: Epoca, nivel: Nivel, t: number, todo: boolean): Intervalo | undefined {
    const { intervalos } = this.pista(e.id, nivel);
    const iv = intervalos[ultimoHasta(intervalos, t, x => x.t0) + 1];
    return iv && (todo || iv.t0 < e.fin) ? iv : undefined;
  }

  /**
   * Dónde leer `t`: el nivel más fino con un intervalo que contiene `t` en la época que se ve en `t` (o en la pedida);
   * si ninguno, lo primero que haya después, del nivel más fino si empatan.
   */
  private ubicar(t: number, niveles: readonly Nivel[], pedida?: Epoca): Sitio | undefined {
    const todo = !!pedida, epocas = pedida ? [pedida] : this.epocas.slice(this.epocaEn(t));
    const e = epocas[0];
    if (!e) return undefined;
    for (const nivel of niveles) {
      const iv = this.intervaloEn(e, nivel, t, todo);
      if (iv) return { e, nivel, iv };
    }
    let mejor: Sitio | undefined;
    for (const nivel of niveles) for (const x of epocas) {
      const iv = this.siguiente(x, nivel, t, todo);
      if (!iv) continue;
      if (!mejor || iv.t0 < mejor.iv.t0) mejor = { e: x, nivel, iv };
      break;
    }
    return mejor;
  }

  /** Lo visible de un nivel en todas las épocas: del primer al último fotograma que se ve. */
  private cobertura(nivel: Nivel): { t0: number; t1: number; fotogramas: number } | undefined {
    let t0 = Infinity, t1 = -1, fotogramas = 0;
    for (const e of this.epocas) {
      const { bloques, intervalos } = this.pista(e.id, nivel);
      for (const b of bloques) if (b.t0 < e.fin) fotogramas += b.fotogramas;
      for (const iv of intervalos) {
        const ultimo = this.ultimo(e, nivel, iv, false);
        if (ultimo >= 0) { t0 = Math.min(t0, iv.t0); t1 = Math.max(t1, ultimo); }
      }
    }
    return t1 < 0 ? undefined : { t0, t1, fotogramas };
  }

  /** Fotogramas completos de un nivel de los bloques [i, j], sin llegar a `hasta`. Las teselas van aparte. */
  private *recorrer(e: Epoca, nivel: Nivel, i: number, j: number, hasta: number, camara?: Viewport): Generator<Fotograma> {
    const { bloques } = this.pista(e.id, nivel);
    for (let k = i; k <= j; k++) {
      const b = bloques[k]!;
      if (b.t0 >= hasta) return;
      for (const { indice, json } of this.abrirBloque(b)) {
        const visibles = camara && sectoresVisibles(indice, camara);
        const teselas = new Map<string, string>();
        const copiar = (mapa: Map<string, string>): LeerTesela =>
          (x, y, json) => {
            if (camara) {
              const i = Number(x), j = Number(y);
              if (i < camara.x || i >= camara.x + camara.width || j < camara.y || j >= camara.y + camara.height) return;
            }
            mapa.set(`${x},${y}`, json);
          };
        let vista = JSON.parse(json(0, visibles, copiar(teselas))) as WorldView;
        const personas = new Entidades(vista.people);
        let animales = vista.animals && new Entidades(vista.animals);
        yield { vista, teselas };
        for (let m = 1; m < indice.marcos.length; m++) {
          if (indice.marcos[m]!.tick >= hasta) return;
          const cambiadas = new Map<string, string>();
          const delta = JSON.parse(json(m, visibles, copiar(cambiadas))) as TapeClientDelta;
          const { removedTiles, peoplePatch, animalsPatch, ...cabecera } = delta;
          vista = applyClientTapeDelta(vista, cabecera).frame;
          if (peoplePatch) vista.people = personas.aplicar(peoplePatch);
          if (!vista.animals) animales = undefined;
          if (animalsPatch) vista.animals = (animales ??= new Entidades()).aplicar(animalsPatch);
          for (const k of removedTiles ?? []) teselas.delete(k);
          for (const [k, t] of cambiadas) teselas.set(k, t);
          yield { vista, teselas, delta, cambiadas };
        }
      }
    }
  }

  /** El salto dentro de un bloque puede enviar su JSON directamente, sin reconstruir el mundo entero. */
  private tramoCrudo(b: Bloque, desde: number, o: OpcionesTramo): Tramo | undefined {
    if (b.t1 < desde) return undefined;
    for (const { indice, json } of this.abrirBloque(b)) {
      const primero = ultimoHasta(indice.marcos, desde - 1, m => m.tick) + 1;
      const limite = Math.max(primero + 1, o.n);
      if (limite > indice.fotogramas || indice.marcos[primero]!.tick >= o.hasta) return undefined;
      const r: Tramo = { partes: [], t0: b.t0, t1: b.t0, ultimo: b.t0, contados: 0 };
      let bytes = 0;
      for (let i = 0; i < limite; i++) {
        const tick = indice.marcos[i]!.tick;
        if (tick >= o.hasta) break;
        const parte = json(i);
        const medida = Buffer.byteLength(parte);
        if (r.contados && bytes + medida > TOPE_RESPUESTA) break;
        if (!i) r.base = parte;
        else r.partes.push(parte);
        if (tick >= desde) r.contados++;
        bytes += medida;
        r.ultimo = r.t1 = tick;
      }
      return r;
    }
    return undefined;
  }

  /**
   * Serializa un tramo de los bloques [i, j]: una base y deltas que aplica `applyClientTapeDelta`, recortados a la
   * cámara. Con `clave` la base es el fotograma clave del bloque `i` (el primer pintado sale sin aplicar deltas); si
   * no, el primer fotograma ≥ `desde`. `n` y el tope de bytes cuentan todo lo que se envía, pero lo que lleva hasta el
   * primer fotograma ≥ `desde` entra siempre: un bloque tiene 32 fotogramas y `n` llega a 120.
   */
  private tramo(e: Epoca, nivel: Nivel, i: number, j: number, desde: number, o: OpcionesTramo): Tramo {
    if (o.clave && !o.camara && !o.completos) {
      const crudo = this.tramoCrudo(this.pista(e.id, nivel).bloques[i]!, desde, o);
      if (crudo) return crudo;
    }
    const r: Tramo = { partes: [], t0: desde, t1: desde, ultimo: -1, contados: 0 };
    let bytes = 0, enviados = 0;
    let previa: WorldView | undefined, teselasPrevias: Map<string, string> | undefined;
    const visibles = new Map<string, string>();
    for (const f of this.recorrer(e, nivel, i, j, o.hasta, o.camara)) {
      const tick = f.vista.tick;
      if (!previa && !o.clave && tick < desde) continue;
      // Lo huérfano se pinta sobre el archivo que comparte con lo visible: el de su bifurcación.
      const fondo = (x: number, y: number): string | undefined => {
        const t = o.fondo?.(x, y, Math.min(tick, e.fin));
        return t && JSON.stringify(t);
      };
      const cabecera = proyectar(f.vista, o.camara);
      let parte: string;
      if (o.completos || !previa) {
        const { tiles: _, ...base } = cabecera, cam = o.camara;
        const filas: string[] = [];
        if (cam) {
          for (let y = cam.y; y < cam.y + cam.height; y++) for (let x = cam.x; x < cam.x + cam.width; x++) {
            const k = `${x},${y}`, t = f.teselas.get(k) ?? fondo(x, y);
            if (t) { filas.push(t); visibles.set(k, t); }
          }
        } else for (const t of f.teselas.values()) filas.push(t);
        parte = conCampos(base, `"tiles":[${filas.join(',')}]`);
      } else if (!o.camara && f.delta) {
        parte = f.cambiadas!.size ? conCampos(f.delta, `"tilesPatch":[${[...f.cambiadas!.values()].join(',')}]`) : JSON.stringify(f.delta);
      } else if (!o.camara) {
        const teselas = (m: Map<string, string>): Tile[] => [...m.values()].map(t => JSON.parse(t) as Tile);
        parte = JSON.stringify(clientDelta({ ...previa, tiles: teselas(teselasPrevias!) },
          { ...cabecera, tiles: teselas(f.teselas) }));
      } else {
        const delta = deltaRecortado(previa, cabecera, f.delta);
        const cambiadas: string[] = [], quitadas: string[] = [];
        const cambiar = (k: string, t: string) => { cambiadas.push(t); visibles.set(k, t); };
        if (f.delta) {
          if (f.delta.removedTiles?.length) {
            for (const k of f.delta.removedTiles) {
              if (f.cambiadas!.has(k) || !visibles.has(k)) continue;
              const coma = k.indexOf(','), x = Number(k.slice(0, coma)), y = Number(k.slice(coma + 1));
              const t = fondo(x, y);
              if (t) cambiar(k, t);
              else quitadas.push(k);
            }
          }
          for (const [k, t] of f.cambiadas!) cambiar(k, t);
        } else {
          // Cruce de bloque: la clave nueva no trae parche, se compara lo que se ve.
          for (let y = o.camara.y; y < o.camara.y + o.camara.height; y++) for (let x = o.camara.x; x < o.camara.x + o.camara.width; x++) {
            const k = `${x},${y}`, t = f.teselas.get(k) ?? fondo(x, y);
            if (t && t !== visibles.get(k)) cambiar(k, t);
            else if (!t && visibles.has(k)) quitadas.push(k);
          }
        }
        for (const k of quitadas) visibles.delete(k);
        if (quitadas.length) delta.removedTiles = quitadas;
        parte = cambiadas.length ? conCampos(delta, `"tilesPatch":[${cambiadas.join(',')}]`) : JSON.stringify(delta);
      }
      const medida = Buffer.byteLength(parte);
      if (r.contados && bytes + medida > TOPE_RESPUESTA) break;
      if (!o.completos && !previa) r.base = parte;
      else r.partes.push(parte);
      if (!previa) r.t0 = tick;
      if (tick >= desde) r.contados++;
      bytes += medida; enviados++;
      // Dentro de un bloque el mapa de teselas es el mismo objeto; al cruzar queda el del bloque anterior.
      previa = cabecera; teselasPrevias = f.teselas; r.t1 = tick;
      if (r.contados && enviados >= o.n) break;
    }
    r.ultimo = previa ? r.t1 : -1;
    return r;
  }

  meta(rango: { t0?: number; t1?: number } = {}, estado: CintaMeta['estado'] = 'ok', topeBytes: number = CINTA.topeBytes,
    instancia?: string): CintaMeta {
    const vacia: CintaMeta = { version: 3, estado, epoca: 0, t0: 0, t1: 0, hz: 0, bytes: 0, topeBytes, niveles: [], bifurcaciones: [], lagunas: [], serie: [] };
    return this.reintentar(() => {
      if (!this.refrescar(instancia)) return vacia;
      let bytes = 0;
      for (const sufijo of ['', '-wal', '-shm']) bytes += statSync(join(this.directorio, INDICE_CINTA + sufijo), { throwIfNoEntry: false })?.size ?? 0;
      const niveles: CintaMeta['niveles'] = [];
      for (const nivel of NIVELES) {
        const c = this.cobertura(nivel);
        let enDisco = 0;
        for (const s of this.segmentos.values()) if (s.nivel === nivel) enDisco += s.bytes;
        bytes += enDisco;
        if (c) niveles.push({ nivel, paso: CINTA.pasos[nivel], t0: c.t0, t1: c.t1, bytes: enDisco, fotogramas: c.fotogramas });
      }
      const ultima = this.epocas.at(-1);
      const t0 = Math.min(...niveles.map(n => n.t0), ultima?.t1 ?? 0), t1 = ultima?.t1 ?? 0;
      const serie = this.serie(rango.t0 ?? t0, rango.t1 ?? t1, PUNTOS_SERIE);
      return { ...vacia, epoca: ultima?.id ?? 0, t0, t1, hz: this.ultimoHz(), bytes, niveles,
        bifurcaciones: this.bifurcaciones, lagunas: [...this.lagunas, ...this.cuarentena]
          .map(({ t0, t1 }) => ({ t0, t1 })).sort((a, b) => a.t0 - b.t0), serie };
    });
  }

  private ultimoHz(): number {
    return Number(this.db!.prepare('SELECT hz FROM serie ORDER BY epoca DESC, t DESC LIMIT 1').get()?.hz ?? 0);
  }

  /** La serie visible (sin lo huérfano) en [t0, t1], con a lo sumo `puntos` filas: la última de cada tramo. */
  private serie(t0: number, t1: number, puntos: number): SeriePunto[] {
    const db = this.db!, tramo = Math.max(1, Math.ceil((t1 - t0 + 1) / puntos));
    const filas = db.prepare(`SELECT max(t) AS t,poblacion,nacimientos,muertes,fauna,estructuras,sustancias,hz FROM serie
      WHERE epoca=? AND t>=? AND t<? GROUP BY t/CAST(? AS INTEGER) ORDER BY t`);
    const serie: SeriePunto[] = [];
    for (const e of this.epocas) {
      const desde = Math.max(t0, e.tMundo), hasta = Math.min(t1 + 1, e.fin);
      if (desde < hasta) for (const fila of filas.all(e.id, desde, hasta, tramo)) serie.push({ ...fila } as unknown as SeriePunto);
    }
    if (serie.length <= puntos) return serie;
    const salto = serie.length / puntos;
    return Array.from({ length: puntos }, (_, i) => serie[Math.min(serie.length - 1, Math.round((i + 1) * salto) - 1)]!);
  }

  private anterior(t: number, niveles: readonly Nivel[], pedida?: Epoca) {
    const desde = this.epocaEn(t), epoca = pedida ?? this.epocas[desde]!;
    const fino = niveles.find(n => this.intervaloEn(epoca, n, t, !!pedida));
    const epocas = pedida ? [pedida] : this.epocas.slice(0, desde + 1).reverse();
    let mejor: { e: Epoca; nivel: Nivel; i: number; tick: number; clave: boolean } | undefined;
    for (const e of epocas) {
      const hasta = pedida ? t : Math.min(t, e.fin - 1);
      for (const nivel of fino === undefined ? niveles : [fino]) {
        const { bloques } = this.pista(e.id, nivel);
        const i = ultimoHasta(bloques, hasta, b => b.t0);
        const b = bloques[i];
        if (!b || (mejor && b.t1 <= mejor.tick)) continue;
        let tick = b.t0 === hasta ? b.t0 : b.t1;
        if (tick > hasta) for (const { indice } of this.abrirBloque(b)) {
          tick = indice.marcos[ultimoHasta(indice.marcos, hasta, m => m.tick)]!.tick;
        }
        if (!mejor || tick > mejor.tick) mejor = { e, nivel, i, tick, clave: tick === b.t0 };
      }
      if (mejor) break;
    }
    return mejor;
  }

  private cambioNivel(e: Epoca, nivel: Nivel, iv: Intervalo, desde: number, niveles: readonly Nivel[], todo: boolean): number {
    const fin = todo ? Infinity : e.fin;
    let cambio = Infinity;
    for (const k of niveles) {
      const otro = k < nivel ? this.siguiente(e, k, desde, todo) : undefined;
      if (otro && otro.t0 < fin) cambio = Math.min(cambio, otro.t0);
    }
    const ultimo = this.ultimo(e, nivel, iv, todo);
    if (ultimo + 1 < cambio && niveles.some(k => k !== nivel && this.intervaloEn(e, k, ultimo + 1, todo))) cambio = ultimo + 1;
    return cambio;
  }

  private haySiguiente(e: Epoca, nivel: Nivel, tick: number, todo: boolean): boolean {
    if (todo) return tick < this.pista(e.id, nivel).bloques.at(-1)!.t1;
    for (let i = this.epocas.length - 1; i >= 0 && this.epocas[i]!.id >= e.id; i--) {
      const epoca = this.epocas[i]!, { intervalos } = this.pista(epoca.id, nivel);
      const ultimo = intervalos[ultimoHasta(intervalos, epoca.fin - 1, p => p.t0)];
      if (ultimo && this.ultimo(epoca, nivel, ultimo, false) > tick) return true;
    }
    return false;
  }

  /**
   * `GET /api/cinta/chunk`. Sin `epoca` sirve lo visible y nunca cruza una época, una laguna ni un hueco; con ella, la
   * historia entera de esa época (también lo huérfano), que sigue siendo continua. El tramo termina donde empieza un
   * nivel más fino o donde el servido se acaba y otro sigue (`cambioDeNivelEn`).
   */
  chunk(req: ChunkReq, fondo?: Fondo, instancia?: string): string {
    return this.reintentar(() => {
      const n = Math.min(CINTA.maxFotogramas, Math.max(1, req.n));
      const auto = req.nivel === undefined || req.nivel === 'auto', niveles = auto ? NIVELES : [req.nivel as Nivel];
      const vacio = (t: number, epoca: number): string => JSON.stringify({ nivel: niveles[0]!, paso: CINTA.pasos[niveles[0]!], epoca,
        t0: t, t1: t, hayMas: false, deltas: [] } satisfies ChunkResp);
      if (!this.refrescar(instancia) || !this.epocas.length) return vacio(req.t, req.epoca ?? 0);
      const pedida = req.epoca === undefined ? undefined : this.epocas.find(x => x.id === req.epoca);
      if (req.epoca !== undefined && !pedida) return vacio(req.t, req.epoca);
      const todo = !!pedida, camara = req.w === undefined ? undefined : { x: req.x!, y: req.y!, width: req.w, height: req.h! };
      if (n === 1) {
        const anterior = this.anterior(req.t, niveles, pedida);
        if (!anterior) return vacio(req.t, req.epoca ?? this.epocas[this.epocaEn(req.t)]!.id);
        const { e, nivel, i, tick, clave } = anterior;
        const tramo = this.tramo(e, nivel, i, i, tick, { clave, n, hasta: tick + 1, camara, fondo: fondoDe(nivel, fondo) });
        const iv = this.intervaloEn(e, nivel, tick, todo)!;
        const cambio = this.cambioNivel(e, nivel, iv, tick, niveles, todo);
        return conCampos({ nivel, paso: CINTA.pasos[nivel], epoca: e.id, t0: tick, t1: tick,
          hayMas: this.haySiguiente(e, nivel, tick, todo),
          ...(cambio < Infinity ? { cambioDeNivelEn: cambio } : {}) }, `"baseFrame":${tramo.base},"deltas":[]`);
      }
      // Entre t y el corte puede no haber fotogramas (un nivel más fino empieza antes del siguiente, o lo que queda
      // del bloque es huérfano): se sirve desde el corte.
      for (let t = req.t; ;) {
        const sitio = this.ubicar(t, niveles, pedida);
        if (!sitio) return vacio(t, req.epoca ?? this.epocas.at(-1)!.id);
        const { e, nivel, iv } = sitio, desde = Math.max(t, iv.t0), fin = todo ? Infinity : e.fin;
        const cambio = this.cambioNivel(e, nivel, iv, desde, niveles, todo);
        const hasta = Math.min(fin, cambio), { bloques } = this.pista(e.id, nivel);
        const i = Math.max(iv.i0, ultimoHasta(bloques, desde, b => b.t0));
        const tramo = this.tramo(e, nivel, i, iv.i1, desde, { clave: true, n, hasta, camara, fondo: fondoDe(nivel, fondo) });
        if (!tramo.contados) {
          if (hasta === Infinity || hasta <= t) return vacio(t, e.id);
          t = hasta;
          continue;
        }
        const final = todo ? this.pista(e.id, nivel).bloques.at(-1)!.t1 : this.cobertura(nivel)!.t1;
        const resp: Omit<ChunkResp, 'baseFrame' | 'deltas'> = { nivel, paso: CINTA.pasos[nivel], epoca: e.id, t0: tramo.t0, t1: tramo.t1,
          hayMas: tramo.ultimo < final, ...(cambio < Infinity ? { cambioDeNivelEn: cambio } : {}) };
        return conCampos(resp, `${tramo.base ? `"baseFrame":${tramo.base},` : ''}"deltas":[${tramo.partes.join(',')}]`);
      }
    });
  }

  /** `GET /api/tape/meta` con la forma del reproductor actual, servido desde L0 (alias hasta la ola 2). */
  metaAntigua(flags: { observerOnly: boolean; turbo: boolean }, instancia?: string, puntos = 240): string {
    return this.reintentar(() => {
      const r: TapeMetaResponse = { enabled: true, observerOnly: flags.observerOnly, turbo: flags.turbo, minTick: 0, maxTick: 0,
        latestDay: 1, totalFrames: 0, keyframeInterval: CINTA.pasos[0], simHz: 0, keyframeTicks: [], timeline: [] };
      if (!this.refrescar(instancia)) return JSON.stringify(r);
      const c = this.cobertura(0);
      if (c) {
        const ultimo = this.pista(this.epocas.at(-1)!.id, 0).bloques.at(-1);
        Object.assign(r, { minTick: c.t0, maxTick: c.t1, latestDay: Math.floor(c.t1 / TICKS_PER_DAY) + 1, totalFrames: c.fotogramas,
          ...(ultimo ? { keyframeInterval: Math.max(CINTA.pasos[0], ultimo.t1 - ultimo.t0) } : {}) });
      }
      const serie = this.serie(r.minTick, Math.max(r.maxTick, this.epocas.at(-1)?.t1 ?? 0), Math.max(2, puntos));
      r.simHz = this.ultimoHz();
      // La serie no graba tiempo ni pavimento: el reproductor actual solo usa día, población, obras y fórmulas.
      r.timeline = serie.map((s): TapeTimelinePoint => ({ tick: s.t, day: Math.floor(s.t / TICKS_PER_DAY) + 1, phase: phaseAt(s.t),
        weather: 'clear', pop: s.poblacion, births: s.nacimientos, deaths: s.muertes, structures: s.estructuras, formulas: s.sustancias,
        paved: 0, simHz: s.hz }));
      return JSON.stringify(r);
    });
  }

  /** `GET /api/tape/chunk`: L0 visible desde el primer fotograma ≥ `fromTick`, sin cruzar una época, una laguna ni un hueco. */
  chunkAntiguo(fromTick: number, count: number, camara?: Viewport, encoding: TapeChunkEncoding = 'full', fondo?: Fondo,
    instancia?: string): string {
    return this.reintentar(() => {
      const c = this.refrescar(instancia) ? this.cobertura(0) : undefined;
      // El intervalo de `ubicar` tiene un fotograma visible ≥ `fromTick` (o empieza después): el tramo nunca sale vacío.
      const sitio = c && this.ubicar(fromTick, [0]);
      let lleno: Tramo | undefined;
      if (sitio) {
        const { e, iv } = sitio, desde = Math.max(fromTick, iv.t0), { bloques } = this.pista(e.id, 0);
        let i = Math.max(iv.i0, ultimoHasta(bloques, desde, b => b.t0));
        if (bloques[i]!.t1 < desde) i++;
        lleno = this.tramo(e, 0, i, iv.i1, desde, { clave: false, n: count, hasta: e.fin, camara, fondo, completos: encoding !== 'delta' });
      }
      const sobre: Omit<TapeChunkResponse, 'frames' | 'baseFrame' | 'deltas'> = { fromTick: lleno?.t0 ?? fromTick,
        toTick: lleno?.t1 ?? fromTick, minTick: c?.t0 ?? 0, maxTick: c?.t1 ?? 0, simHz: c ? this.ultimoHz() : 0,
        hasMore: !!lleno && lleno.ultimo < c!.t1, ...(encoding === 'delta' ? { encoding } : {}) };
      const partes = lleno?.partes.join(',') ?? '';
      if (encoding !== 'delta') return conCampos(sobre, `"frames":[${partes}]`);
      return conCampos(sobre, `"frames":[],${lleno?.base ? `"baseFrame":${lleno.base},` : ''}"deltas":[${partes}]`);
    });
  }

  close(): void { this.olvidar(); }
}

/** El fondo de cada nivel: las teselas tal como las graba ese nivel; L3 y L4 no graban teselas. */
function fondoDe(nivel: Nivel, fondo?: Fondo): Fondo | undefined {
  if (!fondo || nivel > 2) return undefined;
  if (nivel === 0) return fondo;
  return (x, y, t) => { const tesela = fondo(x, y, t); return tesela && reducirTesela(nivel, tesela); };
}
