import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALCANCES as ALCANCES_BASE, ALCANCES_SERIALES as SERIALES_BASE, COLECCIONES_POR_NOMBRE, CONSTANTES_DE_RADIO as CONSTANTES_BASE, ESCRITURAS, ESTADO_GLOBAL as ESTADO_BASE, FASES_CON_HALO, FUERA_DEL_PASO as FUERA_BASE, HALO_CELDAS, INVENTARIO as INVENTARIO_BASE,
  LECTURAS_GLOBALES as GLOBALES_BASE, LECTURAS_POR_IDENTIDAD as IDENTIDAD_BASE, LLAMADAS as LLAMADAS_BASE, PRIMITIVAS, RAICES as RAICES_BASE, RECORRIDOS as RECORRIDOS_BASE, UMBRALES_QUE_NO_SON_LECTURAS,
  alcanceSerial, alcancesDeFase, excesos, fraccionBorde, funcionesDeFase, haloRequerido,
  type Alcance, type AlcanceSerial, type ClaveDeRadio, type Fase, type Inventario, type LecturaGlobal, type LecturaPorIdentidad, type Llamada, type Sitio,
} from '../src/world/halo.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, parseParams } from '../src/world/params.js';
import { CHUNK_SIZE } from '../src/world/terrain.js';

