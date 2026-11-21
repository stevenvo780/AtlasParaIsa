/**
 * T145 + T151 + T153 — Fase B pura de la fase `personas` sobre `SharedArrayBuffer`.
 *
 * Este módulo es el cuerpo de cálculo que corre en cada worker de `StaticWorkerPool` (y, con
 * `hilos = 1`, en el propio hilo del coordinador). Es 100 % solo lectura sobre el terreno y las
 * personas empaquetadas: cada actor escribe únicamente su fila de salida (`actorSlot`), así que
 * no hay carreras ni `Atomics`. No lee relojes, ni la máquina, ni azar del proceso (T171).
 *
 * Paridad con `src/world/index.ts` (mismo orden de vecinos, mismos desempates, mismas fórmulas):
 * · `perceivedRoutes`: BFS en el disco `dx² + dy² ≤ RADIUS²` (RADIUS = 7) sobre teselas presentes
 *   y no-agua, vecinos en el orden del código real `(+1,0), (0,+1), (−1,0), (0,−1)`.
 * · `move`: BFS acotado (2048 extracciones, Chebyshev ≤ 24) hacia `target`, mismo orden de vecinos
 *   y misma regla «mejor = estrictamente más cerca»; devuelve el primer paso exacto.
 * · alimento `primero(reachable, dist − food·2 [+ recelo], food > 0.025 ∧ planAffordable)`,
 *   agua `primeroConFiltroCaro(reachable, dist [+ recelo], agua > 0.005 ∧ planAffordable)`,
 *   materiales `primero(nearby, resourceDistance, …)`.
 * · cuerpo: `bodilyNeedRates` + `advanceBody` de la tesela de partida, como al inicio de
 *   `bodyAndAction`; las decisiones de este paso usan el cuerpo ya avanzado.
 *
 * Fuera del núcleo (siguen siendo serie en `index.ts`): `explorationTarget`, la puntuación de
 * candidatos de `choose`, el pago de carga de agua de `move`, herramientas y cisternas al beber.
 */
import { advanceBody, type BodyRates, type BodyState } from '../body.js';
import { HAMBRE_POR_PASO, SED_POR_PASO, SED_POR_UNIDAD } from '../ecologia-constantes.js';
import { buscarPagina, CELDAS_POR_PAGINA } from './paginas.js';
import type { StaticRegion } from './particion.js';
import type { StaticWorkerHandlerJob } from './piscina.js';

export const RADIO_PERCEPCION = 7;
export const LADO_PERCEPCION = 2 * RADIO_PERCEPCION + 1;
export const CELDAS_PERCEPCION = LADO_PERCEPCION * LADO_PERCEPCION;
export const MOVE_MAX_EXTRACCIONES = 2048;
export const MOVE_RADIO_CHEBYSHEV = 24;
export const FORAGE_AMOUNT = 0.06;
export const EAT_AMOUNT = 0.0035;

/** Acciones en el mismo orden que el SoA de personas (`soa/personas.ts`). */
export const ACCIONES = ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest', 'approach', 'accompany', 'retreat', 'share',
  'gather', 'farm', 'build', 'cooperate', 'invent', 'repair', 'research', 'craft'] as const;
export const ACCION = Object.fromEntries(ACCIONES.map((accion, codigo) => [accion, codigo])) as { readonly [A in typeof ACCIONES[number]]: number };

/** Códigos de `Terrain`/`Biome` (`shared/types.ts`); 255 = desconocido o ausente. */
export const TERRENOS = ['water', 'soil', 'meadow', 'shelter'] as const;
export const BIOMAS = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'] as const;

/** Banderas por celda. */
export const CELDA_PRESENTE = 1, CELDA_CAMINABLE = 2, CELDA_REFUGIO = 4, CELDA_DESIERTO = 8;

