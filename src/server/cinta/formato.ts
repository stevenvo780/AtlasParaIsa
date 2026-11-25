import { isDeepStrictEqual } from 'node:util';
import { constants, crc32, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Nivel } from '../../shared/cinta.js';
import type { TapeClientDelta, TapeEntityPatch, TapeIdentified, TapeObjectPatch, TapePartialUpsert, TapeTechPatch } from '../../shared/tape-delta.js';
import type { StructureView, Tile, Viewport, WorldView } from '../../shared/types.js';

const CABECERA = 33;
const CRC = 25;
const LONGITUD_INDICE = 29;
const CABECERA_FOTOGRAMA = 16;
const ENTRADA_PARTE = 16;
const ENTRADA_SECTOR = 33;
const MAX_INDICE = 16 * 1024 ** 2;
const UMBRAL_INDICE = 15 * 1024 ** 2;
// Cota de lo que descomprime una lectura de un fotograma (cada parte y la suma de las que lee), no del bloque: un
// mundo grande sigue grabando y lo que pase de ella se lee por sectores. Ronda el largo máximo de una cadena de V8.
const MAX_CRUDO = 512 * 1024 ** 2;
// Medido con el banco del códec (revisión de C1c): con 64 el bloque ocupa menos que con 16 o 32 y el salto con
// cámara de un mundo de 50.000 entidades sigue siendo el más rápido; con 128 la cámara lee casi un cuadrante entero.
const LADO_SECTOR = 64;
const COMPRESION = { params: { [constants.ZSTD_c_compressionLevel]: 1 } };
const VENTANA = { [constants.ZSTD_d_windowLogMax]: 23 };
// JSON.stringify escapa este separador dentro de cualquier valor.
const SEPARADOR_TESELA = '\x1e';

export interface MetadatosBloque {
  nivel: Nivel;
  t0: number;
  t1: number;
  fotogramas: number;
  crc: number;
}

interface Rectangulo { x0: number; y0: number; x1: number; y1: number; margen: number }
interface Parte { sector: number; offset: number; bytes: number; crudos: number; crc: number }
interface Marco { tick: number; campos: number; partes: Parte[] }
export interface IndiceBloque extends MetadatosBloque {
  sectores: Rectangulo[];
  marcos: Marco[];
  bytesIndice: number;
}
export type LeerBytes = (offset: number, bytes: number) => Buffer;
export type LeerTesela = (x: string, y: string, json: string) => void;

const tickValido = (t: number): boolean => Number.isSafeInteger(t) && t >= 0;
const nivelValido = (n: number): n is Nivel => Number.isInteger(n) && n >= 0 && n <= 4;
const sectorDe = (n: number): number => Math.floor(n / LADO_SECTOR);
const listasEspaciales = ['people', 'animals', 'places', 'structures'] as const;
const listasClave = ['tiles', ...listasEspaciales] as const;
const margenDe = (nombre: typeof listasClave[number]): number => Number(nombre === 'people' || nombre === 'structures');
const errorFormato = (detalle: string): Error => new Error(`${detalle} CNT2 inválido.`);

type Posicion = { x: number; y: number; cells?: StructureView['cells']; footprint?: StructureView['footprint'] };
interface Domicilio { sector: number; pos: Posicion }
interface FilasSector { indices: number[]; valores: unknown[] }
interface ParteComprimida { sector: number; datos: Buffer; crudos: number; crc: number }
interface MarcoComprimido { tick: number; campos: number; partes: ParteComprimida[] }

