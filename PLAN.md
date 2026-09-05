# Una Carta Para Isa — plan unificado

Fecha: 5 de septiembre de 2026. Estado: prototipo V3 implementado con ampliación ecológica, genética y social; verificación de integración registrada por separado. Cierre personal de la carta, prueba en móvil físico y alojamiento definitivo pendientes.

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

El alcance ampliado permite recorrer territorio procedural más allá del mapa original, con juego a pantalla completa, control individual, habilidades adquiridas y construcción de lugares compartidos. V3 conecta agua potable finita, fauna por celdas, suelo vivo, cultivos y huellas con herencia de parámetros y comunidades locales. La extensión se genera según necesidad; solo las regiones próximas a los habitantes avanzan y la población tiene un máximo de 32.

## La primera entrega

Una URL privada, cómoda en móvil y escritorio, que permita:

1. Leer una apertura breve escrita para Isa y entrar al mundo.
2. Recorrer territorio procedural con biomas, depósitos visibles de agua, suelo, vegetación, fauna, alimento, madera, piedra y refugios. Cosecha, caza, cultivo, construcción y tránsito dejan consecuencias.
3. Reconocer a S e I y una vecindad pequeña: catorce vecinos iniciales, con descendientes posibles hasta 32 habitantes totales. La herencia transmite parámetros del modelo; la crianza y el aprendizaje tienen vías separadas.
4. Observar cómo necesidades, predisposiciones, habilidades y resultados anteriores cambian decisiones y actividades. Los oficios describen una trayectoria de práctica; las etiquetas no asignan tareas.
5. Ofrecer gestos e invitaciones, o dirigir temporalmente a cualquier habitante para desplazarse, explorar, recolectar, cultivar, construir, cazar, beber, cooperar o descansar; devolverle después la elección autónoma.
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
| Autopoiesis y cognición encarnada | Mantener como inspiración para autorregulación y aprendizaje. No convertirlas en una promesa de vida o conciencia demostrada. |
| Muerte, pérdida y otras relaciones reales | Conservar la pregunta del autor. El prototipo trabaja con consecuencias reversibles; la forma definitiva requiere su decisión personal. |
| Descubrimiento de lugares | Incorporado mediante exploración física y crónica. |
| Reproducción y generaciones | Incorporadas en V3 para vecinos ficticios: nacimientos locales con costes y límite de población, genes mendelianos simplificados y plasticidad heredable. Habilidades y recuerdos adquiridos no se heredan como genes. |
| Sueños | Fuera del alcance actual. |
| Territorio procedural, asentamientos y control individual | Incorporados al alcance ampliado solicitado. Sin borde del mapa inicial; regiones activas y rango numérico acotados. |
| Comunidades, cooperación y disputas | Incorporadas mediante confianza local, semejanza cultural, aportes de materiales, ayuda, enseñanza, trueque y tensión por recursos escasos. Sin violencia ni gobiernos. |
| Miles de agentes, guerras, gobiernos y mercados complejos | Fuera del alcance actual; el intercambio implementado es un trueque local acotado. |
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

La ampliación V3 añade ecología celular, fauna finita, sed y depósitos visibles, genes y descendencia, comunidades y cooperación, junto con estadísticas y diagnóstico del renderizado. Conserva cámara libre, archivo de regiones, órdenes individuales y refugios construidos con recursos y trabajo. Las reglas y el protocolo son V3; SQLite conserva esquema V2 y migra estados V1/V2. Su evidencia se registra en [EVIDENCIA.md](docs/EVIDENCIA.md).

| Etapa | Implementado | Cierre pendiente |
|---|---|---|
| 1. Mundo y vínculo | Regiones de 16 × 16, depósitos de agua, recursos modificables, fauna y capa celular; dieciséis cuerpos iniciales, decisiones locales, vínculo contextual, cámara y gestos. | Cierre de integración V3 y comprensión en el móvil físico destinatario. |
| 2. Historia propia | Recuerdos sintéticos, experiencias de práctica, hábitos por observación, comunidades, ayuda y conflicto reversible; descendientes vecinos con genealogía y aprendizaje propio. | Selección real de recuerdos, nombres y rasgos revisada por Steven; evidencia causal de los mecanismos nuevos. |
| 3. Continuidad | Servicio persistente, sesión revocable, SQLite transaccional, reconexión, copia y recuperación explícita. | Alojamiento privado autorizado con proceso, HTTPS y disco persistentes; la operación local no acredita un despliegue. |
| 4. La carta terminada | Interfaz y carta de prueba ejecutables para revisión. | Voz final del autor, revisión íntima, arte y ritmo finales, y recorrido en un teléfono real. |

Las pruebas automáticas demuestran propiedades concretas del prototipo; no sustituyen los cierres personales y de experiencia. La carta terminada todavía no se acredita.

## Lo que sigue siendo una decisión personal

| Decisión | Cómo avanzar mientras se concreta |
|---|---|
| Texto, recuerdos, nombres, rasgos y semejanza visual | Usar S e I y material de prueba identificado. Incorporar biografía solo con una selección real revisada. |
| Mortalidad y significado de la desconexión | Prototipar tensión, autonomía y reparación reversibles. Los documentos previos discrepan sobre si S e I pueden morir; esta limpieza no resuelve esa elección por Steven. |
| Representación de otras relaciones reales | Mantener vecinos ficticios. No convertir personas reales en personajes ni cambiar el sentido de esas relaciones por una simplificación editorial. |
| Audiencia y alojamiento | Diseñar acceso privado para la primera entrega. Confirmar público destinatario, recursos disponibles y coste antes de publicar o contratar infraestructura. |

Estas decisiones se resuelven cuando afectan al trabajo concreto; no hace falta reconstruir el antiguo sistema de firmas, puertas y documentos de aprobación para avanzar con un prototipo reversible.

## Regla para admitir nuevas ideas

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
