/**
 * INTERFAZ PUENTE del mundo material (carril w). El esqueleto lo fijó la preparación de la oleada: w rellena los cuerpos
 * y puede añadir exportaciones, pero no cambia estas firmas (las consumen b, f, t1, t2, act, m6 y lab).
 *
 * Con `v23.materia` cada tesela residente tiene tres lotes (Suelo, Agua si hay charca, Vida) y cada página 16 × 16 un
 * lote de Aire y dos depósitos de agua (mar y cielo); la roca es latente hasta que alguien la saca. Los escalares de
 * `Tile` (comida, agua potable, humedad, vegetación, madera, piedra, crecimiento y fertilidad) pasan a ser VISTAS que w
 * escribe tras cada paso material de la página.
 *
 * La física está en `mundo.ts` (`MundoMaterial`); aquí va el enganche con el motor: qué páginas existen (activar,
 * retirar), cuándo da su paso cada una (cadencia escalonada), con qué forzamiento (luz, tiempo y estación), por dónde
 * va la química de los suelos (tarjeta o CPU), los fuegos, las vistas y el libro.
 */
import { ELEMENTOS, KAPPA_SUELO, KAPPA_SUELO_HH, NE } from '../../shared/naturaleza.js';
import type { MatTesela, SustanciaId, SustanciaVista } from '../../shared/materia.js';
import type { Tile, WorldView } from '../../shared/types.js';
import type { AireVisible, LoteVisible, MateriaMundoVisible } from '../../shared/vistas-v23.js';
import type { Violacion } from '../invariantes.js';
import type { CtxF0, CtxLey, CtxLeyMateria, Ley } from '../motor/acceso.js';
import { ErrorDispositivo, REF_NULA, TipoIntento, type ChunkId } from '../motor/contratos.js';
import { INTERVALO_TIEMPO_TICKS } from '../ecologia-constantes.js';
import { regionalClimateFactor, sortearTiempo } from '../clima.js';
import { asentarHuella, enlazarMateria, rasgoPorMadera, rasgoPorPiedra, type PuenteMaterial } from '../ecosystem.js';
import { marcarTesela } from '../soa/barrera-percepcion.js';
import { tileLookup } from '../tile-index.js';
import { CanalCompartido } from '../gpu/canal.js';
import { crearPasoMateriaGpu, type PasoMateriaGpu } from '../gpu/materia-gpu.js';
import type { TotalesMateria } from './libro.js';
import { CUENTA, MundoMaterial, NOMBRE_CUENTA, N_CUENTAS, luzDe, luzMedia, type BaseMundo, type Forzamiento } from './mundo.js';
import { Rol, nivelDeLote, type Kappa, type LoteRef, type Plantilla } from './tipos.js';
import { vistaAireVacia, vistaVacia, type VistaAire, type VistaTesela } from './vistas.js';

export const leyMundo: Ley = {
  id: 'w', interruptor: 'materia', sustituye: ['ecologia', 'kernel'],
  iniciar, alActivar, alRetirar, F0, F1: asentarLibro, eco, F6: asentarLibro,
  proyectar: { tesela: proyectarTesela, mundo: proyectarMundo },
  comprobar,
};

// ── Constantes del enganche ──────────────────────────────────────────────────────────────────────────────

/** Anomalía de temperatura de una página por unidad de amplitud estacional (K). Real: 5–15 K entre estaciones en
 * latitudes medias. La estación de `clima.ts` entra en la materia como temperatura (de ella salen la evaporación y la
 * velocidad de la química) y como prisa de la lluvia (`Forzamiento.lluviaEscala`). */
const AMPLITUD_TERMICA_K = 10;
/** Plazo de la tarjeta para devolver la química de los suelos de un tick (ms); vencido, ese paso se da en CPU. */
const PLAZO_GPU_MS = 50;
/** Ticks que w espera antes de volver a abrir la tarjeta tras un fallo. */
const REINTENTO_GPU_TICKS = 600;
/** Ticks entre dos inventarios para el panel «Materia» (recorre todos los lotes del dueño). */
const PANEL_TICKS = 600;
/** Lo que el asiento de fuentes del hilo puede valer antes de materializar otra página (J o mmol de átomos): el libro
 * del hilo es de enteros exactos (< 2⁵³) y el coordinador lo pliega en cada F0, así que una tanda de páginas nuevas que
 * no quepa espera al tick siguiente. */
const MARGEN_LIBRO = 2 ** 52;

const SIN_CATALISIS: Kappa = [0, 0, 0, 0];
const CATALISIS_SUELO: Kappa = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH];
/** Catálisis que lleva un lote por su rol (materia.cierre): el suelo y el cadáver descomponen; aire, agua, roca,
 * objetos, piezas, tejido y fuego no catalizan. El digestivo lleva la κ de su plantilla (`Plantilla.kappa`), no esta. */
export const kappaDeRol = (rol: Rol): Kappa => rol === Rol.Suelo || rol === Rol.Cadaver ? CATALISIS_SUELO : SIN_CATALISIS;

/** Compartimentos del panel «Materia», en el orden de `Rol` (el de Roca son los dos depósitos de agua de cada página,
 * que no tienen rol propio) más lo que está en vuelo y lo que salió del mundo por una cuenta declarada. */
const COMPARTIMENTOS = ['Suelo', 'Agua', 'Vida', 'Aire', 'Mar y cielo', 'Tejido', 'Reserva', 'Digestivo', 'Embrión', 'Objeto',
  'Cadáver', 'Pieza', 'enVuelo', 'exterior'] as const;
const EN_VUELO = 12, EXTERIOR = 13;
const ROLES_EN_CELDA = [Rol.Objeto, Rol.Cadaver, Rol.Pieza] as const;
const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];

// ── Estado del dueño ─────────────────────────────────────────────────────────────────────────────────────

interface Estado {
  /** El contexto vigente (se pone al día en cada gancho): lo leen los cierres que el mundo material llama. */
  caja: { c: CtxLeyMateria };
  m: MundoMaterial;
  /** `Tile` de cada tesela del mundo material (por su índice), mientras su página está despierta. */
  teselas: (Tile | undefined)[];
  /** Por página: tick de su último paso y sal de su desfase. */
  ultimo: Int32Array;
  sal: Uint32Array;
  /** Chunks residentes que aún no pudieron materializarse (sin teselas todavía, o sin sitio en el libro del hilo). */
  pendientes: Set<ChunkId>;
  asientoPagina: number;
  /** Lotes que arden, por celda. */
  fuegos: Map<number, LoteRef[]>;
  cuentas: bigint[];
  libro: { ancla: bigint[] | null; neto: bigint[]; vistoF: Float64Array; vistoS: Float64Array };
  gpu: { paso: PasoMateriaGpu | null; canal: CanalCompartido | null; reintento: number; fallo: string };
  panel: MateriaMundoVisible | null;
  panelTick: number;
  desde: Map<SustanciaId, number>;
  aire: Map<number, AireVisible>;
  aireVista: Record<string, AireVisible> | null;
  /** `Tile.mat` por tesela y el tick del paso de página con que se calculó. */
  mat: (MatTesela | undefined)[];
  matTick: number[];
  tocan: number[];
  forzamientos: (Forzamiento | undefined)[];
  luces: Map<number, Forzamiento>;
  lucesTick: number;
  puente: PuenteMaterial;
  v: VistaTesela;
  va: VistaAire;
}

