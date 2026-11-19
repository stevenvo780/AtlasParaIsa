# Una Carta Para Isa — plan unificado

## Estado actual

- **Estado publicado vigente**: consultar únicamente [docs/ESTADO.md](docs/ESTADO.md) (mundo V13 en la torre, `RULES_VERSION` 11 + COM + COM-D′, `PROTOCOL_VERSION` 10, SQLite `user_version` 5).
- **Meta y revisiones vigentes**: [GOAL.md](GOAL.md), [revisión del 24 de septiembre](docs/REVISION-2026-09-24.md), [revisión del 22 de septiembre](docs/REVISION-2026-09-22.md) y [revisión de la noche del 22](docs/REVISION-NOCHE-2026-09-22.md).
- **Corte operativo archivado (2026-10-03 → 2026-10-06 14:49 UTC)**: marcador histórico **7/24** (`C1–C7`); ninguna aceptación científica nueva (`C8–C24` abiertos). En el worktree `AtlasParaIsa-anexo/worktrees/criterios-realismo-20261003` cerró el gate técnico **G1** (`ROOT-G1-GO v9c`, T004–T006, 1733/0/9) y siguen abiertos **G2** (replay completo de App y 6 semillas técnicas × 1200, `B9 NO_GO`), **G3** (48 casos + 8 controles RAW), **G4** y `T019` (6 semillas nuevas × 60d). El registro completo de los 24 cortes del 2026-10-06 y las notas del 03–04 oct quedó archivado sin pérdida en `AtlasParaIsa-anexo/archivo/PLAN-cortes-20261003-20261006.md` (y el respaldo previo en `AtlasParaIsa-anexo/archivo/PLAN.md.pre-g1-g2-0cc2ce345d91.bak`); la matriz fila por fila está en `AtlasParaIsa-anexo/worktrees/criterios-realismo-20261003/specs/003-criterios-realismo/acceptance-status.md`.

Lo publicado se consulta exclusivamente en [ESTADO](docs/ESTADO.md). El plan de cierre
vigente es el siguiente; los balances fechados posteriores de este documento son históricos.

## Plan de cierre C1–C24 — recuperación del 3 de octubre de 2026

**Objetivo:** completar la meta de [GOAL](GOAL.md) mediante evidencia conjunta de C1–C24,
con pruebas de servidor y experiencia separadas de las réplicas biológicas.
**Arquitectura:** conservar el motor autoritativo y determinista; medir primero las brechas,
contrastar una ley local por experimento y aceptar únicamente mejoras materiales verificadas.
**Tecnología:** TypeScript, Node, SQLite, Vite y los instrumentos existentes del laboratorio.
**Base del plan:** GOAL, la constitución y la decisión recuperada de Steven de adoptar B01–B16
como C9–C24; el encargo pendiente está en `datos-lab/codex-goal-12.md` del laboratorio.

Este plan organiza trabajo futuro. No acredita criterios nuevos, aprueba candidatas ni cambia
reglas, evaluadores congelados, umbrales o publicaciones. La ejecución SDD seguirá
`/speckit-implement` con tareas y ownership explícitos antes de cada implementación.

### Qué se recuperó y qué quedó detenido

- Sesión principal de Claude: `71b6da8a-24fe-445a-abe9-a2469c7538ac`, en
  `/home/stev/.claude/projects/-datos-workspaces-personal-AtlasParaIsa/`.
  Última petición humana: pausar el monitor por falta de tokens, **01-10 18:48:47 -05**.
  Claude confirmó la pausa a las 18:49:30. La memoria resume la hora como ~18:25;
  para la petición exacta manda el registro de la sesión. No se ha reactivado el monitor.
- La decisión del **30-09** mantiene **C8 por tendencia creciente**, y la del **01-10**
  amplía «terminado» a **C1–C24**. La frase de ESTADO sobre una lectura de C8 pendiente
  está superada por esa decisión, aunque todavía no se ha corregido allí.
- La auditoría de realismo está terminada y revisada. C9–C24 se adoptaron como frentes;
  sus umbrales candidatos requieren la especificación y calibración prevista en el objetivo 12.
  No se encontraron `docs/CRITERIOS-REALISMO.md`, `scripts/lab/criterio-realismo.mts`,
  su línea base final ni la rama/worktree previstos para ese objetivo.
- **P0.c / objetivo 11:** los cuatro JSONL de 9501–9504 conservan 31/37/32/41 de 60 días.
  Las cuatro ejecuciones acabaron con `SIGTERM`/`missingInnerReceipt`; el cierre coincide
  temporalmente con el cierre de sesión/user-manager del 02-10 a las 05:54 UTC, pero se
  desconoce quién emitió la señal. El reboot posterior invalida la época y no explica por sí
  solo la primera interrupción. El estado es **interrumpido**, no un veredicto científico.
  Repetir los cuatro desde tick 0 en una época nueva; no usar el runner hardcoded sin adaptación
  operacional aprobada. La calibración previa de cuatro semillas y su perfil P90 sí tienen cierre.
- **DESG-D60:** de 36 trayectorias, 9 están completas sin validar, 14 interrumpidas y 13 no
  iniciadas; ninguna es completa válida. Tener 60 registros no acredita fuentes, recibos,
  continuidad ni seguridad.
- **Muse4 sequía:** de seis secuencias, tres están completas sin validar y tres interrumpidas;
  ninguna es completa válida. No se encontró cierre/evaluación final; no se leyeron outcomes.
- La reconciliación de archivos de staging halló tres targets `underlay` de 0 B que son stubs
  `ro-bind`, no corrupción de fuente. AMD (111067 B), clock (332 B) y recipe (196363 B)
  canónicos coinciden por SHA con fuentes v7. R0 sigue abierto: esos estados no son aceptación.
- No hay réplicas nuevas científicas en marcha. La revisión Sol autoriza preparar nueva operación
  P0.c con ciencia sin cambios, pero da NO-GO a ejecutar los comandos antiguos sin adaptación.
- **Objetivo 7 / escala:** la asignación diferida de productos quedó archivada en
  `530c846`: paridad observada, rendimiento sin mejora conjunta y suite completa fallida.
  El siguiente ensayo de pertenencia quedó preparando/corrigiendo el lanzador; no tiene
  aceptación de rendimiento. No se encontraron `codex7-FIN`, `codex11-FIN` ni `codex12-FIN`.
- Las sesiones tmux antiguas en los sockets `codex` y `muse` no están disponibles.
  El reinicio que interrumpió P0.c está confirmado; otras causas no se atribuyen sin evidencia.
  No se han relanzado procesos.
  La consulta del 03-10 confirmó health público correcto y servicio/timer activos;
  disponibilidad operativa no equivale a cumplimiento biológico.

Fuentes locales de recuperación, sin copiar conversaciones ni bases al repositorio:
`/datos/tmp-atlas-lab/datos-lab/bitacora.md`,
`/datos/tmp-atlas-lab/balance/auditoria-realismo-20260930.md`,
`/datos/tmp-atlas-lab/balance/codex11/P0C-PORTABLE-HANDOFF-20261001.md`,
`/datos/tmp-atlas-lab/datos-lab/desg-d60/PRERREGISTRO.md` y las memorias
`c8-decision-crecer.md`, `criterios-realismo-c9-c24.md`, `estado-20261001-pausa.md`
de la sesión de Claude. El corte actualizado está en
`/datos/tmp-atlas-lab/orquestacion-20261003/recuperacion/RECUPERACION.md` e
`INVENTARIO.json`; las puertas operativas están en
`/datos/tmp-atlas-lab/orquestacion-20261003/recursos/RESULTADO-RECURSOS.md` y
`recursos/fedora/FEDORA-RECURSOS.md`. Estas rutas son locales, no artefactos disponibles en otro clon.

### Matriz de cobertura para el cierre

«Pendiente» significa que no hay aceptación integral del criterio nuevo; no afirma que falte
toda implementación. C1–C7 están acreditados en el panel publicado, no en todas las campañas.
El diagnóstico observable de la auditoría y sus ablaciones todavía deben convertirse en
evaluaciones ejecutables; un histórico de otra versión no aprueba la versión candidata.

| Criterio | Frente y estado recuperado | Evidencia que falta para cerrar |
|---|---|---|
| C1–C7 | Supervivencia, recambio, generaciones, cooperación, conflictos, muertes y tecnología: panel publicado favorable | Revalidar sobre el código integrado final; conservar el alcance y las limitaciones del evaluador congelado |
| C8 | Diversidad de conducta creciente: falla en los paneles publicados | Tendencia que cumpla el evaluador vigente; un nivel mayor entre comunidades no sustituye la tendencia |
| C9 | Uso de obras y construcción marginal: pendiente | Uso por ID y usuario, servicio material y control de utilidad de construir |
| C10 | Desgaste, mantenimiento y ruinas: pendiente; DESG-D60 incompleto | Condición, exposición, pérdida de función y reparación con costes; definir la política de ruinas sin inventarla |
| C11 | Continuidad material y reposición: pendiente | Varios recambios e insumos repuestos por la red; retirada y restauración física de un proveedor |
| C12 | Conservación y alivio corporal: pendiente | Balance de materia, agua, trabajo y pérdidas; alivio sólo tras consumo real |
| C13 | Muerte temprana y causalidad individual: pendiente | Edad, lugar, historia causal y frecuencia temprana, además de las cuatro etiquetas de C6 |
| C14 | Transmisión y redescubrimiento: pendiente | Enseñanza local, pérdida del último conocedor y redescubrimiento pagado; usar no concede instrucciones |
| C15 | Novedad funcional y catálogo ampliable: pendiente | Nueva función ejecutada con beneficio y costes, genealogía resoluble y archivo más allá de la caché |
| C16 | Migración por escasez y abandono: pendiente | Trayecto, cambio duradero de hogar, consumo en destino y contraste causal de escasez |
| C17 | Roles, dependencias e instituciones adaptables: pendiente | Especialización útil, receptores, sustitución de proveedores y consecuencias de reglas sociales locales |
| C18 | Conflictos y acuerdos con consecuencia: pendiente | Desencadenante material y cambio posterior de acceso, consumo, recurrencia o confianza |
| C19 | Ecología y territorio fuera de cámara: pendiente; congelación lejana conocida | Política multiescala, conservación al activar/retirar y trayectorias independientes de las cámaras |
| C20 | Demografía frente a topes de software: pendiente; cupo global activo | Atribución de cada freno; retirar el regulador global con una ley local validada y conservar determinismo |
| C21 | Mundo durable y compartido: evidencia técnica parcial | Estado e historia coherentes ante interrupciones, rollback y reconexión; cámaras con el mismo reloj |
| C22 | Rendimiento y hardware equivalentes: aceptación integral pendiente | Coste completo de paso, guardado, proyección, RAM, disco y red; mejora medida sin cambiar el mundo |
| C23 | Carta, agencia, accesibilidad y legibilidad: pendiente | Recorrido en teléfono real y teclado, consecuencias legibles y revisión personal de Steven |
| C24 | Calidad del experimento y neuroevolución: método parcial, entrenamiento sin comenzar | Procedencia/control/semillas reservadas; entrenamiento posterior a afinar el mundo, con contraste neutral y selector actual |

### Restricciones y controles transversales

- C1–C8 y su evaluador congelado no se cambian. Su umbral de agregación actual admite
  exactamente la mitad; no llamarlo mayoría estricta ni imponer otro umbral sin preregistro.
- Separar criterio aprobado, fallado, desconocido, no observado e infraestructura interrumpida.
  Una trayectoria parcial o ausencia de eventos sin observabilidad no se convierte en éxito.
- Excluir S e I del éxito autónomo en los nuevos instrumentos; documentar las inclusiones
  heredadas del evaluador antiguo sin modificarlo para mejorar sus resultados.
- Todo instrumento observador conserva digestos con/sin medición; hardware y cámaras
  no cambian leyes ni resultados de pasos equivalentes. Ningún rescate o suministro oculto.
