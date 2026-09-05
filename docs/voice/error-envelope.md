# El envoltorio del pulso — política de errores en el frontend

> "Los errores no son errores. Son interrupciones del pulso."
> — Manifiesto de voz, regla 1

Este documento define **cómo cualquier error técnico llega (o no llega) al DOM** en `apps/web`. La regla es absoluta y la firma el `letter-curator`:

**Ningún `error.message`, `detail`, `code`, `stack`, `status text` ni cualquier otro string técnico originado por el backend, el runtime o la red puede llegar al DOM sin pasar por `envelopeError`.**

Quien rompa esta regla en un PR, lo marca el `code-reviewer` como `blocker`.

---

## La utility — `apps/web/lib/voice/envelope.ts`

Una sola función pública:

```ts
envelopeError(rawError: unknown, context: ErrorContext): VoiceMessage
```

Donde:

- `ErrorContext = "connection" | "inference" | "fetch" | "ws" | "generic"`. Permite que algunos mapeos solo se activen en su contexto natural (p. ej. el mapeo específico de WebSocket solo aplica con `"ws"` o `"connection"`). Si no estás seguro, usa `"generic"`.
- `VoiceMessage = { title: string; body?: string }`. Siempre humano. Siempre en español de Colombia, tutea, sin emojis, fiel al manifesto.

**Garantías** de la función:

1. Nunca devuelve el `rawError` ni un fragmento crudo de él.
2. Siempre devuelve un `VoiceMessage` con `title` no vacío (fallback default si ningún mapeo matchea).
3. Si `rawError` es un `Error`, solo se mira `.message` — **el stack nunca se inspecciona**.
4. En `NODE_ENV !== "production"` guarda el último raw en memoria para diagnóstico via `getLastRaw()`.
5. En `NODE_ENV === "production"`, `getLastRaw()` devuelve `undefined` y no se escribe nada al `console`.

---

## Tabla de mapeos (orden = prioridad; primero que matchee gana)