const estados = new WeakMap<object, Estado>();

function conMateria(c: CtxLey): CtxLeyMateria {
  const m = c as Partial<CtxLeyMateria> & CtxLey;
  if (!m.materia || !m.quimica) throw new Error('La ley w exige la materia en el contexto del dueño (v23.materia).');
  return m as CtxLeyMateria;
}

function estado(c: CtxLey): Estado {
  let e = estados.get(c.mundo);
  if (e) e.caja.c = c as CtxLeyMateria;
  else estados.set(c.mundo, e = crear(conMateria(c)));
  return e;
}

function crear(c0: CtxLeyMateria): Estado {
  const caja = { c: c0 };
  const m = MundoMaterial.sobre({
    arena: c0.materia, quimica: c0.quimica, libro: c0.libro, hilo: c0.hilo, registro: c0.globales.registro,
    azar: () => caja.c.azar(),
    vecina(p, dir) {
      const t = caja.c.terreno, celda = t.celda((t.paginaX[p]! + DX[dir]!) * 16, (t.paginaY[p]! + DY[dir]!) * 16);
      return celda < 0 ? -1 : t.chunkDe(celda);
    },
    // El vapor que cruza a una página de otro dueño (o a una propia aún sin materializar) va por intento, con garantía.
    exportar(_p, q, garantia) {
      const c = caja.c;
      if (garantia.length === 0) return;
      c.buzon.enviar(c.terreno.duenoChunk[q]!, {
        tipo: TipoIntento.Depositar, de: REF_NULA, a: REF_NULA, celda: q * 256, lote: REF_NULA, nonce: c.id('nonce'),
        materia: garantia, dato: Float64Array.of(Rol.Aire, 0), bytes: null,
      });
    },
  });
  const e: Estado = {
    caja, m, teselas: [], ultimo: new Int32Array(0), sal: new Uint32Array(0), pendientes: new Set(), asientoPagina: 0,
    fuegos: new Map(), cuentas: Array<bigint>(N_CUENTAS).fill(0n),
    libro: { ancla: null, neto: Array<bigint>(NE + 1).fill(0n), vistoF: new Float64Array(NE + 1), vistoS: new Float64Array(NE + 1) },
    gpu: { paso: null, canal: null, reintento: 0, fallo: '' },
    panel: null, panelTick: 0, desde: new Map(), aire: new Map(), aireVista: null, mat: [], matTick: [],
    tocan: [], forzamientos: [], luces: new Map(), lucesTick: -1,
    puente: undefined as never, v: vistaVacia(), va: vistaAireVacia(),
  };
  e.puente = puenteDe(e);
  // El libro del hilo puede traer asientos de antes de que esta ley existiera: no son de este tramo.
  e.libro.vistoF.set(c0.libro.fuentes); e.libro.vistoS.set(c0.libro.sumideros);
  return e;
}

/** Lo que las funciones heredadas del ecosistema (talar, picar, pisar, labrar), que solo reciben la tesela, hacen sobre la
 * materia cuando la tesela es de este mundo. */
function puenteDe(e: Estado): PuenteMaterial {
  const mia = (tile: Tile): number => {
    const i = e.m.indiceDe(e.caja.c.terreno.celda(tile.x, tile.y));
    return i >= 0 && e.teselas[i] === tile ? i : -1;
  };
  return {
    extraer(tile, material, cantidad) {
      const i = mia(tile);
      return i < 0 ? undefined : sacar(e, i, material === 'wood' ? 'madera' : 'piedra', cantidad);
    },
    pisar(tile, vegetacion) {
      const i = mia(tile);
      if (i < 0) return false;
      e.m.pisar(i, Math.round(vegetacion * e.m.params.escalas.vegetacion));
      escribirTesela(e, i, tile);
      return true;
    },
    cultivar(tile, fertilidad, vegetacion) {
      const i = mia(tile);
      if (i < 0) return false;
      e.m.abonar(i, fertilidad);
      e.m.aportar(i, 'hoja', Math.round(vegetacion * e.m.params.escalas.vegetacion));
      escribirTesela(e, i, tile);
      return true;
    },
  };
}

const crecerI32 = (a: Int32Array, n: number): Int32Array => { if (a.length >= n) return a; const b = new Int32Array(Math.max(n, 2 * a.length, 16)); b.set(a); return b; };
const crecerU32 = (a: Uint32Array, n: number): Uint32Array => { if (a.length >= n) return a; const b = new Uint32Array(Math.max(n, 2 * a.length, 16)); b.set(a); return b; };

// ── Páginas: activar y retirar ───────────────────────────────────────────────────────────────────────────

/** Teselas residentes del chunk en el heap de este dueño, por celda local (ly · 16 + lx). */
function teselasDe(c: CtxLey, chunk: ChunkId): Tile[] {
  const en = tileLookup(c.mundo.tiles), x0 = c.terreno.paginaX[chunk]! * 16, y0 = c.terreno.paginaY[chunk]! * 16, out: Tile[] = [];
  for (let ly = 0; ly < 16; ly++) for (let lx = 0; lx < 16; lx++) {
    const t = en(x0 + lx, y0 + ly);
    if (t) out.push(t);
  }
  return out;
}

/** ¿Cabe otra página nueva en el libro del hilo antes de que el coordinador lo pliegue? */
function cabeEnLibro(e: Estado): boolean {
  const f = e.caja.c.libro.fuentes;
  for (let k = 0; k <= NE; k++) if (Math.abs(f[k]!) + 2 * e.asientoPagina > MARGEN_LIBRO) return false;
  return true;
}

/**
 * Deja el chunk con sus lotes y ligado a sus teselas. Por orden: la página dormida que este dueño conserva; los lotes
 * que la arena ya tiene en sus celdas (durmió con otro dueño, o el mundo se cargó); y, si nunca existió, los materializa
 * de los escalares de sus teselas (fuente «chunk nuevo»). Devuelve false si hay que reintentarlo.
 */