- Preservar campañas interrumpidas, fuentes, parámetros y recibos. No juntar prefijos de épocas
  diferentes. El handoff de P0.c exige repetir sus cuatro controles desde tick cero si la época
  se interrumpió mecánicamente; no existe permiso técnico para continuarla como si nada.
- Nuevos experimentos usan el método de placebo adoptado el 01-10. Los veredictos antiguos
  permanecen cerrados; el panel DESG-D60 tiene su propio contrato de aceptación.
- Mantener un escritor por área; worktrees en `AtlasParaIsa-anexo/worktrees/`, laboratorio
  temporal y público intacto. La autorización de recursos del 03-10 reemplaza la afinidad
  histórica 12–31 y el límite de madrugada; verificar el estado de cada límite antes de usarlo.
  La portátil comparte la cuota Codex principal.
- Consultar cuotas y rutas actuales antes del reparto. El 03-10 se consultaron ambas:
  Gemini Pro revisó cobertura en lectura (job `180371008af94b4196850c742e74d34c`);
  Codex realizó recuperación y síntesis. La cuota Claude fue desconocida. Reconsultar al ejecutar.

### Recursos y reparto de agentes — 3 de octubre de 2026

El árbol principal conserva sólo la orquestación. El primer grupo tiene cuatro agentes
subordinados (dos Luna y dos Sol high) más el coordinador, dentro de cinco slots nativos;
no se abren seis agentes ni se asignan cuatro jobs cloud por agente. El pool MCP admite
hasta cuatro jobs agregados. Cada artefacto tiene un escritor y una revisión independiente;
al acabar una entrega, el revisor puede rotar a otro carril.

| Espacio | Ownership / salida | Gate y dependencia | Asignación inicial |
|---|---|---|---|
| R0 recuperación | Luna: inventario documental, recibos y estados; entrega de recuperación | P0.c: cuatro ejecuciones interrumpidas, prefijos 31/37/32/41 de 60 días; reboot posterior invalida la época, no explica por sí solo la interrupción inicial. Requiere nueva época y cuatro controles desde tick 0; inventario total sigue abierto | Luna; `/datos/tmp-atlas-lab/orquestacion-20261003/recuperacion` |
| R1 criterios | Sol 6.1 high: `docs/CRITERIOS-REALISMO.md` y spec/tareas C9–C24 | Fórmula, ventana, denominador, umbral y desconocido; separado de C8 y no dependiente de P0.c | Despachado en worktree `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/criterios-realismo-20261003`, rama `codex/criterios-realismo-20261003`, HEAD `bb483260b2489fe62b113d620e5f56e5f3676dbc`; Sol 6.1 high, cuenta secundaria `561…`, job `8de35915a3eb42259fb6fdbb79434ebd`, timeout 1800 s. El job `8de35915a3eb42259fb6fdbb79434ebd` terminó succeeded (2026-10-04 01:37:43 UTC): entregó `docs/CRITERIOS-REALISMO.md`, `specs/003-criterios-realismo/ENTREGA.md`, spec/plan/tasks, schemas v1 y 26 tareas. R1 sigue sin aprobar: la revisión v2 (job MCP `47510e03921d4091a2fac76ead47299f`) emitió NO-GO-R2 por dos bloqueos; G1 semántica sigue pendiente. La corrección secundaria job MCP `96bd6836a13d47daa0286bcd75d86f05` falló por timeout 900 s a las 02:52:42 UTC, sin señal de auth/cuota. Luna conservó diagnóstico y snapshot privado de 88 archivos en `/datos/tmp-atlas-lab/orquestacion-20261003/criterios-autor/DIAGNOSTICO-TIMEOUT-R1-v3.md` y `snapshots/timeout-r1-v3-20261004T0254Z`; manifiesto 7/54 hashes coinciden, 47/54 están obsoletos, 64/64 rutas de índice existen. Nuevo job MCP `2b601dd3bf462f9d321b3541853be6` continúa con la misma cuenta secundaria Sol 6.1 high, timeout 1500 s, limitado a finalizar los dos fixes e integridad. Los IDs `d1ab5…`, `96bd…` y `2b601…` son jobs MCP, no commits. R1v3 requiere formalización independiente; R2 sigue NO-GO, sin cambios de motor/ciencia. Copia fiel del handoff: `/datos/tmp-atlas-lab/orquestacion-20261003/criterios-autor/ENTREGA.md` (SHA-256 de la fuente `5ddf7ef2e7c09b73f11c2d51de9e1087fa864fa698ab15d23f9f58e980b20bb4`). El intento anterior `5f9fbf0fb73944bc87ce91caa5c6c204` se canceló por el orquestador tras 20 min sin artefacto/worktree, no por auth/cuota. |
| Revisión R1 | Sol 6.1 high, principal: revisión independiente, sin editar contrato | R1-v2 NO-GO-R2; R1-v3 formal y peer pendientes; G1 semántica pendiente | Informe v2 `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/REVISION-R1-v2.md`. La corrección v3 de autor job MCP `96bd6836a13d47daa0286bcd75d86f05` falló timeout 900 s (no auth/cuota); Luna preservó diagnóstico/snapshot 88 archivos. Nuevo job MCP `2b601dd3bf462f9d321b3541853be6`, misma cuenta secundaria/Sol high, timeout 1500 s, solo completar ambos fixes e integridad. Jobs MCP, no commits. |
| Observador de viabilidad | Sol 6.1 high, principal: informe independiente, sin editar autoría ni ejecutar motor/ciencia | Informe de viabilidad separado; no desbloquea R1 por sí solo | Job `77fb33129aed47d992d200dfbfc7b2b8` completado. Informe durable: `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/VIABILIDAD-OBSERVADOR.md` (SHA-256 `f925390b238bdc34a23e426dfb6ebd016c3aa1ad4bf94a6d6e25be8edc5491be`). |
| R2 observadores | Ownership separado de `replica.ts`/`instrumentos.ts` | Gate 6×1200 con digestos iguales y coste medido | Bloqueado por NO-GO-R2/G0 abierto; no iniciado |
| R2 evaluador | Sol high, escritor distinto: `scripts/lab/criterio-realismo.mts` y pruebas propias | Solo lectura; fixtures sintéticos pass/fail/unknown; requiere contrato R1 sellado | Casos de revisión disponibles; no son fixtures ejecutados ni evidencia empírica |
| R3 línea base | Luna: runner/informe y recibos en espacio nuevo de evidencia | Depende de R1/R2, semillas nuevas verificadas y preregistro; seis semillas × 60 días, desconocidos explícitos | Luna ejecuta checks; réplicas son procesos compute, no agentes |
| R4 campañas pendientes | Ownership separado por manifiestos/salidas P0.c y DESG-D60 | Preservar parciales; P0.c interrumpido: nueva época y cuatro controles desde tick 0; runner original requiere adaptación operacional aprobada | Sol high adversarial sobre procedencia; Luna coteja cobertura |
| R6 escala / R7 técnico y UI | Worktrees y artefactos separados para territorio/natalidad, Store/servidor y experiencia | No usar el worktree sucio de pertenencia como espacio limpio; C21/C23 puertas distintas de biología | Asignación posterior; el trabajo de carta queda con Steven |

**Capacidad observada, 03-10 ~19:00 Bogotá.** Es una muestra puntual, no una promesa de
throughput ni una garantía de capacidad física sostenida.

| Equipo | Estado observado | Uso sugerido sujeto a gates |
|---|---|---|
| Torre Kratos | Ryzen 9 9950X3D, 32 hilos, 125 GiB; 81 GiB disponibles, swap 159 GiB con 5,2 GiB usados; load 6,6, CPU 84,8% idle en lectura puntual; `/datos` 276 GiB libres (77% usado). RTX 5070 Ti 16 GiB (~3 usados), RTX 2060 6 GiB (~0,1 usado), driver 615.71.09 | Réplicas CPU y suites medidas; GPU solo render/benchmark. Público V13 activo (RSS ~1,5 GiB; cgroup ~5,3 GB) y Vitest activo: no tocar procesos ajenos. No se detectaron réplicas Atlas activas. |
| Fedora portátil | SSH `fedora` funciona; i7-12700H, 20 hilos, 38 GiB RAM; 28 GiB disponibles, swap 8 GiB sin uso, load 0,43. Datos ext4 641 GiB, 440 usados/169 libres (73%); `/home` 206 GiB libres. Intel Iris Xe; no se ve NVIDIA | Puede alojar réplica(s) CPU tras medir. Sin tmux histórico ni réplicas detectadas; conservar checkouts sucios. |

**Autorización de recursos del 03-10:** la portátil puede usar hasta el 100% de la CPU
permitida por el host durante todo horario; la torre puede usar hasta el 80% de la CPU
total durante todo horario (25,6 CPU equivalentes de 32). Son techos autorizados, no
objetivos de saturación ni garantía de disponibilidad sostenida. La admisión debe contar
CPU de tareas autorizadas junto con Vitest, público y todas las cargas ajenas para mantener
el total bajo 80%. Ya no aplica una partición fija de CPU ni una
ventana exclusiva de madrugada.

| Host | Límite propuesto / autorización | Estado |
|---|---|---|
| Torre | CPUQuota 2400% (24 CPU) en slice propia; cpuset 0–31; MemoryMax inicial 32 GiB; preflight `MemAvailable` ≥40 GiB además del pedido. Supervisor para solo sus lotes si CPU global >80% durante tres muestras, si `MemAvailable` cae a 44 GiB o si `/datos` llega al suelo de 220 GiB libres. | Slice/guardrails base verificados. Pruebas mecánicas rechazaron `--cpu 25` antes de iniciar y confirmaron stop de lote propio (`exit 143`, cgroup vacío). Cap de output corregido; gate mecánico torre PASS. Primer intento P0.c run `p0c-recovery-20261003-v1` admitió supervisor 02:52:57.834, pero el hijo salió 1 antes del primer `Popen`: materializador `ROOT-GO` emitió `amdSha256` en vez de `amendmentSha256`. No se crearon procesos científicos, World, boots, ACK ni START files; 83 pins revisados sin alteración. Unidad muerta/cgroup vacío; reserva terminal persiste hasta reconciliación CLI. START2 validado el 2026-10-04 03:01:09.870 UTC: recibos de cuatro boots/ACK y STARTFILES con SHA pasan; modelos 9501–9504 vivos en Fedora bajo FULL 20 CPU/24 GiB/output 40 GiB. ROOT-GO SHA `b18105d3773c36a6c7ac34b21e2cfbbfb8888b6495dca18040c87e18a31fb863`. Esto valida el inicio de época, no resultados ni aceptación científica; C+B, 4×60 y 240×14 siguen pendientes. |
| Fedora | 20 CPU, 24 GiB RAM y output 40 GiB bajo perfil FULL aplicado; admitir solo si `MemAvailable` ≥ solicitud+4 GiB y disco libre ≥140 GiB. Backup privado de configuración propia. | Luna live confirmó PASS mecánico del supervisor SHA `f8e62e…e6907` y reporter `b610…e330`. Root aprobó el segundo inicio operacional condicionado; START2 sí tiene inicio operativo validado (2026-10-04 03:01:09.870 UTC): cuatro boots/ACK y hashes STARTFILES PASS, modelos 9501–9504 vivos. No implica PASS científico; los cierres C+B, 4×60 y 240×14 siguen pendientes. El primer intento murió antes de `Popen`; no aceptación biológica. |

La torre tiene slice agregada y freno de CPU global que solo detiene sus trabajos; la revisión
independiente confirma el rechazo por exceso de CPU y el stop propio con `exit 143` y cgroup vacío.
El cap de salida de torre está corregido y su gate mecánico pasó. Fedora FULL también pasó revisión mecánica live; estos PASS de recursos no sustituyen autorización científica. Aumentar
réplicas de 1→2→4 en torre y 1→2 en Fedora solo tras corregir gates y revisar muestras de exit,
RSS, p95/coste, swap nuevo, PSI, disco y carga ajena.
Ejecutar una suite por equipo a la vez; esperar cierres limpios antes de cambiar concurrencia.

