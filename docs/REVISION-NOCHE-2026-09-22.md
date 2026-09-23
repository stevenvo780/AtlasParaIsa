# Noche del 22 al 23 de septiembre de 2026 — extinción pública, gobernador `techo` y cerrojo de natalidad

Fuente: `docs/ops/noche-20260922-bitacora.md` (bitácora del orquestador, primero Fable, después Opus
tras una pausa pedida por Steven) y `git log --oneline main..HEAD` en `sprint/noche-integra-20260922`.
La noche corrió un workflow de Etapa A de `specs/002-mundo-ilimitado/` (T100, T103–T109, T134, T136,
gobernador y laboratorio) en worktrees paralelos con revisor adversarial de otro proveedor, seguido de
la integración en `n-INTEGRA` y de un A/B de ciencia sobre las leyes de comportamiento y de natalidad.

## a. Causa de la extinción pública V7

Diagnóstico inicial (09:58): la extinción de la V7 pública fue la política `apagar` del gobernador. El
p95 del paso completo superó los 50 ms por el coste de clonar y guardar un mundo ya envejecido, y el
gobernador apagó los nacimientos durante quince días; sin nacimientos, la senescencia vació el mundo.
Los conflictos por recursos se mantuvieron en cero desde el principio porque `resourceDispute` exige a
la vez hambre ≥ 0,65 en los dos implicados, una fuente casi agotada y contacto a ≤ 2 celdas: no forman
parte de la causa de la extinción.

Esa causa se reprodujo en laboratorio con el brazo `apagar` (parámetros públicos, clon por paso, 4
semillas × 25 días — el mismo coste que paga el servidor público):

- Semilla 1 (detalle a las 11:00): 21 → 19 (día 9) → 14 (día 13) → 7 (día 16) → 2 (día 21, solo S e I);
  5 nacimientos en total; el último frenazo del gobernador quedó registrado con 2 habitantes.
- Cierre del brazo, 4/4 semillas a los 25 días (11:30): 51926: 22 → 2 al día 20 con 6 nacimientos; 1:
  21 → 2 al día 21; 42: 21 → 2 al día 18; 7: 16 → 2 al día 19, con 0 nacimientos.

Las cuatro semillas se extinguen hasta quedar solo S e I: es, literalmente, la reproducción
experimental de la extinción pública.

## b. Política `techo` y por qué el techo nunca baja

A las 10:10, worktree `n-GOB` introduce la política `techo`: por encima del presupuesto de paso se fija
un techo igual a la población del momento del frenazo, y por debajo de ese techo solo se permite
reponer muertes, no crecer (47/47 tests + 180/180 de persistencia). A las 10:35, bajo carga externa
sostenida en la torre (carga 30, p95 100–145 ms), se comprobó que **bajar** el techo cuando el rojo es
grave es peligroso: una carga externa ajena a la biología del mundo lo vaciaría igual que la política
`apagar`. La bajada se eliminó (`3c6e801`, *«Never lower the observed ceiling: the governor stops
growth, not lives»*): el techo nunca baja; solo se retira (deja de aplicarse) cuando la carga vuelve a
un margen sano. El brazo `techo` se relanzó con esa corrección.

El experimento del gobernador (4 semillas × `apagar`/`techo` × 25 días, parámetros públicos, clon por
paso, torre saturada) cerró a las 12:35 con las 8 réplicas terminando en 2 habitantes:

- `apagar`: 0–6 nacimientos y extinción igual que en el mundo público.
- `techo`: el frenazo llegó ya el día 1 (p95 > 50 ms por la propia saturación de la torre) y fijó el
  techo en la población inicial (16–22 según la semilla); cuando empezaron las muertes (día 10) la
  reproducción quedó permitida, pero **no hubo nacimientos**.

Conclusión registrada en la bitácora: el gobernador `techo` es **necesario** (evita el apagado
indefinido) pero **no suficiente**: la ausencia de nacimientos con reproducción habilitada es un
cerrojo biológico, no del gobernador, y las leyes de natalidad son la corrección de fondo.

## c. El cerrojo biológico de natalidad — embudo en las semillas 7 y 42

A las 11:35 se confirma que el cerrojo depende de la geografía de la semilla y no solo del gobernador:
con clon+gobernador, la semilla 1 llega a 7 habitantes en el día 17 con reproducción permitida y 0
nacimientos, la 42 a 3 y la 7 a 2 en el día 25. Incluso en el A/B de ciencia sin ningún freno
(presupuesto de gobernador a 5000 ms, nunca frena), el control de la semilla 42 colapsa igual (8
nacimientos, ninguno después del día 5) y la 7 apenas nace (2 en 10 días), mientras 51926 y 1 crecen
sin problema (48 al día 9, 69 al día 11).