/** Columnas Float64 de entrada por persona (`personasF64[campo · cap + slot]`). */
export const PF = {
  x: 0, y: 1, targetX: 2, targetY: 3, hunger: 4, thirst: 5, fatigue: 6, energy: 7, inventory: 8, wood: 9, stone: 10,
  curiosity: 11, sociability: 12, industriousness: 13, care: 14, resilience: 15, heading: 16,
  payload: 17, foodDemand: 18, waterDemand: 19, disputaX: 20, disputaY: 21, work: 22, workDuration: 23,
} as const;
export const NPF = 24;
/** Columnas Int32 de entrada por persona. */
export const PI = { actionCode: 0, needsDecision: 1, shouldMove: 2, regionId: 3, disputaActiva: 4 } as const;
export const NPI = 5;

/** Columnas Int32 de salida por persona (escritura exclusiva por `actorSlot`). */
export const SI = {
  nextX: 0, nextY: 1, moveStatus: 2, bestFoodX: 3, bestFoodY: 4, bestWaterX: 5, bestWaterY: 6,
  bestResourceX: 7, bestResourceY: 8, found: 9, intentKind: 10, intentCellX: 11, intentCellY: 12,
  routeSteps: 13, stepsFood: 14, stepsWater: 15,
} as const;
export const NSI = 16;
/** Columnas Float64 de salida por persona. */
export const SF = { intentAmount: 0, bodyHunger: 1, bodyThirst: 2, bodyFatigue: 3, bodyEnergy: 4 } as const;
export const NSF = 5;

/** `found`: qué objetivos encontró la Fase B. */
export const HALLADO_COMIDA = 1, HALLADO_AGUA = 2, HALLADO_RECURSO = 4;
/** `moveStatus`. */
export const MOVE_SIN_EVALUAR = -1, MOVE_EN_DESTINO = 0, MOVE_AVANZA = 1, MOVE_BLOQUEADO = 2;
/** `intentKind`. */
export const INTENTO_NINGUNO = 0, INTENTO_COMER = 1, INTENTO_COSECHAR = 2, INTENTO_BEBER = 3, INTENTO_MADERA = 4, INTENTO_PIEDRA = 5;

/** Nombres de los SAB del despacho. */
export const BUFFERS_PERSONAS = [
  'paginasX', 'paginasY', 'paginasSlot', 'celdaFlags', 'celdaComida', 'celdaAgua', 'celdaAguaPotable', 'celdaMadera', 'celdaPiedra',
  'celdaTerreno', 'celdaBioma', 'personasF64', 'personasI32', 'ordenSlots', 'salidaI32', 'salidaF64', 'salidaRutas',
] as const;
export type BuffersPersonas = Record<typeof BUFFERS_PERSONAS[number], SharedArrayBuffer>;

/** Parámetros del despacho: escalares estructurados (sin objetos JS pesados). */
export interface ParamsFaseBPersonas {
  capPersonas: number;
  personas: number;
  hashMask: number;
  lluvia: boolean;
  memoriaDisputa: number;
  disputaDestino: number;
  /** Bucle real: solo BFS invariantes; cuerpo, stocks y selección se confirman en serie. */
  soloRutasYMovimiento?: boolean;
}

/** Vistas tipadas sobre los SAB. Se reconstruyen por llamada (coste despreciable). */
export interface VistaPersonas {
  paginasX: Int32Array; paginasY: Int32Array; paginasSlot: Int32Array;
  flags: Uint8Array; comida: Float64Array; agua: Float64Array; aguaPotable: Float64Array; madera: Float64Array; piedra: Float64Array;
  terreno: Uint8Array; bioma: Uint8Array;
  pf: Float64Array; pi: Int32Array; orden: Int32Array; si: Int32Array; sf: Float64Array;
  rutas: Int16Array;
  params: ParamsFaseBPersonas;
}

export function crearVista(buffers: Readonly<Record<string, SharedArrayBuffer>>, params: ParamsFaseBPersonas): VistaPersonas {
  return {
    paginasX: new Int32Array(buffers.paginasX!), paginasY: new Int32Array(buffers.paginasY!), paginasSlot: new Int32Array(buffers.paginasSlot!),
    flags: new Uint8Array(buffers.celdaFlags!), comida: new Float64Array(buffers.celdaComida!), agua: new Float64Array(buffers.celdaAgua!),
    aguaPotable: new Float64Array(buffers.celdaAguaPotable!), madera: new Float64Array(buffers.celdaMadera!), piedra: new Float64Array(buffers.celdaPiedra!),
    terreno: new Uint8Array(buffers.celdaTerreno!), bioma: new Uint8Array(buffers.celdaBioma!),
    pf: new Float64Array(buffers.personasF64!), pi: new Int32Array(buffers.personasI32!), orden: new Int32Array(buffers.ordenSlots!),
    si: new Int32Array(buffers.salidaI32!), sf: new Float64Array(buffers.salidaF64!),
    rutas: new Int16Array(buffers.salidaRutas!), params,
  };
}

