import { serialize } from 'node:v8';
import {
  disposicion, ESQUEMA_CELDA, ESQUEMA_ORGANISMO, RANURA_F64, RANURA_I32, regionesRanura, SERIE_CAMPOS,
  type CampoSerie, type EnlaceCinta, type Suceso,
} from '../../shared/fotograma.js';
import type { Action, AnimalView, ChronicleEvent, PersonView, Tile, WorldView } from '../../shared/types.js';
import { ESCUCHA_LOCUS } from '../genetics.js';
import { matDeCelda, temperaturaDe } from '../materia/ley-mundo.js';
import { ErrorFatalMotor, PLAZO_BARRERA_MS } from '../paralelo/barrera.js';
import { ley } from '../params.js';
import { crecerSAB } from '../soa/arena.js';
import { PAGE_CELLS, PAGE_SIDE } from '../soa/region.js';
import { type CtxF0, type CtxLey, type CtxLeyMateria } from './acceso.js';
import { CAMPOS_CUERPO, Clase, CUERPO_ANCHO, GENOMA_ANCHO } from './contratos.js';

const HOLGURA_RANURA = 0.25;
const { ancho: anchoOrganismo, desde: campoO } = disposicion(ESQUEMA_ORGANISMO);
const { ancho: anchoCelda, desde: campoC } = disposicion(ESQUEMA_CELDA);
const escalaU8 = 255;

/** Orden de la columna `accion` de personas; la fauna usa `animals.ACTIONS`. */
export const ACCIONES_PERSONA_FOTOGRAMA: readonly Action[] = [
  'explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather',
  'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft',
];

/** Campos públicos que no están en las columnas ni en los sucesos de texto. */
export type VistaPersonaFotograma = Omit<PersonView,
  'name' | 'color' | 'reason' | 'need' | 'recentMemory' | 'specialty' | 'craftTint' | 'craftFocus' |
  'action' | 'x' | 'y' | 'energy' | 'hunger' | 'thirst' | 'health' | 'experiences' | 'trust'>;
export type VistaAnimalFotograma = Omit<AnimalView, 'reason' | 'action' | 'x' | 'y' | 'energy' | 'hunger' | 'thirst' | 'health'>;
export type VistaPaginaFotograma = readonly Omit<Tile, 'x' | 'y' | 'mat' | 'T'>[];
export type VistaMundoFotograma = Omit<WorldView, 'version' | 'sequence' | 'tick' | 'day' | 'phase' | 'weather' | 'tiles' | 'people' | 'animals' | 'places' | 'events' | 'memories' | 'communities' | 'structures' | 'blueprints' | 'technology' | 'organization' | 'whispers'>;

export type SucesoVistaAdicional =
  | { tipo: 'mundo'; id: string; vista: VistaMundoFotograma | null }
  | { tipo: 'cronicaVista'; id: string; vista: readonly ChronicleEvent[] | null }
  | { tipo: 'persona'; id: string; vista: VistaPersonaFotograma | null }
  | { tipo: 'animal'; id: string; vista: VistaAnimalFotograma | null }
  | { tipo: 'pagina'; id: string; vista: VistaPaginaFotograma | null };
export type SucesoFotograma = Suceso | SucesoVistaAdicional;

/** F0 reúne los partes de los dueños; después de B4 presenta el lote desde el último fotograma entregado. */
export interface FuenteFotograma {
  corte(c: CtxF0, f: FotogramaEnCurso): {
    sucesos: readonly SucesoFotograma[];
    serie: Readonly<Record<CampoSerie, number>>;
  };
  confirmar(f: FotogramaEnCurso): void;
}

const fuentes = new WeakMap<EnlaceCinta, FuenteFotograma>();
export function enlazarFuenteFotograma(enlace: EnlaceCinta, fuente: FuenteFotograma): void {
  fuentes.set(enlace, fuente);
}

/** Estado del fotograma en curso, que el coordinador abre en F0 y los dueños rellenan en F6. */
export interface FotogramaEnCurso { readonly ranura: SharedArrayBuffer; readonly completo: boolean; readonly tick: number; readonly epoca: number }

interface FotogramaConVersiones extends FotogramaEnCurso {
  readonly versiones: Float64Array; // Por chunk, versionVisible entregada + 1. 0 significa que aún no viajó.
}
interface EstadoEnlace {
  epoca: number;
  ultimoIntento: number;
  saltados: number;
  primero: boolean;
  versiones: Float64Array;
  enCurso: FotogramaConVersiones | null;
}
const estados = new WeakMap<EnlaceCinta, EstadoEnlace>();
const capacidad = (n: number): number => Math.ceil(n * (1 + HOLGURA_RANURA)) + 1;

