# Una Carta Para Isa — plan unificado

La revisión privada actual es V4: fauna individual con fisiología compartida, depredación y herencia; invenciones de estructuras funcionales mediante gramática y búsqueda; hogares elegidos y retornos que permiten sostener comunidades en la ejecución comprobada. Este plan conserva los requisitos y su estado; [REGLAS.md](docs/REGLAS.md) define los mecanismos y [EVIDENCIA.md](docs/EVIDENCIA.md) registra lo comprobado.

Fecha: 5 de septiembre de 2026. Estado: prototipo V4 implementado, comprobado y activo en revisión privada con un mundo nuevo y el anterior conservado íntegro. Cierre personal de la carta, prueba en móvil físico y alojamiento definitivo pendientes.

El objetivo ampliado sigue abierto: construir un mundo que mantenga sus propias redes de producción, aprenda, se diferencie socialmente y descubra procedimientos ejecutables sin supervisión. La fase en desarrollo conecta materiales y herramientas procedurales, especialización por práctica, demografía con herencia y un paisaje más animado. Sus módulos y pruebas aisladas no acreditan todavía integración ni activación; la revisión privada continúa ejecutando V4 hasta validar el conjunto.

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
| Muerte, pérdida y otras relaciones reales | Demografía de vecinos ficticios en desarrollo, con genealogía persistente y consecuencias ambientales. S e I conservan protección explícita de continuidad; cambiar su significado personal sigue siendo una decisión del autor. |
| Descubrimiento de lugares | Incorporado mediante exploración física y crónica. |
| Reproducción y generaciones | Incorporadas en V3 para vecinos ficticios: nacimientos locales con costes y límite de población, genes mendelianos simplificados y plasticidad heredable. Habilidades y recuerdos adquiridos no se heredan como genes. |
| Sueños | Fuera del alcance actual. |
| Territorio procedural, asentamientos y control individual | Incorporados al alcance ampliado solicitado. Sin borde del mapa inicial; regiones activas y rango numérico acotados. |
| Comunidades, cooperación y disputas | Incorporadas mediante confianza local, semejanza cultural, aportes de materiales, ayuda, enseñanza, trueque y tensión por recursos escasos. Sin violencia ni gobiernos. |
| Miles de habitantes, guerras, gobiernos y mercados complejos | Horizonte conservado: instituciones, conflictos y redes económicas deberán emerger de interacciones verificables. El intercambio actual es un trueque local acotado; ampliar población exige presupuestos medidos. |
| Invención funcional | Gramática de seis componentes, variantes y cruces entre diseños conocidos, selección contextual, costes, desgaste y utilidad observada por uso. No se inventan componentes físicos arbitrarios. |
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

La ampliación V4 añade fauna individual, fisiología compartida, depredación, herencia animal, invenciones y motivos locales para volver a un hogar. Conserva ecología celular, genética humana, cooperación, cámara libre, archivo de regiones y órdenes individuales. Las reglas y el protocolo son V4; SQLite conserva esquema V2. Su integración se registra en [EVIDENCIA.md](docs/EVIDENCIA.md); las versiones anteriores permanecen en Git.

