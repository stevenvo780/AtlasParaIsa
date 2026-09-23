/**
 * Halo de las particiones del motor (T111, etapa B de 002-mundo-ilimitado).
 *
 * Una región sólo puede calcular por su cuenta lo que lee dentro de su recinto más `HALO_CELDAS` celdas
 * por eje. Este fichero es el INVENTARIO de lo que el paso lee del mundo alrededor de un punto, con su
 * ALCANCE EFECTIVO COMPUESTO: el radio directo más el de los sub-escaneos que la función hace alrededor
 * de lo que encontró (refutación G2: `settlementOpportunity` lee personas a ≤ 6 del hogar, que está a
 * ≤ 7 de quien decide). El motor no lo lee: es una constante y su prueba (`tests/halo-radios.test.ts`),
 * que cruza cada entrada con el código por `patrones` (fragmentos literales de la línea, dentro de
 * `funcion`) y falla si una lectura queda fuera del inventario o si un alcance compuesto de una fase
 * con halo lo supera.
 *
 * Métrica: el halo cuenta celdas por eje. Las personas miden con `Math.hypot` y la fauna con Manhattan;
 * en ambas `d ≤ r` implica |Δx|, |Δy| ≤ r, y por la desigualdad triangular dos saltos ≤ r1 y ≤ r2 quedan
 * a ≤ r1 + r2 por eje. Un umbral estricto (`< 5`) cuenta como su radio: cota conservadora.
 */
import type { WorldParams } from './params.js';

/** 14, no 13: `evaluateCooperation` (dentro de `choose`) mira a quien está a ≤ 7 y, desde esa persona,
 * la tesela de su destino (≤ 7 de ella: `practicedSkillToTeach`, `itemNeed`) y las teselas a ≤ 7 que
 * suman los insumos de una receta (`localRecipeInputs`): 7 + 7. El 13 de G2 (hogar 7 + personas 6)
 * queda como máximo de las lecturas de personas. */
export const HALO_CELDAS = 14;

export type Coleccion = 'personas' | 'teselas' | 'estructuras' | 'lugares' | 'animales' | 'punto';
export type Fase = 'activacion' | 'gestos' | 'ecologia' | 'fauna' | 'faunaSerial' | 'estructuras' | 'decision'
  | 'accion' | 'encuentros' | 'demografia' | 'comunidades' | 'reproduccion' | 'checkpoint' | 'muestreo';
/** Fases que el plan reparte por regiones: la decisión de cada persona (`choose`, la fase B de solo
 * lectura), la ecología (T115/T120) y la decisión de la fauna (T116; su movimiento, alimentación y
 * cría son una cadena secuencial y siguen en `faunaSerial`). Las demás se quedan en la fase serial del
 * coordinador —escriben en orden de `world.people`, consumen `world.rng` o cuentan en acumuladores
 * globales—: su alcance se inventaría y la prueba lo fija, pero el halo no lo acota. */
export const FASES_CON_HALO: readonly Fase[] = ['decision', 'ecologia', 'fauna'];

export type ClaveDeRadio = 'poblacion.radioPareja' | 'poblacion.radioLugar' | 'poblacion.radioCortejo' | 'social.disputaRadio';
/** Radio que dicta una ley parametrizada; `activa` es la clave que la apaga cuando vale 0. */
export interface RadioParametrizado { readonly param: ClaveDeRadio; readonly activa?: 'poblacion.cortejo' }
export type Radio = number | RadioParametrizado;

/** Dónde vive una lectura: fichero de `src/world`, función de primer nivel que la contiene y fragmentos
 * literales de sus líneas. */
export interface Sitio { readonly fichero: string; readonly funcion: string; readonly patrones: readonly string[] }
export interface Alcance extends Sitio {
  readonly id: string;
  readonly fase: Fase;
  readonly coleccion: Coleccion;
  /** `actor` (quien decide o actúa: persona, animal, estructura o gesto) o el `id` de la entrada que
   * produjo el punto alrededor del cual se lee: así se compone el alcance. */
  readonly centro: string;
  readonly radio: Radio;
  /** Única salida admitida del halo en una fase con halo: la máscara de presencia no cambia durante
   * el paso (sólo `maintainRegions` activa y retira) y se replica entera de solo lectura. */
  readonly excepcion?: 'presencia';
  readonly nota?: string;
}
export interface LecturaGlobal extends Sitio { readonly id: string; readonly fase: Fase; readonly fuente: string; readonly cota: number | string; readonly motivo: string }
export interface LecturaPorIdentidad extends Sitio { readonly id: string; readonly fase: Fase; readonly fuente: string; readonly motivo: string }
export interface Recorrido extends Sitio { readonly id: string; readonly fase: Fase; readonly motivo: string }
export interface Escritura extends Sitio { readonly id: string; readonly fase: Fase; readonly radio: number; readonly motivo: string }
export interface FueraDelPaso { readonly fichero: string; readonly funcion: string; readonly motivo: string }

const a = (id: string, fase: Fase, coleccion: Coleccion, centro: string, radio: Radio, fichero: string, funcion: string,
  patrones: readonly string[], extra: Pick<Alcance, 'excepcion' | 'nota'> = {}): Alcance =>
  ({ id, fase, coleccion, centro, radio, fichero, funcion, patrones, ...extra });

/** Lecturas alrededor de un punto. `centro` compone; el alcance de cada entrada es su radio más el de
 * su centro. Una función auxiliar llamada desde varios sitios se inventaría en su peor llamada. */
