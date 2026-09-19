# Feature Specification: Mundo sólido y laboratorio masivo

**Feature Branch**: `001-mundo-solido-masivo`

**Created**: 2026-09-19

**Status**: Ready for implementation

**Input**: Steven, 2026-09-19: «La arquitectura de software es mejorable; los agentes se mueren a gran velocidad; son muy homogéneos; hay errores invisibles como que el entorno es literalmente recursos en todos lados. Tenemos ~4 horas de Fable 5.1: que aproveche el ordenador al máximo (RAM, GPUs, CPU), muchas instancias y simulaciones, workflows masivos, y que quede un proyecto sólido, presentable y visualmente muy llamativo. En el celular el frontend es imposible: entornos separados para máxima optimización.»

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Laboratorio de simulaciones masivas (Priority: P1)

Como autor, lanzo desde la terminal un barrido de N mundos sin interfaz (semillas y parámetros distintos) que ocupa todos los núcleos de la torre, corre D días simulados cada uno y me devuelve un informe comparable (supervivencia, causas de muerte, diversidad, recursos, tiempos por paso). Con eso decido qué regla cambiar y vuelvo a medir en minutos, no en horas.

**Why this priority**: sin instrumento no hay afinación honesta; todo lo demás (supervivencia, homogeneidad, abundancia) se decide con él. Es lo que convierte el evento en horas de cómputo útiles.

**Independent Test**: `npm run lab -- --replicas 32 --dias 10 --salida artifacts/lab/<sello>` termina en la torre usando ≥ 28 hilos, escribe `resumen.json` + `resumen.md` y un `control` sin cambios reproduce cifras previas con la misma semilla.

**Acceptance Scenarios**:

1. **Given** el repo en la torre, **When** ejecuto el barrido con 32 réplicas y 10 días, **Then** todos los procesos terminan, `resumen.json` tiene 32 filas con semilla, SHA, días, población inicial/final, muertes por causa, índice de diversidad, balance de recursos y p50/p95 de ms por paso.
2. **Given** dos ejecuciones con la misma semilla y el mismo SHA, **When** comparo sus resúmenes, **Then** las métricas de mundo son idénticas (determinismo) y solo cambian los tiempos.
3. **Given** un parámetro de reglas expuesto (p.ej. densidad de recursos), **When** paso `--param recursos.densidad=0.4,0.7,1.0`, **Then** el barrido corre el producto cartesiano y el informe agrupa por valor.

---

### User Story 2 - Los habitantes sobreviven, difieren y mueren por causas legibles (Priority: P1)

Como autor, quiero que en 10 días simulados la población no colapse, que dos habitantes cualesquiera se distingan por genes, oficio practicado, recuerdos y hábitos, y que cada muerte tenga causa material rastreable en la crónica.

**Why this priority**: es la queja central ("se mueren a gran velocidad", "muy homogéneos"). Sin esto la carta no vive.

**Independent Test**: sobre el laboratorio de US1, con 32 réplicas de 10 días: mediana de supervivencia de fundadores ≥ 70 %, población final entre 60 % y 200 % de la inicial, índice de diversidad de conducta ≥ 0,6 (definido en research.md), 0 muertes con causa `desconocida`.

**Acceptance Scenarios**:

1. **Given** un mundo nuevo con 16 fundadores, **When** pasan 10 días, **Then** al menos 11 siguen vivos en la mediana de 32 réplicas y ninguna réplica pierde más del 50 % en los primeros 2 días.
2. **Given** dos habitantes al día 5, **When** comparo su vector de conducta (tiempo por actividad, alimentos consumidos, lugares visitados, procedimientos practicados), **Then** la distancia media entre pares ≥ 0,6 normalizada.
3. **Given** una muerte, **When** abro la crónica, **Then** dice causa (hambre, sed, frío, herida, edad, ahogamiento…), lugar, paso y los tres eventos previos que la explican.

---

### User Story 3 - El entorno es escaso, desigual y legible (Priority: P2)

Como autor, quiero que los recursos NO estén "en todos lados": densidad por bioma, agotamiento y regeneración medibles, distancias que obliguen a moverse y a transportar, y un mapa de calor de recursos en la interfaz que lo haga visible.

**Why this priority**: la abundancia irreal esconde los demás errores y hace inútil la cooperación. Depende de US1 para medirse.