function activar(e: Estado, chunk: ChunkId): boolean {
  const c = e.caja.c, m = e.m, tiles = teselasDe(c, chunk);
  if (!tiles.length) { e.pendientes.add(chunk); return false; }
  let adoptada = false;
  if (m.tiene(chunk) && !(m.fin[chunk]! - m.inicio[chunk]! === tiles.length && m.despertar(chunk, tiles[0]!.x, tiles[0]!.y))) m.olvidar(chunk);
  if (!m.tiene(chunk)) {
    adoptada = m.adoptar(chunk, tiles);
    if (!adoptada) {
      if (!cabeEnLibro(e)) { e.pendientes.add(chunk); return false; }
      const antes = Math.abs(c.libro.fuentes[NE]!);
      m.materializar(chunk, tiles, luzDe(c.tick));
      e.asientoPagina = Math.max(e.asientoPagina, Math.abs(Math.abs(c.libro.fuentes[NE]!) - antes));
    }
  }
  e.pendientes.delete(chunk);
  e.ultimo = crecerI32(e.ultimo, chunk + 1); e.sal = crecerU32(e.sal, chunk + 1);
  e.ultimo[chunk] = c.tick;
  e.sal[chunk] = (Math.imul(c.terreno.paginaX[chunk]!, 0x9e3779b1) ^ Math.imul(c.terreno.paginaY[chunk]!, 0x85ebca77)) >>> 0;
  const i0 = m.inicio[chunk]!;
  for (let j = 0; j < tiles.length; j++) { e.teselas[i0 + j] = tiles[j]; e.matTick[i0 + j] = -1; }
  if (adoptada) { buscarFuegos(e, chunk); escribirVistas(e, chunk, 0); }
  anotarAire(e, chunk);
  e.aireVista = null;
  return true;
}

function iniciar(c: CtxLey): void {
  const e = estado(c);
  enlazarMateria(e.puente);
  for (const chunk of c.chunks) if (!(e.m.tiene(chunk) && e.m.activa[chunk] === 1)) activar(e, chunk);
  e.m.volcarCuentas(e.cuentas);
  asentar(e);
}

function alActivar(c: CtxLey, chunk: ChunkId): void {
  const e = estado(c);
  activar(e, chunk);
  e.m.volcarCuentas(e.cuentas);
  asentar(e);
}

/** El chunk deja de ser residente: sus teselas se llevan las vistas al día (es lo que se archiva con ellas) y sus lotes
 * se quedan en la arena, dormidos, hasta que el chunk vuelva. */
function alRetirar(c: CtxLey, chunk: ChunkId): void {
  const e = estado(c), m = e.m;
  e.pendientes.delete(chunk);
  if (!m.tiene(chunk)) return;
  if (m.activa[chunk] === 1) escribirVistas(e, chunk, 0);
  m.dormir(chunk);
  for (let i = m.inicio[chunk]!; i < m.fin[chunk]!; i++) { e.teselas[i] = undefined; e.mat[i] = undefined; }
  e.aire.delete(chunk);
  e.aireVista = null;
}

// ── El tick ──────────────────────────────────────────────────────────────────────────────────────────────

/** El tiempo del mundo lo sortea el coordinador con su azar; los dueños lo leen de `mundo.weather`. */
function F0(c: CtxF0): void {
  if (c.tick % INTERVALO_TIEMPO_TICKS !== 0) return;
  sortearTiempo(c.mundo, c.azar(), (suceso) => { c.suceso(suceso); },
    'Cambio de tiempo; la lluvia es agua que el cielo ya tenía, evaporada del mar, y vuelve a él por el desagüe.');
}

function asentarLibro(c: CtxLey): void { asentar(estado(c)); }

/** Forzamiento de un paso de `dt` ticks que acaba en `tick`: la luz media de cada mitad de la ventana y el tiempo. */
function ventana(e: Estado, tick: number, dt: number): Forzamiento {
  if (e.lucesTick !== tick) { e.luces.clear(); e.lucesTick = tick; }
  let f = e.luces.get(dt);
  if (!f) {
    const partido = e.m.params.reparto === 'strang' && dt > 1, mitad = partido ? Math.max(1, dt >> 1) : dt;
    const luz = luzMedia(tick - dt, tick - dt + mitad);
    f = { dt, luz, lluvia: e.caja.c.mundo.weather === 'rain', luzFin: mitad < dt ? luzMedia(tick - dt + mitad, tick) : luz };
    e.luces.set(dt, f);
  }
  return f;
}

/**
 * Fase eco: el paso material de las páginas a las que les toca. Cada página da su paso cada K = `v23.cadenciaMateria`
 * ticks con dt = K, escalonadas por una sal de sus coordenadas (1/K de ellas en cada tick). Los fuegos arden todos los
 * ticks, a su propio paso.
 */
function eco(c: CtxLey): void {
  const e = estado(c), m = e.m, tick = c.tick, K = Math.max(1, Math.floor(c.params.v23.cadenciaMateria));
  enlazarMateria(e.puente);
  asentar(e);
  m.completarPlantillas();
  if (e.pendientes.size) for (const chunk of [...e.pendientes]) activar(e, chunk);
  arderFuegos(e);
  const tocan = e.tocan, clima = c.params.ecologia, estacional = clima.amplitudEstacional > 0;
  tocan.length = 0;
  for (const p of c.chunks) {
    if (!m.tiene(p) || m.activa[p] !== 1 || (tick + e.sal[p]! % K) % K !== 0) continue;
    let f = ventana(e, tick, Math.min(K, Math.max(1, tick - e.ultimo[p]!)));
    if (estacional) {
      const k = regionalClimateFactor(c.mundo.seed, tick, c.terreno.paginaX[p]! * 16 + 8, c.terreno.paginaY[p]! * 16 + 8,
        clima.amplitudEstacional, clima.periodoEstacionalDias, clima.escalaClimaticaCeldas);
      m.dT[p] = (k.growthScale - 1) * AMPLITUD_TERMICA_K;
      f = { ...f, lluviaEscala: k.rainScale };
    }
    e.forzamientos[p] = f;
    tocan.push(p);
  }
  if (tocan.length) {
    for (const p of tocan) m.pasarAntes(p, e.forzamientos[p]!);
    quimicaSuelos(e, tocan);
    for (const p of tocan) {
      const f = e.forzamientos[p]!;
      m.pasarDespues(p, f);
      e.ultimo[p] = tick;
      escribirVistas(e, p, f.dt);
      anotarAire(e, p);
    }
  }
  m.volcarCuentas(e.cuentas);
  asentar(e);
}

