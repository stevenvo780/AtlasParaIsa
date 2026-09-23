/**
 * Halo de las particiones del motor (T111, etapa B de 002-mundo-ilimitado).
 *
 * Una región sólo puede calcular por su cuenta lo que lee dentro de su recinto más `HALO_CELDAS` celdas
 * por eje. Este fichero es el INVENTARIO de lo que el paso lee del mundo alrededor de un punto. El motor no
 * lo importa: es una constante, unas tablas y su prueba (`tests/halo-radios.test.ts`).
 *
 * Fases con halo (`FASES_CON_HALO`): cada una nace en una función RAÍZ (`RAICES`), que sólo puede llamarse desde
 * su bucle de fase. La prueba recorre desde ella, en el fuente, el grafo de llamadas a funciones que leen el
 * mundo, y en cada función alcanzada exige que estén fijados, ENTEROS y en frontera de símbolo, por el texto
 * literal de una entrada de este fichero: toda mención de una colección del mundo (con cualquier receptor,
 * desestructurada o entre corchetes, con la cadena `.filter(…).sort(…)` que cuelga de ella; si un `for … of` la
 * recorre, su cabecera y la condición que acota en la primera sentencia), todo alias local, toda primitiva de
 * consulta con sus argumentos, todo `state.tile/occupants/counts` de la fauna, toda llamada a otra función que
 * lee el mundo con sus argumentos, y todo barrido de desplazamientos (su cabecera y cualquier reasignación).
 * Además, los demás campos de `world`/`host` que lee han de estar en `ESTADO_GLOBAL`, y el mundo no puede
 * aparecer con otro tipo, otro nombre o por reflexión. El alcance compuesto se CALCULA sobre ese grafo:
 * `entrada(F)` es el peor punto con que se llama a `F` (`LLAMADAS`: el centro de cada llamada) y cada lectura
 * de `F` suma su radio a su centro (`entrada` u otra lectura). Así la refutación G2 (`settlementOpportunity`
 * lee personas a ≤ 6 del hogar, que está a ≤ 7) y la cooperación (7 + 7) salen del grafo, no de una suma a mano.
 *
 * Fases seriales: su alcance se inventaría en `ALCANCES_SERIALES` (plano, centro `actor`) con una red más
 * laxa: toda colección de `world`/`host` cuya cadena (o su línea) consulta (`filter`, `find`, `some`, `reduce`,
 * `map`, `slice`, `sort`, `distance`, un índice…) y toda primitiva han de estar fijadas. El halo no las acota y
 * la prueba sólo fija su máximo.
 *
 * Qué NO demuestra la prueba: que el radio escrito en cada entrada sea el verdadero (lo fija quien la escribe;
 * lo contrasta la sonda dinámica del informe de T111, que altera todo lo que está a más de H celdas y compara la
 * decisión), ni el flujo de datos: si cambia de dónde sale una variable local que una lectura fijada usa como
 * punto (`const recuerdo = …`), el texto de la lectura no cambia y la prueba no lo ve. Tampoco mira fuera de
 * `src/world`. Lo que sí garantiza es que un cambio del texto de una lectura, de un barrido o de una llamada en
 * una función alcanzada, o una lectura nueva, rompe la prueba hasta que alguien lo inventaríe.
 *
 * Métrica: celdas por eje. Las personas miden con `Math.hypot` y la fauna con Manhattan; en ambas `d ≤ r`
 * implica |Δx|, |Δy| ≤ r, y dos saltos ≤ r1 y ≤ r2 quedan a ≤ r1 + r2 por eje. Un umbral estricto (`< 5`)
 * cuenta como su radio. El alcance es el de los datos que DECIDEN el resultado: un prefiltro que toca un
 * candidato un poco más lejos y lo descarta por distancia (`filtrarCerca(…, r + 1, … <= r)`) cuenta `r`.
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

/** Dónde vive una entrada: fichero de `src/world`, declaración de primer nivel que la contiene y fragmentos
 * literales de su texto. Cada patrón aparece exactamente `veces` veces (1 si no se dice) en esa declaración. */
export interface Sitio { readonly fichero: string; readonly funcion: string; readonly patrones: readonly string[]; readonly veces?: number }
/** Lectura alrededor de un punto en una función que alcanza una fase con halo. `centro` es `entrada` (el
 * punto con que se llamó a la función: ver `LLAMADAS`) o el `id` de otra lectura, de esta u otra función. */
export interface Alcance extends Sitio {
  readonly id: string;
  readonly coleccion: Coleccion;
  readonly centro: string;
  readonly radio: Radio;
  /** Única salida admitida del halo en una fase con halo: la máscara de presencia no cambia durante
   * el paso (sólo `maintainRegions` activa y retira) y se replica entera de solo lectura. */
  readonly excepcion?: 'presencia';
  readonly nota?: string;
}
/** Llamada, desde una función alcanzada, a otra que lee el mundo (`llama` = `fichero:función`). `centro` es
 * el peor punto que recibe: `entrada` de quien llama o el `id` de una lectura. */
export interface Llamada extends Sitio { readonly id: string; readonly llama: string; readonly centro: string; readonly nota?: string }
/** Función que una fase con halo reparte, el bucle serial que la llama y las lecturas que deciden QUIÉN la
 * ejecuta en cada paso: esas se resuelven antes de repartir, en el coordinador. */
export interface Raiz {
  readonly fase: Fase; readonly fichero: string; readonly funcion: string;
  readonly llamador: Sitio; readonly seleccion: readonly string[]; readonly nota: string;
}
/** Lectura del plano serial: fase explícita y centro `actor` (quien actúa) o el `id` de otra de esta tabla. */
export interface AlcanceSerial extends Sitio { readonly id: string; readonly fase: Fase; readonly coleccion: Coleccion; readonly centro: string; readonly radio: Radio; readonly nota?: string }
export interface LecturaGlobal extends Sitio { readonly id: string; readonly fase: Fase; readonly fuente: string; readonly cota: number | string; readonly motivo: string }
export interface LecturaPorIdentidad extends Sitio { readonly id: string; readonly fase: Fase; readonly fuente: string; readonly motivo: string }
export interface Recorrido extends Sitio { readonly id: string; readonly fase: Fase; readonly motivo: string }
export interface Escritura extends Sitio { readonly id: string; readonly fase: Fase; readonly radio: number; readonly motivo: string }
export interface Declaracion { readonly fichero: string; readonly funcion: string; readonly motivo: string }

const a = (id: string, coleccion: Coleccion, centro: string, radio: Radio, fichero: string, funcion: string,
  patrones: readonly string[], extra: Pick<Alcance, 'excepcion' | 'nota' | 'veces'> = {}): Alcance =>
  ({ id, coleccion, centro, radio, fichero, funcion, patrones, ...extra });
const ll = (fichero: string, funcion: string, llama: string, centro: string, patrones: readonly string[], nota?: string): Llamada =>
  ({ id: `${funcion}→${llama.split(':')[1]}`, fichero, funcion, llama, centro, patrones, ...(nota ? { nota } : {}) });

export const RAICES: readonly Raiz[] = [
  { fase: 'decision', fichero: 'index.ts', funcion: 'choose',
    llamador: { fichero: 'index.ts', funcion: 'bodyAndAction', patrones: ["(person.thirst > 0.9 && person.action !== 'drink'))) choose(world, person);"] },
    seleccion: ['accion.destino', 'accion.aqui'],
    nota: 'Quién decide lo resuelve `bodyAndAction` en la cadena serial: su turno (`decisionAt`) y el disparador de destino agotado, que lee la tesela y el agua de su destino propio (`accion.destino`: hasta 4 096 celdas con una orden). Al repartir `choose`, ese disparador se evalúa antes y fuera del halo. `choose` tampoco es de solo lectura hoy: al decidir por un recuerdo de S e I escribe un evento de crónica (id global, `addEvent`), y resolver recetas toca el LRU del catálogo (`ESTADO_GLOBAL.technology`). El halo acota lo que se lee; esas escrituras las ordena la confirmación (E.1), y este inventario no las recorre.' },
  { fase: 'fauna', fichero: 'animals.ts', funcion: 'choose',
    llamador: { fichero: 'animals.ts', funcion: 'stepAnimals', patrones: ['for (const animal of due) choose(animal, world, state);'] },
    seleccion: ['fauna.ventana', 'fauna.turno'],
    nota: 'Quién decide sale de dos selecciones sobre TODA la fauna activa (`LECTURAS_GLOBALES`): la ventana rotatoria de `MAX_ACTIVE_ANIMALS` y los `MAX_ANIMAL_DECISIONS_PER_TICK` más atrasados. Las calcula el coordinador; sólo la decisión de cada animal elegido se reparte.' },
  { fase: 'ecologia', fichero: 'index.ts', funcion: 'ecology',
    llamador: { fichero: 'index.ts', funcion: 'advanceTick', patrones: ["medirFase(medicion, 'ecologia', () => ecology(world));"] }, seleccion: [],
    nota: 'Cada tesela activa. El cambio de tiempo (cada 600 pasos) consume `world.rng` y se queda en el coordinador.' },
  { fase: 'ecologia', fichero: 'ecosystem-kernel.ts', funcion: 'EcosystemKernel',
    llamador: { fichero: 'ecosystem.ts', funcion: 'ecosystemKernel', patrones: ['const ecosystemKernel = new EcosystemKernel();'] }, seleccion: [],
    nota: 'Una sola instancia, la de `ecosystem.ts`, que `stepEcosystem` llama cada 10 pasos (`ecosystemKernel.step(tiles, …)`). El kernel recibe `world.tiles` como `tiles`: `COLECCIONES_POR_NOMBRE` lo declara colección.' },
];

/** Colecciones del mundo que una función recibe con otro nombre (el kernel recibe `world.tiles` como `tiles`). */
export const COLECCIONES_POR_NOMBRE: readonly { fichero: string; funcion: string; nombres: readonly string[] }[] = [
  { fichero: 'ecosystem-kernel.ts', funcion: 'EcosystemKernel', nombres: ['tiles', 'lifeBefore'] },
  { fichero: 'ecosystem-kernel.ts', funcion: 'buildTopology', nombres: ['tiles'] },
  { fichero: 'ecosystem-kernel.ts', funcion: 'sameCoordinates', nombres: ['tiles'] },
];

/** Primitivas de consulta. No se recorren: cada llamada a una de ellas es una lectura que el inventario fija
 * donde se hace, con el radio de esa llamada. */