/** Cota acumulada del índice. Un parche parcial conserva su sector de origen y no añade sectores. */
export function cotaIndiceBloque(base: WorldView): (delta: TapeClientDelta) => boolean {
  const sectores = new Set<string>();
  const agregar = (x: number, y: number, margen: number): void => {
    const sx = sectorDe(x), sy = sectorDe(y);
    if (Number.isSafeInteger(sx) && Number.isSafeInteger(sy)) sectores.add(`${sx},${sy},${margen}`);
  };
  for (const nombre of listasClave) {
    for (const fila of base[nombre] ?? []) agregar(fila.x, fila.y, margenDe(nombre));
  }
  let bytes = 4 + ENTRADA_SECTOR * sectores.size + CABECERA_FOTOGRAMA + ENTRADA_PARTE * (sectores.size + 1);
  return delta => {
    const previos = sectores.size;
    let filas = (delta.tilesPatch?.length ?? 0) + (delta.removedTiles?.length ?? 0);
    for (const t of delta.tilesPatch ?? []) agregar(t.x, t.y, 0);
    for (const k of delta.removedTiles ?? []) {
      const coma = k.indexOf(',');
      agregar(Number(k.slice(0, coma)), Number(k.slice(coma + 1)), 0);
    }
    for (const nombre of listasEspaciales) {
      const p = delta[`${nombre}Patch`];
      if (!p) continue;
      filas += p.removed.length + p.upserts.length;
      for (const u of p.upserts) if (!('_p' in u)) agregar(u.x, u.y, margenDe(nombre));
    }
    bytes += ENTRADA_SECTOR * (sectores.size - previos) + CABECERA_FOTOGRAMA
      + ENTRADA_PARTE * (1 + Math.min(filas, sectores.size));
    return bytes <= UMBRAL_INDICE;
  };
}

/**
 * Los ticks viven en el índice, separados del JSON. Cada entidad conserva su sector de entrada al bloque:
 * se amplía la cobertura de ese sector cuando se mueve para que una cámara nueva pueda leer también su base.
 */