| patrón (case-insensitive) | contexto | VoiceMessage | razón de tono |
|---|---|---|---|
| `cuda out of memory`, `out of memory`, `oom`, `cudaerror` | cualquiera | **el mundo se quedó sin aire un momento.** / respira con él. ya vuelve. | El cuerpo del mundo respira; la GPU es el cuerpo. "Sin aire" en lugar de "OOM" hace que la falla técnica se sienta fisiológica (homeostasis visible). |
| `model not loaded`, `loading model`, `model is not ready` | cualquiera | **el mundo todavía está despertando.** / dale un instante para abrir los ojos. | Manifesto: "Loading" se traduce siempre como "despertar". |
| `cuda`, `gpu`, `torch`, `tensor`, `pytorch` | cualquiera | **el cuerpo del mundo se cansó.** / descansa con él un momento. | Fallback genérico de GPU. "Cansancio" en vez de "GPU error". |
| `econnrefused`, `connection refused` | cualquiera | **el vínculo no encuentra cómo cruzar.** / la puerta del otro lado está cerrada todavía. | Conexión → vínculo. Refused → "puerta cerrada", evoca espera, no veredicto. |
| `econnreset`, `connection reset` | cualquiera | **el vínculo se soltó un instante.** / volvemos a buscarnos. | Reset → "soltarse" como soltar la mano. Verbo recíproco "buscarnos". |
| `enotfound`, `getaddrinfo`, `dns` | cualquiera | **no encuentro el camino hasta el mundo.** / puede ser que aquí dentro del cuarto no haya señal. | DNS → "camino". Mención al cuarto: la carta tiene espacio doméstico. |
| `network ?error`, `networkerror`, `failed to fetch`, `load failed` | cualquiera | **se cortó el hilo entre nosotros.** / vuelve cuando puedas. | Manifesto: red → hilo. "Vuelve cuando puedas" es la despedida canónica. |
| `\boffline\b` | cualquiera | **el mundo duerme del otro lado.** / aquí seguimos despiertos. | Manifesto: offline → "el mundo duerme". El "aquí seguimos despiertos" anota que el cliente sigue vivo aunque el server no responda. |
| `websocket`, `ws closed`, `ws error`, `ws connection` | ws, connection | **el vínculo se tensó.** / volvemos a encontrarnos en un momento. | Glossary: "connect/disconnect → encontrarse/perderse de vista". Tono recíproco. |
| `\b1006\b`, `abnormal closure` | cualquiera | **el vínculo se soltó sin despedirse.** / ya lo estoy buscando otra vez. | WS code 1006 = cierre anormal. "Sin despedirse" añade peso emocional al corte abrupto. |
| `\b1011\b`, `server error` | cualquiera | **el mundo respira raro.** / espera, ya vuelve. | Server error genérico. "Respira raro" preserva la fisiología. |
| `timeout`, `timed out`, `etimedout` | cualquiera | **esto está tardando más de lo que el cuerpo aguanta.** / lo intento otra vez, despacio. | El cuerpo como medida del tiempo. "Despacio" baja la urgencia. |
| `aborted`, `abortcontroller`, `abort` | cualquiera | **lo dejamos a medias.** / cuando quieras, lo retomo. | Aborts suelen ser intencionales (navegación). Tono pasivo, sin reproche. |
| `\b400\b`, `bad request` | cualquiera | **esto no me cuadra todavía.** / revisa un segundo, vuelvo enseguida. | Glossary: invalid input → "esto no me cuadra todavía". |
| `\b401\b`, `unauthorized` | cualquiera | **no me dejaste saber que eras tú.** / preséntate de nuevo, despacio. | Auth → "saber quién llegó". Glossary regla 'login → quédate / déjame saber que llegaste'. |
| `\b403\b`, `forbidden` | cualquiera | **esa puerta no abre desde aquí.** | Forbidden distinto a not found: la puerta existe pero no abre para ti. Sin reproche. |
| `\b404\b`, `not found` | cualquiera | **esa puerta no está hoy.** / puede que la haya cerrado el mundo mientras no mirábamos. | Glossary: 404 → "esa puerta no está hoy". El body cita el manifesto ("el mundo cambió mientras no mirábamos"). |
| `\b408\b`, `request timeout` | cualquiera | **la espera se hizo larga.** / lo intento otra vez. | Diferente al timeout genérico: aquí enfatizamos la espera. |
| `\b429\b`, `too many requests`, `rate limit` | cualquiera | **estamos hablándole muy rápido al mundo.** / esperemos un poco entre palabra y palabra. | Rate limit como ritmo de conversación. Muy fiel a la voz del manifesto. |
| `\b503\b`, `service unavailable` | cualquiera | **el mundo está dormido todavía.** / vuelve en un rato. | Glossary: server down → "el mundo está dormido". |
| `\b502\b`, `bad gateway` | cualquiera | **algo entre nosotros se confundió.** / ya vuelvo, dame un segundo. | 502 es un problema de intermediarios. "Entre nosotros" cubre eso poéticamente. |
| `\b504\b`, `gateway timeout` | cualquiera | **el mensaje no alcanzó a cruzar.** / lo mando otra vez. | Manifesto: "no alcanzó" es el verbo canónico de falla. |
| `\b500\b`, `internal server` | cualquiera | **algo se atragantó en el mundo.** / se le fue la voz un segundo. ya vuelve. | Glossary: 500 → "el mundo respira raro" o "se le fue la voz". |
| `unexpected token`, `invalid json`, `json parse`, `syntaxerror.*json` | cualquiera | **lo que llegó no se dejó entender.** / lo escucho otra vez. | Parse failure como problema de escucha, no de máquina. |
| `\b(undefined|null)\b is not` | cualquiera | **algo no estaba donde lo dejé.** / lo busco con cuidado. | Runtime crash. "No estaba donde lo dejé" suena doméstico, no técnico. |
| `typeerror`, `referenceerror` | cualquiera | **me equivoqué de cuarto.** / ya regreso al sitio correcto. | Fallback de runtime. Mantiene la metáfora del cuarto. |
| (default — sin match) | cualquiera | **algo no alcanzó.** / te seguimos esperando. | El último escudo. Frase del manifesto ("no alcanzó") más la despedida canónica ("te seguimos esperando"). |