// Wave 2/A2 and V19/V20: pin the new expressions, radii and call graph here
// (halo.ts is outside this track's ownership). Literal expectations, never
// inferred from the source under test: every mutation must still break coverage.
function actualizarSitios<T extends Sitio & { readonly id: string }>(base: readonly T[], patrones: Readonly<Record<string, readonly string[]>>): T[] {
  for (const id of Object.keys(patrones)) assert.ok(base.some(s => s.id === id), `entrada desconocida: ${id}`);
  return base.map(s => patrones[s.id] ? { ...s, patrones: patrones[s.id]! } : s);
}
const ESTADO_GLOBAL = { ...ESTADO_BASE, adaptationEnabled: 'V19: bandera de adaptación causal, igual para todas las regiones.' };
const CONSTANTES_DE_RADIO = { ...CONSTANTES_BASE, RADIO_PAREJA: { fichero: 'animals.ts', valor: 12 } };
const FUERA_DEL_PASO = [...FUERA_BASE, {
  fichero: 'proyeccion.ts', funcion: 'projectChemistry', motivo: 'V20: resumen de lotes para la vista; sólo lo llama projectWorld.',
}];
const ALCANCES: readonly Alcance[] = [...actualizarSitios(ALCANCES_BASE, {
  'decision.teselas': [
    'const tileIn = tileInArg ?? tileLookup(world.tiles);',
    'const fast = fastArg === undefined ? residentFastAccess(world.tiles) : fastArg ?? undefined;',
    'for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {',
    'if (dx * dx + dy * dy > RADIUS * RADIUS) continue;',
    'if (cell >= 0 && terrainScan![cell] !== WATER_CODE) { nearbyTiles.push(tileIn(x, y)!); nearbyCells.push(cell); }',
    'const tile = tileIn(x, y);\n      if (!tile) continue;',
    "const tile = tileIn(x, y); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);",
  ],
  'decision.personas': ["const nearbyPeople = vecinos(world, person, RADIUS + 1, other => other.id !== person.id && distance(person, other) <= RADIUS, 'choose', own ? choosePeople : undefined);"],
  'decision.caza': ['for (const animal of world.animals) {\n          if (animal.x !== tile.x || animal.y !== tile.y || !(animal.health > 0)) continue;'],
  'decision.destinoForrajeo': ["(selected.action!=='forage' || foodStock(tileIn(person.target.x, person.target.y), soaCell(fast, person.target.x, person.target.y, tileIn(person.target.x, person.target.y)), fast)>=MIN_FORAGE_STOCK)"],
  'decision.sedPorPaso': ['const here = tileIn(person.x, person.y)!;', 'const sedPorPaso = needRates(world, tileIsDesert(here, hereCell, fast), tileIsExposed(here, hereCell, fast), demographicTraits(person.genome, params.cuerpo)).thirst;'],
  'decision.techo': ['const tileIn = lookup ?? tileLookup(world.tiles);', 'const tile = tileIn(point.x, point.y);',
    "const roofs = filtrarCerca(world.structures, point, 0,\n    s => s.x === point.x && s.y === point.y && s.condition > BROKEN_CONDITION && s.components.includes('roof'), bodilyRoofs);"],
  'decision.comidaInmediata': ['const tileIn = lookup ?? tileLookup(world.tiles);', 'const tile = tileIn(person.x, person.y);', 'Math.min(foodStock(tile, soaCell(fast, person.x, person.y, tile), fast), 0.0035)'],
  'decision.recuperarAgua': ['const tileIn = lookup ?? tileLookup(world.tiles);', 'const here = tileIn(person.x, person.y)!;'],
  'decision.politicaPersonas': ["const nearby = people ?? vecinos(world, person, RADIUS + 1, other => other.id !== person.id && distance(person, other) <= RADIUS, 'policy', policyNearby);"],
  ...Object.fromEntries(['asentamiento.hogar', 'asentamiento.lugares'].map(centro => [`${centro}.teselas`, [
    'const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);',
    'for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) {', 'if (dx*dx+dy*dy>16) continue;',
    'const x = place.x + dx, y = place.y + dy, tile = tileIn(x, y);',
    'if (r > 0) { const w = fast!.woodArr[cell]!; wood += w === w ? w : 0; stone += tile.stone ?? 0; fauna += tile.fauna ?? 0; }',
    'if (r > 0) { wood += tile.wood ?? 0; stone += tile.stone ?? 0; fauna += tile.fauna ?? 0; }',
  ]])),
  ...Object.fromEntries(['asentamiento.hogar', 'asentamiento.lugares'].map(centro => [`${centro}.estructuras`, [
    'filtrarCerca(world.structures, place, 5, s => Math.abs(s.x - place.x) <= 5 && Math.abs(s.y - place.y) <= 5\n        && (!s.site || !!s.site.expansion) && structureDistance(place, s) <= 3 && s.condition > 0.1)',
    'filtrarCerca(world.structures, place, 5, s=>distance(s,place)<=4 && s.condition>0.1)',
  ]])),
  'cooperacion.insumos': ['const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles);',
    'for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {', 'if (dx * dx + dy * dy > 49) continue;',
    'const x = learner.x + dx, y = learner.y + dy, tile = tileIn(x, y);'],
  'obra.materiales': ['const fast = residentFastAccess(world.tiles), exact = fast?.exact;',
    'for (let dy = -CONSTRUCTION_RADIUS; dy <= CONSTRUCTION_RADIUS; dy++) for (let dx = -CONSTRUCTION_RADIUS; dx <= CONSTRUCTION_RADIUS; dx++) {',
    'if (dx * dx + dy * dy > CONSTRUCTION_RADIUS * CONSTRUCTION_RADIUS) continue;',
    'const tile = cell >= 0 ? tileAt(world, { x, y }) : exact ? undefined : tileAt(world, { x, y });'],
  'agua.disponible': ['let total = tileAt(world, point)?.drinkingWater ?? 0;'],
  'obra.servicios': ['const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);', 'for (const structure of filtrarCerca(world.structures, person, radius + 1,',
    "structure => (paramsOf(world).construccion.modular ? hasCompletedBuilding(structure) : !structure.site) && !(distance(person, structure) > radius || tileAt(world, structure)?.terrain !== 'shelter'))) {",
    'add(structure.components, replacement?.structure === structure ? replacement.condition : structure.condition, structure.water, structure.food,\n      paramsOf(world).tecnologia.obrasPorPropiedades ? structureAffordances(world, structure) : undefined);'],
  'obra.reparaciones': ['const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);', "const structures = filtrarCerca(world.structures, person, radius + 1, structure => !structure.site && !(structure.condition >= REPAIR_CONDITION_LIMIT\n    || distance(person, structure) > radius || tileAt(world, structure)?.terrain !== 'shelter'));"],
  'invento.techos': ['const roofRadius = structureSearchRadius(world, 4);', "const roofs = filtrarCerca(world.structures, person, roofRadius + 1, s => distance(person, s) <= roofRadius && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter');"],
  'invento.planosEstructuras': ['const radius = structureSearchRadius(world, 5);', 'for (const structure of filtrarCerca(world.structures, person, radius + 1, structure => distance(person, structure) <= radius',
    "&& (paramsOf(world).construccion.modular ? hasCompletedBuilding(structure) : !structure.site) && structure.condition > BROKEN_CONDITION && tileAt(world, structure)?.terrain === 'shelter')) ids.add(structure.blueprintId);"],
  'estructuras.funcionales': [
    "? filtrarCerca(world.structures, point, radius + 2, s => hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && structureDistance(point, s) <= radius)",
    ': filtrarCerca(world.structures, point, radius + 1, s => Math.abs(s.x - point.x) <= radius + 1',
    "&& Math.abs(s.y - point.y) <= radius + 1 && !s.site && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius);",
  ],
  'ecologia.vecinos': ['const waterAt = (x: number, y: number): boolean => {', 'const tile = tileIn(x, y);',
    'waterAt(tile.x - 1, tile.y) || waterAt(tile.x + 1, tile.y) || waterAt(tile.x, tile.y - 1) || waterAt(tile.x, tile.y + 1)'],
}).map(e => e.id === 'estructuras.funcionales' ? { ...e, radio: 6.5,
  nota: 'V20: servicio ≤ 1,5 más hasta cinco celdas hasta el ancla de seis celdas conexas (también en snapshots válidos).' }
  : e.id === 'asentamiento.hogar.estructuras' || e.id === 'asentamiento.lugares.estructuras' ? { ...e, radio: 5,
    nota: 'V20 limita explícitamente el ancla a cinco por eje; V19 lee anclas a cuatro.' } : e), {
  id: 'agua.cisternas', coleccion: 'estructuras', centro: 'entrada', radio: 0.5,
  fichero: 'inventions.ts', funcion: 'waterAvailable', patrones: [
    'filtrarCerca(world.structures, point, 1.5, structure => Math.abs(structure.x - point.x) <= 1.5\n    && Math.abs(structure.y - point.y) <= 1.5 && !structure.site && structure.condition > BROKEN_CONDITION\n    && tileAt(world, structure)?.terrain === \'shelter\' && distance(structure, point) <= 0.5, candidates);',
  ],
}, {
  id: 'obra.sitioLocal', coleccion: 'estructuras', centro: 'entrada', radio: 0.5,
  fichero: 'inventions.ts', funcion: 'activeSiteAt', patrones: [
    'return filtrarCerca(world.structures, point, 1.5, s => !!s.site && distance(point, s) <= 0.5)\n    .sort((a, b) => distance(point, a) - distance(point, b) || a.id.localeCompare(b.id))[0];',
  ],
}, {
  id: 'obra.sitios', coleccion: 'estructuras', centro: 'entrada', radio: 7,
  fichero: 'inventions.ts', funcion: 'constructionSite', patrones: [
    'const radius = structureSearchRadius(world, 7);',
    'return filtrarCerca(world.structures, person, radius + 1, s => !!s.site && distance(person, s) <= radius)\n    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];',
  ],
}, {
  id: 'obra.ampliables', coleccion: 'estructuras', centro: 'entrada', radio: 7,
  fichero: 'inventions.ts', funcion: 'expansionCandidate', patrones: [
    'const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);',
    "for (const structure of filtrarCerca(world.structures, person, radius + 1, s => !s.site && s.condition > 0.5 && distance(person, s) <= radius\n    && tileAt(world, s)?.terrain === 'shelter')\n    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))) {\n    const cost = expansionDelta(structure, blueprint.components);",
  ],
}, {
  id: 'obra.centroAlmacen', coleccion: 'punto', centro: 'entrada', radio: 7,
  fichero: 'inventions.ts', funcion: 'constructionCost', patrones: ['const structure = constructionSite(world, person), site = structure?.site;',
    'const expansion = site ? undefined : expansionCandidate(world, person), delta = expansion?.cost;'],
  nota: 'El almacén se consulta desde la obra o ampliación elegida a ≤ 7, no desde la persona.',
}, {
  id: 'obra.almacenes', coleccion: 'estructuras', centro: 'entrada', radio: 7,
  fichero: 'inventions.ts', funcion: 'warehousesNear', patrones: [
    "return filtrarCerca(world.structures, person, paramsOf(world).construccion.poliminosYSinergia ? 5 : 4.5, s => Math.abs(s.x - person.x) <= 7 && Math.abs(s.y - person.y) <= 7\n    && hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION\n    && tileAt(world, s)?.terrain === 'shelter' && structureDistance(person, s) <= 2.5)\n    .sort((a, b) => structureDistance(person, a) - structureDistance(person, b) || a.id.localeCompare(b.id));",
  ], nota: 'V20: servicio a 2,5 + extensión válida hasta 5; el ancla queda acotada explícitamente a 7. V19 ≤ 3,5.',
}, {
  id: 'obra.materialesAlmacenados', coleccion: 'estructuras', centro: 'entrada', radio: 7,
  fichero: 'inventions.ts', funcion: 'localMaterials', patrones: [
    'const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);',
    "for (const s of filtrarCerca(world.structures, person, radius + 1, s => hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION\n      && distance(person, s) <= radius && tileAt(world, s)?.terrain === 'shelter')) {\n      materials.wood += s.storedWood ?? 0;",
  ],
}, {
  id: 'obra.huella.celdas', coleccion: 'teselas', centro: 'entrada', radio: 1,
  fichero: 'inventions.ts', funcion: 'fittingFootprint', patrones: [
    'const candidates: NonNullable<StructureView[\'footprint\']>[] = frames >= 5 ? [{ width: 2, height: 2 }]\n    : frames >= 3 ? [{ width: 2, height: 1 }, { width: 1, height: 2 }] : [{ width: 1, height: 1 }];',
    "cells.some(c => tileAt(world, c)!.terrain === 'shelter' && !old.some(o => o.x === c.x && o.y === c.y))",
  ],
}, {
  id: 'obra.huella.terreno', coleccion: 'teselas', centro: 'entrada', radio: 0,
  fichero: 'inventions.ts', funcion: 'isFootprintFree', patrones: [
    "cells.some(c => !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y)\n    || !tileAt(world, c) || tileAt(world, c)!.terrain === 'water')",
  ],
}, {
  id: 'obra.huella.colisiones', coleccion: 'estructuras', centro: 'entrada', radio: 5,
  fichero: 'inventions.ts', funcion: 'isFootprintFree', patrones: [
    'filtrarCerca(world.structures, cell, paramsOf(world).construccion.poliminosYSinergia ? 5 : 2,\n    s => s.id !== ignoreStructureId && structureFootprintCells(s).some(c => keys.has(`${c.x},${c.y}`))).length',
  ], nota: 'Hasta cinco por eje desde una celda de un polimino conexo de seis celdas hasta su ancla; V19 ≤ 1.',
}, {
  id: 'obra.ampliablesPoliminos', coleccion: 'punto', centro: 'entrada', radio: 3,
  fichero: 'inventions.ts', funcion: 'expansionCandidate', patrones: ['if (paramsOf(world).construccion.poliminosYSinergia) {'],
  nota: 'Esta rama sólo existe con V20: structureSearchRadius reduce el selector de anclas de 7 a 3.',
}, {
  id: 'obra.polimino.celdas', coleccion: 'punto', centro: 'entrada', radio: 5,
  fichero: 'inventions.ts', funcion: 'fittingPolyomino', patrones: [
    'const cells = existing ? completedStructureCells(existing).map(c => ({ ...c })) : [{ x: anchor.x, y: anchor.y }];',
  ], nota: 'Hasta cinco por eje en una huella existente válida de seis celdas conexas; las nuevas quedan a ±2.',
}, {
  id: 'obra.polimino.terreno', coleccion: 'teselas', centro: 'entrada', radio: 2,
  fichero: 'inventions.ts', funcion: 'fittingPolyomino', patrones: [
    'for (const c of cells) for (const [dx, dy] of ORTHOGONAL) {',
    "if (keys.has(cellKey(p)) || Math.abs(p.x - anchor.x) > 2 || Math.abs(p.y - anchor.y) > 2\n        || chunkKey(p.x, p.y) !== chunkKey(anchor.x, anchor.y) || tileAt(world, p)?.terrain === 'shelter'",
    'const edges = (p: Point) => ORTHOGONAL.filter(([dx, dy]) => keys.has(`${p.x + dx},${p.y + dy}`)).length;',
  ], nota: 'Antes de tileAt se descarta p fuera de ±2; los vecinos usados para ordenar son geometría local ya leída.',
}, {
  id: 'tecnologia.mundoSinergia', coleccion: 'punto', centro: 'entrada', radio: 0,
  fichero: 'technology.ts', funcion: 'synergyWorld', patrones: [
    "return !!(boundParamsOf(host)?.construccion.poliminosYSinergia && host.structures && host.tiles && 'blueprints' in host);",
  ], nota: 'Sólo presencia de referencias y bandera; no inspecciona elementos, no convierte ni copia el mundo.',
}, {
  id: 'fauna.pareja', coleccion: 'animales', centro: 'entrada', radio: 12,
  fichero: 'animals.ts', funcion: 'parejaCercana', patrones: [
    'for (let dy = -RADIO_PAREJA; dy <= RADIO_PAREJA; dy++) {', 'const span = RADIO_PAREJA - Math.abs(dy);',
    'for (let dx = -span; dx <= span; dx++) {', 'state.occupants.get(cellXY(animal.x + dx, animal.y + dy))',
  ], nota: 'Rombo Manhattan de RADIO_PAREJA = 12; cada fila tiene semiancho 12 − |dy|.',
}];
const LLAMADAS: readonly Llamada[] = [...actualizarSitios(LLAMADAS_BASE.filter(l => l.id !== 'evaluateCooperation→constructionCost' && l.id !== 'choose→workDuration' && l.id !== 'workDuration→constructionCost'), {
  'choose→bodilyShelter': ['bodilyShelter(world, person, tileIn, fast)', 'bodilyShelter(world, tile, tileIn, fast)', 'bodilyShelter(world, candidate.target, tileIn, fast)'],
  'choose→immediateMeal': ['immediateMeal(world, person, tileIn, fast)', 'immediateMeal(world, {\n        x: candidate.target.x, y: candidate.target.y,\n        inventory: over.inventory ?? person.inventory, hunger: over.hunger ?? person.hunger,\n      }, tileIn, fast)'],
  'choose→waterAvailable': ['ambient > 0.005 || waterAvailable(world, tile) > 0.005', 'const localWater = waterAvailable(world, person) > 0;', 'waterAvailable(world, recuerdo)'],
  'choose→canRecoverWaterHandling': ['canRecoverWaterHandling(world, person, tileIn, fast)'],
  'choose→drinkingBody': ['drinkingBody(world, person, candidate.target, forecastBody)'],
  'choose→explorationTarget': ["if (command.order === 'explore') directed.target = explorationTarget(world, person, reachableTiles, reachableCells, fast);", 'selected.target = continuingSearch ? person.target : explorationTarget(world, person, reachableTiles, reachableCells, fast);'],
  'choose→localPolicyObservation': ['localPolicyObservation(world, person, tileIn, fast, undefined, 0, nearbyPeople)'],
  'localPolicyObservation→computeLocalPolicyObservation': ['return computeLocalPolicyObservation(world, person, lookup, nearby, fast, out, offset);'],
  'evaluateCooperation→practicedRecipeToTeach': ['practicedRecipeToTeach(world, person, other, world.learningEnabled ? practiced ??= practicedRecipes(person) : undefined, census)'],
  'practicedRecipeToTeach→recipeHolders': ['const holders = rareza > 0 ? census ? census.counts ??= recipeHolders(world) : recipeHolders(world) : undefined;'],
  'constructionOpportunity→selectedBlueprint': ['selectedBlueprint(world, person)'],
  'usefulRepairs→localServices': ['serviceValue(localServices(world, person), perceived)',
    'serviceValue(localServices(world, person, { structure, condition }, undefined, Math.max(0, person.materials.wood - steps * load)), perceived)'],
  'chooseInvention→candidatesFromKnown': ['candidatesFromKnown(world, person, context, known)'],
}),
  ...([
    ['animals.ts', 'choose', 'animals.ts:parejaCercana', 'entrada', ['parejaCercana(animal, state)']],
    ['society.ts', 'evaluateCooperation', 'inventions.ts:activeSiteAt', 'cooperacion.otro', ['activeSiteAt(world, other)']],
    ['society.ts', 'evaluateCooperation', 'inventions.ts:partnerConstructionCost', 'cooperacion.otro', ['partnerConstructionCost(world, other)']],
    ['society.ts', 'evaluateCooperation', 'inventions.ts:storedMaterialsNear', 'entrada', ['storedMaterialsNear(world, person)']],
    ['inventions.ts', 'partnerConstructionCost', 'inventions.ts:selectedBlueprint', 'entrada', ['selectedBlueprint(world, person).components']],
    ['inventions.ts', 'partnerConstructionCost', 'inventions.ts:activeSiteAt', 'entrada', ['activeSiteAt(world, person)']],
    ['inventions.ts', 'partnerConstructionCost', 'inventions.ts:storedMaterialsNear', 'entrada', ['storedMaterialsNear(world, person)']],
    ['inventions.ts', 'constructionCost', 'inventions.ts:constructionSite', 'entrada', ['constructionSite(world, person)']],
    ['inventions.ts', 'constructionCost', 'inventions.ts:expansionCandidate', 'entrada', ['expansionCandidate(world, person)']],
    ['inventions.ts', 'constructionCost', 'inventions.ts:storedMaterialsNear', 'obra.centroAlmacen', ['storedMaterialsNear(world, structure ?? expansion?.structure ?? person)']],
    ['inventions.ts', 'expansionCandidate', 'inventions.ts:selectedBlueprint', 'entrada', ['selectedBlueprint(world, person)']],
    ['inventions.ts', 'expansionCandidate', 'inventions.ts:fittingFootprint', 'obra.ampliables', ['fittingFootprint(world, structure, blueprint.components, structure)']],
    ['inventions.ts', 'fittingFootprint', 'inventions.ts:isFootprintFree', 'obra.huella.celdas', ['isFootprintFree(world, cells, existing?.id)']],
    ['inventions.ts', 'storedMaterialsNear', 'inventions.ts:warehousesNear', 'entrada', ['warehousesNear(world, person)']],
    ['inventions.ts', 'constructionOpportunity', 'inventions.ts:constructionSite', 'entrada', ['constructionSite(world, person)']],
    ['inventions.ts', 'constructionOpportunity', 'inventions.ts:expansionCandidate', 'entrada', ['expansionCandidate(world, person, blueprint)']],
    ['inventions.ts', 'constructionOpportunity', 'inventions.ts:storedMaterialsNear', 'obra.ampliables', ['storedMaterialsNear(world, expansion.structure)']],
    ['inventions.ts', 'repairOpportunity', 'inventions.ts:storedMaterialsNear', 'entrada', ['storedMaterialsNear(world, person)']],
    ['inventions.ts', 'expansionCandidate', 'inventions.ts:fittingPolyomino', 'obra.ampliablesPoliminos', ['fittingPolyomino(world, structure, blueprint.components, structure)']],
    ['inventions.ts', 'constructionCost', 'inventions.ts:fittingPolyomino', 'entrada', ['fittingPolyomino(world, person, components)']],
    ['inventions.ts', 'constructionOpportunity', 'inventions.ts:fittingPolyomino', 'entrada', ['fittingPolyomino(world, person, blueprint.components)']],
    ['inventions.ts', 'fittingPolyomino', 'inventions.ts:isFootprintFree', 'obra.polimino.celdas', ['isFootprintFree(world, cells, existing?.id)', 'isFootprintFree(world, [p], existing?.id)']],
    ['technology.ts', 'availableRawMaterials', 'technology.ts:synergyWorld', 'entrada', ['synergyWorld(host)']],
    ['technology.ts', 'availableRawMaterials', 'inventions.ts:storedMaterialsNear', 'entrada', ['storedMaterialsNear(host, actor)']],
    ['technology.ts', 'planWithdrawal', 'technology.ts:availableRawMaterials', 'entrada', ['availableRawMaterials(host, actor)']],
    ['technology.ts', 'localInputs', 'technology.ts:availableRawMaterials', 'entrada', ['availableRawMaterials(host, actor)']],
    ['technology.ts', 'withdraw', 'technology.ts:synergyWorld', 'entrada', ['synergyWorld(host)']],
    ['technology.ts', 'withdraw', 'inventions.ts:withdrawMaterials', 'entrada', [
      'withdrawMaterials(host, actor, {\n      wood: Math.max(0, Math.ceil(plan.imported.wood / MASS_UNIT - actor.materials.wood - 1e-8)),\n      stone: Math.max(0, Math.ceil(plan.imported.stone / MASS_UNIT - actor.materials.stone - 1e-8)),\n    })',
    ]],
    ['technology.ts', 'forecastCraft', 'technology.ts:withdraw', 'entrada', ['withdraw(host, actor, plan)']],
    ['inventions.ts', 'withdrawMaterials', 'inventions.ts:warehousesNear', 'entrada', ['warehousesNear(world, person)']],
    ['inventions.ts', 'withdrawMaterials', 'inventions.ts:observeUse', 'obra.almacenes', ['observeUse(world, s, (wood + stone) / 20)']],
  ] as const).map(([fichero, funcion, llama, centro, patrones]) => ({ id: `${funcion}→${llama.split(':')[1]}`, fichero, funcion, llama, centro, patrones })),
];
const ALCANCES_SERIALES: readonly AlcanceSerial[] = [...actualizarSitios(SERIALES_BASE, {
  'accion.bfs': ['const tileIn = tileInArg ?? tileLookup(world.tiles);', 'Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) > 24'],
  'accion.caminable': ['const tile = (lookup ?? tileLookup(world.tiles))(p.x, p.y);'],
  'accion.pisada': ['const steppedTile = tileIn(person.x, person.y)!;', 'trampleTile(steppedTile)'],
  'accion.aqui': ['const tileIn = tileInArg ?? tileLookup(world.tiles);', 'const tile = tileIn(person.x, person.y)!;', 'const current = moved ? tileIn(person.x, person.y)! : tile;'],
  'accion.destino': ['const targetTile = tileIn(person.target.x, person.target.y);', 'waterAvailable(world,person.target) < 0.003'],
  'accion.cazar': ['world.animals.filter(a => a.x === point.x && a.y === point.y && a.health > 0)', '!residentBackingArray(world.tiles).some(t => t.x === point.x && t.y === point.y)'],
  'estructuras.riego': ['tileAt(world, { x: structure.x + dx!, y: structure.y + dy! })', '[...ground.values()].map(p => tileAt(world, p))'],
}).map(e => e.id === 'estructuras.riego' ? { ...e, radio: 6, nota: 'V20: hasta cinco por eje de huella válida y un vecino ortogonal.' } : e),
  ...([
    ['accion.deposito', 'depositMaterials', 6.5, ["tileAt(world, structure)?.terrain !== 'shelter'"]],
    ['accion.obraModular', 'modularConstruction', 0.5, ['tileAt(world, tile) !== tile', 'world.structures.find(s => s.x === tile.x && s.y === tile.y)']],
    ['accion.huellaTerminada', 'contributeConstruction', 6.5, ['for (const cell of structureFootprintCells(structure)) tileAt(world, cell)!.terrain = \'shelter\';', 'tileAt(world, structure)!']],
    ['accion.lugarObra', 'modularConstruction', 5.5, ['algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5 && !world.structures.some(s => p.id === `settlement-${s.x}-${s.y}`))']],
  ] as const).map(([id, funcion, radio, patrones]) => ({ id, fase: 'accion' as const, coleccion: 'teselas' as const, centro: 'actor', radio, fichero: 'inventions.ts', funcion, patrones })),
  { id: 'tecnologia.descubrimientoPersonas', fase: 'accion', coleccion: 'personas', centro: 'actor', radio: 5, fichero: 'technology.ts', funcion: 'locallyUsefulDiscovery',
    patrones: ['for (const other of host.people) if (other === actor || distance(actor, other) <= 5)'] },
  { id: 'tecnologia.descubrimientoObras', fase: 'accion', coleccion: 'estructuras', centro: 'actor', radio: 5, fichero: 'technology.ts', funcion: 'locallyUsefulDiscovery',
    patrones: ['for (const structure of host.structures ?? []) if (distance(actor, structure) <= 5)'] },
  { id: 'estructuras.depositoMaterial', fase: 'estructuras', coleccion: 'personas', centro: 'actor', radio: 6.5, fichero: 'inventions.ts', funcion: 'stepStructures',
    patrones: ['vecinos(world, structure, 3.5, p => structureDistance(p, structure) <= 1.5)'], nota: 'V20: 1,5 desde huella válida más hasta cinco desde el ancla.' },
  { id: 'estructuras.sinergia', fase: 'estructuras', coleccion: 'estructuras', centro: 'actor', radio: 13, fichero: 'inventions.ts', funcion: 'synergyNeighbours',
    patrones: ['filtrarCerca(world.structures, cell, 5,\n    s => s !== structure && hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION && structureDistance(cell, s) <= 3)'],
    nota: 'Cinco hasta la celda propia, tres de vecindad física, cinco hasta el ancla vecina; fase serial.' },
  { id: 'tecnologia.taller', fase: 'accion', coleccion: 'estructuras', centro: 'actor', radio: 6.5, fichero: 'technology.ts', funcion: 'workshopWorkFactor',
    patrones: ['filtrarCerca(host.structures, actor, 5, s => (!s.site || !!s.site.expansion) && s.condition > BROKEN_CONDITION\n    && structureDistance(actor, s) <= 1.5 && (s.synergy?.workshopBonus ?? 0) > 0)'],
    nota: 'Contacto a 1,5 de hasta seis celdas conexas; usa sinergia ya calculada en la fase serial.' },
  { id: 'quimica.bodyAndAction', fase: 'accion', coleccion: 'estructuras', centro: 'actor', radio: 3, fichero: 'index.ts', funcion: 'bodyAndAction',
    patrones: [
      'const nearbyRestChem = filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion));',
      'const nearbyChem = filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion));',
    ] },
  { id: 'quimica.performWork', fase: 'accion', coleccion: 'estructuras', centro: 'actor', radio: 3, fichero: 'index.ts', funcion: 'performWork',
    patrones: ['filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion))'] },
  { id: 'accion.preferenciaCamino', fase: 'accion', coleccion: 'teselas', centro: 'actor', radio: 1, fichero: 'index.ts', funcion: 'move',
    patrones: ['distance(nextStep, person.target) < startDistance',
      'considerRoad(start.x + 1, start.y, tileIn(start.x + 1, start.y))', 'considerRoad(start.x, start.y + 1, tileIn(start.x, start.y + 1))',
      'considerRoad(start.x - 1, start.y, tileIn(start.x - 1, start.y))', 'considerRoad(start.x, start.y - 1, tileIn(start.x, start.y - 1))',
      'roadEffortFactor(tileIn(start.x, start.y))', 'const tile = tileIn(nextStep.x, nextStep.y);'],
    nota: 'Cuatro vecinos cardinales y celda propia; startDistance sólo compara un destino ya guardado.' },
];
const RAICES = RAICES_BASE.map(r => r.fichero === 'index.ts' && r.funcion === 'choose' ? {
  ...r, llamador: { ...r.llamador, patrones: ["(person.thirst > 0.9 && person.action !== 'drink'))) choose(world, person, policyScores, precomputedMoves, slot, tileIn, fast ?? null);"] },
} : r);
const RECORRIDOS = actualizarSitios(RECORRIDOS_BASE, {
  'paso.acciones': ['const tileIn = tileLookup(world.tiles);', 'for (let slot = 0; slot < world.people.length; slot++) bodyAndAction(world, world.people[slot]!, precomputedMoves, slot, policyScores, tileIn, fast);'],
  'ecologia': ['const rawTiles = residentBackingArray(world.tiles);', 'for (let i = 0; i < rawTiles.length; i++) {',
    "if (bound && terrainArr![cell] === WATER) continue;", "if (!bound && tile.terrain === 'water') continue;",
    'const tileIn = tileLookup(world.tiles);', 'const fast = residentFastAccess(world.tiles);',
    'stepLocalEcology(world.tiles, world.tick, world.weather, phase, paramsOf(world).recursos,'],
  'estructuras': ['if (polyomino) for (const structure of world.structures) {\n    if (!hasCompletedBuilding(structure)) continue;',
    'for (const structure of world.structures) {\n    const modular = paramsOf(world).construccion.modular;',
    'if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {'],
});
const LECTURAS_GLOBALES: readonly LecturaGlobal[] = [...actualizarSitios(GLOBALES_BASE, {
  'planos': ['world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components, paramsOf(world).construccion.modular))',
    "world.blueprints.find(b => b.id === 'blueprint-base')"],
  'planos.conocidos': ['return world.blueprints.filter(b => (ids.has(b.id) || b.inventorId === person.id) && validBlueprint(b.components, paramsOf(world).construccion.modular))'],
  'planos.catalogo': ['const modular = paramsOf(world).construccion.modular, encountered = modular ? known : world.blueprints;'],
  'estructuras.tope.constructionOpportunity': ['if (!expansion && world.structures.length >= structureCap(world)) return;'],
}).map(e => e.id === 'planos.uso' ? { ...e, fase: 'decision' as const,
  motivo: 'Identidad del plano de la estructura usada; V20 también llega desde withdraw en forecastCraft (copias de previsión).' } : e), {
  id: 'estructuras.tope.modular', fase: 'accion', fichero: 'inventions.ts', funcion: 'modularConstruction', fuente: 'world.structures.length', cota: 'structureCap(world)',
  patrones: ['world.structures.length >= structureCap(world)'], motivo: 'Tope global de obras activas antes de reservar una obra modular.' }, {
  id: 'tecnologia.activosFijos', fase: 'checkpoint', fichero: 'technology.ts', funcion: 'fixedTechnologyAssets', fuente: 'host.structures + host.retiredChunks', cota: 'O(obras activas y retiradas)',
  patrones: ['return [...(host.structures ?? []), ...(host.retiredChunks ?? []).flatMap(c => c.structures ?? [])].flatMap(s => s.installed ?? []);'],
  motivo: 'Balance global de materia instalada, fuera de las fases con halo.' },
];
const LECTURAS_POR_IDENTIDAD: readonly LecturaPorIdentidad[] = [...actualizarSitios(IDENTIDAD_BASE, {
  'comunidad.pertenencia': ['for (const group of world.communities) comunidadesPorId.set(group.id, group);', 'for (const group of world.communities) gruposActuales.set(group.id, group);'],
}),
  ...([
    ['pertenencia.deposito', 'inventions.ts', 'depositMaterials', 'world.people + world.structures', ['!world.people.includes(person)', '!world.structures.includes(structure)']],
    ['pertenencia.obraModular', 'inventions.ts', 'modularConstruction', 'world.people', ['!world.people.includes(person)']],
    ['identidad.obraModular', 'inventions.ts', 'modularConstruction', 'world.structures', ["nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world)"]],
    ['pertenencia.contribucion', 'inventions.ts', 'contributeConstruction', 'world.people + world.structures', ['!world.structures.includes(structure)', '!world.people.includes(person)']],
    ['planos.ampliacion', 'inventions.ts', 'contributeConstruction', 'world.blueprints', ['world.blueprints.find(b => b.id === site.expansion!.blueprintId)!']],
    ['planos.firmaModular', 'inventions.ts', 'invent', 'world.blueprints', ['world.blueprints.find(b => blueprintSignature(b.components) === blueprintSignature(candidate.components))']],
    ['lugar.ampliacion', 'inventions.ts', 'contributeConstruction', 'world.places', ['for (const p of world.places) if (p.id === place.id)']],
    ['lugar.obraCompartida', 'inventions.ts', 'contributeConstruction', 'world.places + world.chunks', ['world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);']],
    ['cooperacion.obraCompartida', 'society.ts', 'cooperate', 'world.structures', ['world.structures.find(s => s.id === opportunity.siteId)']],
    ['acuerdo.socio', 'society.ts', 'settleAgreement', 'world.people', ['world.people.find(p => p.id === agreement.partner)']],
    ['acuerdo.fuente', 'society.ts', 'settleAgreement', 'world.tiles', ['tileAt(world, agreement)']],
    ['pertenencia.instalacion', 'technology.ts', 'installTechnologyItem', 'host.structures + host.people', ['!host.structures?.includes(structure)', '!isHostMember(host.people, actor)']],
  ] as const).map(([id, fichero, funcion, fuente, patrones]) => ({ id, fase: 'accion' as const, fichero, funcion, fuente, patrones,
    motivo: 'V19: identidad, pertenencia o coordenada guardada; lectura serial sin cota espacial, nunca una excepción al halo.' })),
];
const INVENTARIO: Inventario = { ...INVENTARIO_BASE, alcances: ALCANCES, llamadas: LLAMADAS, raices: RAICES };