// ── Química de los suelos: tarjeta o CPU ─────────────────────────────────────────────────────────────────

/** Para que quien aloja el motor comparta con w un paso material ya abierto sobre su canal (o lo retire con null). Si
 * nadie lo pone y `motor.gpu` nombra una tarjeta, w abre el suyo sobre la primera. */
export function enlazarPasoGpu(c: CtxLeyMateria, paso: PasoMateriaGpu | null): void {
  const g = estado(c).gpu;
  g.paso = paso; g.canal = null; g.fallo = '';
}

function pasoGpu(e: Estado): PasoMateriaGpu | null {
  const c = e.caja.c, g = e.gpu;
  if (g.paso) return g.paso;
  if (c.tick < g.reintento || c.params.motor.gpu.length === 0) return null;
  try {
    g.canal = new CanalCompartido(c.params.motor.gpu[0]!);
    g.paso = crearPasoMateriaGpu(g.canal);
  } catch (error) { soltarGpu(e, error); }
  return g.paso;
}

function soltarGpu(e: Estado, error: unknown): void {
  const g = e.gpu;
  try { g.paso?.cerrar(); } catch { /* la tarjeta ya no responde */ }
  try { g.canal?.cerrar(); } catch { /* ídem */ }
  g.paso = null; g.canal = null; g.reintento = e.caja.c.tick + REINTENTO_GPU_TICKS; g.fallo = String(error);
}

/**
 * Química de los suelos de las páginas que tocan. Con `v23.materiaGpu` va a la tarjeta, que nunca es autoridad: devuelve
 * cuántas veces aplicar cada reacción y la arena las aplica (con su recorte y su libro). Si la tarjeta falla o no llega a
 * tiempo (`ErrorDispositivo`), las páginas que falten dan ese paso en CPU en este mismo tick.
 */
function quimicaSuelos(e: Estado, tocan: readonly number[]): void {
  const c = e.caja.c, m = e.m, paso = c.params.v23.materiaGpu ? pasoGpu(e) : null, hechas = new Set<number>();
  if (paso) {
    try {
      // Un lanzamiento por duración de paso: casi siempre una sola (K).
      const porDt = new Map<number, number[]>();
      for (const p of tocan) {
        const dt = e.forzamientos[p]!.dt;
        let grupo = porDt.get(dt);
        if (!grupo) porDt.set(dt, grupo = []);
        grupo.push(p);
      }
      for (const [dt, grupo] of porDt) {
        suelosEnTarjeta(e, paso, grupo, dt);
        for (const p of grupo) hechas.add(p);
      }
    } catch (error) {
      if (!(error instanceof ErrorDispositivo)) throw error;
      soltarGpu(e, error);
    }
  }
  for (const p of tocan) if (!hechas.has(p)) m.quimicaSuelos(p, e.forzamientos[p]!.dt);
}

function suelosEnTarjeta(e: Estado, paso: PasoMateriaGpu, paginas: readonly number[], dt: number): void {
  const c = e.caja.c, m = e.m;
  let n = 0;
  for (const p of paginas) n += m.fin[p]! - m.inicio[p]!;
  const lotes = new Float64Array(n), kappas = new Float64Array(4 * n), T = new Float64Array(n);
  let k = 0;
  for (const p of paginas) for (let i = m.inicio[p]!; i < m.fin[p]!; i++, k++) {
    lotes[k] = m.suelo[i]!; T[k] = m.temperaturaLote(m.suelo[i]!);
    kappas.set(CATALISIS_SUELO, 4 * k);
  }
  paso.lanzar(m.ctx, lotes, kappas, dt, c.tick);
  const r = paso.esperar(PLAZO_GPU_MS), total = r.tripletas.length / 3;
  // `desde[i]` es la primera tripleta (a, b, veces) del lote i; las suyas acaban donde empiezan las del siguiente.
  for (let i = 0; i < n; i++) {
    const fin = i + 1 < r.desde.length ? r.desde[i + 1]! : total;
    for (let t = r.desde[i]!; t < fin; t++) {
      const veces = r.tripletas[3 * t + 2]!;
      if (!(veces > 0)) continue;
      const reaccion = c.quimica.reaccion(r.tripletas[3 * t]!, r.tripletas[3 * t + 1]!, nivelDeLote(T[i]!, CATALISIS_SUELO));
      if (reaccion) c.materia.aplicar(lotes[i]!, reaccion, veces);
    }
  }
}

// ── Vistas ───────────────────────────────────────────────────────────────────────────────────────────────

/** Los escalares de siempre van de 0 a 1 (madera y piedra, en sus unidades): la vista satura ahí, la materia no. */
const unidad = (x: number): number => x > 1 ? 1 : x > 0 ? x : 0;
/** Fondo de escala de las vistas de madera (kg) y de piedra (kg) de una tesela: el intervalo que admite el guardado
 * (mundo/validar.ts) y el que pinta el cliente. Un tronco que crece por encima sigue en su lote; la vista no lo enseña. */
const VISTA_MADERA_MAX = 12, VISTA_PIEDRA_MAX = 8;
const hasta = (x: number, max: number): number => x > max ? max : x > 0 ? x : 0;

/** Vuelca en la tesela las vistas de sus lotes. Un campo opcional que la tesela no tiene y vale 0 no se le añade. */
function escribirTesela(e: Estado, i: number, t: Tile): void {
  const v = e.m.vista(i, e.v);
  t.food = unidad(v.food); t.moisture = unidad(v.moisture); t.vegetation = unidad(v.vegetation);
  if (t.drinkingWater !== undefined || v.drinkingWater > 0) t.drinkingWater = unidad(v.drinkingWater);
  if (t.wood !== undefined || v.wood > 0) t.wood = hasta(v.wood, VISTA_MADERA_MAX);
  if (t.stone !== undefined || v.stone > 0) t.stone = hasta(v.stone, VISTA_PIEDRA_MAX);
  if (v.stone > VISTA_PIEDRA_MAX || t.rocaLatente !== undefined)
    t.rocaLatente = v.stone > VISTA_PIEDRA_MAX ? e.m.latente[i] : undefined;
  if (t.growth !== undefined || v.vegetation > 0) t.growth = unidad(v.vegetation);
  const fertilidad = unidad(e.m.fertilidad(i));
  if (t.fertility !== undefined || fertilidad > 0) t.fertility = fertilidad;
  marcarTesela(t);
}

const CAMPOS_VISTA = ['food', 'moisture', 'vegetation', 'drinkingWater', 'wood', 'stone', 'growth', 'fertility'] as const;