**Independent Test**: en 32 réplicas, el coeficiente de Gini de recursos por región ≥ 0,35 (hoy medido en research.md), ≥ 30 % de regiones sin agua superficial, y la distancia media recorrida para conseguir agua > 6 celdas; el mapa de calor se activa con una tecla y coincide con los conteos del servidor.

**Acceptance Scenarios**:

1. **Given** un mundo nuevo, **When** cuento recursos por región, **Then** hay regiones ricas y pobres según bioma con Gini ≥ 0,35.
2. **Given** una fuente explotada sin descanso, **When** pasan 3 días, **Then** se agota y tarda ≥ 5 días en regenerar; los habitantes cambian de fuente o transportan agua.
3. **Given** la interfaz abierta, **When** activo el mapa de calor, **Then** veo densidad por celda y los totales coinciden con `worldStatistics` del servidor.

---

### User Story 4 - Presentable: visualmente llamativo y observable desde un teléfono (Priority: P2)

Como autor, en el evento abro `https://atlas.humanizar.tech` en el portátil y se ve espectacular (luz del día, agua, vegetación, huellas, ciudades emergentes, inspector claro). Desde el teléfono abro la misma URL y recibo un **modo observador ligero**: la carta, la crónica, el censo y una vista de mapa estática o de baja frecuencia, sin WebGL pesado, sin colapsar.

**Why this priority**: el evento es una demostración; hoy el móvil "lo mata". Separar entornos (motor de render completo vs observador) es la optimización pedida.

**Independent Test**: Lighthouse móvil emulado (Moto G Power, 4x CPU slowdown) carga la ruta observador en < 3 s y usa < 150 MB; el escritorio mantiene ≥ 55 fps con 32 habitantes en 1920×1080; captura antes/después guardada en `artifacts/`.

**Acceptance Scenarios**:

1. **Given** un user-agent móvil o ancho < 700 px, **When** cargo la URL, **Then** se sirve el modo observador (sin compositor WebGL, actualización cada 5 s, crónica y censo legibles).
2. **Given** escritorio, **When** observo 60 s con 32 habitantes, **Then** fps ≥ 55 y sin picos de paso > 100 ms en el servidor.
3. **Given** el modo observador, **When** toco un habitante en el censo, **Then** veo su ficha (estado, oficio, recuerdos, causa de la última decisión) sin cargar el mapa completo.

---

### User Story 5 - Arquitectura que aguanta (Priority: P3)

Como desarrollador, el paso del mundo está separado en fases puras (percepción → decisión → acción → materia → registro) con contratos tipados, `src/world/index.ts` (1.196 líneas) y `src/client/landscape.ts` (2.032) partidos en módulos < 400 líneas, sin comportamiento cambiado (los 58 tests y el laboratorio dan lo mismo antes y después con la misma semilla).

**Why this priority**: habilita paralelizar trabajo entre agentes y mantener el proyecto después del evento; se hace después de tener el instrumento y las métricas.

**Independent Test**: `npm run typecheck && npm test` verdes; `npm run lab -- --replicas 8 --dias 3 --seed 7` produce métricas de mundo bit a bit iguales antes y después del refactor.

**Acceptance Scenarios**:

1. **Given** el refactor, **When** corro la suite y el laboratorio de control, **Then** métricas idénticas y ningún fichero de `src/world` supera 400 líneas.

### Edge Cases