export const PRIMITIVAS: readonly Declaracion[] = [
  { fichero: 'spatial.ts', funcion: 'tileAt', motivo: 'Tesela de unas coordenadas (índice por casillas de `world.tiles`).' },
  ...['firstTileAt', 'lastTileAt', 'tileLookup'].map(funcion => ({ fichero: 'tile-index.ts', funcion, motivo: 'Tesela de unas coordenadas.' })),
  ...['filtrarCerca', 'primeroCerca', 'algunoCerca'].map(funcion => ({ fichero: 'indice-puntos.ts', funcion, motivo: 'Elementos a ≤ r por eje de un punto, en el orden del arreglo; el predicado acota.' })),
  { fichero: 'index.ts', funcion: 'personById', motivo: 'Persona por id: lectura por identidad, sin cota espacial.' },
  // T141: la rejilla efímera de personas. `vecinos` ≡ `world.people.filter(pred)` y `primerVecino` ≡
  // `world.people.find(pred)` para cualquier `pred` que implique |Δx|, |Δy| ≤ alcance (los llamadores
  // dan radio + 1, igual que `filtrarCerca`/`primeroCerca`): mismos objetos, mismo orden de slot.
  ...['vecinos', 'primerVecino'].map(funcion => ({ fichero: 'rejilla.ts', funcion, motivo: 'Personas a ≤ alcance de un centro (equivalente a world.people.filter/find, T141).' })),
  // T140: techo de identidades del archivo dormido y pertenencia O(1), cacheados por `world.tick`.
  { fichero: 'indices.ts', funcion: 'techoDelArchivo', motivo: 'Techo de ids de blueprint/structure entre los chunks retirados (sustituye el flatMap de world.retiredChunks).' },
  { fichero: 'indices.ts', funcion: 'esMiembro', motivo: 'Pertenencia a un arreglo de personas (sustituye `.includes`), cacheada por `world.tick`.' },
  // `isHostMember` está declarada por separado en `technology.ts` y en `technology-water.ts` (mismo
  // nombre, cuerpos independientes, cada uno con su propia caché); una sola entrada basta para que
  // el análisis léxico (que va por nombre) reconozca cualquier llamada `isHostMember(...)` como
  // primitiva. La declaración de `technology.ts` va además en `FUERA_DEL_PASO`, para que su propio
  // cuerpo no se analice bajo el otro nombre de fichero.
  { fichero: 'technology-water.ts', funcion: 'isHostMember', motivo: 'Pertenencia O(1) a host.people (Set cacheado por longitud del arreglo).' },
];

/** Lecturas alrededor de un punto en las funciones que alcanzan las fases con halo. */
export const ALCANCES: readonly Alcance[] = [
  // Decisión de cada persona: `choose`.
  a('decision.teselas', 'teselas', 'entrada', 7, 'index.ts', 'choose', ['for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {',
    'if (dx * dx + dy * dy > RADIUS * RADIUS) continue;', 'const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });']),
  a('decision.personas', 'personas', 'entrada', 7, 'index.ts', 'choose', ["const nearbyPeople = vecinos(world, person, RADIUS + 1, other => other.id !== person.id && distance(person, other) <= RADIUS, 'choose');"]),
  a('decision.lugarFamilia', 'lugares', 'entrada', 7, 'index.ts', 'choose', ['filtrarCerca(world.places, person, RADIUS + 1, place => distance(person,place)<=RADIUS && distance(family.partner,place)<=RADIUS)',
    '.sort((a,b) => (distance(person,a)+distance(family.partner,a))-(distance(person,b)+distance(family.partner,b)) || a.id.localeCompare(b.id))[0]']),
  a('decision.caza', 'animales', 'decision.teselas', 0, 'index.ts', 'choose', ['const victim = world.animals.filter(a => a.x === tile.x && a.y === tile.y && a.health > 0)', '.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];']),
  a('decision.obra', 'lugares', 'decision.teselas', 5, 'index.ts', 'choose', ['!algunoCerca(world.places, t, 6, p => distance(p, t) < 5)'],
    { nota: 'Antes de PERF2 recorría todo `world.places`; hoy usa el índice por casillas, pero la regla sigue siendo «ningún lugar a < 5 de una tesela a ≤ 7»: 12.' }),
  a('decision.lugarCompartir', 'lugares', 'entrada', 3, 'index.ts', 'choose', ['const place = primeroCerca(world.places, person, 4, p => distance(person, p) <= 3);']),
  a('decision.destinoForrajeo', 'teselas', 'entrada', 0, 'index.ts', 'choose', ["(selected.action!=='forage' || (tileAt(world,person.target)?.food??0)>=MIN_FORAGE_STOCK)"],
    { nota: 'Sólo con `person.work > 0`: el trabajo se acumula en el destino (distancia < 0,5) y se pone a 0 al cambiarlo, y nadie se mueve si ya está en él.' }),
  a('decision.sedPorPaso', 'teselas', 'entrada', 0, 'index.ts', 'choose', ['const sedPorPaso = bodilyNeedRates(world, tileAt(world, person)!']),
  a('decision.aguaRecordada', 'punto', 'entrada', 7, 'index.ts', 'choose', ['if (recuerdo && distance(person, recuerdo) <= RADIUS && waterAvailable(world, recuerdo) <= 0.005)'],
    { nota: 'El agua recordada sólo se consulta si está a ≤ `RADIUS`; más lejos sólo se compara su distancia.' }),
  a('decision.cortejo', 'personas', 'entrada', { param: 'poblacion.radioCortejo', activa: 'poblacion.cortejo' }, 'index.ts', 'choose', ['away > leyPoblacion.radioCortejo'],
    { nota: 'Reglas 10: 128 celdas. La lectura por id de cada vínculo no tiene cota (ver `vinculos.cortejo`); el radio acota a quién se decide buscar.' }),
  a('decision.techo', 'estructuras', 'entrada', 0, 'index.ts', 'bodilyShelter',
    ["tileAt(world, point)?.terrain === 'shelter' ? Math.max(0, ...filtrarCerca(world.structures, point, 0,", "s => s.x === point.x && s.y === point.y && s.condition > BROKEN_CONDITION && s.components.includes('roof'))"]),
  a('decision.comidaInmediata', 'teselas', 'entrada', 0, 'index.ts', 'immediateMeal', ['Math.min(tileAt(world, person)?.food ?? 0, 0.0035)']),
  a('decision.recuperarAgua', 'teselas', 'entrada', 0, 'index.ts', 'canRecoverWaterHandling', ['bodilyNeedRates(world, tileAt(world, person)!']),
  a('decision.companeros', 'personas', 'entrada', 7, 'index.ts', 'explorationTarget', ["const companions = world.cooperationEnabled ? vecinos(world, person, 8, p => p.id !== person.id && distance(person, p) <= 7 && (person.bonds[p.id] ?? 0) > 0.3, 'explorationTarget') : [];"]),
  a('familia.pareja', 'personas', 'entrada', 7, 'family.ts', 'familyOpportunity', ['const partner = vecinos(world, person, 8, other => other !== person && other.id !== person.id && !!other.communityId',
    '&& distance(person, other) <= 7 && (person.bonds[other.id] ?? 0) >= 0.3 && (other.bonds[person.id] ?? 0) >= 0.3', '&& !closeKin(person, other) && reproductiveReadiness(world, other)',
    '.sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];']),
  a('familia.lugar', 'lugares', 'entrada', 7, 'family.ts', 'familyOpportunity', ['&& algunoCerca(world.places, person, 8, place => distance(person, place) <= 7 && (distance(person, place) <= 4 || distance(other, place) <= 4)))']),
  // G2: `viable` mira alrededor del hogar (a ≤ 7) y de cada lugar a ≤ 6.
  a('asentamiento.hogar', 'punto', 'entrada', 7, 'society.ts', 'settlementOpportunity', ['if (person.home && distance(person,person.home)<=7) {', 'person.home.quality = viable(person.home);']),
  a('asentamiento.lugares', 'lugares', 'entrada', 6, 'society.ts', 'settlementOpportunity', ['const nearby = filtrarCerca(world.places, person, 7, p=>distance(person,p)<=6).map(p=>({place:p,quality:viable(p)}))',
    '.sort((a,b)=>b.quality-a.quality || distance(person,a.place)-distance(person,b.place));']),
  ...(['asentamiento.hogar', 'asentamiento.lugares'] as const).flatMap(centro => [
    a(`${centro}.teselas`, 'teselas', centro, 4, 'society.ts', 'settlementOpportunity', ['for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {', 'if (dx*dx+dy*dy>16) continue;', 'const tile = tileAt(world,{x:place.x+dx,y:place.y+dy});']),
    a(`${centro}.estructuras`, 'estructuras', centro, 4, 'society.ts', 'settlementOpportunity', ['const facilities = filtrarCerca(world.structures, place, 5, s=>distance(s,place)<=4 && s.condition>0.1);']),
    a(`${centro}.personas`, 'personas', centro, 6, 'society.ts', 'settlementOpportunity', ["const peers = vecinos(world, place, 7, p=>p!==person && distance(p,place)<=6, 'settlementOpportunity');"]),
  ]),
  // Cooperación: el otro a ≤ 7, y desde él su destino y sus insumos.
  a('cooperacion.otro', 'personas', 'entrada', 7, 'society.ts', 'evaluateCooperation', ["for (const other of vecinos(world, person, 8, other => !(other === person || distance(person, other) > 7), 'cooperationOpportunity')) {",
    'const same = person.communityId && person.communityId === other.communityId;']),
  a('cooperacion.destinoDelOtro', 'teselas', 'entrada', 7, 'society.ts', 'practicedSkillToTeach', ['distance(learner, learner.target) > 7', 'const tile = tileAt(world, learner.target);']),
  a('cooperacion.insumos', 'teselas', 'entrada', 7, 'society.ts', 'localRecipeInputs', ['for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {',
    'if (dx * dx + dy * dy > 49) continue;', 'const tile = tileAt(world, { x: learner.x + dx, y: learner.y + dy });']),
  a('cooperacion.necesidad', 'teselas', 'entrada', 7, 'society.ts', 'itemNeed', ['if (distance(person, person.target) <= 7) {', 'const tile = tileAt(world, person.target);']),
  // Obra, inventos y servicios.
  a('obra.servicios', 'estructuras', 'entrada', 7, 'inventions.ts', 'localServices', ['for (const structure of filtrarCerca(world.structures, person, CONSTRUCTION_RADIUS + 1,',
    "structure => !(distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)?.terrain !== 'shelter'))) {",
    'add(structure.components, replacement?.structure === structure ? replacement.condition : structure.condition, structure.water, structure.food);']),
  a('obra.personas', 'personas', 'entrada', 7, 'inventions.ts', 'constructionContext', ['const nearby = vecinos(world, person, CONSTRUCTION_RADIUS + 1, other => distance(person, other) <= CONSTRUCTION_RADIUS);']),
  a('obra.materiales', 'teselas', 'entrada', 7, 'inventions.ts', 'localMaterials', ['for (let dy = -CONSTRUCTION_RADIUS; dy <= CONSTRUCTION_RADIUS; dy++) for (let dx = -CONSTRUCTION_RADIUS; dx <= CONSTRUCTION_RADIUS; dx++) {',
    'if (dx * dx + dy * dy > CONSTRUCTION_RADIUS * CONSTRUCTION_RADIUS) continue;', 'const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });']),
  a('obra.reparaciones', 'estructuras', 'entrada', 7, 'inventions.ts', 'usefulRepairs',
    ["return filtrarCerca(world.structures, person, CONSTRUCTION_RADIUS + 1, structure => !(structure.condition >= REPAIR_CONDITION_LIMIT\n    || distance(person, structure) > CONSTRUCTION_RADIUS || tileAt(world, structure)?.terrain !== 'shelter')).flatMap(structure => {\n    // Evaluate each physically legal paid prefix. A broken roof can need several\n    // steps before it helps; a last top-up with no extra service earns no benefit.\n    let condition = structure.condition, steps = 0;\n    const options: { structure: StructureView; gain: number; steps: number; efficiency: number }[] = [];\n    while (condition < REPAIR_CONDITION_LIMIT) {\n      condition = clamp(condition + 0.4); steps++;\n      const gain = serviceValue(localServices(world, person, { structure, condition }, undefined, Math.max(0, person.materials.wood - steps)), context) - before;\n      if (gain >= MIN_SERVICE_GAIN) options.push({ structure, gain, steps, efficiency: gain / (steps * (1 + REPAIR_WORK / 30)) });\n    }\n    return options;\n  }).sort((a, b) => b.efficiency - a.efficiency || distance(person, a.structure) - distance(person, b.structure) || a.structure.id.localeCompare(b.structure.id));"],
    { nota: 'La cadena entera va fijada: `filtrarCerca(...)` encadena `.flatMap(...)` y el análisis exige el bloque completo, no sólo su cabecera.' }),
  a('invento.teselas', 'teselas', 'entrada', 4, 'inventions.ts', 'inventionContext', ['for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {',
    'if (dx * dx + dy * dy > 16) continue;', 'const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });'],
    { nota: 'También cada 60 pasos en `stepStructures`, alrededor de cada persona (fase serial).' }),
  a('invento.personas', 'personas', 'entrada', 4, 'inventions.ts', 'inventionContext', ['const portable = vecinos(world, person, 5, p => distance(person, p) <= 4).reduce((sum, p) => sum + Math.max(0, p.inventory - 0.08), 0);']),
  a('invento.techos', 'estructuras', 'entrada', 4, 'inventions.ts', 'inventionContext', ["const roofs = filtrarCerca(world.structures, person, 5, s => distance(person, s) <= 4 && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter');"]),
  a('invento.planosEstructuras', 'estructuras', 'entrada', 5, 'inventions.ts', 'knownBlueprints', ["for (const structure of filtrarCerca(world.structures, person, 6, structure => distance(person, structure) <= 5",
    "&& structure.condition > BROKEN_CONDITION && tileAt(world, structure)?.terrain === 'shelter')) ids.add(structure.blueprintId);"]),
  a('invento.planosPersonas', 'personas', 'entrada', 3, 'inventions.ts', 'knownBlueprints', ['if (world.cooperationEnabled) for (const other of vecinos(world, person, 4, other => other !== person && distance(person, other) <= 3',
    '&& (person.bonds[other.id] ?? 0.2) >= 0.2 && person.culture.openness >= 0.15)) ids.add(other.blueprintId);']),
  a('estructuras.funcionales', 'estructuras', 'entrada', 1.5, 'inventions.ts', 'functionalNear', ['(world: World, point: Point, radius = 1.5) => filtrarCerca(world.structures, point, radius + 1, s => Math.abs(s.x - point.x) <= radius + 1',
    "&& Math.abs(s.y - point.y) <= radius + 1 && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius);"], { nota: 'Radio 1,5 por defecto; `waterAvailable` y `restFacility` piden 0,5. La prueba exige que ninguna llamada pida más de 1,5.' }),
  a('agua.disponible', 'teselas', 'entrada', 0, 'inventions.ts', 'waterAvailable', ['(tileAt(world, point)?.drinkingWater ?? 0)']),
  ...(['planWithdrawal', 'localInputs', 'localTechnologyUses', 'dependencyCraft'] as const).map(funcion =>
    a(`tecnologia.${funcion}`, 'teselas', 'entrada', 0, 'technology.ts', funcion, ['(host.tiles ? firstTileAt(host.tiles, Math.round(actor.x), Math.round(actor.y)) : undefined)'])),
  // Decisión de la fauna: `choose` y `localTiles` de animals.ts.
  a('fauna.percepcion', 'teselas', 'entrada', 6, 'animals.ts', 'localTiles', ['const radius = 2 + Math.floor(animal.genes.perception * 4)',
    'for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {', 'if (Math.abs(dx) + Math.abs(dy) > radius) continue;',
    'const tile = state.tile(animal.x + dx, animal.y + dy);'], { nota: 'Rombo Manhattan de radio 2 + ⌊p·4⌋ ≤ 6.' }),
  a('fauna.vecinos', 'animales', 'fauna.percepcion', 0, 'animals.ts', 'choose', ['visible.flatMap(t => state.occupants.get(cell(t)) ?? [])'],
),
  a('fauna.amenazas', 'animales', 'fauna.percepcion', 0, 'animals.ts', 'choose', ['const threats = near.filter(a => edible(a, animal) && distance(a, animal) <= 1 + Math.floor(animal.genes.perception * 5));'],
    { nota: 'Subconjunto de `fauna.vecinos`: el umbral `1 + ⌊p·5⌋ ≤ 6` filtra lo ya percibido.' }),
  a('fauna.adyacentes', 'animales', 'fauna.percepcion', 0, 'animals.ts', 'choose', ['const adjacent = visible.filter(t => distance(t, animal) === 1 && (state.counts.get(cell(t)) ?? 0) < MAX_ANIMALS_PER_TILE);'],
    { nota: 'Ocupación de las celdas visibles a distancia 1.' }),
  a('fauna.memoria', 'teselas', 'entrada', 126, 'animals.ts', 'choose', ['state.tile(m.x, m.y) !== undefined'],
    { excepcion: 'presencia', nota: 'Sólo pregunta si la celda recordada sigue activa: recuerdos de ≤ 480 pasos (`MEMORY_TTL`), un paso de celda cada ≥ 4 pasos y celdas vistas a ≤ 6: 6 + 480/4.' }),
  // Ecología: vecindad de una celda.
  a('ecologia.vecinos', 'teselas', 'entrada', 1, 'index.ts', 'ecology', ["const waterAt = (x: number, y: number): boolean => tileIn(x, y)?.terrain === 'water';",
    'waterAt(tile.x - 1, tile.y) || waterAt(tile.x + 1, tile.y) || waterAt(tile.x, tile.y - 1) || waterAt(tile.x, tile.y + 1)']),
  a('kernel.propia', 'teselas', 'entrada', 0, 'ecosystem-kernel.ts', 'EcosystemKernel', [
    'const store = options?.soaTerreno === true ? this.soaTopology(tiles) : null;',
    'const length = tiles.length, cells = store?.cells, living = store?.livingNeighborCounts(0.45), front = store?.lifeFront;',
    'for (let i = 0; i < length; i++) lifeBefore[i] = tiles[i].life ?? 0;', 'const tile = tiles[i];', 'life = lifeBefore[i];',
    'if (!store.loadLife(tiles)) return null;'],
    { nota: 'T112: con `motor.soaTerreno` la foto de `life` y la presencia van al `TileStore` (`soaTopology`, misma clase) y los vecinos vivos salen por aritmética (`kernel.vivos`); sin él sigue la caché de topologías de objetos.' }),
  a('kernel.vecinos', 'teselas', 'entrada', 1, 'ecosystem-kernel.ts', 'buildTopology', ['for (let dy = -1; dy <= 1; dy++) {', 'const row = rows.get(tile.y + dy);',
    'for (let dx = -1; dx <= 1; dx++) {', 'neighbors[offset++] = row === undefined ? -1 : row.get(tile.x + dx) ?? -1;']),
  a('kernel.vivos', 'teselas', 'kernel.vecinos', 0, 'ecosystem-kernel.ts', 'EcosystemKernel', ['for (let offset = 0; offset < 8; offset++) {', 'if (neighbor >= 0 && lifeBefore[neighbor] >= 0.45) livingNeighbors++;']),
];

