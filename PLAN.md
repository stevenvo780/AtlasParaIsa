# Una Carta Para Isa — plan unificado

## Objetivo rector

[GOAL.md](GOAL.md) contiene la **meta completa lista para copiar**, sus criterios de aceptación y las condiciones de cierre. Es la única fuente del objetivo del proyecto. Este plan conserva las ideas acumuladas, el alcance, el estado y el orden de trabajo; una capacidad implementada o una prueba aprobada no equivale a completar la meta.

## Estado actual

La revisión privada activa es **V5 `6d0e53b` desde el 5 de septiembre de 2026, 21:08 UTC**, con SQLite 3. Integra producción material, herramientas, aprendizaje tecnológico y ciclo vital, con **reemplazo generacional observado en dos réplicas de veinticinco días** después de corregir la preparación alimentaria local. Esta ventana acotada no demuestra continuidad indefinida. **MAIN `c7796ec`, todavía sin desplegar**, reúne inventarios de apertura, archivo tecnológico transaccional, índice ecológico en CPU y renovación de interfaz y paisaje; usa SQLite 4 sin cambiar reglas ni protocolo 5. [REGLAS.md](docs/REGLAS.md) define mecanismos y [EVIDENCIA.md](docs/EVIDENCIA.md) registra pruebas, migración pendiente y límites.

Fecha: 5 de septiembre de 2026. V5 empezó un mundo nuevo autorizado, conservando acceso, base y build anteriores. La copia V4 era inválida también para su lector anterior: esta activación no constituye una migración V4→V5 exitosa. Cierre personal de la carta, prueba en móvil físico y alojamiento definitivo pendientes.

V5 conserva vecinos de octava generación en ambas réplicas extendidas, sin rescates y después de morir los fundadores mortales. Persisten el catálogo tecnológico finito y el mantenimiento material sin acreditar; una réplica conserva quince muertes por deshidratación. Reemplazo observado, suite aprobada y capacidad activa son evidencias distintas.

El repositorio ya contiene una aplicación local ejecutable. El [README](README.md) reúne los comandos reales de arranque, acceso y recuperación. La experiencia siguiente conserva su alcance de diseño; la implementación actual usa S e I, vecinos ficticios y cinco recuerdos sintéticos identificados, sin importar conversaciones ni atribuirles biografía.

## La idea

**Un sandbox de mundo vivo, inspirado en WorldBox, con reglas científicas comprensibles y preguntas filosóficas que se experimentan al jugar. Ese mundo entero es una carta de Steven para su esposa Isa.**

Se puede recorrer, observar a sus habitantes, intervenir en algunas condiciones y descubrir qué cambia. La vida surge de la interacción entre terreno, recursos, cuerpos, decisiones y memoria. Steven e Isa, representados provisionalmente como S e I, tienen un lugar reconocible dentro de esa sociedad.

La carta está en cómo se buscan, en lo que aprenden, en los lugares que adquieren significado y en las huellas que dejan juntos. La historia real aporta la identidad; la simulación permite que aparezcan historias nuevas.

**Síntesis editorial del mensaje:** «Quise construirte un lugar donde nuestra historia pudiera seguir tomando formas. Un mundo donde encontrarnos importe, donde podamos cambiar y donde haya espacio para volver».

Este texto propone el sentido de la obra; la redacción personal final pertenece a Steven.

## Tres compromisos que deben convivir

| Compromiso | Qué significa en la experiencia |
|---|---|
| Mundo jugable | Explorar un mapa, seguir habitantes, observar procesos e intervenir con consecuencias. La sociedad tiene actividad propia y puede sorprender. |
| Ciencia y filosofía | Reglas explícitas, causas comprobables, necesidades que compiten y memoria que transforma conductas. Las preguntas sobre autonomía, identidad y cuidado aparecen en lo que sucede. |
| Carta para Isa | S e I son reconocibles; hay recuerdos autorizados y lugares propios; la voz es íntima. Volver tiene significado y ausentarse no genera una obligación de cuidado. |

