# Revisión independiente final del objetivo 8

**Veredicto: PASS para la entrega de auditoría del objetivo 8. Hallazgos bloqueantes: 0.** No hay correcciones numéricas, de unidades, ventanas, causalidad o requisitos que impidan cerrar esta entrega. Esto acepta el informe de auditoría; C8 sigue sin aprobar y GOAL completo permanece abierto.

Informe revisado: `auditoria-realismo-20260930.md`, SHA256 **`dde249901c7502b7baff2de14c98f0eb71ef4e2066f3d1eb3ec6a0a2344688bb`**. Código de referencia **`bb483260b2489fe62b113d620e5f56e5f3676dbc`**. Objetivo leído íntegro: `/datos/tmp-atlas-lab/datos-lab/codex-goal-8.md`, incluidas prohibiciones. Revisión del diff real: 30 archivos añadidos, instrumentación/documentación/datos de análisis; ningún módulo de reglas modificado. El instrumento nuevo y las fuentes de código se inspeccionaron directamente.

## Findings por severidad

| Severidad | Hallazgos confirmados pendientes | Evidencia / reproducción / corrección |
|---|---:|---|
| P0 | 0 | Sin corrupción de cifras, pérdida de evidencia aceptada ni uso del mundo vivo detectados en el alcance revisado. |
| P1 | 0 | Sin incumplimiento de A/B/C, sustitución de C8 o extrapolación causal bloqueante. |
| P2 | 0 | Las limitaciones materiales de la observación están declaradas; no se elevaron diferencias cosméticas a findings. |

Los P0/P1 que **el informe encuentra en el simulador** son resultados de la auditoría, no bugs de la entrega. Mantenerlos abiertos es parte del resultado correcto: ruina/archivo, contabilidad y observabilidad, transmisión y diversidad. No se aplicaron leyes ni criterios propuestos.

## Evidencia independiente y reproducción

Resultados completos: [codex8-revision-final.json](codex8-revision-final.json).

**105.429 comparaciones, 0 diferencias**; además **22.260 celdas de 1.590 filas CSV, 0 diferencias**. Los totales proceden de ejecuciones efectivas, no de conteos prometidos. Se contrastaron **57 filas de tablas numéricas** del informe con los JSON y sus cálculos. Recursos de cada lote: `prctl(codex8-audit)`, nice **19**, CPUs **6–31**, `TMPDIR=/datos/tmp-atlas-lab`, guardas inicial/final iguales. Los lectores Python no invocaron subprocess ni un simulador.

1. [codex8-final-verificar.py](codex8-final-verificar.py): 102.103 comparaciones. Reconstruye resúmenes desde registros individuales de las seis copias públicas, vuelve a calcular las cuatro ventanas estructurales y contrasta estructuras contra SQLite; comprueba los campos publicados de los 2.428 diarios contra los diarios copiados y recalcula las estadísticas por réplica y grupo. Para C calcula por cuenta propia MK/Sen, factores Hamed–Rao/AR(1), ventanas, proporciones de acciones, agregación igual por semilla y cultura de las seis instantáneas. Usa `math.erfc` independiente; diferencia máxima admitida para p es 1e−7 frente a la aproximación del evaluador. Las decisiones no están próximas al umbral en este recálculo.
2. [codex8-final-verificar-extra.py](codex8-final-verificar-extra.py): 3.318 comparaciones adicionales. Verifica SHA de las copias A/B/C, digest de fuentes históricas y equivalencia de los módulos clave con el panel; calcula Q1–Q5 de diez pares sin ejecutar el evaluador, y C1–C7 de las doce primarias leyendo los campos y fórmulas vigentes. Resultado: primario Q1/Q4/Q5 6/6, fragmentación 1/6; adenda Q1 10/10, fragmentación 3/10, Q4 8/10 y una razón natalidad<0,8; C1–C7 primarios 6/6 por brazo.
3. [codex8-final-verificar-sinteticos.py](codex8-final-verificar-sinteticos.py): ocho filas adicionales de tablas, comprobación de sintaxis y ejecución de `self_tests()` del verificador por import, con bytecode deshabilitado. No invoca `main` ni `--real` ni sobrescribe la revisión anterior del instrumento.
4. Los cuatro CSV externos se leyeron con `csv.DictReader` y cada celda se comparó con la fila correspondiente de `publicos.json`. Sus 0/869/648/73 filas coinciden. La normalización de CRLF a LF conserva sus valores.

