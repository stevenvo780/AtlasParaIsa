# T162: estados, umbrales y palancas con prioridad estricta

Rama: `sprint/t162-gobernador-20261119` (sobre `d7ba0b5`, T161+T164).
Alcance: el pedido exacto de esta sesión. No se ha tocado el árbol principal
ni se ha ejecutado `npm test` completo.

## Qué se implementó

- `src/server/governor.ts`:
  - Nueva función pura `gobernar(entrada, previo)` y tipos `EstadoGobernador`
    (`'verde' | 'amarillo' | 'rojo' | 'manual'`), `PalancaGobernador`
    (`'area' | 'nacimientos' | 'red' | 'guardado'`), `SenalGobernador`
    (`'p95' | 'max' | 'rss' | 'colaRed' | 'saveMs'`), `EstadoGobernacion`
    (estado arrastrado entre ventanas, viaja como argumento/resultado, nunca
    se muta) y `DecisionGobernar`.
  - Umbrales relativos a `presupuestoMs`: amarillo desde `0.7 × presupuestoMs`
    (35 ms con 50 ms), rojo por encima de `1.0 × presupuestoMs` (50 ms).
  - `manualOverride !== null` ⇒ estado `manual`, sin palanca, y la orden
    humana es el `reproductionEnabled` resultante, dispare lo que dispare.
  - En rojo gana **una sola palanca**, en orden estricto área → nacimientos →
    red → guardado; las demás quedan intactas. Área solo la levanta el exceso
    de páginas frías con la palanca habilitada y solo **solicita**
    (`solicitarRetiroPaginasFrias`): retirarlas es T163. Nacimientos aplica
    `techo`/`apagar` sobre `reproductionEnabled`. Red sube el `subscribeMs`
    efectivo (×2, capado en 5000 ms; 1000 ms si no había suelo) antes que
    descartar. Guardado espacia `cadaTicks` (×2, capado en 20) y con
    `gestoEnEstePaso` no lo toca nunca.
  - Histéresis multiseñal: salir de rojo exige `VENTANAS_VERDES_PARA_SALIR = 3`
    ventanas verdes consecutivas (todas las señales bajo el 70 %); una
    ventana amarilla reinicia la cuenta, y mientras tanto el estado sigue en
    rojo con techo y reproducción vigentes.
  - `decideReproduction` y `decidirConTecho` no cambian. **Control**: con
    `senales = ['p95']` (o sin señalar), `gobernar` delega en ellas, no
    espera tres ventanas, y `reproductionEnabled`/`techo` reproducen el
    gobernador anterior exactamente.
  - La clase `Gobernador` delega en `gobernar`, aporta p95/máximo de su
    ventana, y publica `estadoGobernador`, `palancaActiva`,
    `senalDisparadora`, `ventanasVerdesConsecutivas`,
    `solicitarRetiroPaginasFrias`, `subscribeMsEfectivo` y
    `cadaTicksEfectivo`. `techoObservado` (T164) ahora registra la señal
    disparadora real; con `p95` el motivo conserva su formato histórico.
- `src/server/app.ts`: `governReproduction` pasa a llamarse `gobernar`;
  alimenta las señales vigentes (`saveMs`, `colaRed` de los sockets, RSS en
  MiB y el máximo/p95 de la ventana), aplica el suelo de suscripción de la
  palanca de red en `broadcast` y la cadencia espaciada de la palanca de
  guardado en el guardado por cadencia, manteniendo intacta la invariante
  «un gesto fuerza guardado en su propio paso» (`valid.length > 0` sigue
  primero). La palanca de área queda deshabilitada en el servidor
  (`areaHabilitada: false`) hasta T163. `setReproduccionManual` publica
  estado `manual`.
- `src/shared/types.ts`: `performance.gobernador` publica `estado`,
  `palancaActiva`, `senalDisparadora`, `ventanasVerdesConsecutivas`,
  `solicitarRetiroPaginasFrias`, `subscribeMsEfectivo` y `cadaTicksEfectivo`.
- `src/world/params.ts`: `gobernador.senales` admite
  `['p95', 'max', 'rss', 'colaRed', 'saveMs']` (sin duplicados, no vacía);
  las señales inventadas se siguen rechazando.

## Pruebas

`tests/gobernador.test.ts` gana 8 pruebas T162 (las 20 anteriores pasan sin
tocar una sola aserción):

1. Umbrales 35/50 ms: verde < 35, amarillo en [35, 50], rojo > 50; en
   amarillo no se toca ninguna palanca.
2. Cuatro señales a la vez (p95, max, rss, colaRed, saveMs a 80) ⇒ una sola
   palanca, `area`, con red/guardado/nacimientos intactos; y la cadena de
   reserva área → nacimientos → red → guardado al retirar cada una.
3. Guardado capa su máximo y no espacia el paso de un gesto; red capa el suyo.
4. Histéresis: 3 ventanas verdes para salir, una amarilla reinicia, y la
   oscilación rojo/verde alterna nunca sale de rojo.
5. `manual` gana a todo, activando y deteniendo, también vía la clase.
6. `gobernar` es pura: entradas y estado previo congelados, mismo resultado
   repetido, sin mutación.
7. Control exacto `['p95']` contra `decideReproduction`/`decidirConTecho`
   en una secuencia de 10 valores × 2 políticas, y salida de rojo sin
   esperar tres ventanas, tanto en la función como en la clase.
8. La clase publica estado/palanca/señal con histéresis ventana a ventana y
   el servidor real publica `rojo`/`nacimientos`/`p95` bajo carga y
   `manual` con orden humana.

Colateral por el nuevo descriptor: `tests/params.test.ts` y
`tests/params-instantanea.test.ts` dejan de tratar `rss` como señal
inválida y prueban en su lugar una inventada.

## Verificación (observada en esta sesión)

- `npm run typecheck` — 0 errores.
- `npx tsx --test tests/gobernador.test.ts tests/gobernador-senales.test.ts tests/techo-observado.test.ts`
  — **28 pasadas, 0 fallos** (20 previas + 8 nuevas).
- Extra, por el descriptor nuevo: `npx tsx --test tests/params.test.ts tests/params-instantanea.test.ts`
  — **35 pasadas, 0 fallos**.
- No se ejecutó `npm test` completo (prohibido en esta sesión) ni build.

## Límites y notas

- El retiro efectivo de páginas frías es T163: aquí la palanca de área solo
  decide y solicita; en el servidor está deshabilitada, así que con el
  default `['p95']` nada cambia (control verificado arriba).
- Los valores de `rss`/`colaRed` se comparan con `presupuestoMs` en la
  magnitud que declare quien mide (en `app.ts`: RSS en MiB y bytes en cola),
  como pide el contrato de esta tarea; con la configuración por defecto eso
  no afecta a ninguna decisión.
- El panel del cliente que muestra este estado es T165; aquí solo viaja el
  dato en `performance.gobernador`.