/** Índice global de celda o −1 si la tesela no existe. */
export function celdaDe(vista: VistaPersonas, x: number, y: number): number {
  const slot = buscarPagina(vista, x >> 4, y >> 4);
  if (slot < 0) return -1;
  const celda = slot * CELDAS_POR_PAGINA + ((y & 15) << 4) + (x & 15);
  return vista.flags[celda]! & CELDA_PRESENTE ? celda : -1;
}

// ── Scratch por hilo (cada worker y el coordinador tienen el suyo; nunca se comparte) ──────

/** Ventana de páginas resueltas: evita el hash en los bucles calientes del BFS. */
const VENTANA_MAX = 6;
const ventana = new Int32Array(VENTANA_MAX * VENTANA_MAX);
let ventanaPx0 = 0, ventanaPy0 = 0, ventanaAncho = 0;

function cargarVentana(vista: VistaPersonas, cx: number, cy: number, radio: number): void {
  const px0 = (cx - radio) >> 4, px1 = (cx + radio) >> 4, py0 = (cy - radio) >> 4, py1 = (cy + radio) >> 4;
  ventanaPx0 = px0; ventanaPy0 = py0; ventanaAncho = px1 - px0 + 1;
  for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) {
    ventana[(py - py0) * ventanaAncho + (px - px0)] = buscarPagina(vista, px, py);
  }
}

/** Celda presente dentro de la ventana cargada, o −1. */
function celdaVentana(vista: VistaPersonas, x: number, y: number): number {
  const slot = ventana[((y >> 4) - ventanaPy0) * ventanaAncho + ((x >> 4) - ventanaPx0)]!;
  if (slot < 0) return -1;
  const celda = slot * CELDAS_POR_PAGINA + ((y & 15) << 4) + (x & 15);
  return vista.flags[celda]! & CELDA_PRESENTE ? celda : -1;
}

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

// Rutas percibidas: rejilla local (2R+1)² con pasos (−1 = sin ruta).
const LADO_R = LADO_PERCEPCION;
const rutaPasos = new Int16Array(CELDAS_PERCEPCION);
const rutaTierra = new Int32Array(LADO_R * LADO_R); // celda global si es tierra percibida, −1 si no
const rutaCola = new Int32Array(LADO_R * LADO_R);
/** Teselas cercanas (`nearbyTiles`) en su orden de `choose`: índice local en la rejilla. */
const cercanas = new Int32Array(LADO_R * LADO_R);
let numCercanas = 0;

/**
 * `perceivedRoutes` + `nearbyTiles` de `choose`. Deja en `rutaPasos` los pasos BFS por celda local
 * y en `cercanas[0..numCercanas)` las teselas tierra del disco en orden `dy` exterior, `dx` interior.
 * Devuelve el tamaño del mapa de rutas (incluido el origen, como el `Map` real).
 */
function calcularRutas(vista: VistaPersonas, px: number, py: number): number {
  const R = RADIO_PERCEPCION;
  cargarVentana(vista, px, py, R);
  numCercanas = 0;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const local = (dy + R) * LADO_R + (dx + R);
    rutaPasos[local] = -1; rutaTierra[local] = -1;
    if (dx * dx + dy * dy > R * R) continue;
    const celda = celdaVentana(vista, px + dx, py + dy);
    if (celda >= 0 && vista.flags[celda]! & CELDA_CAMINABLE) { rutaTierra[local] = celda; cercanas[numCercanas++] = local; }
  }
  const origen = R * LADO_R + R;
  rutaPasos[origen] = 0; rutaCola[0] = origen;
  let cola = 1;
  for (let i = 0; i < cola; i++) {
    const actual = rutaCola[i]!, n = rutaPasos[actual]! + 1;
    const lx = actual % LADO_R, ly = (actual - lx) / LADO_R;
    for (let k = 0; k < 4; k++) {
      const nx = lx + DX[k]!, ny = ly + DY[k]!;
      // Fuera de la rejilla local nunca hay tierra percibida (el disco cabe entero en ella).
      if (nx < 0 || ny < 0 || nx >= LADO_R || ny >= LADO_R) continue;
      const vecino = ny * LADO_R + nx;
      if (rutaTierra[vecino]! >= 0 && rutaPasos[vecino]! < 0) { rutaPasos[vecino] = n; rutaCola[cola++] = vecino; }
    }
  }
  return cola;
}