- Un barrido con más réplicas que hilos: se encola sin agotar la RAM (límite de concurrencia = hilos − 2; memoria por réplica medida).
- Una réplica que se cuelga: el laboratorio la mata a los `--timeout` segundos y la marca `abortada`, sin perder las demás.
- Un cambio de reglas que rompe el determinismo: el control de la misma semilla lo detecta y el informe lo marca en rojo.
- Móvil con ancho grande (tablet apaisada): el modo se decide por capacidad (WebGL2 disponible + memoria), no solo por ancho; siempre hay conmutador manual.
- Servidor público en marcha durante el trabajo: el laboratorio nunca toca `data/` del servidor; usa `CARTA_DATA_DIR` temporal por réplica.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: El sistema MUST ofrecer `scripts/lab/` (comando `npm run lab`) que lance N mundos sin interfaz en procesos paralelos con semillas y parámetros dados, con límite de concurrencia y timeout por réplica.
- **FR-002**: Cada réplica MUST emitir métricas estructuradas (JSON) por día: población, nacimientos, muertes por causa, diversidad de conducta, recursos por región, agua disponible, construcciones, p50/p95 ms por paso, RSS.
- **FR-003**: El laboratorio MUST generar `resumen.json` y `resumen.md` con agregados (mediana, p10, p90) por grupo de parámetros y una comparación contra un `control` designado.
- **FR-004**: Las reglas ajustables de supervivencia y recursos MUST exponerse como parámetros con nombre (`src/world/params.ts`) leídos por el laboratorio; los valores por defecto quedan documentados en `docs/REGLAS.md`.
- **FR-005**: La generación de recursos MUST depender del bioma y de la distancia, con agotamiento y regeneración, y MUST registrar por región los totales para estadísticas.
- **FR-006**: Cada muerte MUST registrar causa, lugar, paso y eventos previos en la crónica; ninguna muerte puede quedar como `desconocida`.
- **FR-007**: La diversidad MUST medirse con un índice definido (research.md) y exponerse en `worldStatistics`.
- **FR-008**: El cliente MUST detectar capacidad del dispositivo y servir modo observador ligero (sin WebGL2, actualización a baja frecuencia) o modo completo, con conmutador manual.
- **FR-009**: El modo observador MUST mostrar la carta de apertura, crónica, censo y fichas de habitantes con lo que ya envía el servidor, sin nuevos endpoints salvo un `state` reducido opcional.
- **FR-010**: El modo completo MUST incluir mapa de calor de recursos y un pase visual de luz diurna/agua/vegetación coherente con las reglas.
- **FR-011**: `src/world/index.ts` y `src/client/landscape.ts` MUST partirse en módulos por fase/tema sin cambiar el comportamiento (verificado por determinismo).
- **FR-012**: Toda tarea de reglas MUST dejar su experimento y su fila en `docs/EVIDENCIA.md`.

### Key Entities

- **Réplica**: ejecución de un mundo con semilla, parámetros, SHA, días; produce series diarias y un resumen.
- **Barrido**: conjunto de réplicas con producto cartesiano de parámetros y un control.
- **Métrica diaria**: fila por (réplica, día) con población, muertes por causa, diversidad, recursos por región, tiempos.
- **Parámetro de reglas**: nombre, valor por defecto, rango válido, descripción; único punto de ajuste.
- **Modo de cliente**: `completo` | `observador`, decidido por capacidad y conmutable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un barrido de 32 réplicas × 10 días termina en < 15 min en la torre y usa ≥ 85 % de los hilos durante la ejecución.
- **SC-002**: Mediana de supervivencia de fundadores a 10 días ≥ 70 %, sin réplica con colapso > 50 % en los 2 primeros días.
- **SC-003**: Índice de diversidad de conducta ≥ 0,6 en la mediana de réplicas al día 5.
- **SC-004**: Gini de recursos por región ≥ 0,35 y ≥ 30 % de regiones sin agua superficial.
- **SC-005**: 0 muertes con causa `desconocida` en 32 réplicas.
- **SC-006**: Modo observador en móvil emulado: carga < 3 s, memoria < 150 MB, sin errores de consola; escritorio ≥ 55 fps con 32 habitantes.
- **SC-007**: Suite (58 tests) y typecheck verdes en cada fase; determinismo conservado tras el refactor (métricas idénticas con la misma semilla).
- **SC-008**: `docs/EVIDENCIA.md` con una sección nueva fechada 2026-09-19 con SHA, semillas y cifras de cada criterio.

## Assumptions

- El servidor público (`atlas.humanizar.tech`) sigue sirviendo `main` compilado; el trabajo ocurre en la rama de feature y se integra al final de cada fase verde.
- No hay presupuesto de GPU para la simulación en este bloque: la GPU se usa para render y, si sobra tiempo, para el benchmark de ecología ya existente (`scripts/compute-ecology-*`). La CPU (32 hilos) es el recurso principal del laboratorio.
- La carta, los recuerdos y S e I no se tocan sin Steven.
- Las cifras objetivo (70 %, 0,6, 0,35) son puntos de partida; el laboratorio puede revisarlas con evidencia y dejarlo escrito.