export function prepararBloque(nivel: Nivel, base: WorldView, deltas: readonly TapeClientDelta[]): (t0?: number) => Buffer {
  const original = base.tick;
  if (!nivelValido(nivel) || !tickValido(original)) throw errorFormato('Nivel o tick inicial');
  const sectores: Rectangulo[] = [];
  const porOrigen = [new Map<number, Map<number, number>>(), new Map<number, Map<number, number>>()];
  const domicilios = listasEspaciales.map(() => new Map<string, Domicilio>());
  const sector = (x: number, y: number, margen = 0): number => {
    const sx = sectorDe(x), sy = sectorDe(y);
    // Sin una posición representable va con lo global, que se lee siempre; ninguna cámara la ve.
    if (!Number.isSafeInteger(sx) || !Number.isSafeInteger(sy)) return 0;
    const plano = porOrigen[margen]!;
    let fila = plano.get(sy);
    if (!fila) plano.set(sy, fila = new Map());
    const previo = fila.get(sx);
    if (previo !== undefined) return previo;
    const i = sectores.push({ x0: sx, y0: sy, x1: sx, y1: sy, margen });
    fila.set(sx, i);
    return i;
  };
  const extender = ({ sector: i, pos }: Domicilio) => {
    const r = sectores[i - 1];
    if (!r) return;
    const agregar = (x: number, y: number) => {
      const sx = sectorDe(x), sy = sectorDe(y);
      if (!Number.isSafeInteger(sx) || !Number.isSafeInteger(sy)) return;
      r.x0 = Math.min(r.x0, sx); r.y0 = Math.min(r.y0, sy);
      r.x1 = Math.max(r.x1, sx); r.y1 = Math.max(r.y1, sy);
    };
    agregar(pos.x, pos.y);
    for (const c of pos.cells ?? []) agregar(c.x, c.y);
    if (pos.footprint) agregar(pos.x + pos.footprint.width - 1, pos.y + pos.footprint.height - 1);
  };

  const marcos: MarcoComprimido[] = [];
  for (let i = 0; i <= deltas.length; i++) {
    const delta = deltas[i - 1], frame = delta ?? base;
    if (!tickValido(frame.tick) || (i && frame.tick <= marcos.at(-1)!.tick)) throw new Error('Ticks fuera de orden en CNT2.');
    const { tick, ...cabecera } = frame;
    const global = cabecera as Record<string, unknown>;
    delete global.seed;
    let campos = 0;
    const filasPorSector = new Map<number, Map<number, FilasSector>>();
    const agregar = <T>(campo: number, filas: readonly T[], ubicacion: (fila: T) => number) => {
      campos |= 1 << campo;
      filas.forEach((fila, indice) => {
        const s = ubicacion(fila);
        let sector = filasPorSector.get(s);
        if (!sector) filasPorSector.set(s, sector = new Map());
        let grupo = sector.get(campo);
        if (!grupo) sector.set(campo, grupo = { indices: [], valores: [] });
        grupo.indices.push(indice);
        grupo.valores.push(fila);
      });
    };

    if (!delta) {
      listasClave.forEach((nombre, campo) => {
        const valores = base[nombre];
        if (!valores) return;
        delete global[nombre];
        agregar(campo, valores as readonly (Posicion & { id?: string })[], fila => {
          const i = sector(fila.x, fila.y, margenDe(nombre));
          if (fila.id !== undefined && campo) {
            const d = { sector: i, pos: fila };
            domicilios[campo - 1]!.set(fila.id, d);
            if (fila.cells || fila.footprint) extender(d);
          }
          return i;
        });
      });
    } else {
      if (delta.tilesPatch) {
        delete global.tilesPatch;
        agregar(0, delta.tilesPatch, (t: Tile) => sector(t.x, t.y));
      }
      if (delta.removedTiles) {
        delete global.removedTiles;
        agregar(1, delta.removedTiles, (k: string) => {
          const coma = k.indexOf(',');
          return sector(Number(k.slice(0, coma)), Number(k.slice(coma + 1)));
        });
      }
      listasEspaciales.forEach((nombre, i) => {
        const campo = 2 + 3 * i, llave = `${nombre}Patch` as const, p = delta[llave];
        if (delta.unset?.includes(nombre)) domicilios[i]!.clear();
        if (!p) return;
        delete global[llave];
        const mapa = domicilios[i]!;
        agregar(campo + 1, p.removed, (id: string) => {
          const s = mapa.get(id)?.sector ?? 0;
          mapa.delete(id);
          return s;
        });
        agregar(campo, p.upserts as ((Posicion & TapeIdentified) | TapePartialUpsert)[], u => {
          let d = mapa.get(u.id);
          if ('_p' in u) {
            if (!d) throw errorFormato('Origen del parche');
            if ('x' in u || 'y' in u || 'cells' in u || 'footprint' in u || u._u?.length) {
              const { x, y, cells, footprint } = d.pos;
              const pos = { x, y, cells, footprint, ...u };
              for (const k of u._u ?? []) delete (pos as Record<string, unknown>)[k];
              d.pos = pos;
              extender(d);
            }
          } else {
            d = { sector: d?.sector ?? sector(u.x, u.y, margenDe(nombre)), pos: u };
            mapa.set(u.id, d);
            extender(d);
          }
          return d.sector;
        });
        if (p.order) agregar(campo + 2, p.order, () => 0);
      });
    }

    const partes: ParteComprimida[] = [];
    if (!filasPorSector.has(0)) filasPorSector.set(0, new Map());
    for (const [s, grupos] of filasPorSector) {
      const lineas = s === 0 ? [JSON.stringify(global)] : [];
      for (const [campo, { indices, valores }] of grupos) {
        const inicio = indices[0]!;
        const posiciones = indices.at(-1)! - inicio === indices.length - 1 ? inicio : `@${indices.join(',')}`;
        const json = campo === 0
          ? (valores as Tile[]).map(t => `${t.x},${t.y}:${JSON.stringify(t)}`).join(SEPARADOR_TESELA)
          : JSON.stringify(valores).slice(1, -1);
        lineas.push(`${campo}:${posiciones}:${json}`);
      }
      const crudo = Buffer.from(lineas.join('\n')), crudos = crudo.length;
      if (crudos > MAX_CRUDO) throw errorFormato('Tamaño descomprimido');
      // También las partes pequeñas: las deltas se reparten en muchas y, sin comprimir, doblaban el bloque.
      const comprimido = zstdCompressSync(crudo, COMPRESION);
      const datos = comprimido.length < crudos ? comprimido : crudo;
      partes.push({ sector: s, datos, crudos, crc: crc32(datos) });
    }
    marcos.push({ tick, campos, partes });
  }

  const bytesIndice = 4 + ENTRADA_SECTOR * sectores.length + marcos.reduce((n, m) => n + CABECERA_FOTOGRAMA + ENTRADA_PARTE * m.partes.length, 0);
  if (bytesIndice > MAX_INDICE) throw errorFormato('Tamaño de índice');
  const indice = Buffer.allocUnsafe(CABECERA + bytesIndice);
  indice.write('CNT2', 0, 'ascii');
  indice.writeUInt8(nivel, 4);
  indice.writeUInt32LE(marcos.length, 5);
  indice.writeUInt32LE(bytesIndice, LONGITUD_INDICE);
  indice.writeUInt32LE(sectores.length, CABECERA);
  let cursor = CABECERA + 4;
  for (const r of sectores) {
    for (const v of [r.x0, r.y0, r.x1, r.y1]) { indice.writeDoubleLE(v, cursor); cursor += 8; }
    indice.writeUInt8(r.margen, cursor++);
  }
  const ticks: number[] = [], partes: Buffer[] = [];
  for (const m of marcos) {
    ticks.push(cursor);
    indice.writeUInt32LE(m.campos, cursor + 8);
    indice.writeUInt32LE(m.partes.length, cursor + 12);
    cursor += CABECERA_FOTOGRAMA;
    for (const p of m.partes) {
      indice.writeUInt32LE(p.sector, cursor);
      indice.writeUInt32LE(p.datos.length, cursor + 4);
      indice.writeUInt32LE(p.crudos, cursor + 8);
      indice.writeUInt32LE(p.crc, cursor + 12);
      cursor += ENTRADA_PARTE;
      partes.push(p.datos);
    }
  }
  const total = indice.length + partes.reduce((n, p) => n + p.length, 0);
  const ticksRelativos = marcos.map(m => m.tick - original);
  return (t0 = original) => {
    const t1 = t0 + ticksRelativos.at(-1)!;
    if (!tickValido(t0) || !tickValido(t1)) throw errorFormato('Tick');
    indice.writeDoubleLE(t0, 9);
    indice.writeDoubleLE(t1, 17);
    ticks.forEach((offset, i) => indice.writeDoubleLE(t0 + ticksRelativos[i]!, offset));
    indice.writeUInt32LE(crc32(indice.subarray(LONGITUD_INDICE), crc32(indice.subarray(0, CRC))), CRC);
    return Buffer.concat([indice, ...partes], total);
  };
}

