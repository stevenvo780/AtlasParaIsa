import { deserialize } from 'node:v8';
import type { StructureView } from '../../shared/life.js';
import { ClaseSustancia, formaDeCodigo } from '../../shared/materia.js';
import { ELEMENTOS, TABLA } from '../../shared/naturaleza.js';
import type { PlaceView, Tile, WorldView } from '../../shared/types.js';
import type { LoteVisible } from '../../shared/vistas-v23.js';
import { INTERVALO_ECOLOGIA_TICKS } from '../ecologia-constantes.js';
import { algunoCerca, filtrarCerca } from '../indice-puntos.js';
import type { Violacion } from '../invariantes.js';
import type { CtxLey, CtxLeyMateria, Ley } from '../motor/acceso.js';
import { CHUNK_SIZE } from '../terrain.js';
import { fluirCalor } from './fluir.js';
import { fuegoEn, kappaDeRol, lotesDeCelda } from './ley-mundo.js';
import { pasoLote, type CtxPaso } from './paso.js';
import { anotarReaccionAplicada, reaccionObservadaDe } from './reaccion-observada.js';
import { desprender } from './romper.js';
import { Parte, Rol, type LoteRef, type Pedido, type ProcesoMaterial, type VistaLote } from './tipos.js';

export const AREA_OBRA_M2 = 1;
export const MASA_PORTANTE_KG_M2 = 8;
export const COBERTURA_COBIJO = 0.5;
export const CONDUCTANCIA_PIEZA_J_POR_K_TICK_M2 = 0.25;
export const FRACCION_FRACTURA_TERMICA = 0.01;
export const T_HOGAR_K = 330;
export const DENSIDAD_AGUA_KG_M3 = 1000;
export const DENSIDAD_GRANO_KG_M3 = 750;
export const FLUJO_CAPTACION_KG_M2_TICK = 0.001;
const MG_POR_KG = 1e6;
export const KG_POR_CUANTO_AGUA = (2 * TABLA[ELEMENTOS.indexOf('H')].masa + TABLA[ELEMENTOS.indexOf('O')].masa) / MG_POR_KG;

type Punto = { x: number; y: number };
export interface PiezaColocada extends Punto { lote: LoteRef }
export interface PiezaPendiente extends PiezaColocada {
  proceso: ProcesoMaterial | null;
  trabajoJ: number;
}
export interface EstadoObra {
  piezas: PiezaColocada[];
  pendiente: PiezaPendiente | null;
  agua: LoteRef;
  comida: LoteRef;
  terminada: boolean;
}

export type DepositoObra = 'agua' | 'comida';
type Propiedades = Pick<VistaLote, 'sellado' | 'aislamiento' | 'dureza' | 'tenacidad' | 'masa'>;
type Prestaciones = Propiedades & { cobertura: number; cobijo: number; volumen: number; calor: number };
export const estadoObra = (s: StructureView): EstadoObra | undefined =>
  (s as StructureView & { obraMaterial?: EstadoObra }).obraMaterial;

export function loteReservadoObra(c: CtxLey, ref: LoteRef): boolean {
  if (ref < 0) return false;
  return c.mundo.structures.some(s => {
    const obra = estadoObra(s);
    return obra && (obra.agua === ref || obra.comida === ref || obra.pendiente?.lote === ref);
  });
}

export function celdaObra(c: CtxLey, p: Punto): number {
  const celda = c.terreno.celda(p.x, p.y);
  return celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo ? celda : -1;
}

export function lotesEnObra(c: CtxLeyMateria, celda: number, rol: Rol): Float64Array {
  let refs = new Float64Array(1);
  const n = c.materia.lotes(celda, rol, refs);
  if (n <= refs.length) return refs.subarray(0, n);
  refs = new Float64Array(n);
  return refs.subarray(0, c.materia.lotes(celda, rol, refs));
}

const TODO: Pedido = { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null };

/** Vacía el origen con su calor. El rol y la celda pertenecen al lote de destino. */
export function trasladarLoteObra(c: CtxLeyMateria, lote: LoteRef, rol: Rol, celda: number, forma: number): LoteRef {
  const destino = c.materia.nuevo(rol, celda, forma);
  c.materia.moverParte(lote, destino, TODO);
  c.materia.liberar(lote);
  return destino;
}

