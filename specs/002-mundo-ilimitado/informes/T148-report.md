# T148: modo depuración, guardia de solo lectura en la fase de decisión

Worktree `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/t148-guardia-fase-b`, rama
`sprint/t148-guardia-20261119`. Tarea de la Etapa E (`specs/002-mundo-ilimitado/tasks.md`, T148).

## Ficheros tocados

- `src/world/params.ts`: clave `motor.depuracion` (booleano, default `false`) en `WorldParams`,
  `RAW_HISTORICAL` (y por tanto `HISTORICAL_PARAMS` y `DEFAULT_PARAMS`) y `PARAM_DESCRIPTORS`.
- `src/world/digesto.ts`: `paramsParaDigesto` quita `motor.depuracion` antes de hashear los params
  (en `digestoCanonico` y en `canonicalWorld`/`diferenciaCanonica`).
- `src/world/paralelo/guardia.ts` (nuevo): `createDecisionReadOnlyProxy` y `withReadOnlyDecisionGuard`.
- `tests/guardia-fase-b.test.ts` (nuevo): 9 pruebas.
- `tests/params.test.ts`: la aserción exacta de `DEFAULT_PARAMS.motor` incluye `depuracion: false`; nueva
  prueba de parseo y de digesto.
- `tests/digesto-stream.test.ts`: la referencia «bytes previos» omite `motor.depuracion` (ver decisiones).

No cambia ningún default existente ni `RULES_VERSION`: la clave nueva no altera la dinámica.

## Decisiones

**1. `motor.depuracion` queda fuera del digesto.** El digesto serializa `paramsOf(world)` completo, así
que añadir la clave lo habría cambiado en todos los mundos (con `false` aparece `"depuracion":false` en
`motor`) y además activar la guardia habría movido el digesto. El control de T148 pide lo contrario, así
que la clave es un interruptor de diagnóstico y se excluye del hash. Consecuencia: los digestos de
mundos existentes siguen iguales byte a byte.

**2. Referencia de `digesto-stream.test.ts`.** La prueba «streamed digest preserves prior bytes» construye
los bytes de referencia con `paramsOf(world)` completo. Al aplicar (1) fallaba en las tres semillas. Su
intención es fijar los bytes anteriores a la clave, así que ahora la referencia omite `motor.depuracion`.
No se relajó ninguna comparación: el digesto del stream sigue comparándose con bytes exactos.

**3. Firma de `withReadOnlyDecisionGuard`.** El enunciado pedía `fn: () => T`, pero una función sin
argumentos no puede recibir la vista protegida, y sin ella el código no tiene forma de leer a través de la
guardia. Se usa `fn: (vista: World) => T`. Un `() => T` sigue siendo asignable. Con `depuracion=false`
recibe el propio mundo (`===`), sin proxies ni copias.

**4. Params dentro de la vista.** `paramsOf` busca en un `WeakMap` por identidad, así que `paramsOf(proxy)`
devolvería `DEFAULT_PARAMS` en silencio. `withReadOnlyDecisionGuard` registra los params del mundo sobre la
vista con `setParams` (solo con `depuracion=true`).

## Qué hace la guardia

Con `motor.depuracion=true`, `createDecisionReadOnlyProxy` envuelve el mundo en un proxy profundo. Lanza
un `Error` con el formato `<Operación> prohibida en fase B por slot <N> sobre <ruta>`:

- `set`: `Escritura prohibida en fase B por slot 3 sobre tiles[0].food`.
- `deleteProperty`: `Borrado prohibido …`; `defineProperty`: `Redefinición prohibida …`; también
  `setPrototypeOf` y `preventExtensions`.
- `TypedArray`: escritura indexada y mutadores (`set`, `fill`, `copyWithin`, `reverse`, `sort`) lanzan con
  la ruta del buffer (`datos.fill()`). `buffer` y `subarray` devuelven copias, así que no dejan escribir el
  buffer compartido.
- `Map`/`Set`: mutadores (`set`, `add`, `delete`, `clear`) lanzan.
- Las lecturas de objetos y arrays anidados devuelven proxies con caché por objeto, para que `===` siga valiendo
  dentro de la fase.

Con `depuracion=false` no se crea ningún proxy: `withReadOnlyDecisionGuard` llama a `fn(world)` directamente.

## Límites conocidos

- **No está conectada a `stepWorld`.** La fase de decisión de hoy es el bucle serial
  `for (const person of world.people) bodyAndAction(world, person)` (`src/world/index.ts`), y ese código
  escribe legítimamente el estado de la propia persona. Activar la guardia ahí haría fallar el mundo
  normal. Separar decidir de escribir es T145 y T149. Por eso el cierre de T148 («la guardia activa en todas
  las corridas del laboratorio de la etapa E») queda pendiente de esas tareas: la guardia está lista para
  envolver el paso de decisión cuando exista.
- Un valor leído de un `Map` o `Set` (`get`, `forEach`) no pasa por el proxy.
- Un objeto alcanzado por dos rutas conserva la ruta de su primer acceso, así que el mensaje puede nombrar
  esa ruta.
- Las propiedades no configurables y no escribibles devuelven su valor real, por la invariante de `Proxy`.
- `DataView` no tiene guardia de mutadores (no aparece en el estado del mundo).

## Verificación

- `npm run typecheck` (`tsc --noEmit`): exit 0.
- `npx tsx --test tests/guardia-fase-b.test.ts tests/params.test.ts`: 35 pruebas, 35 pasan.
- Control de regresión: `digesto`, `digesto-stream`, `params-instantanea`, `rules-version`,
  `reglas10-defaults`, `migration-params-v1`, `snapshot`, `snapshot-parts`, `snapshot-numbers` y
  `limites-anticorrupcion`: 173 pruebas, 172 pasan, 0 fallan, 1 saltada (`skipped`, no es de esta
  tarea). Es un subconjunto dirigido; no se ejecutó `npm test` completo.

Primera corrida roja de la guardia: el módulo no existía (`ERR_MODULE_NOT_FOUND`), como se espera en TDD.
