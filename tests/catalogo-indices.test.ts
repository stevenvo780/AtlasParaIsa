/**
 * Índices de resolución del catálogo tecnológico (sprint noche-perf2 2026-09-22): `pending` y la
 * ventana residente se consultan por id con índices asociados a la identidad y longitud de cada
 * arreglo, y `cacheRecipe` traslada el índice de la ventana al arreglo nuevo. Esta prueba compara,
 * operación a operación y sobre secuencias aleatorias, cada resolución, cada toque de la ventana y cada
 * actualización de estadísticas con la semántica de siempre (`find` en `pending` y luego en la
 * ventana; `filter` + `push` + `slice(-max)` en un arreglo NUEVO), incluida la IDENTIDAD de los objetos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTechnologyCatalogue, enableTechnologyCatalogue, markTechnologyCatalogueCommitted, resolveTechnologyRecipe,
  updateTechnologyRecipeStats, withRecipeSession, type TechnologyCatalogueReader } from '../src/world/technology-catalogue.js';
import { defaultTechnologyState } from '../src/world/technology.js';
import type { TechnologyRecipe, TechnologyState } from '../src/shared/technology.js';

function aleatorio(seed: number): () => number {
  let n = seed >>> 0 || 1;
  return () => { n ^= n << 13; n >>>= 0; n ^= n >>> 17; n ^= n << 5; n >>>= 0; return n / 4294967296; };
}

function receta(n: number): TechnologyRecipe {
  return { id: `recipe-${n}`, name: `R${n}`, program: { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 1 + n % 4, shape: 'rod' }] },
    signature: `firma-${n}`, parents: [], generation: 1, inventorId: 'p-1', tick: 0, x: 0, y: 0, novelty: 'both',
    capacities: { cutting: (n % 6) / 5, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 }, uses: 0, utility: 0, manufactured: 0 };
}

function mundo(total: number, ventana: number): { host: { technology: TechnologyState; tick: number }; archivo: Map<string, TechnologyRecipe> } {
  const state = defaultTechnologyState();
  state.recipes = Array.from({ length: total }, (_, i) => receta(i + 1));
  state.recipeCounter = total;
  enableTechnologyCatalogue(state, { committedThrough: total, memoryCapacity: Math.min(256, ventana) });
  state.budgets.maxRecipes = ventana;
  const archivo = new Map(state.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  state.recipes = state.recipes.slice(-ventana).map(recipe => structuredClone(recipe));
  const reader: TechnologyCatalogueReader = {
    resolve: id => { const recipe = archivo.get(id); return recipe ? structuredClone(recipe) : null; },
    findBySignature: () => null, freshCopies: true,
  };
  bindTechnologyCatalogue(state, reader);
  return { host: { technology: state, tick: 10 }, archivo };
}

/** La ventana esperada tras tocar `recipe`, con el algoritmo de siempre. */
function ventanaEsperada(anterior: readonly TechnologyRecipe[], recipe: TechnologyRecipe, max: number): TechnologyRecipe[] {
  const next = anterior.filter(cached => cached.id !== recipe.id);
  next.push(recipe);
  return next.length > max ? next.slice(-max) : next;
}
function mismosObjetos(actual: readonly TechnologyRecipe[], esperado: readonly TechnologyRecipe[], contexto: string): void {
  assert.equal(actual.length, esperado.length, contexto);
  for (let i = 0; i < esperado.length; i++) assert.equal(actual[i], esperado[i], `${contexto}: posición ${i}`);
}