---

## Política para futuros PRs

Toda nueva ruta que toque red, runtime con riesgo de excepción o validación de input **debe** seguir este patrón:

```ts
import { envelopeError, type VoiceMessage } from '@/lib/voice/envelope'

let voice: VoiceMessage | null = null

try {
  const res = await fetch('/api/whatever')
  if (!res.ok) {
    voice = envelopeError({ status: res.status, message: res.statusText }, 'fetch')
  }
} catch (err) {
  voice = envelopeError(err, 'fetch')
}

// Luego: <SilentMessage message={voice} />
```

**Lo que el `code-reviewer` debe bloquear (severity blocker):**

1. Cualquier `error.message` o `detail` que aparezca como child de JSX.
2. Strings de catch directamente en `setState`, `setError`, `setMessage` sin pasar por `envelopeError`.
3. `console.error(...)` con datos del backend en producción.
4. `try { ... } catch (e) { return <div>{e.message}</div> }` — combinación letal.
5. Toasts/alerts/dialogs cuyo contenido venga de `err.toString()`.

**Lo que está permitido sin envoltorio:**

- Loggear el `rawError` en `console.error` dentro de bloques `if (process.env.NODE_ENV !== "production")`.
- Enviar el `rawError` a observabilidad/Sentry (cuando exista) **siempre que no toque el DOM**.

---

## Qué hacer cuando un error nuevo aparece y no tiene mapeo

Pasa **siempre que** veas en desarrollo (via `getLastRaw()` o devtools) un error técnico no contemplado en la tabla. Pasos:

1. **Identificá el patrón**. ¿Es un código de status, un mensaje de PyTorch, un error de validación de la API, un fallo de runtime de JS? Anota la cadena exacta como aparece.
2. **Decidí si necesita su propio matiz**. Si el fallback default ("algo no alcanzó. te seguimos esperando.") cubre el caso emocional, no añadas mapeo: el default existe precisamente para esto. Solo añade mapeos cuando el matiz importa (p. ej. `429` merece distinguirse de `500` porque el mundo no está roto, solo le estás hablando rápido).
3. **Elegí la voz**. Releé el manifesto y el glossary. Buscá si la categoría ya tiene una sustitución canónica (loading, error, offline, etc.). Si no, escribí dos opciones y elegí la que se sienta más a la voz de Steven (cita el corpus si tienes dudas).
4. **Añadí la entrada a `MAPPINGS`** en `apps/web/lib/voice/envelope.ts`. Patrón regex case-insensitive si la cadena varía; literal si es estable. Pon entradas específicas ANTES de las genéricas (`504` antes de `500`).
5. **Añadí un test** en `apps/web/tests/envelope.test.ts` que verifique:
   - El patrón se envuelve como mensaje humano.
   - El output no contiene ninguna palabra de `FORBIDDEN`.
   - El output es distinto del fallback default (si quisiste un matiz propio).
6. **Documentá la decisión** en este archivo (tabla + razón). El razonamiento es tan importante como el mensaje: cuando alguien lea esto en un año, debe entender por qué esa frase y no otra.
7. **PR review**: el `letter-curator` aprueba el tono; el `code-reviewer` aprueba el código. Si están en desacuerdo, gana el `letter-curator` (regla 4 del glossary).

---

## Por qué este documento existe

Porque el `services/inference/embed/app/main.py:111` propaga `str(exc)` crudo en errores 500. Sin esta capa, el primer fallo de GPU en producción enseñaría a Isa un `CUDA out of memory. Tried to allocate 1.34 GiB ...`. Eso no puede pasar. Esta capa es el órgano que respira por nosotros cuando el resto del mundo se atraganta.