export function colocarPieza(c: CtxLeyMateria, estructura: string, lote: LoteRef, celda: number): void {
  const s = c.mundo.structures.find(s => s.id === estructura);
  const obra = s && estadoObra(s);
  const p = s && (s.cells ?? [s]).find(p => celdaObra(c, p) === celda);
  if (!obra || !p || celda < 0 || !c.materia.propio(lote)) throw new Error('Pieza u obra fuera de su celda propia.');
  if (obra.piezas.some(pieza => pieza.lote === lote)) return;
  const vista = c.materia.vista(lote);
  if (!vista.forma || vista.masa <= 0 || !lotesEnObra(c, celda, Rol.Objeto).includes(lote)) {
    throw new Error('La pieza debe ser un lote con forma y masa en la celda de obra.');
  }
  obra.piezas.push({ x: p.x, y: p.y, lote: trasladarLoteObra(c, lote, Rol.Pieza, celda, vista.forma) });
  c.propio.marcar(c.terreno.chunkDe(celda), true);
}

export function piezasDe(c: CtxLeyMateria, estructura: string, out: LoteRef[]): LoteRef[] {
  const s = c.mundo.structures.find(s => s.id === estructura);
  out.length = 0;
  for (const { lote } of (s && estadoObra(s)?.piezas) ?? []) if (c.materia.propio(lote)) out.push(lote);
  return out;
}

export function areaPortante(pieza: VistaLote): number {
  const f = formaDeCodigo(pieza.forma);
  if (pieza.dureza <= 0 && pieza.tenacidad <= 0 || pieza.fase === 1 || pieza.fase === 2 || f.grueso === 0) return 0;
  return Math.min(f.largo * f.ancho, pieza.masa / MASA_PORTANTE_KG_M2);
}

export function prestacionesDePiezas(piezas: Iterable<VistaLote>, celdas: number, areaCubierta = Infinity): Prestaciones {
  const r: Prestaciones = { masa: 0, sellado: 0, aislamiento: 0, dureza: 0, tenacidad: 0, cobertura: 0, cobijo: 0, volumen: 0, calor: 0 };
  let area = 0, volumen = 0, calor = 0;
  for (const v of piezas) {
    r.masa += v.masa;
    const soporte = areaPortante(v);
    if (!soporte) continue;
    area += soporte;
    r.sellado += soporte * v.sellado;
    r.aislamiento += soporte * v.aislamiento;
    r.dureza += soporte * v.dureza;
    r.tenacidad += soporte * v.tenacidad;
    const f = formaDeCodigo(v.forma);
    volumen += soporte * f.grueso * f.hueco * v.sellado;
    calor += soporte * v.dureza * Math.max(0, v.T - T_HOGAR_K);
  }
  if (!area || !celdas) return r;
  r.cobertura = Math.min(1, Math.min(area, areaCubierta) / (celdas * AREA_OBRA_M2));
  r.sellado /= area; r.aislamiento /= area; r.dureza /= area; r.tenacidad /= area;
  if (r.cobertura < COBERTURA_COBIJO) return r;
  r.cobijo = r.cobertura * r.sellado;
  r.volumen = volumen;
  r.calor = calor / area;
  return r;
}

export function prestacionesObra(c: CtxLeyMateria, s: StructureView): Prestaciones {
  const vistas: VistaLote[] = [], areas = new Map<number, number>();
  for (const p of estadoObra(s)?.piezas ?? []) {
    const celda = celdaObra(c, p);
    if (celda < 0 || !c.materia.propio(p.lote)) continue;
    const v = c.materia.vista(p.lote);
    vistas.push(v);
    areas.set(celda, Math.min(AREA_OBRA_M2, (areas.get(celda) ?? 0) + areaPortante(v)));
  }
  let cubierta = 0;
  for (const area of areas.values()) cubierta += area;
  return prestacionesDePiezas(vistas, s.cells?.length ?? 1, cubierta);
}

export function servicioDe(c: CtxLeyMateria, estructura: string): Propiedades {
  const s = c.mundo.structures.find(s => s.id === estructura);
  const { masa, sellado, aislamiento, dureza, tenacidad } = s ? prestacionesObra(c, s) : prestacionesDePiezas([], 0);
  return { masa, sellado, aislamiento, dureza, tenacidad };
}