// Movimiento: rejilla (2·24+1)² con sello de generación para no limpiar entre personas.
const LADO_M = 2 * MOVE_RADIO_CHEBYSHEV + 1;
const moveSello = new Int32Array(LADO_M * LADO_M);
const movePrevio = new Int32Array(LADO_M * LADO_M);
const moveCola = new Int32Array(LADO_M * LADO_M);
let generacion = 0;

/** Resultado del BFS de `move` (scratch reutilizado: copiar si se necesita conservar). */
export interface PasoMovimiento { estado: number; x: number; y: number }

/**
 * Primer paso exacto de `move()` hacia `(tx, ty)` desde `(sx, sy)`. Mismo orden de vecinos,
 * misma cota de 2048 extracciones y Chebyshev 24, misma regla de «mejor» y mismo retroceso.
 */
export function pasoMovimiento(vista: VistaPersonas, sx: number, sy: number, tx: number, ty: number, salida: PasoMovimiento): PasoMovimiento {
  if (Math.hypot(sx - tx, sy - ty) < 0.5) { salida.estado = MOVE_EN_DESTINO; salida.x = sx; salida.y = sy; return salida; }
  const M = MOVE_RADIO_CHEBYSHEV;
  cargarVentana(vista, sx, sy, M);
  generacion = (generacion + 1) | 0;
  if (generacion === 0) { moveSello.fill(0); generacion = 1; }
  const origen = M * LADO_M + M;
  moveSello[origen] = generacion; movePrevio[origen] = -1; moveCola[0] = origen;
  let cola = 1, cabeza = 0, mejor = origen;
  let mejorDist = Math.hypot(sx - tx, sy - ty);
  while (cabeza < cola && cabeza < MOVE_MAX_EXTRACCIONES) {
    const actual = moveCola[cabeza++]!;
    const lx = actual % LADO_M, ly = (actual - lx) / LADO_M;
    const cx = sx + lx - M, cy = sy + ly - M;
    const d = Math.hypot(cx - tx, cy - ty);
    if (d < mejorDist) { mejor = actual; mejorDist = d; }
    if (d < 0.5) { mejor = actual; break; }
    for (let k = 0; k < 4; k++) {
      const nlx = lx + DX[k]!, nly = ly + DY[k]!;
      // Chebyshev > 24 ⇔ fuera de la rejilla local.
      if (nlx < 0 || nly < 0 || nlx >= LADO_M || nly >= LADO_M) continue;
      const vecino = nly * LADO_M + nlx;
      if (moveSello[vecino] === generacion) continue;
      const celda = celdaVentana(vista, sx + nlx - M, sy + nly - M);
      if (celda < 0 || !(vista.flags[celda]! & CELDA_CAMINABLE)) continue;
      moveSello[vecino] = generacion; movePrevio[vecino] = actual; moveCola[cola++] = vecino;
    }
  }
  if (mejor === origen) { salida.estado = MOVE_BLOQUEADO; salida.x = sx; salida.y = sy; return salida; }
  while (movePrevio[mejor] !== origen) mejor = movePrevio[mejor]!;
  const lx = mejor % LADO_M, ly = (mejor - lx) / LADO_M;
  salida.estado = MOVE_AVANZA; salida.x = sx + lx - M; salida.y = sy + ly - M;
  return salida;
}

