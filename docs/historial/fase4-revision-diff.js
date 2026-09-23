// Archivado: workflow de un solo uso del sprint 001 (2026-09-19). No se mantiene ni se ejecuta:
// fija el árbol público como REPO y cita informes y un ledger de .superpowers/ que no están versionados.
export const meta = {
  name: 'fase4-revision-diff',
  description: 'T041: revision adversarial del diff completo Gate 0 -> HEAD con 3 lentes Opus (determinismo, conservacion de materia, regresion de supervivencia) + refutacion cruzada',
  whenToUse: 'Tras el merge de los worktrees de Fase 1+2 (Gate 1+2). args: { base: "<sha Gate 0>", head: "HEAD" }',
  phases: [
    { title: 'Lentes', detail: '3 revisores Opus, uno por lente, sobre el mismo diff' },
    { title: 'Refutar', detail: 'cada hallazgo critico/importante lo intenta refutar otro Opus' },
  ],
}

const REPO = '/datos/workspaces/personal/AtlasParaIsa'
const base = (args && args.base) || 'HEAD~1'
const head = (args && args.head) || 'HEAD'

const CONTEXTO = `
PROYECTO: "Una Carta Para Isa" (${REPO}), simulacion determinista TS estricto. Constitucion: I determinismo sin rescates; II evidencia; III reglas simples; IV diversidad y muerte con sentido; V p95 < 50 ms; VI experiencia sin mentir.
Se acaban de integrar 15 workstreams (specs/001-mundo-solido-masivo/tasks.md T010-T025) que cambian leyes de vida (senescencia como riesgo), genetica, reproduccion, ecologia (capacidad de carga), tecnologia (recipeId), persistencia (cadencia, poda, validacion), red (state acotado) y cliente (modo observador).
Diff a revisar: 'git -C ${REPO} diff ${base}..${head}' (y '--stat'). Informes por tarea en ${REPO}/.superpowers/sdd/tasks/T0*-report.md. Ledger: ${REPO}/.superpowers/sdd/tasks/progress.md.
PROHIBIDO: editar ficheros, 'npm run build' o 'npm run check' en ${REPO} (el servidor publico sirve dist/ en caliente). Puedes ejecutar 'npm run typecheck' y 'timeout 600 npx tsx --test <ficheros>' y scripts propios con 'timeout 120 npx tsx -e'.
`

const LENTES = [
  { key: 'determinismo', foco: `LENTE DETERMINISMO (constitucion I). Busca en el diff: Math.random/Date.now/performance.now en src/world; iteracion sobre Map/Set/objetos cuyo orden dependa de insercion no canonica; localRandom con salts que colisionen (misma semilla para dos personas o dos ticks); floats acumulados en orden no determinista; estado lateral (WeakMap) que no se propague en cloneWorld; params que cambien resultados con defaults (el control bit a bit era obligatorio en T011/T012/T013). VERIFICA EJECUTANDO: createWorld(4821) con y sin params explicitos, 2400 pasos, JSON identico; dos mundos misma semilla, 1000 pasos, identicos; y si existe scripts/lab/replica.ts, dos replicas iguales dan metricas identicas.` },
  { key: 'conservacion', foco: `LENTE CONSERVACION Y RESCATES (constitucion I y III). Busca: materia/energia creada de la nada (recetas, comida, madera, agua) tras T013/T014; clamps que resuciten valores (salud que sube sin causa, hambre que no baja); constantes que hagan imposible morir tras T010 (hazard con probabilidad 0 en algun rango; cuidadoReduceRiesgo que anule el riesgo); poda de T021 que borre eventos referenciados por memorias/provenance (tests de provenance existen: world.test 'two actual observations retain provenance'); save() que valide y luego escriba otra cosa; slot 2 que no se restaure. VERIFICA EJECUTANDO lo que puedas: un cuerpo con salud y vitalidad plenas a 3x maximumAge debe poder morir (probabilidad acumulada > 0.5 sobre 500 semillas); un mundo 10 dias no crea recursos netos por encima de la capacidad de carga.` },
  { key: 'regresion', foco: `LENTE REGRESION Y CONTRATO. Busca: llamadores rotos de funciones cuya firma cambio (grep en TODO src/ y scripts/ de cada funcion tocada); tests que pasen sin poder fallar; el contrato cliente-servidor tras T020 (¿el cliente lee recipe.program en algun sitio que ahora recibe un resumen? grep 'program' en src/client); T024 (¿el modo observador rompe el modo completo? ¿decidirModo falla sin window?); T023 (¿XFF desde no-loopback se ignora de verdad?); T021 (¿los tests de servidor que asumian guardado por tick siguen siendo validos o se ajustaron trampeando?); T012 (¿assertWorld sigue rechazando poblaciones > 128?); regresion de supervivencia: corre 'timeout 600 npx tsx -e' un mundo createWorld(51926) 12 dias con DEFAULT_PARAMS y reporta poblacion, muertes por causa y si alguien murio por senescencia antes del dia 8 (no deberia).` },
]

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severidad: { type: 'string', enum: ['critica', 'importante', 'menor'] },
      titulo: { type: 'string' }, fichero: { type: 'string' }, linea: { type: 'number' }, tarea: { type: 'string' },
      evidencia: { type: 'string' }, arreglo: { type: 'string' },
    }, required: ['severidad', 'titulo', 'fichero', 'evidencia', 'arreglo'] } },
    verificaciones_ejecutadas: { type: 'array', items: { type: 'string' } },
    resumen: { type: 'string' },
  },
  required: ['findings', 'verificaciones_ejecutadas', 'resumen'],
}
const VERDICT = {
  type: 'object',
  properties: { refutado: { type: 'boolean' }, veredicto: { type: 'string', enum: ['CONFIRMADO', 'PLAUSIBLE', 'REFUTADO'] }, razonamiento: { type: 'string' }, severidad_corregida: { type: 'string', enum: ['critica', 'importante', 'menor'] } },
  required: ['refutado', 'veredicto', 'razonamiento', 'severidad_corregida'],
}