/** Llamadas entre funciones que leen el mundo, dentro de las fases con halo. */
export const LLAMADAS: readonly Llamada[] = [
  ll('index.ts', 'choose', 'society.ts:settlementOpportunity', 'entrada', ['const home = settlementOpportunity(world,person);']),
  ll('index.ts', 'choose', 'inventions.ts:foodAvailable', 'entrada', ['foodAvailable(world,person)>0']),
  ll('index.ts', 'choose', 'index.ts:bodilyShelter', 'decision.teselas', ['const protection = bodilyShelter(world, person)',
    'bodilyShelter(world, b) * (TICKS_PER_DAY - stepsTo(b)! * 6) - bodilyShelter(world, a) * (TICKS_PER_DAY - stepsTo(a)! * 6)', 'tile => bodilyShelter(world, tile) > 0',
    'bodilyShelter(world, candidate.target)'], 'Sobre sí, teselas percibidas y destinos con ruta percibida (`stepsTo` definido: ≤ 7).'),
  ll('index.ts', 'choose', 'index.ts:immediateMeal', 'decision.teselas', ['meal = immediateMeal(world, person)', 'immediateMeal(world, { ...person, ...candidate.target })'],
    'Sobre sí y sobre destinos de comida con ruta percibida (≤ 7).'),
  ll('index.ts', 'choose', 'family.ts:familyOpportunity', 'entrada', ['const family = familyOpportunity(world, person);']),
  ll('index.ts', 'choose', 'index.ts:workDuration', 'decision.personas', ["workDuration(world, person, 'forage')", "duration: other => workDuration(world, other, 'forage')"]),
  ll('index.ts', 'choose', 'inventions.ts:waterAvailable', 'decision.teselas', ['t => waterAvailable(world,t) > 0.005', 'const localWater = waterAvailable(world, person) > 0;',
    'waterAvailable(world, recuerdo)', 'if (waterAvailable(world, person) > 0 && damage > 0)'], 'Sobre sí, teselas percibidas y el agua recordada a ≤ `RADIUS`.'),
  ll('index.ts', 'choose', 'index.ts:canRecoverWaterHandling', 'entrada', ['canRecoverWaterHandling(world, person)']),
  ll('index.ts', 'choose', 'society.ts:cooperationOpportunity', 'entrada', ['const help = cooperationOpportunity(world, person);']),
  ll('index.ts', 'choose', 'inventions.ts:constructionCost', 'entrada', ['const cost = constructionCost(world,person);']),
  ll('index.ts', 'choose', 'inventions.ts:constructionOpportunity', 'entrada', ['constructionOpportunity(world, person)']),
  ll('index.ts', 'choose', 'inventions.ts:inventionOpportunity', 'entrada', ['inventionOpportunity(world,person)']),
  ll('index.ts', 'choose', 'technology.ts:technologyOpportunity', 'entrada', ['technologyOpportunity(world,person)']),
  ll('index.ts', 'choose', 'inventions.ts:repairOpportunity', 'entrada', ['repairOpportunity(world,person)']),
  ll('index.ts', 'choose', 'family.ts:availableToShare', 'entrada', ['availableToShare(world, person, hungry)']),
  ll('index.ts', 'choose', 'index.ts:drinkingBody', 'decision.teselas', ['drinkingBody(world, person, candidate.target)'], 'Destinos con ruta percibida (≤ 7).'),
  ll('index.ts', 'choose', 'index.ts:explorationTarget', 'entrada', ["if (command.order === 'explore') directed.target = explorationTarget(world, person, reachableTiles);",
    'selected.target = continuingSearch ? person.target : explorationTarget(world, person, reachableTiles);']),
  ll('index.ts', 'immediateMeal', 'inventions.ts:foodAvailable', 'entrada', ['Math.min(foodAvailable(world, person), 0.002)']),
  ll('index.ts', 'drinkingBody', 'inventions.ts:waterAvailable', 'entrada', ['Math.min(waterAvailable(world, point), needed)']),
  ll('index.ts', 'localRestQuality', 'inventions.ts:facilityRestQuality', 'entrada', ['facilityRestQuality(world, person)']),
  ll('index.ts', 'canRecoverWaterHandling', 'index.ts:localRestQuality', 'entrada', ['quality = localRestQuality(world, person)']),
  ll('index.ts', 'workDuration', 'inventions.ts:constructionCost', 'entrada', ["action === 'build' ? constructionCost(world, person).work"]),
  ll('family.ts', 'availableToShare', 'family.ts:familyOpportunity', 'entrada', ['const family = familyOpportunity(world, person);']),
  ll('society.ts', 'cooperationOpportunity', 'society.ts:evaluateCooperation', 'entrada', ['evaluateCooperation(world, person)']),
  ll('society.ts', 'evaluateCooperation', 'inventions.ts:constructionCost', 'cooperacion.otro', ['const cost = constructionCost(world,other);']),
  ll('society.ts', 'evaluateCooperation', 'society.ts:practicedRecipeToTeach', 'cooperacion.otro', ['practicedRecipeToTeach(world, person, other, world.learningEnabled ? practiced ??= practicedRecipes(person) : undefined)']),
  ll('society.ts', 'evaluateCooperation', 'society.ts:productExchange', 'cooperacion.otro', ['productExchange(world, person, other)']),
  ll('society.ts', 'evaluateCooperation', 'society.ts:practicedSkillToTeach', 'cooperacion.otro', ['practicedSkillToTeach(world, person, other)']),
  ll('society.ts', 'practicedRecipeToTeach', 'society.ts:localRecipeInputs', 'entrada', ['localRecipeInputs(world, teacher, learner)'], '`entrada` es el aprendiz (el otro).'),
  ll('society.ts', 'practicedRecipeToTeach', 'society.ts:recipeHolders', 'entrada', ['recipeHolders(world, viable)']),
  ll('society.ts', 'productExchange', 'society.ts:itemNeed', 'entrada', ['itemNeed(world, buyer, i) > 0 && itemNeed(world, seller, i, true) === 0',
    'itemNeed(world, buyer, b) - itemNeed(world, buyer, a)'], 'Comprador (el otro, 7) y vendedor (quien decide, 0): cuenta el peor.'),
  ll('inventions.ts', 'constructionCost', 'inventions.ts:selectedBlueprint', 'entrada', ['selectedBlueprint(world, person).components']),
  ll('inventions.ts', 'constructionOpportunity', 'inventions.ts:selectedBlueprint', 'entrada', ['const blueprint = selectedBlueprint(world, person)']),
  ll('inventions.ts', 'constructionOpportunity', 'inventions.ts:localMaterials', 'entrada', ['materials = localMaterials(world, person);']),
  ll('inventions.ts', 'constructionOpportunity', 'inventions.ts:constructionContext', 'entrada', ['const context = constructionContext(world, person)']),
  ll('inventions.ts', 'constructionOpportunity', 'inventions.ts:localServices', 'entrada', ['serviceValue(localServices(world, person), context)',
    'serviceValue(localServices(world, person, undefined, blueprint.components, Math.max(0, person.materials.wood - cost.wood))']),
  ll('inventions.ts', 'constructionOpportunity', 'inventions.ts:usefulRepairs', 'entrada', ['const repair = usefulRepairs(world, person)']),
  ll('inventions.ts', 'constructionContext', 'inventions.ts:inventionContext', 'entrada', ['...inventionContext(world, person)']),
  ll('inventions.ts', 'usefulRepairs', 'inventions.ts:constructionContext', 'entrada', ['const context = constructionContext(world, person)']),
  ll('inventions.ts', 'usefulRepairs', 'inventions.ts:localServices', 'entrada', ['serviceValue(localServices(world, person), context)',
    'serviceValue(localServices(world, person, { structure, condition }, undefined, Math.max(0, person.materials.wood - steps))']),
  ll('inventions.ts', 'inventionCandidates', 'inventions.ts:inventionContext', 'entrada', ['const context = inventionContext(world, person)']),
  ll('inventions.ts', 'inventionCandidates', 'inventions.ts:knownBlueprints', 'entrada', ['known = knownBlueprints(world, person)']),
  ll('inventions.ts', 'chooseInvention', 'inventions.ts:inventionContext', 'entrada', ['const context = inventionContext(world, person)']),
  ll('inventions.ts', 'chooseInvention', 'inventions.ts:inventionCandidates', 'entrada', ['paretoCandidates(inventionCandidates(world, person))']),
  ll('inventions.ts', 'inventionOpportunity', 'inventions.ts:inventionContext', 'entrada', ['const context = inventionContext(world, person)']),
  ll('inventions.ts', 'inventionOpportunity', 'inventions.ts:chooseInvention', 'entrada', ['!chooseInvention(world, person)']),
  ll('inventions.ts', 'repairOpportunity', 'inventions.ts:localMaterials', 'entrada', ['const materials = localMaterials(world, person);']),
  ll('inventions.ts', 'repairOpportunity', 'inventions.ts:usefulRepairs', 'entrada', ['return usefulRepairs(world, person)']),
  ll('inventions.ts', 'foodAvailable', 'inventions.ts:functionalNear', 'entrada', ['functionalNear(world, person).reduce(']),
  ll('inventions.ts', 'waterAvailable', 'inventions.ts:functionalNear', 'entrada', ['functionalNear(world, point, 0.5)']),
  ll('inventions.ts', 'restFacility', 'inventions.ts:functionalNear', 'entrada', ['return functionalNear(world, person, 0.5)']),
  ll('inventions.ts', 'facilityRestQuality', 'inventions.ts:restFacility', 'entrada', ['const structure = restFacility(world, person);']),
  ll('technology.ts', 'technologyOpportunity', 'technology.ts:dependencyCraft', 'entrada', ['const dependency = dependencyCraft(host, actor, known, powers);']),
  ll('technology.ts', 'technologyOpportunity', 'technology.ts:planWithdrawal', 'entrada', ['known.filter(r => planWithdrawal(host, actor, r.program)']),
  ll('technology.ts', 'technologyOpportunity', 'technology.ts:localInputs', 'entrada', ['!localInputs(host, actor).length']),
  ll('technology.ts', 'dependencyCraft', 'technology.ts:localTechnologyUses', 'entrada', ['const uses = localTechnologyUses(host, actor)',
    'const finalUses = localTechnologyUses({ ...privateHost, technology: host.technology }, privateActor)'], 'El actor privado es una copia en el mismo sitio.'),
  ll('technology.ts', 'dependencyCraft', 'technology.ts:forecastCraft', 'entrada', ['const output = forecastCraft(privateHost, privateActor, recipe);']),
  ll('technology.ts', 'forecastCraft', 'technology.ts:planWithdrawal', 'entrada', ['const plan = planWithdrawal(host, actor, recipe.program);']),
  ll('animals.ts', 'choose', 'animals.ts:localTiles', 'entrada', ['const visible = localTiles(animal, state)']),
  ll('ecosystem-kernel.ts', 'EcosystemKernel', 'ecosystem-kernel.ts:buildTopology', 'entrada', ['buildTopology(tiles)']),
  ll('ecosystem-kernel.ts', 'EcosystemKernel', 'ecosystem-kernel.ts:sameCoordinates', 'entrada', ['sameCoordinates(topology, tiles)']),
];