/** CNT2: directorio little-endian con CRC; partes crudas o Zstd con CRC y longitud cruda propios. */
export function codificarBloque(nivel: Nivel, base: WorldView, deltas: readonly TapeClientDelta[]): Buffer {
  return prepararBloque(nivel, base, deltas)();
}

export function leerIndiceBloque(leer: LeerBytes, longitud: number): IndiceBloque {
  if (longitud < CABECERA) throw errorFormato('Tamaño de bloque');
  const cabecera = leer(0, CABECERA);
  if (cabecera.toString('ascii', 0, 4) !== 'CNT2') throw errorFormato('Cabecera');
  const nivel = cabecera.readUInt8(4), fotogramas = cabecera.readUInt32LE(5);
  const t0 = cabecera.readDoubleLE(9), t1 = cabecera.readDoubleLE(17), crc = cabecera.readUInt32LE(CRC);
  const bytesIndice = cabecera.readUInt32LE(LONGITUD_INDICE);
  if (bytesIndice < 4 || bytesIndice > Math.min(MAX_INDICE, longitud - CABECERA)) throw errorFormato('Tamaño de índice');
  const indice = leer(CABECERA, bytesIndice);
  if (crc32(indice, crc32(cabecera.subarray(LONGITUD_INDICE), crc32(cabecera.subarray(0, CRC)))) !== crc) {
    throw errorFormato('CRC32');
  }
  if (!nivelValido(nivel) || !fotogramas || !tickValido(t0) || !tickValido(t1) || t0 > t1) throw errorFormato('Metadatos');
  const cantidad = indice.readUInt32LE(0);
  const sectores: Rectangulo[] = [];
  let cursor = 4, offset = CABECERA + bytesIndice, previo = -1;
  if (ENTRADA_SECTOR * cantidad + CABECERA_FOTOGRAMA * fotogramas > bytesIndice - cursor) throw errorFormato('Índice');
  for (let i = 0; i < cantidad; i++, cursor += ENTRADA_SECTOR) {
    const x0 = indice.readDoubleLE(cursor), y0 = indice.readDoubleLE(cursor + 8);
    const x1 = indice.readDoubleLE(cursor + 16), y1 = indice.readDoubleLE(cursor + 24);
    const margen = indice.readUInt8(cursor + 32);
    if (![x0, y0, x1, y1].every(Number.isSafeInteger) || x1 < x0 || y1 < y0 || margen > 1) throw errorFormato('Sector');
    sectores.push({ x0, y0, x1, y1, margen });
  }
  const marcos = new Array<Marco>(fotogramas);
  for (let i = 0; i < fotogramas; i++) {
    if (cursor + CABECERA_FOTOGRAMA > bytesIndice) throw errorFormato('Índice de fotograma');
    const tick = indice.readDoubleLE(cursor), campos = indice.readUInt32LE(cursor + 8), n = indice.readUInt32LE(cursor + 12);
    cursor += CABECERA_FOTOGRAMA;
    if (!tickValido(tick) || tick <= previo || (!i && tick !== t0) || !n || n > cantidad + 1
        || campos >= 1 << (i ? 2 + listasEspaciales.length * 3 : listasClave.length)
        || cursor + n * ENTRADA_PARTE > bytesIndice) throw errorFormato('Índice de fotograma');
    const partes = new Array<Parte>(n), vistos = new Set<number>();
    for (let j = 0; j < n; j++, cursor += ENTRADA_PARTE) {
      const sector = indice.readUInt32LE(cursor), bytes = indice.readUInt32LE(cursor + 4);
      const bruto = indice.readUInt32LE(cursor + 8), crc = indice.readUInt32LE(cursor + 12);
      if (sector > cantidad || vistos.has(sector) || !bytes || bytes > bruto || offset + bytes > longitud
          || !bruto || bruto > MAX_CRUDO) throw errorFormato('Índice de parte');
      partes[j] = { sector, offset, bytes, crudos: bruto, crc };
      vistos.add(sector);
      offset += bytes;
    }
    if (!vistos.has(0)) throw errorFormato('Índice sin cabecera global');
    marcos[i] = { tick, campos, partes };
    previo = tick;
  }
  if (cursor !== bytesIndice || offset !== longitud || previo !== t1) throw errorFormato('Fin de bloque');
  return { nivel, t0, t1, fotogramas, crc, sectores, marcos, bytesIndice: CABECERA + bytesIndice };
}

