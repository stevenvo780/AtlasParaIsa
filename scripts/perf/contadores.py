#!/usr/bin/env python3
"""Contadores de llamadas del paso (sprint noche-perf2 2026-09-22).

    TMPDIR=/datos/tmp-atlas-lab python3 scripts/perf/contadores.py <copia> -- --db <world.sqlite> --pasos 300 [--digesto H]

Copia `src/`, `scripts/perf/`, `package.json` y `tsconfig.json` de este árbol a `<copia>` (un
directorio NUEVO fuera de /tmp; `node_modules` se enlaza), inserta contadores en la copia —nunca en
este árbol— y corre allí `scripts/perf/fases.ts` con los argumentos que siguen a `--`. El JSON de
salida lleva además `contadoresPorPaso`: cuántas veces por paso se decide (`choose`), cuántos
pares persona–vecino evalúa `cooperationOpportunity`, cuántas resoluciones de receta hay (y cuántas
van al archivo SQLite, cuántos toques de la ventana LRU, cuántos sellos del archivo), la longitud
media de `pending` y de la ventana en cada resolución, cuántas veces el filtro de obra recorre los
lugares, cuántas consultas `functionalNear` y cuántas estructuras recorren, etc.

Contar no cambia el mundo: con la misma base el digesto final es el mismo que sin contadores
(comprobado con la semilla 51926 a 6 días: b9e5503a… a 300 pasos en ambos casos). Si una ancla ya
no existe en el código, el script falla en vez de medir otra cosa.
"""
import json, os, shutil, subprocess, sys

HELPER = ("const __c = (k: string, n = 1): void => { const g = globalThis as unknown as { __perf2?: Record<string, number> }; "
          "const t = (g.__perf2 ??= {}); t[k] = (t[k] ?? 0) + n; };\n")

PARCHES = {
    'src/world/index.ts': [
        ("function choose(world: World, person: Person): void {\n", "function choose(world: World, person: Person): void {\n  __c('choose');\n"),
        ("  const partner = nearbyPeople.find(", "  __c('choose.nearbyPeople', nearbyPeople.length);\n  const partner = nearbyPeople.find("),
        ("function bodyAndAction(world: World, person: Person): void {\n", "function bodyAndAction(world: World, person: Person): void {\n  __c('bodyAndAction');\n"),
        ("  if (best === start) {\n    person.heading += 1.3;", "  __c('move'); __c('move.bfs', head);\n  if (best === start) {\n    person.heading += 1.3;"),
        ("    t => t.terrain !== 'shelter' && t.moisture > 0.2 && t.vegetation > 0.15 && !world.places.some(p => distance(p, t) < 5));",
         "    t => { if (!(t.terrain !== 'shelter' && t.moisture > 0.2 && t.vegetation > 0.15)) return false; __c('buildable.placesSome'); __c('buildable.placesLen', world.places.length); return !world.places.some(p => distance(p, t) < 5); });"),
        ("      const victim = world.animals.filter(a => a.x === tile.x && a.y === tile.y && a.health > 0)",
         "      __c('hunt.animalsFilter'); const victim = world.animals.filter(a => a.x === tile.x && a.y === tile.y && a.health > 0)"),
    ],
    'src/world/society.ts': [
        ("export function cooperationOpportunity(world: World, person: Person): Opportunity | undefined {\n  if (!world.cooperationEnabled) return;\n",
         "export function cooperationOpportunity(world: World, person: Person): Opportunity | undefined {\n  if (!world.cooperationEnabled) return;\n  __c('coop');\n"),
        ("    if (other === person || distance(person, other) > 7 || world.tick - person.lastSocial < 30) continue;\n",
         "    if (other === person || distance(person, other) > 7 || world.tick - person.lastSocial < 30) continue;\n    __c('coop.pairs');\n"),
        ("  if (!candidates.length) return;\n  const inputsAvailable = localRecipeInputs(world, teacher, learner);\n",
         "  __c('teach.calls'); __c('teach.teacherRecipes', teacher.technology.knownRecipes.length); __c('teach.candidates', candidates.length);\n"
         "  if (!candidates.length) return;\n  __c('teach.conCandidatas'); __c('teach.learnerRecipes', learner.technology.knownRecipes.length);\n"
         "  const inputsAvailable = localRecipeInputs(world, teacher, learner);\n"),
        ("  const viable = (place: {x:number;y:number}) => {\n", "  const viable = (place: {x:number;y:number}) => {\n    __c('settle.viable');\n"),
    ],
    'src/world/technology-catalogue.ts': [
        ("  let recipe = state.catalogue!.pending.find(recipe => recipe.id === id) ?? state.recipes.find(recipe => recipe.id === id);\n  if (!recipe) {\n",
         "  __c('resolve'); if (options.cache === false) __c('resolve.sinCache'); __c('resolve.pendingLen', state.catalogue!.pending.length); __c('resolve.ventanaLen', state.recipes.length);\n"
         "  let recipe = state.catalogue!.pending.find(recipe => recipe.id === id) ?? state.recipes.find(recipe => recipe.id === id);\n  if (!recipe) {\n    __c('resolve.archivada');\n"),
        ("function cacheRecipe(state: TechnologyState, recipe: TechnologyRecipe): void {\n",
         "function cacheRecipe(state: TechnologyState, recipe: TechnologyRecipe): void {\n  __c('cacheRecipe'); if (state.recipes[state.recipes.length - 1] === recipe) __c('cacheRecipe.yaUltima');\n"),
    ],
    'src/world/technology-checkpoint.ts': [
        ("  if (rosterChanged || technologyHistoryGap(state)) {\n", "  if (rosterChanged || technologyHistoryGap(state)) {\n    __c('checkpoint.rotaciones');\n"),
    ],
    'src/world/inventions.ts': [
        ("const functionalNear = (world: World, point: Point, radius = 1.5) => world.structures.filter(",
         "const functionalNear = (world: World, point: Point, radius = 1.5) => (__c('functionalNear'), __c('functionalNear.estructuras', world.structures.length), world.structures).filter("),
    ],
    'src/server/store.ts': [
        ("    if (memo && remembered) {\n", "    __c('store.read'); if (memo && remembered) {\n"),
        ("    const definition = this.technologyArchive.getDefinition(id, atTick);\n    if (!definition) { memo?.recipes.set(id, { atTick, value: null }); return null; }\n",
         "    __c('store.lecturaCompleta');\n    const definition = this.technologyArchive.getDefinition(id, atTick);\n    if (!definition) { memo?.recipes.set(id, { atTick, value: null }); return null; }\n"),
    ],
    'src/server/technology-archive.ts': [
        ("  readEpoch(): string | null {\n", "  readEpoch(): string | null {\n    __c('readEpoch');\n"),
    ],
    'scripts/perf/fases.ts': [
        ("  const medicion: FaseMedicion = { clock: cpuMs, fases: {} };",
         "  (globalThis as unknown as { __perf2?: Record<string, number> }).__perf2 = {};\n  const medicion: FaseMedicion = { clock: cpuMs, fases: {} };"),
        ("  const texto = JSON.stringify(resultado, null, 2);",
         "  const g = globalThis as unknown as { __perf2?: Record<string, number> };\n"
         "  (resultado as Record<string, unknown>).contadoresPorPaso = Object.fromEntries(Object.entries(g.__perf2 ?? {}).map(([k, v]) => [k, r3(v / pasos)]));\n"
         "  const texto = JSON.stringify(resultado, null, 2);"),
    ],
}