El alcance ampliado permite recorrer territorio procedural más allá del mapa original, con juego a pantalla completa, control individual, habilidades adquiridas y construcción de lugares compartidos. V4 conecta agua potable finita, animales individuales con herencia y depredación, suelo vivo, cultivos, invenciones funcionales y hogares recordados con comunidades locales. La extensión se genera según necesidad; solo las regiones próximas a los habitantes avanzan y la población humana tiene un máximo de 32.

La arquitectura implementada mantiene **un mundo compartido por todos los clientes del servicio**: la CPU del backend lo simula a 10 Hz y cada navegador dibuja su vista, normalmente actualizada a 2 Hz. Cámaras distintas observan el mismo estado; abrir clientes no multiplica la simulación. El compositor WebGL2 utiliza, cuando está disponible, la GPU del dispositivo cliente. El servidor admite actualmente hasta 12 conexiones WebSocket simultáneas; aumentar esa escala requiere medición.

## La primera entrega

Una URL privada, cómoda en móvil y escritorio, que permita:

1. Leer una apertura breve escrita para Isa y entrar al mundo.
2. Recorrer territorio procedural con biomas, depósitos visibles de agua, suelo, vegetación, fauna, alimento, madera, piedra y refugios. Cosecha, caza, cultivo, construcción y tránsito dejan consecuencias.
3. Reconocer a S e I y una vecindad pequeña: catorce vecinos iniciales, con descendientes posibles hasta 32 habitantes totales. La herencia transmite parámetros del modelo; la crianza y el aprendizaje tienen vías separadas.
4. Observar cómo necesidades, predisposiciones, habilidades y resultados anteriores cambian decisiones y actividades. Los oficios describen una trayectoria de práctica; las etiquetas no asignan tareas.
5. Ofrecer gestos e invitaciones, o dirigir temporalmente a cualquier habitante para desplazarse, explorar, recolectar, cultivar, construir, ensayar un diseño, reparar, cazar, beber, cooperar o descansar; devolverle después la elección autónoma. Inspeccionar y seguir animales con cuerpos y actividad propios.
6. Descubrir una selección pequeña de recuerdos reales aprobados que influya en comportamientos, lugares y voz.
7. Consultar una crónica breve, estadísticas con alcance explícito y comunidades que comparten recursos, trabajo y conocimientos. Encontrar continuidad al regresar: el mundo avanza en el servidor aunque el navegador esté cerrado.

La primera entrega incluye al menos una costumbre compartida que se forme por repetición e imitación. Así, la sociedad aporta historia propia desde el inicio.

## Qué conservamos y qué recortamos