for (const [semilla, total, ventana] of [[1, 40, 8], [2, 300, 256], [3, 12, 12], [4, 60, 1]] as const) {
  test(`resolución con índices = find + filter/push/slice, objeto a objeto (semilla ${semilla}, ${total} recetas, ventana ${ventana})`, () => {
    const r = aleatorio(semilla), { host, archivo } = mundo(total, ventana), state = host.technology;
    const vistos = new Set<TechnologyRecipe>([...state.recipes]);
    for (let paso = 0; paso < 6000; paso++) {
      const eleccion = r(), id = r() < 0.03 ? `recipe-${total + 5}` : `recipe-${1 + Math.floor(r() * total)}`;
      const antes = state.recipes, pending = state.catalogue!.pending;
      const local = pending.find(recipe => recipe.id === id) ?? antes.find(recipe => recipe.id === id);
      if (eleccion < 0.75) {
        const cache = r() < 0.85;
        const resultado = resolveTechnologyRecipe(host, id, { cache });
        if (!archivo.has(id)) { assert.equal(resultado, undefined); assert.equal(state.recipes, antes); continue; }
        if (local) assert.equal(resultado, local, `paso ${paso}: ${id} local`);
        else { assert.ok(resultado && !vistos.has(resultado), `paso ${paso}: ${id} debe ser una copia nueva`); assert.deepEqual(resultado, archivo.get(id)); }
        vistos.add(resultado!);
        if (cache) { assert.notEqual(state.recipes, antes); mismosObjetos(state.recipes, ventanaEsperada(antes, resultado!, ventana), `paso ${paso}`); }
        else assert.equal(state.recipes, antes);
      } else if (eleccion < 0.93) {
        if (!archivo.has(id)) continue;
        const pendiente = pending.find(recipe => recipe.id === id), largo = pending.length;
        updateTechnologyRecipeStats(host, id, { uses: 1, utility: 0.5 });
        const objeto = state.catalogue!.pending.find(recipe => recipe.id === id)!;
        if (local) assert.equal(objeto, local, `paso ${paso}: estadística sobre el objeto local`);
        else assert.ok(!vistos.has(objeto));
        vistos.add(objeto);
        assert.equal(state.catalogue!.pending.length, largo + (pendiente ? 0 : 1));
        mismosObjetos(state.recipes, ventanaEsperada(antes, objeto, ventana), `paso ${paso} (estadística)`);
      } else if (eleccion < 0.97) {
        for (const recipe of pending) archivo.set(recipe.id, structuredClone(recipe));
        markTechnologyCatalogueCommitted(state);
        assert.deepEqual(state.catalogue!.pending, []);
      } else {
        // Reemplazos ajenos del arreglo: el índice va con la identidad, nunca con el estado.
        state.recipes = [...state.recipes];
        if (r() < 0.5) state.catalogue!.pending = [...state.catalogue!.pending];
      }
    }
  });
}

test('con ids repetidos en la ventana vuelve el recorrido lineal de siempre', () => {
  const { host } = mundo(10, 6), state = host.technology;
  const duplicada = structuredClone(state.recipes[2]!);
  state.recipes = [...state.recipes.slice(0, 5), duplicada];
  const antes = state.recipes, esperado = antes.find(recipe => recipe.id === duplicada.id)!;
  const resultado = resolveTechnologyRecipe(host, duplicada.id)!;
  assert.equal(resultado, esperado);
  mismosObjetos(state.recipes, ventanaEsperada(antes, resultado, 6), 'duplicada');
  // Tras el toque ya no hay duplicados y vuelve el índice; la respuesta sigue siendo la de find.
  const otra = state.recipes[0]!;
  assert.equal(resolveTechnologyRecipe(host, otra.id), otra);
});

/** Procedencia de un objeto devuelto: el de `pending` (posición), uno ya devuelto antes (en qué
 * operación apareció por primera vez) o una copia nueva. Comparable entre dos mundos gemelos. */
function procedencia(objeto: TechnologyRecipe | undefined, pending: readonly TechnologyRecipe[], vistos: Map<TechnologyRecipe, number>, n: number): string {
  if (!objeto) return 'nada';
  const p = pending.indexOf(objeto);
  if (p >= 0) return `pending ${p}`;
  const visto = vistos.get(objeto);
  if (visto !== undefined) return `visto ${visto}`;
  vistos.set(objeto, n); return 'nuevo';
}
const huella = (state: TechnologyState) => JSON.stringify({ ventana: state.recipes, pending: state.catalogue!.pending,
  compartidos: state.recipes.map(recipe => state.catalogue!.pending.indexOf(recipe)) });