Repetición de las comprobaciones propias, secuencial, desde un entorno con las copias privadas preservadas:

```bash
PYTHONDONTWRITEBYTECODE=1 TMPDIR=/datos/tmp-atlas-lab taskset -c 6-31 nice -n 19 /datos/tmp-atlas-lab/codex8-runtime/codex8-python /datos/tmp-atlas-lab/balance/codex8-final-verificar.py
PYTHONDONTWRITEBYTECODE=1 TMPDIR=/datos/tmp-atlas-lab taskset -c 6-31 nice -n 19 /datos/tmp-atlas-lab/codex8-runtime/codex8-python /datos/tmp-atlas-lab/balance/codex8-final-verificar-extra.py
PYTHONDONTWRITEBYTECODE=1 TMPDIR=/datos/tmp-atlas-lab taskset -c 6-31 nice -n 19 /datos/tmp-atlas-lab/codex8-runtime/codex8-python /datos/tmp-atlas-lab/balance/codex8-final-verificar-sinteticos.py
```

La igualdad de CSV y la decisión final también quedan en el JSON. La primera orden regenera la evidencia propia del revisor; preservar el resultado de esta entrega antes de repetirla.

**Lector actual:** SHA256 **`0c37bbb58b5c4cd51f90004aed6fdeca595906e909db8802f0eef3bdc244e40f`**, estable antes/después de la comprobación. **19/19 sintéticos PASS, 0 GAP**. Las once pruebas que invocan el lector auditado pasan; las otras ocho comprueban el lector independiente y sus límites. Se cubren activo sobre archivo, horizonte, legacy, duplicados, coordenadas negativas, continuidad de IDs, checksums, recetas al horizonte, estadísticas faltantes, tasas de intervalo, consumo-reposición ocultos, exclusión de protegidos, claves JSON duplicadas, rechazo de rutas vivas y exactitud entera. Se comprobó sintaxis del lector, verificador y nuevo recálculo de laboratorio.

No se conserva un diff exacto contra el SHA anterior `c83a2c34…`; no se afirma equivalencia histórica byte a byte. La ejecución anterior queda atribuida a su SHA y el SHA actual está probado directamente por estos 19 sintéticos. La modificación del wrapper de recursos y el delimitador CSV no se usan como excusa para reasignar resultados antiguos a un SHA nuevo.

## Cumplimiento y límites sustantivos

| Requisito | Resultado confirmado | Evidencia en el informe revisado |
|---|---|---|
| A: V13/V12 actuales al corte | Seis respaldos copiados, tres por mundo; últimas observaciones 126,750 y 227,250 días. Se excluyen las tres legacy de construidas y se diferencian archivos/activos. | `auditoria-realismo-20260930.md:23,38,79,95,111` |
| A: laboratorio existente | 42 identidades, 2.428 diarios, 35 con 60 días y siete parciales; cinco brazos canónicos de cupo, sin duplicar prefijos/relanzamientos. Ventanas parciales declaradas. | `:133–149` |
| A: uso por casa/día y nunca-consumo | No recuperables con estos datos. Se presentan tasas por intervalo, observabilidad faltante y propuestas de ledger. Las reservas transversales no se convierten en consumos. | `:49,70,86,93,109,149` |
| B: brechas de GOAL/constitución/C1–C8 | Ocho criterios descritos conforme al código y 16 instrumentos propuestos con medida, umbral y ventana; fuentes históricas identificadas. No se redefine C8 ni se presenta un umbral candidato como vigente. | `:151–214`, especialmente `:163–170,182–197` |
| C: homogeneización y diferenciación | 20 series reproducidas; C8 0/6 y 0/10 aprobadas por brazo. La caída de oficio explica aritméticamente 97,21 %/96,32 % del descenso compuesto, sin atribuir ese porcentaje causal a una ley. | `:216–305,325` |
| C: candidatas y CULT-VAR | Tres leyes locales con manipulación, predicción conductual, refutación, seguridad y C8 final obligatorio. Crítica CULT-VAR leída completa; se conservan riesgos y se descartan extrapolaciones de sus otros controles. | `:307–325` |
| Entrega | Resumen exactamente de 15 líneas y ocho filas priorizadas de defectos/decisiones. | `:3–17,328–339` |