const densidad = (tipo: DepositoObra) => tipo === 'agua' ? DENSIDAD_AGUA_KG_M3 : DENSIDAD_GRANO_KG_M3;

export function loteDepositoObra(c: CtxLeyMateria, s: StructureView, tipo: DepositoObra): LoteRef {
  const ref = estadoObra(s)?.[tipo] ?? -1;
  return c.materia.propio(ref) ? ref : -1;
}

export function stockObra(c: CtxLeyMateria, s: StructureView, tipo: DepositoObra): number {
  const ref = loteDepositoObra(c, s, tipo);
  return ref < 0 ? 0 : c.materia.vista(ref).masa;
}

function moverKg(c: CtxLeyMateria, de: LoteRef, a: LoteRef, kg: number, tipo?: DepositoObra): number {
  const arena = c.materia;
  if (!(kg > 0)) return 0;
  if (tipo === 'agua') {
    const cuantos = Math.min(arena.vista(de).agua, Math.floor(kg / KG_POR_CUANTO_AGUA));
    return cuantos > 0 ? arena.moverParte(de, a, { parte: Parte.Agua, esp: 0, cuantos, kappa: null }) * KG_POR_CUANTO_AGUA : 0;
  }
  if (tipo === 'comida' && arena.vista(de).digerible <= 0) return 0;
  let ids = new Uint32Array(1);
  let n = arena.especies(de, ids);
  if (n > ids.length) n = arena.especies(de, ids = new Uint32Array(n));
  let movido = 0;
  for (const esp of ids.subarray(0, n)) {
    const masa = c.quimica.sustancia(esp).masa / MG_POR_KG;
    const redondear = tipo ? Math.floor : Math.ceil;
    const cuantos = Math.min(arena.cuantos(de, esp), redondear((kg - movido) / masa));
    if (cuantos > 0) movido += masa * arena.moverParte(de, a, { parte: Parte.Exacta, esp, cuantos, kappa: null });
  }
  return movido;
}

/** El llamador aporta un lote propio y alcanzable, con agua o alimento para su depósito. */
export function depositarEnObra(c: CtxLeyMateria, s: StructureView, tipo: DepositoObra, de: LoteRef, kg: number): number {
  if (!Number.isFinite(kg) || kg <= 0 || !c.materia.propio(de)) return 0;
  const obra = estadoObra(s);
  const celda = celdaObra(c, s);
  if (!obra || celda < 0 || de === obra.agua || de === obra.comida || obra.piezas.some(p => p.lote === de)) return 0;
  const ocupado = stockObra(c, s, 'agua') / densidad('agua') + stockObra(c, s, 'comida') / densidad('comida');
  const hueco = prestacionesObra(c, s).volumen - ocupado;
  if (hueco <= 0) return 0;
  if (obra[tipo] >= 0 && !c.materia.propio(obra[tipo])) return 0;
  const nuevo = obra[tipo] < 0;
  const destino = nuevo ? c.materia.nuevo(Rol.Objeto, celda, 0) : obra[tipo];
  const movido = moverKg(c, de, destino, Math.min(kg, hueco * densidad(tipo)), tipo);
  if (movido > 0) obra[tipo] = destino;
  else if (nuevo) c.materia.liberar(destino);
  return movido;
}

function pasoPieza(c: CtxLeyMateria, lote: LoteRef, celda: number): void {
  const ctx: CtxPaso = { arena: c.materia, quimica: c.quimica, azar: () => c.azar() };
  if (!reaccionObservadaDe(c.materia)) {
    ctx.anotar = (reaccion, veces, loteAplicado) => {
      anotarReaccionAplicada(c.materia, reaccion, veces, loteAplicado, c.tick);
      ctx.anotar = undefined;
    };
  }
  const entorno = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
  const vista = c.materia.vista(lote);
  const f = formaDeCodigo(vista.forma);
  pasoLote(ctx, lote, INTERVALO_ECOLOGIA_TICKS, kappaDeRol(Rol.Pieza));
  const g = CONDUCTANCIA_PIEZA_J_POR_K_TICK_M2 * f.largo * f.ancho * (1 - vista.aislamiento);
  const fuego = fuegoEn(c, celda);
  const caliente = fuego >= 0 ? fluirCalor(ctx, fuego, lote, g, INTERVALO_ECOLOGIA_TICKS) : 0;
  const ambiente = fluirCalor(ctx, lote, entorno.aire, g, INTERVALO_ECOLOGIA_TICKS);
  // La variación térmica ejerce trabajo de dilatación. Lo desprendido vuelve al suelo con su calor.
  desprender(c.materia, c.quimica, lote, entorno.suelo,
    (Math.abs(caliente) + Math.abs(ambiente)) * FRACCION_FRACTURA_TERMICA * (1 - vista.tenacidad), ctx.azar);
}

