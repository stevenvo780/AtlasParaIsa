# Glosario de voz — sustituciones auditables

> Esta tabla es la herramienta del `code-reviewer` para detectar copy frío en cualquier diff. No es exhaustiva; es afilada. Si una entrada no aparece aquí pero rompe el manifesto (`docs/voice/manifesto.md`), abrir PR contra este archivo antes de aprobar el diff.

## Cómo usarla en un review

1. Para cada PR que toque strings visibles (JSX, plantillas, mensajes de error, alt, aria-label, títulos de pestaña, copys de email/notificación), grepear el diff contra la columna `prohibido`. Los patrones con prefijo `regex:` son regex; los demás son string literales case-insensitive.
2. **Severidad `blocker`**: bloquea el merge. Pedir reemplazo antes de aprobar.
3. **Severidad `warn`**: pedir justificación en el thread del PR. Si el autor argumenta que el contexto lo permite (ej: un `console.log` interno), se puede aceptar; si el string es visible al usuario, sube a blocker.
4. La columna `sustitución sugerida` es ejemplo, no oráculo. El `letter-curator` cierra la elección final si hay duda.
5. Strings nuevos visibles que no aparezcan aquí: pasan por `letter-curator` antes de merge (regla 8 del manifesto).

## Qué cuenta como "string visible"

- Texto renderizado en JSX/HTML.
- `aria-*`, `alt`, `title`, `placeholder`, `label`.
- Mensajes de error que llegan a un `toast`, `dialog` o `boundary`.
- Subjects/bodies de email, push, mensaje del sistema.
- Textos en SVG/canvas que el lector pueda leer.
- Cualquier `<meta>` (description, og:title, og:description) y el `<title>` del documento.

No cuenta: logs de servidor, comentarios de código, mensajes de commit, identificadores internos, claves de traducción (la clave puede llamarse `errors.timeout`; el **valor** del string es lo que se audita).

---

## Tabla