**Hechos confirmados por código:** `observeUse` solo incrementa ante beneficio positivo (`src/world/inventions.ts:365`); `functionalNear` excluye condición≤0,1 (`:375–376`); reparación paga 1 madera/30 trabajo y suma 0,4 (`:457–461`); desgaste activo ocurre cada diez ticks y no aplica un avance por edad de archivo (`:466–472`, `src/world/spatial.ts:121–141,185–205`). La protección corporal contra fatiga de lluvia mira `terrain=shelter` (`src/world/index.ts:382`), por lo que el informe acierta al limitar “rotura apaga funciones” a los servicios comprobados y señalar protección residual.

**Cultura y selector:** `bond` contrae diferencias sin filtro de comunidad (`src/world/society.ts:23–30`); el aprendizaje normativo tiene incrementos de un solo signo (`src/world/index.ts:880–887`); habilidades útiles suman 0,008 (`:893`); herencia cultural promedia a los progenitores y reinicia la práctica adquirida (`:1338–1340`). El argmax y los valores adquiridos se ven en `:786,828`; COM-D′ modifica pertenencia/disolución, no cancela esa mezcla. El informe diferencia estos mecanismos de una estimación causal de cuánto explica cada uno. El paquete de parámetros entre control/tratamiento está declarado; no se atribuye a disolución aislada todo el efecto de F.

**Criterios:** la supervivencia revisa la ventana final, C6 cierra el censo y C7 cuenta usos con autor, sin filtrar S/I en el productor (`scripts/lab/criterio-terminado.mts:429–437,532–576`; `scripts/lab/metrics.ts:44–71`). La formulación de esas brechas es correcta. Las cifras históricas B se contrastaron en las líneas de `docs/EVIDENCIA.md`/specs/constitución citadas; no se recalcularon experimentos antiguos ni se trasladaron a V13.

**Límites:** usos≠visitas, home≠ocupación, archivo≠estado simultáneo, masa/saldo intacto≠nunca usado, receta histórica≠función vigente. Tres respaldos por mundo y una semilla pública no dan una serie diaria ni un contraste causal entre versiones. Los 16.844/11.082 insumos de `uses=0` pertenecen a la ventana retenida; no reconstruyen el prefijo podado. El recálculo propio tomó los totales de recetas/recibos del JSON validado y comprobó 30 filas crudas de cada tipo por último respaldo; la extracción integral independiente previa de seis copias/dos catálogos/cuatro intervalos, 133.166 comparaciones, permanece documentada separadamente en `codex8-revision-instrumento.json`.

## Pruebas reales, recursos y cierre

Se leyó el log real `codex8-test.log`: **1.629 tests, 1.620 PASS, nueve SKIP, cero FAIL**, duración **433,123671094 s**. `codex8-validacion-repo.json` registra typecheck exit0 y test exit0; sus 434,281 s incluyen el wrapper, por eso no se confunden con los 433,124 s de TAP. No se repitió una suite masiva ni se construyó/publicó el producto.

`recursos.json` canónico coincide con las guardas válidas **embebidas** en `publicos.json`, declara que se restauró desde esa evidencia y contiene su SHA256. La repetición fallida se conserva en `recursos-replay73703-FAIL.json`: inicio nice19, final nice−4, `valid=false`. No se presenta como PASS ni sustituye a la extracción/verificación aceptadas. El replay fallido de la revisión independiente anterior también se identifica como fallido en su propio artefacto. Las pruebas propias finales sí tuvieron guardas iguales; no se atribuye causa a las derivas ni se cambió un servicio para resolverlas.

No se editaron reglas, GOAL, constitución, evaluadores, preregistros, carta, main, worktrees ajenos ni servicios. Se abrieron exclusivamente las copias privadas del público y copias de diarios; no se accedió al mundo vivo, credenciales o canales externos. Solo se escribieron estos artefactos propios de revisión y scripts con prefijo `codex8-final-verificar`.

**Para codex8-FIN:** esta revisión no exige otra simulación, otra ley ni otro gate masivo. El integrador debe conservar informe, JSON, CSV, fuentes y guardas PASS/FAIL; incluir/enlazar esta revisión y su SHA exacto; completar el registro de entrega en la rama propia y la bitácora autorizada; y recién entonces crear FIN. Si cambia solo el estado/parágrafo de validación final, registrar SHA revisado y SHA final y probar que las tablas/contenido empírico permanecen iguales. FIN significa auditoría entregada, sin alterar el fallo de C8 ni cerrar el mundo completo. El revisor no creó FIN.