/** Verifica que el descriptor cacheado sigue perteneciéndole al archivo que se acaba de abrir. */
export function cabeceraCoincide(leer: LeerBytes, indice: IndiceBloque): boolean {
  const h = leer(0, CABECERA);
  return h.toString('ascii', 0, 4) === 'CNT2' && h.readUInt8(4) === indice.nivel
    && h.readUInt32LE(5) === indice.fotogramas && h.readDoubleLE(9) === indice.t0 && h.readDoubleLE(17) === indice.t1
    && h.readUInt32LE(CRC) === indice.crc && h.readUInt32LE(LONGITUD_INDICE) === indice.bytesIndice - CABECERA;
}

function verificarParte(p: Parte, datos: Buffer): Buffer {
  if (crc32(datos) !== p.crc) throw errorFormato('CRC32');
  return datos;
}

export function sectoresVisibles(indice: IndiceBloque, camara: Viewport): Set<number> {
  // Personas y edificios usan el margen de una tesela de la proyección. El resto usa el rectángulo exacto.
  const limites = [0, 1].map(m => ({
    x0: sectorDe(camara.x - m), x1: Math.ceil((camara.x + camara.width + m) / LADO_SECTOR) - 1,
    y0: sectorDe(camara.y - m), y1: Math.ceil((camara.y + camara.height + m) / LADO_SECTOR) - 1,
  }));
  const visibles = new Set([0]);
  indice.sectores.forEach((s, i) => {
    const { x0, y0, x1, y1 } = limites[s.margen]!;
    if (s.x0 <= x1 && s.x1 >= x0 && s.y0 <= y1 && s.y1 >= y0) visibles.add(i + 1);
  });
  return visibles;
}

/** Separa las filas de un grupo sin volver a parsear ni serializar los objetos. */
function* piezasJson(json: string): Generator<string> {
  let desde = 0, profundidad = 0, cadena = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (cadena) {
      if (c === '\\') i++;
      else if (c === '"') cadena = false;
    } else if (c === '"') cadena = true;
    else if (c === '[' || c === '{') profundidad++;
    else if (c === ']' || c === '}') profundidad--;
    else if (c === ',' && profundidad === 0) {
      yield json.slice(desde, i);
      desde = i + 1;
    }
  }
  yield json.slice(desde);
}