const s = (id: string, fase: Fase, coleccion: Coleccion, centro: string, radio: Radio, fichero: string, funcion: string,
  patrones: readonly string[], extra: Pick<AlcanceSerial, 'nota' | 'veces'> = {}): AlcanceSerial =>
  ({ id, fase, coleccion, centro, radio, fichero, funcion, patrones, ...extra });

/** Lecturas de las fases seriales, planas: el halo no las acota y la prueba sólo fija su máximo. */
export const ALCANCES_SERIALES: readonly AlcanceSerial[] = [
  s('fauna.mover', 'faunaSerial', 'teselas', 'actor', 1, 'animals.ts', 'move', ['.map(([dx, dy]) => state.tile(animal.x + dx!, animal.y + dy!))']),
  s('fauna.cria', 'faunaSerial', 'animales', 'actor', 1, 'animals.ts', 'reproduce', ['state.occupants.get(cellXY(a.x + dx!, a.y + dy!))']),
  // Acción de cada persona: cadena secuencial en orden de `world.people`.
  s('accion.bfs', 'accion', 'teselas', 'actor', 24, 'index.ts', 'move', ['Math.abs(next.y - start.y)) > 24 || !walkable(world, next)'],
    { nota: 'Búsqueda en anchura acotada a 24 celdas por eje (y 2 048 nodos): lee terreno y presencia.' }),
  s('accion.caminable', 'accion', 'teselas', 'accion.bfs', 0, 'index.ts', 'walkable', ['const tile = tileAt(world, p);']),
  s('accion.pisada', 'accion', 'teselas', 'actor', 0, 'index.ts', 'move', ['trampleTile(tileAt(world, person)!)']),
  s('accion.aqui', 'accion', 'teselas', 'actor', 0, 'index.ts', 'bodyAndAction', ['const tile = tileAt(world, person)!;', 'const current = tileAt(world, person)!;']),
  s('accion.destino', 'accion', 'teselas', 'actor', 4096, 'index.ts', 'bodyAndAction',
    ["person.action === 'eat' && (tileAt(world, person.target)?.food", "person.action === 'forage' && (tileAt(world, person.target)?.food", 'waterAvailable(world,person.target) < 0.003'],
    { nota: 'Destinos propios: ≤ 7 si los eligió `choose`, pero una orden (`forage`, `drink`, `hunt`) fuera de la vista deja el destino en el punto del gesto, a ≤ 4 096 celdas.' }),
  s('accion.compartirLugar', 'accion', 'lugares', 'actor', 3, 'index.ts', 'share', ['primeroCerca(world.places, donor, 4, p => distance(donor, p) <= 3)']),
  s('accion.compartirReceptor', 'accion', 'personas', 'actor', 2, 'index.ts', 'share', ["const recipient = vecinos(world, donor, 3, p => p.id !== donor.id && p.hunger > 0.27 && distance(p, donor) <= 2, 'share:recipient').sort((a, b) => b.hunger - a.hunger)[0];"]),
  s('accion.observadores', 'accion', 'personas', 'actor', 3, 'index.ts', 'share', ["for (const observer of vecinos(world, donor, 4, observer => !(observer.id === donor.id || distance(observer, donor) > 3), 'share:observers')) {"]),
  s('accion.reparar', 'accion', 'estructuras', 'actor', 0, 'index.ts', 'performWork', ['primeroCerca(world.structures, tile, 1, s=>s.x===tile.x&&s.y===tile.y)']),
  s('accion.obraLugares', 'accion', 'lugares', 'actor', 5, 'inventions.ts', 'completeConstruction', ['tileAt(world, tile) !== tile', 'algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5)']),
  s('accion.obraEstructuras', 'accion', 'estructuras', 'actor', 0, 'inventions.ts', 'completeConstruction', ['algunoCerca(world.structures, tile, 1, s => s.x === tile.x && s.y === tile.y)']),
  s('accion.beber', 'accion', 'teselas', 'actor', 0, 'inventions.ts', 'takeWater', ['const tile = tileAt(world, person); if (!tile) return 0;']),
  s('accion.disputaFuente', 'accion', 'teselas', 'actor', 4096, 'society.ts', 'resourceDispute', ['const source = tileAt(world, person.target);'], { nota: 'Destino propio; ver `accion.destino`.' }),
  s('accion.disputa', 'accion', 'personas', 'actor', { param: 'social.disputaRadio' }, 'society.ts', 'resourceDispute', ["const other = primerVecino(world, person, disputaRadio + 1, p => p !== person && !!p.communityId && p.action === person.action && distance(person, p) <= disputaRadio && distance(person.target, p.target) < disputaDestino"]),
  s('accion.cazar', 'accion', 'animales', 'actor', 0, 'animals.ts', 'harvestAt', ['world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0)', '!world.tiles.some(t => t.x === point.x && t.y === point.y)']),
  ...(['fillContainedWater', 'beginWaterPreparation'] as const).map(funcion =>
    s(`accion.${funcion}`, 'accion', 'teselas', 'actor', 0, 'technology-water.ts', funcion, ['firstTileAt(host.tiles, actor.x, actor.y)'])),
  s('accion.entregaObjeto', 'accion', 'personas', 'actor', 2, 'technology.ts', 'transferTechnologyItem', ['distance(from, to) > 2']),
  // Gestos: el actor es el punto del gesto.
  s('gesto.testigos', 'gestos', 'personas', 'actor', 7, 'index.ts', 'applyGesture', ['!world.people.some(p => distance(p, gesture) <= RADIUS)']),
  s('gesto.avisados', 'gestos', 'personas', 'actor', 7, 'index.ts', 'applyGesture', ['for (const person of world.people) if (distance(person, gesture) <= RADIUS)'], { veces: 2 }),
  s('gesto.tesela', 'gestos', 'teselas', 'actor', 0, 'index.ts', 'applyGesture', ['const tile = tileAt(world, gesture)!;']),
  // Estructuras (cada 10 pasos): el actor es la estructura.
  s('estructuras.tesela', 'estructuras', 'teselas', 'actor', 0, 'inventions.ts', 'stepStructures', ['const tile = tileAt(world, structure); if (!tile']),
  s('estructuras.riego', 'estructuras', 'teselas', 'actor', 1, 'inventions.ts', 'stepStructures', ['tileAt(world, { x: structure.x + dx!, y: structure.y + dy! })']),
  s('estructuras.deposito', 'estructuras', 'personas', 'actor', 1.5, 'inventions.ts', 'stepStructures', ['if (a.foodCapacity > 0) for (const person of vecinos(world, structure, 2.5,',
    'person => !(distance(person, structure) > 1.5 || person.hunger >= 0.5 || person.inventory <= 0.12))) {']),
  // Encuentros, demografía, comunidades y reproducción.
  s('encuentro.lugar', 'encuentros', 'lugares', 'actor', 3, 'index.ts', 'encounters', ['primeroCerca(world.places, s, 4, p => distance(s, p) <= 3)']),
  s('convivencia', 'encuentros', 'personas', 'actor', 2, 'society.ts', 'convivir', ['distance(a, b) > RADIO_CONVIVENCIA']),
  s('herencia', 'demografia', 'personas', 'actor', 2, 'index.ts', 'transferEstate', ["const recipients=vecinos(world,person,3,other=>other!==person&&other.demography.deathCause===null&&distance(person,other)<=2,'transferEstate')"]),
  s('herencia.tecnologica', 'demografia', 'personas', 'actor', 2, 'technology.ts', 'settleTechnologyEstate', ['isHostMember(host.people, p) && distance(actor, p) <= 2']),
  s('muerte.tesela', 'demografia', 'teselas', 'actor', 0, 'lineage.ts', 'advancePopulation', ['const tile = tileAt(world, person);']),
  s('muerte.techo', 'demografia', 'estructuras', 'actor', 0, 'lineage.ts', 'advancePopulation', ['if (structuresByCell) for (const structure of world.structures) {',
    "if (!(structure.condition > BROKEN_CONDITION && structure.components.includes('roof'))) continue;",
    "const shelter = world.shelterBenefitEnabled && tile?.terrain === 'shelter' ? Math.max(0,",
    '...(structuresByCell!.get(`${person.x},${person.y}`) ?? []).map(structure => structure.condition)) : 0;'],
    { nota: 'T140: la condición de techo por celda se agrupa una sola vez para toda la población (`structuresByCell`), en vez de filtrar `world.structures` por cada persona; sigue siendo exacta a distancia 0.' }),
  s('comunidad.alternativas', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'updateCommunities', ["const alternatives = vecinos(world, person, 7, p => p !== person && p.communityId !== group.id && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.3 && culturalDistance(person.culture, p.culture) < distanciaAlternativa, 'updateCommunities:alternatives');"]),
  s('comunidad.vecinos', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'updateCommunities', ["const nearby = vecinos(world, person, 7, p => p !== person && distance(person, p) <= 6 && (person.bonds[p.id] ?? 0) >= 0.25 && culturalDistance(person.culture, p.culture) < 0.3, 'updateCommunities:foundation');"]),
  s('comunidad.fundacion', 'comunidades', 'lugares', 'actor', 7, 'society.ts', 'updateCommunities', ['algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)']),
  s('convivencia.vecinos', 'comunidades', 'personas', 'actor', 6, 'society.ts', 'reviseByCohabitation', ["const core = vecinos(world, person, 7, p => memberSet.has(p) && trustedNeighbor(person, p), 'updateCommunities:cohabitation');",
    "const nearby = vecinos(world, person, 7, p => trustedNeighbor(person, p), 'updateCommunities:cohabitation');"],
    { nota: '`trustedNeighbor`: ≤ 6 celdas. Dos llamadas con la misma etiqueta: la fisión (sobre `members`, filtrado aparte) y la revisión de todo el mundo.' }),
  s('convivencia.fision', 'comunidades', 'lugares', 'actor', 7, 'society.ts', 'reviseByCohabitation', ['algunoCerca(world.places, person, 8, place => distance(person, place) <= 7)']),
  s('reproduccion.lugar', 'reproduccion', 'lugares', 'actor', { param: 'poblacion.radioLugar' }, 'index.ts', 'reproduce', ['primeroCerca(world.places, a, pop.radioLugar + 1, p => distance(a, p) <= pop.radioLugar)']),
  s('reproduccion.pareja', 'reproduccion', 'personas', 'actor', { param: 'poblacion.radioPareja' }, 'index.ts', 'reproduce',
    ["const b = chooseReproductivePartner(world, a, vecinos(world, a, pop.radioPareja + 1, p => match(a, p), 'reproduce'), ELECCION_POR_AFINIDAD);", 'distance(a, b) <= pop.radioPareja'],
    { nota: 'Pareja (≤ radioPareja) y lugar (≤ radioLugar) se miden los dos desde `a`: no se componen.' }),
];