export const ALCANCES: readonly Alcance[] = [
  // Decisión de cada persona (`choose` y lo que llama).
  a('decision.teselas', 'decision', 'teselas', 'actor', 7, 'index.ts', 'choose', ['tileAt(world, { x: person.x + dx, y: person.y + dy })']),
  a('decision.personas', 'decision', 'personas', 'actor', 7, 'index.ts', 'choose', ['world.people.filter(other => other.id !== person.id && distance(person, other) <= RADIUS)']),
  a('decision.lugarFamilia', 'decision', 'lugares', 'actor', 7, 'index.ts', 'choose', ['filtrarCerca(world.places, person, RADIUS + 1, place => distance(person,place)<=RADIUS']),
  a('decision.caza', 'decision', 'animales', 'decision.teselas', 0, 'index.ts', 'choose', ['world.animals.filter(a => a.x === tile.x && a.y === tile.y && a.health > 0)']),
  a('decision.obra', 'decision', 'lugares', 'decision.teselas', 5, 'index.ts', 'choose', ['!algunoCerca(world.places, t, 6, p => distance(p, t) < 5)'],
    { nota: 'Antes de PERF2 recorría todo `world.places`; hoy usa el índice por casillas, pero la regla sigue siendo «ningún lugar a < 5 de una tesela a ≤ 7»: 12.' }),
  a('decision.lugarCompartir', 'decision', 'lugares', 'actor', 3, 'index.ts', 'choose', ['primeroCerca(world.places, person, 4, p => distance(person, p) <= 3)']),
  a('decision.destinoForrajeo', 'decision', 'teselas', 'actor', 0, 'index.ts', 'choose', ['(tileAt(world,person.target)?.food??0)>=MIN_FORAGE_STOCK'],
    { nota: 'Sólo con `person.work > 0`: el trabajo se acumula en el destino (distancia < 0,5) y se pone a 0 al cambiarlo, y nadie se mueve si ya está en él.' }),
  a('decision.sedPorPaso', 'decision', 'teselas', 'actor', 0, 'index.ts', 'choose', ['const sedPorPaso = bodilyNeedRates(world, tileAt(world, person)!']),
  a('decision.recuperarAgua', 'decision', 'teselas', 'actor', 0, 'index.ts', 'canRecoverWaterHandling', ['bodilyNeedRates(world, tileAt(world, person)!']),
  a('decision.comidaInmediata', 'decision', 'teselas', 'decision.teselas', 0, 'index.ts', 'immediateMeal', ['Math.min(tileAt(world, person)?.food ?? 0, 0.0035)'],
    { nota: '`choose` la llama sobre sí y sobre destinos de comida con ruta percibida (≤ 7).' }),
  a('decision.techo', 'decision', 'estructuras', 'decision.teselas', 0, 'index.ts', 'bodilyShelter',
    ["tileAt(world, point)?.terrain === 'shelter' ? Math.max(0, ...world.structures", '.filter(s => s.x === point.x && s.y === point.y'],
    { nota: '`choose` sólo pregunta por teselas y destinos con ruta percibida (`stepsTo` definido: ≤ 7).' }),
  a('decision.companeros', 'decision', 'personas', 'actor', 7, 'index.ts', 'explorationTarget', ['world.people.filter(p => p.id !== person.id && distance(person, p) <= 7']),
  a('decision.cortejo', 'decision', 'personas', 'actor', { param: 'poblacion.radioCortejo', activa: 'poblacion.cortejo' }, 'index.ts', 'choose', ['away > leyPoblacion.radioCortejo'],
    { nota: 'Reglas 10: 128 celdas. La lectura por id de cada vínculo no tiene cota (ver `vinculos.cortejo`); el radio acota a quién se decide buscar.' }),
  a('familia.pareja', 'decision', 'personas', 'actor', 7, 'family.ts', 'familyOpportunity', ['const partner = world.people.filter(', 'distance(person, other) <= 7']),
  a('familia.lugar', 'decision', 'lugares', 'actor', 7, 'family.ts', 'familyOpportunity', ['algunoCerca(world.places, person, 8, place => distance(person, place) <= 7']),
  a('asentamiento.hogar', 'decision', 'punto', 'actor', 7, 'society.ts', 'settlementOpportunity', ['person.home && distance(person,person.home)<=7']),
  a('asentamiento.lugares', 'decision', 'lugares', 'actor', 6, 'society.ts', 'settlementOpportunity', ['filtrarCerca(world.places, person, 7, p=>distance(person,p)<=6)']),
  ...(['asentamiento.hogar', 'asentamiento.lugares'] as const).flatMap(centro => [
    a(`${centro}.teselas`, 'decision', 'teselas', centro, 4, 'society.ts', 'settlementOpportunity', ['const tile = tileAt(world,{x:place.x+dx,y:place.y+dy});', 'if (dx*dx+dy*dy>16) continue;']),
    a(`${centro}.estructuras`, 'decision', 'estructuras', centro, 4, 'society.ts', 'settlementOpportunity', ['filtrarCerca(world.structures, place, 5, s=>distance(s,place)<=4']),
    a(`${centro}.personas`, 'decision', 'personas', centro, 6, 'society.ts', 'settlementOpportunity', ['world.people.filter(p=>p!==person && distance(p,place)<=6)']),
  ]),
  a('cooperacion.otro', 'decision', 'personas', 'actor', 7, 'society.ts', 'evaluateCooperation', ['for (const other of world.people) {', 'distance(person, other) > 7']),
  a('cooperacion.destinoDelOtro', 'decision', 'teselas', 'cooperacion.otro', 7, 'society.ts', 'practicedSkillToTeach', ['distance(learner, learner.target) > 7', 'const tile = tileAt(world, learner.target);'],
    { nota: 'También en `cooperate` (acción) con el otro a ≤ 1,5.' }),
  a('cooperacion.insumos', 'decision', 'teselas', 'cooperacion.otro', 7, 'society.ts', 'localRecipeInputs', ['if (dx * dx + dy * dy > 49) continue;', 'const tile = tileAt(world, { x: learner.x + dx, y: learner.y + dy });']),
  a('cooperacion.necesidad', 'decision', 'teselas', 'cooperacion.otro', 7, 'society.ts', 'itemNeed', ['if (distance(person, person.target) <= 7) {', 'const tile = tileAt(world, person.target);'],
    { nota: '`productExchange` la llama con el comprador (el otro); con el vendedor (quien decide) queda en 7.' }),
  a('obra.servicios', 'decision', 'estructuras', 'actor', 7, 'inventions.ts', 'localServices', ['for (const structure of world.structures) {', 'if (distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)']),
  a('obra.personas', 'decision', 'personas', 'actor', 7, 'inventions.ts', 'constructionContext', ['world.people.filter(other => distance(person, other) <= CONSTRUCTION_RADIUS)']),
  a('obra.materiales', 'decision', 'teselas', 'actor', 7, 'inventions.ts', 'localMaterials', ['const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });']),
  a('obra.reparaciones', 'decision', 'estructuras', 'actor', 7, 'inventions.ts', 'usefulRepairs', ['distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)']),
  a('invento.teselas', 'decision', 'teselas', 'actor', 4, 'inventions.ts', 'inventionContext', ['const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });'],
    { nota: 'También cada 60 pasos en `stepStructures`, alrededor de cada persona.' }),
  a('invento.personas', 'decision', 'personas', 'actor', 4, 'inventions.ts', 'inventionContext', ['world.people.filter(p => distance(person, p) <= 4)']),
  a('invento.techos', 'decision', 'estructuras', 'actor', 4, 'inventions.ts', 'inventionContext', ['filtrarCerca(world.structures, person, 5, s => distance(person, s) <= 4', "tileAt(world, s)?.terrain === 'shelter'"]),
  a('invento.planosEstructuras', 'decision', 'estructuras', 'actor', 5, 'inventions.ts', 'knownBlueprints', ['for (const structure of world.structures) if (distance(person, structure) <= 5', "tileAt(world, structure)?.terrain === 'shelter') ids.add"]),
  a('invento.planosPersonas', 'decision', 'personas', 'actor', 3, 'inventions.ts', 'knownBlueprints', ['if (world.cooperationEnabled) for (const other of world.people) {', 'distance(person, other) <= 3']),
  a('estructuras.funcionales', 'decision', 'estructuras', 'decision.teselas', 1.5, 'inventions.ts', 'functionalNear', ['filtrarCerca(world.structures, point, radius + 1', "tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius"],
    { nota: 'Peor llamada: `waterAvailable` sobre teselas percibidas (≤ 7) con radio 0,5; `foodAvailable` usa 1,5 sobre quien decide.' }),
  a('agua.disponible', 'decision', 'teselas', 'decision.teselas', 0, 'inventions.ts', 'waterAvailable', ['return (tileAt(world, point)?.drinkingWater ?? 0) + functionalNear(world, point, 0.5)'],
    { nota: 'En `bodyAndAction` y `resourceDispute` se llama con el destino propio: ver `accion.destino`.' }),
  ...(['planWithdrawal', 'localInputs', 'localTechnologyUses', 'dependencyCraft'] as const).map(funcion =>
    a(`tecnologia.${funcion}`, 'decision', 'teselas', 'actor', 0, 'technology.ts', funcion, ['firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y))'])),
  // Decisión de la fauna (T116 la reparte; `localTiles` y `choose` de animals.ts).
  a('fauna.percepcion', 'fauna', 'teselas', 'actor', 6, 'animals.ts', 'localTiles', ['const radius = 2 + Math.floor(animal.genes.perception * 4)'], { nota: 'Rombo Manhattan.' }),
  a('fauna.vecinos', 'fauna', 'animales', 'fauna.percepcion', 0, 'animals.ts', 'choose', ['visible.flatMap(t => state.occupants.get(cell(t)) ?? [])'],
    { nota: 'Las amenazas son un subconjunto: `1 + ⌊p·5⌋ ≤ 6`.' }),
  a('fauna.memoria', 'fauna', 'teselas', 'actor', 126, 'animals.ts', 'choose', ['state.tile(m.x, m.y) !== undefined'],
    { excepcion: 'presencia', nota: 'Sólo pregunta si la celda recordada sigue activa: recuerdos de ≤ 480 pasos (`MEMORY_TTL`), un paso de celda cada ≥ 4 pasos y celdas vistas a ≤ 6: 6 + 480/4.' }),
  a('fauna.mover', 'faunaSerial', 'teselas', 'actor', 1, 'animals.ts', 'move', ['.map(([dx, dy]) => state.tile(animal.x + dx!, animal.y + dy!))']),
  a('fauna.cria', 'faunaSerial', 'animales', 'actor', 1, 'animals.ts', 'reproduce', ['state.occupants.get(cellXY(a.x + dx!, a.y + dy!))']),
  // Ecología: vecindad de una celda (T115/T120).
  a('ecologia.vecinos', 'ecologia', 'teselas', 'actor', 1, 'index.ts', 'ecology', ['waterAt(tile.x - 1, tile.y) || waterAt(tile.x + 1, tile.y)']),
  a('kernel.vecinos', 'ecologia', 'teselas', 'actor', 1, 'ecosystem-kernel.ts', 'buildTopology', ['for (let dx = -1; dx <= 1; dx++) {']),
  // Acción de cada persona: cadena secuencial en orden de `world.people` (fase serial).
  a('accion.bfs', 'accion', 'teselas', 'actor', 24, 'index.ts', 'move', ['Math.abs(next.y - start.y)) > 24 || !walkable(world, next)'],
    { nota: 'Búsqueda en anchura acotada a 24 celdas por eje (y 2 048 nodos): lee terreno y presencia.' }),
  a('accion.caminable', 'accion', 'teselas', 'accion.bfs', 0, 'index.ts', 'walkable', ['const tile = tileAt(world, p);']),
  a('accion.pisada', 'accion', 'teselas', 'actor', 0, 'index.ts', 'move', ['trampleTile(tileAt(world, person)!)']),
  a('accion.aqui', 'accion', 'teselas', 'actor', 0, 'index.ts', 'bodyAndAction', ['const tile = tileAt(world, person)!;', 'const current = tileAt(world, person)!;']),
  a('accion.destino', 'accion', 'teselas', 'actor', 4096, 'index.ts', 'bodyAndAction',
    ["person.action === 'eat' && (tileAt(world, person.target)?.food", "person.action === 'forage' && (tileAt(world, person.target)?.food", 'waterAvailable(world,person.target) < 0.003'],
    { nota: 'Destinos propios: ≤ 7 si los eligió `choose`, pero una orden (`forage`, `drink`, `hunt`) fuera de la vista deja el destino en el punto del gesto, a ≤ 4 096 celdas.' }),
  a('accion.compartirLugar', 'accion', 'lugares', 'actor', 3, 'index.ts', 'share', ['primeroCerca(world.places, donor, 4, p => distance(donor, p) <= 3)']),
  a('accion.compartirReceptor', 'accion', 'personas', 'actor', 2, 'index.ts', 'share', ['world.people.filter(p => p.id !== donor.id && p.hunger > 0.27 && distance(p, donor) <= 2)']),
  a('accion.observadores', 'accion', 'personas', 'actor', 3, 'index.ts', 'share', ['for (const observer of world.people) {', 'distance(observer, donor) > 3']),
  a('accion.reparar', 'accion', 'estructuras', 'actor', 0, 'index.ts', 'performWork', ['primeroCerca(world.structures, tile, 1, s=>s.x===tile.x&&s.y===tile.y)']),
  a('accion.obraLugares', 'accion', 'lugares', 'actor', 5, 'inventions.ts', 'completeConstruction', ['tileAt(world, tile) !== tile', 'algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5)']),
  a('accion.obraEstructuras', 'accion', 'estructuras', 'actor', 0, 'inventions.ts', 'completeConstruction', ['algunoCerca(world.structures, tile, 1, s => s.x === tile.x && s.y === tile.y)']),
  a('accion.beber', 'accion', 'teselas', 'actor', 0, 'inventions.ts', 'takeWater', ['const tile = tileAt(world, person); if (!tile) return 0;']),
  a('accion.disputaFuente', 'accion', 'teselas', 'actor', 4096, 'society.ts', 'resourceDispute', ['const source = tileAt(world, person.target);'], { nota: 'Destino propio; ver `accion.destino`.' }),
  a('accion.disputa', 'accion', 'personas', 'actor', { param: 'social.disputaRadio' }, 'society.ts', 'resourceDispute', ['world.people.find(p => p !== person && p.communityId && p.action === person.action && distance(person, p) <= disputaRadio']),
  a('accion.cazar', 'accion', 'animales', 'actor', 0, 'animals.ts', 'harvestAt', ['world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0)', '!world.tiles.some(t => t.x === point.x && t.y === point.y)']),
  ...(['fillContainedWater', 'beginWaterPreparation'] as const).map(funcion =>
    a(`accion.${funcion}`, 'accion', 'teselas', 'actor', 0, 'technology-water.ts', funcion, ['firstTileAt(host.tiles, actor.x, actor.y)'])),
  a('accion.entregaObjeto', 'accion', 'personas', 'actor', 2, 'technology.ts', 'transferTechnologyItem', ['distance(from, to) > 2']),
  // Gestos: el actor es el punto del gesto.
  a('gesto.testigos', 'gestos', 'personas', 'actor', 7, 'index.ts', 'applyGesture', ['!world.people.some(p => distance(p, gesture) <= RADIUS)', 'for (const person of world.people) if (distance(person, gesture) <= RADIUS)']),
  a('gesto.tesela', 'gestos', 'teselas', 'actor', 0, 'index.ts', 'applyGesture', ['const tile = tileAt(world, gesture)!;']),
  // Estructuras (cada 10 pasos): el actor es la estructura.
  a('estructuras.tesela', 'estructuras', 'teselas', 'actor', 0, 'inventions.ts', 'stepStructures', ['const tile = tileAt(world, structure); if (!tile']),
  a('estructuras.riego', 'estructuras', 'teselas', 'actor', 1, 'inventions.ts', 'stepStructures', ['tileAt(world, { x: structure.x + dx!, y: structure.y + dy! })']),
  a('estructuras.deposito', 'estructuras', 'personas', 'actor', 1.5, 'inventions.ts', 'stepStructures', ['if (a.foodCapacity > 0) for (const person of world.people) {', 'distance(person, structure) > 1.5']),
  // Encuentros, demografía, comunidades y reproducción.
  a('encuentro.lugar', 'encuentros', 'lugares', 'actor', 3, 'index.ts', 'encounters', ['primeroCerca(world.places, s, 4, p => distance(s, p) <= 3)']),
  a('convivencia', 'encuentros', 'personas', 'actor', 2, 'society.ts', 'convivir', ['distance(a, b) > RADIO_CONVIVENCIA']),
  a('herencia', 'demografia', 'personas', 'actor', 2, 'index.ts', 'transferEstate', ['world.people.filter(other=>other!==person&&other.demography.deathCause===null&&distance(person,other)<=2)']),
  a('herencia.tecnologica', 'demografia', 'personas', 'actor', 2, 'technology.ts', 'settleTechnologyEstate', ['host.people.includes(p) && distance(actor, p) <= 2']),
  a('muerte.tesela', 'demografia', 'teselas', 'actor', 0, 'lineage.ts', 'advancePopulation', ['const tile = tileAt(world, person);']),
  a('comunidad.alternativas', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'updateCommunities', ['world.people.filter(p => p !== person && p.communityId !== group.id && distance(person, p) <= 6']),
  a('comunidad.vecinos', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'updateCommunities', ['world.people.filter(p => p !== person && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.25']),
  a('comunidad.fundacion', 'comunidades', 'lugares', 'actor', 7, 'society.ts', 'updateCommunities', ['algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)']),
  a('convivencia.vecinos', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'reviseByCohabitation', ['world.people.filter(p => trustedNeighbor(person, p))'],
    { nota: '`trustedNeighbor`: ≤ 6 celdas.' }),
  a('convivencia.fision', 'comunidades', 'lugares', 'actor', 7, 'society.ts', 'reviseByCohabitation', ['algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)']),
  a('reproduccion.lugar', 'reproduccion', 'lugares', 'actor', { param: 'poblacion.radioLugar' }, 'index.ts', 'reproduce', ['primeroCerca(world.places, a, pop.radioLugar + 1, p => distance(a, p) <= pop.radioLugar)']),
  a('reproduccion.pareja', 'reproduccion', 'personas', 'actor', { param: 'poblacion.radioPareja' }, 'index.ts', 'reproduce', ['world.people.filter(p => match(a, p))', 'distance(a, b) <= pop.radioPareja'],
    { nota: 'Pareja (≤ radioPareja) y lugar (≤ radioLugar) se miden los dos desde `a`: no se componen.' }),
];