function retirarPiezaVacia(c: CtxLeyMateria, lote: LoteRef, celda: number): boolean {
  if (c.materia.vista(lote).masa > 0) return false;
  const { suelo } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
  c.materia.moverParte(lote, suelo, TODO);
  c.materia.liberar(lote);
  return true;
}

function derramar(c: CtxLeyMateria, obra: EstadoObra, suelo: LoteRef, volumen: number): void {
  for (const tipo of ['agua', 'comida'] as const) {
    const ref = obra[tipo];
    if (!c.materia.propio(ref)) continue;
    const masa = c.materia.vista(ref).masa;
    const capacidad = volumen * densidad(tipo);
    if (capacidad <= 0 || masa <= 0) {
      c.materia.moverParte(ref, suelo, TODO);
      c.materia.liberar(ref);
      obra[tipo] = -1;
      continue;
    }
    if (masa > capacidad) moverKg(c, ref, suelo, masa - capacidad);
    volumen = Math.max(0, volumen - c.materia.vista(ref).masa / densidad(tipo));
  }
}

function pasoObra(c: CtxLeyMateria): void {
  if (c.tick % INTERVALO_ECOLOGIA_TICKS !== 0) return;
  const ocupadas = new Set<LoteRef>();
  for (const s of c.mundo.structures) {
    const obra = estadoObra(s);
    const celda = celdaObra(c, s);
    if (!obra || celda < 0) continue;
    for (let i = obra.piezas.length - 1; i >= 0; i--) {
      const p = obra.piezas[i]!;
      const sitio = celdaObra(c, p);
      if (sitio < 0 || !c.materia.propio(p.lote)) continue;
      pasoPieza(c, p.lote, sitio);
      if (retirarPiezaVacia(c, p.lote, sitio)) obra.piezas.splice(i, 1);
      else ocupadas.add(p.lote);
      c.propio.marcar(c.terreno.chunkDe(sitio), true);
    }
    const servicio = prestacionesObra(c, s);
    s.condition = servicio.cobertura >= COBERTURA_COBIJO ? servicio.cobertura : 0;
    if (obra.agua >= 0 || obra.comida >= 0 || c.mundo.weather === 'rain' && servicio.volumen > 0) {
      const { suelo, agua } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
      derramar(c, obra, suelo, servicio.volumen);
      if (c.mundo.weather === 'rain') {
        c.mundo.inventionDynamics.waterCollected += depositarEnObra(c, s, 'agua', agua >= 0 ? agua : suelo,
          FLUJO_CAPTACION_KG_M2_TICK * servicio.cobijo * (s.cells?.length ?? 1) * AREA_OBRA_M2 * INTERVALO_ECOLOGIA_TICKS);
      }
    }
  }
  for (const [chunk, celdas] of indiceCaminos(c)) for (const celda of celdas) {
    let queda = false;
    for (const l of lotesEnObra(c, celda, Rol.Pieza)) {
      if (!c.materia.propio(l) || ocupadas.has(l)) continue;
      pasoPieza(c, l, celda);
      queda = !retirarPiezaVacia(c, l, celda) || queda;
      c.propio.marcar(chunk, true);
    }
    if (!queda) celdas.delete(celda);
  }
}

const SELLO_IDS = new Uint32Array(16);
const SELLO_Q = new Float64Array(16);
/** Huella de las piezas ya colocadas. No recorre el mundo: solo los lotes de esta obra. */
export function selloObra(c: CtxLeyMateria, s: StructureView): string {
  const obra = estadoObra(s);
  if (!obra) return '';
  let sello = `${obra.piezas.length}`;
  for (const p of obra.piezas) {
    if (!c.materia.propio(p.lote)) { sello += `|${p.lote}:ajeno`; continue; }
    const n = c.materia.especies(p.lote, SELLO_IDS, SELLO_Q);
    sello += `|${p.lote}@${p.x},${p.y}:${c.materia.calor(p.lote)}#${n}:`;
    for (let i = 0; i < n && i < SELLO_IDS.length; i++) sello += `${SELLO_IDS[i]}=${SELLO_Q[i]},`;
  }
  return sello;
}