/** Lecturas que no dependen de dónde está nadie: colecciones acotadas que cada región recibe enteras y
 * de solo lectura, y agregados o selecciones que el coordinador calcula una vez. */
export const LECTURAS_GLOBALES: readonly LecturaGlobal[] = [
  { id: 'lugares.porId', fase: 'decision', fuente: 'world.places', cota: 2048, fichero: 'index.ts', funcion: 'choose',
    patrones: ['world.places.find(p => p.id === habit.placeId)', 'world.places.find(p => p.id === memory.placeId)'],
    motivo: 'Lugares de hábitos y recuerdos por id, dondequiera que estén. `world.places` (≤ 2 048, `assertCommon`) se replica íntegro: ninguna lectura de lugares necesita el halo.' },
  { id: 'lugares.gesto', fase: 'gestos', fuente: 'world.places', cota: 2048, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ['world.places.find(p => p.id === memory?.placeId)'], motivo: 'Lugar del recuerdo pedido; luego exige que esté a ≤ 4 del gesto.' },
  { id: 'lugares.activacion', fase: 'activacion', fuente: 'world.places', cota: 2048, fichero: 'spatial.ts', funcion: 'activateChunk',
    patrones: ['if (!world.places.some(p => p.id === place.id)) world.places.push(place);'], motivo: 'Evita duplicar un lugar al reanimar su chunk. T113 separó el cuerpo de `activate` (el `export`, sin cambios) a `activateChunk`.' },
  { id: 'invitaciones', fase: 'decision', fuente: 'world.invitations', cota: 8, fichero: 'index.ts', funcion: 'choose',
    patrones: ['for (const invitation of world.invitations) {', 'if (distance(person, invitation) <= RADIUS && person.hunger < 0.65 && person.fatigue < 0.7 && person.socialLoad < 0.7)'], motivo: 'Todas las invitaciones vigentes; luego exige ≤ 7 celdas.' },
  { id: 'recordatorios', fase: 'decision', fuente: 'world.reminders', cota: 8, fichero: 'index.ts', funcion: 'choose',
    patrones: ['world.reminders.some(reminder => reminder.memoryId === memory.id)'], motivo: 'Recordatorio activo de un recuerdo.' },
  { id: 'recuerdos.gesto', fase: 'gestos', fuente: 'world.memories', cota: 10, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ["world.memories.find(m => m.id === gesture.memoryId)"], motivo: 'Recuerdo que pide el gesto, por id.' },
  ...(['invitations', 'reminders'] as const).map(lista => ({ id: `${lista}.tope`, fase: 'gestos' as const, fuente: `world.${lista}`, cota: 8, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: [`world.${lista} = world.${lista}.slice(-8);`], motivo: 'Conserva las ocho más recientes.' })),
  { id: 'recordatorios.gesto', fase: 'gestos', fuente: 'world.reminders', cota: 8, fichero: 'index.ts', funcion: 'applyGesture',
    patrones: ['world.reminders = world.reminders.filter(r => r.memoryId !== memory.id);'], motivo: 'Reemplaza el recordatorio del mismo recuerdo.' },
  { id: 'recuerdos', fase: 'decision', fuente: 'world.memories', cota: 10, fichero: 'index.ts', funcion: 'choose',
    patrones: ['for (const memory of world.memories) {', "if (person.role === 'neighbor' || !memory.roles.includes(person.role)) continue;"], motivo: 'Recuerdos de S e I; el lugar se busca por id y se exige ≤ 4.' },
  { id: 'planos', fase: 'decision', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'selectedBlueprint',
    patrones: ['world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components))', "world.blueprints.find(b => b.id === 'blueprint-base')"], motivo: 'Coste de obra de cualquiera (también del otro en `evaluateCooperation`).' },
  { id: 'planos.conocidos', fase: 'decision', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'knownBlueprints',
    patrones: ['return world.blueprints.filter(b => (ids.has(b.id) || b.inventorId === person.id) && validBlueprint(b.components))'], motivo: 'Planos de los ids que conoce (propio, estructuras a ≤ 5 y contactos a ≤ 3).' },
  { id: 'planos.catalogo', fase: 'decision', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'inventionCandidates',
    patrones: ['world.blueprints.map(b => blueprintSignature(b.components))', 'world.blueprints.map(b => genotypeDistance(child.components, b.components))'],
    motivo: 'Novedad de un diseño frente a todos los planos del mundo.' },
  ...([['constructionOpportunity', 'decision', 'if (world.structures.length >= MAX_STRUCTURES) return;'],
    ['completeConstruction', 'accion', 'world.structures.length >= MAX_STRUCTURES']] as const).map(([funcion, fase, patron]) => ({
    id: `estructuras.tope.${funcion}`, fase, fuente: 'world.structures.length', cota: 'MAX_STRUCTURES = 512', fichero: 'inventions.ts', funcion,
    patrones: [patron], motivo: 'Cuántas estructuras activas hay en todo el mundo: un recuento global.' })),
  { id: 'comunidades.tope', fase: 'comunidades', fuente: 'world.communities.length', cota: '`social.maxComunidades` (8)', fichero: 'society.ts', funcion: 'updateCommunities',
    patrones: ['world.communities.length >= paramsOf(world).social.maxComunidades'], motivo: 'Cuántas comunidades hay en todo el mundo: tope de fundación.' },
  { id: 'planos.uso', fase: 'accion', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'observeUse',
    patrones: ['world.blueprints.find(b => b.id === structure.blueprintId)'], motivo: 'Plano de la estructura usada, por id.' },
  { id: 'planos.padres', fase: 'accion', fuente: 'world.blueprints', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'invent',
    patrones: ['candidate.parents.map(id => world.blueprints.find(b => b.id === id))'], motivo: 'Planos padres del diseño, por id.' },
  { id: 'planos.identidad', fase: 'accion', fuente: 'world.blueprints + world.structures', cota: 'O(planos + estructuras)', fichero: 'inventions.ts', funcion: 'blueprintIdentity',
    patrones: ["nextIdentity(world.blueprintCounter, 'blueprint', [...world.blueprints.map(b => b.id), ...world.blueprints.flatMap(b => b.parents),",
      '...world.structures.map(s => s.blueprintId)], world);'],
    motivo: 'Id nuevo de plano que no repita ninguno vivo; el archivo dormido lo aporta `techoDelArchivo` (T140, ver `archivo.techo`).' },
  { id: 'estructuras.identidad', fase: 'accion', fuente: 'world.structures', cota: 'O(estructuras)', fichero: 'inventions.ts', funcion: 'completeConstruction',
    patrones: ["const identity = nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world);"],
    motivo: 'Id nueva de estructura que no repita ninguna viva; el archivo dormido lo aporta `techoDelArchivo` (T140, ver `archivo.techo`).' },
  { id: 'archivo.techo', fase: 'accion', fuente: 'world.retiredChunks', cota: 'O(chunks retirados), cacheado por world.tick (T140)', fichero: 'inventions.ts', funcion: 'nextIdentity',
    patrones: ['const archive = techoDelArchivo(world.retiredChunks, world.tick);'],
    motivo: 'Techo de ids de blueprint/structure del archivo dormido, compartido por `blueprintIdentity` y `completeConstruction` (`indices.ts`, primitiva).' },
  { id: 'planos.tope', fase: 'decision', fuente: 'world.blueprints.length', cota: 'MAX_BLUEPRINTS = 64', fichero: 'inventions.ts', funcion: 'inventionOpportunity',
    patrones: ['world.blueprints.length >= MAX_BLUEPRINTS'], motivo: 'Tope global de planos.' },
  { id: 'recetas.rareza', fase: 'decision', fuente: 'world.people', cota: 'O(P)', fichero: 'society.ts', funcion: 'recipeHolders',
    patrones: ['for (const person of world.people) for (const id of person.technology.knownRecipes) {'],
    motivo: 'Sólo con `social.ensenanzaRareza` > 0 (default 0): cuenta quién recuerda cada receta en toda la población. Agregado entero: lo calcularía el coordinador.' },
  { id: 'recetas.vivos', fase: 'decision', fuente: 'world.people.length', cota: 'O(1)', fichero: 'society.ts', funcion: 'practicedRecipeToTeach',
    patrones: ['const alive = Math.max(1, world.people.length);'], motivo: 'Población viva total: denominador de la rareza (sólo cuenta con `social.ensenanzaRareza` > 0).' },
  { id: 'fauna.ventana', fase: 'fauna', fuente: 'world.animals', cota: 'MAX_ACTIVE_ANIMALS = 8 192', fichero: 'animals.ts', funcion: 'calcularMascara',
    patrones: ['const offset = population ? ((world.tick % population) * MAX_ACTIVE_ANIMALS) % population : 0;',
      'const tramo = animals.slice(offset, offset + MAX_ACTIVE_ANIMALS), vuelta = animals.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population));'],
    motivo: 'Con más de 8 192 animales, sólo vive este paso una ventana rotatoria del orden canónico de TODA la fauna activa: qué animales entran depende de cuántos hay en todo el mundo. Selección global: la calcula el coordinador (T116, `mascaraFauna`), no ya `stepAnimals` directamente.' },
  { id: 'fauna.turno', fase: 'fauna', fuente: 'world.animals', cota: 'MAX_ANIMAL_DECISIONS_PER_TICK = 1 024', fichero: 'animals.ts', funcion: 'stepAnimals',
    patrones: ['const due = active.filter(a => world.tick - a.lastDecision >= 8)', '.sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);'],
    motivo: 'Deciden los 1 024 más atrasados de toda la ventana: con más atrasados, que un animal decida depende de la fauna de cualquier parte del mundo (latente hoy: ≤ 775 animales). Selección global: la hace el coordinador antes de repartir `choose`.' },
  { id: 'nacimientosRecientes', fase: 'reproduccion', fuente: 'world.people', cota: 'O(P)', fichero: 'index.ts', funcion: 'reproduce',
    patrones: ["world.people.filter(p => p.role === 'neighbor' && p.bornAt > world.tick - pop.intervaloComprobacionTicks).length"],
    motivo: 'Cupo de nacimientos de la ventana (`poblacion.comprobacionContinua`).' },
  { id: 'muestreo', fase: 'muestreo', fuente: 'world.people', cota: 'O(P)', fichero: 'statistics.ts', funcion: 'sample',
    patrones: ['const n = Math.max(1, world.people.length)', 'world.people.reduce((sum, p) => sum + p[key], 0) / n'], motivo: 'Medias de la población cada 60 pasos: suma FP64 en orden de `world.people`, fase serial (regla 13).' },
  { id: 'capacidadFauna', fase: 'faunaSerial', fuente: 'world.tiles', cota: 'O(teselas activas)', fichero: 'animals.ts', funcion: 'reproduce',
    patrones: ['capacity ??= faunaCapacity(world.tiles);'],
    motivo: 'Capacidad natural de cría: recuento entero sobre TODAS las teselas activas, extraído a `faunaCapacity` (E.0) sin cambiar el cálculo.' },
  { id: 'kernel.indice', fase: 'ecologia', fuente: 'world.tiles', cota: 'O(teselas activas)', fichero: 'ecosystem-kernel.ts', funcion: 'buildTopology', veces: 2,
    patrones: ['for (let i = 0; i < length; i++) {', 'const tile = tiles[i];'],
    motivo: 'Índice de posiciones de TODAS las teselas activas para hallar los 8 vecinos; T112 lo sustituye por aritmética sobre la región.' },
  { id: 'kernel.recuento', fase: 'ecologia', fuente: 'world.tiles.length', cota: 'O(1)', fichero: 'ecosystem-kernel.ts', funcion: 'buildTopology',
    patrones: ['const length = tiles.length;'], motivo: 'Tamaño del índice.' },
  { id: 'kernel.cache', fase: 'ecologia', fuente: 'world.tiles', cota: 'O(teselas activas)', fichero: 'ecosystem-kernel.ts', funcion: 'sameCoordinates',
    patrones: ['if (topology.coordinates.length !== tiles.length * 2) return false;', 'for (let i = 0; i < tiles.length; i++) {', 'tiles[i].x)', 'tiles[i].y)'],
    motivo: 'Validación de la caché de topologías contra las coordenadas de todas las teselas (T112 la cambia por una versión entera).' },
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
  { id: 'comunidad.snapshot', fase: 'comunidades', fuente: 'world.people', fichero: 'society.ts', funcion: 'updateCommunities', veces: 2,
    patrones: ['porComunidad(world.people)'],
    motivo: 'T140/T141: dos fotos de pertenencia por comunidad (antes y después de salidas, fisiones y convivencia de este paso), en vez de filtrar `world.people` por cada grupo.' },
  { id: 'comunidad.pertenencia', fase: 'comunidades', fuente: 'world.people + world.communities', fichero: 'society.ts', funcion: 'updateCommunities',
    patrones: ['world.communities.find(c => c.id === person.communityId);', 'world.communities.find(c => c.id === joined)'],
    motivo: 'Confianza media con TODOS los miembros de la comunidad, dondequiera que estén (la foto de miembros sale de `comunidad.snapshot`).' },
  { id: 'convivencia.miembros', fase: 'comunidades', fuente: 'world.communities', fichero: 'society.ts', funcion: 'reviseByCohabitation',
    patrones: ['world.communities.find(c => c.id === person.communityId), to = world.communities.find(c => c.id === best.id)'],
    motivo: 'Centroide de todos los miembros (de la foto `iniciales`, recibida de `updateCommunities`); `social.radioConvivencia` se compara con él, no acota ninguna lectura.' },
  { id: 'comida.observada', fase: 'accion', fuente: 'world.people', fichero: 'inventions.ts', funcion: 'takeFood',
    patrones: ["esMiembro(world.people, member, world.tick) && member.action === 'eat' && member.hunger > 0"], motivo: 'Pertenencia de quien come (T140, `esMiembro` cacheada por `world.tick`).' },
  ...(['takeWater', 'recordFacilityRest'] as const).map(funcion => ({ id: `pertenencia.${funcion}`, fase: 'accion' as const, fuente: 'world.people',
    fichero: 'inventions.ts', funcion, patrones: ['!esMiembro(world.people, person, world.tick)'], motivo: 'Pertenencia de quien actúa (T140, `esMiembro`).' })),
  { id: 'pertenencia.estructura', fase: 'accion', fuente: 'world.structures', fichero: 'inventions.ts', funcion: 'repair',
    patrones: ['!world.structures.includes(structure)'], motivo: 'La estructura sigue activa.' },
  ...(['canHandle', 'payContainedWaterCarry', 'beginWaterPreparation'] as const).map(funcion => ({ id: `pertenencia.${funcion}`, fase: 'accion' as const,
    fuente: 'host.people', fichero: 'technology-water.ts', funcion, patrones: ['isHostMember(host.people, actor)'], motivo: 'Pertenencia de quien actúa (Set cacheado por longitud del arreglo).' })),
  { id: 'pertenencia.transferTechnologyItem', fase: 'accion', fuente: 'host.people', fichero: 'technology.ts', funcion: 'transferTechnologyItem',
    patrones: ['!isHostMember(host.people, from) || !isHostMember(host.people, to)'], motivo: 'Pertenencia de las dos partes (Set cacheado por longitud del arreglo).' },
  { id: 'fauna.presa', fase: 'faunaSerial', fuente: 'world.animals', fichero: 'animals.ts', funcion: 'stepAnimals',
    patrones: ['const byId = new Map(world.animals.map(a => [a.id, a]));', 'const prey = byId.get(animal.preyId);'], motivo: 'Presa elegida (a ≤ 6) leída por id dondequiera que esté; sólo se la hiere a distancia 0.' },
  { id: 'muerte.identidad', fase: 'demografia', fuente: 'world.people + legado', fichero: 'lineage.ts', funcion: 'advancePopulation',
    patrones: ['const archived = new Set([...world.legacy, ...world.retiredLegacy].map(record => record.id));', 'world.people.some(person => archived.has(person.id))'], motivo: 'Ninguna identidad archivada reaparece.' },
  { id: 'muerte.legado', fase: 'demografia', fuente: 'world.legacy', fichero: 'index.ts', funcion: 'deathContext',
    patrones: ['world.legacy.find(entry => entry.id === actorId)'], motivo: 'Registro de quien acaba de morir, para narrar su muerte.' },
  { id: 'activacion.chunk', fase: 'activacion', fuente: 'world.chunks + world.retiredChunks', fichero: 'spatial.ts', funcion: 'activateChunk',
    patrones: ['if (world.chunks[key]) return;', 'const pending = pendingIndex(world.retiredChunks, key);', 'world.chunks[key] = meta;'],
    motivo: 'Chunk por clave: ya activo, retirado (T113: `pendingIndex`, indexado por clave en vez de `findIndex`) o nuevo. `activate` (el `export`) sólo delega en `activateChunk`.' },
  { id: 'rejilla.indice', fase: 'decision', fuente: 'world.people', fichero: 'rejilla.ts', funcion: 'sincronizar',
    patrones: ['const person = world.people[slot];'],
    motivo: 'T141: construye/extiende por slot la rejilla efímera de personas detrás de las primitivas `vecinos`/`primerVecino`; el resto de sus comparaciones son de índice, sin leer más personas.' },
  { id: 'compartir.lugarArchivado', fase: 'accion', fuente: 'world.chunks', fichero: 'index.ts', funcion: 'share',
    patrones: ['world.chunks[chunkKey(place.x, place.y)]?.places.find(p => p.id === place.id)'], motivo: 'Copia del lugar (a ≤ 3) en su chunk, por clave e id.' },
  { id: 'linaje.referencias', fase: 'demografia', fuente: 'world.people', fichero: 'lineage.ts', funcion: 'referencedLegacy',
    patrones: ['for (const person of world.people) for (const parent of person.genome.parents)', 'for (const person of world.people) required.delete(person.id);',
      'for (const blueprint of world.blueprints) if (blueprint.inventorId !== null)'],
    motivo: 'Legado que alguien vivo cita como progenitor (`retainLegacy`).' },
];

