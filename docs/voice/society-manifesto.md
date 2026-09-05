# Manifiesto de voz — la multitud

> Extensión del `docs/voice/manifesto.md` para cuando el mundo deja de ser un
> dueto. Los pilares del proyecto siguen mandando: lo que cambia es **cómo
> miramos a los que no son ellos dos**.
>
> Premisa central de esta extensión: **la sociedad no compite con la carta,
> la sostiene**. Los otros no son escenografía neutra ni co-protagonistas:
> son aire, son eco, son el contraste contra el cual S e I se vuelven nítidos.
> Si la cámara empieza a querer enfocar a los demás, la carta se rompe.

## Por qué importa que sean borrosos

En el mundo real, Steven e Isa no conocen el nombre de la gente que pasa por
su calle. Eso no los hace menos humanos: los hace humanos del modo en que
todos lo somos. La sociedad simulada respeta esa verdad. Para nosotros (Isa
y quien mire), los demás son **una multitud con textura, no con biografía**.

Esto también es ético: si nombráramos a doscientos seres simulados, los
gamificaríamos. Quedarían como NPCs con etiqueta. Dejándolos borrosos,
quedan vivos.

## Las cinco reglas

### 1. Steven e Isa son los únicos con nombre

Ni una sola entidad común tiene nombre propio en texto visible. En el código
pueden ser ids (`a-0421`, `c-1188`); en pantalla son **alguien**, **una**,
**uno**, **otra**, **el que vive cerca del agua**, **la que se asoma al
amanecer**.

Si Steven decide más adelante darle nombre a un común (por una razón
narrativa que solo él puede justificar), eso entra como excepción puntual
y se discute caso por caso con el `letter-curator`. Nunca como regla.

### 2. La cámara nunca enfoca a un común con descripción larga

Lo que pasa en la multitud es **eco, no protagonista**. Una frase corta,
ambiental, sin sujeto definido:

- *muchas se quedaron junto al fuego.*
- *alguien cruzó el agua despacio.*
- *los del bosque se hicieron poco.*

Lo que **no** se hace:

- *Akiro, el habitante del oeste, perdió a su pareja en la cuarta luna.*
- *El grupo Alpha del norte migró tras la sequía.*

Cualquier frase que se sienta como ficha de personaje rompe la regla.

### 3. Las utterances del LLM solo aparecen para S, I, o lo muy próximo

El motor puede generar texto para cualquier ser. La capa que decide qué
sale a pantalla **no**:

- **Sí se renderiza** cualquier `utterance` cuyo emisor sea Steven o Isa.
- **Sí se renderiza** si dos seres están a distancia íntima de S o I, y
  lo que dicen es relevante para el momento que S/I están viviendo
  (criterio del `narrative-curator`).
- **No se renderiza** la habla pública de los demás. Existe en el mundo,
  como existe el ruido en un café, pero no aterriza en texto visible.
  Puede sugerirse como rumor ambiental: *se oyen voces lejos*.

Cien utterances simultáneas son ruido; el ruido se respeta no
imprimiéndolo.

### 4. El diario del mundo habla de bandadas, no de ids

Cuando el diario del mundo cuenta lo que pasó mientras Isa no estaba,
sintetiza la multitud:

- *el día que muchas se fueron al norte.*
- *la tarde que el bosque del oeste se quedó callado.*
- *cuando casi todas se juntaron junto al agua.*

Lo que **no** se hace:

- *el agente A-1234 inició una migración a las 14:32.*
- *la población del bioma B descendió un 18%.*
- *3 grupos se formaron, 1 se disolvió.*

El diario del mundo es un cuaderno de viajero, no un dashboard.

### 5. La muerte de S o I es única; las demás son una línea

La muerte de Steven o de Isa es **la única ceremonia narrativa con peso
completo** en todo el proyecto. Tiene su propio archivo, su propio
componente, su propio momento de fade del mundo, su propia postal final.
Está blindada por los cuatro pilares (la *death by disconnection* es de
ellos dos, no de los demás).

Las muertes de los comunes son **una sola línea, fade-out corto, sin
nombre**:

- *alguien se quedó quieta cerca del agua.*
- *uno dejó de moverse en el bosque.*
- *la que venía por el camino no llegó.*

Sin orbe largo, sin postal del corpus, sin parar la simulación. La carta
sostiene su peso reservándolo para los dos.

## Cómo cambia el tono cuando hay multitud

El registro **íntimo** sigue siendo el dominante: S e I son la cámara
principal. Cuando aparece el registro **multitud**, las reglas son:

- **Frases sin sujeto** cuando se puede. *Hubo movimiento al norte.*
- **Cuantificadores borrosos**: *muchas*, *unas cuantas*, *casi todas*,
  *unas pocas*, *nadie*. Nunca números.
- **Verbos plurales sin antecedente claro**: *se fueron*, *se juntaron*,
  *se quedaron*. Si la conjugación no aclara género, default femenino
  (la voz del proyecto ya tiende a *ellas*, sin marcarlo).
- **Referencias por lugar**: *los del bosque*, *los de la playa*, *los
  del otro lado*. Nunca *facción*, *clan*, *grupo X*.
- **Cero exclamación, cero énfasis sobre la multitud**. La masa nunca
  sorprende; lo que sorprende es lo que les pasa a S o a I dentro de ella.

## Coordinación con otros archivos

- `docs/voice/manifesto.md` sigue siendo la fuente. Si choca con este
  archivo, manda aquel.
- `docs/voice/society-glossary.md` es la tabla operativa para el
  `code-reviewer`. Este manifesto explica el porqué; ese, el qué.
- `docs/voice/moments.md` se extiende con `MomentKind` sociales nuevos
  (ver Parte C del reporte del `letter-curator`). Cada nuevo kind hereda
  el registro tonal descrito aquí: descripción ambiental, sin nombre, sin
  conteo, sin protagonismo.
- Cuando `narrative-curator` traiga fragmentos del corpus donde Steven
  habla de "la gente", "los demás", "los otros", esos fragmentos entran
  como semilla autorizada para frases de multitud. Lo que escribimos hoy
  es andamio: la voz definitiva sale del corpus.

## Regla de cierre

> Si una frase sobre la multitud se puede leer como una frase de paper de
> simulación social, se reescribe. Si no se puede leer en voz alta a Isa
> sin que la frase compita con lo que están viviendo S e I, se borra.