| Material histórico | Decisión de esta síntesis |
|---|---|
| Mundo autónomo, ecología y sociedad | Conservar con pocos procesos conectados y consecuencias visibles. |
| Cuerpo, vínculo, memoria y agencia | Conservar como un solo circuito de comportamiento. |
| Lugares significativos, silencio, momentos y diario | Conservar; destacar poco y contar hechos ocurridos. |
| Historia real como semilla | Empezar con recuerdos seleccionados y revisados. La ingestión de todo el archivo de conversaciones deja de ser un requisito inicial. |
| Autopoiesis y cognición encarnada | Conservar el objetivo de autonomía material, mantenimiento y organización que se reconstruye mediante sus propios procesos. Exigir evidencia causal; autorregulación o ciclos en un grafo no demuestran por sí solos autopoiesis ni conciencia. |
| Muerte, pérdida y otras relaciones reales | Ciclo vital y genealogía persistente implementados en V5 activo; reemplazo generacional observado en las dos réplicas extendidas de veinticinco días. S e I conservan protección explícita; cambiar su significado personal sigue siendo una decisión del autor. |
| Descubrimiento de lugares | Incorporado mediante exploración física y crónica. |
| Reproducción y generaciones | Incorporadas en V3 para vecinos ficticios: nacimientos locales con costes y límite de población, genes mendelianos simplificados y plasticidad heredable. Habilidades y recuerdos adquiridos no se heredan como genes. |
| Sueños | Fuera del alcance actual. |
| Territorio procedural, asentamientos y control individual | Incorporados al alcance ampliado solicitado. Sin borde del mapa inicial; regiones activas y rango numérico acotados. |
| Comunidades, cooperación y disputas | Incorporadas mediante confianza local, semejanza cultural, aportes de materiales, ayuda, enseñanza, trueque y tensión por recursos escasos. Sin violencia ni gobiernos. |
| Miles de habitantes, guerras, gobiernos y mercados complejos | Horizonte conservado: instituciones, conflictos y redes económicas deberán emerger de interacciones verificables. El intercambio actual es un trueque local acotado; ampliar población exige presupuestos medidos. |
| Invención funcional | Construcción con seis componentes y programas materiales compuestos, herramientas e insumos derivados en V5. Ambas búsquedas pagan costes y distinguen función prevista de utilidad observada. Sus catálogos finitos limitan invención; ampliarlos exige archivo y memoria local separables. |
| GPU para dibujar | Incorporado compositor WebGL2 con cachés, diagnóstico del dispositivo y alternativa Canvas 2D. La simulación sigue en CPU; no se promete aceleración física en cualquier navegador. |
| Entrenamiento de modelos, embeddings obligatorios, múltiples servicios y protocolos binarios | Fuera del alcance actual. La simulación no necesita inferencia de un LLM. |
| Medidores de conciencia, lenguaje cuántico ornamental y aleatoriedad presentada como agencia | Retirar. Sustituirlos por pruebas de causalidad y explicaciones honestas del modelo. |
| Prohibiciones absolutas de jugar, inspeccionar el mundo o mostrar ciencia | Retirar. La intimidad es compatible con la curiosidad y con controles claros. |

## Orden de construcción

| Etapa | Resultado que debe poder verse | Criterio para avanzar |
|---|---|---|
| 1. Mundo y vínculo | Región pequeña, ciclo de recursos, S e I con cuerpo y decisiones, cámara y un gesto ambiental. | Una alteración del entorno cambia una decisión; el encuentro modifica el estado de ambos. Se entiende en móvil sin explicación técnica. |
| 2. Historia propia | Recuerdos seleccionados, lugares significativos, vecinos y una costumbre aprendida. | Una memoria cambia una acción; una conducta colectiva surge de interacciones locales y afecta la vida de la pareja. |
| 3. Continuidad | Guardado, servidor persistente, acceso privado, reconexión y crónica. | Cerrar el navegador no detiene el servidor; reiniciarlo recupera el mismo mundo; la crónica coincide con los hechos guardados. |
| 4. La carta terminada | Texto del autor, arte coherente, sonido opcional y ajustes de ritmo, tacto y accesibilidad. | El enlace funciona en un móvil real y la experiencia permite reconocer la relación, entender una consecuencia y querer volver. |

El orden organiza pruebas de extremo a extremo. La persistencia básica se prepara desde la primera etapa y se endurece en la tercera. Cada etapa deja algo ejecutable; no obliga a desplegar públicamente cada avance.

### Situación del prototipo

El código V5 añade tecnología material, prácticas por procedimiento, mortalidad humana y archivo de identidades a la fauna, ecología y comunidades de V4. El servicio activo usa reglas/protocolo 5 y SQLite 3. La prueba larga corregida conserva generaciones nuevas durante veinticinco días en ambas semillas. No acredita una sociedad autosostenida indefinidamente ni elimina la saturación tecnológica; se conserva la comparación con la extinción anterior.