/** Recorridos de fase y compactaciones: el bucle que decide QUIÉN actúa, no una lectura alrededor de
 * nadie. Su orden es parte de la regla (orden de `world.people`, orden canónico de la fauna). */
export const RECORRIDOS: readonly Recorrido[] = [
  { id: 'paso.acciones', fase: 'accion', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) bodyAndAction(world, person);'],
    motivo: 'Cadena secuencial: cada persona decide y actúa viendo lo que las anteriores ya hicieron en este paso.' },
  { id: 'paso.descubrimiento', fase: 'accion', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) {', 'const chunk = world.chunks[chunkKey(person.x, person.y)]!;'], motivo: 'Chunk bajo cada persona.' },
  { id: 'paso.caducidad', fase: 'gestos', fichero: 'index.ts', funcion: 'advanceTick',
    patrones: ['world.invitations = world.invitations.filter(', 'world.reminders = world.reminders.filter('], motivo: 'Listas globales acotadas a 8.' },
  { id: 'paso.checkpoint', fase: 'checkpoint', fichero: 'index.ts', funcion: 'advanceTick', patrones: ['for (const person of world.people) maintainTechnologyMemory(world, person);'], motivo: 'Memoria tecnológica.' },
  { id: 'ecologia', fase: 'ecologia', fichero: 'index.ts', funcion: 'ecology', patrones: ['for (const tile of world.tiles) {', "if (tile.terrain === 'water') continue;", 'const tileIn = tileLookup(world.tiles);'], motivo: 'Autómata por tesela (T120).' },
  { id: 'kernel', fase: 'ecologia', fichero: 'ecosystem-kernel.ts', funcion: 'EcosystemKernel', patrones: ['for (let i = 0; i < length; i++) {'], motivo: 'Una vuelta por tesela activa.' },
  { id: 'fauna', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'stepAnimals',
    patrones: ['for (const animal of world.animals) {', 'tileLookup(world.tiles)', 'syncFauna(world.tiles, world.animals);'], motivo: 'Ocupación de la fauna y recuento por celda al final.' },
  { id: 'fauna.orden.inicio', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'calcularMascara', patrones: ['ordenCanonico(world.animals);'],
    motivo: 'T116: el orden canónico al empezar el paso lo deja `ordenCanonico` (certificado + mezcla), el mismo resultado que `world.animals.sort(canonical)`, calculado dentro de `mascaraFauna`/`calcularMascara`, no ya en `stepAnimals`.' },
  { id: 'fauna.orden.cierre', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'stepAnimals', patrones: ['ordenCanonico(world.animals, previos);'],
    motivo: 'Orden canónico al acabar el paso (tras la reproducción), con `ordenCanonico` en vez de `sort`.' },
  { id: 'fauna.compactacion', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'stepAnimals', veces: 2,
    patrones: ['world.animals = world.animals.filter(a => a.health > 0);'], motivo: 'Compactación tras la fisiología y tras la depredación.' },
  { id: 'fauna.caza', fase: 'accion', fichero: 'animals.ts', funcion: 'harvestAt', patrones: ['world.animals = world.animals.filter(a => a.id !== victim.id);', 'syncFauna(world.tiles, world.animals)'],
    motivo: 'Tras cada caza humana, `syncFauna` vuelve a contar la fauna por celda en el mundo activo.' },
  { id: 'fauna.recuento', fase: 'faunaSerial', fichero: 'animals.ts', funcion: 'syncFauna', patrones: ['const tileIn = tileLookup(tiles);'],
    motivo: 'Escribe `fauna` y `species` en las celdas ocupadas antes o ahora; al final de `stepAnimals` y tras cada caza.' },
  { id: 'reproduccion', fase: 'reproduccion', fichero: 'index.ts', funcion: 'reproduce', patrones: ['for (const a of world.people) {'], motivo: 'Emparejamiento en cadena (`used`).' },
  { id: 'estructuras', fase: 'estructuras', fichero: 'inventions.ts', funcion: 'stepStructures',
    patrones: ['for (const structure of world.structures) {', 'if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {'],
    motivo: 'Cada estructura; y cada 60 pasos cada persona revisa su plano (`inventionContext` ≤ 4, `knownBlueprints` ≤ 5).' },
  { id: 'comunidades', fase: 'comunidades', fichero: 'society.ts', funcion: 'updateCommunities',
    patrones: ['for (const group of world.communities) {', 'world.communities = world.communities.filter('], motivo: 'Revisión cada 120 pasos.' },
  { id: 'comunidades.personas', fase: 'comunidades', fichero: 'society.ts', funcion: 'updateCommunities', veces: 2,
    patrones: ['for (const person of world.people) {'], motivo: 'Pertenencia y fundación: dos vueltas por persona.' },
  { id: 'convivencia.revision', fase: 'comunidades', fichero: 'society.ts', funcion: 'reviseByCohabitation', patrones: ['for (const person of world.people) {'], motivo: 'Mayoría de vecinos de confianza.' },
  { id: 'demografia', fase: 'demografia', fichero: 'lineage.ts', funcion: 'advancePopulation',
    patrones: ['const transitions = world.people.map(person => {', 'world.people = world.people.filter(', 'pruneBonds(world.people, dying.map(result => result.person));',
      'const alive = new Set(world.people.map(person => person.id));', 'for (const community of world.communities)', 'const communities = new Set(world.communities.map(community => community.id));',
      'world.communities = world.communities.filter(', 'for (const person of world.people) if (person.communityId !== null'],
    motivo: 'Bajas y limpieza de vínculos (T142: `pruneBonds` sustituye el doble bucle sobre `departed`, mismo resultado) y comunidades.' },
  { id: 'activacion.retiro', fase: 'activacion', fichero: 'spatial.ts', funcion: 'maintainRegions',
    patrones: ['const meta = world.chunks[key]!;', 'for (const tile of world.tiles) {', 'for (const place of world.places) detached', 'delete world.chunks[key];', 'world.animals = world.animals.filter(', 'world.structures = world.structures.filter(', 'world.places = world.places.filter('],
    motivo: 'Retira los chunks que nadie necesita.' },
];