Presupuesto de almacenamiento propuesto: ≤60 GiB nuevo en `/datos`, manteniendo uso
≤85%; en Fedora ≤20 GiB por campaña y ≥100 GiB libres. `/tmp` de torre es tmpfs que
comparte RAM: no alojar allí bases grandes. Vigilar también `/mnt/Data2` (611 GiB libres).
No borrar almacenes o procesos ajenos para recuperar capacidad.

**Cuotas y rutas, consulta del 03-10.** La cuenta Codex principal `b5f…` marca 58%
disponible en ventana semanal en la app; la sesión Codex de Fedora usa el mismo ID, así
que no es cuota independiente. Los perfiles `secundaria` y `jhon-existente` comparten
la cuenta `561…`, distinta de principal/flota/Fedora; smoke de Luna
(`codex/gpt-6-luna`, texto, low) completó en 4,9 s,
job `761d08498cd34e4cab17010721375bf3`. Su cuota sigue desconocida: el sondeo ai-usage
está desactivado y no hay lecturas recientes. No copiar credenciales ni cambiar perfiles.
Sol high está disponible en Codex 6.1; para R1 se propone perfil secundario y para R2
principal, con cuenta/proveedor/job/cwd anotados en cada recibo. Gemini indica 76% en
ventana de 5 h y 82% semanal; MiniMax 67% en 5 h y 22% semanal: reservarlos para trabajo
que lo requiera, sin usarlos en este inventario. El catálogo anuncia `claude/opus`, pero no
confirma que sea la versión exacta Opus 5.5. Mantener Sol high como revisor difícil hasta
verificar esa versión; no sustituir proveedor o modelo silenciosamente.

El MCP `fedora-offload` está configurado en `/home/stev/.codex/config.toml` para SSH
`fedora` y `/home/stev/.local/bin/cloud-mcp-fedora`, pero hoy sus tools no están expuestos;
el alias `fedora-local` también apunta a remoto. Para usar ese puente se requiere recarga
segura de herramientas/sesión y verificación de catálogo antes de crear jobs. SSH directo
no equivale a MCP expuesto. El ejecutable existe y respondió a `initialize` y `tools/list`
por stdio (7 herramientas): transporte probado, exposición en la app pendiente. El wrapper
usa CODEX_HOME principal `b5f…`; el catálogo confirma las rutas `codex/gpt-6-luna`,
`codex/gpt-6.1-sol` y `claude/opus` (versión 5.5 sin confirmar). El alias `portatil` apunta
a `/home/stev/.codex` y al mismo account_id `b5f…` de principal. No se lanzaron modelos
remotos. No instalar ni cambiar configuración.

**Estado al 04-10:** R0 recuperó la matriz de campañas, aún sin aceptación. R1 se reintentó en
worktree preparado, rama `codex/criterios-realismo-20261003` (HEAD `bb483260b2489fe62b113d620e5f56e5f3676dbc`): job `8de35915a3eb42259fb6fdbb79434ebd`, Sol 6.1 high, cuenta secundaria, terminó succeeded a las 01:37:43 UTC. Contrato, spec, plan, schemas v1 y 26 tareas fueron entregados, pendientes de revisión y sin aprobación. El handoff documental se copió fielmente a `/datos/tmp-atlas-lab/orquestacion-20261003/criterios-autor/ENTREGA.md` (SHA-256 fuente `5ddf7ef2e7c09b73f11c2d51de9e1087fa864fa698ab15d23f9f58e980b20bb4`). Revisión Sol principal R1-v2 job MCP `47510e03921d4091a2fac76ead47299f` terminó NO-GO-R2 por dos bloqueos; G1 semántica sigue pendiente. Luna validó tres schemas, 27 estructuras, cuatro parsers y 194 punteros, pero cuatro casos semánticos requieren engine. Corrección secundaria job MCP `96bd6836a13d47daa0286bcd75d86f05` terminó FAILED por timeout 900 s (02:52:42 UTC), sin auth/cuota. `DIAGNOSTICO-TIMEOUT-R1-v3.md` y snapshot privado de 88 archivos quedan preservados; 64 rutas de índice existen, con 7/54 hashes de manifest coincidentes y 47 stale. Nuevo job MCP `2b601dd3bf462f9d321b3541853be6`, misma cuenta secundaria/Sol high, timeout 1500 s, limitado a terminar dos fixes y recalcular integridad. IDs `d1ab5…`/`96bd…`/`2b601…` son jobs MCP, no commits. R1 formal v3 + peer independientes pendientes; R2 NO-GO. No se corrieron suites, builds ni commits. El job anterior `5f9fbf0fb73944bc87ce91caa5c6c204` fue cancelado por el orquestador tras 20 min sin artefacto/worktree, no por auth/cuota. El observador Sol 6.1 high principal terminó el job `77fb33129aed47d992d200dfbfc7b2b8` sin motor ni ciencia; por filesystem de solo lectura no pudo escribir en su cwd. Recuperé fielmente su texto y metadata en `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/VIABILIDAD-OBSERVADOR.md` (SHA-256 `f925390b238bdc34a23e426dfb6ebd016c3aa1ad4bf94a6d6e25be8edc5491be`). Es viabilidad parcial, no aprobación R1. R1 usa `specs/003-criterios-realismo/`; su archivo de criterios sigue siendo borrador no leído/evaluado. Sol preparó para P0.c una nueva época con 504 inputs de SHA exactos y salida vacía; no se lanzó ciencia. El peer P0.c-v2 encontró incoherencia entre START pin AMD v1 y launcher AMD v2 con check post-spawn, además de receta v2 montando v1 visible. Sol completó P0.c op-v3 sin ejecutar ciencia: peer revalidó 83/83 manifest v3, 33/33 históricos, 37 checks read-only y preservación de 504 records; 27 checks de transporte se respaldan por evidencia registrada, no reejecución; dos pruebas con procesos hijos no fueron repetidas por el peer. Job MCP `af6489381f8248e6867b826a893e9f6b` terminó con GO técnico condicionado. La cápsula aislada restauró el OpenSSL 3.5.8 firmado. Fedora perfil FULL pasó gate mecánico live; el panel 4×60 no está lanzado. Torre pasó gate mecánico; cap de salida corregido. La identidad R0 dio PASS fresco: comparador original 1926, cross-digest 1284, inner 6, legacy rows 69 y eventos exactos 19017/19018 × 320 × 3; probe técnico 180 s con pico 302.5 MB, no estimación de 60 días. El primer ROOT-GO falló por campo mal nombrado antes del primer Popen; el segundo intento fue aprobado a partir del ejemplo sellado y cinco aserciones AST PASS. START2 fue validado a las 2026-10-04 03:01:09.870 UTC; sus recibos ROOT-LAUNCH y LIVE-STARTUP-AUDIT confirman cuatro boots/ACK y hashes STARTFILES correctos, con modelos 9501–9504 vivos. Es inicio de época, no evidencia de resultados ni aceptación: faltan los cierres C+B, 4×60 y 240×14. En el intento1 la reserva terminal sigue en ledger hasta la reconciliación CLI. Receta AMD2/probe de identidad precede el panel de cuatro; perfil FULL Fedora 24 GiB y output 40 GiB aplicado; antes de cada start exige admisión fresca ≥28 GiB disponibles y ≥140 GiB libres en disco. Fedora perfil FULL aplicado: 20 CPU, 24 GiB y output 40 GiB, admisión RAM del host ≥pedido+4 GiB, disco libre ≥140 GiB (100 reserva +40 solicitud) y backup privado de configuración propia; Luna confirmó PASS mecánico live del supervisor (SHA `f8e62e…e6907`) y reporter (`b610…e330`). Torre PASS mecánico. El panel científico 4×60 sigue sin lanzar. Cuota reportada 02:36 UTC: principal 55% semanal disponible; secundaria desconocida. Versión exacta de Opus 5.5 pendiente, no sustituir Sol sin verificar ruta.
Antes de cada trabajo se consultan rutas/cuotas de las cuentas elegidas y se revisan
leases/capacidad; si se usa MCP Fedora, comprobar exposición en la app. R1 y R2 pueden
avanzar sin esperar C8: el evaluador C1–C8 permanece congelado y el cierre C8 por tendencia sigue su
propia evidencia. Réplicas son procesos de cómputo, no agentes API/cloud; su fan-out exige
mediciones propias. Preservar `publico-v13`, la carta y todos los checkouts ajenos. El estado
por job, cuenta, máquina, ownership y gate se mantiene en
`/datos/tmp-atlas-lab/orquestacion-20261003/ESTADO-ORQUESTACION.md`.

### Secuencia de trabajo y entregables comprobables

1. **R0 — Cerrar el inventario de recuperación.** Ownership: operación/evidencia, sin tocar leyes.
   Leer manifiestos y recibos completos en ambas máquinas, registrar SHA, cobertura, época,
   cierre real y motivo de interrupción cuando pueda probarse. Marcar cada brazo como completo
   válido, interrumpido o no iniciado. Verificar la campaña de sequía y sus cierres en
   `auditoria-muse/`; la ausencia de FIN no basta para declarar fracaso biológico.
   **Puerta:** inventario de las 36 trayectorias DESG, los cuatro controles P0.c y los ensayos
   de escala, sin estados `running` atribuidos a procesos ausentes. Registrar en EVIDENCIA
   sólo hechos verificables y conservar originales. Después corregir las notas atrasadas de
   ESTADO/AGENTS sobre la decisión C8 y T100, sin duplicar el contrato publicado.

2. **R1 — Especificar C9–C24 y el método de aceptación.** Ownership:
   `docs/CRITERIOS-REALISMO.md`, `docs/REGLAS.md` sólo para referencias de fórmulas;
   tareas propias de una nueva especificación SDD. Convertir el objetivo 12 en definiciones
   de campo/fórmula/ventana/denominador y resultados desconocidos. Identificar los umbrales
   heredados y los provisionales a calibrar con controles, nunca con candidatas.
   **Puerta:** cada frente de GOAL tiene criterio, prueba y responsable; C21–C23 son puertas
   separadas de biología y C24 conserva método y etapa posterior de entrenamiento.
   Esto puede avanzar en paralelo a R0 y no depende del resultado de P0.c.

3. **R2 — Instrumentos y evaluador sin alterar el mundo.** Ownership de observadores:
   `scripts/lab/replica.ts`, `scripts/lab/instrumentos.ts` y el observador material recuperado
   de `sprint/ciclo-material-20261001`, tras revisar su puerta de coste todavía incumplida.
   Ownership separado del evaluador: `scripts/lab/criterio-realismo.mts` y sus pruebas.
   Reutilizar registros útiles de obras, balances, mortalidad, enseñanza y trayectos; no integrar
   todo el código de una rama porque contenga un instrumento útil.
   **Puerta:** seis semillas × 1200 pasos con digestos idénticos con/sin instrumento, cobertura
   de casos sintéticos aprobados/fallados/desconocidos, typecheck y suite completos, y coste
   integral observado. Un wrapper o fixture defectuoso se corrige conservando el fallo original.

4. **R3 — Línea base C1–C24.** Ownership: laboratorio y evidencia. Tras sellar R1/R2,
   usar seis semillas nuevas verificadas sin uso, 60 días completos cada una, como pide
   el objetivo 12. Conservar tablas por semilla y agregación explícita; las puertas técnicas
   y personales tienen ensayos propios, no columnas biológicas rellenadas por intuición.
   **Puerta:** línea base reproducible con SHA/parámetros/recibos y causas de fallo o
   desconocimiento. Identifica qué cambios son necesarios; no presupone 16 leyes nuevas.