El instrumento `scripts/lab/diagnostico-natalidad.ts` (worktree `n-CIENCIA`) contó, comprobación a
comprobación, cuántos mortales pasan cada condición de `reproduce()`:

- **Semilla 7** (11:50; 14 mortales, 6 días, 0 nacimientos): fértiles ≈ 9, con comunidad solo 6,
  fértiles + comunidad + lugar ≈ 4,7, **con pareja 0**. En el instante de cada comprobación (cada 120
  pasos) los vínculos válidos estaban a más de 3 celdas.
- **Semilla 42** (12:00; 18 mortales, 8 días): la comunidad no es el cerrojo (15–17 la tienen);
  fértiles 5–10; fértiles + comunidad + lugar 4–6; con pareja ≈ 0 desde el día 6; bloqueados por
  distancia 5–7 (vínculo mutuo válido, pero a más de 3 celdas en el instante de la comprobación).

El cerrojo dominante identificado en ese momento, en ambas semillas: el muestreo instantáneo a 3
celdas, cada 120 pasos. Se encargaron cuatro leyes candidatas (worktree `n-CIENCIA`, Opus), todas con
default = comportamiento de hoy: `poblacion.exigeComunidad`, `poblacion.radioPareja`,
`poblacion.radioLugar` y `poblacion.comprobacionContinua` (cambia solo el muestreo — de una vez cada
120 pasos a cada paso, descontando los nacimientos de la ventana móvil anterior — sin tocar el techo de
nacimientos por ventana ni añadir estado nuevo a `World`).

**Corrección posterior, tras implementar las cuatro leyes (commit `1edec7d`, WIP):** mirando los 7200
pasos completos de la corrida —no solo el instante de las ~60 comprobaciones puntuales— el cerrojo de
la semilla 7 no son 3 celdas: el par fértil, no consanguíneo y con vínculo mutuo ≥ 0,3 **más cercano**
de toda la corrida está a **18,38 celdas**. Por eso `radioPareja=6` —y también 12— no abren nada; hace
falta subirlo a 20 para que nazca 1. El radio de pareja es el cerrojo real, y es mucho mayor de lo que
el primer diagnóstico instantáneo sugería: los vínculos existen, pero la gente que se quiere está lejos.

Cifras a 3 días (7200 pasos, nacimientos acumulados, instrumento): semilla 7 → 0 con defaults, 0 con
cada clave por separado, 0 con las cuatro y `radioPareja=6`, 1 con las cuatro y `radioPareja=20`.
Semilla 42 → 6 con defaults, 6 con `exigeComunidad`/`radioLugar`/`comprobacionContinua` por separado, 8
con `radioPareja=6`.

Defecto anotado y no corregido en esta noche: el evento de fundación de una comunidad se emite con el
mismo arreglo que `group.members` (`society.ts`); con `comprobacionContinua` un nacimiento puede caer
varios pasos después de archivado el evento y `Store.save` aborta con «an immutable event cannot be
overwritten» (reproducido en la semilla 42, paso 167). El arreglo de raíz mueve el digesto de semillas
ya grabadas, así que se revirtió; `reproduce()` evita el alias solo en el camino nuevo. Queda anotado en
`docs/REGLAS.md` como tarea aparte.

Tras la pausa, se añadió además una quinta ley candidata (commit `8b9b58a`): `poblacion.cortejo`
(default 0 = conducta de hoy) y `poblacion.radioCortejo` (24) — quien está en edad fértil y recuerda un
vínculo mutuo con otra persona fértil no emparentada va hacia ella, pagando el movimiento, sin crear
recursos. El resultado medido de este carril queda pendiente (§g).

## d. Etapa A integrada: estado de cada tarea

El workflow de Etapa A cerró a las 13:05: 27 agentes, 2 horas, 4,15 M tokens de subagentes. Integración
en `n-INTEGRA` (rama `sprint/noche-integra-20260922`): a las 12:10 quedaron fusionadas T103, T105,
T106, T107, T108, T109, T100, GOB, LAB, T134 y T136 (27 commits sobre `main`, con dos conflictos
triviales resueltos en `app.ts` y `types.ts`); typecheck verde. T104 se fusionó después (`e669ea4`, a
las 13:15) porque dependía de T101/T103 y era, según la propia tarea, «la más delicada de la etapa».

