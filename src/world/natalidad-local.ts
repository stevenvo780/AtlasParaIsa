import type { PlaceView } from '../shared/types.js';
import type { Person, World } from './index.js';
import { primeroCerca } from './indice-puntos.js';
import { conRejilla, vecinos } from './rejilla.js';
import { tileLookup } from './tile-index.js';
import { residentTileReader } from './soa/terreno.js';

/**
 * Natalidad por vecindad (decisión D2). El cupo global de 2 nacimientos cada 120 pasos
 * fija 40 nacimientos al día en todo el planeta. Aquí cada vecindad administra ese cupo
 * por su cuenta: una aldea compacta arranca al ritmo ya medido, y las colonias separadas
 * por más de un radio conciben en paralelo hasta que el alimento local o
 * `reproductionEnabled` digan basta.
 *
 * NAT-L (24-09-2026) dividía por el agua superficial y, en tesela seca, obtenía infinito.
 * Esta ley no lee `drinkingWater` ni divide por el agua: el freno es el alimento medio
 * del suelo caminable. Una muestra vacía vale 0, sin singularidad.
 */

/** Radio, en celdas, de una vecindad de aldea. */
export const RADIO_VECINDAD_NATALIDAD_DEFAULT = 16;

/**
 * Por debajo de este alimento medio la vecindad deja de concebir y empuja a migrar.
 * No es una capacidad de carga: es el suelo ya sobreexplotado.
 */
export const ALIMENTO_MEDIO_MINIMO_NATALIDAD = 0.08;

/**
 * Ventana de forrajeo alrededor del nacimiento. Radio de Chebyshev 4 → 81 celdas.
 * Más allá se recorta: la decisión tiene que seguir siendo local.
 */
export const RADIO_MUESTREO_FORRAJEO_DEFAULT = 4;
const RADIO_MUESTREO_MAXIMO = 4;

/** La misma confianza mutua que ya exige `reproduce`. No es un umbral ecológico nuevo. */
const CONFIANZA_MUTUA_MINIMA = 0.3;

export interface LocalBirthConfig {
  radioVecindad: number;
  cupoLocalPorVentana: number;
  ventanaTicks: number;
  alimentoMedioMinimo: number;
  radioPareja: number;
  radioLugar: number;
  exigeComunidad: boolean;
  maximaPoblacion: number;
}

export interface LocalBirthPair {
  a: Person;
  b: Person;
  place: PlaceView;
  affinity: number;
}

interface Centro { x: number; y: number }

const distancia = (a: Centro, b: Centro): number => Math.hypot(a.x - b.x, a.y - b.y);

function radioMuestreoDe(pedido: number): number {
  if (!Number.isFinite(pedido)) return RADIO_MUESTREO_FORRAJEO_DEFAULT;
  return Math.max(0, Math.min(RADIO_MUESTREO_MAXIMO, Math.floor(pedido)));
}

/**
 * Nacimientos de vecinos todavía dentro de la ventana y a ≤ `radioVecindad` del centro.
 * `vecinos` resuelve la consulta en la rejilla del paso; el predicado ya implica la caja
 * de lado `radioVecindad + 1`, así que no hace falta recorrer el censo entero.
 */
export function localRecentBirths(world: World, center: Centro, radioVecindad: number, ventanaTicks: number): number {
  if (!(Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(radioVecindad) && radioVecindad >= 0 && Number.isFinite(ventanaTicks))) return 0;
  const limite = world.tick - ventanaTicks;
  const alcance = radioVecindad + 1;
  return conRejilla(world, () => vecinos(world, center, alcance, (person) => {
    if (person.role !== 'neighbor' || !(person.bornAt > limite)) return false;
    return distancia(person, center) <= radioVecindad;
  }, 'natalidadLocal').length);
}

/**
 * Alimento medio de las teselas de tierra (todo lo que no es agua) en la ventana.
 * Las celdas sin tesela cargada no cuentan como 0: eso fue lo que hizo singular a NAT-L
 * en el terreno dormido. Si no queda tierra, el medio es 0 y no se divide.
 */
