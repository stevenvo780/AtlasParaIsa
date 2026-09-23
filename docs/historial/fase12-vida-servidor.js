// Archivado: workflow de un solo uso del sprint 001 (2026-09-19). No se mantiene ni se ejecuta:
// fija el árbol público como REPO, un ledger en .superpowers/ y modelos que la flota ya no permite.
export const meta = {
  name: 'fase12-vida-servidor',
  description: 'Fase 1+2 del sprint 001: 14 workstreams en worktrees paralelos (Codex/Gemini/Grok/MiniMax/Claude), revision adversarial por tarea y una ronda de arreglo',
  whenToUse: 'Tras el commit Gate 0 (params.ts + tests desbloqueados). Lanzar con Workflow({scriptPath}) desde la raiz del repo. Devuelve por tarea: rama, worktree, commits, veredicto.',
  phases: [
    { title: 'Implementar', detail: '14 worktrees, un modelo por tarea (tasks.md)' },
    { title: 'Revisar', detail: 'revisor Opus por tarea: spec + calidad + constitucion' },
    { title: 'Arreglar', detail: 'una ronda con el mismo modelo si hay hallazgos' },
    { title: 'Re-revisar', detail: 'acotado a los hallazgos' },
  ],
}

const REPO = '/datos/workspaces/personal/AtlasParaIsa'
const TASKS = 'specs/001-mundo-solido-masivo/tasks.md'
const LEDGER = `${REPO}/.superpowers/sdd/tasks/progress.md`
// Commit del Gate 0 (params.ts + tests desbloqueados): todo worktree debe contenerlo. Sobrescribible con args.base.
const BASE_SPRINT = (args && args.base) || '1619c6b'