/** Para pruebas: el `Map` de `perceivedRoutes` reconstruido desde la rejilla del kernel. */
export function rutasPercibidas(vista: VistaPersonas, px: number, py: number): Map<string, number> {
  calcularRutas(vista, px, py);
  const R = RADIO_PERCEPCION, rutas = new Map<string, number>();
  for (let local = 0; local < LADO_R * LADO_R; local++) {
    const pasos = rutaPasos[local]!;
    if (pasos < 0) continue;
    const lx = local % LADO_R, ly = (local - lx) / LADO_R;
    rutas.set(`${px + lx - R},${py + ly - R}`, pasos);
  }
  return rutas;
}

// ── Fase B por persona ─────────────────────────────────────────────────────────────────

const cuerpo: BodyState = { hunger: 0, thirst: 0, fatigue: 0, energy: 0 };
const tasas: BodyRates = { hunger: 0, thirst: 0, energy: 0.00007, stressEnergy: 0.00015, fatigue: 0 };
const paso: PasoMovimiento = { estado: MOVE_SIN_EVALUAR, x: 0, y: 0 };

/** Cada actor es dueño de sus 225 celdas; no crea Map ni copia stocks mutables. */
function precomputarRutasYMovimiento(vista: VistaPersonas, slot: number): void {
  const { pf, pi, si, params } = vista, cap = params.capPersonas;
  const px = pf[PF.x * cap + slot]!, py = pf[PF.y * cap + slot]!;
  const inicio = slot * CELDAS_PERCEPCION;
  let rutas = 0;
  if (pi[PI.needsDecision * cap + slot]) {
    rutas = calcularRutas(vista, px, py);
    vista.rutas.set(rutaPasos, inicio);
  } else vista.rutas.fill(-1, inicio, inicio + CELDAS_PERCEPCION);
  si[SI.routeSteps * cap + slot] = rutas;
  paso.estado = MOVE_SIN_EVALUAR; paso.x = px; paso.y = py;
  if (pi[PI.shouldMove * cap + slot]) {
    pasoMovimiento(vista, px, py, pf[PF.targetX * cap + slot]!, pf[PF.targetY * cap + slot]!, paso);
  }
  si[SI.moveStatus * cap + slot] = paso.estado;
  si[SI.nextX * cap + slot] = paso.x; si[SI.nextY * cap + slot] = paso.y;
}