| Etapa | Implementado | Cierre pendiente |
|---|---|---|
| 1. Mundo y vínculo | Regiones de 16 × 16, depósitos de agua, recursos modificables, fauna individual y capa celular; dieciséis cuerpos humanos iniciales, decisiones locales, vínculo contextual, cámara y gestos. | Comprensión en el móvil físico destinatario. |
| 2. Historia propia | Recuerdos sintéticos, práctica, hábitos observados, comunidades, ayuda y conflicto reversible; descendencia hasta octava generación, tecnología y legados observados en V5. | Continuidad fuera de la ventana estudiada, transmisión y redes productivas sostenidas; selección real de recuerdos, nombres y rasgos. |
| 3. Continuidad | Servicio V5 activo con mundo nuevo, mismo acceso y archivo íntegro del V4 inválido; sesión revocable, SQLite transaccional, copia y recuperación comprobadas en escenarios aislados. | Continuidad durante varios días reales y alojamiento definitivo con proceso, HTTPS y disco persistentes. El archivo V4 conserva su defecto de validación. |
| 4. La carta terminada | Interfaz y carta de prueba ejecutables para revisión. | Voz final del autor, revisión íntima, arte y ritmo finales, y recorrido en un teléfono real. |

Las pruebas automáticas demuestran propiedades concretas del prototipo; no sustituyen los cierres personales y de experiencia. La carta terminada todavía no se acredita.

## Lo que sigue siendo una decisión personal

| Decisión | Cómo avanzar mientras se concreta |
|---|---|
| Texto, recuerdos, nombres, rasgos y semejanza visual | Usar S e I y material de prueba identificado. Incorporar biografía solo con una selección real revisada. |
| Mortalidad de S e I y significado de la desconexión | Mantener protección explícita de ambas identidades mientras se desarrolla el ciclo vital de vecinos ficticios. La mortalidad de los demás no decide el significado personal de la pareja. |
| Representación de otras relaciones reales | Mantener vecinos ficticios. No convertir personas reales en personajes ni cambiar el sentido de esas relaciones por una simplificación editorial. |
| Audiencia y alojamiento | Diseñar acceso privado para la primera entrega. Confirmar público destinatario, recursos disponibles y coste antes de publicar o contratar infraestructura. |

Estas decisiones se resuelven cuando afectan al trabajo concreto; no hace falta reconstruir el antiguo sistema de firmas, puertas y documentos de aprobación para avanzar con un prototipo reversible.

## Regla para admitir nuevas ideas

### Ideas acumuladas y estado

Esta tabla conserva la dirección expresada por Steven, incluso cuando excede el prototipo actual. «Pendiente» conserva una intención; no anuncia una capacidad disponible. Las reglas técnicas se mantienen en su documento canónico y las mediciones en EVIDENCIA.