const DIRECTORIO = fileURLToPath(new URL('../src/world/', import.meta.url));
const FUENTES: Readonly<Record<string, string>> = Object.fromEntries(readdirSync(DIRECTORIO).filter(f => f.endsWith('.ts') && f !== 'halo.ts').sort()
  .map(f => [f, readFileSync(DIRECTORIO + f, 'utf8')]));

// ── Analizador léxico: sin comentarios, cadenas ni expresiones regulares, con las posiciones del original. ──
function limpiar(texto: string): string {
  const out = texto.split(''), blanco = (i: number) => { if (out[i] !== '\n') out[i] = ' '; };
  const pila: { plantilla: boolean; llaves: number }[] = [{ plantilla: false, llaves: 0 }];
  let i = 0, ultimo = '';
  while (i < texto.length) {
    const ctx = pila[pila.length - 1]!, c = texto[i]!, d = texto[i + 1];
    if (ctx.plantilla) {
      if (c === '\\') { blanco(i); blanco(i + 1); i += 2; }
      else if (c === '`') { pila.pop(); ultimo = '`'; i++; }
      else if (c === '$' && d === '{') { pila.push({ plantilla: false, llaves: 0 }); i += 2; ultimo = '{'; }
      else blanco(i++);
      continue;
    }
    if (c === '/' && d === '/') { while (i < texto.length && texto[i] !== '\n') blanco(i++); continue; }
    if (c === '/' && d === '*') { const fin = texto.indexOf('*/', i + 2), hasta = fin < 0 ? texto.length : fin + 2; while (i < hasta) blanco(i++); continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < texto.length && texto[i] !== c && texto[i] !== '\n') { if (texto[i] === '\\') blanco(i++); blanco(i++); }
      i++; ultimo = c; continue;
    }
    if (c === '`') { pila.push({ plantilla: true, llaves: 0 }); i++; continue; }
    if (c === '/' && (ultimo === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(ultimo) || /\b(?:return|typeof|case)\s*$/.test(texto.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, clase = false;
      while (j < texto.length && texto[j] !== '\n' && (clase || texto[j] !== '/')) { if (texto[j] === '\\') j++; else if (texto[j] === '[') clase = true; else if (texto[j] === ']') clase = false; j++; }
      if (texto[j] === '/') { for (let k = i; k <= j; k++) blanco(k); i = j + 1; while (/[a-z]/.test(texto[i] ?? '')) blanco(i++); ultimo = 'r'; continue; }
    }
    if (c === '{') ctx.llaves++;
    if (c === '}') { if (ctx.llaves === 0 && pila.length > 1) { pila.pop(); i++; continue; } ctx.llaves--; }
    if (!/\s/.test(c)) ultimo = c;
    i++;
  }
  return out.join('');
}

interface Decl { fichero: string; nombre: string; inicio: number; fin: number; tipo: string }
interface Fuente { fichero: string; texto: string; limpio: string; decl: Decl[]; importa: Map<string, string> }
const DECLARACION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum|import|export)\b\s*\*?\s*([A-Za-z_$][\w$]*)?/;
/** Cada declaración de primer nivel (columna 0 del texto limpio) va hasta la siguiente. */
function cargar(textos: Readonly<Record<string, string>>): Map<string, Fuente> {
  const fuentes = new Map<string, Fuente>();
  for (const [fichero, texto] of Object.entries(textos)) {
    const limpio = limpiar(texto), decl: Decl[] = [];
    let pos = 0, n = 0;
    for (const linea of limpio.split('\n')) {
      n++;
      const m = DECLARACION.exec(linea);
      if (m) {
        if (decl.length) decl[decl.length - 1]!.fin = pos;
        const anonima = m[1] === 'import' || m[1] === 'export' || !m[2];
        decl.push({ fichero, nombre: anonima ? `<${m[1]}@${n}>` : m[2]!, inicio: pos, fin: limpio.length, tipo: m[1]! });
      }
      pos += linea.length + 1;
    }
    const importa = new Map<string, string>();
    for (const m of texto.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'\.\/([\w-]+)\.js'/gm)) for (const parte of m[1]!.split(',').map(p => p.trim()).filter(Boolean)) {
      if (parte.startsWith('type ')) continue;
      const [nombre, alias] = parte.split(/\s+as\s+/) as [string, string?];
      importa.set(alias ?? nombre, `${m[2]}.ts:${nombre}`);
    }
    fuentes.set(fichero, { fichero, texto, limpio, decl, importa });
  }
  return fuentes;
}

