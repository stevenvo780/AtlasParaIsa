import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual as igual } from 'node:util';
import { CINTA, type Bifurcacion, type ChunkReq, type ChunkResp, type CintaMeta, type Laguna, type Nivel, type SeriePunto } from '../../shared/cinta.js';
import { applyClientTapeDelta, type TapeClientDelta, type TapeEntityPatch } from '../../shared/tape-delta.js';
import type { TapeChunkEncoding, TapeChunkResponse, TapeMetaResponse, TapeTimelinePoint } from '../../shared/tape.js';
import type { Tile, Viewport, WorldView } from '../../shared/types.js';
import { phaseAt } from '../../world/mundo/crear.js';
import { TICKS_PER_DAY } from '../../world/mundo/tipos.js';
import { INDICE_CINTA, NIVELES, rutaSegmento } from './catalogo.js';
import { clientDelta, decodificarBloque, type BloqueDecodificado } from './formato.js';
import { reducirTesela } from './reducir.js';

/** Memoria de bloques decodificados por lector (cinta-sonnet §6). */
export const CACHE_BYTES = 256 * 1024 ** 2;
// Un bloque decodificado ocupa en el montón unas 20 veces lo que ocupa comprimido (JSON con gzip nivel 1 ≈ 6×,
// objetos de V8 ≈ 3× el JSON). El tope se cuenta con esa estimación.
const FACTOR_MEMORIA = 20;
/** JSON por respuesta: al pasarlo se corta el tramo y se marca `hayMas`. Siempre va la base. */
export const TOPE_RESPUESTA = 8 * 1024 ** 2;
const PUNTOS_SERIE = 400;

/** Pinta lo que la cinta no grabó dentro de la cámara (terreno archivado o sin generar). */
export type Fondo = (x: number, y: number) => Tile | undefined;

interface Bloque { segmento: number; epoca: number; nivel: Nivel; t0: number; t1: number; offset: number; bytes: number; fotogramas: number }
/** `fin`: el tick desde el que manda una época posterior (exclusivo). Lo que la época grabó desde ahí es huérfano. */
interface Epoca { id: number; tMundo: number; t1: number; fin: number }
interface Fotograma { vista: WorldView; teselas: Map<string, Tile>; delta?: TapeClientDelta }
/** `contados`: fotogramas ≥ `desde`; `ultimo` es -1 si el tramo salió vacío. */
interface Tramo { base?: string; partes: string[]; t0: number; t1: number; ultimo: number; contados: number }
interface OpcionesTramo { clave: boolean; n: number; hasta: number; camara?: Viewport; fondo?: Fondo; completos?: boolean }

const coord = (t: { x: number; y: number }): string => `${t.x},${t.y}`;

/**
 * Parche de una lista recortada a partir del grabado para el mundo entero: quien sigue a la vista lleva el mismo cambio,
 * quien entra va entero y quien sale se quita. Evita comparar campo a campo miles de entidades en cada fotograma.
 */
function parcheRecortado<T extends { id: string }>(antes: readonly T[], ahora: readonly T[], grabado?: TapeEntityPatch<T>): TapeEntityPatch<T> {
  const previos = new Set<string>(), actuales = new Set<string>();
  for (const v of antes) previos.add(v.id);
  for (const v of ahora) actuales.add(v.id);
  const cambios = new Map<string, TapeEntityPatch<T>['upserts'][number]>();
  for (const u of grabado?.upserts ?? []) cambios.set(u.id, u);
  const upserts: TapeEntityPatch<T>['upserts'] = [], removed: string[] = [], natural: string[] = [];
  for (const v of antes) if (actuales.has(v.id)) natural.push(v.id); else removed.push(v.id);
  for (const v of ahora) {
    if (!previos.has(v.id)) { upserts.push(v); natural.push(v.id); continue; }
    const u = cambios.get(v.id);
    if (u) upserts.push(u);
  }
  const r: TapeEntityPatch<T> = { upserts, removed };
  if (natural.some((id, i) => id !== ahora[i]!.id)) r.order = ahora.map(v => v.id);
  return r;
}

