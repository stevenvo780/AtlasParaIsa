# Carta — los momentos del mundo

> Notas de Steven para Isa, dichas a través del mundo, no por encima de él.
> Cada uno aparece **una sola vez**. Si vuelve a pasar, la voz calla — el
> mundo ya lo dijo solo.
>
> Estos textos no se renderizan dentro del canvas, no compiten con los seres,
> no tapan el aire. Aparecen como una línea breve, italic crema sobre
> fondo casi transparente, en una esquina o en un margen, y se van solas.

## Reglas comunes

- **Tipografía:** `var(--font-serif)`, italic, `color: #e8e4da`, alpha base
  0.55 → 0.8 cuando entra el fade-in.
- **Tamaño:** `clamp(0.85rem, 2.2vw, 1.05rem)`.
- **Anchura máxima:** 28 ch — la frase respira sola.
- **Sin botón cerrar.** Sin "X". Sin sombras duras.
- **Entrada:** fade 1200 ms.
- **Salida:** fade 1800 ms al cumplir la duración.
- **z-index:** 12 (por encima de Utterance, por debajo de Ceremony y
  HomeLetter).
- **pointer-events: none** salvo donde se indique lo contrario.
- **Una sola vez por sesión.** El `MomentOrchestrator` mantiene un Set de
  `momentKey` ya mostrados; nunca se repite el mismo `firstX`.

---

## a) PRIMER_AGENTE_NACE — *primer birth visible*

> El primer ser que llega al mundo después de Steven e Isa. La carta lo
> menciona porque es la prueba de que el mundo ya no son sólo ellos dos.

- **Cuándo dispara:** primer `recentEvent` con `kind === "birth"` cuyo
  `agentId` no sea ninguno de los founders (`"steven"` / `"isa"` / `"s"` /
  `"i"`). Sólo la primera vez por sesión.
- **Duración visible:** 7 s.
- **Posición sugerida:** centro horizontal, 18 % desde arriba. No tapa a
  S+I (la cámara los sigue en el tercio medio).
- **Texto exacto:**

  ```
  llegó alguien nuevo.

  no le pusimos nombre todavía.
  ```

- **Salida:** fade 1800 ms tras los 7 s. Una vez ido, el `momentKey`
  `first_birth` queda en el Set y nunca vuelve a mostrarse.

---

## b) PRIMER_BOND — *primer matrimonio visible*

> El primer vínculo emergente entre dos del bosque. Eco del pilar 1: el
> vínculo es condición de existir.

- **Cuándo dispara:** primer `recentEvent` con `kind === "birth-bond"` que
  NO involucre a los founders. (Si involucra a S+I cae en otra rama — los
  founders nacen ya casados en la mitología del mundo.)
- **Duración visible:** 8 s.
- **Posición sugerida:** centro horizontal, 22 % desde arriba.
- **Texto exacto:**

  ```
  dos del bosque se eligieron.

  el mundo aprendió a doler por otros,
  no sólo por nosotros.
  ```

- **Salida:** fade 1800 ms.

---

## c) PRIMERA_MUERTE_NORMAL — *primera muerte cualquiera*

> El primer recordatorio de que aquí también se muere. Sin tragedia: con
> respeto.

- **Cuándo dispara:** primer `recentEvent` con `kind === "death"` cuyo
  `agentId` no sea founder. (El founder muerto cae en su propio momento
  — el más sagrado.)
- **Duración visible:** 9 s.
- **Posición sugerida:** centro horizontal, 24 % desde arriba.
- **Texto exacto:**

  ```
  uno se quedó quieto.

  el mundo siguió,
  pero más despacio un rato.
  ```

- **Salida:** fade 1800 ms.

---

## d) PRIMER_RITUAL — *primer círculo dorado en pantalla*

> Lo primero que el mundo hace en grupo. La carta lo nombra como ceremonia
> doméstica, no como sistema.