const COLECCION = /\.\s*(people|places|structures|tiles|animals|communities|invitations|reminders|memories|blueprints|legacy|retiredLegacy|chunks|retiredChunks)\b/g;
const NOMBRES_DE_COLECCION = new Set(COLECCION.source.slice(COLECCION.source.indexOf('(') + 1, COLECCION.source.indexOf(')')).split('|'));
const ESTADO = /\bstate\.(tile|occupants|counts)\b/g;
const PRIMITIVA = new Map(PRIMITIVAS.map(p => [p.funcion, `${p.fichero}:${p.funcion}`]));
const RECIBEN_COLECCION = new Set(COLECCIONES_POR_NOMBRE.map(c => `${c.fichero}:${c.funcion}`));
const NO_CODIGO = /^(?:import|export|interface|type)$/;
type Tipo = 'coleccion' | 'nombre' | 'estado' | 'primitiva' | 'alias' | 'llamada' | 'barrido';
interface Uso { fichero: string; funcion: string; pos: number; tipo: Tipo; nombre: string; llama?: string }
const clave = (fichero: string, funcion: string) => `${fichero}:${funcion}`;
const lineaDe = (f: Fuente, pos: number) => f.texto.slice(0, pos).split('\n').length;
const textoDe = (f: Fuente, pos: number) => f.texto.split('\n')[lineaDe(f, pos) - 1]!.trim().slice(0, 150);

/** Fin del inicializador que empieza en `desde`: la primera `,` o `;` a profundidad 0 (o `argumentos`: sólo
 * el paréntesis que cierra, para leer lo que sigue a una llamada). */
function finDeExpresion(texto: string, desde: number, argumentos = false): number {
  let profundidad = 0;
  for (let i = desde; i < texto.length; i++) {
    const c = texto[i]!;
    if ('([{'.includes(c)) profundidad++;
    else if (')]}'.includes(c)) { if (profundidad === 0) return i; profundidad--; }
    else if (!argumentos && (c === ',' || c === ';') && profundidad === 0) return i;
  }
  return texto.length;
}
/** Operando derecho de una comparación que empieza en `desde`: hasta `,` `;` `)` `&&` `||` `?` `:` `}` a profundidad 0. */
function operando(texto: string, desde: number): string {
  let profundidad = 0, i = desde;
  for (; i < texto.length; i++) {
    const c = texto[i]!, dos = texto.slice(i, i + 2);
    if ('([{'.includes(c)) profundidad++;
    else if (')]}'.includes(c)) { if (profundidad === 0) break; profundidad--; }
    else if (profundidad === 0 && (',;?:\n'.includes(c) || dos === '&&' || dos === '||')) break;
  }
  return texto.slice(desde, i).trim();
}
/** Operando izquierdo de una comparación que acaba en `hasta` (sin incluir): hacia atrás hasta un delimitador a profundidad 0. */
function operandoIzquierdo(texto: string, hasta: number): string {
  let profundidad = 0, i = hasta - 1;
  for (; i >= 0; i--) {
    const c = texto[i]!, dos = texto.slice(i - 1, i + 1);
    if (')]}'.includes(c)) profundidad++;
    else if ('([{'.includes(c)) { if (profundidad === 0) break; profundidad--; }
    else if (profundidad === 0 && (',;?:=!\n'.includes(c) || dos === '&&' || dos === '||' || dos === '=>')) break;
  }
  return texto.slice(i + 1, hasta).trim();
}
/** Nombres que liga un patrón de declaración: `v`, `[dx, dy]` o `{ x, y: b }`. */
const ligados = (patron: string): string[] => [...patron.replace(/:\s*[A-Za-z_$][\w$]*/g, m => m.replace(/^:\s*/, ' ')).matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]);
/** `v` desplaza una coordenada en `cuerpo`: `p.x + v`, `y - v`, `v + p.x`… */
const desplaza = (cuerpo: string, v: string): boolean =>
  new RegExp(`(?:\\.[xy]|(?<![\\w$.])[xy])\\s*[+-]\\s*${v}!?(?![\\w$.])|(?<![\\w$.])${v}!?\\s*[+-]\\s*[\\w$.]*\\.[xy]\\b`).test(cuerpo);