const porLente = await pipeline(
  LENTES,
  (l) => agent(`${CONTEXTO}\n\n${l.foco}\n\nLee el diff ENTERO (es grande: usa --stat primero y luego por fichero). Maximo 8 hallazgos, de mas grave a menos. Cita fichero:linea del diff aplicado (HEAD). Espanol.`, { label: `lente:${l.key}`, phase: 'Lentes', model: 'opus', schema: FINDINGS }),
  (r, l) => {
    if (!r) return null
    const graves = r.findings.filter(f => f.severidad !== 'menor')
    log(`[${l.key}] ${r.findings.length} hallazgos (${graves.length} criticos/importantes)`)
    return parallel(graves.map((f) => () => agent(`${CONTEXTO}

VERIFICADOR ADVERSARIAL. Intenta REFUTAR este hallazgo leyendo el codigo real en HEAD y ejecutando si puedes:
${JSON.stringify(f, null, 2)}
Ante la duda, refuta. CONFIRMADO solo con escenario concreto reproducible. No edites nada. Espanol.`, { label: `refuta:${l.key}:${(f.fichero || '?').split('/').pop()}`, phase: 'Refutar', model: 'opus', schema: VERDICT })
      .then(v => ({ ...f, lente: l.key, veredicto: v }))))
      .then(vs => ({ lente: l.key, resumen: r.resumen, verificaciones: r.verificaciones_ejecutadas, verificados: vs.filter(Boolean), menores: r.findings.filter(f => f.severidad === 'menor') }))
  }
)

const todos = porLente.filter(Boolean)
const confirmados = todos.flatMap(x => x.verificados).filter(f => f.veredicto && !f.veredicto.refutado)
log(`T041: ${confirmados.length} hallazgos sobreviven la refutacion (${confirmados.filter(f => f.veredicto.severidad_corregida === 'critica').length} criticos)`)
return {
  confirmados: confirmados.map(f => ({ lente: f.lente, severidad: f.veredicto.severidad_corregida, tarea: f.tarea, titulo: f.titulo, fichero: f.fichero, linea: f.linea, evidencia: f.evidencia, arreglo: f.arreglo, razonamiento: f.veredicto.razonamiento })),
  refutados: todos.flatMap(x => x.verificados).filter(f => f.veredicto && f.veredicto.refutado).map(f => ({ lente: f.lente, titulo: f.titulo, por_que: f.veredicto.razonamiento })),
  menores: todos.flatMap(x => x.menores.map(m => ({ lente: x.lente, titulo: m.titulo, fichero: m.fichero }))),
  verificaciones: todos.map(x => ({ lente: x.lente, ejecutadas: x.verificaciones, resumen: x.resumen })),
}