const RECORTE_RAPIDO = ['people', 'animals'] as const;
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
const clave = (epoca: number, nivel: Nivel): number => epoca * 5 + nivel;

/** Recorte a la cámara de una vista de la cinta; sin `teselas` solo proyecta la cabecera (para las deltas). */
function proyectar(vista: WorldView, teselas: Map<string, Tile> | undefined, camara: Viewport | undefined, fondo?: Fondo): WorldView {
  const r: WorldView = { ...vista };
  delete (r as unknown as Record<string, unknown>).seed;
  if (!camara) { r.tiles = teselas ? [...teselas.values()] : []; return r; }
  const { x, y, width, height } = camara;
  const visible = (p: { x: number; y: number }, margen = 0): boolean => p.x >= x - margen && p.y >= y - margen
    && p.x < x + width + margen && p.y < y + height + margen;
  r.originX = x; r.originY = y; r.width = width; r.height = height;
  r.tiles = [];
  if (teselas) for (let j = y; j < y + height; j++) for (let i = x; i < x + width; i++) {
    const t = teselas.get(`${i},${j}`) ?? fondo?.(i, j);
    if (t) r.tiles.push(t);
  }
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

/**
 * Lector de la cinta (cinta-sonnet §3, «Lectura y salto»): índice de bloques en RAM que se pone al día con lo que
 * confirma el escritor, búsqueda binaria por tick y caché LRU de bloques decodificados. Es síncrono: corre en los
 * hilos de `lector-worker.ts`, nunca en el del HTTP.
 */
export class LectorCinta {
  private db?: DatabaseSync;
  private ino = -1;
  private version = -1;
  private ultimoRowid = 0;
  private epocas: Epoca[] = [];
  private segmentos = new Map<number, { nivel: Nivel; bytes: number }>();
  private indice = new Map<number, Bloque[]>();
  private lagunas: (Laguna & { epoca: number })[] = [];
  private bifurcaciones: Bifurcacion[] = [];
  private readonly cache = new Map<string, { bloque: BloqueDecodificado; coste: number }>();
  private cacheUsado = 0;

  constructor(readonly directorio: string, private readonly cacheBytes = CACHE_BYTES) {}

  private olvidar(): void {
    try { this.db?.close(); } finally {
      this.db = undefined; this.ino = -1; this.version = -1; this.ultimoRowid = 0;
      this.epocas = []; this.segmentos.clear(); this.indice.clear(); this.lagunas = []; this.bifurcaciones = [];
      this.cache.clear(); this.cacheUsado = 0;
    }
  }

  /** Pone el índice al día. Falso mientras la cinta no tiene catálogo. */
  private refrescar(): boolean {
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
        if (version !== 3) throw new Error(`Versión de catálogo de cinta incompatible: ${version}.`);
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
    return true;
  }

  private cargar(db: DatabaseSync): void {
    const epocas = db.prepare('SELECT id,tMundo,t1 FROM epocas ORDER BY id').all() as unknown as Epoca[];
    let fin = Infinity;
    for (let i = epocas.length - 1; i >= 0; i--) { epocas[i]!.fin = fin; fin = Math.min(fin, epocas[i]!.tMundo); }
    this.epocas = epocas;
    const vivos = new Map((db.prepare('SELECT id,nivel,bytes FROM segmentos').all() as { id: number; nivel: Nivel; bytes: number }[])
      .map(s => [s.id, { nivel: s.nivel, bytes: s.bytes }]));
    const maximo = Number(db.prepare('SELECT coalesce(max(rowid),0) AS r FROM bloques').get()!.r);
    if (maximo < this.ultimoRowid) { this.indice.clear(); this.ultimoRowid = 0; }
    else if ([...this.segmentos.keys()].some(id => !vivos.has(id))) {
      for (const [k, lista] of this.indice) this.indice.set(k, lista.filter(b => vivos.has(b.segmento)));
    }
    this.segmentos = vivos;
    // El escritor añade los bloques de cada época y nivel en orden de tick, así que el rowid conserva ese orden.
    const nuevos = db.prepare(`SELECT rowid AS r,segmento,epoca,nivel,t0,t1,offset,bytes,fotogramas FROM bloques
      WHERE rowid>? ORDER BY rowid`).all(this.ultimoRowid) as unknown as (Bloque & { r: number })[];
    for (const { r, ...b } of nuevos) {
      const k = clave(b.epoca, b.nivel);
      let lista = this.indice.get(k);
      if (!lista) this.indice.set(k, lista = []);
      lista.push(b);
      this.ultimoRowid = r;
    }
    this.lagunas = db.prepare('SELECT epoca,t0,t1 FROM lagunas ORDER BY t0').all().map(l => ({ ...l })) as unknown as (Laguna & { epoca: number })[];
    this.bifurcaciones = db.prepare('SELECT epoca,desde,hasta,motivo FROM bifurcaciones ORDER BY epoca').all()
      .map(b => ({ ...b })) as unknown as Bifurcacion[];
  }

  /** Un segmento podado entre la carga del índice y la lectura: se recarga el índice y se intenta una vez más. */
  private reintentar<T>(leer: () => T): T {
    try { return leer(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.version = -1;
      return leer();
    }
  }

  private leerBloque(b: Bloque): BloqueDecodificado {
    const k = `${b.segmento}:${b.offset}`;
    const guardado = this.cache.get(k);
    if (guardado) { this.cache.delete(k); this.cache.set(k, guardado); return guardado.bloque; }
    const datos = Buffer.allocUnsafe(b.bytes);
    const fd = openSync(rutaSegmento(this.directorio, b.nivel, b.segmento), 'r');
    try {
      for (let cursor = 0; cursor < datos.length;) {
        const n = readSync(fd, datos, cursor, datos.length - cursor, b.offset + cursor);
        if (!n) throw new Error(`Bloque de cinta incompleto: ${b.segmento}/${b.offset}.`);
        cursor += n;
      }
    } finally { closeSync(fd); }
    const bloque = decodificarBloque(datos);
    const coste = b.bytes * FACTOR_MEMORIA;
    this.cache.set(k, { bloque, coste });
    this.cacheUsado += coste;
    for (const [viejo, { coste: c }] of this.cache) {
      if (this.cacheUsado <= this.cacheBytes || this.cache.size === 1) break;
      this.cache.delete(viejo); this.cacheUsado -= c;
    }
    return bloque;
  }

  private lista(epoca: number, nivel: Nivel): Bloque[] { return this.indice.get(clave(epoca, nivel)) ?? []; }

  /** La época que se ve en `t`: la última que empezó en o antes de `t`. */
  private epocaEn(t: number): number {
    let i = this.epocas.length - 1;
    while (i > 0 && this.epocas[i]!.tMundo > t) i--;
    return Math.max(0, i);
  }

  /** El bloque desde el que leer `t`: el último que empieza en o antes de `t`, o el primero si `t` es anterior. */
  private bloqueEn(lista: Bloque[], t: number): number {
    let lo = 0, hi = lista.length - 1, r = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (lista[m]!.t0 <= t) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
  }

  /** Lo visible de un nivel en una época: [t0, t1] de sus fotogramas antes de `fin`. */
  private cobertura(e: Epoca, nivel: Nivel): { t0: number; t1: number } | undefined {
    const lista = this.lista(e.id, nivel);
    let j = lista.length - 1;
    while (j >= 0 && lista[j]!.t0 >= e.fin) j--;
    const primero = lista[0], ultimo = lista[j];
    if (!primero || !ultimo) return undefined;
    return { t0: primero.t0, t1: Math.min(ultimo.t1, e.fin - 1) };
  }

  private coberturaTotal(nivel: Nivel): { t0: number; t1: number } | undefined {
    let t0 = Infinity, t1 = -Infinity;
    for (const e of this.epocas) {
      const c = this.cobertura(e, nivel);
      if (c) { t0 = Math.min(t0, c.t0); t1 = Math.max(t1, c.t1); }
    }
    return t1 < 0 ? undefined : { t0, t1 };
  }

  private lagunaEntre(epoca: number, antes: Bloque, despues: Bloque): boolean {
    return this.lagunas.some(l => l.epoca === epoca && l.t1 > antes.t1 && l.t1 <= despues.t0);
  }

  /** Fotogramas completos de un nivel desde el bloque `i`, sin cruzar `hasta` ni una laguna. Las teselas van aparte. */
  private *recorrer(e: Epoca, nivel: Nivel, i: number, hasta: number): Generator<Fotograma> {
    const lista = this.lista(e.id, nivel);
    for (let j = i; j < lista.length; j++) {
      const b = lista[j]!;
      if (b.t0 >= hasta || j > i && this.lagunaEntre(e.id, lista[j - 1]!, b)) return;
      const d = this.leerBloque(b);
      let vista: WorldView = { ...d.baseFrame, tiles: [] };
      const teselas = new Map(d.baseFrame.tiles.map(t => [coord(t), t]));
      yield { vista, teselas };
      for (const delta of d.deltas) {
        if (delta.tick >= hasta) return;
        const { tilesPatch, removedTiles, ...cabecera } = delta;
        vista = applyClientTapeDelta(vista, cabecera).frame;
        for (const k of removedTiles ?? []) teselas.delete(k);
        for (const t of tilesPatch ?? []) teselas.set(coord(t), t);
        yield { vista, teselas, delta };
      }
    }
  }

  /**
   * Serializa un tramo: una base y deltas que aplica `applyClientTapeDelta`, recortados a la cámara. Con `clave` la base
   * es el fotograma clave del bloque (el primer pintado sale sin aplicar deltas); si no, el primer fotograma ≥ `desde`.
   */
  private tramo(e: Epoca, nivel: Nivel, i: number, desde: number, o: OpcionesTramo): Tramo {
    const r: Tramo = { partes: [], t0: desde, t1: desde, ultimo: -1, contados: 0 };
    let bytes = 0;
    let previa: WorldView | undefined, teselasPrevias: Map<string, Tile> | undefined;
    const visibles = new Map<string, Tile>();
    const dentro = (t: { x: number; y: number }): boolean => !o.camara || t.x >= o.camara.x && t.y >= o.camara.y
      && t.x < o.camara.x + o.camara.width && t.y < o.camara.y + o.camara.height;
    for (const f of this.recorrer(e, nivel, i, o.hasta)) {
      const tick = f.vista.tick;
      if (!previa && !o.clave && tick < desde) continue;
      if (r.contados >= o.n || bytes >= TOPE_RESPUESTA) break;
      if (tick >= desde) r.contados++;
      const cabecera = proyectar(f.vista, undefined, o.camara);
      let parte: string;
      if (o.completos) parte = JSON.stringify(proyectar(f.vista, f.teselas, o.camara, o.fondo));
      else if (!previa) {
        const base = proyectar(f.vista, f.teselas, o.camara, o.fondo);
        for (const t of base.tiles) visibles.set(coord(t), t);
        parte = r.base = JSON.stringify(base);
      } else if (!o.camara && f.delta) parte = JSON.stringify(f.delta);
      else {
        const delta = deltaRecortado(previa, cabecera, f.delta);
        const cambiadas: Tile[] = [], quitadas: string[] = [];
        if (f.delta) {
          for (const t of f.delta.tilesPatch ?? []) if (dentro(t)) cambiadas.push(t);
        } else if (o.camara) {
          // Cruce de bloque: la clave nueva no trae parche, se compara lo que se ve.
          for (let y = o.camara.y; y < o.camara.y + o.camara.height; y++) for (let x = o.camara.x; x < o.camara.x + o.camara.width; x++) {
            const k = `${x},${y}`, t = f.teselas.get(k) ?? o.fondo?.(x, y);
            if (t && !igual(t, visibles.get(k))) cambiadas.push(t);
            else if (!t && visibles.has(k)) quitadas.push(k);
          }
        } else {
          for (const [k, t] of f.teselas) if (!igual(t, teselasPrevias!.get(k))) cambiadas.push(t);
          for (const k of teselasPrevias!.keys()) if (!f.teselas.has(k)) quitadas.push(k);
        }
        for (const t of cambiadas) visibles.set(coord(t), t);
        for (const k of quitadas) visibles.delete(k);
        if (cambiadas.length) delta.tilesPatch = cambiadas;
        if (quitadas.length) delta.removedTiles = quitadas;
        parte = JSON.stringify(delta);
      }
      if (o.completos || previa) r.partes.push(parte);
      if (!previa) r.t0 = tick;
      bytes += parte.length;
      // Dentro de un bloque el mapa de teselas es el mismo objeto; al cruzar queda el del bloque anterior.
      previa = cabecera; teselasPrevias = f.teselas; r.t1 = tick;
    }
    r.ultimo = previa ? r.t1 : -1;
    return r;
  }

  /**
   * El bloque desde el que leer `t`. Con `clave` es el del fotograma clave más cercano ≤ `t`, salvo que entre ese bloque
   * y `t` haya una laguna; sin ella, el primero con fotogramas en o después de `t`.
   */
  private bloqueDesde(epoca: number, lista: Bloque[], t: number, clave: boolean): number {
    const i = this.bloqueEn(lista, t), b = lista[i], siguiente = lista[i + 1];
    if (!b || b.t1 >= t) return i;
    return !clave || siguiente && this.lagunaEntre(epoca, b, siguiente) ? i + 1 : i;
  }

  /** Primera época, desde la que se ve `t`, con un bloque del nivel desde el que leerlo. */
  private ubicar(nivel: Nivel, t: number, clave: boolean): { e: Epoca; i: number; desde: number } | undefined {
    for (let k = this.epocaEn(t); k < this.epocas.length; k++) {
      const e = this.epocas[k]!, desde = Math.max(t, e.tMundo), lista = this.lista(e.id, nivel);
      if (desde >= e.fin) continue;
      const i = this.bloqueDesde(e.id, lista, desde, clave);
      if (i < lista.length && lista[i]!.t0 < e.fin) return { e, i, desde };
    }
    return undefined;
  }

  meta(rango: { t0?: number; t1?: number } = {}, estado: CintaMeta['estado'] = 'ok', topeBytes: number = CINTA.topeBytes): CintaMeta {
    const vacia: CintaMeta = { version: 3, estado, epoca: 0, t0: 0, t1: 0, hz: 0, bytes: 0, topeBytes, niveles: [], bifurcaciones: [], lagunas: [], serie: [] };
    if (!this.reintentar(() => this.refrescar())) return vacia;
    let bytes = 0;
    for (const sufijo of ['', '-wal', '-shm']) bytes += statSync(join(this.directorio, INDICE_CINTA + sufijo), { throwIfNoEntry: false })?.size ?? 0;
    const niveles: CintaMeta['niveles'] = [];
    for (const nivel of NIVELES) {
      const c = this.coberturaTotal(nivel);
      let enDisco = 0, fotogramas = 0;
      for (const s of this.segmentos.values()) if (s.nivel === nivel) enDisco += s.bytes;
      for (const e of this.epocas) for (const b of this.lista(e.id, nivel)) fotogramas += b.fotogramas;
      bytes += enDisco;
      if (c) niveles.push({ nivel, paso: CINTA.pasos[nivel], t0: c.t0, t1: c.t1, bytes: enDisco, fotogramas });
    }
    const ultima = this.epocas.at(-1);
    const t0 = Math.min(...niveles.map(n => n.t0), ultima?.t1 ?? 0), t1 = ultima?.t1 ?? 0;
    const serie = this.serie(rango.t0 ?? t0, rango.t1 ?? t1, PUNTOS_SERIE);
    return { ...vacia, epoca: ultima?.id ?? 0, t0, t1, hz: this.ultimoHz(), bytes, niveles,
      bifurcaciones: this.bifurcaciones, lagunas: this.lagunas.map(({ t0, t1 }) => ({ t0, t1 })), serie };
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

  chunk(req: ChunkReq, fondo?: Fondo): string {
    return this.reintentar(() => {
      const t = req.t, n = Math.min(CINTA.maxFotogramas, Math.max(1, req.n));
      const vacio = (nivel: Nivel, epoca: number): string => JSON.stringify({ nivel, paso: CINTA.pasos[nivel], epoca, t0: t, t1: t,
        hayMas: false, deltas: [] } satisfies ChunkResp);
      if (!this.refrescar() || !this.epocas.length) return vacio(0, 0);
      let sitio: { e: Epoca; i: number; desde: number } | undefined, nivel: Nivel = 0, cambio: number | undefined;
      let limite = Infinity, clave = true;
      if (req.epoca !== undefined) {
        // Una época pedida explícitamente sirve también lo huérfano, pero nunca seguido de lo visible ni al revés.
        const e = this.epocas.find(x => x.id === req.epoca);
        if (!e) return vacio(0, req.epoca);
        nivel = req.nivel === undefined || req.nivel === 'auto' ? NIVELES.find(k => this.lista(e.id, k).some(b => b.t1 >= t)) ?? 0 : req.nivel;
        const lista = this.lista(e.id, nivel);
        if (t < e.fin) limite = e.fin;
        else clave = false;
        const i = this.bloqueDesde(e.id, lista, t, clave);
        if (i < lista.length) sitio = { e, i, desde: t };
      } else {
        const niveles = req.nivel === undefined || req.nivel === 'auto' ? NIVELES : [req.nivel];
        // El más fino que cubre t o, si ninguno lo cubre, el más fino con fotogramas después.
        for (const k of niveles) {
          const s = this.ubicar(k, t, true);
          if (!s) continue;
          const cubre = this.cobertura(s.e, k)!.t0 <= s.desde;
          if (cubre || !sitio) { sitio = s; nivel = k; }
          if (cubre) break;
        }
        if (sitio) {
          limite = sitio.e.fin;
          // Si un nivel más fino empieza más adelante en la misma época, el tramo termina ahí.
          for (const k of niveles) {
            const c = k < nivel ? this.cobertura(sitio.e, k) : undefined;
            if (c && c.t0 > sitio.desde) cambio = Math.min(cambio ?? Infinity, c.t0);
          }
        }
      }
      if (!sitio) return vacio(req.nivel === undefined || req.nivel === 'auto' ? nivel : req.nivel, req.epoca ?? this.epocas.at(-1)!.id);
      const { e, i, desde } = sitio;
      const camara = req.w === undefined ? undefined : { x: req.x!, y: req.y!, width: req.w, height: req.h! };
      const hasta = Math.min(limite, cambio ?? Infinity);
      const tramo = this.tramo(e, nivel, i, desde, { clave, n, hasta, camara, fondo: fondoDe(nivel, fondo) });
      // Entre `t` y el corte no había fotogramas (el bloque sigue con lo huérfano o con un nivel más fino): se sirve desde el corte.
      if (!tramo.contados && hasta < Infinity && hasta > t) return this.chunk({ ...req, t: hasta }, fondo);
      const final = req.epoca === undefined ? this.coberturaTotal(nivel)?.t1 ?? -1 : this.lista(e.id, nivel).at(-1)?.t1 ?? -1;
      const resp: Omit<ChunkResp, 'baseFrame' | 'deltas'> = { nivel, paso: CINTA.pasos[nivel], epoca: e.id, t0: tramo.t0, t1: tramo.t1,
        hayMas: tramo.ultimo >= 0 && tramo.ultimo < final,
        ...(cambio !== undefined && tramo.ultimo >= 0 && tramo.ultimo < cambio ? { cambioDeNivelEn: cambio } : {}) };
      return conCampos(resp, `${tramo.base ? `"baseFrame":${tramo.base},` : ''}"deltas":[${tramo.partes.join(',')}]`);
    });
  }

  /** `GET /api/tape/meta` con la forma del reproductor actual, servido desde L0 (alias hasta la ola 2). */
  metaAntigua(flags: { observerOnly: boolean; turbo: boolean }, puntos = 240): string {
    return this.reintentar(() => {
      const r: TapeMetaResponse = { enabled: true, observerOnly: flags.observerOnly, turbo: flags.turbo, minTick: 0, maxTick: 0,
        latestDay: 1, totalFrames: 0, keyframeInterval: CINTA.pasos[0], simHz: 0, keyframeTicks: [], timeline: [] };
      if (!this.refrescar()) return JSON.stringify(r);
      const c = this.coberturaTotal(0);
      if (c) {
        let total = 0;
        for (const e of this.epocas) for (const b of this.lista(e.id, 0)) if (b.t0 < e.fin) total += b.fotogramas;
        const ultimo = this.lista(this.epocas.at(-1)!.id, 0).at(-1);
        Object.assign(r, { minTick: c.t0, maxTick: c.t1, latestDay: Math.floor(c.t1 / TICKS_PER_DAY) + 1, totalFrames: total,
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

  /** `GET /api/tape/chunk`: L0 desde el primer fotograma ≥ `fromTick`, sin cruzar una época ni una laguna. */
  chunkAntiguo(fromTick: number, count: number, camara?: Viewport, encoding: TapeChunkEncoding = 'full', fondo?: Fondo): string {
    return this.reintentar(() => {
      const c = this.refrescar() ? this.coberturaTotal(0) : undefined;
      const sitio = c && this.ubicar(0, fromTick, false);
      const tramo = sitio && this.tramo(sitio.e, 0, sitio.i, sitio.desde, { clave: false, n: count, hasta: sitio.e.fin, camara,
        fondo, completos: encoding !== 'delta' });
      // El resto del bloque es huérfano: lo siguiente visible empieza donde la época deja de verse.
      if (tramo && !tramo.contados && sitio.e.fin < Infinity) return this.chunkAntiguo(sitio.e.fin, count, camara, encoding, fondo);
      const sobre: Omit<TapeChunkResponse, 'frames' | 'baseFrame' | 'deltas'> = { fromTick: tramo?.t0 ?? fromTick,
        toTick: tramo?.t1 ?? fromTick, minTick: c?.t0 ?? 0, maxTick: c?.t1 ?? 0, simHz: c ? this.ultimoHz() : 0,
        hasMore: !!tramo && tramo.ultimo >= 0 && tramo.ultimo < c!.t1, ...(encoding === 'delta' ? { encoding } : {}) };
      const partes = tramo?.partes.join(',') ?? '';
      if (encoding !== 'delta') return conCampos(sobre, `"frames":[${partes}]`);
      return conCampos(sobre, `"frames":[],${tramo?.base ? `"baseFrame":${tramo.base},` : ''}"deltas":[${partes}]`);
    });
  }

  close(): void { this.olvidar(); }
}

/** El fondo de cada nivel: las teselas tal como las graba ese nivel; L3 y L4 no graban teselas. */
function fondoDe(nivel: Nivel, fondo?: Fondo): Fondo | undefined {
  if (!fondo || nivel > 2) return undefined;
  if (nivel === 0) return fondo;
  return (x, y) => { const t = fondo(x, y); return t && reducirTesela(nivel, t); };
}
