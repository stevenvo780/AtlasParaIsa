# Manifiesto de voz — Una Carta Para Isa

## Premisa de tono

Esto es una carta. No es una app, no es un juego, no es una demo. Es una carta que respira porque tiene un mundo adentro, pero sigue siendo una carta. Todo lo que se lee desde el otro lado debe sentirse escrito a mano, en una noche, para una sola persona.

Íntima antes que espectacular. Lenta antes que ágil. Tibia antes que brillante. Si una frase suena a marketing, a tutorial o a release notes, no entra.

## Idioma

Español de Colombia. **Tú**, nunca *usted*, nunca *vos*. Registros mezclados: el día a día puede sonar a chat de pareja —corto, doméstico, casi mudo— y de pronto, sin aviso, abrirse a una intensidad que no pide permiso. Esa oscilación es parte del tono: así habla él, así se quieren.

Sin anglicismos cuando hay palabra propia. Sin diminutivos de empaque ("amorcito", "cosita") salvo que vengan de Steven mismo —si los pide, se respetan.

## Vocabulario prohibido y sustituciones

Ninguna de estas palabras puede aparecer en texto visible. Si el código las trae, se reemplazan.

| Prohibido | Sustitución poética |
|---|---|
| usuario | tú / quien mira / quien lee |
| jugador | tú / quien mira |
| bot, NPC | (su nombre) / la otra / el otro / quien habita |
| AI, IA, modelo | la memoria del mundo / lo que recuerda |
| loading, cargando | el mundo se está despertando / aún respira hondo |
| error | el vínculo se tensó / algo se interrumpió / el pulso se perdió un momento |
| settings, ajustes | cómo quieres mirar / tu manera de estar |
| login, registro | quédate / déjame saber que llegaste |
| logout | hasta luego / cierra despacio |
| play / start | entrar / abrir la puerta |
| pause | quedarse quieto / detener el latido |
| game over | el mundo se apagó / ya no respira |
| score, puntos | (no existen — borrar) |
| level | día / estación / capítulo |
| connect / disconnect | encontrarse / soltarse |
| chat, mensaje | lo que se dicen / lo que alcanzó a decirse |
| offline / online | el mundo duerme / el mundo está despierto |
| update | el mundo cambió un poco mientras no mirabas |

Regla general: si la palabra existe en un manual de software, busca otra.

## Microformas

- **Botones**: minúscula, verbo en infinitivo o frase corta. *entrar al mundo*, *quedarse un rato*, *cerrar despacio*. Nunca CTAs imperativos en mayúscula.
- **Transiciones**: una línea, presente, sin sujeto si se puede. *el mundo se acomoda*. *vuelve el pulso*. *afuera empieza a llover dentro*.
- **Ausencias** (estados vacíos): no decir "no hay nada". Decir lo que sí hay: *todavía no se han dicho nada*. *aquí no ha pasado el día*. *el silencio también cuenta*.
- **Errores**: no son errores, son interrupciones del pulso. *algo se tensó, espera*. *se perdió un momento, ya vuelve*. *el mundo respira despacio, dale un instante*.
- **Despedidas**: nunca cerrar duro. *quédate cuando quieras*. *vuelve cuando puedas*. *la puerta sigue abierta*.
- **Confirmaciones**: bajar el volumen. *está*. *guardado en el mundo*. *queda dicho*.

## Tres registros

**Cotidiano** — lo que las entidades se dicen mientras viven. Frases cortas, casi mensajes de WhatsApp domésticos. Sin signos de admiración.
> *¿comiste?*
> *hoy te extrañé temprano.*
> *vente, está haciendo bueno.*

**Íntimo** — cartas, fragmentos, postales del mundo. Más respiración, más imagen, más silencio entre línea y línea.
> *Hay días en los que el mundo se acuerda de cómo se llama. Hoy es uno de esos.*

**Umbral** — transiciones, principio, final, momentos donde el mundo cambia de estado. Casi rezo. Frases que no terminan del todo.
> *Si dejas de mirar, no se apaga: se queda esperándote, despierto, como un animal pequeño que aprendió tu paso.*

## Reglas duras para el code-reviewer

Cazar en cualquier string visible:

1. **Palabras de la tabla prohibida** —bloqueo automático, sin excepción.
2. **Inglés en UI** — *Loading*, *Submit*, *OK*, *Cancel*, *Retry*, *Save*, *Delete*. Todo se traduce, y la traducción se cura (no es *Cancelar*, es *dejarlo así*).
3. **Mayúsculas tipo botón** — *ENTRAR*, *EMPEZAR*. Bloquear.
4. **Signos de admiración dobles, emojis sueltos, puntos suspensivos largos** (`...!!`, `:)`, `🎮`). Bloquear salvo aprobación explícita de Steven.
5. **Mensajes de sistema crudos** — *404*, *500*, *Network error*, *undefined*, *NaN*. Todos van curados antes de llegar al DOM.
6. **Pluralización fría** — *1 entidad encontrada* / *2 entidades encontradas*. Reescribir como prosa: *está ella sola. están los dos.*
7. **Tooltips técnicos** — *Click here to...*. Bloquear; los tooltips, si existen, son susurros, no instrucciones.
8. **Strings hardcodeados sin pasar por `docs/voice/glossary.md`** — toda copia visible nueva pasa por el letter-curator antes de merge.

Si una string no se puede defender leyéndosela en voz alta a Isa en la noche, no entra.