| Tarea | Estado al cierre | Qué cerró / qué queda |
| :--- | :--- | :--- |
| **T100** | Parcial, resuelto en integración | Dos hallazgos altos de diseño: la admisión (`limites.*`) no puede ser política. Separado en `0179d60` (*«Separate community founding and fauna breeding from admission limits»*): el tope de fundación de comunidades pasa a `social.maxComunidades` (default 8 = conducta de hoy), la cría de fauna vuelve a la capacidad natural del terreno, y `limites.*` solo admite o lanza (136/136 focales). El «sin tope» de fundación queda deliberadamente para la próxima versión de reglas (FR-002). |
| **T103** | Parcial | Clon acotado de `retiredChunks`; paridad de digesto probada, pero el **gate de rendimiento sigue abierto** (no alcanza las cifras objetivo de p50/p95 del clon). |
| **T104** | Parcial | Punto de restauración correcto y digesto idéntico; las cifras objetivo de tiempo por paso no son alcanzables porque el paso lo domina la simulación, no el clon. Hallazgo: `delete tile.species` deja las teselas en modo diccionario, y el clon por paso las renormalizaba sin que nadie lo supiera; el punto de restauración conserva esa higiene. Fusionada en `e669ea4` (30 commits sobre `main`): `stepOnce` coherente con el punto de restauración + perfil por fase (T107) + gobernador `techo` (GOB); 94/94 focales del bucle del servidor. |
| **T105** | Aprobada | `prep`/`flushTechnology` del guardado. |
| **T106** | Aprobada | `assertWorld` deja de ser cúbico. |
| **T107** | Aprobada | Perfil por fase y fracción serial. |
| **T108** | Aprobada | Banco de cómputo del kernel desbloqueado y perfilado. |
| **T109** | Hallazgo medio → cerrado | Un hallazgo medio (test del control frente al laboratorio) seguía abierto al cierre del workflow (13:05); Sonnet lo cerró después en su worktree (13:15) y se fusionó junto con el resto de la suite en `9d2089b` (13:35). |
| **T134** | Aprobada | `people`/`communities`/`blueprints` por viewport y censo en el servidor. |
| **T136** | Medida y decidida | `perMessageDeflate` ahorra 88,7 % de bytes, pero cuesta +58,8 ms de p95: **se mantiene desactivado**. |

Otros hitos de la integración: a las 12:25, commit `0179d60` separa admisión de conducta (136/136
focales); a las 12:50, regresión focal desde la raíz: 71/71 (los 29 fallos previos eran el `cwd`, no un
defecto real); a las 13:35, suite completa de la integración (`9d2089b`, ya con el test de control de
T109): **1300/1307**, 4 omitidos, 2 fallos + 1 timeout, los tres sensibles a la carga de la torre (R²
del ajuste lineal de `assertWorld` en 0,918 < 0,95 con carga 50; el planificador de deriva; y
`world.test.ts` por encima de 600 s). Queda pendiente repetirla con la torre tranquila al terminar el
A/B.

## e. Resultados del A/B de ciencia de 15 días

A las 12:10 se lanzó el A/B (worktree `n-LABCIENCIA` = LAB + CIENCIA): brazos control/H(abituación)/
R(esencia de disputa)/C(onfianza-salida) × semillas 51926, 1, 7, 42 × 15 días, determinista, sin clon,
gobernador con presupuesto de 5000 ms (nunca frena). A las 11:50 se lanzó una segunda ola de brazos: D
(cinco claves de disputa), D2 (más agresivo: necesidad 0,3, escasez 8, radio 4) y ALL (todas las leyes),
porque aflojar solo el destino y la espera de la disputa (`disputaDestino=1,5`, `disputaEspera=60`) no
cambiaba nada (`7876a7a`): el cerrojo real de la disputa es la conjunción de necesidad, escasez y
proximidad, no esas dos condiciones.

Primer corte a las 12:50 (15 días, 4 semillas; habitantes por semilla, orden 1/42/51926/7):

| Brazo | Semilla 1 | Semilla 42 | Semilla 51926 | Semilla 7 | Nota |
| :--- | ---: | ---: | ---: | ---: | :--- |
| control | 112 | 7 | 55 | 11 | — |
| habituación 0,35 | 62 (d14) | 12 | 69 (d12) | 45 (d13) | rescata 7 y 42, frena a 1 |
| disputas | 56 | 9 | 52 | 11 | 144 conflictos y 44 muertes en la semilla 1 |
| D2 | — | — | — | — | 604 conflictos, aún peor que «disputas» |

`conducta.habituacion=0,35` rescata la natalidad de las semillas 7 y 42, pero frena el crecimiento de la
semilla 1. Las leyes de disputa cuestan vidas (144 conflictos, 44 muertes en la semilla 1) sin ganar
diversidad (0,46 frente a 0,48 del control): **no se adoptan tal cual**. **Ningún brazo alcanza SC-003
≥ 0,6** (el rango medido va de 0,3 a 0,5). Los brazos de enseñanza rara y de comunidades (confianza de
salida / distancia alternativa) seguían en curso al cerrar este corte.

## f. Cambio de estrategia: biología antes que escala