/** Vista lenta de una obra: las piezas reales de sus lotes. Sin obra material, la estructura cruda. */
export function vistaEstructuraLenta(c: CtxLeyMateria, s: StructureView): StructureView {
  const obra = estadoObra(s);
  if (!obra) return s;
  const piezas = piezasVisibles(c, s);
  return piezas.length || s.piezas !== undefined ? { ...s, piezas } : s;
}

function piezasVisibles(c: CtxLeyMateria, s: StructureView): LoteVisible[] {
  const piezas: LoteVisible[] = [];
  for (const { x, y, lote } of estadoObra(s)?.piezas ?? []) {
    if (!c.materia.propio(lote)) continue;
    const { forma, principal, masa, T } = c.materia.vista(lote);
    if (forma && masa > 0) piezas.push({ x, y, rol: 'pieza', forma, principal, masa, T });
  }
  return piezas;
}

function comprobarObra(c: CtxLeyMateria): Violacion[] {
  const errores: Violacion[] = [], vistos = new Set<LoteRef>();
  for (const s of c.mundo.structures) {
    const obra = estadoObra(s);
    if (!obra) continue;
    const anotar = (detalle: string) => errores.push({ id: 't2-obra', gravedad: 'dura', tick: c.tick, detalle, contexto: { obra: s.id } });
    const planta = s.cells ?? [s];
    const ancla = celdaObra(c, s);
    const celdas = new Set(planta.map(p => celdaObra(c, p)));
    if (ancla < 0 || !celdas.has(ancla) || celdas.has(-1) || celdas.size !== planta.length
      || [...celdas].some(l => c.terreno.chunkDe(l) !== c.terreno.chunkDe(ancla))) anotar('Planta inválida para el chunk de la obra.');
    if (obra.pendiente && (!Number.isFinite(obra.pendiente.trabajoJ) || obra.pendiente.trabajoJ < 0
      || obra.pendiente.proceso && (obra.pendiente.proceso.lote !== obra.pendiente.lote
        || obra.pendiente.proceso.x !== obra.pendiente.x || obra.pendiente.proceso.y !== obra.pendiente.y))) {
      anotar('Proceso pendiente incoherente con su lote, celda o trabajo pagado.');
    }
    for (const [p, lote, rol] of [
      ...obra.piezas.map(p => [p, p.lote, Rol.Pieza] as const),
      ...(obra.pendiente ? [[obra.pendiente, obra.pendiente.lote, Rol.Objeto] as const] : []),
      ...([obra.agua, obra.comida].filter(ref => ref !== -1).map(ref => [s, ref, Rol.Objeto] as const)),
    ]) {
      const celda = celdaObra(c, p);
      if (vistos.has(lote) || celda < 0 || !celdas.has(celda) || !c.materia.propio(lote) || !lotesEnObra(c, celda, rol).includes(lote)) {
        anotar(`Referencia duplicada, ajena o fuera de su emplazamiento: ${lote}.`);
      } else if (rol === Rol.Pieza && !c.materia.vista(lote).forma) anotar(`Pieza sin forma: ${lote}.`);
      vistos.add(lote);
    }
  }
  return errores;
}

const caminosLocales = new WeakMap<CtxLey['mundo'], Map<number, Set<number>>>();
function indiceCaminos(c: CtxLey): Map<number, Set<number>> {
  let indice = caminosLocales.get(c.mundo);
  if (!indice) caminosLocales.set(c.mundo, indice = new Map());
  return indice;
}

export function registrarEmpedrado(c: CtxLey, celda: number): void {
  const chunk = c.terreno.chunkDe(celda), indice = indiceCaminos(c);
  let celdas = indice.get(chunk);
  if (!celdas) indice.set(chunk, celdas = new Set());
  celdas.add(celda);
}