/** Lecturas que no dependen de dónde está nadie: colecciones acotadas que cada región recibe enteras y
 * de solo lectura, y agregados que el coordinador calcula una vez. */
export const LECTURAS_GLOBALES: readonly LecturaGlobal[] = [
  { id: 'lugares.porId', fase: 'decision', fuente: 'world.places', cota: 2048, fichero: 'index.ts', funcion: 'choose',
    patrones: ['world.places.find(p => p.id === habit.placeId)', 'world.places.find(p => p.id === memory.placeId)'],
    motivo: 'Lugares de hábitos y recuerdos por id, dondequiera que estén. `world.places` (≤ 2 048, `assertCommon`) se replica íntegro: ninguna lectura de lugares necesita el halo.' },
  { id: 'lugares.gesto', fase: 'gestos', fuente: 'world.places', cota: 2048, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ['world.places.find(p => p.id === memory?.placeId)'], motivo: 'Lugar del recuerdo pedido; luego exige que esté a ≤ 4 del gesto.' },
  { id: 'lugares.activacion', fase: 'activacion', fuente: 'world.places', cota: 2048, fichero: 'spatial.ts', funcion: 'activate',
    patrones: ['if (!world.places.some(p => p.id === place.id)) world.places.push(place);'], motivo: 'Evita duplicar un lugar al reanimar su chunk.' },
  { id: 'invitaciones', fase: 'decision', fuente: 'world.invitations', cota: 8, fichero: 'index.ts', funcion: 'choose',
    patrones: ['for (const invitation of world.invitations) {'], motivo: 'Todas las invitaciones vigentes; luego exige ≤ 7 celdas.' },
  { id: 'recordatorios', fase: 'decision', fuente: 'world.reminders', cota: 8, fichero: 'index.ts', funcion: 'choose',
    patrones: ['world.reminders.some(reminder => reminder.memoryId === memory.id)'], motivo: 'Recordatorio activo de un recuerdo.' },
  { id: 'recordatorios.gesto', fase: 'gestos', fuente: 'world.reminders', cota: 8, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ['world.reminders = world.reminders.filter(r => r.memoryId !== memory.id);'], motivo: 'Reemplaza el recordatorio del mismo recuerdo.' },
  { id: 'recuerdos', fase: 'decision', fuente: 'world.memories', cota: 10, fichero: 'index.ts', funcion: 'choose',
    patrones: ['for (const memory of world.memories) {'], motivo: 'Recuerdos de S e I; el lugar se busca por id y se exige ≤ 4.' },
  { id: 'planos', fase: 'decision', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'selectedBlueprint',
    patrones: ['world.blueprints.find(b => b.id === person.blueprintId'], motivo: 'Coste de obra de cualquiera (también del otro en `evaluateCooperation`).' },
  ...([['constructionOpportunity', 'decision', 'if (world.structures.length >= MAX_STRUCTURES) return;'],
    ['completeConstruction', 'accion', 'world.structures.length >= MAX_STRUCTURES']] as const).map(([funcion, fase, patron]) => ({
    id: `estructuras.tope.${funcion}`, fase, fuente: 'world.structures.length', cota: 'MAX_STRUCTURES = 512', fichero: 'inventions.ts', funcion,
    patrones: [patron], motivo: 'Cuántas estructuras activas hay en todo el mundo: un recuento global.' })),
  { id: 'planos.tope', fase: 'decision', fuente: 'world.blueprints.length', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'inventionOpportunity',
    patrones: ['world.blueprints.length >= MAX_BLUEPRINTS'], motivo: 'Tope global de planos.' },
  { id: 'recetas.rareza', fase: 'decision', fuente: 'world.people', cota: 'O(P)', fichero: 'society.ts', funcion: 'recipeHolders',
    patrones: ['for (const person of world.people) for (const id of person.technology.knownRecipes) {'],
    motivo: 'Sólo con `social.ensenanzaRareza` > 0 (default 0): cuenta quién recuerda cada receta en toda la población. Agregado entero: lo calcularía el coordinador.' },
  { id: 'nacimientosRecientes', fase: 'reproduccion', fuente: 'world.people', cota: 'O(P)', fichero: 'index.ts', funcion: 'reproduce',
    patrones: ["world.people.filter(p => p.role === 'neighbor' && p.bornAt > world.tick - pop.intervaloComprobacionTicks).length"],
    motivo: 'Cupo de nacimientos de la ventana (`poblacion.comprobacionContinua`).' },
  { id: 'muestreo', fase: 'muestreo', fuente: 'world.people', cota: 'O(P)', fichero: 'statistics.ts', funcion: 'sample',
    patrones: ['world.people.reduce((sum, p) => sum + p[key], 0) / n'], motivo: 'Medias de la población cada 60 pasos: suma FP64 en orden de `world.people`, fase serial (regla 13).' },
  { id: 'capacidadFauna', fase: 'faunaSerial', fuente: 'world.tiles', cota: 'O(teselas activas)', fichero: 'animals.ts', funcion: 'reproduce',
    patrones: ["capacity ??= world.tiles.filter(t => t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04).length * 3;"],
    motivo: 'Capacidad natural de cría: recuento entero sobre TODAS las teselas activas.' },
];