/** F0: reserva una sola ranura por tick elegible. */
export function abrirFotograma(c: CtxF0, enlace: EnlaceCinta, epoca: number): FotogramaEnCurso | null {
  if (!ley(c.mundo, 'fotograma')) return null;
  let e = estados.get(enlace);
  if (e?.enCurso) throw new Error('La ranura anterior sigue abierta.');
  if (e?.epoca !== epoca) {
    e = { epoca, ultimoIntento: -Infinity, saltados: 0, primero: true, versiones: new Float64Array(0), enCurso: null };
    estados.set(enlace, e);
  }
  if (c.tick - e.ultimoIntento < Math.max(1, Atomics.load(enlace.cadencia, 0))) return null;
  e.ultimoIntento = c.tick;
  if (Atomics.load(enlace.creditos, 0) <= 0) {
    e.saltados++;
    return null;
  }

  const capOrganismos = capacidad(c.frente.alta), capPaginas = capacidad(c.terreno.paginas);
  const entregados = Atomics.load(enlace.entregados, 0);
  if (!enlace.ranuras.length) throw new Error('Hay créditos de cinta sin ranuras disponibles.');
  const ranura = enlace.ranuras[Number(entregados % BigInt(enlace.ranuras.length))];
  crecerSAB(ranura, regionesRanura(capOrganismos, capPaginas).total);
  if (e.versiones.length < capPaginas) {
    const versiones = new Float64Array(new SharedArrayBuffer(capPaginas * Float64Array.BYTES_PER_ELEMENT));
    versiones.set(e.versiones);
    e.versiones = versiones;
  }

  Atomics.sub(enlace.creditos, 0, 1);
  const completo = Atomics.exchange(enlace.pedirCompleto, 0, 0) !== 0 || e.primero;
  const i32 = new Int32Array(ranura, 0, 8), f64 = new Float64Array(ranura, 0, 8);
  i32.set([0, 0, Number(completo), e.saltados, capOrganismos, capPaginas]);
  f64[RANURA_F64.tick] = c.tick;
  f64[RANURA_F64.epoca] = epoca;
  e.enCurso = { ranura, completo, tick: c.tick, epoca, versiones: e.versiones };
  return e.enCurso;
}

/** El coordinador puede dar a cada dueño su lista final de slots tras F5. */
const filasLocales = new WeakMap<CtxLey, () => Iterable<number>>();
export function enlazarFilasFotograma(c: CtxLey, filas: () => Iterable<number>): void {
  filasLocales.set(c, filas);
}

function* indices(n: number): Iterable<number> {
  for (let i = 0; i < n; i++) yield i;
}