/**
 * Tras un paso de la página (o al despertarla o retirarla, con dt = 0): escribe las vistas en sus teselas, deja decaer
 * lo que el paso heredado del ecosistema llevaba y no es materia (huella, firme y cultivo), pone el rasgo que se ve de
 * acuerdo con la madera y la piedra que quedan y, si el terreno del dueño tiene esos campos en columnas que no siguen a
 * la tesela, los escribe también allí.
 */
function escribirVistas(e: Estado, p: number, dt: number): void {
  const c = e.caja.c, m = e.m, caminos = c.params.terreno.caminosFisicos, campos = c.propio.campos;
  for (let i = m.inicio[p]!, i1 = m.fin[p]!; i < i1; i++) {
    const t = e.teselas[i];
    if (!t) continue;
    escribirTesela(e, i, t);
    if (dt > 0) asentarHuella(t, dt, caminos);
    rasgoPorMadera(t); rasgoPorPiedra(t);
  }
  for (const nombre of CAMPOS_VISTA) {
    if (!campos.includes(nombre)) continue;
    const leido = c.propio.campo(nombre);
    let columna: ReturnType<typeof c.propio.escribible> | null = null;
    for (let i = m.inicio[p]!, i1 = m.fin[p]!; i < i1; i++) {
      const t = e.teselas[i], valor = t?.[nombre];
      if (valor === undefined || leido[m.celda[i]!] === valor) continue;
      columna ??= c.propio.escribible(nombre, p);
      columna[m.celda[i]! & 255] = valor;
    }
  }
  c.propio.marcar(p, true);
}

function anotarAire(e: Estado, p: number): void {
  const m = e.m, T = m.temperaturaLote(m.aire[p]!), v = m.vistaAire(p, T, e.va);
  let a = e.aire.get(p);
  if (!a) { e.aire.set(p, a = { humedadRelativa: 0, lluvia: 0, T: 0 }); e.aireVista = null; }
  a.humedadRelativa = v.humedadRelativa; a.lluvia = v.lluvia; a.T = T;
}

/** `Tile.mat` de la tesela i: lo que se ve desde arriba. El dosel tapa la fracción de luz que captura; de lo que deja
 * ver, la charca tapa lo que está llena y el resto es suelo. De cada capa, su sustancia de más masa. */
function matDe(e: Estado, i: number): MatTesela {
  const m = e.m, A = e.caja.c.materia, tick = e.ultimo[m.paginaDe(i)]!;
  const guardado = e.mat[i];
  if (guardado && e.matTick[i] === tick) return guardado;
  const dosel = m.cubierta(i), charca = m.agua[i]! >= 0 ? unidad(A.cuantos(m.agua[i]!, m.S.H2O) / m.params.escalas.agua) : 0;
  const capas: [SustanciaId, number][] = [];
  if (dosel > 0) capas.push([A.vista(m.vida[i]!).principal, dosel]);
  if (charca > 0) capas.push([m.S.H2O, (1 - dosel) * charca]);
  if ((1 - dosel) * (1 - charca) > 0) capas.push([A.vista(m.suelo[i]!).principal, (1 - dosel) * (1 - charca)]);
  capas.sort((a, b) => b[1] - a[1]);
  e.mat[i] = capas; e.matTick[i] = tick;
  return capas;
}

function proyectarTesela(c: CtxLey, tesela: Tile, vista: Tile): void {
  const e = estados.get(c.mundo);
  if (!e) return;
  e.caja.c = c as CtxLeyMateria;
  const i = e.m.indiceDe(c.terreno.celda(tesela.x, tesela.y));
  if (i < 0) return;
  vista.mat = matDe(e, i);
  const aire = e.aire.get(e.m.paginaDe(i));
  if (aire) vista.T = aire.T;
}

function proyectarMundo(c: CtxLey, vista: WorldView): void {
  const e = estados.get(c.mundo);
  if (!e) return;
  e.caja.c = c as CtxLeyMateria;
  const cm = e.caja.c, m = e.m;
  vista.materia = panel(e);
  if (!e.aireVista) {
    e.aireVista = {};
    for (const [p, a] of e.aire) e.aireVista[`${c.terreno.paginaX[p]},${c.terreno.paginaY[p]}`] = a;
  }
  vista.aire = vista.aire ? Object.assign(vista.aire, e.aireVista) : e.aireVista;
  const fuegos: LoteVisible[] = [], referidas = new Set<SustanciaId>(vista.materia.sustancias.map((s) => s.id));
  for (const [celda, lista] of e.fuegos) {
    const i = m.indiceDe(celda);
    if (i < 0) continue;
    for (const l of lista) {
      if (!cm.materia.vivo(l)) continue;
      const v = cm.materia.vista(l);
      fuegos.push({ x: m.x[i]!, y: m.y[i]!, rol: 'fuego', forma: v.forma, principal: v.principal, masa: v.masa, T: v.T });
      referidas.add(v.principal);
    }
  }
  if (fuegos.length) vista.lotes = vista.lotes ? vista.lotes.concat(fuegos) : fuegos;
  const sustancias = vista.sustancias ?? (vista.sustancias = []);
  for (const s of sustancias) referidas.delete(s.id);
  for (const id of referidas) sustancias.push(sustanciaVista(cm, id));
}

function sustanciaVista(c: CtxLeyMateria, id: SustanciaId): SustanciaVista {
  const s = c.quimica.sustancia(id);
  return { id, clase: s.clase, atomos: [...s.atomos], enlaces: [...s.enlaces], masa: s.masa, prop: s.prop };
}

// ── Lo que consumen los demás carriles ───────────────────────────────────────────────────────────────────

/** Ids de las sustancias con nombre del mundo (agua, O₂, CO₂, N₂, madera, proteína…), internadas al crear la materia.
 * Nadie escribe un id de sustancia a mano: se leen de aquí o de Q. */
export function sustanciasDe(c: CtxLeyMateria): BaseMundo { return estado(c).m.S; }

/** Los lotes de una tesela residente y el aire de su página. `agua` es REF_NULA (−1) si la tesela no tiene charca. */
export interface LotesCelda { suelo: LoteRef; agua: LoteRef; vida: LoteRef; aire: LoteRef }
/** Solo para celdas del dueño que llama (las ajenas, por intento `Tomar`/`Depositar` con su `Rol`). Las cuatro son
 * REF_NULA si la celda no es suya o su chunk aún no se ha materializado. */
export function lotesDeCelda(c: CtxLeyMateria, celda: number, out: LotesCelda): LotesCelda {
  const m = estado(c).m, i = m.indiceDe(celda);
  if (i < 0) { out.suelo = out.agua = out.vida = out.aire = REF_NULA; return out; }
  out.suelo = m.suelo[i]!; out.agua = m.agua[i]!; out.vida = m.vida[i]!; out.aire = m.aire[m.paginaDe(i)]!;
  return out;
}