// modelo: ruta delegar_a_cloud ('claude' = lo implementa el propio agente Claude) · wrapper: modelo Claude del agente
const TAREAS = [
  { id: 'T010', modelo: 'codex/gpt-5.6-sol', effort: 'xhigh', wrapper: 'opus',   tests: 'tests/demography.test.ts tests/senescencia.test.ts', hallazgo: 'C1' },
  { id: 'T013', modelo: 'codex/gpt-5.6-sol', effort: 'high',  wrapper: 'opus',   tests: 'tests/ecosystem.test.ts tests/ecosystem-kernel.test.ts tests/recursos.test.ts', hallazgo: 'C6' },
  { id: 'T011', modelo: 'gemini/pro',        effort: 'high',  wrapper: 'sonnet', tests: 'tests/genetics.test.ts tests/lineage.test.ts', hallazgo: 'homogeneidad (b)' },
  { id: 'T012', modelo: 'grok/grok-4.6',     effort: 'high',  wrapper: 'sonnet', tests: 'tests/family.test.ts tests/demography.test.ts', hallazgo: 'homogeneidad (c)' },
  { id: 'T014', modelo: 'minimax/MiniMax-M3', effort: null,   wrapper: 'sonnet', tests: 'tests/technology.test.ts', hallazgo: 'C2' },
  { id: 'T023', modelo: 'minimax/MiniMax-M3', effort: null,   wrapper: 'sonnet', tests: 'tests/server.test.ts', hallazgo: 'C7' },
  { id: 'T015', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/muerte.test.ts', hallazgo: 'FR-006' },
  { id: 'T016', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/lab.test.ts', hallazgo: 'P3 (lab con Store)' },
  { id: 'T017', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/lab-barrido.test.ts', hallazgo: 'US1' },
  { id: 'T018', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/lab-resumen.test.ts', hallazgo: 'US1' },
  { id: 'T024', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/modo.test.ts tests/connection.test.ts', hallazgo: 'P1' },
  { id: 'T025', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/animals.test.ts', hallazgo: 'P2' },
  { id: 'T022', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/respaldo.test.ts', hallazgo: 'critico: sin respaldo, 6,1 GiB/dia' },
  { id: 'T019', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/diversidad.test.ts', hallazgo: 'FR-007/SC-003 (indice de diversidad)' },
  { id: 'T033', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/calor.test.ts', hallazgo: 'FR-010 mapa de calor (US3 esc. 3)' },
  { id: 'T034', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/luz.test.ts', hallazgo: 'FR-010 pase visual (US4)' },
  { id: 'T035', modelo: 'claude', effort: null, wrapper: 'sonnet', tests: 'tests/agua.test.ts', hallazgo: 'SC-004 agua: 0% regiones secas, distancia 3,0 celdas' },
  { id: 'T020', modelo: 'claude', effort: null, wrapper: 'opus',   tests: 'tests/world-view-size.test.ts tests/connection.test.ts tests/server.test.ts', hallazgo: 'C4' },
  { id: 'T021', modelo: 'claude', effort: null, wrapper: 'opus',   tests: 'tests/server.test.ts tests/store-technology.test.ts tests/chronicle-store.test.ts tests/archive.test.ts', hallazgo: 'C3/C5/C10/C12' },
]

const REGLAS = `
PROYECTO: "Una Carta Para Isa", simulacion determinista (TypeScript estricto, Node 22, node:sqlite, ws, Vite). Repo principal: ${REPO}. Rama del sprint: 001-mundo-solido-masivo.
CONSTITUCION (.specify/memory/constitution.md): I determinismo por semilla y sin rescates ocultos; II evidencia; III reglas simples; IV diversidad y muerte con sentido; V p95 paso < 50 ms; VI experiencia sin mentir. Manda sobre todo.
REGLAS DE EJECUCION (tasks.md, seccion "Reglas de ejecucion", resumidas):
1. Toca SOLO los ficheros listados en tu tarea. Si necesitas algo de otro fichero, escribelo en tu informe.
2. NUNCA edites src/world/params.ts (ya existe, T001): importa sus claves (paramsOf(world).cuerpo.*, .genes.*, .poblacion.*, .recursos.*, .persistencia.*). Si te falta una clave: constante local con '// TODO params:' y reportalo.
3. Verificacion obligatoria: 'npm run typecheck' verde y 'timeout 300 npx tsx --test <tus tests>' verde. NO ejecutes 'npm test' completo.
4. Nada de Math.random/Date.now/performance.now en src/world: usa localRandom(seed, salt) o random(world) de src/world/index.ts.
5. Sin rescates ocultos; toda regla nueva con coste y con un test que pueda refutarla. Con los parametros por defecto el comportamiento debe ser BIT A BIT igual al actual cuando la tarea lo indica (control).
6. No toques data/, ~/.local/bin/atlas-servidor*, ni la carta (S e I, recuerdos, textos de world-shell.ts).
7. Codigo denso como el circundante; textos de usuario en espanol; identificadores en ingles.
8. PROHIBIDO 'npm run build' o 'npm run check' en el repo principal ${REPO}: el servidor publico de Isa corre con cwd ahi y sirve dist/client en caliente. En tu worktree si puedes construir (dist/ es local).
`

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    tarea: { type: 'string' },
    estado: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'BLOCKED'] },
    worktree: { type: 'string' }, rama: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' },
    ficheros: { type: 'array', items: { type: 'string' } },
    typecheck_ok: { type: 'boolean' }, tests_ok: { type: 'boolean' },
    resumen: { type: 'string', description: 'que ley cambio y por que; cifras medidas' },
    concerns: { type: 'string' },
    informe: { type: 'string', description: 'ruta del informe escrito' },
  },
  required: ['tarea', 'estado', 'worktree', 'rama', 'base', 'head', 'ficheros', 'typecheck_ok', 'tests_ok', 'resumen'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    spec_ok: { type: 'boolean' }, calidad_ok: { type: 'boolean' },
    hallazgos: { type: 'array', items: { type: 'object', properties: {
      severidad: { type: 'string', enum: ['critica', 'importante', 'menor'] },
      titulo: { type: 'string' }, fichero: { type: 'string' }, linea: { type: 'number' }, detalle: { type: 'string' },
    }, required: ['severidad', 'titulo', 'fichero', 'detalle'] } },
    no_verificable: { type: 'array', items: { type: 'string' } },
    veredicto: { type: 'string' },
  },
  required: ['spec_ok', 'calidad_ok', 'hallazgos', 'veredicto'],
}

function promptImplementador(t) {
  const externo = t.modelo !== 'claude'
  return `${REGLAS}

ERES EL IMPLEMENTADOR DE LA TAREA ${t.id} (corrige el hallazgo ${t.hallazgo} de docs/REVISION-2026-09-19.md). Estas en un WORKTREE aislado (comprueba con 'pwd' y 'git rev-parse --abbrev-ref HEAD'); el repo principal es ${REPO}. Otros 13 agentes trabajan en otros worktrees a la vez: no toques el repo principal salvo para escribir tu informe.

PREPARACION:
0. AUTO-REPARACION OBLIGATORIA: el harness a veces crea el worktree desde 'main' (viejo) en vez de desde la rama del sprint. Ejecuta: 'git merge-base --is-ancestor ${BASE_SPRINT} HEAD || git merge --no-edit ${BASE_SPRINT}'. Luego confirma que existen src/world/params.ts y que 'grep -c "\\*\\*${t.id}\\*\\*" ${TASKS}' devuelve 1. Si no, PARA y devuelve estado BLOCKED explicando que el worktree no contiene el Gate 0.
1. 'ln -sfn ${REPO}/node_modules node_modules' (el worktree no tiene node_modules). Si 'git rev-parse --abbrev-ref HEAD' es HEAD (detached), 'git checkout -b sprint/${t.id}'. Anota BASE = 'git rev-parse HEAD'.
2. Lee tu tarea: 'grep -n "\\*\\*${t.id}\\*\\*" ${TASKS}' y lee ese bullet ENTERO (es tu brief; los valores exactos estan ahi). Lee tambien la seccion del hallazgo ${t.hallazgo} en docs/REVISION-2026-09-19.md y las lineas de codigo citadas EN SU CONTEXTO.
3. Lee src/world/params.ts (claves y defaults) si tu tarea usa parametros.

${externo ? `IMPLEMENTACION (delegada a ${t.modelo}${t.effort ? ', effort ' + t.effort : ''}):
4. Carga la tool: ToolSearch "select:mcp__cloud-offload__delegar_a_cloud". Llamala con model='${t.modelo}'${t.effort ? `, effort='${t.effort}'` : ''}, access='write', cwd=<ruta absoluta de tu worktree>, timeout_s=1500, y un prompt AUTOCONTENIDO (el delegado NO ve nada de esto): las REGLAS de arriba, el texto LITERAL del bullet ${t.id}, los fragmentos actuales de las funciones a tocar (pegalos con sed -n, con numeros de linea), la firma de src/world/params.ts, y la instruccion de que termine con 'npm run typecheck' y 'timeout 300 npx tsx --test ${t.tests}' verdes y devuelva un resumen de que cambio.
5. Cuando vuelva, VERIFICA TU: 'git status --short' (solo ficheros de la tarea), 'git diff' (lee el diff entero y contrastalo con el brief: ¿cambio la ley pedida? ¿control bit a bit con defaults? ¿determinismo? ¿sin rescates?), 'npm run typecheck', 'timeout 300 npx tsx --test ${t.tests}'.
6. Si algo falla o el diff no cumple el brief: UNA segunda delegacion al mismo modelo con el error/desviacion exacta. Si sigue fallando y es pequeno, arreglalo tu; si es grande, estado BLOCKED con el detalle.` : `IMPLEMENTACION (la haces tu, modelo Claude ${t.wrapper}):
4. Implementa siguiendo el brief al pie de la letra; escribe primero los tests que el brief pide (TDD), luego el codigo. Lee el codigo circundante antes de escribir.
5. Verifica: 'npm run typecheck', 'timeout 300 npx tsx --test ${t.tests}'. Corrige hasta verde.`}

CIERRE:
7. Commit SOLO de tus ficheros en la rama del worktree: 'git add <ficheros>' y 'git commit -m "${t.id}: <una linea>"'. HEAD = 'git rev-parse HEAD'.
8. Escribe el informe en ${REPO}/.superpowers/sdd/tasks/${t.id}-report.md: brief resumido, que ley cambio y por que, ficheros, comandos y salida de typecheck/tests, cifras medidas, dudas. Anade UNA linea a ${LEDGER}: 'echo "- ${t.id}: implementado en <rama> (<base7>..<head7>) tests=<ok/fallo>" >> ${LEDGER}'.
9. Devuelve el resultado estructurado. NO lances subagentes. NO hagas merge ni push.`
}

function promptRevisor(t, r) {
  return `${REGLAS}

ERES EL REVISOR ADVERSARIAL DE LA TAREA ${t.id} (hallazgo ${t.hallazgo}). No edites nada. El implementador dice:
${JSON.stringify({ estado: r.estado, rama: r.rama, worktree: r.worktree, base: r.base, head: r.head, ficheros: r.ficheros, resumen: r.resumen, concerns: r.concerns }, null, 2)}

1. Lee el brief: 'grep -n "\\*\\*${t.id}\\*\\*" ${REPO}/${TASKS}' y ese bullet entero. Lee el informe ${REPO}/.superpowers/sdd/tasks/${t.id}-report.md si existe.
2. Lee el diff COMPLETO: 'git -C ${r.worktree} diff ${r.base}..${r.head}' y 'git -C ${r.worktree} diff --stat ${r.base}..${r.head}'.
3. SPEC: ¿cumple cada requisito del brief? ¿toco ficheros fuera de la lista? ¿edito params.ts (prohibido)? ¿el control con defaults es bit a bit igual cuando el brief lo exige? ¿los tests pueden fallar de verdad (no son triviales)?
4. CONSTITUCION: ¿introduce Math.random/Date.now en src/world? ¿rescates ocultos (constantes que hacen imposible morir, clamps que resucitan)? ¿rompe determinismo (orden de iteracion, floats dependientes del orden)? ¿conserva materia/energia?
5. CALIDAD: bugs reales, casos limite (0 habitantes, 1 habitante, tope alcanzado, tile de agua), regresiones en llamadores (grep de la funcion cambiada en TODO src/).
6. Si puedes, ejecuta en el worktree: 'cd ${r.worktree} && npm run typecheck && timeout 300 npx tsx --test ${t.tests}'.
Clasifica: critica (rompe spec/constitucion), importante (bug real o test que no puede fallar), menor (estilo, nombres). Solo 'spec_ok=false' o hallazgos critica/importante disparan arreglo. Se concreto: fichero:linea y por que. Responde en espanol.`
}

function promptArreglo(t, r, rev) {
  const abiertos = rev.hallazgos.filter(h => h.severidad !== 'menor')
  return `${REGLAS}

ERES EL IMPLEMENTADOR DE ARREGLO (ronda 1/1) DE LA TAREA ${t.id}. Un implementador previo dejo el trabajo en el worktree ${r.worktree} (rama ${r.rama}, ${r.base}..${r.head}) y el revisor encontro estos hallazgos ABIERTOS:
${JSON.stringify({ spec_ok: rev.spec_ok, hallazgos: abiertos, no_verificable: rev.no_verificable }, null, 2)}

1. 'cd ${r.worktree}'; lee el brief ('grep -n "\\*\\*${t.id}\\*\\*" ${REPO}/${TASKS}'), el informe ${REPO}/.superpowers/sdd/tasks/${t.id}-report.md y el diff actual ('git diff ${r.base}..HEAD').
2. Arregla CADA hallazgo abierto (${t.modelo !== 'claude' ? `puedes delegar a ${t.modelo} con delegar_a_cloud access='write' cwd='${r.worktree}' pasando los hallazgos literales, o arreglarlo tu si es pequeno` : 'tu mismo'}). No amplies el alcance.
3. Verifica: 'npm run typecheck' y 'timeout 300 npx tsx --test ${t.tests}' verdes. Commit en la misma rama: 'git commit -am "${t.id}: arreglos de revision"'.
4. Anade al informe una seccion "Ronda de arreglo" con cada hallazgo -> que cambiaste, y la salida de los tests. Linea en ${LEDGER}: '- ${t.id}: ronda 1/1 (<n> arreglados) <head7>'.
5. Devuelve el resultado estructurado con el nuevo head. No lances subagentes.`
}

function promptReRevision(t, r, rev, fix) {
  return `${REGLAS}

RE-REVISION ACOTADA de ${t.id}. Hallazgos que debian arreglarse:
${JSON.stringify(rev.hallazgos.filter(h => h.severidad !== 'menor'), null, 2)}
Diff de la ronda de arreglo: 'git -C ${r.worktree} diff ${r.head}..${fix.head}'. Brief: bullet ${t.id} en ${REPO}/${TASKS}.
Para CADA hallazgo: ADDRESSED o NOT ADDRESSED con fichero:linea. Ademas, ¿la ronda introdujo rotura nueva EN SU PROPIO DIFF? (no re-revises lo que ya estaba). Ejecuta si puedes 'cd ${r.worktree} && npm run typecheck && timeout 300 npx tsx --test ${t.tests}'. No edites nada. Espanol.`
}

// args.solo = ['T014', ...] limita la corrida a ese subconjunto (p.ej. las que no dependen de params.ts antes del Gate 0)
const SOLO = args && Array.isArray(args.solo) ? new Set(args.solo) : null
const TAREAS_RUN = SOLO ? TAREAS.filter(t => SOLO.has(t.id)) : TAREAS
log(`Fase 1+2: lanzando ${TAREAS_RUN.length} tareas: ${TAREAS_RUN.map(t => t.id).join(', ')}`)

const resultados = await pipeline(
  TAREAS_RUN,
  (t) => agent(promptImplementador(t), { label: `impl:${t.id}:${t.modelo.split('/')[0]}`, phase: 'Implementar', model: t.wrapper, isolation: 'worktree', schema: IMPL_SCHEMA }),
  (r, t) => {
    if (!r) { log(`[${t.id}] implementador caido`); return null }
    if (r.estado === 'BLOCKED') { log(`[${t.id}] BLOQUEADO: ${(r.concerns || r.resumen || '').slice(0, 200)}`); return { tarea: t, impl: r, review: null } }
    return agent(promptRevisor(t, r), { label: `rev:${t.id}`, phase: 'Revisar', model: 'opus', schema: REVIEW_SCHEMA })
      .then((review) => ({ tarea: t, impl: r, review }))
  },
  (x, t) => {
    if (!x || !x.review) return x
    const abiertos = x.review.hallazgos.filter(h => h.severidad !== 'menor')
    const necesita = !x.review.spec_ok || abiertos.length > 0
    if (!necesita) { log(`[${t.id}] revision limpia (${x.review.hallazgos.length} menores)`); return { ...x, fix: null, rereview: null } }
    log(`[${t.id}] ${abiertos.length} hallazgo(s) abiertos -> ronda de arreglo`)
    return agent(promptArreglo(t, x.impl, x.review), { label: `fix:${t.id}`, phase: 'Arreglar', model: t.wrapper, schema: IMPL_SCHEMA })
      .then((fix) => ({ ...x, fix }))
  },
  (x, t) => {
    if (!x || !x.fix) return x
    return agent(promptReRevision(t, x.impl, x.review, x.fix), { label: `rerev:${t.id}`, phase: 'Re-revisar', model: 'sonnet', schema: REVIEW_SCHEMA })
      .then((rereview) => ({ ...x, rereview }))
  }
)

const salida = resultados.filter(Boolean).map((x) => ({
  tarea: x.tarea.id, modelo: x.tarea.modelo,
  estado: x.impl.estado, rama: x.impl.rama, worktree: x.impl.worktree, base: x.impl.base,
  head: x.fix ? x.fix.head : x.impl.head,
  ficheros: x.impl.ficheros, resumen: x.impl.resumen, concerns: x.impl.concerns || '',
  revision: x.review ? { spec_ok: x.review.spec_ok, calidad_ok: x.review.calidad_ok, hallazgos: x.review.hallazgos, veredicto: x.review.veredicto } : null,
  arreglo: x.fix ? { estado: x.fix.estado, resumen: x.fix.resumen } : null,
  re_revision: x.rereview ? { spec_ok: x.rereview.spec_ok, hallazgos: x.rereview.hallazgos, veredicto: x.rereview.veredicto } : null,
  menores: x.review ? x.review.hallazgos.filter(h => h.severidad === 'menor').map(h => `${h.fichero}: ${h.titulo}`) : [],
}))

const ok = salida.filter(s => s.estado !== 'BLOCKED' && s.revision && (s.revision.spec_ok || (s.re_revision && s.re_revision.spec_ok)))
log(`Fase 1+2: ${ok.length}/${TAREAS_RUN.length} tareas listas para merge; bloqueadas: ${salida.filter(s => s.estado === 'BLOCKED').map(s => s.tarea).join(',') || 'ninguna'}`)

return { orden_merge_sugerido: ['T014', 'T015', 'T025', 'T022', 'T023', 'T011', 'T013', 'T012', 'T010', 'T016', 'T017', 'T018', 'T020', 'T021', 'T024'], tareas: salida }
