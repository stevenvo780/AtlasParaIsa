# T165 — Panel del techo y estado del gobernador en el cliente

## Ficheros tocados

- `src/shared/types.ts` — campos opcionales del gobernador en `RuntimeStats.gobernador`.
- `src/client/gobernador-view.ts` — función pura del panel (`formatearPanelGobernador` / `renderPanelGobernador`).
- `src/client/game.ts` — integración en el DOM (`renderPanelGobernadorEnDom`, llamada desde `renderStats`).
- `src/client/world-shell.ts` — contenedor `#panel-gobernador` en el cajón Mundo.
- `tests/panel-gobernador.test.ts` — nuevo.
- `specs/002-mundo-ilimitado/informes/T165-report.md` — este informe.

## Qué cambió y por qué

### Tipos (`src/shared/types.ts`)

`RuntimeStats.gobernador` conserva sus campos de siempre (`activo`, `presupuestoMs`, `p95StepMs`, `manual`, `techo`) y añade, todos opcionales y compatibles hacia atrás: `estado` (`verde|amarillo|rojo|manual`), `p95Ms`, `maxMs`, `faseMax`, `senal`, `teselasActivas`, `teselasPorHabitante`, `techoPoblacion`, `reproductionEnabled`, y en `techoObservado` el nuevo `maxMs` opcional. `politica` pasa a `string` (los valores conocidos siguen siendo `apagar` y `techo`) y `techoObservado.senal` pasa de `'p95'` a `string`, como pide el contrato de T165. `techoObservado.motivo` se mantiene como `string` requerido en el tipo del cable porque el servidor siempre lo produce (`describirFrenazo` en `governor.ts`) y un test existente lo lee como tal; la entrada laxa del panel (`GobernadorPanelInput`) sí lo admite ausente y en ese caso compone el texto desde las cifras. Un servidor anterior que omita los campos nuevos sigue cargando: todo es opcional.

### Función pura del panel (`src/client/gobernador-view.ts`)

`formatearPanelGobernador(entrada, poblacion?, teselasActivasRespaldo?)` acepta el gobernador suelto, el `RuntimeStats` (`performance`) o el `WorldView` (`state`) entero, y devuelve `{ estado, titulo, lineas, texto, html, manual, senal, teselasPorHabitante, techoPoblacion, techoObservado, p95Ms, presupuestoMs, maxMs, faseMax }` o `null` si no hay gobernador. `renderPanelGobernador(...)` devuelve solo el HTML (cadena vacía sin gobernador). Sin DOM, sin relojes, sin estado: determinista.

El panel muestra, en español sobrio y por causas (principio VI):

- `Estado del gobernador: verde|amarillo|rojo|manual`. El estado se toma de `estado` si viene; si no, se deriva del margen p95/presupuesto (`>100 %` rojo, `≥70 %` amarillo, resto verde) o de un techo vigente (amarillo). Si `manual` no es `null` o `estado` es `manual`, el estado es `manual` y una línea lo dice explícitamente: «Gobernador en modo manual: los nacimientos … por orden manual; el gobernador mide el paso pero no decide», con la mención `(reproductionEnabled fijado manualmente)` cuando ese campo viene fijado.
- Señal disparadora y margen: `Señal disparadora: p95; paso p95 X ms frente a Y ms de presupuesto (margen Z ms)`, usando `p95Ms` o, en su defecto, `p95StepMs`.
- Pico de ventana: `Pico máximo de la ventana: A ms en la fase B` cuando `maxMs`/`faseMax` están disponibles.
- `Teselas activas por habitante: R (T teselas activas / P habitantes)`, tomando `teselasPorHabitante` si viene o derivándolo de `teselasActivas` (o `activeTiles`) y la población; con 0 habitantes dice «sin habitantes» y no divide.
- Techo vigente (`Techo de población: N habitantes`, de `techoPoblacion` o `techo`) y techo observado: si `techoObservado.motivo` viene, se cita; si no, se compone («frenado por p95 = … con … habitantes y … teselas activas (paso …)»), más las teselas por habitante y el pico de ese frenazo. El techo observado se imprime siempre que exista, aunque el estado actual haya vuelto a verde: es historia, no se borra.

### Integración en el DOM (`game.ts`, `world-shell.ts`)

`world-shell.ts` reserva `<section id="panel-gobernador" data-panel-gobernador-contenedor>` dentro del cajón Mundo (`#stats-drawer`), que es el mismo shell en escritorio y en modo observador. `game.ts` lo rellena con `renderPanelGobernadorEnDom()` desde `renderStats()`, con `world.performance` y `world.stats.population`, y lo oculta si el servidor no informó el gobernador. El chip del HUD (`growth-chip`) y las tarjetas existentes de Rendimiento no cambian.

## Cómo se prueba

`tests/panel-gobernador.test.ts` (6 tests) prueba a partir del `state`:

1. Estado rojo con señal `p95`, margen p95/presupuesto, pico máximo con su fase, teselas por habitante, techo de población y techo observado con motivo.
2. El techo observado sigue visible cuando el estado actual vuelve a verde.
3. Sin motivo, el techo observado se compone desde p95, población, teselas y paso.
4. Modo manual explícito por las dos vías: `manual: false` (orden humana) y `estado: 'manual'` con `reproductionEnabled: false` (fijado manualmente).
5. Teselas por habitante derivadas de teselas/población, 0 habitantes sin división, y ausencia de gobernador (`null` / HTML vacío).
6. El shell reserva el contenedor del panel.

Verificación ejecutada en este worktree:

- `npm run typecheck` — 0 errores.
- `npx tsx --test tests/panel-gobernador.test.ts tests/modo.test.ts` — 13/13 verdes (6 nuevos + 7 de `modo`).
- `npx tsx --test tests/gobernador-view.test.ts tests/censo-view.test.ts` — 7/7 verdes (control de no regresión en la vista del gobernador).

No se ejecutó `npm test` completo ni `npm run build`, por instrucción expresa de la tarea. No hay captura en `artifacts/`: la verificación es por la función pura y los tests, sin WebGL.

## Cifras

No aplica medición ANTES/DESPUÉS de rendimiento: es publicación en el cliente (principio de T164, «es publicación, no regla»). El coste es una función pura sobre campos ya recibidos en el `state`, ejecutada al renderizar el cajón de estadísticas.

## Hardware y resultado

El hardware no puede cambiar el resultado de este cambio: el panel solo formatea campos que ya viajan en el `state`; no lee relojes, ni `availableParallelism`, ni ninguna capacidad medida, y no toca ninguna regla del mundo ni su digesto.