/** F6: reserva un bloque por dueño y lee sus columnas del frente que se está cerrando. */
export function escribirFotograma(c: CtxLey, f: FotogramaEnCurso): boolean {
  const versiones = (f as FotogramaConVersiones).versiones;
  const i32 = new Int32Array(f.ranura, 0, 8);
  const capO = i32[RANURA_I32.capOrganismos], capP = i32[RANURA_I32.capPaginas];
  const r = regionesRanura(capO, capP), binario = new DataView(f.ranura);
  const w = c.escritura, vivo = w.u8('vivo'), dueno = w.i32('dueno');
  const slots: number[] = [];
  for (const s of filasLocales.get(c)?.() ?? indices(vivo.length)) {
    if (dueno[s] === c.hilo && vivo[s] === 1) slots.push(s);
  }

  const t = c.terreno;
  const chunks: number[] = [];
  for (const chunk of c.chunks) {
    if (t.duenoChunk[chunk] !== c.hilo) continue;
    if (f.completo || versiones[chunk] !== t.versionVisible[chunk] + 1) chunks.push(chunk);
  }
  const desdeO = Atomics.add(i32, RANURA_I32.n, slots.length);
  const desdeP = Atomics.add(i32, RANURA_I32.paginas, chunks.length);
  if (desdeO + slots.length > capO || desdeP + chunks.length > capP) return false;

  const uid = w.f64('uid'), clase = w.u8('clase'), x = w.f32('x'), y = w.f32('y');
  const accion = w.u8('accion'), cuerpo = w.f32('cuerpo');
  const forma = c.frente.columnas.includes('forma') ? w.i32('forma') : undefined;
  const principal = c.frente.columnas.includes('principal') ? w.i32('principal') : undefined;
  const fatiga = campoO.fatiga !== undefined && c.frente.columnas.includes('fatiga') ? w.f32('fatiga') : undefined;
  const genoma = campoO.escucha === undefined ? undefined : w.f32('genoma');
  let offset = r.organismos + desdeO * anchoOrganismo;
  for (const s of slots) {
    const base = s * CUERPO_ANCHO;
    binario.setFloat64(offset + campoO.uid, uid[s], true);
    binario.setUint8(offset + campoO.clase, clase[s]);
    binario.setFloat32(offset + campoO.x, x[s], true);
    binario.setFloat32(offset + campoO.y, y[s], true);
    binario.setUint8(offset + campoO.accion, accion[s]);
    binario.setUint8(offset + campoO.hambre, Math.round(cuerpo[base + CAMPOS_CUERPO.hambre] * escalaU8));
    binario.setUint8(offset + campoO.sed, Math.round(cuerpo[base + CAMPOS_CUERPO.sed] * escalaU8));
    binario.setUint8(offset + campoO.energia, Math.round(cuerpo[base + CAMPOS_CUERPO.energia] * escalaU8));
    binario.setUint8(offset + campoO.salud, Math.round(cuerpo[base + CAMPOS_CUERPO.salud] * escalaU8));
    binario.setFloat32(offset + campoO.masa, cuerpo[base + CAMPOS_CUERPO.masa], true);
    binario.setUint32(offset + campoO.forma, forma?.[s] ?? 0, true);
    binario.setUint32(offset + campoO.principal, principal?.[s] ?? 0, true);
    if (campoO.fatiga !== undefined) binario.setFloat32(offset + campoO.fatiga, fatiga?.[s] ?? NaN, true);
    if (campoO.carga !== undefined) binario.setFloat32(offset + campoO.carga, cuerpo[base + CAMPOS_CUERPO.carga], true);
    if (campoO.T !== undefined) binario.setFloat32(offset + campoO.T, cuerpo[base + CAMPOS_CUERPO.T], true);
    if (genoma) {
      const locus = s * GENOMA_ANCHO + 2 * ESCUCHA_LOCUS;
      const escucha = clase[s] === Clase.Persona ? (genoma[locus] + genoma[locus + 1]) / 2 : 0;
      binario.setUint8(offset + campoO.escucha, Math.round(escucha * escalaU8));
    }
    offset += anchoOrganismo;
  }

  const materia = ley(c.mundo, 'materia') ? c as CtxLeyMateria : undefined;
  if (materia && (!materia.materia || !materia.quimica)) throw new Error('El fotograma de materia necesita arena y química.');
  const paginas = new Int32Array(f.ranura, r.paginas, capP * 2);
  const reparto = f.completo ? new Int16Array(f.ranura, r.reparto, capP) : undefined;
  for (let p = 0; p < chunks.length; p++) {
    const fila = desdeP + p, chunk = chunks[p];
    paginas[2 * fila] = t.paginaX[chunk];
    paginas[2 * fila + 1] = t.paginaY[chunk];
    if (reparto) reparto[fila] = c.hilo;
    const primera = chunk * PAGE_CELLS;
    offset = r.celdas + fila * PAGE_CELLS * anchoCelda;
    for (let celda = primera; celda < primera + PAGE_CELLS; celda++, offset += anchoCelda) {
      const mat = materia && matDeCelda(materia, celda);
      const a = mat?.[0], b = mat?.[1], d = mat?.[2];
      binario.setUint32(offset + campoC.mat0, a?.[0] ?? 0, true);
      binario.setUint32(offset + campoC.mat1, b?.[0] ?? 0, true);
      binario.setUint32(offset + campoC.mat2, d?.[0] ?? 0, true);
      binario.setUint8(offset + campoC.fr0, Math.round((a?.[1] ?? 0) * escalaU8));
      binario.setUint8(offset + campoC.fr1, Math.round((b?.[1] ?? 0) * escalaU8));
      binario.setUint8(offset + campoC.fr2, Math.round((d?.[1] ?? 0) * escalaU8));
      binario.setFloat32(offset + campoC.T, materia ? temperaturaDe(materia, celda) : NaN, true);
    }
  }
  return true;
}