/** Lecturas por id, rol o pertenencia: no tienen cota espacial. Con personas repartidas por región
 * exigen una tabla de personas replicada de solo lectura (o quedarse en la fase serial). */
export const LECTURAS_POR_IDENTIDAD: readonly LecturaPorIdentidad[] = [
  { id: 'vinculos.cortejo', fase: 'decision', fuente: 'world.people', fichero: 'index.ts', funcion: 'choose',
    patrones: ['for (const [id, strength] of Object.entries(person.bonds))', 'const other = personById(world, id);'],
    motivo: 'Con `poblacion.cortejo` > 0 (reglas 10) lee rol, vínculos y padres de cada persona vinculada, a cualquier distancia, antes de filtrar por `radioCortejo`.' },
  { id: 'indicePorId', fase: 'decision', fuente: 'world.people', fichero: 'index.ts', funcion: 'personById',
    patrones: ['function personById(', 'for (const person of world.people) if (!byId.has(person.id))'], motivo: 'Índice id → persona de toda la población.' },
  { id: 'gesto.agente', fase: 'gestos', fuente: 'world.people', fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ['world.people.find(p => p.id === gesture.agentId)'], motivo: 'Destinatario de una orden.' },
  { id: 'encuentro.SeI', fase: 'encuentros', fuente: 'world.people', fichero: 'index.ts', funcion: 'encounters',
    patrones: ["world.people.find(p => p.role === 'S')", "world.people.find(p => p.role === 'I')"], motivo: 'S e I por rol; el encuentro exige ≤ 1,5 celdas.' },
  { id: 'nacimiento.identidad', fase: 'reproduccion', fuente: 'world.people + legado', fichero: 'index.ts', funcion: 'reproduce',
    patrones: ['[...world.people,...world.legacy,...world.retiredLegacy].some(p=>p.id===id)'], motivo: 'Unicidad de la identidad nueva.' },
  { id: 'nacimiento.comunidad', fase: 'reproduccion', fuente: 'world.communities', fichero: 'index.ts', funcion: 'reproduce',
    patrones: ['world.communities.find(c => c.id === a.communityId)'], motivo: 'Comunidad del progenitor.' },
  { id: 'cooperacion.comunidad', fase: 'accion', fuente: 'world.communities', fichero: 'society.ts', funcion: 'cooperate',
    patrones: ['world.communities.find(c => c.id === person.communityId); if (group) group.cooperation++;'], motivo: 'Contador de la comunidad.' },
  { id: 'disputa.comunidad', fase: 'accion', fuente: 'world.communities', fichero: 'society.ts', funcion: 'resourceDispute',
    patrones: ['world.communities.find(c => c.id === p.communityId); if (group) group.disputes++;'], motivo: 'Contador de la comunidad.' },
  { id: 'comunidad.pertenencia', fase: 'comunidades', fuente: 'world.people + world.communities', fichero: 'society.ts', funcion: 'updateCommunities',
    patrones: ['world.communities.find(c => c.id === person.communityId);', 'world.people.filter(p => p !== person && p.communityId === group.id)',
      'const members = world.people.filter(p => p.communityId === group.id);', 'world.communities.find(c => c.id === joined)'],
    motivo: 'Confianza media con TODOS los miembros de la comunidad, dondequiera que estén.' },
  { id: 'convivencia.miembros', fase: 'comunidades', fuente: 'world.people + world.communities', fichero: 'society.ts', funcion: 'reviseByCohabitation',
    patrones: ['const members = world.people.filter(p => p.communityId === group.id);', 'world.communities.find(c => c.id === person.communityId), to = world.communities.find(c => c.id === best.id)'],
    motivo: 'Centroide de todos los miembros; `social.radioConvivencia` se compara con él, no acota ninguna lectura.' },
  { id: 'comida.observada', fase: 'accion', fuente: 'world.people', fichero: 'inventions.ts', funcion: 'takeFood',
    patrones: ["world.people.some(p => p === person && p.action === 'eat' && p.hunger > 0)"], motivo: 'Pertenencia de quien come.' },
  ...(['takeWater', 'recordFacilityRest'] as const).map(funcion => ({ id: `pertenencia.${funcion}`, fase: 'accion' as const, fuente: 'world.people',
    fichero: 'inventions.ts', funcion, patrones: ['!world.people.includes(person)'], motivo: 'Pertenencia de quien actúa.' })),
  { id: 'pertenencia.estructura', fase: 'accion', fuente: 'world.structures', fichero: 'inventions.ts', funcion: 'repair',
    patrones: ['!world.structures.includes(structure)'], motivo: 'La estructura sigue activa.' },
  ...(['canHandle', 'payContainedWaterCarry', 'beginWaterPreparation'] as const).map(funcion => ({ id: `pertenencia.${funcion}`, fase: 'accion' as const,
    fuente: 'host.people', fichero: 'technology-water.ts', funcion, patrones: ['host.people.includes(actor)'], motivo: 'Pertenencia de quien actúa.' })),
  { id: 'pertenencia.transferTechnologyItem', fase: 'accion', fuente: 'host.people', fichero: 'technology.ts', funcion: 'transferTechnologyItem',
    patrones: ['!host.people.includes(from) || !host.people.includes(to)'], motivo: 'Pertenencia de las dos partes.' },
  { id: 'fauna.presa', fase: 'faunaSerial', fuente: 'world.animals', fichero: 'animals.ts', funcion: 'stepAnimals',
    patrones: ['const prey = byId.get(animal.preyId);'], motivo: 'Presa elegida (a ≤ 6) leída por id dondequiera que esté; sólo se la hiere a distancia 0.' },
  { id: 'muerte.identidad', fase: 'demografia', fuente: 'world.people', fichero: 'lineage.ts', funcion: 'advancePopulation',
    patrones: ['world.people.some(person => archived.has(person.id))'], motivo: 'Ninguna identidad archivada reaparece.' },
  { id: 'linaje.referencias', fase: 'demografia', fuente: 'world.people', fichero: 'lineage.ts', funcion: 'referencedLegacy',
    patrones: ['for (const person of world.people) for (const parent of person.genome.parents)', 'for (const person of world.people) required.delete(person.id);'],
    motivo: 'Legado que alguien vivo cita como progenitor (`retainLegacy`).' },
];

