import type { World } from './index.js';
import { worldContext } from './spatial.js';
import { tileLookup } from './tile-index.js';
import { conRejilla, vecinos } from './rejilla.js';
import { animalesVivosEnCelda, conRejillaFauna } from './animals.js';
import { resolveTechnologyRecipe } from './technology-catalogue.js';
import { ELEMENTS, vectorMass } from '../shared/chemistry.js';
import type { CompoundLot } from '../shared/chemistry.js';
import { CHUNK_SIZE, chunkKey } from './terrain.js';

export type Gravedad = 'dura' | 'blanda';
export interface RegionRef { chunkX: number; chunkY: number }
export interface Violacion {
  id: string; gravedad: Gravedad; tick: number; detalle: string;
  contexto?: Record<string, unknown>; region?: string;
  esperado?: number; observado?: number; muestra?: unknown;
}
export interface Invariante {
  id: string; carril: string; gravedad: Gravedad; cadaTicks: number;
  alcance: 'global' | 'region';
  comprobar(mundo: World, region?: RegionRef): Violacion[];
}

const registro = new Map<string, Invariante>();
/** Devuelve el retiro del registro para módulos descargables y pruebas aisladas. */
export function registrar(invariante: Invariante): () => void {
  if (!invariante.id || registro.has(invariante.id) || !Number.isSafeInteger(invariante.cadaTicks) || invariante.cadaTicks < 1) {
    throw new Error(`Registro de invariante inválido o duplicado: ${invariante.id}`);
  }
  const entrada = Object.freeze({ ...invariante });
  registro.set(entrada.id, entrada);
  return () => { if (registro.get(entrada.id) === entrada) registro.delete(entrada.id); };
}
export function listaInvariantes(): readonly Invariante[] { return [...registro.values()]; }

export function comprobarInvariante(inv: Invariante, mundo: World, region?: RegionRef): Violacion[] {
  try {
    return inv.comprobar(mundo, region).map(v => ({ ...v, id: inv.id, gravedad: inv.gravedad, tick: mundo.tick }));
  } catch (error) {
    return [{ id: inv.id, gravedad: 'dura', tick: mundo.tick, detalle: 'El comprobador lanzó una excepción.',
      contexto: { error: error instanceof Error ? error.message : String(error) } }];
  }
}
/** Sin cadencia por defecto: las pruebas comprueban TODAS las leyes en cada barrera de fin de paso. */
export function comprobarInvariantes(mundo: World, opciones: { region?: RegionRef; ids?: readonly string[]; cadencia?: boolean } = {}): Violacion[] {
  const resultado: Violacion[] = [];
  for (const inv of registro.values()) {
    if (opciones.ids && !opciones.ids.includes(inv.id) || opciones.cadencia && mundo.tick % inv.cadaTicks !== 0) continue;
    resultado.push(...comprobarInvariante(inv, mundo, opciones.region));
  }
  return resultado;
}

type Punto = { x: number; y: number };
const enRegion = (p: Punto, r?: RegionRef): boolean => !r || Math.floor(p.x / CHUNK_SIZE) === r.chunkX && Math.floor(p.y / CHUNK_SIZE) === r.chunkY;
function teselas(m: World, r?: RegionRef): World['tiles'] {
  if (!r) return m.tiles;
  const encontrar = tileLookup(m.tiles), resultado: World['tiles'] = [];
  for (let y = r.chunkY * CHUNK_SIZE; y < (r.chunkY + 1) * CHUNK_SIZE; y++) {
    for (let x = r.chunkX * CHUNK_SIZE; x < (r.chunkX + 1) * CHUNK_SIZE; x++) {
      const t = encontrar(x, y); if (t) resultado.push(t);
    }
  }
  return resultado;
}
function inicial(id: string, alcance: Invariante['alcance'], comprobar: Invariante['comprobar'], cadaTicks = 60): void {
  registrar({ id, carril: '0C', gravedad: 'dura', cadaTicks, alcance, comprobar });
}
function hallazgos(id: string, m: World, region?: RegionRef) {
  const resultado: Violacion[] = [];
  const fallo = (detalle: string, contexto: Record<string, unknown>, esperado?: number, observado?: number): void => {
    resultado.push({ id, gravedad: 'dura', tick: m.tick, detalle, contexto, esperado, observado,
      ...(region ? { region: `${region.chunkX},${region.chunkY}` } : {}) });
  };
  const numero = (valor: unknown, campo: string, contexto: Record<string, unknown>, negativo = false): void => {
    if (typeof valor !== 'number' || !Number.isFinite(valor) || !negativo && valor < 0) fallo('Magnitud inválida.', { ...contexto, campo, valor });
  };
  const numeros = (objeto: object, campo: string, contexto: Record<string, unknown>): void => {
    for (const [clave, valor] of Object.entries(objeto)) if (typeof valor === 'number') numero(valor, `${campo}.${clave}`, contexto);
  };
  return { resultado, fallo, numero, numeros };
}