export function localForageSupport(world: World, center: Centro, radioMuestreo: number = RADIO_MUESTREO_FORRAJEO_DEFAULT): { meanFood: number; landTiles: number } {
  if (!(Number.isFinite(center.x) && Number.isFinite(center.y))) return { meanFood: 0, landTiles: 0 };
  const radio = radioMuestreoDe(radioMuestreo);
  const origenX = Math.round(center.x), origenY = Math.round(center.y);
  const reader = residentTileReader(world.tiles), tileIn = reader ? undefined : tileLookup(world.tiles);
  let suma = 0, landTiles = 0;
  for (let dy = -radio; dy <= radio; dy++) for (let dx = -radio; dx <= radio; dx++) {
    let food: number | undefined;
    if (reader) {
      const cell = reader.cellAt(origenX + dx, origenY + dy);
      if (cell < 0 || reader.terrainCode(cell) === reader.TERRAIN_WATER) continue;
      food = reader.food(cell);
    } else {
      const tile = tileIn!(origenX + dx, origenY + dy);
      if (!tile || tile.terrain === 'water') continue;
      food = tile.food;
    }
    landTiles++;
    suma += Number.isFinite(food) ? food! : 0;
  }
  return { meanFood: landTiles === 0 ? 0 : suma / landTiles, landTiles };
}

function apto(person: Person, config: LocalBirthConfig, isFertile: (p: Person) => boolean): boolean {
  return isFertile(person) && (!config.exigeComunidad || !!person.communityId);
}

function confianzaMutua(a: Person, b: Person): boolean {
  return (a.bonds[b.id] ?? 0) >= CONFIANZA_MUTUA_MINIMA && (b.bonds[a.id] ?? 0) >= CONFIANZA_MUTUA_MINIMA;
}

/** `maxComunidades = 0` significa «sin tope de conducta»: solo corta la admisión del anfitrión.
 * Con `maxComunidades > 0` manda la ley de fundación (T100: la admisión nunca decide la conducta). */
export function effectiveCommunityCap(maxComunidades: number, admissionLimit: number): number {
  if (maxComunidades === 0) return admissionLimit;
  return maxComunidades;
}

/**
 * Parejas que concebirían en este paso si el cupo fuera local.
 * No escribe el mundo: quien llama decide si materializa los nacimientos.
 * El orden es el de `reproduce` (slot, luego afinidad, luego desempate): repetir
 * la llamada con el mismo censo devuelve las mismas parejas.
 * Los nacimientos elegidos en este paso (`nuevosEnPaso`) consumen el cupo de su
 * vecindad antes de mirar a la pareja siguiente, así dos parejas del mismo disco
 * no rebasan juntas `cupoLocalPorVentana`.
 */