/** Recorridos de fase y compactaciones: el bucle que decide QUIÉN actúa, no una lectura alrededor de
 * nadie. Su orden es parte de la regla (orden de `world.people`, orden canónico de la fauna). */
export const RECORRIDOS: readonly Recorrido[] = [
  { id: 'paso.acciones', fase: 'accion', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) bodyAndAction(world, person);'],
    motivo: 'Cadena secuencial: cada persona decide y actúa viendo lo que las anteriores ya hicieron en este paso.' },
  { id: 'paso.descubrimiento', fase: 'accion', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) {'], motivo: 'Chunk bajo cada persona.' },
  { id: 'paso.caducidad', fase: 'gestos', fichero: 'index.ts', funcion: 'advanceTick',
    patrones: ['world.invitations = world.invitations.filter(', 'world.reminders = world.reminders.filter('], motivo: 'Listas globales acotadas a 8.' },
  { id: 'paso.checkpoint', fase: 'checkpoint', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) maintainTechnologyMemory(world, person);'], motivo: 'Memoria tecnológica.' },
  { id: 'ecologia', fase: 'ecologia', fichero: 'index.ts', funcion: 'ecology', patrones: ['for (const tile of world.tiles) {', 'tileLookup(world.tiles)'], motivo: 'Autómata por tesela (T120).' },
  { id: 'fauna', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'stepAnimals',
    patrones: ['for (const animal of world.animals) {', 'world.animals = world.animals.filter(a => a.health > 0);', 'tileLookup(world.tiles)'], motivo: 'Ocupación y compactación de la fauna.' },
  { id: 'fauna.caza', fase: 'accion', fichero: 'animals.ts', funcion: 'harvestAt', patrones: ['world.animals = world.animals.filter(a => a.id !== victim.id);', 'syncFauna(world.tiles, world.animals)'],
    motivo: 'Tras cada caza humana, `syncFauna` vuelve a contar la fauna por celda en el mundo activo.' },
  { id: 'fauna.recuento', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'syncFauna', patrones: ['const tileIn = tileLookup(tiles);'],
    motivo: 'Escribe `fauna` y `species` en las celdas ocupadas antes o ahora; al final de `stepAnimals` y tras cada caza.' },
  { id: 'reproduccion', fase: 'reproduccion', fichero: 'index.ts', funcion: 'reproduce', patrones: ['for (const a of world.people) {'], motivo: 'Emparejamiento en cadena (`used`).' },
  { id: 'estructuras', fase: 'estructuras', fichero: 'inventions.ts', funcion: 'stepStructures',
    patrones: ['for (const structure of world.structures) {', 'if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {'],
    motivo: 'Cada estructura; y cada 60 pasos cada persona revisa su plano (`inventionContext` ≤ 4, `knownBlueprints` ≤ 5).' },
  { id: 'comunidades', fase: 'comunidades', fichero: 'society.ts', funcion: 'updateCommunities',
    patrones: ['for (const person of world.people) {', 'for (const group of world.communities) {', 'world.communities = world.communities.filter('], motivo: 'Revisión cada 120 pasos.' },
  { id: 'convivencia.revision', fase: 'comunidades', fichero: 'society.ts', funcion: 'reviseByCohabitation', patrones: ['for (const person of world.people) {'], motivo: 'Mayoría de vecinos de confianza.' },
  { id: 'demografia', fase: 'demografia', fichero: 'lineage.ts', funcion: 'advancePopulation',
    patrones: ['world.people = world.people.filter(', 'for (const person of world.people) for (const id of departed)', 'for (const community of world.communities)',
      'world.communities = world.communities.filter(', 'for (const person of world.people) if (person.communityId !== null'], motivo: 'Bajas y limpieza de vínculos y comunidades.' },
  { id: 'activacion.retiro', fase: 'activacion', fichero: 'spatial.ts', funcion: 'maintainRegions',
    patrones: ['for (const tile of world.tiles) {', 'for (const place of world.places) detached', 'world.animals = world.animals.filter(', 'world.structures = world.structures.filter(', 'world.places = world.places.filter('],
    motivo: 'Retira los chunks que nadie necesita.' },
  { id: 'primitiva.tileAt', fase: 'decision', fichero: 'spatial.ts', funcion: 'tileAt', patrones: ['export function tileAt(', 'lastTileAt(world.tiles, p.x, p.y)'],
    motivo: 'Consulta por coordenadas; cada llamada se inventaría donde se hace.' },
];