inicial('numeros.cuerpos', 'region', (m, r) => {
  const h = hallazgos('numeros.cuerpos', m, r);
  for (const p of [...m.people, ...m.animals]) if (enRegion(p, r)) {
    const contexto = { entidad: p.id, x: p.x, y: p.y };
    h.numero(p.x, 'x', contexto, true); h.numero(p.y, 'y', contexto, true);
    for (const campo of ['energy', 'hunger', 'thirst', 'fatigue'] as const) h.numero(p[campo], campo, contexto);
    if ('demography' in p) {
      for (const campo of ['health', 'vitality', 'age'] as const) h.numero(p.demography[campo], `demography.${campo}`, contexto);
    } else {
      h.numero(p.health, 'health', contexto); h.numero(p.age, 'age', contexto);
      if (p.reproReserve !== undefined) h.numero(p.reproReserve, 'reproReserve', contexto);
    }
  }
  return h.resultado;
});

inicial('numeros.inventarios', 'region', (m, r) => {
  const h = hallazgos('numeros.inventarios', m, r);
  const lotes = (ls: CompoundLot[] | undefined, contexto: Record<string, unknown>): void => {
    for (const lote of ls ?? []) {
      h.numero(lote.mass, 'mass', { ...contexto, lote: lote.id });
      for (const e of ELEMENTS) h.numero(lote.composition[e], `composition.${e}`, { ...contexto, lote: lote.id });
    }
  };
  for (const p of m.people) if (enRegion(p, r)) {
    const contexto = { entidad: p.id, x: p.x, y: p.y };
    h.numero(p.inventory, 'inventory', contexto); h.numeros(p.materials, 'materials', contexto);
    h.numeros(p.technology.residue, 'residue', contexto);
    for (const item of p.technology.items) {
      h.numero(item.mass, 'mass', { ...contexto, item: item.id });
      h.numeros(item.composition, 'composition', { ...contexto, item: item.id });
      if (item.contents) h.numeros(item.contents, 'contents', { ...contexto, item: item.id });
    }
    lotes(p.compounds, contexto);
  }
  for (const s of m.structures) if (enRegion(s, r)) {
    const contexto = { entidad: s.id, x: s.x, y: s.y };
    for (const campo of ['water', 'food', 'condition'] as const) h.numero(s[campo], campo, contexto);
    for (const campo of ['storedWood', 'storedStone'] as const) if (s[campo] !== undefined) h.numero(s[campo], campo, contexto);
    if (s.site) h.numeros(s.site, 'site', contexto);
    for (const item of s.installed ?? []) { h.numero(item.mass, 'installed.mass', contexto); if (item.composition) h.numeros(item.composition, 'installed.composition', contexto); }
    lotes(s.storedCompounds, contexto);
  }
  return h.resultado;
});

inicial('numeros.teselas', 'region', (m, r) => {
  const h = hallazgos('numeros.teselas', m, r);
  for (const t of teselas(m, r)) {
    const contexto = { x: t.x, y: t.y };
    h.numero(t.x, 'x', contexto, true); h.numero(t.y, 'y', contexto, true);
    for (const [campo, valor] of Object.entries(t)) if (campo !== 'x' && campo !== 'y' && typeof valor === 'number') h.numero(valor, campo, contexto);
    for (const campo of ['food', 'moisture', 'vegetation'] as const) h.numero(t[campo], campo, contexto);
  }
  return h.resultado;
});

inicial('identidades.unicas', 'global', m => {
  const h = hallazgos('identidades.unicas', m);
  const conjuntos: [string, readonly { id: string }[]][] = [
    ['personas', m.people], ['animales', m.animals], ['comunidades', m.communities], ['estructuras', m.structures],
    ['lugares', m.places], ['planos', m.blueprints], ['eventos', m.events], ['legado', m.legacy], ['legadoRetirado', m.retiredLegacy],
    ['productos', m.people.flatMap(p => p.technology.items)],
    ['lotes', [...m.people.flatMap(p => p.compounds ?? []), ...m.structures.flatMap(s => s.storedCompounds ?? [])]],
    ['formulas', m.chemistry?.formulas ?? []], ['recetas', m.technology.recipes],
  ];
  for (const [coleccion, lista] of conjuntos) {
    const ids = new Set<string>();
    for (const objeto of lista) {
      if (!objeto.id || ids.has(objeto.id)) h.fallo('Identificador vacío o repetido.', { coleccion, entidad: objeto.id });
      ids.add(objeto.id);
    }
  }
  const vivos = new Set(m.people.map(p => p.id));
  for (const p of [...m.legacy, ...m.retiredLegacy]) if (vivos.has(p.id)) h.fallo('Identidad viva y fallecida a la vez.', { entidad: p.id });
  const coords = new Set<string>();
  for (const t of m.tiles) { const key = `${t.x},${t.y}`; if (coords.has(key)) h.fallo('Tesela repetida.', { x: t.x, y: t.y }); coords.add(key); }
  return h.resultado;
}, 600);