class Analisis {
  readonly fuentes: Map<string, Fuente>;
  readonly decl = new Map<string, Decl>();
  readonly usos = new Map<string, Uso[]>();
  readonly lectores = new Set<string>();
  constructor(textos: Readonly<Record<string, string>>) {
    this.fuentes = cargar(textos);
    for (const f of this.fuentes.values()) for (const d of f.decl) if (!NO_CODIGO.test(d.tipo)) this.decl.set(clave(f.fichero, d.nombre), d);
    for (const [k, d] of this.decl) this.usos.set(k, this.directos(this.fuentes.get(d.fichero)!, d));
    // Un barrido sin lectura no lee el mundo: sólo cuenta en una función que ya lee.
    for (const [k, u] of this.usos) if (u.some(x => x.tipo !== 'barrido') && !PRIMITIVA.has(this.decl.get(k)!.nombre)) this.lectores.add(k);
    for (const k of PRIMITIVA.values()) this.lectores.add(k);
    for (let cambio = true; cambio;) {
      cambio = false;
      for (const k of this.decl.keys()) if (!this.lectores.has(k) && this.llamadas(k).some(u => this.lectores.has(u.llama!))) { this.lectores.add(k); cambio = true; }
    }
  }
  private resolver(f: Fuente, nombre: string): string | undefined {
    if (this.decl.has(clave(f.fichero, nombre))) return clave(f.fichero, nombre);
    const importado = f.importa.get(nombre);
    return importado && this.decl.has(importado) ? importado : undefined;
  }
  /** Lecturas del mundo escritas en la declaración, con sus alias locales. */
  private directos(f: Fuente, d: Decl): Uso[] {
    const cuerpo = f.limpio.slice(d.inicio, d.fin), usos: Uso[] = [];
    const add = (pos: number, tipo: Tipo, nombre: string) => usos.push({ fichero: f.fichero, funcion: d.nombre, pos: d.inicio + pos, tipo, nombre });
    for (const m of cuerpo.matchAll(COLECCION)) add(m.index!, 'coleccion', m[1]!);
    // `const { people } = world` y `world['people']` también leen una colección.
    for (const m of cuerpo.matchAll(/\{([^{}]*)\}\s*=(?![=>])/g)) for (const nombre of ligados(m[1]!)) if (NOMBRES_DE_COLECCION.has(nombre)) add(m.index!, 'coleccion', nombre);
    const original = f.texto.slice(d.inicio, d.fin);
    for (const m of original.matchAll(/\[\s*['"`]([A-Za-z]+)['"`]\s*\]/g)) if (NOMBRES_DE_COLECCION.has(m[1]!) && cuerpo[m.index!] === '[') add(m.index!, 'coleccion', m[1]!);
    // El mundo entero por reflexión o con una clave calculada: `Object.values(world)`, `{ ...world }`, `world[campo]`.
    // También el mundo con otro tipo o con otro nombre: `world as …`, `(world)[…]`, `const w = world;`.
    for (const m of cuerpo.matchAll(/(?:\b(?:Object|JSON|Reflect)\s*\.\s*\w+\s*\(\s*|\.\.\.\s*)(?:world|host)\b(?!\s*\.)|(?<![\w$.])(?:world|host)\s*(?:\[|as\b|\)\s*\[)|(?<![=!<>])=\s*(?:world|host)\s*(?=[;,)\n])/g)) add(m.index!, 'coleccion', 'reflexion');
    for (const m of cuerpo.matchAll(ESTADO)) add(m.index!, 'estado', m[1]!);
    for (const m of cuerpo.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (PRIMITIVA.has(m[1]!) && m[1] !== d.nombre && !/function\s+$/.test(cuerpo.slice(0, m.index!))) add(m.index!, 'primitiva', m[1]!);
    const nombres = COLECCIONES_POR_NOMBRE.find(c => c.fichero === f.fichero && c.funcion === d.nombre)?.nombres ?? [];
    for (const nombre of nombres) for (const m of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${nombre}\\b(?!\\s*:)(?!\\s*=[^=>])`, 'g'))) add(m.index!, 'nombre', nombre);
    // Alias: `const x = world.people`, `const f = tileLookup(…)` o una función flecha que lee; hasta punto fijo.
    const alias = new Set<string>();
    for (let cambio = true; cambio;) {
      cambio = false;
      for (const m of cuerpo.matchAll(/(?:\b(?:const|let|var)\s+|,\s*)([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=(?![=>])/g)) {
        const nombre = m[1]!, desde = m.index! + m[0].length, valor = cuerpo.slice(desde, finDeExpresion(cuerpo, desde)).trim();
        if (alias.has(nombre)) continue;
        const lee = (t: string) => new RegExp(COLECCION.source).test(t) || new RegExp(ESTADO.source).test(t) || [...PRIMITIVA.keys()].some(p => new RegExp(`\\b${p}\\s*\\(`).test(t))
          || [...alias].some(x => new RegExp(`(?<![\\w$.])${x}\\b`).test(t));
        const desnudo = new RegExp(`^[\\w$.\\s]*\\.\\s*(?:${COLECCION.source.slice(6, -3)})$`).test(valor), consulta = /^tileLookup\s*\(/.test(valor);
        // Una función invocada en el acto (`(() => {…})()`) no es un alias: da un valor, y sus lecturas son directas.
        const flecha = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>/.test(valor) && !/^\(.*\)\s*\(\s*\)$/s.test(valor);
        if (desnudo || consulta || (flecha && lee(valor))) { alias.add(nombre); cambio = true; }
      }
    }
    for (const nombre of alias) for (const m of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${nombre}\\b(?!\\s*:)(?!\\s*=[^=>])`, 'g'))) add(m.index!, 'alias', nombre);
    // Barridos: un `for (let|const …)` o un parámetro de función flecha cuya variable desplaza una coordenada. El patrón
    // que lo fija debe incluir sus cotas (la cabecera del `for`, o el arreglo de desplazamientos y el `.map` que lo recorre).
    for (const m of cuerpo.matchAll(/\bfor\s*\(\s*(?:let|const|var)\s+(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/g)) {
      const cabecera = finDeExpresion(cuerpo, cuerpo.indexOf('(', m.index!) + 1, true);
      for (const v of ligados(m[1]!)) if (desplaza(cuerpo, v)) {
        add(m.index!, 'barrido', v);
        // Un desplazamiento reasignado dentro del cuerpo (`dy += 20`) cambia el barrido sin tocar su cabecera.
        for (const a of cuerpo.matchAll(new RegExp(`(?<![\\w$.])${v}\\s*(?:[-+*/%]?=(?![=>])|\\+\\+|--)|(?:\\+\\+|--)\\s*${v}\\b`, 'g'))) if (a.index! > cabecera) add(a.index!, 'barrido', v);
        break;
      }
    }
    for (const m of cuerpo.matchAll(/(?:\(\s*(\[[^\]]*\]|\{[^}]*\})\s*\)|\(([^()]*)\)|(?<![\w$.])([A-Za-z_$][\w$]*))\s*(?::[^=()]*)?=>/g)) {
      for (const v of ligados(m[1] ?? m[2] ?? m[3]!).filter(v => !/^(?:number|string|boolean|Tile|Point|Person)$/.test(v))) if (desplaza(cuerpo, v)) { add(m.index!, 'barrido', v); break; }
    }
    return usos;
  }
  /** Llamadas (o referencias) a otras declaraciones de `src/world` que no son primitivas. */
  llamadas(k: string): Uso[] {
    const d = this.decl.get(k)!, f = this.fuentes.get(d.fichero)!, cuerpo = f.limpio.slice(d.inicio, d.fin), usos: Uso[] = [];
    const locales = new Set<string>();
    for (const m of cuerpo.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)|[,(]\s*([A-Za-z_$][\w$]*)\s*(?:[:,)=]|\?:)|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>|,\s*([A-Za-z_$][\w$]*)\s*=(?![=>])/g)) locales.add(m[1] ?? m[2] ?? m[3] ?? m[4]!);
    let primera = true;
    for (const m of cuerpo.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\b/g)) {
      const nombre = m[1]!;
      if (primera && nombre === d.nombre) { primera = false; continue; }
      if (PRIMITIVA.has(nombre)) continue;
      const antes = cuerpo.slice(0, m.index!).trimEnd(), despues = cuerpo.slice(m.index! + nombre.length);
      if (/\btypeof$/.test(antes) || (/^\s*:(?!:)/.test(despues) && /[{,]$/.test(antes))) continue;
      if (!/^\s*(?:<[^<>()]*>)?\(/.test(despues) && locales.has(nombre)) continue;
      const destino = this.resolver(f, nombre);
      if (destino && destino !== k) usos.push({ fichero: f.fichero, funcion: d.nombre, pos: d.inicio + m.index!, tipo: 'llamada', nombre, llama: destino });
    }
    return usos;
  }
  /** Funciones lectoras que alcanza una raíz por el fuente (las primitivas no se recorren). */
  cierre(raices: readonly string[]): Set<string> {
    const vistas = new Set(raices), cola = [...raices];
    while (cola.length) for (const u of this.llamadas(cola.pop()!)) {
      if (this.lectores.has(u.llama!) && ![...PRIMITIVA.values()].includes(u.llama!) && !vistas.has(u.llama!)) { vistas.add(u.llama!); cola.push(u.llama!); }
    }
    return vistas;
  }
}

interface Tablas extends Inventario {
  readonly serial: readonly Sitio[]; readonly globales: readonly (Sitio & { id: string; fase: Fase })[]; readonly identidad: readonly (Sitio & { id: string; fase: Fase })[];
  readonly recorridos: readonly Sitio[]; readonly escrituras: readonly Sitio[];
}
const TABLAS: Tablas = { ...INVENTARIO, serial: ALCANCES_SERIALES, globales: LECTURAS_GLOBALES, identidad: LECTURAS_POR_IDENTIDAD, recorridos: RECORRIDOS, escrituras: ESCRITURAS };
const lecturasDe = (t: Tablas): readonly Sitio[] => [...t.alcances, ...t.serial, ...t.globales, ...t.identidad, ...t.recorridos, ...t.escrituras];

/** Intervalos [inicio, fin) de cada aparición de cada patrón dentro de la declaración. */
function apariciones(f: Fuente, d: Decl, s: Sitio, problemas: string[]): [number, number][] {
  const texto = f.texto.slice(d.inicio, d.fin), res: [number, number][] = [];
  for (const p of s.patrones) {
    let n = 0;
    // En frontera de símbolo: `<= 3` no casa dentro de `<= 30`, ni `person` dentro de `persons`.
    const frontera = (i: number) => !(/[\w$]/.test(p[0]!) && /[\w$]/.test(texto[i - 1] ?? '')) && !(/[\w$]/.test(p.at(-1)!) && /[\w$]/.test(texto[i + p.length] ?? ''))
      && !(/\d/.test(p.at(-1)!) && /\.\d/.test(texto.slice(i + p.length, i + p.length + 2)));
    for (let i = texto.indexOf(p); i >= 0; i = texto.indexOf(p, i + 1)) if (frontera(i)) { res.push([d.inicio + i, d.inicio + i + p.length]); n++; }
    if (n !== (s.veces ?? 1)) problemas.push(`${s.fichero} (${s.funcion}) el patrón aparece ${n} veces (se esperaban ${s.veces ?? 1}): ${p}`);
  }
  return res;
}
const cubre = (intervalos: readonly [number, number][], pos: number) => intervalos.some(([i, f]) => i <= pos && pos < f);
/** Fin de la cadena de miembros y llamadas que empieza en `desde` (`world.people.filter(…)\n  .map(…)[0]!`): sigue
 * con `.x`, `?.x`, `(…)`, `[…]` y `!`, también tras un salto de línea si la línea siguiente empieza por `.`. */
function finDeCadena(limpio: string, desde: number): number {
  let i = desde;
  for (;;) {
    while (/[\w$]/.test(limpio[i] ?? '')) i++;
    if (limpio[i] === '!' && limpio[i + 1] !== '=') { i++; continue; }
    if (limpio[i] === '(' || limpio[i] === '[') { i = finDeExpresion(limpio, i + 1, true) + 1; continue; }
    let j = i;
    while (/\s/.test(limpio[j] ?? '')) j++;
    if (limpio[j] === '.' && limpio[j + 1] !== '.' || limpio.startsWith('?.', j)) { i = j + (limpio[j] === '?' ? 2 : 1); if (limpio[i] === '(' || limpio[i] === '[') continue; if (!/[\w$]/.test(limpio[i] ?? '')) return i; continue; }
    return i;
  }
}
/** Tramo que tiene que quedar fijado entero para una lectura en `pos` (posición absoluta en el fichero): la cadena
 * que cuelga de ella (`world.people.filter(…).map(…)`, una llamada con sus argumentos) o, si recorre una colección
 * con `for (… of …)`, la cabecera y la condición de la primera sentencia del cuerpo, que es la que acota. */
function tramoDeLectura(limpio: string, pos: number, tipo: Tipo): [number, number] {
  let inicio = pos;
  if (tipo === 'coleccion') while (inicio > 0 && /[\w$.?!]/.test(limpio[inicio - 1]!) && !limpio.slice(0, inicio).endsWith('...')) inicio--;
  const antes = limpio.slice(Math.max(0, inicio - 40), inicio);
  /** Desde `i` (inicio de un cuerpo): la condición del primer `if`, la cabecera del primer `for` o la primera sentencia. */
  const primeraSentencia = (i: number): number => {
    while (/[\s{]/.test(limpio[i] ?? '')) i++;
    if (/^(?:if|for)\b/.test(limpio.slice(i, i + 3))) return finDeExpresion(limpio, limpio.indexOf('(', i) + 1, true) + 1;
    return finDeExpresion(limpio, i);
  };
  if (tipo === 'barrido' || /\bof\s*$/.test(antes)) {
    const abre = limpio.lastIndexOf('for', inicio), cierra = finDeExpresion(limpio, limpio.indexOf('(', abre) + 1, true);
    return [abre, tipo === 'barrido' ? cierra + 1 : primeraSentencia(cierra + 1)];
  }
  // `world.structures.flatMap(s => { … })`: como un `for`, hasta lo que acota en la primera sentencia del cuerpo.
  const bloque = /^[\w$.?!]*\s*\.\s*[\w$]+\s*\(\s*(?:[\w$]+|\([^()]*\))\s*=>\s*\{/.exec(limpio.slice(pos));
  if (bloque) return [inicio, primeraSentencia(pos + bloque[0].length)];
  return [inicio, finDeCadena(limpio, pos)];
}
/** Primer carácter no blanco de [inicio, fin) sin fijar, o -1. */
function sinFijar(limpio: string, [inicio, fin]: [number, number], intervalos: readonly [number, number][]): number {
  for (let i = inicio; i < fin; i++) if (!/\s/.test(limpio[i]!) && !cubre(intervalos, i)) return i;
  return -1;
}

/** Todas las comprobaciones estáticas: devuelve los problemas (vacío = inventario al día). */
function verificar(textos: Readonly<Record<string, string>>, t: Tablas = TABLAS, halo = HALO_CELDAS): { problemas: string[]; analisis: Analisis; cierres: Map<Fase, Set<string>> } {
  const analisis = new Analisis(textos), problemas: string[] = [];
  const declDe = (s: { fichero: string; funcion: string }) => analisis.decl.get(clave(s.fichero, s.funcion));
  const fuera = new Set(FUERA_DEL_PASO.map(f => clave(f.fichero, f.funcion)));
  for (const k of [...fuera, ...PRIMITIVA.values()]) if (!analisis.decl.has(k)) problemas.push(`${k}: declaración inexistente`);
  // Intervalos cubiertos por función, separados en lecturas y llamadas.
  const lecturas = new Map<string, [number, number][]>(), llamadas = new Map<string, Map<string, [number, number][]>>();
  for (const s of lecturasDe(t)) {
    const d = declDe(s);
    if (!d) { problemas.push(`${s.fichero} (${s.funcion}): declaración inexistente`); continue; }
    const k = clave(s.fichero, s.funcion);
    lecturas.set(k, [...lecturas.get(k) ?? [], ...apariciones(analisis.fuentes.get(s.fichero)!, d, s, problemas)]);
  }
  for (const l of t.llamadas) {
    const d = declDe(l);
    if (!d) { problemas.push(`${l.fichero} (${l.funcion}): declaración inexistente`); continue; }
    const k = clave(l.fichero, l.funcion), porDestino = llamadas.get(k) ?? new Map<string, [number, number][]>();
    porDestino.set(l.llama, [...porDestino.get(l.llama) ?? [], ...apariciones(analisis.fuentes.get(l.fichero)!, d, l, problemas)]);
    llamadas.set(k, porDestino);
    if (!analisis.lectores.has(l.llama) || [...PRIMITIVA.values()].includes(l.llama)) problemas.push(`${l.id}: ${l.llama} no es una función del paso que lea el mundo`);
  }
  // Raíces y cierres de las fases con halo, desde el fuente.
  const cierres = new Map<Fase, Set<string>>();
  for (const fase of FASES_CON_HALO) {
    const raices = t.raices.filter(r => r.fase === fase).map(r => clave(r.fichero, r.funcion));
    for (const r of raices) if (!analisis.decl.has(r)) problemas.push(`raíz inexistente: ${r}`);
    cierres.set(fase, analisis.cierre(raices.filter(r => analisis.decl.has(r))));
  }
  const estrictas = new Set([...cierres.values()].flatMap(c => [...c]));
  for (const r of t.raices) {
    const d = declDe(r.llamador), f = analisis.fuentes.get(r.llamador.fichero);
    if (!d || !f) { problemas.push(`${r.funcion}: llamador inexistente`); continue; }
    const fijadas = apariciones(f, d, r.llamador, problemas), raiz = clave(r.fichero, r.funcion);
    for (const k of analisis.decl.keys()) for (const u of analisis.llamadas(k)) if (u.llama === raiz && !(k === clave(d.fichero, d.nombre) && cubre(fijadas, u.pos)))
      problemas.push(`${raiz} se llama fuera de su bucle de fase: ${u.fichero}:${lineaDe(analisis.fuentes.get(u.fichero)!, u.pos)} (${u.funcion})`);
    const ids = new Set(lecturasDe(t).map(s => (s as { id?: string }).id));
    for (const id of r.seleccion) if (!ids.has(id)) problemas.push(`${raiz}: selección desconocida ${id}`);
  }
  // Red estricta en las funciones que alcanzan las fases con halo; red de la tarea en el resto del paso.
  const RED_TAREA = new RegExp(`(?<![\\w$])(?<![^.]\\.)(?:world|host)\\s*\\.\\s*(?:${[...NOMBRES_DE_COLECCION].join('|')})\\b`);
  const CONSULTA = /distance\(|Math\.hypot\(|\.(?:filter|some|find|findIndex|findLast|includes|every|reduce|map|flatMap|forEach|slice|sort|indexOf|at)\(|\bof\s+(?:world|host)\.|(?:world|host)\.\w+\s*\[/;
  for (const [k, d] of analisis.decl) {
    if (fuera.has(k) || [...PRIMITIVA.values()].includes(k)) continue;
    const f = analisis.fuentes.get(d.fichero)!, cubiertas = lecturas.get(k) ?? [];
    if (estrictas.has(k)) {
      // Una colección pasada como argumento a una llamada fijada vale si el destino declara ese argumento como colección.
      const pasadas = [...llamadas.get(k) ?? []].filter(([destino]) => RECIBEN_COLECCION.has(destino)).flatMap(([, i]) => i);
      for (const u of analisis.usos.get(k)!) {
        if (!cubre(cubiertas, u.pos) && !(u.tipo !== 'barrido' && cubre(pasadas, u.pos))) {
          problemas.push(`${d.fichero}:${lineaDe(f, u.pos)} (${d.nombre}) ${u.tipo} ${u.nombre} sin inventariar: ${textoDe(f, u.pos)}`);
          continue;
        }
        if (u.nombre === 'reflexion' || cubre(pasadas, u.pos)) continue;
        const hueco = sinFijar(f.limpio, tramoDeLectura(f.limpio, u.pos, u.tipo), cubiertas);
        if (hueco >= 0) problemas.push(`${d.fichero}:${lineaDe(f, hueco)} (${d.nombre}) ${u.tipo} ${u.nombre} fijada a medias (falta «${f.texto.slice(hueco, hueco + 40).split('\n')[0]}»): ${textoDe(f, u.pos)}`);
      }
      for (const m of f.limpio.slice(d.inicio, d.fin).matchAll(/(?<![\w$])(?<![^.]\.)(?:world|host|privateHost)\s*\.\s*([A-Za-z_$][\w$]*)/g))
        if (!NOMBRES_DE_COLECCION.has(m[1]!) && !Object.hasOwn(ESTADO_GLOBAL, m[1]!)) problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) campo global ${m[1]} fuera de ESTADO_GLOBAL: ${textoDe(f, d.inicio + m.index!)}`);
      for (const u of analisis.llamadas(k)) {
        if (!analisis.lectores.has(u.llama!)) continue;
        const fijadas = llamadas.get(k)?.get(u.llama!) ?? [];
        if (!cubre(fijadas, u.pos)) { problemas.push(`${d.fichero}:${lineaDe(f, u.pos)} (${d.nombre}) llamada a ${u.llama} sin inventariar: ${textoDe(f, u.pos)}`); continue; }
        // La llamada entera, con sus argumentos: el punto que recibe es parte de la composición.
        const abre = f.limpio.indexOf('(', u.pos), tramo: [number, number] = [u.pos, abre >= 0 && /^\s*(?:<[^<>()]*>)?$/.test(f.limpio.slice(u.pos + u.nombre.length, abre)) ? finDeExpresion(f.limpio, abre + 1, true) + 1 : u.pos + u.nombre.length];
        const hueco = sinFijar(f.limpio, tramo, fijadas);
        if (hueco >= 0) problemas.push(`${d.fichero}:${lineaDe(f, hueco)} (${d.nombre}) llamada a ${u.llama} fijada a medias (falta «${f.texto.slice(hueco, hueco + 40).split('\n')[0]}»): ${textoDe(f, u.pos)}`);
      }
    } else {
      const cuerpo = f.limpio.slice(d.inicio, d.fin), lineas = cuerpo.split('\n'), avisadas = new Set<number>();
      let pos = d.inicio;
      // Por cadena: la colección y la expresión que cuelga de ella hasta `,` `;` o el paréntesis que la cierra,
      // aunque ocupe varias líneas (`...world.structures\n  .filter(…)`).
      for (const m of cuerpo.matchAll(new RegExp(RED_TAREA.source, 'g'))) {
        const cadena = cuerpo.slice(Math.max(0, m.index! - 12), finDeExpresion(cuerpo, m.index! + m[0].length));
        if (CONSULTA.test(cadena) && !cubre(cubiertas, d.inicio + m.index!)) {
          avisadas.add(d.inicio + m.index!);
          problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) lectura sin inventariar: ${textoDe(f, d.inicio + m.index!)}`);
        }
      }
      for (const linea of lineas) {
        if (RED_TAREA.test(linea) && CONSULTA.test(linea)) for (const m of linea.matchAll(new RegExp(RED_TAREA.source, 'g'))) if (!cubre(cubiertas, pos + m.index!) && !avisadas.has(pos + m.index!))
          problemas.push(`${d.fichero}:${lineaDe(f, pos)} (${d.nombre}) lectura sin inventariar: ${textoDe(f, pos)}`);
        for (const m of linea.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) if (PRIMITIVA.has(m[1]!) && !cubre(cubiertas, pos + m.index!))
          problemas.push(`${d.fichero}:${lineaDe(f, pos)} (${d.nombre}) primitiva ${m[1]} sin inventariar: ${textoDe(f, pos)}`);
        pos += linea.length + 1;
      }
    }
  }
  // Las tablas de las fases con halo sólo hablan de funciones que las alcanzan, y en su fase.
  for (const e of t.alcances) if (!estrictas.has(clave(e.fichero, e.funcion))) problemas.push(`${e.id}: su función no alcanza ninguna fase con halo (va en ALCANCES_SERIALES)`);
  for (const l of t.llamadas) if (!estrictas.has(clave(l.fichero, l.funcion))) problemas.push(`${l.id}: la llamada sale de una función que no alcanza ninguna fase con halo`);
  for (const e of [...t.globales, ...t.identidad]) {
    const fases = FASES_CON_HALO.filter(fase => cierres.get(fase)!.has(clave(e.fichero, e.funcion)));
    if (fases.length && !fases.includes(e.fase)) problemas.push(`${e.id}: su función está en la fase ${fases.join('/')}, no en ${e.fase}`);
  }
  for (const fase of FASES_CON_HALO) {
    const inventario = [...funcionesDeFase(fase, t)].sort(), fuente = [...cierres.get(fase)!].sort();
    if (inventario.join() !== fuente.join()) problemas.push(`fase ${fase}: el grafo del inventario (${inventario.join(', ')}) no es el del fuente (${fuente.join(', ')})`);
  }
  // Umbrales de distancia: número ≤ halo, constante de radio, o dentro de un patrón fijado; si no, declarado.
  for (const [k, d] of analisis.decl) {
    if (fuera.has(k)) continue;
    const f = analisis.fuentes.get(d.fichero)!, cuerpo = f.limpio.slice(d.inicio, d.fin), cubiertas = [...lecturas.get(k) ?? [], ...[...llamadas.get(k)?.values() ?? []].flat()];
    for (const m of cuerpo.matchAll(/(?<![\w$.])(?:distance|Math\.hypot)\(/g)) {
      const cierra = finDeExpresion(cuerpo, m.index! + m[0].length, true), resto = cuerpo.slice(cierra + 1), op = /^\s*(<=|>=|<|>)(?!=)\s*/.exec(resto);
      // Umbral a la derecha (`distance(…) <= 7`) o a la izquierda (`7 >= distance(…)`).
      const izquierda = /(?:<=|>=|(?<![=>])<|(?<![=-])>)$/.exec(cuerpo.slice(0, m.index!).trimEnd());
      if (!op && !izquierda) continue;
      const umbral = op ? operando(cuerpo, cierra + 1 + op[0].length) : operandoIzquierdo(cuerpo, m.index! - (cuerpo.slice(0, m.index!).length - cuerpo.slice(0, m.index!).trimEnd().length) - izquierda![0].length), numero = /^\d+(?:\.\d+)?$/.test(umbral) ? Number(umbral) : undefined;
      if (numero !== undefined ? numero <= halo : Object.hasOwn(CONSTANTES_DE_RADIO, umbral)) continue;
      if (/^(?:distance|Math\.hypot)\(/.test(umbral) && finDeExpresion(umbral, umbral.indexOf('(') + 1, true) === umbral.length - 1) continue; // distancia contra distancia
      if (cubre(cubiertas, d.inicio + m.index!) || UMBRALES_QUE_NO_SON_LECTURAS.some(u => u.fichero === d.fichero && u.funcion === d.nombre && u.umbral === umbral)) continue;
      problemas.push(`${d.fichero}:${lineaDe(f, d.inicio + m.index!)} (${d.nombre}) umbral ${umbral} fuera del halo o sin inventariar`);
    }
  }
  for (const [nombre, c] of Object.entries(CONSTANTES_DE_RADIO)) {
    const valor = Number(new RegExp(`\\bconst ${nombre} = (\\d+(?:\\.\\d+)?);`).exec(textos[c.fichero] ?? '')?.[1]);
    if (valor !== c.valor) problemas.push(`${nombre} vale ${valor} en ${c.fichero}, el inventario dice ${c.valor}`);
    if (c.valor > halo) problemas.push(`${nombre} = ${c.valor} supera el halo`);
  }
  for (const m of (textos['inventions.ts'] ?? '').matchAll(/functionalNear\(world, \w+, ([\d.]+)\)/g)) if (Number(m[1]) > 1.5) problemas.push(`functionalNear con radio ${m[1]} > 1,5`);
  // Composición.
  try { for (const e of excesos(t, halo)) problemas.push(`${e.id} (${e.fase}) alcanza ${e.alcance} > ${halo}`); }
  catch (error) { problemas.push(String(error)); }
  return { problemas, analisis, cierres };
}

const BASE = verificar(FUENTES);
const conHalo = (fase: Fase) => [...alcancesDeFase(fase, undefined, INVENTARIO)].filter(([id]) => !ALCANCES.find(e => e.id === id)!.excepcion);
const maximoSerial = (fase: Fase, params = HISTORICAL_PARAMS) => Math.max(...ALCANCES_SERIALES.filter(e => e.fase === fase).map(e => alcanceSerial(e.id, ALCANCES_SERIALES, params)!));

test('el inventario cubre cada lectura, llamada y barrido de las fases con halo y ninguna entrada está obsoleta', () => {
  assert.deepEqual(BASE.problemas, []);
  const ids = [...lecturasDe(TABLAS), ...LLAMADAS].map(e => (e as { id?: string }).id).filter(Boolean);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'ids repetidos en el inventario');
  for (const e of ALCANCES) assert.ok(e.centro === 'entrada' || ALCANCES.some(c => c.id === e.centro), `centro desconocido: ${e.id} → ${e.centro}`);
  for (const l of LLAMADAS) assert.ok(l.centro === 'entrada' || ALCANCES.some(c => c.id === l.centro), `centro desconocido: ${l.id} → ${l.centro}`);
  for (const e of ALCANCES_SERIALES) assert.ok(e.centro === 'actor' || ALCANCES_SERIALES.some(c => c.id === e.centro), `centro desconocido: ${e.id} → ${e.centro}`);
});

test('las funciones que alcanza cada fase con halo son las del fuente', () => {
  const tamanos = Object.fromEntries(FASES_CON_HALO.map(fase => [fase, BASE.cierres.get(fase)!.size]));
  assert.deepEqual(tamanos, { decision: 58, ecologia: 6, fauna: 3 });
  for (const fase of FASES_CON_HALO) assert.deepEqual([...funcionesDeFase(fase, INVENTARIO)].sort(), [...BASE.cierres.get(fase)!].sort());
  // Lecturas que ninguna tabla cubre si la red estricta no se aplicara (lo que la red de la tarea no veía).
  const decision = BASE.cierres.get('decision')!;
  for (const k of ['society.ts:itemNeed', 'society.ts:settlementOpportunity', 'inventions.ts:candidatesFromKnown', 'inventions.ts:functionalNear']) assert.ok(decision.has(k), k);
});

test('el alcance compuesto de las fases con halo no supera HALO_CELDAS, y el máximo es exactamente el halo', () => {
  assert.deepEqual(excesos(INVENTARIO), []);
  const decision = new Map(conHalo('decision'));
  const numericos = [...decision].filter(([id]) => typeof ALCANCES.find(e => e.id === id)!.radio === 'number');
  assert.equal(Math.max(...numericos.map(([, v]) => v!)), HALO_CELDAS);
  // 7 + 7 desde el otro de la cooperación y los almacenes V20; G2 sigue en 13.
  assert.deepEqual(numericos.filter(([, v]) => v === HALO_CELDAS).map(([id]) => id).sort(), [
    'cooperacion.destinoDelOtro', 'cooperacion.insumos', 'cooperacion.necesidad', 'obra.almacenes',
  ]);
  assert.deepEqual(['asentamiento.hogar.personas', 'asentamiento.hogar.teselas', 'asentamiento.hogar.estructuras', 'asentamiento.lugares.personas', 'decision.obra', 'estructuras.funcionales', 'obra.materiales']
    .map(id => decision.get(id)), [13, 11, 12, 12, 12, 13.5, 7]);
  assert.deepEqual(['obra.polimino.celdas', 'obra.polimino.terreno', 'obra.huella.colisiones', 'obra.ampliablesPoliminos', 'tecnologia.mundoSinergia']
    .map(id => decision.get(id)), [8, 5, 13, 3, 0]);
  // Fijar los límites de los auxiliares puros de los que dependen los radios;
  // seis celdas conexas válidas pueden extenderse cinco, aunque el generador use ±2.
  assert.match(FUENTES['inventions.ts']!, /const structureSearchRadius = \(world: World, legacy: number\) => paramsOf\(world\)\.construccion\.poliminosYSinergia \? Math\.min\(3, legacy\) : legacy;/);
  assert.match(FUENTES['inventions.ts']!, /const ORTHOGONAL = \[\[1, 0\], \[0, 1\], \[-1, 0\], \[0, -1\]\] as const;/);
  assert.match(FUENTES['validation.ts']!, /cells\.length>6/);
  assert.match(FUENTES['validation.ts']!, /if\(reached\.size!==keys\.size\)fail\(\);/);
  const porColeccion = (coleccion: Alcance['coleccion']) => Math.max(...numericos.filter(([id]) => ALCANCES.find(e => e.id === id)!.coleccion === coleccion).map(([, v]) => v!));
  assert.deepEqual({ teselas: porColeccion('teselas'), personas: porColeccion('personas'), estructuras: porColeccion('estructuras'), lugares: porColeccion('lugares') },
    { teselas: 14, personas: 13, estructuras: 14, lugares: 12 });
  assert.deepEqual(Object.fromEntries(FASES_CON_HALO.map(fase => [fase, Math.max(...conHalo(fase).map(([, v]) => v ?? 0))])), { decision: 14, ecologia: 1, fauna: 12 });
  // La memoria de la fauna: 6 celdas vistas + 480 pasos de vida a un paso de celda cada ≥ 4 pasos, sólo presencia.
  assert.equal(alcancesDeFase('fauna').get('fauna.memoria'), 6 + Number(/const MEMORY_TTL = (\d+);/.exec(FUENTES['animals.ts']!)![1]) / (11 - 7));
  assert.match(FUENTES['animals.ts']!, /const interval = Math\.ceil\(11 - animal\.genes\.speed \* 7 \+ animal\.fatigue \* 3\);/);
});

test('quién actúa en una fase con halo lo decide la fase serial: el destino propio y dos selecciones globales de la fauna', () => {
  const decision = RAICES.find(r => r.fase === 'decision')!, fauna = RAICES.find(r => r.fase === 'fauna')!;
  assert.equal(Math.max(...decision.seleccion.map(id => alcanceSerial(id)!)), 4096, 'el disparador de destino agotado lee el destino propio');
  for (const id of fauna.seleccion) {
    const e = LECTURAS_GLOBALES.find(g => g.id === id)!;
    // T116: el coordinador (`mascaraFauna`/`calcularMascara`) calcula la ventana antes de repartir
    // `choose`; `fauna.turno` sigue en `stepAnimals`, `fauna.ventana` se movió a `calcularMascara`.
    assert.equal(e.fase, 'fauna'); assert.ok(['stepAnimals', 'calcularMascara'].includes(e.funcion), e.funcion);
  }
  assert.match(FUENTES['animals.ts']!, /export const MAX_ACTIVE_ANIMALS = 8192;/);
  assert.match(FUENTES['animals.ts']!, /export const MAX_ANIMAL_DECISIONS_PER_TICK = 1024;/);
});

test('alcances fijados de las fases seriales, que el halo no acota', () => {
  const fases: Fase[] = ['faunaSerial', 'accion', 'gestos', 'estructuras', 'encuentros', 'demografia', 'comunidades', 'reproduccion'];
  assert.deepEqual(Object.fromEntries(fases.map(f => [f, maximoSerial(f)])), {
    faunaSerial: 1, accion: 4096, gestos: 7, estructuras: 13, encuentros: 3, demografia: 2, comunidades: 7, reproduccion: 4,
  });
  assert.equal(alcanceSerial('accion.caminable'), 24, 'la búsqueda de ruta de `move` lee terreno y presencia a 24 celdas');
  assert.match(FUENTES['index.ts']!, /Math\.max\(Math\.abs\(x - start\.x\), Math\.abs\(y - start\.y\)\) > 24/);
  const activacion = ESCRITURAS.find(e => e.id === 'activacion')!;
  assert.equal(activacion.radio, 8 + CHUNK_SIZE - 1);
  assert.ok(activacion.radio > HALO_CELDAS, 'el área escrita supera el halo de lectura: la activación queda en el coordinador');
  assert.match(FUENTES['index.ts']!, /earlierForagerExhausts\(person, tile, workers, work, \{\s*tick: world\.tick, radius: RADIUS,/);
});

test('radios de parámetros: el cortejo de reglas 10 exige 128 celdas y el histórico cabe en el halo', () => {
  assert.deepEqual(haloRequerido(HISTORICAL_PARAMS), { celdas: HALO_CELDAS, causa: 'cooperacion.destinoDelOtro' });
  assert.equal(DEFAULT_PARAMS.poblacion.cortejo > 0, true, 'reglas 10 activa el cortejo');
  assert.deepEqual(haloRequerido(DEFAULT_PARAMS), { celdas: DEFAULT_PARAMS.poblacion.radioCortejo, causa: 'decision.cortejo' });
  assert.equal(DEFAULT_PARAMS.poblacion.radioCortejo, 128);
  assert.equal(haloRequerido(parseParams('poblacion.cortejo=0,poblacion.radioCortejo=128', DEFAULT_PARAMS)).celdas, HALO_CELDAS);
  const claves: ClaveDeRadio[] = ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo', 'social.disputaRadio'];
  const exceden = claves.filter(clave => {
    const params = parseParams(`${clave}=${PARAM_RANGES[clave]![1]},poblacion.cortejo=1`, HISTORICAL_PARAMS);
    return ALCANCES_SERIALES.some(e => typeof e.radio !== 'number' && e.radio.param === clave && alcanceSerial(e.id, ALCANCES_SERIALES, params)! > HALO_CELDAS)
      || ALCANCES.some(e => typeof e.radio !== 'number' && e.radio.param === clave && alcancesDeFase('decision', params).get(e.id)! > HALO_CELDAS);
  });
  assert.deepEqual(exceden, ['poblacion.radioPareja', 'poblacion.radioLugar', 'poblacion.radioCortejo']);
  // Este caso fija las reglas históricas sin construcción modular; la composición de
  // todas las ramas V19 se comprueba arriba con INVENTARIO, también si su bandera está apagada.
  assert.equal(DEFAULT_PARAMS.construccion.modular, false);
  assert.deepEqual(excesos(INVENTARIO_BASE, HALO_CELDAS, DEFAULT_PARAMS), [{ id: 'decision.cortejo', fase: 'decision', alcance: 128 }]);
});

/** Aplica sustituciones literales (cada texto viejo debe aparecer una sola vez) a una copia de las fuentes. */
function mutar(cambios: readonly [fichero: string, viejo: string, nuevo: string][]): Record<string, string> {
  const textos = { ...FUENTES };
  for (const [fichero, viejo, nuevo] of cambios) {
    assert.equal(textos[fichero]!.split(viejo).length, 2, `el texto a mutar no aparece una vez en ${fichero}: ${viejo}`);
    textos[fichero] = textos[fichero]!.replace(viejo, nuevo);
  }
  return textos;
}
const detecta = (textos: Record<string, string>, esperado: RegExp, t: Tablas = TABLAS) => {
  const { problemas } = verificar(textos, t);
  assert.ok(problemas.some(p => esperado.test(p)), `no detectado (${esperado}):\n${problemas.join('\n') || '(sin problemas)'}`);
};

test('la prueba muerde: las siete mutaciones de la verificación, una composición 7 + 8 en el código y otras formas de leer más lejos fallan', () => {
  const eleccion = "  const partner = nearbyPeople.find(other => person.role !== 'neighbor' && other.role !== 'neighbor');";
  // M0: un halo de 13 no basta.
  assert.deepEqual(excesos(INVENTARIO, 13).map(e => e.id).sort(), [
    'cooperacion.destinoDelOtro', 'cooperacion.insumos', 'cooperacion.necesidad', 'estructuras.funcionales', 'obra.almacenes',
  ]);
  // M1: la percepción de `choose` a 3 · RADIUS.
  detecta(mutar([['index.ts', 'for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {\n    if (dx * dx + dy * dy > RADIUS * RADIUS) continue;',
    'for (let dy = -3 * RADIUS; dy <= 3 * RADIUS; dy++) for (let dx = -3 * RADIUS; dx <= 3 * RADIUS; dx++) {\n    if (dx * dx + dy * dy > 9 * RADIUS * RADIUS) continue;']]),
  /index\.ts:\d+ \(choose\) barrido dy sin inventariar/);
  // M2: la percepción de la fauna × 5.
  detecta(mutar([['animals.ts', 'for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {\n    if (Math.abs(dx) + Math.abs(dy) > radius) continue;',
    'for (let dy = -radius * 5; dy <= radius * 5; dy++) for (let dx = -radius * 5; dx <= radius * 5; dx++) {\n    if (Math.abs(dx) + Math.abs(dy) > radius * 5) continue;']]),
  /animals\.ts:\d+ \(localTiles\) barrido dy sin inventariar/);
  // M3: comida del destino del otro: 7 + 7 + 6,5 (servicio + extensión válida V20).
  detecta(mutar([['society.ts', "import { activeSiteAt, contributeConstruction, partnerConstructionCost, storedMaterialsNear, structureDistance, waterAvailable } from './inventions.js';", "import { activeSiteAt, contributeConstruction, foodAvailable, partnerConstructionCost, storedMaterialsNear, structureDistance, waterAvailable } from './inventions.js';"],
    ['society.ts', '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);',
      '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);\n    if (foodAvailable(world, person.target) > 0) need = Math.max(need, 0.1);']]),
  /society\.ts:\d+ \(itemNeed\) llamada a inventions\.ts:foodAvailable sin inventariar/);
  // …y si alguien la inventaría con su centro honesto, la composición supera el halo.
  const m3 = mutar([['society.ts', "import { activeSiteAt, contributeConstruction, partnerConstructionCost, storedMaterialsNear, structureDistance, waterAvailable } from './inventions.js';", "import { activeSiteAt, contributeConstruction, foodAvailable, partnerConstructionCost, storedMaterialsNear, structureDistance, waterAvailable } from './inventions.js';"],
    ['society.ts', '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);',
      '    if (useful && capacities[useful] > Math.max(0.12, powers[useful] + 0.12)) need = Math.max(need, capacities[useful] - powers[useful]);\n    if (foodAvailable(world, person.target) > 0) need = Math.max(need, 0.1);']]);
  const honesta: Llamada = { id: 'itemNeed→foodAvailable', fichero: 'society.ts', funcion: 'itemNeed', llama: 'inventions.ts:foodAvailable', centro: 'cooperacion.necesidad', patrones: ['foodAvailable(world, person.target)'] };
  detecta(m3, /estructuras\.funcionales \(decision\) alcanza 20\.5 > 14/, { ...TABLAS, llamadas: [...LLAMADAS, honesta] });
  // M4: una suma de estructuras a 30 con `.reduce`.
  detecta(mutar([['society.ts', '    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);',
    '    food += facilities.reduce((sum,s)=>sum+s.food,0); water += facilities.reduce((sum,s)=>sum+s.water,0);\n    food += world.structures.reduce((sum, s) => sum + (Math.abs(s.x - place.x) <= 30 && Math.abs(s.y - place.y) <= 30 ? s.food : 0), 0);']]),
  /society\.ts:\d+ \(settlementOpportunity\) coleccion structures sin inventariar/);
  // M5: un bucle indexado sobre `world.people`.
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  let lejanos = 0;\n  for (let i = 0; i < world.people.length; i++) if (Math.hypot(world.people[i]!.x - person.x, world.people[i]!.y - person.y) <= 40) lejanos++;`]]),
    /index\.ts:\d+ \(choose\) coleccion people sin inventariar/);
  // M6: un nombre `radius` que no es el de `functionalNear` ni el de la fauna.
  const m6 = mutar([['index.ts', eleccion, `${eleccion}\n  const radius = 40, lejanos = world.people\n    .filter(o => distance(person, o) <= radius);`]]);
  detecta(m6, /index\.ts:\d+ \(choose\) coleccion people sin inventariar/);
  detecta(m6, /index\.ts:\d+ \(choose\) umbral radius fuera del halo o sin inventariar/);
  // M7: la fauna mira una celda a 40 por `state.tile`.
  detecta(mutar([['animals.ts', '  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);',
    '  const visible = localTiles(animal, state), near = visible.flatMap(t => state.occupants.get(cell(t)) ?? []).filter(a => a.id !== animal.id && a.health > 0);\n  const horizonte = state.tile(animal.x + 40, animal.y);']]),
  /animals\.ts:\d+ \(choose\) estado tile sin inventariar/);
  // Composición 7 + 8 en el código: estructuras a ≤ 8 del otro de la cooperación (a ≤ 7). Sin inventariar falla la
  // cobertura; inventariada con su centro, ninguna de las dos lecturas supera 14 y su composición sí.
  const m8 = mutar([['society.ts', '  const skill = learner.action;', '  const skill = learner.action;\n  if (algunoCerca(world.structures, learner, 9, s => distance(s, learner) <= 8)) return;']]);
  detecta(m8, /society\.ts:\d+ \(practicedSkillToTeach\) coleccion structures sin inventariar/);
  const ocho: Alcance = { id: 'sintetico.ocho', coleccion: 'estructuras', centro: 'entrada', radio: 8, fichero: 'society.ts', funcion: 'practicedSkillToTeach',
    patrones: ['algunoCerca(world.structures, learner, 9, s => distance(s, learner) <= 8)'] };
  assert.ok(ALCANCES.find(e => e.id === 'cooperacion.otro')!.radio === 7 && ocho.radio === 8);
  detecta(m8, /sintetico\.ocho \(decision\) alcanza 15 > 14/, { ...TABLAS, alcances: [...ALCANCES, ocho] });
  // Un alias de una lectura usado de nuevo, una constante de radio cambiada y una raíz llamada desde otro sitio.
  detecta(mutar([['index.ts', 'waterAt(tile.x, tile.y + 1);', 'waterAt(tile.x, tile.y + 1) || waterAt(tile.x + 20, tile.y);']]), /index\.ts:\d+ \(ecology\) alias waterAt sin inventariar/);
  detecta(mutar([['index.ts', 'const RADIUS = 7;', 'const RADIUS = 21;']]), /RADIUS vale 21 en index\.ts/);
  detecta(mutar([['index.ts', '  const tile = tileIn(person.x, person.y)!;\n  const tileCell', '  const tile = tileIn(person.x, person.y)!;\n  if (world.tick < 0) choose(world, person);\n  const tileCell']]),
    /index\.ts:choose se llama fuera de su bucle de fase/);
  // Una lectura fijada que cambia por dentro: umbral 3 → 30 (el patrón casa en frontera de símbolo), un predicado que
  // se amplía, una sentencia antes del filtro que acota un `for`, un desplazamiento reasignado dentro del barrido.
  detecta(mutar([['inventions.ts', 'distance(person, other) <= 3', 'distance(person, other) <= 30']]), /inventions\.ts \(knownBlueprints\) el patrón aparece 0 veces/);
  // T141: la búsqueda de personas ahora pasa por `vecinos` (rejilla.ts), una primitiva; el predicado
  // ampliado se detecta como esa primitiva fijada a medias, no ya como una colección suelta.
  detecta(mutar([['family.ts', '    && !closeKin(person, other) && reproductiveReadiness(world, other)', '    && !closeKin(person, other) && reproductiveReadiness(world, other) || Math.abs(other.x - person.x) < 40 && other.hunger > 2']]),
    /family\.ts:\d+ \(familyOpportunity\) primitiva vecinos fijada a medias/);
  detecta(mutar([['society.ts', "for (const other of vecinos(world, person, 8, other => !(other === person || distance(person, other) > 7), 'cooperationOpportunity')) {",
    "for (const other of vecinos(world, person, 8, other => !(other === person || distance(person, other) > 7) || Math.abs(other.x - person.x) < 40 && other.hunger > 2, 'cooperationOpportunity')) {"]]),
  /society\.ts:\d+ \(evaluateCooperation\) primitiva vecinos sin inventariar/);
  detecta(mutar([['index.ts', "      const tile = tileIn(x, y); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);",
    "      dx += 20; const tile = tileIn(x, y); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);"]]), /index\.ts:\d+ \(choose\) barrido dx sin inventariar/);
  // El mundo por otro camino: un campo global nuevo, el mundo con otro tipo, y una lectura serial repartida en dos líneas.
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  if (world.events.length > 1e9) return;`]]), /index\.ts:\d+ \(choose\) campo global events fuera de ESTADO_GLOBAL/);
  detecta(mutar([['index.ts', eleccion, `${eleccion}\n  const todos = (world as unknown as Record<string, unknown[]>)['peo' + 'ple'];`]]), /index\.ts:\d+ \(choose\) coleccion reflexion sin inventariar/);
  detecta(mutar([['index.ts', '  let transferred=0;', '  const lejanos = world.people\n    .filter(other => distance(person, other) <= 40);\n  let transferred=0;']]), /index\.ts:\d+ \(transferEstate\) lectura sin inventariar/);
  // V20: un cast del host vuelve a disparar reflexión; no se permite inventariarlo
  // como una lectura local para esconder el acceso al mundo entero.
  detecta(mutar([['technology.ts', 'host.structures && host.tiles', '(host as World).structures && host.tiles']]),
    /technology\.ts:\d+ \(synergyWorld\) coleccion reflexion sin inventariar/);
  // Aunque se actualice honestamente el patrón, ampliar el ancla al radio 8
  // desde el hogar o el socio a 7 produce 15. Ambos límites son necesarios.
  for (const [fichero, funcion, id, punto, radio] of [
    ['society.ts', 'settlementOpportunity', 'asentamiento.hogar.estructuras', 'place', 5],
    ['inventions.ts', 'warehousesNear', 'obra.almacenes', 'person', 7],
  ] as const) {
    const viejo = `Math.abs(s.x - ${punto}.x) <= ${radio} && Math.abs(s.y - ${punto}.y) <= ${radio}`;
    const nuevo = `Math.abs(s.x - ${punto}.x) <= 8 && Math.abs(s.y - ${punto}.y) <= 8`;
    const textos = mutar([[fichero, viejo, nuevo]]);
    detecta(textos, new RegExp(`${fichero.replace('.', '\\.')} \\(${funcion}\\) el patrón aparece 0 veces`));
    const alcances = ALCANCES.map(e => e.fichero === fichero && e.funcion === funcion && e.patrones.some(p => p.includes(viejo))
      ? { ...e, radio: 8, patrones: e.patrones.map(p => p.replace(viejo, nuevo)) } : e);
    detecta(textos, new RegExp(`${id.replaceAll('.', '\\.')} \\(decision\\) alcanza 15 > 14`), { ...TABLAS, alcances });
  }
  detecta(mutar([['inventions.ts', 'Math.abs(p.x - anchor.x) > 2 || Math.abs(p.y - anchor.y) > 2',
    'Math.abs(p.x - anchor.x) > 20 || Math.abs(p.y - anchor.y) > 20']]), /inventions\.ts \(fittingPolyomino\) el patrón aparece 0 veces/);
  // Un ciclo de centros en el inventario no se suma: lanza.
  assert.throws(() => alcancesDeFase('decision', undefined, { ...INVENTARIO, alcances: [...ALCANCES, { ...ocho, centro: 'sintetico.ciclo', id: 'sintetico.ciclo' }] }), /Ciclo/);
});

test('coste del halo: fracción de celdas leídas de las regiones vecinas', () => {
  const casi = (valor: number, esperado: number) => assert.ok(Math.abs(valor - esperado) < 1e-4, `${valor} ≠ ${esperado}`);
  casi(fraccionBorde(256, 8), 0.1289);
  casi(fraccionBorde(256, 13), 0.2134);
  casi(fraccionBorde(256, 14), 0.2307);
  casi(fraccionBorde(512, 13), 0.1041);
  casi(fraccionBorde(512, 14), 0.1124);
  casi(fraccionBorde(256, 128), 3);
  casi(fraccionBorde(512, 128), 1.25);
});