function cargarEmpedrados(c: CtxLeyMateria, chunk: number): void {
  const x = c.terreno.paginaX[chunk]! * CHUNK_SIZE, y = c.terreno.paginaY[chunk]! * CHUNK_SIZE;
  const enObra = new Set(filtrarCerca(c.mundo.structures, { x, y }, CHUNK_SIZE,
    s => celdaObra(c, s) >= 0 && c.terreno.chunkDe(celdaObra(c, s)) === chunk).flatMap(s => estadoObra(s)?.piezas.map(p => p.lote) ?? []));
  for (let dy = 0; dy < CHUNK_SIZE; dy++) for (let dx = 0; dx < CHUNK_SIZE; dx++) {
    const celda = celdaObra(c, { x: x + dx, y: y + dy });
    if (celda >= 0 && lotesEnObra(c, celda, Rol.Pieza).some(l => !enObra.has(l))) registrarEmpedrado(c, celda);
  }
}

export function esPiedraDeObra(c: CtxLeyMateria, vista: VistaLote): boolean {
  if (areaPortante(vista) <= 0 || vista.dureza <= 0) return false;
  const sustancia = c.quimica.sustancia(vista.principal);
  return sustancia.clase === ClaseSustancia.Unidad && sustancia.prop.qOxidacion <= 0;
}

export function calidadEmpedrado(c: CtxLeyMateria, tesela: Tile): number {
  const celda = celdaObra(c, tesela);
  if (celda < 0 || tesela.terrain === 'water' || tesela.terrain === 'shelter') return 0;
  const lotes = lotesEnObra(c, celda, Rol.Pieza);
  if (!lotes.length || algunoCerca(c.mundo.structures, tesela, CHUNK_SIZE,
    s => !!estadoObra(s) && (s.cells ?? [s]).some(p => p.x === tesela.x && p.y === tesela.y))) return 0;
  let area = 0;
  for (const lote of lotes) if (c.materia.propio(lote)) {
    const v = c.materia.vista(lote);
    if (esPiedraDeObra(c, v)) area += areaPortante(v) * v.dureza;
  }
  return Math.min(1, area / AREA_OBRA_M2);
}

export function desgastarEmpedrado(c: CtxLeyMateria, tesela: Tile, trabajoJ: number): void {
  const celda = celdaObra(c, tesela);
  if (!(trabajoJ > 0) || calidadEmpedrado(c, tesela) <= 0) return;
  const lotes = lotesEnObra(c, celda, Rol.Pieza);
  const { suelo } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
  for (const l of lotes) {
    desprender(c.materia, c.quimica, l, suelo, trabajoJ / lotes.length, () => c.azar());
    retirarPiezaVacia(c, l, celda);
  }
  c.propio.marcar(c.terreno.chunkDe(celda), true);
}

function proyectarObra(c: CtxLeyMateria, vista: WorldView): void {
  if (!vista.structures) return;
  const obras = new Map(c.mundo.structures.map(s => [s.id, s]));
  // La proyección de terreno puede traer las estructuras vivas. Los kg visibles pertenecen a la vista.
  vista.structures = vista.structures.map(s => {
    const obra = obras.get(s.id);
    if (!obra) return s;
    return { ...s, piezas: piezasVisibles(c, obra), water: stockObra(c, obra, 'agua'), food: stockObra(c, obra, 'comida') };
  });
}

export const leyObra: Ley = {
  id: 't2', interruptor: 'obra', sustituye: ['estructuras'],
  F0: c => {
    const pedidos = c.peticiones('lugar');
    if (!pedidos.length) return;
    const lugares = new Map(c.mundo.places.map(l => [l.id, l]));
    for (const bytes of pedidos) {
      const lugar = deserialize(bytes) as PlaceView;
      if (!lugares.has(lugar.id)) lugares.set(lugar.id, lugar);
    }
    c.publicarLugares([...lugares.values()]);
  },
  iniciar: c => { for (const chunk of c.chunks) cargarEmpedrados(c as CtxLeyMateria, chunk); },
  alActivar: (c, chunk) => cargarEmpedrados(c as CtxLeyMateria, chunk),
  alRetirar: (c, chunk) => { indiceCaminos(c).delete(chunk); },
  F4: c => pasoObra(c as CtxLeyMateria),
  proyectar: {
    mundo: (c, vista) => proyectarObra(c as CtxLeyMateria, vista),
    tesela: (c, t, vista) => {
      const calidad = calidadEmpedrado(c as CtxLeyMateria, t);
      vista.paved = calidad > 0 ? calidad : undefined;
    },
  },
  comprobar: c => comprobarObra(c as CtxLeyMateria),
};