/** El área que el paso ESCRIBE alrededor de cada persona: materializa teselas, fauna, estructuras y lugares. */
export const ESCRITURAS: readonly Escritura[] = [
  { id: 'activacion', fase: 'activacion', radio: 23, fichero: 'spatial.ts', funcion: 'maintainRegions',
    patrones: ['for (const person of world.people) {', 'for (const dx of REACH) for (const dy of REACH) {'],
    motivo: 'Activa el chunk (16 × 16) que contiene (x ± 8, y ± 8): hasta 8 + 15 celdas por eje. Corre antes de toda fase repartida y en el coordinador.' },
  { id: 'obra.lugar', fase: 'accion', radio: 0, fichero: 'inventions.ts', funcion: 'completeConstruction',
    patrones: ['world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);'], motivo: 'La obra terminada funda un lugar en su tesela y en su chunk.' },
];

/** Código de `src/world` que no forma parte del paso: validación, proyección a la vista, creación y migración. */
export const FUERA_DEL_PASO: readonly Declaracion[] = [
  ...['createWorld', 'migrateWorldState', 'upgradeV3', 'upgradeV5'].map(funcion => ({ fichero: 'index.ts', funcion, motivo: 'Creación o migración de un mundo.' })),
  ...['projectWorld', 'personDetail'].map(funcion => ({ fichero: 'index.ts', funcion, motivo: 'Proyección a la vista.' })),
  { fichero: 'index.ts', funcion: 'assertCommon', motivo: 'Validación.' },
  { fichero: 'index.ts', funcion: 'upgradeV4', motivo: 'Migración de un mundo.' },
  ...['cloneWorld', 'puntoDeRestauracion'].map(funcion => ({ fichero: 'index.ts', funcion, motivo: 'Copia o restauración del mundo entero por el servidor: no es una ley.' })),
  { fichero: 'technology.ts', funcion: 'projectTechnology', motivo: 'Proyección a la vista: sólo la llama `projectWorld`.' },
  { fichero: 'spatial.ts', funcion: 'projectTerrain', motivo: 'Proyección a la vista (cámara).' },
  { fichero: 'statistics.ts', funcion: 'computeWorldStatistics', motivo: 'Proyección: sólo la llama `worldStatistics`, desde `projectWorld`.' },
  { fichero: 'lineage.ts', funcion: 'assertPopulation', motivo: 'Validación.' },
  { fichero: 'validation.ts', funcion: 'assertLifeState', motivo: 'Validación.' },
  { fichero: 'technology.ts', funcion: 'assertTechnology', motivo: 'Validación.' },
  { fichero: 'technology-water.ts', funcion: 'assertTechnologyWater', motivo: 'Validación.' },
  { fichero: 'technology.ts', funcion: 'isHostMember', motivo: 'Segunda declaración del mismo nombre (ver PRIMITIVAS): sin lectura propia del mundo (parámetro genérico `people`, no `world.people`).' },
];