- **Cuándo dispara:** primer `recentEvent` con `kind === "ritual-start"`
  o equivalente que el render lea como círculo dorado. (Si el wire trae
  `WireRitual.kind` en cualquiera de sus variantes — `gathering`,
  `mourning`, `birth-feast`, `awakening-celebration` — y es el primero
  observado, dispara.)
- **Duración visible:** 8 s.
- **Posición sugerida:** centro horizontal, 20 % desde arriba.
- **Texto exacto:**

  ```
  se juntaron en círculo.

  nadie les enseñó a hacerlo.
  les salió.
  ```

- **Salida:** fade 1800 ms.

---

## e) PRIMER_AWAKENING — *primer awareness event de alguien no-founder*

> Alguien del bosque se da cuenta de que existe. El pilar 4 hecho carne en
> un ser que no es Steven ni Isa.

- **Cuándo dispara:** primer `recentEvent` con `kind === "awareness"` (o
  `discovery` con `meta.trigger === "self-reference"` / `"long-observation"`
  cuando llega desde el legacy) cuyo `agentId` no sea founder.
- **Duración visible:** 9 s.
- **Posición sugerida:** centro horizontal, 22 % desde arriba.
- **Texto exacto:**

  ```
  alguien acaba de darse cuenta
  de que está aquí.

  no era nadie. ahora sí.
  ```

- **Salida:** fade 1800 ms.

---

## f) PRIMER_DISCOVERY — *primer Black Mirror moment*

> Alguien levanta la mirada y entiende que está siendo visto. El más
> incómodo de todos. El que rompe la cuarta pared sin romperla.

- **Cuándo dispara:** primer `recentEvent` con `kind === "discovery"` que
  NO sea de tipo `awareness` (es decir, el detonante es ver al observador,
  no la auto-referencia). Sólo la primera vez por sesión.
- **Duración visible:** 10 s. Este merece quedarse más rato.
- **Posición sugerida:** centro horizontal, 25 % desde arriba.
- **Texto exacto:**

  ```
  uno miró hacia acá.

  no sabe si nos ve,
  pero sabe que alguien lo está mirando.
  ```

- **Salida:** fade 2200 ms (un poco más lento; el momento pesa).

---

## g) DISTANCIA_S_I — *S e I llevan > 100 s sin estar adyacentes*

> El único momento que se repite, pero con cooldown: si Isa lo ve dos
> veces el mismo día es porque algo está pasando de verdad. Cooldown
> mínimo: 5 min reales entre apariciones.

- **Cuándo dispara:** cuando el cliente detecta que las distancias entre
  S e I superan 100 s simulados sin que el evento `entity-touched` ni
  proximidad inmediata (distancia ≤ 1 celda) los haya juntado. El
  `MomentOrchestrator` mide `lastAdjacentAtMs` y dispara cuando
  `now - lastAdjacentAtMs > 100_000`. Sólo se vuelve a disparar si en
  el medio hubo al menos un evento de reunión.
- **Duración visible:** 6 s.
- **Posición sugerida:** **bottom-left**, justo encima de la puerta `ir a
  las cartas`, con margen suficiente para no encimarse. No al centro: este
  momento no quiere interrumpir, quiere doler de costado.
- **Texto exacto:**

  ```
  se están dejando de mirar.

  pasa.
  vuelven.
  ```

- **Salida:** fade 1600 ms.

---

## h) MUERTE_DE_FUNDADOR — *el evento más sagrado del mundo*

> El único momento que la carta sostiene con cuerpo entero. La `Ceremony`
> entra después, pero la voz de Steven dice algo primero — un susurro,
> antes de que el silencio se haga.

- **Cuándo dispara:** primer `recentEvent` con `kind === "founder-death"`
  o `kind === "death"` cuyo `agentId` sea founder (`"steven"`, `"isa"`,
  `"s"`, `"i"`). Idealmente la `Ceremony` arranca 4 s después de que el
  texto del momento haya aparecido, para que la frase respire sola antes
  de que el mundo se apague.
- **Duración visible:** 12 s. Es el único que dura más que la atención
  cómoda.