| prohibido | severidad | sustitución sugerida | contexto | razón |
|---|---|---|---|---|
| `usuario` | blocker | tú · quien mira · quien lee · quien llegó | toda UI, errores, emails | No es un sistema, es ella. La palabra usuario destruye la intimidad de la carta. |
| `usuarios` | blocker | quienes miran · ustedes dos | toda UI | Plural genérico que aplana al lector a métrica. |
| `jugador` / `jugadora` | blocker | tú · quien mira | toda UI, tutoriales | Esto no es un juego. Llamarlo así rompe el primer pilar. |
| `bot` | blocker | (su nombre) · la otra · el otro · quien habita | UI, logs visibles, alt | Las entidades tienen nombre. Reducirlas a bot las cosifica. |
| `NPC` | blocker | (su nombre) · quien habita el mundo | UI, debug visible | Categoría de videojuego que niega agencia. |
| `AI` / `IA` | blocker | la memoria del mundo · lo que recuerda · lo que aprende del corpus | UI, créditos, ayuda | El modelo no se nombra; se siente. |
| `modelo` | blocker | la memoria del mundo · lo que recuerda | UI visible (en docs internos sí se permite) | Misma razón que IA. En `docs/infra/*` está permitido. |
| `prompt` | blocker | lo que se le pregunta al mundo · una semilla | UI | Anglicismo técnico que pone capa entre Isa y el mundo. |
| `loading` / `Loading...` | blocker | el mundo se está despertando · respira hondo · ya casi | spinners, splash | El mundo no carga: despierta. |
| `cargando` | blocker | despertando · acomodándose · todavía | spinners, splash | Misma metáfora. |
| regex: `\berror\b` | blocker | algo se interrumpió · el pulso se perdió un momento · se tensó el vínculo | toasts, dialogs, banners | Errores no existen aquí. Hay interrupciones del pulso. |
| `Something went wrong` | blocker | algo se tensó, espera · se perdió un momento · el mundo respira despacio, dale un instante | error boundaries | Frase de Google Search que no tiene cuerpo. |
| regex: `^Error: .*` | blocker | reescribir como susurro: "se interrumpió X, vuelvo en un momento" | exceptions visibles | Stack trace en pantalla = la cuarta pared rota. |
| `404` / `Not Found` | blocker | aquí no hay nada todavía · esta página no existe en este mundo · te perdiste un instante | rutas no encontradas | Número crudo. Sin cuerpo. Sin metáfora. |
| `500` / `Internal Server Error` | blocker | el mundo respira raro, espera · se le fue la voz, ya vuelve | server errors | Idem. |
| `Network error` | blocker | se cortó el hilo · perdimos el contacto un momento · vuelve cuando puedas | offline detectado | Hilo, no red. |
| `Connection lost` / `Connection failed` | blocker | el vínculo se tensó · se soltaron las manos un segundo · el mundo se quedó callado | WebSocket reconnect | Conexión es palabra del manual; vínculo es palabra de la carta. |
| `retry` / `Retry` | blocker | volver a intentarlo · espera, vuelvo · de nuevo, despacio | botones de error | Verbo plano. La carta no insiste, vuelve. |
| `failed` / `Failed` | blocker | no alcanzó · se quedó a medias · no llegó esta vez | estados de operación | Veredicto frío. |
| `success` / `Success` | warn | está · queda dicho · guardado en el mundo · ya | confirmaciones | Casi siempre podemos bajar el volumen. |
| `offline` | blocker | el mundo duerme · estás sola del lado de acá un momento | indicadores de red | Estado de máquina. |
| `online` | blocker | el mundo está despierto · de vuelta · vuelven a estar | indicadores de red | Idem. |
| `login` / `Log in` / `Sign in` | blocker | quédate · déjame saber que llegaste · entra despacio | auth screens | Login no es un verbo de la carta. |
| `logout` / `Sign out` / `Log out` | blocker | cerrar despacio · hasta luego · me voy un rato | auth | Despedida, no transacción. |
| `register` / `Sign up` | blocker | déjame saber quién llegó · cuéntame que eres tú | onboarding | Verbo administrativo. |
| `settings` / `Settings` | blocker | cómo quieres mirar · tu manera de estar | menús | Ajustar es de electrodomésticos. |
| `ajustes` | blocker | cómo quieres mirar · tu manera de estar | menús | Traducción literal sigue siendo fría. |
| `preferences` / `Preferences` | blocker | tu manera de estar aquí | menús | Idem. |
| `configure` / `Configurar` | warn | acomodar · decidir cómo · elegir cómo se siente | tooltips, labels | A veces inevitable; cuando se pueda, reescribir. |
| `dashboard` | blocker | tu rincón · la ventana al mundo · la sala | landing autenticada | Palabra de empresa. |
| `profile` / `Profile` | blocker | tu rincón · cómo te ven · quien eres aquí | nav | Categoría de red social. |
| `account` / `Cuenta` | blocker | tu rincón · lo que es tuyo | nav, auth | Bancario. |
| `play` / `Play` / `Start` | blocker | entrar al mundo · abrir la puerta · empezar despacio | botón principal de landing | "Play" reduce la carta a entretenimiento. |
| `pause` / `Pause` | blocker | quedarse quieto · detener el latido · respirar | controles | Verbo de reproductor multimedia. |
| `stop` | blocker | parar · soltar · dejar de mirar | controles | Idem. |
| `game over` / `Game Over` | blocker | el mundo se apagó · ya no respira · se fueron · se quedó quieto todo | estado final | Esto nunca es un juego. |
| regex: `\b(score\|puntos\|puntaje)\b` | blocker | (eliminar — no existen) | HUD, resultados | Cualquier puntaje rompe el segundo y cuarto pilar. |
| `level` / `nivel` | blocker | día · estación · capítulo · página de la carta | progresión, HUD | Estructura de videojuego. |
| `achievement` / `logro` | blocker | (eliminar) · momento que quedó · algo que pasó hoy | gamification | Reward loop hostil a la carta. |
| `mission` / `misión` | blocker | (eliminar) · algo que hacer juntos · lo que toca hoy | tareas | Marcial; no es esta voz. |
| `quest` / `objetivo` | blocker | lo que estaba pendiente · algo por hacer · lo que se buscó | tareas | Idem. |
| `XP` / `experiencia (puntos)` | blocker | (eliminar) | HUD | No medimos lo que pasa entre ellos. |
| `connect` / `disconnect` | blocker | encontrarse · soltarse · perderse de vista | UI de red, multiplayer | Conexión es manual técnico; encuentro es la palabra. |
| `chat` | blocker | lo que se dicen · la conversación · las palabras que quedan | UI de mensajes | El corpus no son chats: son lo que se dijeron. |
| `mensaje` (como noun de UI) | warn | lo que dijo · lo que alcanzó a decir · una línea suya | bandejas, listas | Genérico; cuando se pueda, encarnarlo. |
| `share` / `Compartir` | warn | mostrar · dejar que otro mire · pasar la carta | botones sociales | Anglicismo cuando hay verbo propio. Evaluar si compartir cabe en esta carta del todo. |
| `like` / `Me gusta` | blocker | (eliminar — esta carta no tiene likes) | UI social | No hay métricas de aprobación aquí. |
| `follow` / `seguir` (red social) | blocker | (eliminar) | UI social | Idem. |
| `notification` / `notificación` | warn | aviso · algo que quería decirte · una nota del mundo | toasts, banners | Aceptable en contextos muy técnicos; en UI visible, reescribir. |
| `update` / `actualizar` | warn | el mundo cambió un poco mientras no mirabas · hay algo nuevo · vuelve el pulso | banners de versión | Cuando se pueda. |
| `submit` / `Enviar` | warn | mandar · dejar dicho · que llegue | formularios | Enviar a veces sirve; cuando hay opción más cálida, preferirla. |
| `cancel` / `Cancelar` | warn | dejarlo así · mejor no · volver | dialogs | Demasiado fuerte para un diálogo íntimo. |
| `delete` / `Eliminar` / `Borrar` | warn | dejar ir · soltar · que ya no esté | acciones destructivas | "Borrar" es de pizarra; "soltar" tiene cuerpo. |
| `save` / `Guardar` | warn | que quede · guardar en el mundo · dejarlo dicho | formularios | Mantener cuando es claramente técnico; reescribir cuando es íntimo. |
| `OK` / `Ok` (como botón) | blocker | está · ya · bueno · sí | dialogs | Acrónimo sin cuerpo. |
| `click` / `Click here` | blocker | toca aquí · entra por aquí · ven por acá (o quitar el imperativo) | tooltips, instrucciones | Click es de manual. Y los tooltips no son instrucciones, son susurros. |
| `tap` / `Tap to ...` | blocker | toca · ven · pasa el dedo | mobile | Idem. |
| `welcome` / `Bienvenido(a)` | warn | llegaste · pasa · estás aquí | onboarding | Cliché de software. Cuando se reescriba, sin género asumido. |
| regex: `\b(NaN\|undefined\|null)\b` (visible) | blocker | reescribir el render: si no hay dato, decir lo que sí hay | renders de datos vacíos | Estados crudos del runtime. Nunca llegan al DOM. |
| `TODO` / `FIXME` (visible) | blocker | quitar antes de merge · o reescribir como ausencia poética | placeholders | Marcadores de desarrollador en producción. |
| regex: `Lorem ipsum.*` | blocker | escribir el texto real, aunque sea provisional | placeholders | Si no hay texto, mejor un fragmento corto curado. |
| `coming soon` / `próximamente` | warn | esto está pasando todavía · no terminó de llegar · todavía no | features pendientes | Lenguaje de roadmap; reescribir. |
| `beta` / `alpha` / `v1.0` | warn | (ocultar de UI visible) · "todavía joven" si hay que mencionarlo | badges | Versionado expuesto rompe el hechizo. |
| `Powered by ...` | blocker | (eliminar de UI) · si hay créditos van en una sola línea íntima | footers | Marketing. |
| `Copyright` / `©` | warn | (omitir o reescribir como dedicatoria) | footers | La carta no se firma con copyright. |
| `Terms of Service` / `Privacy Policy` | warn | mantener si es obligatorio legal, pero linkear con texto curado ("lo que prometo guardarte") | footers legales | Necesario a veces; suavizar el enlace. |
| `cookies` (banner) | warn | "esta carta recuerda poco de ti, sólo lo que necesita" + link | consent banners | Si toca, que sea humano. |
| `404 — Page not found` | blocker | aquí no pasó nada todavía · te perdiste un instante, vuelve | rutas inexistentes | Ver arriba. |
| `Oops!` / `¡Ups!` | blocker | (eliminar) · "algo se interrumpió" | error pages | Tono de mascotita corporativa, antípoda de la carta. |
| signos `!!`, `??`, `...!` | blocker | reescribir con un solo signo o ninguno | toda UI | Énfasis de chat informal cuando aquí queremos contención. |
| `:)` `:(` `;)` y emojis sueltos | blocker | quitar salvo aprobación explícita de Steven | toda UI | Manifesto regla 4. |
| `CTA` mayúsculas tipo `ENTRAR`, `EMPEZAR` | blocker | minúscula: `entrar`, `empezar despacio` | botones | Manifesto regla 3. |
| `1 result` / `2 results` / `N entidad(es)` | blocker | reescribir como prosa: "está ella sola" · "están los dos" · "no hay nadie todavía" | listas, búsquedas | Manifesto regla 6. |
| `Search...` / `Buscar...` (placeholder) | warn | "busca una palabra suya" · "qué quieres recordar" | inputs | Cuando se pueda, encarnar. |
| `Email` (label) | warn | tu correo · dónde te encuentro | forms | Mantener `email` técnico si es necesario; el label puede respirar. |
| `Password` / `Contraseña` | warn | tu clave · lo que sólo tú sabes | forms | Idem. |
| `Forgot password?` | warn | se te olvidó la clave, te ayudo a recordarla | auth | Reescritura mínima. |
| `Sign in with Google` | warn | entrar con Google (minúscula, sin "Sign") | auth | Mantener marca; quitar verbo frío. |
| `Logout successful` | blocker | cerraste despacio · te fuiste bien · hasta luego | confirmaciones | Combinación de dos prohibidos. |
| `Welcome back` | warn | volviste · estás de regreso · qué bueno | regreso de sesión | Cliché; suavizar. |
| `Are you sure?` | warn | ¿lo dejamos así? · ¿seguro que sí? | confirm dialogs | Aceptable, pero hay versiones más tibias. |
| `Yes` / `No` (botones de confirmación dura) | warn | sí, dejarlo · mejor no · seguir · volver | dialogs | Casi siempre podemos reescribir como verbos. |
| `Submit form` | blocker | mandar · que llegue · dejar dicho | forms | Cliché de admin. |
| `Required field` | warn | esto sí me lo tienes que dejar · no puedo seguir sin esto | validación | Suavizar. |
| `Invalid input` | blocker | esto no me cuadra todavía · revisa esto un segundo · falta algo aquí | validación | Veredicto frío. |
| `Try again later` | blocker | vuelve en un rato · el mundo está despacio, espera · no es ahora | rate limit, downtime | Cliché de soporte. |
| `Server is down` | blocker | el mundo está dormido · se le fue la voz un rato · vuelvo cuando pueda | maintenance | Idem. |