for (const [semilla, total, ventana] of [[11, 40, 8], [12, 300, 256], [13, 20, 20], [14, 30, 1]] as const) {
  test(`una sesión de resolución deja la misma ventana que tocar uno a uno (semilla ${semilla}, ${total} recetas, ventana ${ventana})`, () => {
    const r = aleatorio(semilla), a = mundo(total, ventana), b = mundo(total, ventana);
    const A = a.host.technology, B = b.host.technology;
    const vistosA = new Map(A.recipes.map((recipe, i) => [recipe, -1 - i])), vistosB = new Map(B.recipes.map((recipe, i) => [recipe, -1 - i]));
    let n = 0;
    for (let bloque = 0; bloque < 400; bloque++) {
      const operaciones = Array.from({ length: 1 + Math.floor(r() * 40) }, () => ({ id: `recipe-${1 + Math.floor(r() * (total + 2))}`, cache: r() < 0.85, estadistica: r() < 0.03 }));
      const antes = A.recipes;
      const inicio = n;
      const enSesion = withRecipeSession(a.host, () => operaciones.map(({ id, cache, estadistica }, k) => {
        if (estadistica) { if (a.archivo.has(id)) updateTechnologyRecipeStats(a.host, id, { uses: 1 }); return 'estadística'; }
        const pendingAntes = [...A.catalogue!.pending];
        const resultado = resolveTechnologyRecipe(a.host, id, { cache });
        return `${procedencia(resultado, pendingAntes, vistosA, inicio + k)} ${JSON.stringify(resultado ?? null)}`;
      }));
      const sinSesion = operaciones.map(({ id, cache, estadistica }, k) => {
        if (estadistica) { if (b.archivo.has(id)) updateTechnologyRecipeStats(b.host, id, { uses: 1 }); return 'estadística'; }
        const pendingAntes = [...B.catalogue!.pending];
        const resultado = resolveTechnologyRecipe(b.host, id, { cache });
        return `${procedencia(resultado, pendingAntes, vistosB, inicio + k)} ${JSON.stringify(resultado ?? null)}`;
      });
      n += operaciones.length;
      for (const [recipe, i] of [...A.recipes.entries()].map(([i, recipe]) => [recipe, i] as const)) if (!vistosA.has(recipe)) vistosA.set(recipe, -1000 - i);
      for (const [recipe, i] of [...B.recipes.entries()].map(([i, recipe]) => [recipe, i] as const)) if (!vistosB.has(recipe)) vistosB.set(recipe, -1000 - i);
      assert.deepEqual(enSesion, sinSesion, `bloque ${bloque}`);
      assert.equal(huella(A), huella(B), `bloque ${bloque}: ventana y pending`);
      if (!operaciones.some(o => o.estadistica) && operaciones.some(o => o.cache && a.archivo.has(o.id))) assert.notEqual(A.recipes, antes);
      if (r() < 0.1) {
        for (const [host, archivo] of [[a.host, a.archivo], [b.host, b.archivo]] as const) {
          for (const recipe of host.technology.catalogue!.pending) archivo.set(recipe.id, structuredClone(recipe));
          markTechnologyCatalogueCommitted(host.technology);
        }
      }
    }
  });
}

test('mientras dura la sesión el arreglo de la ventana no cambia; al cerrar se materializa uno nuevo', () => {
  const { host } = mundo(20, 5), state = host.technology, antes = state.recipes, copia = [...antes];
  withRecipeSession(host, () => {
    for (const id of ['recipe-1', 'recipe-2', 'recipe-19', 'recipe-3']) resolveTechnologyRecipe(host, id);
    assert.equal(state.recipes, antes);
    mismosObjetos(state.recipes, copia, 'intacto');
  });
  assert.notEqual(state.recipes, antes);
  assert.deepEqual(state.recipes.map(recipe => recipe.id), ['recipe-20', 'recipe-1', 'recipe-2', 'recipe-19', 'recipe-3']);
  // Sin toques no hay arreglo nuevo.
  const quieto = state.recipes;
  withRecipeSession(host, () => resolveTechnologyRecipe(host, 'recipe-4', { cache: false }));
  assert.equal(state.recipes, quieto);
});