inicial('referencias.validas', 'global', m => {
  const h = hallazgos('referencias.validas', m);
  const vivos = new Set(m.people.map(p => p.id));
  const identidades = new Set([...vivos, ...m.legacy.map(p => p.id), ...m.retiredLegacy.map(p => p.id)]);
  const identidad = (id: string): boolean => {
    if (identidades.has(id)) return true;
    if (worldContext(m).loadLegacy?.(id, m.tick)) { identidades.add(id); return true; }
    return false;
  };
  const lugares = new Set(m.places.map(p => p.id)), comunidades = new Set(m.communities.map(c => c.id)), planos = new Set(m.blueprints.map(b => b.id));
  const lugar = (id: string): boolean => {
    if (lugares.has(id)) return true;
    // Un recuerdo conserva su lugar aunque la región haya pasado al archivo.
    const asentamiento = /^settlement-(-?\d+)-(-?\d+)$/.exec(id);
    const clave = /^landmark:(-?\d+,-?\d+)$/.exec(id)?.[1]
      ?? (asentamiento ? chunkKey(Number(asentamiento[1]), Number(asentamiento[2])) : undefined);
    if (!clave) return false;
    const chunk = m.retiredChunks.find(c => c.key === clave) ?? worldContext(m).loadChunk?.(clave, m.tick);
    if (chunk?.places.some(p => p.id === id)) { lugares.add(id); return true; }
    return false;
  };
  const referencia = (valida: boolean, entidad: string, campo: string, destino: unknown): void => {
    if (!valida) h.fallo('Referencia inexistente.', { entidad, campo, destino });
  };
  const encontrar = tileLookup(m.tiles);
  for (const p of m.people) {
    referencia(p.communityId === null || comunidades.has(p.communityId), p.id, 'communityId', p.communityId);
    for (const id of Object.keys(p.bonds)) referencia(vivos.has(id), p.id, 'bonds', id);
    for (const id of p.genome.parents) referencia(id !== p.id && identidad(id), p.id, 'genome.parents', id);
    for (const e of p.experiences) if (e.placeId) referencia(lugar(e.placeId), p.id, 'experiences.placeId', e.placeId);
    for (const habito of p.habits) referencia(lugar(habito.placeId), p.id, 'habits.placeId', habito.placeId);
    if (p.blueprintId) referencia(planos.has(p.blueprintId), p.id, 'blueprintId', p.blueprintId);
    const tile = encontrar(p.x, p.y);
    referencia(!!tile && tile.terrain !== 'water', p.id, 'tesela', { x: p.x, y: p.y });
  }
  // Las presas y los objetivos de movimiento son intenciones: pueden caducar entre dos decisiones.
  for (const a of m.animals) referencia(!!encontrar(a.x, a.y), a.id, 'tesela', { x: a.x, y: a.y });
  for (const s of m.structures) {
    referencia(planos.has(s.blueprintId), s.id, 'blueprintId', s.blueprintId);
    referencia(!!encontrar(s.x, s.y), s.id, 'tesela', { x: s.x, y: s.y });
    if (s.builderId) referencia(identidad(s.builderId), s.id, 'builderId', s.builderId);
  }
  for (const b of m.blueprints) {
    for (const id of b.parents) referencia(planos.has(id) && id !== b.id, b.id, 'parents', id);
    if (b.inventorId) referencia(identidad(b.inventorId), b.id, 'inventorId', b.inventorId);
  }
  for (const memoria of m.memories) referencia(lugar(memoria.placeId), memoria.id, 'placeId', memoria.placeId);
  for (const receta of m.technology.recipes) referencia(identidad(receta.inventorId), receta.id, 'inventorId', receta.inventorId);
  for (const p of m.people) {
    const recetas = new Set([...p.technology.knownRecipes, ...p.technology.items.flatMap(i => i.recipeId ? [i.recipeId] : [])]);
    for (const id of recetas) referencia(!!resolveTechnologyRecipe(m, id, { cache: false }), p.id, 'recipeId', id);
  }
  return h.resultado;
}, 600);