/** Plantilla de la vegetación dominante de una tesela propia, o null si no tiene (roca, agua). Es la del órgano con más
 * átomos en la tesela, en su variante que toma el N y el P del suelo. */
export function plantillaVegetal(c: CtxLeyMateria, celda: number): Plantilla | null {
  const e = estado(c), m = e.m, i = m.indiceDe(celda);
  if (i < 0) return null;
  const u = m.unidades(i, { hoja: 0, fruto: 0, tronco: 0 });
  // Cuantos de tejido por unidad base: hoja 25, fruto 6, tronco 1 (PARTES de mundo.ts).
  const hoja = 25 * u.hoja, fruto = 6 * u.fruto, tronco = u.tronco;
  if (hoja + fruto + tronco === 0) return null;
  const organo = tronco >= hoja && tronco >= fruto ? 'tronco' : hoja >= fruto ? 'hoja' : 'fruto';
  return m.plantillas[organo][0]?.p ?? null;
}

/** Materializa hasta `kg` de la roca latente de una celda propia en un lote nuevo con rol Objeto y sin forma, y lo
 * devuelve (REF_NULA si no queda). La roca latente es una fuente declarada («roca») del libro. */
export function rocaDe(c: CtxLeyMateria, celda: number, kg: number): LoteRef {
  const e = estado(c), m = e.m, i = m.indiceDe(celda);
  if (i < 0 || !(kg > 0) || !(m.latente[i]! > 0)) return REF_NULA;
  const cuantos = Math.round(kg * m.params.escalas.piedra); // la escala de la piedra son los cuantos de SiO₂ de 1 kg
  if (!(cuantos > 0)) return REF_NULA;
  const lote = c.materia.nuevo(Rol.Objeto, celda, 0);
  m.sacarRoca(i, cuantos, lote);
  refrescar(e, i);
  return lote;
}

/** Lote que arde en una celda propia (REF_NULA si no hay fuego). Un fuego es un lote con rol Objeto que w mantiene
 * tomando aire de su página mientras quede combustible y su T supere la de ignición de lo que contiene. */
export function fuegoEn(c: CtxLeyMateria, celda: number): LoteRef {
  const lista = estado(c).fuegos.get(celda);
  if (lista) for (const l of lista) if (c.materia.vivo(l)) return l;
  return REF_NULA;
}

/** Prende `combustible` (lote propio en esa celda) con `julios` de calor de ignición que paga quien enciende (ya
 * debitados de su cuerpo o de otro fuego). Devuelve si quedó ardiendo. Con aire de sobra: O₂ ≥ 1× el estequiométrico.
 * Los `julios` entran al lote como fuente declarada «ignición» (quien enciende los sacó antes por un sumidero; si los
 * trajo con `moverCalor`, pasa 0). Queda ardiendo si tiene algo que oxidar y ha llegado a la temperatura de brasa; desde
 * entonces w lo hace arder cada tick con el aire de su página hasta que se consume o se enfría. */
export function encender(c: CtxLeyMateria, celda: number, combustible: LoteRef, julios: number): boolean {
  const e = estado(c), m = e.m, i = m.indiceDe(celda);
  if (i < 0 || !c.materia.propio(combustible)) return false;
  const calor = Math.round(julios);
  if (calor > 0) { c.materia.fuente(combustible, Float64Array.of(0, calor), c.libro); m.cuentas[CUENTA.IGNICION]! += calor; }
  if (!(m.oxigenoQuePide(combustible) > 0) || m.temperaturaLote(combustible) < m.params.fisica.tBrasa) return false;
  const lista = e.fuegos.get(celda);
  if (!lista) e.fuegos.set(celda, [combustible]);
  else if (!lista.includes(combustible)) lista.push(combustible);
  return true;
}

/** Un tick de todos los fuegos de páginas despiertas. El que se apaga deja su ceniza en el mismo lote, que radia hasta
 * la temperatura del aire. */
function arderFuegos(e: Estado): void {
  if (!e.fuegos.size) return;
  const c = e.caja.c, m = e.m;
  for (const [celda, lista] of e.fuegos) {
    const p = c.terreno.chunkDe(celda);
    if (!m.tiene(p) || m.activa[p] !== 1) continue;
    const aire = m.aire[p]!;
    let vivos = 0;
    for (const l of lista) {
      if (!c.materia.propio(l)) continue;
      if (m.arder(l, aire)) lista[vivos++] = l;
      else m.termostato(l, m.temperaturaLote(aire));
    }
    lista.length = vivos;
    if (vivos === 0) e.fuegos.delete(celda);
  }
}

/** Tras adoptar una página (durmió con otro dueño o el mundo se cargó): los objetos que siguen por encima de la
 * temperatura de brasa y con algo que oxidar son fuegos que ardían. */
function buscarFuegos(e: Estado, p: number): void {
  const c = e.caja.c, m = e.m, buf = new Float64Array(32), brasa = m.params.fisica.tBrasa;
  for (let i = m.inicio[p]!; i < m.fin[p]!; i++) {
    const celda = m.celda[i]!, n = Math.min(buf.length, c.materia.lotes(celda, Rol.Objeto, buf));
    for (let k = 0; k < n; k++) {
      const l = buf[k]!;
      if (m.temperaturaLote(l) < brasa || !(m.oxigenoQuePide(l) > 0)) continue;
      const lista = e.fuegos.get(celda);
      if (!lista) e.fuegos.set(celda, [l]); else if (!lista.includes(l)) lista.push(l);
    }
  }
}

/** Temperatura (K) del aire de la página de una celda residente (propia o ajena: solo lectura). */
export function temperaturaDe(c: CtxLeyMateria, celda: number): number {
  const m = estado(c).m, p = c.terreno.chunkDe(celda);
  if (m.tiene(p)) return m.temperaturaLote(m.aire[p]!);
  const buf = new Float64Array(1);
  return c.materia.lotes(celda, Rol.Aire, buf) > 0 ? c.materia.vista(buf[0]!).T : 0;
}

/** `Tile.mat` de una celda propia: hasta 3 pares [sustancia, fracción de masa] de su superficie. Aquí la fracción es la
 * de superficie que se ve de cada capa (dosel, charca, suelo), de mayor a menor. */
export function matDeCelda(c: CtxLeyMateria, celda: number): MatTesela {
  const e = estado(c), i = e.m.indiceDe(celda);
  return i < 0 ? [] : matDe(e, i);
}