5. **R4 — Resolver las campañas pendientes bajo sus contratos.** Puede solaparse con R1/R2
   si hay recursos y ownership distintos. Para P0.c, el reinicio ya está confirmado: usar
   una nueva época aislada y repetir exactamente los cuatro controles desde tick 0; conservar calibración,
   método, ventanas y cotejo de campos. Cerrar diagnóstico de viajes familia/hogar.
   No relanzar el runner original hardcoded sin adaptación operacional aprobada. **Puerta P0.c:**
   sólo el resultado preregistrado habilita el cribado de ley 2′; no lanzarlo
   por la calibración positiva. Para DESG-D60, revisar primero recibos y fuentes de las
   trayectorias de 60 días, conservar las parciales y completar/repetir únicamente lo que
   autorice el contrato operacional. **Puerta DESG:** P1–P3, K1 y seguridad SEGURO;
   9 directorios completos no sustituyen 12 ternas ni la validación del placebo.

6. **R5 — Cierre material y biológico, una hipótesis a la vez.** Prioridad C9–C14:
   uso y utilidad de obras, desgaste/reparación, reposición, balances, mortalidad y transmisión.
   Después C8/C15–C18: diferenciación útil, invención, migración, roles y conflictos.
   Ownership por función/módulo y tareas SDD disjuntas, manteniendo serial cualquier edición
   compartida de `src/world/index.ts`, `society.ts` o `inventions.ts`.
   **Puerta de cada ley:** predicción y refutación selladas antes de datos, controles/ablaciones,
   coste físico explícito, ausencia de daño según método vigente y revisión independiente.
   No declarar resuelto C8 por separación entre comunidades o por cambio del índice.

7. **R6 — Territorio, natalidad y escala.** C19/C20 requieren continuidad fuera de cámara
   y una alternativa local al cupo global; C22 requiere coste completo medido. Reabrir tareas
   002 según el perfil actual, con T100 funcionalmente cerrada y T103/T104 reescritas;
   conservar T110 abierto hasta satisfacer su gate. Ensayar pertenencia sólo tras reparar y
   validar el lanzador, sin reutilizar como éxito los experimentos rechazados.
   **Puerta:** frenos atribuibles, paridad bit a bit, conservación territorial y mediciones
   equivalentes de CPU/GPU/multinúcleo. Adoptar aceleración únicamente si mejora el coste
   completo; kernel rápido por sí solo no acredita utilidad. No prometer una fecha ni escala
   ilimitada sin medir tiempos/disco y el cuello de botella real.

8. **R7 — Durabilidad y experiencia.** Carril técnico C21: pruebas de fallos en copias
   aisladas sobre Store/servidor/red y clientes con cámaras independientes; cotejar también
   historia, identidades, parentesco, autoría y recibos. Carril C23: tareas concretas de
   explorar, seguir, dirigir, devolver autonomía e inspeccionar causas con teclado y teléfono
   físico. La carta y recuerdos reales se revisan con Steven, sin edición por otros agentes.
   **Puerta:** recuperación exacta del último commit durable, sin divergencias silenciosas,
   causas legibles, sin bloqueos críticos y revisión personal realizada. Puede prepararse
   en paralelo a R5/R6; su aceptación final usa el mismo candidato integrado.

9. **R8 — Entrenamiento posterior y aceptación conjunta.** Aplicar el método C24 desde R1.
   Cuando supervivencia, utilidad y legibilidad estén afinadas, contrastar selector actual,
   neutral y aprendido con semillas reservadas, aprendizaje on/off y presupuesto comparable;
   no premiar construcción vacía ni usar LLM por tick. Definir ese experimento antes de
   entrenar. Finalmente revalidar C1–C24 sobre una versión integrada con fuentes congeladas,
   typecheck, suite, build en worktree y pruebas técnicas/personales de la misma versión.
   **Puerta final:** matriz de aceptación completa, ningún desconocido contado como aprobado,
   evidencia de costes, utilidad, recambios, continuidad, transmisión, escala y carta revisada.
   La publicación es una acción posterior con respaldo y contrato; este plan no la ejecuta.

El calendario se estimará después de R0–R3: hoy no hay medición integral que permita estimar
el tiempo de cierre. El primer hito concreto es **recuperación válida + criterios ejecutables +
línea base**, con R1/R2 desbloqueados de la investigación de C8.

### Registro G0 y preparación G1 — 4 de octubre de 2026

PLAN fue recuperado por reproducción documental determinista; informe `/datos/tmp-atlas-lab/orquestacion-20261003/recuperacion-plan/REPARACION.md`. El registro actual de R1 es **GO-G0-R2 — CONTRATO**: ambos bloqueos v2 resueltos, peer independiente `fc33b542bee1494abe4d7f089f5c66e1` y formal Luna v3 sobre los mismos pins. Dictamen `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/REVISION-R1-v3.md` SHA `d085aa80eb01573b4a2f913403f7b9191627433d99e70e5d5397b773a50815d2`; decisión root `ROOT-G0-DECISION-v3.md` SHA `658605e0d5f52d626def8169cf0e39f3d6477dbbbcb7c0573e7f85a0137b410c`.

R1-FROZEN-v3 preserva los 87 archivos revisados más fingerprint fuera del worktree; manifest de archivo SHA `faaac25fb0ace210103eb5a19f12b4be8a0fac009b4635a6bb9a9a880714ef54`. Los cambios vivos de tasks/checklist/ownership conservan ese vínculo y no reescriben el manifiesto original. T001–T003 cerradas documentalmente; G1 T004→T005→T006 autorizado al integrador principal Sol 6.1 high. Observador principal y evaluador secundaria (cuota desconocida) quedan reservados **hasta PASS G1**, sin arranque ni fallback. Runtime privado disponible; root autorizó Ajv2020/jsonc-parser sólo como devDependencies exactas del worktree para parser/schema estándar. T004–T006 aún pendientes de implementación/pruebas y suite capped torre 16CPU/16GiB/output8GiB/log128MiB con TMPDIR propio.

G0 no acepta C9–C24 ni biología, no ejecuta 48+8 diseños, no concede consentimiento personal ni training. P0.c START2 sigue su época sellada e independiente; la recuperación de PLAN y G1 no alteran sus pins, recursos ni resultados.

## Balance histórico del 23 de septiembre de 2026

Lo publicado (commit, reglas, protocolo, SQLite y mundo) está en [docs/ESTADO.md](docs/ESTADO.md),
la única fuente de ese estado; este plan no lo repite. Resumen del 23 de septiembre de 2026 (~17:30):