/** Reúne las partes pedidas sin parsear sus filas. Los índices conservan el orden entre sectores. */
export function leerMarcoJson(indice: IndiceBloque, i: number, leer: LeerBytes, visibles?: ReadonlySet<number>, tesela?: LeerTesela): string {
  const { tick, campos, partes } = indice.marcos[i]!;
  let crudos = 0;
  for (const p of partes) if (!visibles || visibles.has(p.sector)) crudos += p.crudos;
  if (crudos > MAX_CRUDO) throw errorFormato('Tamaño descomprimido');
  const filas: Record<number, string>[] = [];
  let global = '';
  let bloque: Buffer, desde = -1, fin = 0;
  for (let k = 0; k < partes.length; k++) {
    const p = partes[k]!;
    if (visibles && !visibles.has(p.sector)) continue;
    if (p.offset >= fin) {
      let j = k + 1;
      while (j < partes.length && (!visibles || visibles.has(partes[j]!.sector))) j++;
      desde = p.offset;
      const ultima = partes[j - 1]!;
      fin = ultima.offset + ultima.bytes;
      bloque = leer(desde, fin - desde);
    }
    const bytes = verificarParte(p, bloque!.subarray(p.offset - desde, p.offset - desde + p.bytes));
    const bruto = p.bytes === p.crudos ? bytes : zstdDecompressSync(bytes,
      { chunkSize: Math.min(128 * 1024, p.crudos), maxOutputLength: p.crudos, params: VENTANA });
    if (bruto.length !== p.crudos) throw errorFormato('Longitud descomprimida');
    const lineas = bruto.toString().split('\n');
    let j = 0;
    if (!p.sector) global = lineas[j++]!;
    for (; j < lineas.length; j++) {
      const linea = lineas[j]!, a = linea.indexOf(':'), b = linea.indexOf(':', a + 1);
      const campo = Number(linea.slice(0, a)), posiciones = linea.slice(a + 1, b);
      if (a < 1 || b < a + 2 || campo < 0 || campo >= 14 || !Number.isInteger(campo)
          || !(campos & (1 << campo))) throw errorFormato('Filas de sector');
      const destino = filas[campo] ??= Object.create(null) as Record<number, string>;
      const json = linea.slice(b + 1);
      const guardar = (texto: string, valor: string, anterior: number): number => {
        const indice = Number(texto);
        if (!texto || !valor || !Number.isInteger(indice) || indice <= anterior || indice >= MAX_CRUDO || indice in destino) {
          throw errorFormato('Índice de fila');
        }
        destino[indice] = valor;
        return indice;
      };
      if (posiciones[0] !== '@') guardar(posiciones, json, -1);
      else {
        const indices = posiciones.slice(1).split(',');
        let n = 0, anterior = -1;
        for (const valor of campo === 0 ? json.split(SEPARADOR_TESELA) : piezasJson(json)) {
          anterior = guardar(indices[n++] ?? '', valor, anterior);
        }
        if (n !== indices.length) throw errorFormato('Cantidad de filas');
      }
    }
  }
  if (global[0] !== '{' || global.at(-1) !== '}') throw errorFormato('Cabecera JSON');
  const extra: string[] = [];
  const hay = (campo: number) => !!(campos & (1 << campo));
  const lista = (campo: number): string => {
    const rachas = filas[campo];
    // Las claves enteras se enumeran en orden creciente, incluso si faltan sectores.
    if (!rachas) return '';
    const partes = Object.values(rachas);
    if (campo) return partes.join(',');
    for (let j = 0; j < partes.length; j++) {
      const piezas = partes[j]!.split(SEPARADOR_TESELA);
      for (let k = 0; k < piezas.length; k++) {
        const fila = piezas[k]!, coma = fila.indexOf(','), corte = fila.indexOf(':', coma + 1);
        if (coma < 1 || corte < coma + 2 || fila[corte + 1] !== '{') throw errorFormato('Tesela');
        const json = fila.slice(corte + 1);
        if (tesela) tesela(fila.slice(0, coma), fila.slice(coma + 1, corte), json);
        else piezas[k] = json;
      }
      if (!tesela) partes[j] = piezas.join(',');
    }
    return tesela ? '' : partes.join(',');
  };
  if (!i) {
    listasClave.forEach((nombre, campo) => { if (hay(campo)) extra.push(`"${nombre}":[${lista(campo)}]`); });
  } else {
    if (hay(0)) {
      const json = lista(0);
      if (!tesela) extra.push(`"tilesPatch":[${json}]`);
    }
    if (hay(1)) extra.push(`"removedTiles":[${lista(1)}]`);
    listasEspaciales.forEach((nombre, i) => {
      const campo = 2 + i * 3;
      if (hay(campo)) extra.push(`"${nombre}Patch":{"upserts":[${lista(campo)}],"removed":[${lista(campo + 1)}]${hay(campo + 2) ? `,"order":[${lista(campo + 2)}]` : ''}}`);
    });
  }
  return `{"tick":${tick}${global.length > 2 ? ',' + global.slice(1, -1) : ''}${extra.length ? ',' + extra.join(',') : ''}}`;
}