/** El área que el paso ESCRIBE alrededor de cada persona: materializa teselas, fauna, estructuras y lugares. */
export const ESCRITURAS: readonly Escritura[] = [
  { id: 'activacion', fase: 'activacion', radio: 23, fichero: 'spatial.ts', funcion: 'maintainRegions',
    patrones: ['for (const dx of [-8, 0, 8]) for (const dy of [-8, 0, 8]) {', 'for (const person of world.people) {'],
    motivo: 'Activa el chunk (16 × 16) que contiene (x ± 8, y ± 8): hasta 8 + 15 celdas por eje. Corre antes de toda fase repartida y en el coordinador.' },
];

/** Código de `src/world` que no forma parte del paso: validación, proyección a la vista, creación y migración. */
export const FUERA_DEL_PASO: readonly FueraDelPaso[] = [
  ...['createWorld', 'migrateWorldState', 'upgradeV3', 'upgradeV5'].map(funcion => ({ fichero: 'index.ts', funcion, motivo: 'Creación o migración de un mundo.' })),
  ...['projectWorld', 'personDetail'].map(funcion => ({ fichero: 'index.ts', funcion, motivo: 'Proyección a la vista.' })),
  { fichero: 'index.ts', funcion: 'assertCommon', motivo: 'Validación.' },
  { fichero: 'spatial.ts', funcion: 'projectTerrain', motivo: 'Proyección a la vista (cámara).' },
  { fichero: 'statistics.ts', funcion: 'computeWorldStatistics', motivo: 'Proyección: sólo la llama `worldStatistics`, desde `projectWorld`.' },
  { fichero: 'lineage.ts', funcion: 'assertPopulation', motivo: 'Validación.' },
  { fichero: 'validation.ts', funcion: 'assertLifeState', motivo: 'Validación.' },
  { fichero: 'technology.ts', funcion: 'assertTechnology', motivo: 'Validación.' },
  { fichero: 'technology-water.ts', funcion: 'assertTechnologyWater', motivo: 'Validación.' },
];

