import type { World } from './index.js';
import { worldContext } from './spatial.js';
import { tileLookup } from './tile-index.js';
import { conRejilla, vecinos } from './rejilla.js';
import { especieVisual, animalesVivosEnCelda, conRejillaFauna } from './animals.js';
import { resolveTechnologyRecipe } from './technology-catalogue.js';
import { ELEMENTS, vectorMass } from '../shared/chemistry.js';
import type { CompoundLot } from '../shared/chemistry.js';
import { CHUNK_SIZE, chunkKey } from './terrain.js';
import { ctxSi, type CtxLey, type Ley } from './motor/acceso.js';
import type { BalanceBuzones } from './motor/contadores.js';
import type { CtxMateria } from './motor/contratos.js';
import { conservacion } from './materia/ley-mundo.js';
import { ley, paramsOf } from './params.js';

import { listaInvariantes, registrar, type Gravedad, type Invariante, type RegionRef, type Violacion } from './registro-invariantes.js';

export { listaInvariantes, registrar, type Gravedad, type Invariante, type RegionRef, type Violacion } from './registro-invariantes.js';

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
  for (const inv of listaInvariantes()) {
    if (opciones.ids && !opciones.ids.includes(inv.id) || opciones.cadencia && mundo.tick % inv.cadaTicks !== 0) continue;
    resultado.push(...comprobarInvariante(inv, mundo, opciones.region));
  }
  return resultado;
}