/** El escritor y la recuperación verifican todo el bloque sin descomprimir. El salto valida solo las partes que lee. */
export function verificarBloque(datos: Buffer): MetadatosBloque {
  const leer: LeerBytes = (offset, bytes) => datos.subarray(offset, offset + bytes);
  const { sectores: _, marcos, bytesIndice: __, ...meta } = leerIndiceBloque(leer, datos.length);
  for (const m of marcos) for (const p of m.partes) verificarParte(p, leer(p.offset, p.bytes));
  return meta;
}

export function decodificarBloque(datos: Buffer): MetadatosBloque & { baseFrame: WorldView; deltas: TapeClientDelta[] } {
  const leer: LeerBytes = (offset, bytes) => datos.subarray(offset, offset + bytes);
  const indice = leerIndiceBloque(leer, datos.length);
  const { sectores: _, marcos, bytesIndice: __, ...meta } = indice;
  return { ...meta, baseFrame: JSON.parse(leerMarcoJson(indice, 0, leer)) as WorldView,
    deltas: marcos.slice(1).map((_, i) => JSON.parse(leerMarcoJson(indice, i + 1, leer)) as TapeClientDelta) };
}

function igual(a: unknown, b: unknown): boolean {
  return a === b || isDeepStrictEqual(a, b);
}

function campo(o: Record<string, unknown>, clave: string): boolean {
  return Object.hasOwn(o, clave) && o[clave] !== undefined;
}

function cambiosObjeto(cur: Record<string, unknown>, prev: Record<string, unknown>): TapeObjectPatch {
  const set = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(cur)) {
    const v = cur[k];
    if (v !== undefined && !igual(v, prev[k])) set[k] = v;
  }
  let unset: string[] | undefined;
  for (const k of Object.keys(prev)) if (prev[k] !== undefined && !campo(cur, k)) (unset ??= []).push(k);
  return unset ? { set, unset } : { set };
}

function entidades<T extends TapeIdentified>(current: T[], previous: T[]): TapeEntityPatch<T> {
  const mismoOrden = current === previous || (current.length === previous.length && current.every((v, i) => v.id === previous[i]!.id));
  const old = mismoOrden ? undefined : new Map(previous.map(v => [v.id, v]));
  const upserts: (T | TapePartialUpsert)[] = [];
  for (let i = 0; i < current.length; i++) {
    const v = current[i]!, prev = mismoOrden ? previous[i] : old!.get(v.id);
    if (!prev) { upserts.push(v); continue; }
    if (v === prev) continue;
    const { set, unset } = cambiosObjeto(v as Record<string, unknown>, prev as Record<string, unknown>);
    if (Object.keys(set).length || unset) upserts.push({ ...set, id: v.id, _p: 1, ...(unset ? { _u: unset } : {}) });
  }
  if (mismoOrden) return { upserts, removed: [] };
  const ids = new Set(current.map(v => v.id));
  const removed = previous.filter(v => !ids.has(v.id)).map(v => v.id);
  const natural = previous.filter(v => ids.has(v.id)).map(v => v.id)
    .concat(current.filter(v => !old!.has(v.id)).map(v => v.id));
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