/** Umbrales con nombre que aparecen en `distance(…) < | <= | > | >= NOMBRE` dentro de `src/world`. */
export const RADIOS_CON_NOMBRE: Readonly<Record<string, number | ClaveDeRadio | 'comparacion'>> = {
  RADIUS: 7, CONSTRUCTION_RADIUS: 7, RADIO_CONVIVENCIA: 2,
  /** `functionalNear` (1,5 por defecto) y `localTiles` de la fauna (2 + ⌊p·4⌋ ≤ 6). */
  radius: 6,
  /** `earlierForagerExhausts`: `choose` le pasa `RADIUS`. */
  'physical.radius': 7,
  'pop.radioPareja': 'poblacion.radioPareja', 'pop.radioLugar': 'poblacion.radioLugar', disputaRadio: 'social.disputaRadio',
  /** Comparan dos distancias o dos destinos entre sí: no acotan ninguna lectura. */
  disputaDestino: 'comparacion', distance: 'comparacion',
};
/** Umbrales numéricos mayores que el halo que no acotan una lectura. */
export const UMBRALES_QUE_NO_SON_LECTURAS: readonly { fichero: string; funcion: string; umbral: number; motivo: string }[] = [
  { fichero: 'index.ts', funcion: 'applyGesture', umbral: 4096, motivo: 'Rechaza una orden cuyo destino está a más de 4 096 celdas; no lee nada allí.' },
];