| Idea del autor | Estado y siguiente criterio |
|---|---|
| Mundo completo en pantalla y UI cómoda para observar/controlar a cualquiera | Implementado con cámara libre, censo y órdenes humanas; falta comprobar comodidad en teléfono físico. Fauna se puede inspeccionar y seguir. |
| Territorio procedural de extensión comparable a Minecraft, con descubrimientos y asentamientos | Implementadas regiones deterministas y persistentes con límite numérico explícito; ampliar escala requiere medir memoria, disco y tiempo. |
| Biomas ricos y agentes que transformen el entorno | Agua, alimento, madera, piedra, vegetación, cultivos, huellas y edificios están conectados a consumo y trabajo. Ampliar variedad debe añadir consecuencias verificables. |
| Mundo compartido; backend simula y frontend visualiza | Implementado un estado y un reloj para todos los clientes. El navegador conserva su cámara; la carga de varios clientes requiere medición separada. |
| Animales con el mismo fundamento corporal, exploración, reproducción y depredación | V4 integra fisiología compartida, cuerpos individuales, genes y memoria local; sin sistemas sociales ni constructivos humanos. |
| Profesiones y funciones adaptativas, sin asignaciones predeterminadas | V5 registra competencia por procedimiento y relaciones entre productores y usuarios. Falta probar división del trabajo sostenida; futuras instituciones deberán surgir de aportes, necesidades y dependencias locales observadas. |
| Aprendizaje por genes y memorias, cooperación creciente | Herencia y aprendizaje se separan; hay recuerdos acotados, imitación, enseñanza, intercambio y ayuda. Se observó reemplazo acotado; transmisión de oficios y estabilidad fuera de esas trayectorias siguen pendientes. |
| Comunidades culturales, endogrupo/exogrupo y conflictos propios | Implementadas confianza, prácticas adquiridas, pertenencia revisable, disputas por recursos y turnos; no hay todavía guerras, gobiernos o instituciones emergentes. |
| Que las comunidades permanezcan juntas cuando tenga sentido | V4 incorpora hogares observados y retorno físico. Se exige una ejecución autónoma con cooperación y contraste de escasez; reiniciar la DB por sí solo no corrige dispersión. |
| Inventar estructuras nuevas que cambien lo que el mundo puede hacer | V4 combina componentes funcionales. V5 ejecuta programas que transforman materiales, producen herramientas y reutilizan productos o catalizadores, pagando trabajo, materia y desgaste. Saturar el catálogo detiene propuestas; resolverlo forma parte de la arquitectura futura. |
| Un mundo muy vivo, autoorganizado, con complejidad inesperada como Conway y la ficción de Black Mirror | Objetivo abierto: redes que se mantienen, reconstruyen sus condiciones de existencia y generan procedimientos nuevos sin supervisión. Se distinguirán posibilidad estructural, arranque desde recursos disponibles y mantenimiento material observado. No se ha demostrado conciencia, autopoiesis biológica ni evolución abierta ilimitada. |
| Evolución continuada y reemplazo generacional | Demografía con costes heredables, nacimientos y archivo implementados. Las dos réplicas corregidas mantienen vecinos hasta octava generación durante veinticinco días; la continuidad indefinida y la selección genética aislada siguen sin acreditarse. La supervivencia protegida de S e I queda fuera del criterio de éxito. |
| Calidad visual, escala coherente e interfaz renovada | MAIN incorpora navegación y fichas reorganizadas, escala de árboles respecto al cuerpo, suelo por estados y estructuras diferenciadas por componentes y condición. La selección distingue inspeccionar una copa de dar una orden al suelo; las personas siguen legibles entre árboles. Despliegue, teléfono físico y calidad final pendientes; el servicio conserva su interfaz anterior. |
| Continuidad territorial y aprovechamiento de CPU, multinúcleo y dos GPU | Backend único y actividad independiente de cámara implementados. MAIN añade un índice de vecinos con caché acotada y equivalencia comprobada; su medición completa está pendiente. Las regiones sin habitantes siguen congeladas y las GPU del servidor no simulan ecología. Continuidad lejana, multinúcleo y GPU requieren coste y fidelidad medidos. |
| Mucha más estadística y control del hardware | Hay métricas de recursos, cuerpos, grupos, genealogía, invención y tiempos de cliente/servidor. El presupuesto de fauna debe preservar identidades y repartir turnos; su coste completo necesita evidencia. |
| Colaboración entre modelos potentes, con calidad antes que ahorro | GPT-6 integra y revisa; aportes externos se evalúan como propuestas. No se usan LLM en el ciclo de simulación. Commits acotados conservan avances. |
| Explorar Fable como referencia para experiencias generativas | Idea pendiente de evaluación frente al objetivo rector; no es una dependencia instalada ni un componente del mundo en ejecución. |

### Siguiente avance de autonomía