- Servidor público en el portátil de Steven, commit `b5def74` (PERF3 + E.0 ola 1); la torre solo reenvía tráfico (`atlas-puente.service`).
- Mundo V10 vivo: ~día 167, 710 habitantes, 1957 nacimientos; la meseta ~690-710 es el cupo de software de 40 nacimientos/día, no el gobernador.
- Las etapas B–F de la feature 002, congeladas el 22, las descongeló Steven el 23-09; la ola 1 de B y de E.0 ya están fusionadas en `main`.
- Campaña de 60 días con el evaluador C8 v3: BANDA refutada (P1 0/4, P4 falla); H1b sin éxito preregistrado (único aprobado: semilla 606).
- Plan maestro del 23-09 en marcha (reglas 11 sobre `main` + campaña en condición pública): [detalle](https://claude.ai/artifact/PZdkuXSpXMeQqdFeucDtR1).

Las revisiones vigentes son la
[del 22 de septiembre](docs/REVISION-2026-09-22.md), que reúne las correcciones de parentesco,
enseñanza útil, fabricación por dependencias, expresión genética inicial y búsqueda física de
agua, y la [de la noche del 22](docs/REVISION-NOCHE-2026-09-22.md): extinción de la V7 pública
por la política `apagar` del gobernador y adopción de la política `techo` y reglas 10 (esa
revisión congeló las etapas B–F de la feature 002; Steven las descongeló el 23-09, ver arriba).

### Orden de trabajo (plan maestro 23-09)

- **F0 — limpieza**: worktrees y ramas ya fusionadas fuera de las conservadas explícitamente, documentación corregida (este barrido).
- **F1 — reglas 11 + publicación en mundo nuevo**: ley de conflicto legible y cupo de nacimientos declarado como regulador de software; publicar en un directorio de mundo nuevo.
- **F2 — campaña C8**: diagnóstico en condición pública → hipótesis preregistrada → panel de 12 semillas nuevas → veredicto; máximo 2 ciclos.
- **F3 — cierre del frente biológico**: fijar el resultado de la campaña C8 con su evidencia.
- Frentes paralelos: arte (rejilla del atlas pixel-art) y rendimiento (perfil de enseñanza/recetas a 700 habitantes).
- Reglas contra la deriva: ≤ 4 ramas vivas a la vez, preregistro antes de correr un brazo, EVIDENCIA en cada puerta.

Lo que sigue en esta sección es el registro de la tarde del 22, anterior a la publicación V10.
En la V7 pública (`3dd615e`, reglas 7), al día21,21 el censo dejó sólo S e I, tras siete nacimientos y21 muertes;
no sostuvo el recambio mortal. Se conserva el resultado y su
[evidencia](docs/evidencia-2026-09-22/public-v7-day21-census.json), sin atribuir una
causa que el censo aislado no demuestra.
La suite integrada y la publicación se documentan en
[EVIDENCIA](docs/EVIDENCIA.md#revisión-y-ejecución-2026-09-22); los estados de servicio
y cifras de las secciones históricas siguientes pertenecen a sus fechas.

T102 dispone de parámetros tipados; los de límites ya distinguen aplicación
histórica y explícita, mientras los backends futuros siguen inactivos. Tras los controles de Store y
digesto, la integración técnica V7 alcanzó 946/946 pruebas sin omisiones, typecheck
y build/smoke exactos. Recuperación estricta, migración V1 y números exactos tienen
controles independientes; [persistencia](docs/REVISION-PERSISTENCIA-2026-09-22.md).
T100 ya tiene snapshots paginados en SQLite5:1153/1153 pruebas sin omisiones,
typecheck, build/smoke exactos y seis paridades completas de1200 ticks. Siguen
pendientes los límites persistidos por hardware y la puerta de dos millones de
teselas; [gate técnico](docs/REVISION-PERSISTENCIA-PAGINADA-2026-09-22.md).
La admisión persistida posterior conserva los valores reservados de copias antiguas
mediante un modo explícito, incluido en el digesto:1251/1251 pruebas conjuntas,
seis paridades físicas y revisión independiente. Faltan resolución por hardware,
admisión previa a materialización (T100) y que la ley 10 exija el modo y el perfil de
límites en toda instantánea nueva: `RULES_VERSION` 10 (`688e0a6`) se adoptó sin esa
exigencia, y una instantánea sin `limitsProfile` ni modo declarado se sigue leyendo como
legado sea cual sea su versión (`readSnapshotLimits`); [contrato](docs/REVISION-LIMITES-PERSISTIDOS-2026-09-22.md) y
[T100](docs/T100-LIMITES-CONTRATO.md).
El backup verifica ahora la copia terminada, incluidos chunks e identidades
diferidos:1170/1170 pruebas y build/smoke exactos;
[alcance](docs/REVISION-BACKUP-2026-09-22.md).
La provisión familiar V8 y la contención local V9 se
integraron sobre esa base:981/981 pruebas sin omisiones,18/18 Chromium y seis controles
de estado/archivo; [gate V9](docs/REVISION-INTEGRACION-V9-2026-09-22.md). El contraste
V8 de trece días terminó mixto; el contraste V8→V9 terminó con mortales
0→0,24→14 y20→20, sin acreditar mejora demográfica. Sus78 ventanas diarias están
validadas; [resultado adverso](docs/REVISION-CONTENCION-V9-RESULTADOS-2026-09-22.md).
El contraste V7→V9 de51926 a25 días terminó con137→144 vecinos y generaciones2–10,
sin gobernador;50 ventanas y dos checkpoints verificados. No reproduce la
extinción pública. Un backup histórico confirma reproducción desactivada en
t16300, sin reconstruir la duración de las pausas;
[comparación y límites](docs/REVISION-SEMILLA-PUBLICA-25D-2026-09-22.md).
El perfil de tres mundos
envejecidos tampoco alcanza el presupuesto del clon: [T103 continúa abierto](docs/REVISION-CLON-ENVEJECIDO-2026-09-22.md).

La comparación reservada fija32 semillas, control y candidato, a30 días simulados.
El intento original con24 procesos finalizó30 corridas y agotó el tiempo en34;
éstas continúan aparte desde checkpoints con cuatro procesos. No emplea el
gobernador del servidor y sus tiempos concurrentes no acreditan rendimiento de
producción. Una réplica sin terminar no se cuenta como supervivencia. Trece pares
completos son una cohorte seleccionada: once0→0 mortales, uno0→1 y otro0→222;
los19 pares restantes siguen censurados. No prueban superioridad general.

Sigue abierto GOAL.md: selección frente a neutralidad, continuidad y diversidad
multigeneracional, reposición autónoma de insumos, territorio multiescala, T100 y las
etapas B–F de la feature 002 (descongeladas el 23-09, ver Estado actual), teléfono físico y revisión personal de la carta. La medición del
archivo mejoró el guardado, pero aún excede 50 ms en la carga envejecida ensayada.
CPU y ambas GPU se midieron con datos equivalentes; el puente GPU no mejora el coste
completo y permanece fuera del servidor. Ninguna corrección altera la carta de S/I.

## Estado 2026-09-19 · sprint «mundo sólido»

Una revisión integral de 12 dimensiones (10 revisores Sonnet 5 y 2 Opus) sobre la rama `001-mundo-solido-masivo` en el commit base `aeada2e`, contrastada con un refutador adversarial Opus que leyó y ejecutó el código real para cada hallazgo grave, arrojó 31 veredictos (12 confirmados, 4 plausibles y 15 refutados, recogidos en [REVISION-2026-09-19.md](docs/REVISION-2026-09-19.md)). Antes de modificar reglas se verificó el arranque: `npm run typecheck` y `npm run build` resultaron verdes (cliente en 150 KB JS y 76 KB CSS), mientras que `npm test` se colgaba por invocación de `listen()` de Vite fuera del bloque `try` y ausencia de Chromium; el mundo simulado mantenía 22 habitantes vivos sin errores sobre Canvas 2D como fallback correcto de WebGL2, observándose a t=1251 sobre 1120 celdas que el 100 % contenía comida y vegetación > 0,3, frente a solo un 3 % con agua potable.

| Queja del autor | Causa raíz confirmada | Fichero y línea |
| :--- | :--- | :--- |
| «Se mueren a gran velocidad» | Muerte por senescencia incondicional a edad casi fija calculada como `maximumAge = round((11 + resilience·4 − activity) · 2400)`, en una ventana de **10,45–14,70 días simulados** (42–59 min reales) sin evaluar hambre, sed, salud ni cuidados; con la semilla 12345, hasta el día 7,4 la población sube de 16 a 32 sin ninguna muerte; agotados los nacimientos por el tope, la ola de senescencia extingue el mundo hacia el día 15. | `src/world/demography.ts:23,82-83` y `src/world/index.ts:30,162,907` |
| «Son muy homogéneos» | Concurrencia de tres causas: (a) `craftTechnology()` ignora la receta decidida por `technologyOpportunity()` y fabrica la de mayor beneficio histórico mostrando un motivo falso en pantalla; (b) los 16 fundadores nacen homocigotos en los 7 loci con `learningRate` idéntico (0,12), sin variación inicial; (c) reproducción a razón de 1 nacimiento cada 120 ticks eligiendo el primer candidato por orden de inserción con corte duro en 32 habitantes, concentrando la paternidad. | `src/world/technology.ts:462-465`, `src/world/genetics.ts:14-16` y `src/world/index.ts:906-931` |
| «Recursos en todos lados» | `ecology()` incrementa vegetación y comida cada 10 ticks en todas las celdas de tierra hacia saturación sin capacidad de carga por bioma, y la fertilidad carece de decaimiento natural (converge a 1,0 de forma permanente), mientras el agua real permanece escasa (3–7 %). | `src/world/index.ts:183-206` y `src/world/ecosystem-kernel.ts:94` |
| «En el celular es imposible» | El mensaje `state` no está acotado por cámara, emitiendo **465 KiB por cliente, dos veces por segundo** (de los que 186 KiB corresponden a 256 recetas con programa no renderizadas), y la ausencia de modo ligero obliga a redibujar 3,16 megapíxeles por cuadro en pantallas móviles con dpr 3. | `src/world/index.ts:953-978`, `src/world/technology.ts:550` y `src/client/landscape.ts:612` |
| «La arquitectura es mejorable» | Las capas están sanas (`world` no importa `server` ni `client`), pero el bucle del servidor clona el estado, simula y persiste en SQLite sincrónicamente en cada tick (10 Hz), arrojando con 32 habitantes dispersos (28.672 tiles) un **p95 = 131,9 ms** de paso frente al presupuesto de < 50 ms. | `src/server/app.ts:142-146,265` y `src/server/store.ts:568-645` |

El registro de decisiones en el ledger SDD (`.superpowers/sdd/tasks/progress.md`, local y no versionado) formaliza nueve rulings operativos:
- R1: Los 14 implementadores corren en paralelo en worktrees aislados por petición de paralelismo máximo de Steven al tocar funciones disjuntas; el coste si falla es resolver merges manuales en `index.ts` y `app.ts`.
- R2: El refactor US5 de división de ficheros grandes se pospone para después del evento al estar la arquitectura de capas sana; el coste es que los ficheros gigantes siguen gigantes hasta después del evento.
- R3: `WorldParams` reside en un `WeakMap` fuera del snapshot sin migración de esquema en el sprint; el coste es que un mundo restaurado de backup no recuerda parámetros personalizados.
- R4: SQLite pasa a `synchronous=NORMAL` con WAL activo; el coste ante un corte de energía es perder hasta el último commit (~2 s de simulación), sin riesgo de corrupción.
- R5: La genética homocigota se corrige pese a ser refutada como bug por intencionalidad de diseño; el coste es un cambio de ley con valor por defecto 0 que reproduce el comportamiento previo bit a bit como control.
- R6: Queda prohibido ejecutar `npm run build` o `npm run check` en el árbol raíz porque el servidor público que sirve a Isa corre con ese directorio como `cwd`; el coste si falla es exponer un build a medias en caliente.
- R7: La tarea T021 se amplía para validar el mundo antes de persistir con un tercer slot de respaldo y se añade T022 de respaldo automático asignada a Opus; el coste es que T021 crece en alcance.
- R8: Las 7 tareas independientes de `params.ts` arrancan antes del cierre del Gate 0 para acelerar el desarrollo; el coste si falla es integrar ramas desalineadas de `params.ts` en `index.ts`.
- R9: No se interrumpen agentes con avance en worktrees viejos (T015, T023) nacidos de un commit base dispar; el coste es integrar hunks desalineados en `index.ts` y `app.ts` durante el merge final.

La progresión real del código sigue la secuencia lineal de commits `aeada2e` (base de revisión) → `10ac5c1` (documentación SDD y especificación rev.2) → `1619c6b` (Gate 0 con `params.ts` y suite desbloqueada con **627/0/3 tests en 117 s**) → `12d2d71` (apertura de [REGLAS.md](docs/REGLAS.md) §Parámetros y [EVIDENCIA.md](docs/EVIDENCIA.md)) → `027c0e9` (T019, índice de diversidad de conducta). En la estructura del sprint de 180 minutos ([plan.md](specs/001-mundo-solido-masivo/plan.md)), la Fase 0 queda superada tras el Gate 0, avanzando en paralelo en worktrees propios las tareas de Fase 1 (T010 senescencia delegada a `codex/gpt-5.6-sol` con esfuerzo xhigh, T011 variación genética a `gemini/pro`, T012 reproducción a `grok/grok-4.6`, T013 ecología finita a `codex/gpt-5.6-sol`, T014 craft corregido, T015 causas de muerte legibles, T016–T018 laboratorio en `scripts/lab/` y T019 índice de diversidad) y Fase 2 (T020 recorte de `state` y T021 persistencia por cadencia a Claude Opus, T022 respaldo automático, T023 rate limit tras proxy, T024 cliente ligero móvil y T025 fauna incremental). Concluidas con tests verdes T014 a T025, permanecen en marcha las cuatro tareas científicas nucleares (T010–T013), restando por ejecutar el Gate 1+2 de integración y auditoría adversarial de tres lentes Opus (determinismo, conservación de materia y supervivencia), la Fase 3 de evidencia empírica (T030 línea base, T031 calibración de 288 mundos y T032 réplicas de 25 días), y la Fase 4 de cierre editorial y publicación (T040–T043).

Quedan pospuestos para después del evento el refactor US5 de `index.ts` y `landscape.ts` (capas ya sanas y 14 workstreams paralelos generarían colisiones masivas), el mapa de calor y Lighthouse formal (el arnés de capturas cubre lo esencial), y las reglas `agua.cuencas` y `social.imitacion` al carecer de hallazgo previo que las justifique.

| Criterio | Valor de partida medido | Objetivo |
| :--- | :--- | :--- |
| SC-002 (supervivencia de fundadores a 10 días) | pendiente T030 — bajo las reglas viejas el mundo se extingue hacia el día 15 por la ola de senescencia (ventana 10,45–14,70 días) tras agotarse los nacimientos al llegar al tope de 32 | mediana ≥ 70 %, sin réplica con colapso > 50 % en los 2 primeros días |
| SC-003 (índice de diversidad de conducta al día 5) | pendiente T030 (el índice, `src/world/diversidad.ts`, se acaba de escribir en T019) | ≥ 0,6 en la mediana de réplicas |
| SC-004 (Gini de recursos por región y % de regiones sin agua superficial) | parcial medido — a t=1251 el 100 % de las 1120 celdas tenía comida y vegetación > 0,3, solo el 3 % tenía agua potable (36 celdas); Gini formal pendiente T030 (requiere T013) | Gini ≥ 0,35 y ≥ 30 % de regiones sin agua superficial |
| SC-005 (muertes con causa desconocida) | la crónica ya registra `starvation\|dehydration\|exposure\|senescence` para toda muerte (verificado en revisión §3.6); pendiente confirmar 0 en 32 réplicas (T030) | 0 muertes de causa `desconocida` en 32 réplicas |
| SC-006 (modo observador en móvil) | sin modo ligero hoy; `state` de 465 KiB dos veces por segundo y dpr sin techo (hasta 3× en móvil) | carga < 3 s, memoria < 150 MB, sin errores de consola; escritorio ≥ 55 fps con 32 habitantes |
| SC-007 (suite y typecheck verdes en cada fase, determinismo conservado) | Gate 0 aprobado con **627/0/3 tests en 117 s** (antes, `npm test` se colgaba) | mismo resultado verde sostenido en cada fase, métricas idénticas con la misma semilla tras el refactor de reglas |
| SC-008 (sección nueva en EVIDENCIA.md fechada 2026-09-19 con SHA/semillas/cifras) | la sección «2026-09-19» de [docs/EVIDENCIA.md](docs/EVIDENCIA.md) ya se abrió (commit `12d2d71`); se completa con T030–T032 | sección cerrada con cifras de cada criterio |
| SC-009 (tamaño del `state` y p95 del paso del servidor con 32 habitantes) | `state` = **465 KiB** por cliente (186 KiB solo en recetas), **p95 = 131,9 ms** por paso | `state` < 120 KiB a t=8000; p95 < 50 ms |
| SC-010 (crecimiento del SQLite del servidor con poda activa) | la base de datos real (`data/world.sqlite`) crece a razón de **6,1 GiB/día** en tiempo real (medido con dos `stat` separados 120 s, sin poda ni respaldo automático hoy); la especificación ([spec.md](specs/001-mundo-solido-masivo/spec.md)) fija además una referencia de ~170 MB por día simulado antes de la poda | no crecer más de 20 MB por día simulado con poda activa; `npm run backup` en caliente nunca reporta corrupción falsa |
| SC-011 (recambio generacional a 25 días simulados, 16 réplicas) | pendiente T032 bajo las reglas nuevas; bajo el cierre biológico anterior (reglas viejas, fuera de este sprint) se observó reemplazo hasta 8ª generación en dos réplicas extendidas | ninguna extinción, ≥ 3 generaciones vivas, ≥ 2 causas de muerte distintas con lugar y 3 eventos previos, ≥ 4 recetas distintas en uso simultáneo |

Documentación y fuentes de referencia: [Revisión integral 2026-09-19](docs/REVISION-2026-09-19.md), [spec.md](specs/001-mundo-solido-masivo/spec.md), [plan.md](specs/001-mundo-solido-masivo/plan.md), [tasks.md](specs/001-mundo-solido-masivo/tasks.md), [research.md](specs/001-mundo-solido-masivo/research.md) y [EVIDENCIA.md, sección «2026-09-19»](docs/EVIDENCIA.md).

**Resultado del sprint**: se implementaron y calibraron las 4 leyes estructurales identificadas por la revisión (senescencia como hazard Gompertz gradual, capacidad de carga ecológica por bioma con decaimiento de fertilidad y agua en cuencas, elección de pareja por afinidad con variación genética heredable en los fundadores, y persistencia por cadencia con validación de frontera), usando el fallback analítico de `research.md` en lugar de un barrido ejecutado (Ruling R14 del ledger, por el límite de tiempo del evento). El resultado se desplegó en producción a las 11:19 (commit `835f3d5`, mundo nuevo bajo la política de publicación vigente), con mejoras medidas en el rendimiento del servidor (`/api/world` de 85 s a 0,89 s, CPU de ~95 % a 27 %), en la causa de muerte (de un corte de edad incondicional al 99,6 % de las muertes a un riesgo real) y en la distribución de recursos (agua en cuencas para SC-004). T036(h) (dieta del `state`, commit `4bc6d96`) ya bajó el mensaje del cliente un 38 % en cámara móvil (295,3→183,4 KiB) y 31 % en cámara completa (591,9→409,4 KiB), sin alcanzar las metas de 120/250 KiB (`technology` y `tiles` con cámara completa siguen enteros). Quedan pendientes para después del evento los barridos de calibración T031/T032, terminar esa dieta del `state` y los 4 puntos del checklist de publicación T043 (`CARTA_PROXY_IP`, `data/access.scrypt`, activar el timer de respaldo, abrir la ventana de poda de la base de datos vía `CARTA_PARAMS`). [Detalle en EVIDENCIA.md, sección «Despliegue»](docs/EVIDENCIA.md#despliegue-1119-commit-835f3d5).

## Cierre del sprint 2026-09-19 (13:20) y lo que sigue

Resultado del día en la rama `001-mundo-solido-masivo` (todo en GitHub): 13 workstreams del plan + 5 rondas de revisión adversarial integrados; suite **781 tests, 0 fallos**; tres publicaciones en `https://atlas.humanizar.tech` (11:19 `835f3d5`, 12:04 `da1e631` mundo nuevo para la demo, 12:22 `99fac6d` mundo conservado). Cambios de fondo: senescencia de Gompertz con cuidado y genes (T010), variación heredable y mutación (T011), reproducción repartida sin tope (T012 → T044 gobernador por hardware, FR-013), oficio decidido = oficio fabricado (T014), capacidad de carga por bioma y agua concentrada en cuencas (T013/T035, `agua.cuencas` ahora real), estado por cámara y dieta del `state` (T020/T036), persistencia con poda y respaldo en cadena 0→1→2 (T021/T022/R2), laboratorio `npm run lab` (T016–T018), modo observador móvil (T024/T025). Arreglos operativos: guardado −62 % (assertWorld cada 10 guardados), carga del mundo 468 s → 3,3 s, crónica y checkpoints sin topes de 32.

Lo que el hardware permite hoy (medido): un hilo Node sostiene 10 Hz hasta ~35 habitantes; a 40 habitantes y día 5 el público va a 8,2 Hz con p95 ≈ el guardado (350–500 ms cada 20 pasos). Por eso el siguiente trabajo es **`specs/002-mundo-ilimitado/`**: paso residente sin clon (etapa A, cerrable en horas), SoA + workers deterministas para el ecosistema (B), GPU (C), deltas de persistencia y red (D), personas en particiones (E) y gobernador que crece el mundo activo (F). Regla que manda: igualdad bit a bit entre 1 hilo, N hilos y GPU; el hardware solo cambia cuánto crece el mundo.

## Objetivo rector

[GOAL.md](GOAL.md) contiene la **meta completa lista para copiar**, sus criterios de aceptación y las condiciones de cierre. Es la única fuente del objetivo del proyecto. Este plan conserva las ideas acumuladas, el alcance, el estado y el orden de trabajo; una capacidad implementada o una prueba aprobada no equivale a completar la meta.

## Estado histórico del 7 de septiembre de 2026

**Prioridad de afinación, reiterada por Steven el 7 de septiembre:** corregir supervivencia, utilidad de las construcciones y legibilidad antes de incorporar nuevos sistemas. Se conservó y analizó el mundo V5 cuya población mortal se extinguió; la fuente para grabar incorpora correcciones de decisiones y representación. Su copia acredita **113,35 días con recambio: 29 vecinos mortales de generaciones 21–24**, sin órdenes, y se mantiene intacta. La [matriz V6 cerrada](docs/EVIDENCIA.md#matriz-v6-cerrada-a-veinticinco-días) completó tres semillas de 60000 pasos y terminó con **30, 18 y 1 vecinos mortales**. La tercera no conserva ningún vecino anterior a la senescencia, incluidos inmaduros: no puede producir otra generación sin nuevos entrantes. No son tres casos viables ni evidencia de continuidad indefinida. El candidato experimental `292f17a` contrasta una barrera comunitaria en otra rama; su evaluación larga sigue pendiente y no está publicado. V7 y neuroevolución siguen pendientes.

La versión para grabación fue **`03470e3`, con SQLite 4 y reglas/protocolo 6**, activa en la revisión privada desde el 6 de septiembre de 2026 a las 15:18:36 UTC hasta que la sustituyeron publicaciones posteriores (lo vigente, en [ESTADO](docs/ESTADO.md)). Comenzó un mundo normal nuevo con semilla `51926` y dieciséis habitantes; conservó contraseña, TLS y bloqueo de instancia, sin heredar sesiones. Reúne catálogo resoluble, memoria técnica finita, cuerpo compartido, agua transportable, claros, identidad de ejecución y afinación corporal, constructiva y visual. Pasó 567/567 pruebas Node, 18/18 de navegador compilado y smoke completo. [REGLAS.md](docs/REGLAS.md) define mecanismos y [EVIDENCIA.md](docs/EVIDENCIA.md#publicación-para-grabación) registra la fuente exacta y el resultado operativo. El reemplazo generacional de dos réplicas de veinticinco días corresponde al cierre biológico anterior `6d0e53b`; no demuestra continuidad indefinida ni incluye estos cambios.

Estado documental: 7 de septiembre de 2026. El inicio V5 del día 5 a las 21:08 creó un mundo nuevo autorizado y conservó el V4 inválido; no fue una migración V4→V5 exitosa. La actualización posterior a SQLite 4 conservó aquel mundo V5 sin reiniciarlo; la publicación de `7d8777c`, comprobada a las 01:46:49 UTC, lo archivó e inició otro. La publicación para grabación tiene evidencia independiente. Cierre personal de la carta, móvil físico y alojamiento definitivo pendientes.

**Política vigente por decisión de Steven:** durante esta etapa de desarrollo, cada nueva versión de pruebas publicada empieza un mundo desde cero. Se resguardan por separado el mundo y la historia anteriores, se mantiene la contraseña y no se restaura un estado viejo encima del nuevo. Los reinicios por fallo y las reconexiones dentro de la misma versión recuperan su estado confirmado; esta política no reinicia el código ni Git. Se aplicó al publicar `7d8777c`: las sesiones anteriores no se heredan y se vuelve a ingresar con la misma contraseña. [README](README.md#nuevas-versiones-de-pruebas) define el alcance operativo y [EVIDENCIA](docs/EVIDENCIA.md#publicación-con-mundo-nuevo) registra la ejecución.

El catálogo introducido en `614b25d` y publicado en **`7d8777c`** conecta la memoria técnica local de 32 instrucciones y la caché de 256 definiciones con investigación, fabricación, enseñanza, uso y olvido; la historia puede superar 256 recetas y generación 32. La revisión posterior de esa fuente en tres semillas a veinticinco días encontró extinción de vecinos en todas. Corregir solo la búsqueda de agua conservó vecinos en dos. La versión para grabación conserva ese aprendizaje y añade elección según recuperación real, riesgo de exposición y adquisición local viable. La nueva matriz fija **`189791d`**, que añade un journal completo sin modificar esa física; las tres ejecuciones conservaron crónica, reinicio exacto en 30000 y recarga final, sin entradas. El candidato **`4a05bb5`** suma validación incremental del archivo y pasó **606/606 Node y 18/18 navegador compilado**, con paridad de mundos en las comparaciones de carga y continuación. Sigue sin publicar. [EVIDENCIA](docs/EVIDENCIA.md) separa esas fuentes, integridad y resultados demográficos.

El cierre biológico anterior conserva vecinos de octava generación en ambas réplicas extendidas, sin rescates y después de morir los fundadores mortales. Aquellas reglas saturaron su catálogo tecnológico y el mantenimiento material sigue sin acreditarse; una réplica conserva quince muertes por deshidratación. Reemplazo observado, suite aprobada y capacidad activa son evidencias distintas.

El repositorio ya contiene una aplicación local ejecutable. El [README](README.md) reúne los comandos reales de arranque, acceso y recuperación. La experiencia siguiente conserva su alcance de diseño; la implementación actual usa S e I, vecinos ficticios y cinco recuerdos sintéticos identificados, sin importar conversaciones ni atribuirles biografía.

La integración **`95ff0d2` incorporó agua V6**, con preparación autónoma de reservas, capacidades físicas de recipientes, peso, fugas, bebida y explicación en el inspector. Conservó las fuentes y pruebas de `eefbbe2`: 496/496 Node y 17/17 E2E compilados. Tres semillas produjeron llenado y consumo lejos de la fuente sin objetos ni órdenes suministrados; no acreditan mayor supervivencia ni mantenimiento material. La versión para grabación incluye ese mecanismo junto a las afinaciones posteriores.

Los claros y arboledas de `7fff2f3` y la identidad de ejecución de `8565624` forman parte de la fuente para grabación. El candidato previo `9b40f4d` pasó 517 pruebas Node, 18 de navegador compilado, typecheck, build y smoke; su publicación se suspendió durante el diagnóstico. La afinación posterior mejora lectura de instalaciones, reservas y gráficas y compara beneficio marginal de obra y reparación. Reducir construcción no demostró por sí solo mejor recambio en las matrices anteriores. La medición CPU/CUDA no justifica activar el puente GPU probado. La continuidad lejana V7 se conserva en `688d110`, y su puente de servidor en `8fe9e7f`; sus gates parciales no constituyen aceptación conjunta ni despliegue. [EVIDENCIA](docs/EVIDENCIA.md) distingue cada resultado y sus límites.

## La idea

**Un sandbox de mundo vivo, inspirado en WorldBox, con reglas científicas comprensibles y preguntas filosóficas que se experimentan al jugar. Ese mundo entero es una carta de Steven para su esposa Isa.**

Se puede recorrer, observar a sus habitantes, intervenir en algunas condiciones y descubrir qué cambia. La vida surge de la interacción entre terreno, recursos, cuerpos, decisiones y memoria. Steven e Isa, representados provisionalmente como S e I, tienen un lugar reconocible dentro de esa sociedad.

La carta está en cómo se buscan, en lo que aprenden, en los lugares que adquieren significado y en las huellas que dejan juntos. La historia real aporta la identidad; la simulación permite que aparezcan historias nuevas.

**Síntesis editorial del mensaje:** «Quise construirte un lugar donde nuestra historia pudiera seguir tomando formas. Un mundo donde encontrarnos importe, donde podamos cambiar y donde haya espacio para volver».

Este texto propone el sentido de la obra; la redacción personal final pertenece a Steven.

## Tres compromisos que deben convivir

| Compromiso | Qué significa en la experiencia |
|---|---|
| Mundo jugable | Explorar un mapa, seguir habitantes, observar procesos e intervenir con consecuencias. La sociedad tiene actividad propia y puede sorprender. |
| Ciencia y filosofía | Reglas explícitas, causas comprobables, necesidades que compiten y memoria que transforma conductas. Las preguntas sobre autonomía, identidad y cuidado aparecen en lo que sucede. |
| Carta para Isa | S e I son reconocibles; hay recuerdos autorizados y lugares propios; la voz es íntima. Volver tiene significado y ausentarse no genera una obligación de cuidado. |

El alcance ampliado permite recorrer territorio procedural más allá del mapa original, con juego a pantalla completa, control individual, habilidades adquiridas y construcción de lugares compartidos. V4 conecta agua potable finita, animales individuales con herencia y depredación, suelo vivo, cultivos, invenciones funcionales y hogares recordados con comunidades locales. La extensión se genera según necesidad; solo las regiones próximas a los habitantes avanzan y la población humana crece sin techo fijo, regulada por el gobernador y (hoy) por un cupo de nacimientos de software (ver `docs/ESTADO.md`).

La arquitectura implementada mantiene **un mundo compartido por todos los clientes del servicio**: la CPU del backend lo simula a 10 Hz y cada navegador dibuja su vista, normalmente actualizada a 2 Hz. Cámaras distintas observan el mismo estado; abrir clientes no multiplica la simulación. El compositor WebGL2 utiliza, cuando está disponible, la GPU del dispositivo cliente. El servidor admite actualmente hasta 12 conexiones WebSocket simultáneas; aumentar esa escala requiere medición.

## La primera entrega

Una URL privada, cómoda en móvil y escritorio, que permita:

1. Leer una apertura breve escrita para Isa y entrar al mundo.
2. Recorrer territorio procedural con biomas, depósitos visibles de agua, suelo, vegetación, fauna, alimento, madera, piedra y refugios. Cosecha, caza, cultivo, construcción y tránsito dejan consecuencias.
3. Reconocer a S e I y una vecindad pequeña: catorce vecinos iniciales, con descendientes posibles sin techo fijo (regulados por el gobernador y el cupo de nacimientos). La herencia transmite parámetros del modelo; la crianza y el aprendizaje tienen vías separadas.
4. Observar cómo necesidades, predisposiciones, habilidades y resultados anteriores cambian decisiones y actividades. Los oficios describen una trayectoria de práctica; las etiquetas no asignan tareas.
5. Ofrecer gestos e invitaciones, o dirigir temporalmente a cualquier habitante para desplazarse, explorar, recolectar, cultivar, construir, ensayar un diseño, reparar, cazar, beber, cooperar o descansar; devolverle después la elección autónoma. Inspeccionar y seguir animales con cuerpos y actividad propios.
6. Descubrir una selección pequeña de recuerdos reales aprobados que influya en comportamientos, lugares y voz.
7. Consultar una crónica breve, estadísticas con alcance explícito y comunidades que comparten recursos, trabajo y conocimientos. Encontrar continuidad al regresar: el mundo avanza en el servidor aunque el navegador esté cerrado.

La primera entrega incluye al menos una costumbre compartida que se forme por repetición e imitación. Así, la sociedad aporta historia propia desde el inicio.

## Qué conservamos y qué recortamos

| Material histórico | Decisión de esta síntesis |
|---|---|
| Mundo autónomo, ecología y sociedad | Conservar con pocos procesos conectados y consecuencias visibles. |
| Cuerpo, vínculo, memoria y agencia | Conservar como un solo circuito de comportamiento. |
| Lugares significativos, silencio, momentos y diario | Conservar; destacar poco y contar hechos ocurridos. |
| Historia real como semilla | Empezar con recuerdos seleccionados y revisados. La ingestión de todo el archivo de conversaciones deja de ser un requisito inicial. |
| Autopoiesis y cognición encarnada | Conservar el objetivo de autonomía material, mantenimiento y organización que se reconstruye mediante sus propios procesos. Exigir evidencia causal; autorregulación o ciclos en un grafo no demuestran por sí solos autopoiesis ni conciencia. |
| Muerte, pérdida y otras relaciones reales | Ciclo vital y genealogía persistente implementados en la versión activa; reemplazo generacional observado en las dos réplicas de veinticinco días del cierre biológico anterior. S e I conservan protección explícita; cambiar su significado personal sigue siendo una decisión del autor. |
| Descubrimiento de lugares | Incorporado mediante exploración física y crónica. |
| Reproducción y generaciones | Incorporadas en V3 para vecinos ficticios: nacimientos locales con costes y límite de población, genes mendelianos simplificados y plasticidad heredable. Habilidades y recuerdos adquiridos no se heredan como genes. |
| Sueños | Fuera del alcance actual. |
| Territorio procedural, asentamientos y control individual | Incorporados al alcance ampliado solicitado. Sin borde del mapa inicial; regiones activas y rango numérico acotados. |
| Comunidades, cooperación y disputas | Incorporadas mediante confianza local, semejanza cultural, aportes de materiales, ayuda, enseñanza, trueque y tensión por recursos escasos. Sin violencia ni gobiernos. |
| Miles de habitantes, guerras, gobiernos y mercados complejos | Horizonte conservado: instituciones, conflictos y redes económicas deberán emerger de interacciones verificables. El intercambio actual es un trueque local acotado; ampliar población exige presupuestos medidos. |
| Invención funcional | Construcción con seis componentes y programas materiales compuestos, herramientas e insumos derivados en V5. Ambas búsquedas pagan costes y distinguen función prevista de utilidad observada. El catálogo activo desde `7d8777c` separa catálogo tecnológico histórico, caché y conocimiento local; los planos constructivos conservan su gramática y presupuesto actuales. |
| GPU para dibujar | Incorporado compositor WebGL2 con cachés, diagnóstico del dispositivo y alternativa Canvas 2D. La simulación sigue en CPU; no se promete aceleración física en cualquier navegador. |
| Redes evolutivas de decisión y búsqueda de parámetros | Investigación posterior a la afinación de supervivencia, utilidad y legibilidad. Comparar pequeñas políticas y repertorios diversos en réplicas aisladas, con CPU, GPU y RAM medidas; todavía no implementado. Diseño y controles en [CIENCIA](docs/CIENCIA.md#neuroevolución-después-de-afinar-el-mundo). |
| Embeddings obligatorios, inferencia de LLM por paso, múltiples servicios y protocolos binarios | Fuera del alcance actual. No son requisitos del mundo ni del experimento posterior de pequeñas redes de decisión. |
| Medidores de conciencia, lenguaje cuántico ornamental y aleatoriedad presentada como agencia | Retirar. Sustituirlos por pruebas de causalidad y explicaciones honestas del modelo. |
| Prohibiciones absolutas de jugar, inspeccionar el mundo o mostrar ciencia | Retirar. La intimidad es compatible con la curiosidad y con controles claros. |

## Orden de construcción

| Etapa | Resultado que debe poder verse | Criterio para avanzar |
|---|---|---|
| 1. Mundo y vínculo | Región pequeña, ciclo de recursos, S e I con cuerpo y decisiones, cámara y un gesto ambiental. | Una alteración del entorno cambia una decisión; el encuentro modifica el estado de ambos. Se entiende en móvil sin explicación técnica. |
| 2. Historia propia | Recuerdos seleccionados, lugares significativos, vecinos y una costumbre aprendida. | Una memoria cambia una acción; una conducta colectiva surge de interacciones locales y afecta la vida de la pareja. |
| 3. Continuidad | Guardado, servidor persistente, acceso privado, reconexión y crónica. | Cerrar el navegador no detiene el servidor; reiniciarlo sin cambiar de versión recupera el mismo mundo y su crónica. Cada nueva versión de pruebas publicada comienza desde cero, con archivo anterior resguardado y contraseña estable. |
| 4. La carta terminada | Texto del autor, arte coherente, sonido opcional y ajustes de ritmo, tacto y accesibilidad. | El enlace funciona en un móvil real y la experiencia permite reconocer la relación, entender una consecuencia y querer volver. |

El orden organiza pruebas de extremo a extremo. La persistencia básica se prepara desde la primera etapa y se endurece en la tercera. Cada etapa deja algo ejecutable; no obliga a desplegar públicamente cada avance.

### Situación del prototipo

La fuente V6 para grabación conecta tecnología material, agua contenida, prácticas por procedimiento, mortalidad humana, archivo de identidades, fauna, ecología y comunidades, con SQLite 4. El selector afinado responde a comida accesible, sed, recuperación efectiva y protección física; la interfaz distingue reservas, condición y alcance de las estadísticas. Las pruebas largas anteriores conservan sus fuentes y resultados, incluidos colapsos y efectos adversos. La observación privada de 113,35 días y la matriz de tres semillas responden preguntas distintas: la segunda confirma un caso sin recambio y la genealogía de 51926 coincide exactamente con la captura publicada hasta el paso 60000. [Resultados y límites](docs/EVIDENCIA.md#matriz-v6-cerrada-a-veinticinco-días).

| Etapa | Implementado | Cierre pendiente |
|---|---|---|
| 1. Mundo y vínculo | Regiones de 16 × 16, depósitos de agua, recursos modificables, fauna individual y capa celular; dieciséis cuerpos humanos iniciales, decisiones locales, vínculo contextual, cámara y gestos. | Comprensión en el móvil físico destinatario. |
| 2. Historia propia | Recuerdos sintéticos, práctica, hábitos observados, comunidades, ayuda y conflicto reversible; descendencia hasta octava generación, tecnología y legados observados en V5. | Continuidad fuera de la ventana estudiada, transmisión y redes productivas sostenidas; selección real de recuerdos, nombres y rasgos. |
| 3. Continuidad | SQLite 4 (V6, histórico; hoy SQLite 5, ver `docs/ESTADO.md`), archivo tecnológico y recuperación; agua V6 persistente, identidad de ejecución y política de mundo nuevo por publicación. Los archivos V4/V5 anteriores permanecen separados. | Continuidad durante varios días reales y alojamiento definitivo con proceso, HTTPS y disco persistentes. El archivo V4 conserva su defecto de validación. |
| 4. La carta terminada | Interfaz y carta de prueba ejecutables para revisión. | Voz final del autor, revisión íntima, arte y ritmo finales, y recorrido en un teléfono real. |

Las pruebas automáticas demuestran propiedades concretas del prototipo; no sustituyen los cierres personales y de experiencia. La carta terminada todavía no se acredita.

## Lo que sigue siendo una decisión personal

| Decisión | Cómo avanzar mientras se concreta |
|---|---|
| Texto, recuerdos, nombres, rasgos y semejanza visual | Usar S e I y material de prueba identificado. Incorporar biografía solo con una selección real revisada. |
| Mortalidad de S e I y significado de la desconexión | Mantener protección explícita de ambas identidades mientras se desarrolla el ciclo vital de vecinos ficticios. La mortalidad de los demás no decide el significado personal de la pareja. |
| Representación de otras relaciones reales | Mantener vecinos ficticios. No convertir personas reales en personajes ni cambiar el sentido de esas relaciones por una simplificación editorial. |
| Audiencia y alojamiento | Diseñar acceso privado para la primera entrega. Confirmar público destinatario, recursos disponibles y coste antes de publicar o contratar infraestructura. |

Estas decisiones se resuelven cuando afectan al trabajo concreto; no hace falta reconstruir el antiguo sistema de firmas, puertas y documentos de aprobación para avanzar con un prototipo reversible.

## Regla para admitir nuevas ideas

### Ideas acumuladas y estado

Esta tabla conserva la dirección expresada por Steven, incluso cuando excede el prototipo actual. «Pendiente» conserva una intención; no anuncia una capacidad disponible. Las reglas técnicas se mantienen en su documento canónico y las mediciones en EVIDENCIA.

| Idea del autor | Estado y siguiente criterio |
|---|---|
| Mundo completo en pantalla y UI cómoda para observar/controlar a cualquiera | Implementado con cámara libre, censo y órdenes humanas; falta comprobar comodidad en teléfono físico. Fauna se puede inspeccionar y seguir. |
| Territorio procedural de extensión comparable a Minecraft, con descubrimientos y asentamientos | Implementadas regiones deterministas y persistentes con límite numérico explícito; ampliar escala requiere medir memoria, disco y tiempo. |
| Biomas ricos y agentes que transformen el entorno | Agua, alimento, madera, piedra, vegetación, cultivos, huellas y edificios están conectados a consumo y trabajo. Ampliar variedad debe añadir consecuencias verificables. |
| Mundo compartido; backend simula y frontend visualiza | Implementado un estado y un reloj para todos los clientes. El navegador conserva su cámara; la carga de varios clientes requiere medición separada. |
| Empezar desde cero al publicar nuevas versiones de pruebas | Política aplicada en `7d8777c` y en la publicación para grabación `03470e3`: mundo nuevo por versión publicada, historia anterior resguardada y contraseña estable. No sustituye recuperación por fallos, no restaura mundos viejos encima de nuevos y no reinicia el desarrollo ni Git. [Publicación comprobada](docs/EVIDENCIA.md#publicación-para-grabación). |
| Animales con el mismo fundamento corporal, exploración, reproducción y depredación | V4 integra fisiología compartida, cuerpos individuales, genes y memoria local; sin sistemas sociales ni constructivos humanos. |
| Profesiones y funciones adaptativas, sin asignaciones predeterminadas | V5 registra competencia por procedimiento y relaciones entre productores y usuarios. Falta probar división del trabajo sostenida; futuras instituciones deberán surgir de aportes, necesidades y dependencias locales observadas. |
| Aprendizaje por genes y memorias, cooperación creciente | Herencia y aprendizaje se separan; hay recuerdos acotados, imitación, enseñanza, intercambio y ayuda. Se observó reemplazo acotado; transmisión de oficios y estabilidad fuera de esas trayectorias siguen pendientes. |
| Comunidades culturales, endogrupo/exogrupo y conflictos propios | Implementadas confianza, prácticas adquiridas, pertenencia revisable, disputas por recursos y turnos; no hay todavía guerras, gobiernos o instituciones emergentes. |
| Que las comunidades permanezcan juntas cuando tenga sentido | V4 incorpora hogares observados y retorno físico. Se exige una ejecución autónoma con cooperación y contraste de escasez; reiniciar la DB por sí solo no corrige dispersión. |
| Inventar estructuras nuevas que cambien lo que el mundo puede hacer | V4 combina componentes funcionales. V5 ejecuta programas que transforman materiales, producen herramientas y reutilizan productos o catalizadores, pagando trabajo, materia y desgaste. El catálogo activo permite continuar investigando después de llenar la caché; geometría constructiva libre y nuevos usos materiales siguen pendientes. |
| Un mundo muy vivo, autoorganizado, con complejidad inesperada como Conway y la ficción de Black Mirror | Objetivo abierto: redes que se mantienen, reconstruyen sus condiciones de existencia y generan procedimientos nuevos sin supervisión. Se distinguirán posibilidad estructural, arranque desde recursos disponibles y mantenimiento material observado. No se ha demostrado conciencia, autopoiesis biológica ni evolución abierta ilimitada. |
| Evolución continuada y reemplazo generacional | Demografía con costes heredables, nacimientos y archivo implementados. La matriz V6 terminó con 30/18/1 vecinos: murieron todos los fundadores mortales, pero la tercera semilla ya no puede tener descendencia. La captura privada de 51926 acredita generaciones 21–24 a 113,35 días. Se conservan las réplicas anteriores y no se acredita continuidad indefinida ni selección genética aislada. La protección de S e I queda fuera del criterio de éxito. |
| Calidad visual, escala coherente e interfaz renovada | La fuente para grabación incluye claros físicos, instalaciones seleccionadas legibles y fichas de reservas, condición y alcance reciente. Conserva existencias antiguas al cargar y distingue un mundo nuevo del regreso a la misma ejecución. Teléfono físico, autonomía prolongada del conjunto y calidad final siguen pendientes. |
| Continuidad territorial y aprovechamiento de CPU, multinúcleo y dos GPU | Índice CPU activo con paridad y perfiles. La comparación real del pipeline ecológico con cuatro/ocho workers y ambas GPU mantuvo Float64 exacto, pero conversiones y transferencias no demostraron una ventaja robusta; el runtime conserva CPU. Regiones lejanas siguen congeladas en el servicio; V7 prepara lotes cronológicos, deuda y archivo explícitos, aún sin aceptación completa. |
| Mucha más estadística y control del hardware | Hay métricas de recursos, cuerpos, grupos, genealogía, invención y tiempos de cliente/servidor. El presupuesto de fauna debe preservar identidades y repartir turnos; su coste completo necesita evidencia. |
| Usar el hardware para aprender qué condiciones y estrategias producen complejidad útil | Idea incorporada el 6 de septiembre: primero afinar el modelo y sus métricas; después sensibilidad de parámetros, neuroevolución y diversidad de políticas en copias experimentales. No se ha entrenado ninguna red ni seleccionado una política para producción. [CIENCIA](docs/CIENCIA.md#neuroevolución-después-de-afinar-el-mundo) define la propuesta y sus controles; [GOAL](GOAL.md) conserva su criterio de aceptación. |
| Colaboración entre modelos potentes, con calidad y paralelismo antes que ahorro | GPT-6 integra lo difícil, revisa y mantiene el diálogo. Los proveedores y modelos solicitados en [GOAL](GOAL.md) se incorporan según autorización, catálogo, capacidades y cuotas verificadas; sus nombres no acreditan acceso ni instalación. No se usan LLM en el ciclo de simulación. Commits acotados conservan avances. |

### Siguiente avance de autonomía

La continuación autónoma de `614b25d` sobre una copia del mundo saturado, repetida en `7d8777c` con iguales descubrimientos y balances, completó **600 pasos, con guardado por paso: 256→262 programas y generación tecnológica máxima 23→24**. Hubo seis ensayos exitosos y cuatro fallidos, con costes y materia reales, sin órdenes ni reposiciones. La diversidad funcional cuantizada permaneció **48→48**: no son seis funciones nuevas. La activación de memoria finita en esa copia retiró **79 instrucciones, 71 registros de práctica sin soporte y cuatro recuerdos de enseñanza**, conservando exactamente materia, cuerpos, proyectos, identidades y genealogía. Dos recargas conservaron el mundo exacto; el respaldo y las fuentes permanecieron intactos. Esta prueba no es historia del mundo nuevo publicado. [EVIDENCIA](docs/EVIDENCIA.md) conserva los artefactos, sus cortes y límites.

Esta observación comprueba que el código ahora activo supera el bloqueo artificial de la caché, sin acreditar mantenimiento productivo, continuidad indefinida ni una nueva función física. La prioridad inmediata es explicar el fallo de recambio V6 con controles causales sobre decisiones existentes. Después se retomarán reposición material, transmisión y usos nuevos comprobables, manteniendo costes, percepción local y ausencia de rescates. El archivo no reconstruye intervalos perdidos y la organización sigue analizando su ventana reciente. Las pruebas de laboratorio de catálogo y las matrices biológicas responden preguntas distintas. Los siete frentes y sus criterios están una sola vez en [CONSTRUCCION](docs/CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente); sus bases están en [CIENCIA](docs/CIENCIA.md#investigación-pendiente-diversidad-y-continuidad-causal). Este tramo sirve al [objetivo rector](#objetivo-rector); no agota sus frentes ecológico, territorial, social y de interfaz.

Una frontera material producida y reparada por la red sigue siendo una hipótesis posterior: solo aporta al objetivo si su desgaste afecta procesos y su reposición depende de ellos. Añadir cuerpos, instituciones o límites con nombres nuevos no sustituye ese circuito causal.

### Documentación y continuidad del trabajo

Un tema tiene una referencia canónica y los demás documentos la enlazan. No crear documentos históricos o de fase que dupliquen reglas, diseño o evidencia: Git ya conserva esas revisiones. Cada cambio de alcance actualiza esta tabla, su regla cuando exista y su evidencia cuando se ejecute.

| Referencia canónica | Responsabilidad |
|---|---|
| [GOAL.md](GOAL.md) | Objetivo rector listo para copiar, criterios de aceptación y condiciones de cierre. |
| [PLAN.md](PLAN.md) | Ideas acumuladas, alcance, orden y estado de trabajo. |
| [README.md](README.md) | Arranque, acceso, operación y recuperación. |
| [REGLAS.md](docs/REGLAS.md) | Mecánicas, fórmulas, costes, límites y condiciones del modelo implementado. |
| [CONSTRUCCION.md](docs/CONSTRUCCION.md) | Arquitectura, persistencia, contratos e integración. |
| [EXPERIENCIA.md](docs/EXPERIENCIA.md) | Interfaz, interacción, narrativa y voz. |
| [CIENCIA.md](docs/CIENCIA.md) | Fuentes, interpretación y límites de las afirmaciones científicas. |
| [EVIDENCIA.md](docs/EVIDENCIA.md) | Verificación vigente, condiciones medidas y capacidades todavía no probadas. |

Las especificaciones en desarrollo deben identificarse como tales. Una prueba unitaria, una ejecución autónoma y una capacidad desplegada son estados diferentes. Los resultados detallados de herramientas quedan en artefactos; su interpretación vigente se incorpora a EVIDENCIA sin crear otro documento competidor.

El servicio V5 empezó un mundo nuevo autorizado después de comprobar que el V4 privado era inválido, conservando íntegra su historia y el acceso existente. La política de versiones de pruebas amplía el comienzo desde cero a cada publicación durante esta etapa, con respaldo previo y contraseña estable; se aplicó a `7d8777c` y a `03470e3`. No convierte un error de lectura o una extinción en motivo para borrar o repoblar silenciosamente una ejecución. Los detalles de esta [publicación con mundo nuevo](docs/EVIDENCIA.md#publicación-con-mundo-nuevo) están en EVIDENCIA.

Una incorporación debe describir **qué permite observar o hacer, qué causa cambia y qué aporta al mundo o a la carta**. Se prueba con la solución más pequeña que cierre ese circuito. Si duplica otra mecánica o añade complejidad sin consecuencia comprobable, se revisa antes de incorporarla. Aumentar escala exige una mejora de experiencia o continuidad y un presupuesto medido.

La profundidad vendrá de combinar las reglas y acumular historia. No se añade un subsistema por cada concepto filosófico.

## Dónde está cada cosa

- [Experiencia, reglas del mundo y carta](docs/EXPERIENCIA.md).
- [Construcción, persistencia y comprobaciones](docs/CONSTRUCCION.md).

El plan y sus documentos de experiencia, construcción, [reglas](docs/REGLAS.md) y [ciencia](docs/CIENCIA.md) sustituyen la documentación anterior como plan de trabajo. El código actual, el README y las comprobaciones de esta implementación describen las capacidades presentes; las afirmaciones históricas de pruebas o despliegue no se trasladan a este prototipo.

Se revisaron los 44 archivos originales de ideas, conceptos, arquitectura, narrativa, voz, legado, operación, validación y plantillas. Antes de retirarlos se comprobó que coincidían con Git. La versión íntegra de esos documentos permanece en el commit `fe6a3a8c65820bb75be290e7c68faac1625e8d44`; no se conserva otra carpeta de archivo que vuelva a competir con el plan.

Para consultar una fuente histórica sin restaurarla al árbol de trabajo:

```sh
git ls-tree -r --name-only fe6a3a8c65820bb75be290e7c68faac1625e8d44 -- docs
git show fe6a3a8c65820bb75be290e7c68faac1625e8d44:docs/MAPA_DE_IDEAS.md
```