| Etapa | Implementado | Cierre pendiente |
|---|---|---|
| 1. Mundo y vínculo | Regiones de 16 × 16, depósitos de agua, recursos modificables, fauna individual y capa celular; dieciséis cuerpos humanos iniciales, decisiones locales, vínculo contextual, cámara y gestos. | Comprensión en el móvil físico destinatario. |
| 2. Historia propia | Recuerdos sintéticos, experiencias de práctica, hábitos por observación, comunidades, ayuda y conflicto reversible; descendientes vecinos con genealogía y aprendizaje propio. | Selección real de recuerdos, nombres y rasgos revisada por Steven; evidencia causal de los mecanismos nuevos. |
| 3. Continuidad | Servicio persistente, sesión revocable, SQLite transaccional, reconexión, copia y recuperación explícita. | Alojamiento privado autorizado con proceso, HTTPS y disco persistentes; la operación local no acredita un despliegue. |
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
| Profesiones y funciones adaptativas, sin asignaciones predeterminadas | Las etiquetas de oficio describen práctica adquirida. En desarrollo: competencia por procedimiento y dependencias observadas entre productores y usuarios; falta probar especialización autónoma sostenida. |
| Aprendizaje por genes y memorias, cooperación creciente | Herencia y aprendizaje se separan; hay recuerdos acotados, imitación, enseñanza, intercambio y ayuda. Evolución multigeneracional estable queda por estudiar. |
| Comunidades culturales, endogrupo/exogrupo y conflictos propios | Implementadas confianza, prácticas adquiridas, pertenencia revisable, disputas por recursos y turnos; no hay todavía guerras, gobiernos o instituciones emergentes. |
| Que las comunidades permanezcan juntas cuando tenga sentido | V4 incorpora hogares observados y retorno físico. Se exige una ejecución autónoma con cooperación y contraste de escasez; reiniciar la DB por sí solo no corrige dispersión. |
| Inventar estructuras nuevas que cambien lo que el mundo puede hacer | V4 combina seis componentes funcionales con variantes culturales, costes y utilidad observada. En desarrollo: programas que transforman materiales, producen herramientas y reutilizan productos como entradas o catalizadores. Deben cambiar capacidades físicas y pagar trabajo, materia y desgaste. |
| Un mundo muy vivo, autoorganizado, con complejidad inesperada como Conway y la ficción de Black Mirror | Objetivo abierto: redes que se mantienen, reconstruyen sus condiciones de existencia y generan procedimientos nuevos sin supervisión. Se distinguirán posibilidad estructural, arranque desde recursos disponibles y mantenimiento material observado. No se ha demostrado conciencia, autopoiesis biológica ni evolución abierta ilimitada. |
| Evolución continuada y reemplazo generacional | En desarrollo: necesidades y supervivencia con costes heredables, envejecimiento y muerte de vecinos ficticios, nacimientos naturales y archivo de identidad. Una selección en laboratorio no prueba evolución multigeneracional del mundo completo. |
| Calidad visual excelsa, animación y mundo cambiante | En desarrollo: luz continua, sombras, agua, clima, vegetación y acciones visibles vinculadas a hechos del servidor. Exigir comparación visual y rendimiento medido; respetar movimiento reducido. |
| Mejor aprovechamiento de CPU y las dos GPU para crecer | Backend único, cachés y guardado optimizado implementados; las GPU del servidor no simulan ecología. Evaluar procesamiento por lotes o kernels ecológicos solo con benchmark y fidelidad frente al motor de referencia. |
| Mucha más estadística y control del hardware | Hay métricas de recursos, cuerpos, grupos, genealogía, invención y tiempos de cliente/servidor. El presupuesto de fauna debe preservar identidades y repartir turnos; su coste completo necesita evidencia. |
| Colaboración entre modelos potentes, con calidad antes que ahorro | GPT-6 integra y revisa; aportes externos se evalúan como propuestas. No se usan LLM en el ciclo de simulación. Commits acotados conservan avances. |

### Documentación y continuidad del trabajo

Un tema tiene una referencia canónica y los demás documentos la enlazan. No crear documentos históricos o de fase que dupliquen reglas, diseño o evidencia: Git ya conserva esas revisiones. Cada cambio de alcance actualiza esta tabla, su regla cuando exista y su evidencia cuando se ejecute.

| Referencia canónica | Responsabilidad |
|---|---|
| [PLAN.md](PLAN.md) | Visión, ideas acumuladas, alcance y estado de trabajo. |
| [README.md](README.md) | Arranque, acceso, operación y recuperación. |
| [REGLAS.md](docs/REGLAS.md) | Mecánicas, fórmulas, costes, límites y condiciones del modelo implementado. |
| [CONSTRUCCION.md](docs/CONSTRUCCION.md) | Arquitectura, persistencia, contratos e integración. |
| [EXPERIENCIA.md](docs/EXPERIENCIA.md) | Interfaz, interacción, narrativa y voz. |
| [CIENCIA.md](docs/CIENCIA.md) | Fuentes, interpretación y límites de las afirmaciones científicas. |
| [EVIDENCIA.md](docs/EVIDENCIA.md) | Verificación vigente, condiciones medidas y capacidades todavía no probadas. |

Las especificaciones en desarrollo deben identificarse como tales. Una prueba unitaria, una ejecución autónoma y una capacidad desplegada son estados diferentes. Los resultados detallados de herramientas quedan en artefactos; su interpretación vigente se incorpora a EVIDENCIA sin crear otro documento competidor.

El mundo privado mostró dispersión incompatible con comunidades locales. Para concretar la solicitud de limpiar la base principal se inició un mundo nuevo tras validar V4, conservando íntegra la historia anterior y el acceso existente. Un comienzo nuevo no debe borrar el respaldo ni justificarse mediante repoblación silenciosa de un estado inválido. Los detalles de activación están en EVIDENCIA.

Una incorporación debe describir **qué permite observar o hacer, qué causa cambia y qué aporta al mundo o a la carta**. Se prueba con la solución más pequeña que cierre ese circuito. Si duplica otra mecánica, exige una explicación larga para tener sentido o solo aumenta escala, se deja fuera.

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