La comparación alimentaria y su extensión de veinticinco días acreditan reemplazo generacional dentro de las trayectorias estudiadas; ambos catálogos alcanzan su límite. El siguiente avance debe resolver esa saturación y permitir reposición material y transmisión comprobables, manteniendo costes, percepción local y ausencia de rescates. MAIN incorpora aperturas completas para épocas futuras y archivo SQL de definiciones, estadísticas y recibos con origen de cobertura explícito; todavía no están activos ni reconstruyen intervalos perdidos. La memoria técnica finita dispone de funciones probadas, sin conexión al aprendizaje cotidiano. Persisten los límites de 256 recetas y generación 32. Los siete frentes y sus criterios están una sola vez en [CONSTRUCCION](docs/CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente); sus bases están en [CIENCIA](docs/CIENCIA.md#investigación-pendiente-diversidad-y-continuidad-causal). Este tramo sirve al [objetivo rector](#objetivo-rector); no agota sus frentes ecológico, territorial, social y de interfaz.

Una frontera material producida y reparada por la red sigue siendo una hipótesis posterior: solo aporta al objetivo si su desgaste afecta procesos y su reposición depende de ellos. Añadir cuerpos, instituciones o límites con nombres nuevos no sustituye ese circuito causal.

### Documentación y continuidad del trabajo

Un tema tiene una referencia canónica y los demás documentos la enlazan. No crear documentos históricos o de fase que dupliquen reglas, diseño o evidencia: Git ya conserva esas revisiones. Cada cambio de alcance actualiza esta tabla, su regla cuando exista y su evidencia cuando se ejecute.

| Referencia canónica | Responsabilidad |
|---|---|
| [GOAL.md](GOAL.md) | Objetivo rector listo para copiar, criterios de aceptación y condiciones de cierre. |
| [PLAN.md](PLAN.md) | Ideas acumuladas, alcance, orden y estado de trabajo. |
| [README.md](README.md) | Arranque, acceso, operación y recuperación. |
| [REGLAS.md](docs/REGLAS.md) | Mecánicas, fórmulas, costes, límites y condiciones del modelo implementado. |
| [CONSTRUCCION.md](docs/CONSTRUCCION.md) | Arquitectura, persistencia, contratos e integración. |
| [EXPERIENCIA.md](docs/EXPERIENCIA.md) | Interfaz, interacción, narrativa y voz. |
| [CIENCIA.md](docs/CIENCIA.md) | Fuentes, interpretación y límites de las afirmaciones científicas. |
| [EVIDENCIA.md](docs/EVIDENCIA.md) | Verificación vigente, condiciones medidas y capacidades todavía no probadas. |

Las especificaciones en desarrollo deben identificarse como tales. Una prueba unitaria, una ejecución autónoma y una capacidad desplegada son estados diferentes. Los resultados detallados de herramientas quedan en artefactos; su interpretación vigente se incorpora a EVIDENCIA sin crear otro documento competidor.

El servicio V5 empezó un mundo nuevo autorizado después de comprobar que el V4 privado era inválido, conservando íntegra su historia y el acceso existente. Un comienzo nuevo no debe borrar el respaldo ni justificarse mediante repoblación silenciosa de un estado inválido. Los detalles de activación están en EVIDENCIA.

Una incorporación debe describir **qué permite observar o hacer, qué causa cambia y qué aporta al mundo o a la carta**. Se prueba con la solución más pequeña que cierre ese circuito. Si duplica otra mecánica o añade complejidad sin consecuencia comprobable, se revisa antes de incorporarla. Aumentar escala exige una mejora de experiencia o continuidad y un presupuesto medido.

La profundidad vendrá de combinar las reglas y acumular historia. No se añade un subsistema por cada concepto filosófico.

## Dónde está cada cosa

- [Experiencia, reglas del mundo y carta](docs/EXPERIENCIA.md).
- [Construcción, persistencia y comprobaciones](docs/CONSTRUCCION.md).

El plan y sus documentos de experiencia, construcción, [reglas](docs/REGLAS.md) y [ciencia](docs/CIENCIA.md) sustituyen la documentación anterior como plan de trabajo. El código actual, el README y las comprobaciones de esta implementación describen las capacidades presentes; las afirmaciones históricas de pruebas o despliegue no se trasladan a este prototipo.

Se revisaron los 44 archivos originales de ideas, conceptos, arquitectura, narrativa, voz, legado, operación, validación y plantillas. Antes de retirarlos se comprobó que coincidían con Git. La versión íntegra de esos documentos permanece en el commit `fe6a3a8c65820bb75be290e7c68faac1625e8d44`; no se conserva otra carpeta de archivo que vuelva a competir con el plan.

Para consultar una fuente histórica sin restaurarla al árbol de trabajo:

```sh
git ls-tree -r --name-only fe6a3a8c65820bb75be290e7c68faac1625e8d44 -- docs
git show fe6a3a8c65820bb75be290e7c68faac1625e8d44:docs/MAPA_DE_IDEAS.md
```