function escribirSucesos(enlace: EnlaceCinta, sucesos: readonly SucesoFotograma[]): [number, number] {
  const desde = Atomics.load(enlace.sucesosEscritos, 0);
  const registros = sucesos.map(s => {
    if (s.tipo !== 'persona' || !s.vista) return serialize(s);
    // La ficha a petición puede compartir tipo estructural con la vista pública de cinta.
    const { experiences: _experiencias, trust: _confianza, ...vista } = s.vista as VistaPersonaFotograma & Pick<PersonView, 'experiences' | 'trust'>;
    return serialize({ ...s, vista });
  });
  const bytes = registros.reduce((n, body) => n + 4 + body.length, 0);
  if (!bytes) return [Number(desde), Number(desde)];
  const anillo = enlace.sucesos;
  if (!anillo || bytes > anillo.length) throw new ErrorFatalMotor('El lote de sucesos de un fotograma no cabe en el anillo de cinta.');
  const hasta = desde + BigInt(bytes), capacidad = BigInt(anillo.length);
  if (!Number.isSafeInteger(Number(hasta))) throw new ErrorFatalMotor('El cursor de sucesos no cabe en la cabecera del fotograma.');

  let leidos = Atomics.load(enlace.sucesosLeidos, 0);
  let vence = performance.now() + PLAZO_BARRERA_MS;
  while (hasta - leidos > capacidad) {
    const restante = vence - performance.now();
    if (restante <= 0) throw new ErrorFatalMotor('Plazo agotado esperando espacio para los sucesos de cinta.');
    Atomics.wait(enlace.sucesosLeidos, 0, leidos, restante);
    const actual = Atomics.load(enlace.sucesosLeidos, 0);
    if (actual !== leidos) vence = performance.now() + PLAZO_BARRERA_MS;
    leidos = actual;
  }

  let posicion = Number(desde % capacidad);
  const copiar = (v: Uint8Array): void => {
    const primera = Math.min(v.length, anillo.length - posicion);
    anillo.set(v.subarray(0, primera), posicion);
    anillo.set(v.subarray(primera), 0);
    posicion = (posicion + v.length) % anillo.length;
  };
  const cabecera = Buffer.allocUnsafe(4);
  for (const registro of registros) {
    cabecera.writeUInt32LE(registro.length);
    copiar(cabecera);
    copiar(registro);
  }
  return [Number(desde), Number(hasta)];
}

/** Tras B4: aborta sin avanzar los cursores o publica sucesos, serie y fotograma en ese orden. */
export function cerrarFotograma(c: CtxF0, enlace: EnlaceCinta, f: FotogramaEnCurso, valido: boolean): void {
  const e = estados.get(enlace);
  if (!e || e.enCurso !== f) throw new Error('El fotograma no es la ranura abierta de este enlace.');
  const i32 = new Int32Array(f.ranura, 0, 8), f64 = new Float64Array(f.ranura, 0, 8);
  const capO = i32[RANURA_I32.capOrganismos], capP = i32[RANURA_I32.capPaginas];
  const n = Atomics.load(i32, RANURA_I32.n), p = Atomics.load(i32, RANURA_I32.paginas);
  let publicado = false;
  try {
    if (!valido || n < 0 || n > capO || p < 0 || p > capP) return;
    const fuente = fuentes.get(enlace);
    if (!fuente) throw new Error('El enlace de fotogramas necesita una fuente de sucesos y serie.');
    const { sucesos, serie } = fuente.corte(c, f);
    const r = regionesRanura(capO, capP);
    new Float64Array(f.ranura, r.serie, SERIE_CAMPOS.length).set(SERIE_CAMPOS.map(k => serie[k]));
    const paginas = new Int32Array(f.ranura, r.paginas, 2 * p);
    const t = c.terreno, chunks: number[] = [];
    for (let i = 0; i < paginas.length; i += 2) {
      const celda = t.celda(paginas[i] * PAGE_SIDE, paginas[i + 1] * PAGE_SIDE);
      if (celda < 0) throw new Error('La página escrita dejó de estar residente antes de cerrar el fotograma.');
      chunks.push(t.chunkDe(celda));
    }
    const [desde, hasta] = escribirSucesos(enlace, sucesos);
    for (const chunk of chunks) e.versiones[chunk] = t.versionVisible[chunk] + 1;
    f64[RANURA_F64.sucesosDesde] = desde;
    f64[RANURA_F64.sucesosHasta] = hasta;
    Atomics.store(enlace.sucesosEscritos, 0, BigInt(hasta));
    e.saltados = 0;
    e.primero = false;
    Atomics.add(enlace.entregados, 0, 1n);
    Atomics.notify(enlace.entregados, 0);
    publicado = true;
    fuente.confirmar(f);
  } finally {
    e.enCurso = null;
    if (!publicado) {
      e.saltados++;
      if (f.completo) Atomics.store(enlace.pedirCompleto, 0, 1);
      Atomics.add(enlace.creditos, 0, 1);
    }
  }
}