type ParamsDeRadio = Pick<WorldParams, 'poblacion' | 'social'>;
function leer(params: ParamsDeRadio, clave: string): number {
  const [seccion, hoja] = clave.split('.') as [string, string];
  return Number((params as unknown as Record<string, Record<string, unknown>>)[seccion]![hoja]);
}
/** Radio de una entrada; `undefined` si depende de parámetros y no se dan. */
export function valorRadio(radio: Radio, params?: ParamsDeRadio): number | undefined {
  if (typeof radio === 'number') return radio;
  if (!params) return undefined;
  return radio.activa && !(leer(params, radio.activa) > 0) ? 0 : leer(params, radio.param);
}
/** Radio de la entrada más el de su cadena de centros; `undefined` si algún eslabón depende de parámetros no dados. */
export function alcanceCompuesto(id: string, inventario: readonly Alcance[] = ALCANCES, params?: ParamsDeRadio): number | undefined {
  const porId = new Map(inventario.map(entrada => [entrada.id, entrada]));
  const vistos = new Set<string>();
  let total = 0;
  for (let actual: string | undefined = id; actual !== 'actor';) {
    const entrada = porId.get(actual!);
    if (!entrada) throw new Error(`Centro desconocido en el inventario de alcances: ${actual}`);
    if (vistos.has(entrada.id)) throw new Error(`Ciclo en el inventario de alcances: ${entrada.id}`);
    vistos.add(entrada.id);
    const radio = valorRadio(entrada.radio, params);
    if (radio === undefined) return undefined;
    total += radio; actual = entrada.centro;
  }
  return total;
}
/** Entradas de las fases con halo, sin excepción, cuyo alcance compuesto supera `halo`. Sin `params`, las
 * que dependen de parámetros no se evalúan (las fija `haloRequerido`). */
export function excesos(inventario: readonly Alcance[] = ALCANCES, halo = HALO_CELDAS, params?: ParamsDeRadio,
  fases: readonly Fase[] = FASES_CON_HALO): { id: string; alcance: number }[] {
  return inventario.filter(e => fases.includes(e.fase) && !e.excepcion)
    .map(e => ({ id: e.id, alcance: alcanceCompuesto(e.id, inventario, params) }))
    .filter((e): e is { id: string; alcance: number } => e.alcance !== undefined && e.alcance > halo);
}
/** Halo que exigen unos parámetros: el mayor alcance compuesto de las fases con halo (sin excepciones). */
export function haloRequerido(params: ParamsDeRadio, inventario: readonly Alcance[] = ALCANCES, fases: readonly Fase[] = FASES_CON_HALO): { celdas: number; causa: string } {
  let mejor = { celdas: 0, causa: '' };
  for (const e of inventario) {
    if (!fases.includes(e.fase) || e.excepcion) continue;
    const celdas = alcanceCompuesto(e.id, inventario, params)!;
    if (celdas > mejor.celdas) mejor = { celdas, causa: e.id };
  }
  return mejor;
}
/** Celdas que una región de `lado` × `lado` lee de sus vecinas con un halo de `halo`, por celda propia. */
export const fraccionBorde = (lado: number, halo: number): number => ((lado + 2 * halo) ** 2 - lado ** 2) / lado ** 2;