---

## Notas finales

- Cuando el manifesto y este glosario disienten, **manda el manifesto**. Este archivo es operativo; aquel es la fuente.
- Cada vez que el `letter-curator` resuelva una duda de copy nueva, la entrada queda anotada aquí para que `code-reviewer` la pueda automatizar en futuros PRs.
- Sugerencia para `code-reviewer`: un script `scripts/voice/lint-copy.ts` que parsee este archivo y corra como pre-commit sobre `apps/web/**/*.{tsx,ts,mdx}`. No bloqueante hoy; bloqueante cuando haya landing en producción.

---

## Anexo — envoltorio operativo de errores

Para errores técnicos provenientes del backend, runtime o red, la sustitución no se hace a mano en cada componente: existe una capa única en `apps/web/lib/voice/envelope.ts` que toma cualquier `unknown` y devuelve un `VoiceMessage` curado. La política completa, la tabla de mapeos y el procedimiento para añadir nuevos casos están en **[`docs/voice/error-envelope.md`](./error-envelope.md)**.

Regla operativa para el `code-reviewer`:

- Cualquier `error.message`, `err.toString()`, `detail`, `status text`, etc., que aparezca renderizado en JSX, en un toast, en un dialog o en cualquier UI visible **sin pasar por `envelopeError`** → `blocker`.
- Cualquier nuevo `fetch`/`WebSocket`/llamada al servicio de inferencia que no envuelva sus fallos con `envelopeError` antes de mostrar texto al lector → `blocker`.