export function selectLocalBirthPairs(
  world: World,
  config: LocalBirthConfig,
  isFertile: (p: Person) => boolean,
  isCloseKin: (a: Person, b: Person) => boolean,
  pairAffinityFn: (a: Person, b: Person, radius: number) => number,
  pairTieFn: (world: World, a: Person, b: Person) => number,
): LocalBirthPair[] {
  if (!world.reproductionEnabled || !(config.cupoLocalPorVentana > 0)) return [];
  if (!(world.people.length < config.maximaPoblacion)) return [];
  return conRejilla(world, () => {
    const usados = new Set<string>();
    const elegidas: LocalBirthPair[] = [];
    const nuevosEnPaso: Centro[] = [];
    const forraje = new Map<string, { meanFood: number; landTiles: number }>();
    const recientes = new Map<string, number>();
    const apoyoDe = (centro: Centro): { meanFood: number; landTiles: number } => {
      const clave = `${Math.round(centro.x)},${Math.round(centro.y)}`;
      let apoyo = forraje.get(clave);
      if (!apoyo) { apoyo = localForageSupport(world, centro); forraje.set(clave, apoyo); }
      return apoyo;
    };
    const cuentaEn = (centro: Centro): number => {
      const clave = `${centro.x},${centro.y}`;
      let base = recientes.get(clave);
      if (base === undefined) {
        base = localRecentBirths(world, centro, config.radioVecindad, config.ventanaTicks);
        recientes.set(clave, base);
      }
      let nuevos = 0;
      for (const nacido of nuevosEnPaso) if (distancia(nacido, centro) <= config.radioVecindad) nuevos++;
      return base + nuevos;
    };
    const cabe = (centro: Centro): boolean => cuentaEn(centro) < config.cupoLocalPorVentana;
    while (world.people.length + elegidas.length < config.maximaPoblacion) {
      let mejor: (LocalBirthPair & { desempate: number }) | undefined;
      for (const a of world.people) {
        if (usados.has(a.id) || !apto(a, config, isFertile)) continue;
        if (!(apoyoDe(a).meanFood >= config.alimentoMedioMinimo)) continue;
        const lugar = primeroCerca(world.places, a, config.radioLugar + 1, (place) => distancia(a, place) <= config.radioLugar);
        if (!lugar) continue;
        // El disco de la aldea comparte un solo cupo aunque sus extremos no se vean entre sí.
        if (!cabe(a)) continue;
        if (distancia(a, lugar) <= config.radioVecindad && (a.x !== lugar.x || a.y !== lugar.y) && !cabe(lugar)) continue;
        const socio = mejorSocio(world, a, config, usados, isFertile, isCloseKin, pairAffinityFn, pairTieFn, apoyoDe);
        if (!socio) continue;
        if (!mejor || socio.afinidad > mejor.affinity || (socio.afinidad === mejor.affinity && socio.desempate > mejor.desempate)) {
          mejor = { a, b: socio.b, place: lugar, affinity: socio.afinidad, desempate: socio.desempate };
        }
      }
      if (!mejor) break;
      usados.add(mejor.a.id);
      usados.add(mejor.b.id);
      elegidas.push({ a: mejor.a, b: mejor.b, place: mejor.place, affinity: mejor.affinity });
      nuevosEnPaso.push({ x: mejor.a.x, y: mejor.a.y });
    }
    return elegidas;
  });
}

function mejorSocio(
  world: World,
  a: Person,
  config: LocalBirthConfig,
  usados: ReadonlySet<string>,
  isFertile: (p: Person) => boolean,
  isCloseKin: (a: Person, b: Person) => boolean,
  pairAffinityFn: (a: Person, b: Person, radius: number) => number,
  pairTieFn: (world: World, a: Person, b: Person) => number,
  apoyoDe: (centro: Centro) => { meanFood: number },
): { b: Person; afinidad: number; desempate: number } | undefined {
  const candidatos = vecinos(world, a, config.radioPareja + 1, (p) => {
    if (p === a || p.id === a.id || usados.has(p.id) || !apto(p, config, isFertile)) return false;
    if (distancia(a, p) > config.radioPareja) return false;
    if (!confianzaMutua(a, p) || isCloseKin(a, p)) return false;
    return apoyoDe(p).meanFood >= config.alimentoMedioMinimo;
  }, 'natalidadLocal');
  let mejor: Person | undefined;
  let afinidad = -Infinity;
  let desempate = -Infinity;
  for (const b of candidatos) {
    const puntaje = pairAffinityFn(a, b, config.radioPareja);
    const empate = pairTieFn(world, a, b);
    if (!Number.isFinite(puntaje) || !Number.isFinite(empate)) continue;
    if (!mejor || puntaje > afinidad || (puntaje === afinidad && (empate > desempate || (empate === desempate && b.id < mejor.id)))) {
      mejor = b;
      afinidad = puntaje;
      desempate = empate;
    }
  }
  return mejor ? { b: mejor, afinidad, desempate } : undefined;
}