/** Recursos de la vista heredada que una ley aún escalar saca de una tesela o le aporta. */
export type RecursoEscalar = 'comida' | 'agua' | 'madera' | 'piedra';

function refrescar(e: Estado, i: number): void {
  const t = e.teselas[i];
  if (t) escribirTesela(e, i, t);
}

function sacar(e: Estado, i: number, recurso: RecursoEscalar, cantidad: number): number {
  if (!(cantidad > 0)) return 0;
  const m = e.m, es = m.params.escalas;
  let hecho = 0;
  switch (recurso) {
    case 'comida': hecho = m.extraer(i, 'fruto', Math.round(cantidad * es.alimento)) / es.alimento; break;
    // El agua potable es la de la charca: donde no hay vaso, el escalar es 0 y no se saca nada.
    case 'agua': hecho = m.agua[i]! >= 0 ? m.beber(i, Math.round(cantidad * es.agua)) / es.agua : 0; break;
    case 'madera': hecho = m.extraer(i, 'tronco', Math.round(cantidad * es.madera)) / es.madera; break;
    case 'piedra': hecho = m.moverLatente(i, Math.round(cantidad * es.piedra)) / es.piedra; break;
  }
  refrescar(e, i);
  return hecho;
}

/**
 * Etapa con cuerpos (o fauna, técnica u obra) aún escalares: saca de una tesela propia `cantidad` del recurso, en las
 * unidades de su vista (`Tile.food`, `drinkingWater`, `wood`, `stone`), y manda esa materia al sumidero declarado «uso
 * heredado» del libro. Devuelve lo que salió, en las mismas unidades. Lo llaman las leyes heredadas en lugar de restar
 * del escalar; desaparece cuando la ley que come o recoge pasa a mover lotes.
 */
export function extraerEscalar(c: CtxLeyMateria, celda: number, recurso: RecursoEscalar, cantidad: number): number {
  const e = estado(c), i = e.m.indiceDe(celda);
  return i < 0 ? 0 : sacar(e, i, recurso, cantidad);
}

/** Lo simétrico: una ley heredada aporta `cantidad` a una tesela propia (sembrar, regar) como fuente declarada «aporte
 * heredado». Devuelve lo aportado. El agua va a la charca y, donde no hay, al suelo (riego). */
export function aportarEscalar(c: CtxLeyMateria, celda: number, recurso: RecursoEscalar, cantidad: number): number {
  const e = estado(c), m = e.m, i = m.indiceDe(celda), es = m.params.escalas;
  if (i < 0 || !(cantidad > 0)) return 0;
  let hecho = 0;
  switch (recurso) {
    case 'comida': hecho = m.aportar(i, 'fruto', Math.round(cantidad * es.alimento)) / es.alimento; break;
    case 'agua': hecho = m.regar(i, Math.round(cantidad * es.agua)) / es.agua; break;
    case 'madera': hecho = m.aportar(i, 'tronco', Math.round(cantidad * es.madera)) / es.madera; break;
    case 'piedra': hecho = -m.moverLatente(i, -Math.round(cantidad * es.piedra)) / es.piedra; break;
  }
  refrescar(e, i);
  return hecho;
}

// ── Libro e inventario ───────────────────────────────────────────────────────────────────────────────────

/** Estado del libro en lo que este dueño tiene: por posición (NE elementos y energía), lo que debería haber
 * (inicial + fuentes − sumideros) y lo que hay (Σ lotes + Σ en vuelo). Exacto, en bigint. Lo usan lab y los invariantes. */
export interface BalanceMateria { esperado: bigint[]; hallado: bigint[]; cuentas: Record<string, bigint> }

/** Suma al neto del tramo lo que el libro del hilo ha asentado desde la última mirada. Las posiciones de átomos de
 * fuentes y sumideros solo crecen entre dos plegados del coordinador: si alguna bajó, el libro se plegó y lo que hay se
 * cuenta desde cero. */
function asentar(e: Estado): void {
  const { fuentes, sumideros } = e.caja.c.libro, L = e.libro;
  let plegado = false;
  for (let k = 0; k < NE && !plegado; k++) plegado = fuentes[k]! < L.vistoF[k]! || sumideros[k]! < L.vistoS[k]!;
  for (let k = 0; k <= NE; k++) {
    const f = fuentes[k]!, s = sumideros[k]!;
    L.neto[k]! += BigInt(f - (plegado ? 0 : L.vistoF[k]!)) - BigInt(s - (plegado ? 0 : L.vistoS[k]!));
    L.vistoF[k] = f; L.vistoS[k] = s;
  }
}

interface Inventario { atomos: bigint[][]; energia: bigint[]; masa: Map<SustanciaId, number> }

/** Reparto por compartimento para el panel «Materia» (no es la conservación: esa usa `saldoPropio`). Recorre los lotes
 * que este dueño tiene: los del mundo material por sus tablas, los de los cuerpos y la carga por los organismos que hay
 * en el mundo y los que yacen en sus celdas (objetos, cadáveres y piezas) por la arena. No ve los cuerpos de los
 * organismos archivados con su chunk ni los lotes sueltos sin celda (fuego en curso, carne en reparto). Suma en dobles por tramos cortos (una página,
 * cien cuerpos) y pliega cada tramo en bigint: el total del mundo puede pasar de 2⁵³. */