// Reutiliza el ámbito vigente cuando se llama dentro del paso; fuera, verifica uno recién construido.
inicial('indices.coherentes', 'global', m => conRejilla(m, () => conRejillaFauna(m, () => {
  const h = hallazgos('indices.coherentes', m), encontrar = tileLookup(m.tiles);
  const miembros = new Map(m.communities.map(c => [c.id, new Set(c.members)]));
  const personas = new Map(m.people.map(p => [p.id, p]));
  const porCelda = new Map<string, World['people']>();
  for (const p of m.people) { const key = `${p.x},${p.y}`, grupo = porCelda.get(key) ?? []; grupo.push(p); porCelda.set(key, grupo); }
  for (const c of m.communities) {
    if (miembros.get(c.id)!.size !== c.members.length) h.fallo('Miembro repetido.', { entidad: c.id });
    for (const id of c.members) if (personas.get(id)?.communityId !== c.id) h.fallo('Miembro ajeno o inexistente.', { entidad: c.id, persona: id });
  }
  for (const p of m.people) {
    if (p.communityId && !miembros.get(p.communityId)?.has(p.id)) h.fallo('Persona ausente de su comunidad.', { entidad: p.id, comunidad: p.communityId });
    const esperadas = porCelda.get(`${p.x},${p.y}`)!;
    const observadas = vecinos(m, p, 0, q => q.x === p.x && q.y === p.y);
    if (observadas.length !== esperadas.length || observadas.some((q, i) => q !== esperadas[i])) h.fallo('Rejilla de personas incoherente.', { entidad: p.id, x: p.x, y: p.y });
  }
  const fauna = new Map<string, World['animals']>();
  for (const a of m.animals) { const key = `${a.x},${a.y}`, grupo = fauna.get(key) ?? []; grupo.push(a); fauna.set(key, grupo); }
  for (const t of m.tiles) {
    if (encontrar(t.x, t.y) !== t) h.fallo('Índice de teselas incoherente.', { x: t.x, y: t.y });
    const grupo = fauna.get(`${t.x},${t.y}`) ?? [];
    if ((t.fauna ?? 0) !== grupo.length) h.fallo('Proyección de fauna incoherente.', { x: t.x, y: t.y }, grupo.length, t.fauna ?? 0);
    if (grupo.length && t.species !== grupo.reduce((menor, a) => a.species < menor ? a.species : menor, grupo[0]!.species)) h.fallo('Especie representativa de la fauna incoherente.', { x: t.x, y: t.y, especie: t.species });
    const indexados = animalesVivosEnCelda(m, t.x, t.y);
    if (indexados) {
      const vivos = grupo.filter(a => a.health > 0);
      if (indexados.length !== vivos.length || indexados.some((a, i) => a !== vivos[i])) h.fallo('Rejilla de fauna incoherente.', { x: t.x, y: t.y });
    }
  }
  return h.resultado;
})), 600);

const CAUSAS = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
inicial('demografia.causas', 'global', m => {
  const h = hallazgos('demografia.causas', m);
  for (const p of [...m.legacy, ...m.retiredLegacy]) if (!(CAUSAS as readonly string[]).includes(p.cause)) h.fallo('Muerte sin causa legible.', { entidad: p.id, causa: p.cause });
  for (const evento of m.events) if (evento.kind === 'death' && (!evento.death || !(CAUSAS as readonly string[]).includes(evento.death.cause) || evento.death.tick !== evento.tick)) {
    h.fallo('Evento de muerte sin causa o paso coherente.', { entidad: evento.id, muerte: evento.death });
  }
  const suma = CAUSAS.reduce((n, causa) => n + m.demographyDynamics.causes[causa], 0);
  if (suma !== m.demographyDynamics.deaths) h.fallo('Las causas no suman las muertes.', {}, m.demographyDynamics.deaths, suma);
  return h.resultado;
});