/** Campos de `world`/`host` que no son colecciones y que leen las funciones de las fases con halo: iguales para
 * todas las regiones durante la fase (reloj, semilla, tiempo, banderas) o estado global de solo lectura que se
 * replica. La prueba falla si una de esas funciones lee otro campo. */
export const ESTADO_GLOBAL: Readonly<Record<string, string>> = {
  tick: 'Reloj del paso.', seed: 'Semilla del mundo.', weather: 'Tiempo del paso (lo cambia la ecología, en el coordinador).',
  cooperationEnabled: 'Bandera.', learningEnabled: 'Bandera.', noveltyEnabled: 'Bandera.', reproductionEnabled: 'Bandera.', shelterBenefitEnabled: 'Bandera.',
  technology: 'Catálogo de recetas y archivo tecnológico: global. Lo leen la tecnología y la cooperación; resolver recetas toca el LRU residente (`withRecipeSession`), una escritura global que el halo no resuelve.',
};

/** Constantes de módulo que acotan distancias: la prueba lee su valor del fuente. */
export const CONSTANTES_DE_RADIO: Readonly<Record<string, { fichero: string; valor: number }>> = {
  RADIUS: { fichero: 'index.ts', valor: 7 }, CONSTRUCTION_RADIUS: { fichero: 'inventions.ts', valor: 7 }, RADIO_CONVIVENCIA: { fichero: 'society.ts', valor: 2 },
};
/** Umbrales de `distance(…)` que no acotan una lectura del mundo: el número mayor que el halo o el nombre
 * que no es una constante de radio, tal como aparece al otro lado de la comparación. */
export const UMBRALES_QUE_NO_SON_LECTURAS: readonly { fichero: string; funcion: string; umbral: string; motivo: string }[] = [
  { fichero: 'index.ts', funcion: 'applyGesture', umbral: '4096', motivo: 'Rechaza una orden cuyo destino está a más de 4 096 celdas; no lee nada allí.' },
  { fichero: 'index.ts', funcion: 'choose', umbral: 'away', motivo: 'Compara las distancias a dos personas vinculadas ya leídas (`away < distance(person, cortejado)`) para elegir la más cercana.' },
  { fichero: 'family.ts', funcion: 'earlierForagerExhausts', umbral: 'physical.radius', motivo: 'Recorre personas ya percibidas (`choose` le pasa las de ≤ `RADIUS`) y `radius: RADIUS`: no lee el mundo.' },
  { fichero: 'index.ts', funcion: 'choose', umbral: 'disputaDestino', motivo: 'Conflicto legible (`social.memoriaDisputa`): compara una celda que ya percibe (`reachableTiles`) con la fuente disputada que recuerda (`person.conflictMemory`); dos puntos ya leídos, no lee nada en el mundo.' },
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

export interface Inventario { readonly raices: readonly Raiz[]; readonly alcances: readonly Alcance[]; readonly llamadas: readonly Llamada[] }
export const INVENTARIO: Inventario = { raices: RAICES, alcances: ALCANCES, llamadas: LLAMADAS };
const clave = (fichero: string, funcion: string) => `${fichero}:${funcion}`;

/** Funciones que alcanza una fase por las `LLAMADAS` del inventario, desde sus raíces. */
export function funcionesDeFase(fase: Fase, inv: Inventario = INVENTARIO): Set<string> {
  const vistas = new Set(inv.raices.filter(r => r.fase === fase).map(r => clave(r.fichero, r.funcion))), cola = [...vistas];
  while (cola.length) {
    const actual = cola.pop()!;
    for (const l of inv.llamadas) if (clave(l.fichero, l.funcion) === actual && !vistas.has(l.llama)) { vistas.add(l.llama); cola.push(l.llama); }
  }
  return vistas;
}

/** Alcance compuesto de cada lectura de una fase con halo: su radio más el de su centro; `entrada` vale el
 * peor centro de las llamadas a su función desde la fase (0 en la raíz). `undefined` si algún eslabón
 * depende de parámetros no dados. */
export function alcancesDeFase(fase: Fase, params?: ParamsDeRadio, inv: Inventario = INVENTARIO): Map<string, number | undefined> {
  const funciones = funcionesDeFase(fase, inv), raices = new Set(inv.raices.filter(r => r.fase === fase).map(r => clave(r.fichero, r.funcion)));
  const porId = new Map(inv.alcances.map(e => [e.id, e])), memo = new Map<string, number | undefined>(), enCurso = new Set<string>();
  const guardar = (k: string, calcular: () => number | undefined): number | undefined => {
    if (memo.has(k)) return memo.get(k);
    if (enCurso.has(k)) throw new Error(`Ciclo en el inventario de alcances: ${k}`);
    enCurso.add(k); const valor = calcular(); enCurso.delete(k); memo.set(k, valor); return valor;
  };
  const suma = (x: number | undefined, y: number | undefined) => x === undefined || y === undefined ? undefined : x + y;
  const base = (centro: string, funcion: string): number | undefined => centro === 'entrada' ? entrada(funcion) : lectura(centro);
  function entrada(funcion: string): number | undefined {
    return guardar(`entrada:${funcion}`, () => {
      if (raices.has(funcion)) return 0;
      let peor: number | undefined = -Infinity;
      for (const l of inv.llamadas) {
        if (l.llama !== funcion || !funciones.has(clave(l.fichero, l.funcion))) continue;
        const v = base(l.centro, clave(l.fichero, l.funcion));
        peor = v === undefined || peor === undefined ? undefined : Math.max(peor, v);
      }
      if (peor === -Infinity) throw new Error(`Nadie llama a ${funcion} en la fase ${fase}`);
      return peor;
    });
  }
  function lectura(id: string): number | undefined {
    return guardar(id, () => {
      const e = porId.get(id);
      if (!e) throw new Error(`Centro desconocido en el inventario de alcances: ${id}`);
      if (!funciones.has(clave(e.fichero, e.funcion))) throw new Error(`${id} no está en la fase ${fase}`);
      return suma(base(e.centro, clave(e.fichero, e.funcion)), valorRadio(e.radio, params));
    });
  }
  const res = new Map<string, number | undefined>();
  for (const e of inv.alcances) if (funciones.has(clave(e.fichero, e.funcion))) res.set(e.id, lectura(e.id));
  return res;
}

/** Lecturas de las fases con halo, sin excepción, cuyo alcance compuesto supera `halo`. Sin `params`, las
 * que dependen de parámetros no se evalúan (las fija `haloRequerido`). */
export function excesos(inv: Inventario = INVENTARIO, halo = HALO_CELDAS, params?: ParamsDeRadio): { id: string; fase: Fase; alcance: number }[] {
  const res: { id: string; fase: Fase; alcance: number }[] = [];
  for (const fase of FASES_CON_HALO) for (const [id, alcance] of alcancesDeFase(fase, params, inv)) {
    if (alcance !== undefined && alcance > halo && !inv.alcances.find(e => e.id === id)!.excepcion) res.push({ id, fase, alcance });
  }
  return res;
}
/** Halo que exigen unos parámetros: el mayor alcance compuesto de las fases con halo (sin excepciones). */
export function haloRequerido(params: ParamsDeRadio, inv: Inventario = INVENTARIO): { celdas: number; causa: string } {
  let mejor = { celdas: 0, causa: '' };
  for (const fase of FASES_CON_HALO) for (const [id, alcance] of alcancesDeFase(fase, params, inv)) {
    if (!inv.alcances.find(e => e.id === id)!.excepcion && alcance! > mejor.celdas) mejor = { celdas: alcance!, causa: id };
  }
  return mejor;
}
/** Alcance compuesto de una lectura serial: su radio más el de su cadena de centros. */
export function alcanceSerial(id: string, inventario: readonly AlcanceSerial[] = ALCANCES_SERIALES, params?: ParamsDeRadio): number | undefined {
  const porId = new Map(inventario.map(e => [e.id, e])), vistos = new Set<string>();
  let total = 0;
  for (let actual = id; actual !== 'actor';) {
    const e = porId.get(actual);
    if (!e) throw new Error(`Centro desconocido en el inventario serial: ${actual}`);
    if (vistos.has(e.id)) throw new Error(`Ciclo en el inventario serial: ${e.id}`);
    vistos.add(e.id);
    const radio = valorRadio(e.radio, params);
    if (radio === undefined) return undefined;
    total += radio; actual = e.centro;
  }
  return total;
}
/** Celdas que una región de `lado` × `lado` lee de sus vecinas con un halo de `halo`, por celda propia. */
export const fraccionBorde = (lado: number, halo: number): number => ((lado + 2 * halo) ** 2 - lado ** 2) / lado ** 2;