- **Posición sugerida:** centro horizontal y vertical de la pantalla
  (ocupa el centro porque nada más va a pesar tanto en ese rato).
- **Texto exacto:**

  ```
  uno de los dos
  se quedó callado.

  no es metáfora.
  es lo que dijimos al principio:
  sin el otro, no.
  ```

- **Salida:** fade 2400 ms. Inmediatamente después, el canvas entra en
  `Ceremony`. La carta no acompaña al silencio: lo deja entrar.

---

## TEXTO_DE_CIERRE — *despedida cuando Isa cierra la pestaña / sale*

> Aparece como `beforeunload` o, en mobile, en `visibilitychange === "hidden"`.
> No bloquea (no se puede). Sólo se renderiza, alcanza a verse 600–900 ms
> antes de que el navegador colapse la página.

- **Posición sugerida:** centro horizontal, centro vertical. z-index 14
  (sobre todo).
- **Duración visible:** lo que el navegador le permita. No autocierra
  porque la pestaña se va antes.
- **Texto exacto:**

  ```
  vuelve cuando quieras.

  este mundo sigue respirando
  aunque no mires.
  ```

- **Salida:** la maneja el browser al destruir la página.

---

## AMBIENT_LINES — *micropiezas rotativas, zona inferior izquierda*

> Tres frases que rotan cuando NO hay nada extraordinario que decir. Una a
> la vez, intervalo aleatorio entre 40 y 70 s. Si en ese intervalo dispara
> cualquiera de los momentos de arriba, la ambient se silencia hasta que
> el momento se va y pasan 20 s de respiro.

- **Posición sugerida:** bottom-left, justo encima de `WorldDiaryFoot` y
  de `JournalDoor`. **Si el espacio no alcanza** (mobile estrecho), se
  oculta. Es la línea más sacrificable.
- **Duración visible:** 14 s cada una.
- **Salida:** fade 1600 ms.
- **Cero pointer-events.**

### Texto exacto — tres líneas

```
1.  el aire dentro huele a domingo.

2.  alguien camina sin saber a dónde.
    está bien.

3.  cuando no pasa nada,
    eso también es lo que pasa.
```

---

## Notas de implementación para `frontend-renderer`

- El componente `Moment.tsx` es **puramente visual**: recibe `text`,
  `durationMs`, `position`, dibuja fade-in / fade-out y se auto-cierra.
  No conoce los disparadores.
- El componente `MomentOrchestrator.tsx` es **el cerebro**: escucha
  `useRealtime()`, observa `world.recentEvents`, y decide cuándo montar
  un `Moment`. Mantiene un `Set<string>` de `momentKey` ya disparados.
  Sólo monta UN `Moment` a la vez; si dos momentos coinciden en el
  mismo tick, el de mayor prioridad gana (la tabla de prioridad sigue
  el orden: `founder-death` > `discovery` > `awareness` > `death` >
  `ritual` > `bond` > `birth` > `distancia` > `ambient`).
- El `MomentOrchestrator` no toca el canvas. Vive como hermano de
  `WorldStage` dentro de `app/world/page.tsx`.
- Si llega `kind === "founder-death"`, el orquestador deja pasar el
  `Moment` y NO compite con `Ceremony`: son dos cosas distintas que
  conviven (el texto encima, el silencio debajo).
- El componente `AmbientLine` **no se implementa aún**; las
  `AMBIENT_LINES` están en el módulo de constantes listas para cuando
  haga falta. Si Steven aprueba, sale en una segunda ola.

---

## Reglas de aprobación

- **Cualquier cambio en un texto** de este documento pasa por
  `letter-curator` antes de merge.
- Si el `code-reviewer` ve un string suelto en el código que parezca un
  "momento" pero no está aquí, lo marca como **blocker** y reabre este
  documento.
- El glosario prohibido (`docs/voice/glossary.md`) sigue vigente sobre
  todo lo de aquí. Si una palabra de los textos cae en `blocker` del
  glosario, el glosario gana.