inicial('balances.actuales', 'global', m => {
  const h = hallazgos('balances.actuales', m);
  for (const [campo, valor] of Object.entries({ ...m.totals, birthCounter: m.birthCounter, animalCounter: m.animalCounter, ...m.demographyDynamics.causes, deaths: m.demographyDynamics.deaths })) h.numero(valor, campo, {});
  h.numeros(m.animalDynamics, 'animalDynamics', {}); h.numeros(m.inventionDynamics, 'inventionDynamics', {});
  h.numeros(m.technology.ledger, 'technology.ledger', {});
  const series: [readonly { id: string }[], RegExp, number][] = [
    [[...m.people, ...m.legacy, ...m.retiredLegacy], /^descendant-(\d+)$/, m.birthCounter],
    [m.blueprints, /^blueprint-(\d+)$/, m.blueprintCounter], [m.structures, /^structure-(\d+)$/, m.structureCounter],
    [m.communities, /^community-(\d+)$/, m.communityCounter], [m.technology.recipes, /^recipe-(\d+)$/, m.technology.recipeCounter],
    [m.people.flatMap(p => p.technology.items), /^product-(\d+)$/, m.technology.itemCounter],
  ];
  for (const [lista, patron, contador] of series) {
    h.numero(contador, 'contador', { patron: patron.source });
    for (const entidad of lista) {
      const serial = patron.exec(entidad.id)?.[1];
      if (serial && (!Number.isSafeInteger(Number(serial)) || Number(serial) > contador)) h.fallo('Identificador posterior a su contador.', { entidad: entidad.id }, contador, Number(serial));
    }
  }
  if (m.birthCounter !== (m.totals.births ?? 0)) h.fallo('Contadores de nacimientos distintos.', {}, m.birthCounter, m.totals.births ?? 0);
  const actual = { wood: 0, stone: 0, water: 0 };
  let agua = 0;
  for (const p of m.people) {
    for (const material of ['wood', 'stone', 'water'] as const) actual[material] += p.technology.residue[material];
    for (const item of p.technology.items) {
      let masa = 0;
      for (const material of ['wood', 'stone', 'water'] as const) { actual[material] += item.composition[material]; masa += item.composition[material]; }
      if (masa !== item.mass) h.fallo('Masa del producto distinta de su composición.', { entidad: item.id }, masa, item.mass);
      agua += item.contents?.water ?? 0;
    }
  }
  for (const material of ['wood', 'stone', 'water'] as const) {
    const observado = actual[material] + m.technology.ledger.estateLoss[material] + (material === 'wood' ? m.technology.ledger.fuelMass : 0);
    if (observado !== m.technology.ledger.imported[material]) h.fallo('Balance material portátil distinto de las entradas.', { material }, m.technology.ledger.imported[material], observado);
  }
  const libro = m.technology.water;
  if (libro && libro.filled !== agua + libro.consumed + libro.environmentalLoss) h.fallo('Balance de agua contenida distinto de las entradas.', {}, libro.filled, agua + libro.consumed + libro.environmentalLoss);
  const lotes = [...m.people.flatMap(p => p.compounds ?? []), ...m.structures.flatMap(s => s.storedCompounds ?? [])];
  for (const lote of lotes) {
    const masa = vectorMass(lote.composition);
    if (!Number.isFinite(lote.mass) || Math.abs(masa - lote.mass) > 1e-9 * Math.max(1, Math.abs(masa))) h.fallo('Masa del lote distinta de su composición.', { entidad: lote.id }, masa, lote.mass);
  }
  return h.resultado;
});

/** Observador por corrida: las diferencias sólo son válidas entre estados de la misma historia. */
export function crearComprobador(): (mundo: World) => Violacion[] {
  let anterior: { tick: number; poblacion: number; nacimientos: number; muertes: number; acumulados: Record<string, number> } | undefined;
  return m => {
    const resultado = comprobarInvariantes(m);
    const acumulados = { ...m.totals, ...Object.fromEntries(Object.entries(m.animalDynamics).map(([k, v]) => [`fauna.${k}`, v])),
      muertes: m.demographyDynamics.deaths, nacimientos: m.birthCounter, eventos: m.eventCounter, comunidades: m.communityCounter,
      estructuras: m.structureCounter, planos: m.blueprintCounter, animales: m.animalCounter };
    if (anterior && m.tick > anterior.tick) {
      const observado = m.people.length - anterior.poblacion;
      const esperado = (m.totals.births ?? 0) - anterior.nacimientos - (m.demographyDynamics.deaths - anterior.muertes);
      if (observado !== esperado) resultado.push({ id: 'demografia.balance', gravedad: 'dura', tick: m.tick, detalle: 'Δpoblación distinto de nacimientos − muertes.', esperado, observado });
      for (const [campo, valor] of Object.entries(acumulados)) if (valor < (anterior.acumulados[campo] ?? 0)) resultado.push({ id: 'acumulados.monotonos', gravedad: 'dura', tick: m.tick, detalle: 'Disminuyó un acumulado.', contexto: { campo }, esperado: anterior.acumulados[campo], observado: valor });
    }
    anterior = { tick: m.tick, poblacion: m.people.length, nacimientos: m.totals.births ?? 0, muertes: m.demographyDynamics.deaths, acumulados };
    return resultado;
  };
}