def main() -> None:
    if len(sys.argv) < 3 or '--' not in sys.argv:
        sys.exit(__doc__)
    copia = os.path.abspath(sys.argv[1])
    argumentos = sys.argv[sys.argv.index('--') + 1:]
    tmp = os.environ.get('TMPDIR', '/tmp')
    if tmp.startswith('/tmp') or copia.startswith('/tmp'):
        sys.exit('TMPDIR y la copia deben estar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab')
    if os.path.exists(copia):
        sys.exit(f'{copia} ya existe: usa un directorio nuevo')
    raiz = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    os.makedirs(os.path.join(copia, 'scripts'))
    shutil.copytree(os.path.join(raiz, 'src'), os.path.join(copia, 'src'))
    shutil.copytree(os.path.join(raiz, 'scripts', 'perf'), os.path.join(copia, 'scripts', 'perf'))
    for nombre in ('package.json', 'tsconfig.json'):
        shutil.copy(os.path.join(raiz, nombre), copia)
    os.symlink(os.path.join(raiz, 'node_modules'), os.path.join(copia, 'node_modules'))
    for relativo, parches in PARCHES.items():
        ruta = os.path.join(copia, relativo)
        texto = open(ruta, encoding='utf8').read()
        for ancla, reemplazo in parches:
            if texto.count(ancla) != 1:
                sys.exit(f'{relativo}: el ancla aparece {texto.count(ancla)} veces (el código cambió): {ancla[:80]!r}')
            texto = texto.replace(ancla, reemplazo)
        if relativo.startswith('src/'):
            lineas = texto.split('\n')
            ultima = max(i for i, linea in enumerate(lineas) if linea.startswith('import '))
            lineas.insert(ultima + 1, HELPER)
            texto = '\n'.join(lineas)
        open(ruta, 'w', encoding='utf8').write(texto)
    resultado = subprocess.run(['node', '--import', 'tsx', 'scripts/perf/fases.ts', *argumentos], cwd=copia)
    sys.exit(resultado.returncode)


if __name__ == '__main__':
    main()
