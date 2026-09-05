# Glosario social — cuando ya no son dos, sino una multitud

> Este archivo extiende `docs/voice/glossary.md` con el vocabulario que aparece
> cuando el mundo deja de ser un dueto y se vuelve una sociedad. **No reemplaza
> al glosario base**: lo complementa. Si una palabra está prohibida allí, sigue
> prohibida aquí; lo que añadimos son las palabras nuevas que llegan con la
> multitud, y la forma curada de nombrarlas para que la carta no se rompa.
>
> La voz cambia, pero la regla fundamental no: **Steven e Isa son los únicos
> que importan**. Los demás son borrosos a propósito. Por eso el lenguaje los
> deja en penumbra: nadie tiene nombre, nadie es protagonista de su frase.

## Cómo usarla en un review

1. Si el diff introduce términos de sociedad (poblaciones, grupos, migraciones,
   linajes, ceremonias), grepear contra la columna `prohibido` de este archivo
   además del glosario base.
2. La severidad por defecto es `blocker` cuando el string es visible: los
   anglicismos de simulación social son aún más fríos que los de UI normal.
3. Si la palabra cabe en el dueto y en la multitud, prefiere la forma del
   glosario base. Esto solo se aplica a lo que no estaba antes.
4. Para casos límite ("¿llamamos a este grupo *banda*, *familia* o *los del
   bosque*?"), el `letter-curator` decide; la regla guía es: **referenciar
   por lugar antes que por categoría**.

---

## Tabla canónica — sociedad

| concepto técnico | prohibido (NUNCA decir) | sustitución canónica | contexto | razón |
|---|---|---|---|---|
| NPC | `NPC` · `npc` | habitante · otra · vecino · alguien · uno · una | crónica, postales, debug visible | Categoría de videojuego; aplana al otro a función. |
| agent / agente IA | `agent` · `agente` (de simulación) | criatura · ser · habitante · alguien | crónica, diario, hover | Etiqueta de paper; rompe la metáfora. |
| population | `population` · `población` | el resto · los demás · los otros · quienes están | resúmenes del mundo | "Población" es de censo; los otros no son demografía. |
| population size / count | `N agents` · `count` | unos cuantos · muchos · todos los que estaban | diario, métricas visibles | Nunca número; siempre forma borrosa. |
| spawn | `spawn` · `spawnear` | apareció · nació · llegó · se asomó al mundo | eventos de nacimiento | Anglicismo de motor de juego. |
| despawn | `despawn` · `despawnear` | dejó de estar · se fue · se quedó quieta · no volvió | eventos de salida | Idem. |
| AI behavior / behavior tree | `behavior` · `comportamiento` (técnico) | lo que hace · cómo se mueve · lo que le da por hacer | descripciones de UI | "Comportamiento" es de manual; aquí es vida. |
| grouping / cluster | `grouping` · `cluster` · `agrupamiento` | se juntan · se reúnen · se quedan cerca · están juntas | crónica, vistas de mapa | Términos de algoritmo de clustering. |
| flock / swarm | `flock` · `swarm` · `enjambre` · `bandada` (cuando es técnico) | banda · pequeño grupo · familia · unos cuantos | etiquetas de grupos | Anglicismo; "bandada" solo si es literal de pájaros. |
| tribe / faction | `tribe` · `tribu` · `facción` · `clan` | los del bosque · los de la playa · los que viven cerca del río | etiquetas de comunidad | Referenciar por lugar; nunca por categoría étnica. |
| society / civilization | `society` · `civilización` | el mundo · todos los que estaban · el resto | resúmenes amplios | Suena a paper de Sid Meier. |
| community | `community` · `comunidad` (técnico) | los que viven cerca · los del mismo lado · quienes se quedaron juntos | UI de filtros | "Comunidad" como categoría es fría; descripción ambiental es tibia. |
| death (de un agente común) | `died` · `murió` (con énfasis dramático) | se quedó quieta · se fue · no volvió · dejó de estar | crónica de muertes no-S/I | La muerte de uno común es una línea, no una ceremonia. |
| birth / reproduction | `reproduction` · `spawned a child` · `procreación` | alguien nuevo apareció · nació entre ellas · llegó alguien más | eventos de nacimiento | Verbo de paper biológico → verbo de carta. |
| offspring / child agent | `offspring` · `cría` | alguien nuevo · una nueva · una pequeña · la que llegó después | linajes | Naturalismo veterinario; aquí son personas borrosas. |
| migration | `migrate` · `migración` (técnico) | se fueron al otro lado · cambiaron de sitio · se movieron lejos | eventos de movimiento masivo | "Migración" se aceptaría en poesía pero no como tag; preferir el verbo. |
| extinction / extinct | `extinction` · `extinto` · `wipeout` | se quedaron sin nadie · el bosque se quedó vacío · ya no hay quién | eventos de pérdida de población local | Palabra clínica; reescribir como ausencia de lugar. |
| marriage / pair-bond | `marriage` · `pair-bond` · `emparejamiento` | dos se encontraron · se quedaron juntas · empezaron a buscarse | eventos de pareja | "Emparejamiento" suena a cría animal. |
| genealogy / lineage | `genealogy` · `lineage` · `pedigree` | los que vinieron de las mismas · de quién viene · la línea de quien… | árboles familiares (si existen) | Categoría de software de heráldica. |
| governance / leader / chief | `governance` · `chief` · `líder` · `alfa` | quien decide entre ellas · la que llevan oyendo · a quien siguen | UI de organización | Lenguaje de paper o de manada; preferir descripción funcional. |
| economy / market | `economy` · `market` · `mercado` (técnico) | lo que se cambian entre ellas · lo que se pasan · el ir y venir | resúmenes de intercambio | Si llega economía al mundo, que se sienta como trueque, no como bolsa. |
| inventory | `inventory` · `inventario` | lo que carga · lo que tiene encima · lo suyo | descripciones de objetos | Cliché de RPG. |
| biome | `biome` · `bioma` (técnico) | el bosque · la playa · el lado del río · donde hay árboles | etiquetas de zona | Referenciar por descripción, no por categoría. |
| spawn point / spawn area | `spawn point` · `spawn area` | donde aparecen · donde llegan al mundo · el sitio en que nacen | docs visibles | Anglicismo doble. |
| AI utterance (de un agente común) | `utterance` (visible) | lo que alguien dijo · una voz · algo que se oyó | logs de habla pública | Solo S/I tienen `utterance` con peso narrativo; las demás son ecos. |
| crowd / mob | `crowd` · `mob` · `muchedumbre` (peyorativo) | muchas · los demás · todos los que estaban · gente | escenas masivas | "Mob" es de MMO; "muchedumbre" es despectivo. |
| individual / individuo | `individual` (sustantivo técnico) | alguien · una · uno | descripciones | Lenguaje de censo. |
| neighbor / vecino IA | `neighbor agent` · `vecino` (técnico, en debug visible) | quien vive al lado · la otra de al lado · alguien cerca | tooltips, vistas de mapa | "Vecino" se permite si es ambiental, no si es categoría de algoritmo. |
| event log / world log | `event log` · `log del mundo` | el diario del mundo · lo que se ha visto pasar · lo que recuerda | feeds | Ya está cubierto en el base; aquí confirmamos su forma con multitud. |
| simulation tick (visible) | `tick` · `step` | un rato · un instante · un momento · (omitir) | si llega a UI | No debería; si llega, suavizar. |

---

## Reglas duras para escenas con multitud

1. **Cero números, cero conteos exactos.** Ni "12 habitantes en el bosque" ni
   "3 grupos formados". La crónica dice *muchas*, *unas cuantas*, *casi nadie*,
   *todas las que estaban*.
2. **Nadie común tiene nombre propio en pantalla.** Si el motor les asigna ids,
   esos ids **no salen del backend**. En texto visible, son *alguien*, *una*,
   *uno*, *otra*. Steven e Isa son los únicos con nombre.
3. **Las comunidades se nombran por lugar, no por categoría.** *Los del bosque*,
   *los de la playa*, *los del otro lado del río*. Nunca *tribu A*, *clan rojo*,
   *facción del norte*.
4. **La muerte de un común es una línea.** *Alguien se quedó quieta cerca del
   agua.* Sin nombre, sin ceremonia, sin orbe largo. La muerte de S o I es otra
   cosa entera y vive en su propio archivo.
5. **El conteo de población nunca aparece como métrica.** Si el mundo necesita
   decir cuántos quedan, lo dice como aire: *quedan menos*, *está más vacío*,
   *el bosque se quedó callado*.

---

## Notas de coordinación

- Este archivo es ligero a propósito: la sociedad llega después del dueto, y
  parte de la voz tiene que sostener la regla de "los otros son borrosos".
  Si en algún momento Steven decide que un común tenga arco propio, ese caso
  se discute uno por uno y entra como excepción nombrada, no como categoría.
- Cuando `narrative-curator` extraiga voz de Steven sobre "la gente" (porque
  el corpus de 227k líneas seguro tiene fragmentos sobre amigos, familia,
  desconocidos), esas frases entran como columna nueva en esta tabla:
  *"así habla él de los otros"*. Hoy no tenemos ese material curado.
- El `code-reviewer` puede componer este archivo con el glosario base usando
  el mismo `scripts/voice/lint-copy.ts`: ambos comparten formato de tabla.