type Punto = { x: number; y: number };
// Una coordenada no finita no pertenece a ninguna región: se examina en todas, porque es la corrupción más probable.
const enRegion = (p: Punto, r?: RegionRef): boolean => !r || !Number.isFinite(p.x) || !Number.isFinite(p.y)
  || Math.floor(p.x / CHUNK_SIZE) === r.chunkX && Math.floor(p.y / CHUNK_SIZE) === r.chunkY;
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
/** Un mundo corrupto puede tener millones de fallos: basta una muestra para diagnosticar. */
const MAX_HALLAZGOS = 64;
function hallazgos(id: string, m: World, region?: RegionRef) {
  const resultado: Violacion[] = [];
  const fallo = (detalle: string, contexto: Record<string, unknown>, esperado?: number, observado?: number): void => {
    if (resultado.length >= MAX_HALLAZGOS) return;
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
    if (grupo.length && t.species !== grupo.reduce((menor, a) => { const especie = especieVisual(a.species); return especie < menor ? especie : menor; }, especieVisual(grupo[0]!.species))) h.fallo('Especie representativa de la fauna incoherente.', { x: t.x, y: t.y, especie: t.species });
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

// ── V23: invariantes de la oleada (carril lab). Todos devuelven [] con su interruptor apagado ─────────────────────────

/** Un invariante de la V23: como `inicial`, pero con su carril y gravedad, y registrado bajo el id del documento de arquitectura. */
function v23(id: string, carril: string, gravedad: Gravedad, alcance: Invariante['alcance'], comprobar: Invariante['comprobar'], cadaTicks = 60): void {
  registrar({ id, carril, gravedad, cadaTicks, alcance, comprobar });
}
/** El contexto del dueño con materia, o `undefined` si el mundo aún no pasó por el motor o no la tiene. */
function ctxConMateria(m: World): (CtxLey & CtxMateria) | undefined {
  const c = ctxSi(m) as (Partial<CtxMateria> & CtxLey) | undefined;
  return c?.materia && c.quimica ? c as CtxLey & CtxMateria : undefined;
}
const comoNumero = (n: bigint): number => Number(n);

/** I-C `motor-conservacion`: Σ lotes + Σ en vuelo = inicial + fuentes − sumideros, por posición y exacto (bigint), y ningún
 * stock negativo. Con varios dueños comprueba lo del dueño del contexto enlazado a `mundo`. */
v23('motor-conservacion', 'I-C', 'dura', 'global', m => {
  if (!ley(m, 'materia')) return [];
  const c = ctxConMateria(m);
  if (!c) return [];
  const h = hallazgos('motor-conservacion', m);
  const { esperado, hallado, cuentas } = conservacion(c as Parameters<typeof conservacion>[0]);
  if (esperado.length !== hallado.length) h.fallo('El libro y los lotes tienen posiciones distintas.', { esperado: esperado.length, hallado: hallado.length });
  const energia = Math.min(esperado.length, hallado.length) - 1;
  for (let i = 0; i < Math.min(esperado.length, hallado.length); i++) {
    const e = esperado[i]!, o = hallado[i]!;
    const contexto = { posicion: i, energia: i === energia, esperado: String(e), hallado: String(o), diferencia: String(o - e),
      cuentas: Object.fromEntries(Object.entries(cuentas).map(([k, v]) => [k, String(v)])) };
    if (e !== o) h.fallo('La materia no se conserva: Σ lotes + en vuelo distinto de inicial + fuentes − sumideros.', contexto, comoNumero(e), comoNumero(o));
    // La energía es química más calor. La química es la de enlace con referencia en los átomos libres
    // (`Sustancia.energia` = −Σd·b − E_red ≤ 0, estrictamente negativa en todo compuesto), así que el total es negativo por
    // construcción (semilla 7, tick 97: química −1,119·10¹⁴ J, calor +2,03·10¹² J). Lo que no puede bajar de 0 es el calor
    // de cada lote, y eso lo garantiza la arena al escribirlo (`natural` en mover/moverCalor, recorte por calor en aplicar).
    // Solo los átomos tienen aquí cota de stock.
    else if (o < 0n && i !== energia) h.fallo('Stock negativo.', contexto, 0, comoNumero(o));
  }
  return h.resultado;
});

let lectorBuzones: ((mundo: World) => BalanceBuzones | null) | null = null;
/** Quien conduce el tick (motor/coordinador, el servidor o el laboratorio) dice de dónde leer los contadores de buzones. */
export function fijarLectorBuzones(leer: ((mundo: World) => BalanceBuzones | null) | null): void { lectorBuzones = leer; }

/** I-B `motor-garantias`: ninguna garantía vive más de 2 ticks y, sin pendientes, el libro no guarda nada en vuelo (con un
 * solo dueño; con varios cada libro puede ser negativo mientras el global suma cero). El saldo enviados = acreditados lo
 * comprueba `motor-buzones` (`motor/contadores.ts`). */
v23('motor-garantias', 'I-B', 'dura', 'global', m => {
  if (!ley(m, 'intentos') || !lectorBuzones) return [];
  const balance = lectorBuzones(m);
  if (!balance) return [];
  const h = hallazgos('motor-garantias', m);
  if (!Number.isSafeInteger(balance.edadMaxGarantia) || balance.edadMaxGarantia < 0) h.fallo('Edad de garantía inválida.', { balance });
  else if (balance.edadMaxGarantia > 2) h.fallo('Hay una garantía con más de dos ticks.', { balance }, 2, balance.edadMaxGarantia);
  const c = ctxSi(m);
  if (c && paramsOf(m).motor.hilos === 1) {
    for (let i = 0; i < c.libro.enVuelo.length; i++) {
      const v = c.libro.enVuelo[i]!;
      if (!Number.isFinite(v) || v < 0) h.fallo('Materia en vuelo inválida.', { posicion: i, valor: v }, 0, v);
      else if (balance.pendientes === 0 && v !== 0) h.fallo('Hay materia en vuelo sin ninguna garantía pendiente.', { posicion: i, valor: v }, 0, v);
    }
  }
  return h.resultado;
});

/** I-N `motor-nacimientos` (parte sin historia): ningún uid repetido o nulo y cada gestación con su embrión vivo y propio. */
v23('motor-nacimientos', 'I-N', 'dura', 'global', m => {
  const h = hallazgos('motor-nacimientos', m);
  const vistos = new Map<number, string>();
  for (const o of [...m.people, ...m.animals]) {
    if (o.uid === undefined) continue;
    if (!Number.isSafeInteger(o.uid) || o.uid < 1) h.fallo('uid inválido (0 queda reservado).', { entidad: o.id, uid: o.uid });
    else if (vistos.has(o.uid)) h.fallo('uid repetido.', { uid: o.uid, entidad: o.id, otra: vistos.get(o.uid) });
    else vistos.set(o.uid, o.id);
  }
  const c = ley(m, 'cuerpos') ? ctxConMateria(m) : undefined;
  if (c) {
    const embriones = new Map<number, string>();
    for (const o of [...m.people, ...m.animals]) {
      const g = o.cuerpo?.gestacion;
      if (!g) continue;
      const contexto = { entidad: o.id, uid: o.uid, embrion: g.embrion };
      if (embriones.has(g.embrion)) h.fallo('Dos gestaciones comparten embrión.', { ...contexto, otra: embriones.get(g.embrion) });
      embriones.set(g.embrion, o.id);
      if (!c.materia.vivo(g.embrion)) h.fallo('Gestación con un embrión caducado.', contexto);
      if (g.otro === o.uid) h.fallo('Una gestación es de sí mismo.', contexto);
      if (!Number.isFinite(g.inicio) || g.inicio > m.tick) h.fallo('Gestación que empieza en el futuro.', { ...contexto, inicio: g.inicio }, m.tick, g.inicio);
    }
  }
  return h.resultado;
});

/** I-N `motor-nacimientos` (parte con historia): cada nacido de una pareja con cuerpos y natalidad tuvo a su madre gestando
 * en la comprobación anterior. Solo vale si se comprueba cada tick: con huecos mayores no concluye nada. */
export function crearObservadorNacimientos(): (mundo: World) => Violacion[] {
  let anterior: { tick: number; ids: Set<string>; gestantes: Set<string> } | undefined;
  return m => {
    const resultado: Violacion[] = [];
    const ids = new Set(m.people.map(p => p.id));
    const gestantes = new Set(m.people.filter(p => p.cuerpo?.gestacion).map(p => p.id));
    if (anterior && m.tick === anterior.tick + 1 && ley(m, 'cuerpos') && ley(m, 'natalidad')) {
      for (const p of m.people) {
        if (anterior.ids.has(p.id) || p.genome.generation === 0 || p.genome.parents.length === 0) continue;
        if (!p.genome.parents.some(id => anterior!.gestantes.has(id))) {
          resultado.push({ id: 'motor-nacimientos', gravedad: 'dura', tick: m.tick, detalle: 'Nacimiento sin gestación previa de ninguno de sus padres.',
            contexto: { entidad: p.id, uid: p.uid, padres: p.genome.parents } });
        }
      }
    }
    anterior = { tick: m.tick, ids, gestantes };
    return resultado;
  };
}

/** I-R `motor-referencias` (parte del cuerpo): con `cuerpos`, todo organismo tiene cuerpo y ninguna referencia de su cuerpo,
 * de su carga o de su embrión apunta a un lote caducado; con la ley apagada nadie lo tiene. */
v23('motor-referencias', 'I-R', 'dura', 'global', m => {
  const personas = ley(m, 'cuerpos'), animales = ley(m, 'fauna');
  const h = hallazgos('motor-referencias', m);
  const c = personas ? ctxConMateria(m) : undefined;
  const revisar = (o: World['people'][number] | World['animals'][number], debe: boolean): void => {
    const contexto = { entidad: o.id, uid: o.uid };
    if (!o.cuerpo) { if (debe && c) h.fallo('Organismo sin cuerpo con la ley encendida.', contexto); return; }
    if (!debe) { h.fallo('Cuerpo con la ley apagada.', contexto); return; }
    if (!c) return;
    for (const campo of ['tejido', 'reserva', 'digestivo'] as const) {
      if (!c.materia.vivo(o.cuerpo[campo])) h.fallo('Cuerpo con un lote caducado.', { ...contexto, campo, lote: o.cuerpo[campo] });
    }
    if (o.cuerpo.gestacion && !c.materia.vivo(o.cuerpo.gestacion.embrion)) h.fallo('Cuerpo con un embrión caducado.', { ...contexto, lote: o.cuerpo.gestacion.embrion });
    for (const lote of 'carga' in o ? o.carga ?? [] : []) if (!c.materia.vivo(lote)) h.fallo('Carga con un lote caducado.', { ...contexto, lote });
  };
  for (const p of m.people) revisar(p, personas);
  for (const a of m.animals) revisar(a, animales);
  return h.resultado;
});

/** `vistas.materia`: las vistas que w escribe en las teselas (`mat`, `T`) son legibles: fracciones en [0, 1] que suman ≤ 1, de
 * mayor a menor, y temperatura finita y positiva. */
v23('vistas.materia', 'lab', 'dura', 'region', (m, r) => {
  if (!ley(m, 'materia')) return [];
  const h = hallazgos('vistas.materia', m, r);
  for (const t of teselas(m, r)) {
    const contexto = { x: t.x, y: t.y };
    if (t.T !== undefined && (!Number.isFinite(t.T) || t.T <= 0)) h.fallo('Temperatura de tesela inválida.', { ...contexto, T: t.T });
    if (!t.mat) continue;
    if (t.mat.length > 3) h.fallo('Una tesela con más de tres sustancias visibles.', { ...contexto, n: t.mat.length });
    let suma = 0, previa = Infinity;
    for (const [id, fraccion] of t.mat) {
      if (!Number.isInteger(id) || id < 0) h.fallo('Sustancia visible inválida.', { ...contexto, id });
      if (!Number.isFinite(fraccion) || fraccion < 0 || fraccion > 1) h.fallo('Fracción visible fuera de [0, 1].', { ...contexto, fraccion });
      if (fraccion > previa) h.fallo('Fracciones visibles no ordenadas de mayor a menor.', contexto);
      previa = fraccion; suma += fraccion;
    }
    if (suma > 1 + 1e-6) h.fallo('Las fracciones visibles suman más de 1.', contexto, 1, suma);
  }
  return h.resultado;
}, 120);

/** Corre los `comprobar` de las leyes encendidas (en el orden dado) sobre el contexto del dueño de `mundo`. Sin contexto
 * (mundo que no pasó por el motor) no hay nada que comprobar. Una excepción cuenta como violación dura. */
export function comprobarLeyes(mundo: World, leyes: readonly Ley[]): Violacion[] {
  const c = ctxSi(mundo);
  if (!c) return [];
  const resultado: Violacion[] = [];
  for (const l of leyes) {
    if (!l.comprobar || !ley(mundo, l.interruptor)) continue;
    try {
      for (const v of l.comprobar(c)) resultado.push({ ...v, tick: v.tick ?? mundo.tick, contexto: { ...v.contexto, ley: l.id } });
    } catch (error) {
      resultado.push({ id: `ley.${l.id}.excepcion`, gravedad: 'dura', tick: mundo.tick, detalle: 'El comprobador de la ley lanzó una excepción.',
        contexto: { ley: l.id, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return resultado;
}

/** Observador por corrida: las diferencias sólo son válidas entre estados de la misma historia. */
export function crearComprobador(opciones: { cadencia?: boolean } = {}): (mundo: World) => Violacion[] {
  const nacimientos = crearObservadorNacimientos();
  let anterior: { tick: number; poblacion: number; nacimientos: number; muertes: number; acumulados: Record<string, number> } | undefined;
  return m => {
    const resultado = [...comprobarInvariantes(m, { cadencia: opciones.cadencia }), ...nacimientos(m)];
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