El cerrojo de natalidad resultó ser espacial y mucho más severo de lo estimado en el primer diagnóstico
(18,38 celdas, no las 3 que sugería el muestreo instantáneo), el gobernador `techo` por sí solo no
alcanza para sostener una población si nadie nace, y ningún brazo del A/B de comportamiento llegó a
SC-003 ≥ 0,6 en 15 días. Con esa evidencia se decide invertir el orden de trabajo de
`specs/002-mundo-ilimitado/`:

- **Congelar las etapas B–F hasta que los 16 fundadores lleguen a 100 días con 3 generaciones en el
  90 % de las semillas.** Escalar el motor (SoA, workers, GPU) no aporta nada si la población de
  partida no sobrevive lo bastante para producir los datos que esas etapas necesitan medir.
- **Diagnosticar antes que replicar**: seguir localizando el cerrojo exacto con instrumentos dirigidos
  (como `diagnostico-natalidad.ts`) antes de lanzar barridos amplios de leyes.
- **Carril experimental barato**: 4–6 semillas × 10 días en vez de barridos de 15–25 días con muchas
  semillas, para iterar más rápido sobre hipótesis de leyes.
- **Menos umbrales**: preferir leyes con menos condiciones apiladas — la noche mostró que varios
  umbrales exigidos a la vez (necesidad, escasez, proximidad, comunidad, radio) se combinan en
  cerrojos mucho más estrictos que la suma de sus partes, y que cuesta más diagnosticar cada umbral por
  separado que evitar acumularlos.

Esto es consistente con lo que la bitácora deja pendiente al pausar (12:40): fusionar el WIP de
natalidad → ola 3 del A/B → adopción de leyes → suite con la torre tranquila → documentación → `main` →
publicación por protocolo.

## g. Resultado del carril de cortejo y adopción en reglas 10

**Diseño.** Ronda 2: 16 semillas (7, 42, 51926, 1, 104729, 20260919, 2024, 31337, 3, 11, 99, 256, 777,
1234, 4242, 9001) × 30 días, sin gobernador, `persistencia.cadaTicks=300`. Brazos: `control` (reglas de
hoy), `Psinagua` (el paquete adoptado: cortejo 2, radio 128, `exigeComunidad=false`,
`comprobacionContinua=true`, habituación 0,35), `P` (lo mismo + `agua.memoria=0.6`), `Papt` (P + aptitud +
convivencia), `Pcoh` (P + cohorte de fundadores escalonada; retirado por dañino) y `Plong20`/`Plong30`
(Psinagua + longevidad base 20/30 días). 35 réplicas cayeron por la cuota de `/tmp` (tmpfs); las de
`control` y `Psinagua` se relanzaron sobre `/datos` y sus datos parciales se conservan: el fallo es de
E/S, no del mundo, y la simulación es determinista.

**Cifras (recuento final desde los `dia-NNN.json`).**

| día | brazo | semillas con dato | ≥ 16 habitantes | mediana | solo S e I |
|---|---|---|---|---|---|
| 10 | control | 16 | 14 | 24,5 | 0 |
| 10 | paquete | 16 | 15 | 63 | 0 |
| 15 | control | 15 | 7 | 13 | 0 |
| 15 | paquete | 10 | 9 | 68 | 0 |
| 30 | control | 16 (10 terminadas) | — | — | 10 |
| 30 | paquete | 16 (2 terminadas) | — | — | 1 |

Pares al día 10: el paquete supera al control en 14 de 16 semillas (por debajo en 1: 63 frente a 64, y en
20260919: 8 frente a 13). Las corridas de crecimiento son las más lentas (un día simulado con 150–250
habitantes tarda 20–60 min con la torre cargada), así que los cortes tardíos quedan sesgados hacia las
semillas pequeñas; por eso el día 30 se informa solo como extinciones terminadas. La memoria del agua
mejoró dentro de muestra y se refutó fuera de ella; `Papt` quedó por debajo de `P` al día 10 (6/8,
mediana 54 frente a 88). Con la vida alargada ninguna semilla pierde a sus mortales: 6 de 7 con ≥ 16 al día 10 (la séptima,
20260919, crece después hasta 136 el día 27), y crecen todas las que llegaron más lejos
(Plong30-31337: 139 habitantes el día 28; con el paquete solo, 66 el día 30).

**Adopción.** `688e0a6` hace del paquete los defaults de los mundos nuevos (`RULES_10_ADOPTED`); las
instantáneas antiguas completan lo ausente con `HISTORICAL_PARAMS` (conducta de antes, bit a bit). La
semilla 7 pasa de 0 a 11 nacimientos en 3 días. Queda abierto: el crecimiento es casi exponencial hasta
que lo frena el gobernador por hardware, y el criterio de 60 días necesita un techo determinista de
laboratorio (`--techo-lab`) y un motor más rápido con población alta (PERF2), en curso.