/** Fase B completa de un actor: escribe solo su fila de salida. */
export function faseBPersona(vista: VistaPersonas, slot: number): void {
  if (vista.params.soloRutasYMovimiento) { precomputarRutasYMovimiento(vista, slot); return; }
  const { pf, pi, si, sf, params } = vista, cap = params.capPersonas;
  const col = (c: number): number => c * cap + slot;
  const px = pf[col(PF.x)]!, py = pf[col(PF.y)]!, tx = pf[col(PF.targetX)]!, ty = pf[col(PF.targetY)]!;
  const accion = pi[col(PI.actionCode)]!;

  // 1. Tasas basales de la tesela de partida y cuerpo avanzado (`bodilyNeedRates` + `advanceNeeds`).
  cuerpo.hunger = pf[col(PF.hunger)]!; cuerpo.thirst = pf[col(PF.thirst)]!;
  cuerpo.fatigue = pf[col(PF.fatigue)]!; cuerpo.energy = pf[col(PF.energy)]!;
  const origen = celdaDe(vista, px, py);
  if (origen >= 0) {
    const f = vista.flags[origen]!;
    tasas.hunger = HAMBRE_POR_PASO * pf[col(PF.foodDemand)]!;
    tasas.thirst = (SED_POR_PASO + (f & CELDA_DESIERTO ? 0.0002 : 0)) * pf[col(PF.waterDemand)]!;
    tasas.fatigue = 0.00009 + (params.lluvia && !(f & CELDA_REFUGIO) ? 0.0001 : 0);
    advanceBody(cuerpo, tasas);
  }
  sf[SF.bodyHunger * cap + slot] = cuerpo.hunger; sf[SF.bodyThirst * cap + slot] = cuerpo.thirst;
  sf[SF.bodyFatigue * cap + slot] = cuerpo.fatigue; sf[SF.bodyEnergy * cap + slot] = cuerpo.energy;

  // 2. Rutas percibidas y objetivos locales.
  let found = 0, foodLocal = -1, waterLocal = -1, resourceLocal = -1, routeSteps = 0;
  if (pi[col(PI.needsDecision)]) {
    routeSteps = calcularRutas(vista, px, py);
    vista.rutas.set(rutaPasos, slot * CELDAS_PERCEPCION);
    const R = RADIO_PERCEPCION, energy = cuerpo.energy, fatigue = cuerpo.fatigue;
    const payload = pf[col(PF.payload)]!, resilience = pf[col(PF.resilience)]!;
    const planAffordable = (steps: number, work: number): boolean => energy >= steps * (.0008 + payload * .0008) + work * .0003
      && fatigue + steps * (.0007 * (1.2 - resilience * .4) + payload * .0007) + work * .00025 * (1.2 - resilience * .4) < 1;
    const disputada = params.memoriaDisputa > 0 && pi[col(PI.disputaActiva)] === 1;
    const dX = pf[col(PF.disputaX)]!, dY = pf[col(PF.disputaY)]!;
    const recelo = (x: number, y: number): number => Math.hypot(x - dX, y - dY) < params.disputaDestino ? params.memoriaDisputa : 0;
    const mWood = pf[col(PF.wood)]!, mStone = pf[col(PF.stone)]!;
    let foodKey = 0, waterKey = 0, resourceKey = 0;
    for (let i = 0; i < numCercanas; i++) {
      const local = cercanas[i]!, celda = rutaTierra[local]!;
      const lx = local % LADO_R, ly = (local - lx) / LADO_R;
      const cx = px + lx - R, cy = py + ly - R;
      const dist = Math.hypot(px - cx, py - cy);
      // Materiales: sobre `nearbyTiles` (no exige ruta), como en `choose`.
      const wood = vista.madera[celda]!, stone = vista.piedra[celda]!;
      if ((wood >= 1 && mWood < 12) || (stone >= 1 && mStone < 8)) {
        const useful = mWood < 6 ? wood >= 1 : stone >= 1;
        const key = dist + (useful ? 0 : 20);
        if (resourceLocal < 0 || key - resourceKey < 0) { resourceLocal = local; resourceKey = key; }
      }
      const steps = rutaPasos[local]!;
      if (steps < 0) continue; // `reachableTiles`
      const food = vista.comida[celda]!;
      const fKey = disputada ? dist - food * 2 + recelo(cx, cy) : dist - food * 2;
      if (food > 0.025 && planAffordable(steps, 0) && (foodLocal < 0 || fKey - foodKey < 0)) { foodLocal = local; foodKey = fKey; }
      const wKey = disputada ? dist + recelo(cx, cy) : dist;
      if (waterLocal >= 0 && !(wKey - waterKey < 0)) continue;
      if (vista.agua[celda]! > 0.005 && planAffordable(steps, 0)) { waterLocal = local; waterKey = wKey; }
    }
    const escribir = (local: number, campoX: number, campoY: number, bandera: number): void => {
      if (local < 0) { si[campoX * cap + slot] = 0; si[campoY * cap + slot] = 0; return; }
      const lx = local % LADO_R, ly = (local - lx) / LADO_R;
      si[campoX * cap + slot] = px + lx - R; si[campoY * cap + slot] = py + ly - R; found |= bandera;
    };
    escribir(foodLocal, SI.bestFoodX, SI.bestFoodY, HALLADO_COMIDA);
    escribir(waterLocal, SI.bestWaterX, SI.bestWaterY, HALLADO_AGUA);
    escribir(resourceLocal, SI.bestResourceX, SI.bestResourceY, HALLADO_RECURSO);
    si[SI.stepsFood * cap + slot] = foodLocal < 0 ? -1 : rutaPasos[foodLocal]!;
    si[SI.stepsWater * cap + slot] = waterLocal < 0 ? -1 : rutaPasos[waterLocal]!;
  } else {
    vista.rutas.fill(-1, slot * CELDAS_PERCEPCION, (slot + 1) * CELDAS_PERCEPCION);
    si[SI.bestFoodX * cap + slot] = 0; si[SI.bestFoodY * cap + slot] = 0; si[SI.bestWaterX * cap + slot] = 0;
    si[SI.bestWaterY * cap + slot] = 0; si[SI.bestResourceX * cap + slot] = 0; si[SI.bestResourceY * cap + slot] = 0;
    si[SI.stepsFood * cap + slot] = -1; si[SI.stepsWater * cap + slot] = -1;
  }
  si[SI.found * cap + slot] = found;
  si[SI.routeSteps * cap + slot] = routeSteps;

  // 3. Siguiente paso de `move` hacia el objetivo vigente.
  let nx = px, ny = py;
  if (pi[col(PI.shouldMove)]) {
    pasoMovimiento(vista, px, py, tx, ty, paso);
    nx = paso.x; ny = paso.y; si[SI.moveStatus * cap + slot] = paso.estado;
  } else si[SI.moveStatus * cap + slot] = MOVE_SIN_EVALUAR;
  si[SI.nextX * cap + slot] = nx; si[SI.nextY * cap + slot] = ny;

  // 4. Intento sobre un recurso finito de la celda donde queda tras moverse (Fase C lo confirma).
  let kind = INTENTO_NINGUNO, amount = 0;
  const celda = celdaDe(vista, nx, ny), enDestino = Math.hypot(nx - tx, ny - ty) < 0.5;
  if (celda >= 0) {
    if (accion === ACCION.eat) {
      // `bodyAndAction`: come de la tesela actual (tras el paso), sin exigir estar en el objetivo.
      if (vista.comida[celda]! > 0) { kind = INTENTO_COMER; amount = EAT_AMOUNT; }
    } else if (accion === ACCION.drink && enDestino && cuerpo.thirst > 0) {
      const needed = Math.min(0.006, cuerpo.thirst / SED_POR_UNIDAD);
      if (vista.aguaPotable[celda]! > 0 && needed > 0) { kind = INTENTO_BEBER; amount = needed; }
    } else if ((accion === ACCION.forage || accion === ACCION.gather) && enDestino
      && pf[col(PF.work)]! + 1 >= pf[col(PF.workDuration)]!) {
      // `performWork`: el trabajo se completa en este paso.
      if (accion === ACCION.forage) {
        const capacidad = Math.min(FORAGE_AMOUNT, Math.max(0, 0.25 - pf[col(PF.inventory)]!));
        if (vista.comida[celda]! > 0 && capacidad > 0) { kind = INTENTO_COSECHAR; amount = capacidad; }
      } else {
        const mWood = pf[col(PF.wood)]!, mStone = pf[col(PF.stone)]!;
        const preferida = mWood < 6 ? INTENTO_MADERA : INTENTO_PIEDRA;
        for (const material of preferida === INTENTO_MADERA ? [INTENTO_MADERA, INTENTO_PIEDRA] : [INTENTO_PIEDRA, INTENTO_MADERA]) {
          const stock = material === INTENTO_MADERA ? vista.madera[celda]! : vista.piedra[celda]!;
          const tope = material === INTENTO_MADERA ? 12 : 8, tiene = material === INTENTO_MADERA ? mWood : mStone;
          if (stock < 1 || tiene >= tope) continue;
          kind = material; amount = Math.min(tope - tiene, 1); break;
        }
      }
    }
  }
  si[SI.intentKind * cap + slot] = kind;
  si[SI.intentCellX * cap + slot] = kind === INTENTO_NINGUNO ? 0 : nx;
  si[SI.intentCellY * cap + slot] = kind === INTENTO_NINGUNO ? 0 : ny;
  sf[SF.intentAmount * cap + slot] = amount;
}

/** Ejecuta la Fase B sobre los rangos `[begin, end)` de `ordenSlots` de las regiones dadas. */
export function ejecutarRegionesPersonas(vista: VistaPersonas, regiones: readonly StaticRegion[]): void {
  for (const region of regiones) for (let i = region.begin; i < region.end; i++) faseBPersona(vista, vista.orden[i]!);
}

/** Export del worker para `StaticWorkerPool`. */
export function faseBPersonasWorker(job: StaticWorkerHandlerJob<ParamsFaseBPersonas>): void {
  ejecutarRegionesPersonas(crearVista(job.buffers, job.params), job.regions);
}