function inventariar(e: Estado): Inventario {
  const c = e.caja.c, m = e.m, A = c.materia, q = c.quimica, nC = COMPARTIMENTOS.length;
  const atomos = Array.from({ length: nC }, () => Array<bigint>(NE).fill(0n)), energia = Array<bigint>(nC).fill(0n);
  const masa = new Map<SustanciaId, number>(), at = new Float64Array(nC * NE), en = new Float64Array(nC);
  const sumar = (l: LoteRef, comp: number): void => {
    for (const id of m.especies(l)) {
      const n = A.cuantos(l, id), s = q.sustancia(id);
      for (let k = 0; k < NE; k++) at[comp * NE + k]! += n * s.atomos[k]!;
      en[comp]! += n * s.energia;
      masa.set(id, (masa.get(id) ?? 0) + n * s.masa / 1e6);
    }
    en[comp]! += A.calor(l);
  };
  const plegar = (): void => {
    for (let comp = 0; comp < nC; comp++) {
      for (let k = 0; k < NE; k++) if (at[comp * NE + k] !== 0) { atomos[comp]![k]! += BigInt(at[comp * NE + k]!); at[comp * NE + k] = 0; }
      if (en[comp] !== 0) { energia[comp]! += BigInt(en[comp]!); en[comp] = 0; }
    }
  };
  let buf = new Float64Array(32);
  for (let p = 0; p < m.np; p++) {
    if (!m.tiene(p) || !A.propio(m.aire[p]!)) continue;
    for (let i = m.inicio[p]!; i < m.fin[p]!; i++) {
      sumar(m.suelo[i]!, Rol.Suelo); sumar(m.vida[i]!, Rol.Vida);
      if (m.agua[i]! >= 0) sumar(m.agua[i]!, Rol.Agua);
      for (const rol of ROLES_EN_CELDA) {
        // Una celda puede tener más objetos que el búfer (lascas, montones): se agranda y se vuelve a pedir.
        let n = A.lotes(m.celda[i]!, rol, buf);
        if (n > buf.length) n = A.lotes(m.celda[i]!, rol, buf = new Float64Array(2 * n));
        for (let k = 0; k < n; k++) sumar(buf[k]!, rol);
      }
    }
    sumar(m.aire[p]!, Rol.Aire); sumar(m.mar[p]!, Rol.Roca); sumar(m.cielo[p]!, Rol.Roca);
    plegar();
  }
  let cuerpos = 0;
  const cuerpo = (o: { cuerpo?: import('./tipos.js').Cuerpo; carga?: number[] }): void => {
    // Lo que lleva a cuestas (objetos de t1, agua acarreada) cuenta como objeto, con o sin cuerpo.
    if (o.carga) for (const l of o.carga) if (A.propio(l)) sumar(l, Rol.Objeto);
    const k = o.cuerpo;
    if (!k || !A.propio(k.tejido)) return;
    sumar(k.tejido, Rol.Tejido);
    if (A.vivo(k.reserva)) sumar(k.reserva, Rol.Reserva);
    if (A.vivo(k.digestivo)) sumar(k.digestivo, Rol.Digestivo);
    if (k.gestacion && A.vivo(k.gestacion.embrion)) sumar(k.gestacion.embrion, Rol.Embrion);
    if (++cuerpos % 100 === 0) plegar();
  };
  for (const persona of c.mundo.people) cuerpo(persona);
  for (const animal of c.mundo.animals) cuerpo(animal);
  plegar();
  return { atomos, energia, masa };
}

/** Σ de los lotes de este dueño por posición del libro: la arena recorre todos los suyos (`saldoPropio`), con uno o con
 * varios dueños. No sale del inventario del panel, que recorre teselas y organismos vivos en el mundo y no ve los cuerpos
 * de los animales que duermen archivados con su chunk (sus lotes siguen en la arena): eran los ≈ 5,6·10⁸ mmol de H que
 * faltaban en el tick 97 de la semilla 7. */
function saldoDe(e: Estado): bigint[] { return e.caja.c.materia.saldoPropio(); }

function balance(e: Estado): BalanceMateria {
  const c = e.caja.c, L = e.libro;
  e.m.volcarCuentas(e.cuentas);
  asentar(e);
  const hallado = saldoDe(e);
  for (let k = 0; k <= NE; k++) hallado[k]! += BigInt(c.libro.enVuelo[k]!);
  // Lo plegado por el coordinador, si el contexto lo ofrece (pedido al contrato); si no, el tramo que w ha visto pasar
  // por el libro del hilo desde que ancló la cuenta.
  const totales = (c as Partial<{ totales: TotalesMateria }>).totales;
  let esperado: bigint[];
  if (totales) {
    esperado = Array.from({ length: NE + 1 }, (_, k) =>
      totales.inicial[k]! + totales.fuentes[k]! - totales.sumideros[k]! + BigInt(c.libro.fuentes[k]!) - BigInt(c.libro.sumideros[k]!));
  } else {
    L.ancla ??= hallado.map((h, k) => h - L.neto[k]!);
    esperado = L.ancla.map((a, k) => a + L.neto[k]!);
  }
  const cuentas: Record<string, bigint> = {};
  NOMBRE_CUENTA.forEach((nombre, k) => { cuentas[nombre] = e.cuentas[k]!; });
  for (let k = 0; k < NE; k++) cuentas[`neto con el exterior (mmol de ${ELEMENTOS[k]})`] = e.cuentas[CUENTA.EXTERIOR_AT + k]!;
  return { esperado, hallado, cuentas };
}

export function conservacion(c: CtxLeyMateria): BalanceMateria { return balance(estado(c)); }

function comprobar(c: CtxLey): Violacion[] {
  const b = balance(estado(c)), out: Violacion[] = [];
  for (let k = 0; k <= NE; k++) {
    if (b.esperado[k] === b.hallado[k]) continue;
    out.push({
      id: 'w.libro', gravedad: 'dura', tick: c.tick,
      detalle: `El libro de la materia no cuadra en ${k < NE ? `átomos de ${ELEMENTOS[k]}` : 'energía'}: sobra ${b.hallado[k]! - b.esperado[k]!}.`,
      esperado: Number(b.esperado[k]), observado: Number(b.hallado[k]),
    });
  }
  return out;
}

/** Panel «Materia»: dónde están los átomos y la energía, qué sustancias hay y las cuentas declaradas. Se rehace cada
 * PANEL_TICKS (recorre todos los lotes del dueño). */
function panel(e: Estado): MateriaMundoVisible {
  const c = e.caja.c;
  if (e.panel && c.tick - e.panelTick < PANEL_TICKS) return e.panel;
  const inv = inventariar(e), b = balance(e);
  for (let k = 0; k < NE; k++) {
    inv.atomos[EN_VUELO]![k] = BigInt(c.libro.enVuelo[k]!);
    inv.atomos[EXTERIOR]![k] = -e.cuentas[CUENTA.EXTERIOR_AT + k]!;
  }
  inv.energia[EN_VUELO] = BigInt(c.libro.enVuelo[NE]!); inv.energia[EXTERIOR] = -e.cuentas[CUENTA.EXTERIOR_J]!;
  const sustancias: MateriaMundoVisible['sustancias'] = [];
  for (const [id, masa] of inv.masa) {
    if (!(masa > 0)) continue;
    let desde = e.desde.get(id);
    if (desde === undefined) e.desde.set(id, desde = c.tick);
    sustancias.push({ id, masa, desde });
  }
  sustancias.sort((x, y) => y.masa - x.masa);
  const cuentas: Record<string, string> = {};
  for (const nombre in b.cuentas) cuentas[nombre] = String(b.cuentas[nombre]);
  e.panelTick = c.tick;
  return e.panel = {
    tick: c.tick, compartimentos: [...COMPARTIMENTOS],
    atomos: inv.atomos.map((fila) => fila.map(String)), energia: inv.energia.map(String),
    cuentas, sustancias, conserva: b.esperado.every((x, k) => x === b.hallado[k]),
  };
}
