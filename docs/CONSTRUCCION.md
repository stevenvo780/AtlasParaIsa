# Cómo construir y comprobar la primera entrega

Referencia de alcance: [PLAN.md](../PLAN.md). Referencia de comportamiento: [EXPERIENCIA.md](EXPERIENCIA.md).

Estado de la revisión: **V5 activo con mundo nuevo y acceso conservado**, con interfaz WebGL2/Canvas 2D/DOM, HTTP/WebSocket y SQLite. Tecnología, demografía y archivo de identidades tienen pruebas de integración y reemplazo generacional observado durante dos réplicas de quince días; el catálogo finito y las ventanas materiales incompletas siguen limitando la autonomía. [README](../README.md) conserva operaciones y [EVIDENCIA](EVIDENCIA.md) los resultados y el archivo íntegro del V4 rechazado por validación. Los recuerdos son sintéticos; no hay alojamiento definitivo contratado.

## Arquitectura implementada

Una aplicación web en TypeScript, una simulación en CPU y una base de datos local al servidor. Un mismo servicio sirve el frontend compilado, gestiona el acceso y ejecuta **un único mundo persistente compartido por todos sus clientes**. `createApp` conserva un estado del mundo y un temporizador de simulación, independientemente del número de navegadores. Un bloqueo de proceso protege el directorio del mundo; esta implementación admite una sola instancia activa.

```text
Navegadores: cámara propia + WebGL2/Canvas 2D + controles y diario en DOM
                     ↕ HTTPS / WebSocket; vistas normalmente a 2 Hz
Servicio único: sesión privada + mundo compartido a 10 Hz en CPU
                     ↕ transacciones
SQLite en almacenamiento persistente: estado + hechos + recuerdos aprobados
```

El navegador reutiliza dibujos de terreno y sprites en cachés acotadas. Un compositor WebGL2 carga texturas modificadas y compone el terreno; Canvas 2D conserva habitantes, detalles y la alternativa cuando WebGL2 no está disponible, se pierde el contexto o se detecta software. El diagnóstico clasifica el dispositivo como hardware identificado, software o no verificado: disponer de WebGL2 no prueba aceleración física. La clasificación depende de lo que informa el navegador.

La **CPU del servidor** ejecuta ecología, decisiones, aprendizaje, herencia, sociedad, serialización y guardado. La **GPU del dispositivo cliente**, cuando el navegador la utiliza, acelera el dibujo de esa pestaña. No se usa GPU del servidor para simular o entrenar modelos; no hay inferencia de LLM en el ciclo. Añadir clientes aumenta proyecciones y tráfico del servidor, pero no crea mundos ni relojes de simulación adicionales. El límite vigente es doce conexiones WebSocket simultáneas; no se acredita rendimiento con cientos de clientes.

Vite compila el cliente; TypeScript compila el servidor para Node.js. `package-lock.json` fija las dependencias. Se comprobó Node.js 22.22.3 con `node:sqlite`, que en esa versión avisa de su condición experimental. Las comparaciones de renderizado deben conservar escena, cámara, movimiento y configuración, e informar dispositivo observado y tiempos; los FPS o el tiempo de CPU por cuadro no miden ocupación de la GPU. Los resultados concretos pertenecen a [EVIDENCIA.md](EVIDENCIA.md).

Organización suficiente dentro de una aplicación:

```text
src/
  world/       cuerpos, animales, ecología, sociedad, tecnología y organización
  server/      ejecución, guardado, sesión y mensajes
  client/      escena y cachés, carta, fichas, estadísticas y controles
  shared/      tipos de datos que cruzan cliente y servidor
tests/         escenarios y comprobaciones de continuidad
```

Estos módulos no son paquetes publicables ni microservicios. La simulación debe poder ejecutarse sin navegador para probarla. La primera escena puede correr localmente durante el desarrollo; la entrega necesita el servidor para continuar durante la ausencia.

El motor actual corre a 10 Hz y las intenciones ordinarias duran treinta pasos; el servidor confirma transacciones por paso y publica vistas normalmente cada cinco pasos. Las [reglas implementadas](REGLAS.md) detallan unidades, fuentes, límites y comparaciones causales. Ni el dibujo ni un LLM gobiernan la simulación.

## Territorio procedural y archivo

El generador puro usa ruido interpolado multiescala en coordenadas globales, seis biomas y regiones de 16 × 16. Generar en distinto orden produce las mismas celdas. El rango técnico es `[-10 000 000, 10 000 000)`. Los barrios activos dependen de la población, no de la cámara; las vistas admiten hasta 96 × 64 celdas. La ecología archivada permanece congelada.

SQLite conserva revisiones de regiones por clave y paso, con suma de integridad. Retirar regiones, guardar el estado, confirmar entradas y registrar hechos sucede en una transacción. Un punto anterior lee únicamente revisiones de regiones que ya existían en ese paso. La memoria activa es acotada; el archivo persistente crece con el territorio modificado. El motor sin Store mantiene una cola pendiente que su integrador debe confirmar; no ofrece archivo ilimitado en RAM.

La fuente V5 usa reglas y protocolo 5 y esquema SQLite 3. La migración valida la versión de origen antes de enriquecerla y conserva sus campos. Un V4 válido recibe tecnología vacía y estado demográfico cuya edad deriva de su fecha de nacimiento; no se fabrican ensayos ni muertes retrospectivas. La compatibilidad anterior sigue materializando fauna por existencia y planos básicos para refugios antiguos. Una colección guardada vacía impide repoblación implícita. El formato de vida de las regiones continúa en versión 4; no se confunde con la versión global del mundo. Una versión desconocida o un estado inválido se rechaza y nunca dispara un comienzo nuevo silencioso. SQLite íntegro no implica un mundo válido: el caso privado rechazado se registra en EVIDENCIA, sin aplicar un recorte que destruya materia.

La tabla `legacy(id,tick,body,digest)` conserva identidades fallecidas de forma inmutable. El snapshot mantiene solo padres directos de habitantes vivos, autores de planos o recetas y hasta 32 fallecimientos recientes, con límite de 600 registros. La cola `retiredLegacy` espera confirmación igual que las regiones retiradas: ambas se insertan en la misma transacción que el snapshot y solo se vacían al confirmar. El historial completo crece en disco; una simulación sin Store debe hacerse cargo de sus colas.

Leer una identidad exige que su muerte ya haya ocurrido en el paso consultado. La recuperación de un punto anterior poda los registros futuros en una copia, conserva la base original y revoca sesiones de la copia. Se contrastan suma de integridad, fecha, identidad, contador de nacimientos, caché y parentesco; un descendiente no puede nacer después de la muerte de un progenitor. Los archivos mantienen autorías aunque el autor haya desaparecido del censo vivo.

## Una única verdad del mundo

El servidor decide qué ocurre para todos los clientes. Cada navegador dibuja, interpola posiciones y envía solicitudes al mismo mundo; abrir otra sesión no crea una simulación personal. Mover una cámara no cambia el estado de los habitantes. Las órdenes de clientes distintos entran al mismo orden de aplicación, sujeto a validación y guardado.

Un paso de simulación sigue un orden estable:

1. Incorporar entradas aceptadas.
2. Actualizar ambiente, recursos y necesidades.
3. Construir percepción local y recuperar recuerdos pertinentes.
4. Elegir o continuar acciones; resolver efectos y encuentros.
5. Resolver demografía después de las acciones, liquidar pertenencias localmente, conservar identidades y actualizar comunidades, posibles nacimientos y estadísticas.
6. Guardar el estado correspondiente y publicar una vista coherente.

El tiempo avanza con pasos fijos de 100 ms: diez pasos por segundo, ecología cada diez pasos y vistas normalmente cada cinco. Una entrada aceptada o un cambio de cámara puede producir una vista adicional. El dibujo sigue el ritmo de pantalla e interpola el estado recibido. No hay un scheduler distribuido ni un reloj de simulación por usuario.

El generador aleatorio pertenece al estado guardado. Semilla, estado inicial, versión de reglas y entradas con su paso de aplicación y orden dentro del paso permiten repetir una ejecución de prueba. El servidor asigna y guarda esos tiempos y órdenes. Variar una semilla puede producir historias distintas; una misma ejecución debe ser reproducible.

## Los datos necesarios

| Dato | Contenido mínimo |
|---|---|
| Mundo | Versión, semilla, estado del generador aleatorio, paso y tiempo simulado, terreno, recursos y habitantes. |
| Habitante | Identidad, posición, cuerpo con sed, genoma y parentesco, valores aprendidos, habilidades, intención, materiales, cultura, confianza y memoria acotada. |
| Ecología celular | Agua potable, fertilidad, biomasa, cultivo, tránsito y actividad celular; fauna por celda derivada de individuos. |
| Animal | Identidad, especie, cuerpo, edad biológica, parámetros heredables, progenitores, percepción y memoria local. |
| Plano y estructura | Componentes, coste, autor y ascendencia cultural; edificio con identidad, condición, reservas y utilidad derivada de usos. |
| Tecnología | Programas compuestos, ascendencia cultural, lotes con composición y propiedades, proyectos en curso, competencia por receta y recibos de ejecución acotados. |
| Identidad fallecida | Nombre ficticio, parentesco, genoma, parámetros demográficos, fechas, causa y comunidad al morir; sin copia genética del aprendizaje. |
| Comunidad y estadísticas | Pertenencia revisable, prácticas medias, hechos de cooperación/conflicto, acumulados y serie reciente acotada. |
| Recuerdo real aprobado | Identificador, referencia privada a su procedencia, texto aprobado, contexto de activación y efecto posible. |
| Experiencia simulada | Quién actuó, dónde, qué ocurrió y qué preferencia o relación cambió. |
| Hecho para crónica | Momento simulado, participantes, causa identificable y texto permitido para la audiencia. |
| Entrada de Isa | Identificador único, gesto, objetivo, paso de aplicación, orden dentro del paso y resultado. |

La base conserva el estado actual coherente y puntos de recuperación. Los hechos de la crónica explican la historia; no hace falta convertir cada cambio numérico en un evento permanente. El registro de entradas con su paso y orden, junto a los puntos de partida, permite repetir escenarios de validación sin adoptar una arquitectura completa de event sourcing.

Los datos de la simulación y sus textos visibles son distintos del archivo original de conversaciones. El navegador recibe una proyección deliberada: paisaje, acciones, necesidades explicables y contenido revisado. No se serializa todo el estado interno por comodidad.

## Memoria y agencia sin dependencia de un LLM

Al principio, recuperar recuerdos significa buscar entre una selección pequeña usando etiquetas de lugar, situación y necesidad. La memoria modifica una preferencia o la evaluación de una acción. La voz usa texto revisado y plantillas que describen hechos.

Las experiencias nuevas refuerzan o debilitan preferencias con límites explícitos y una tasa de adaptación heredable. Siete pares de genes transmiten parámetros entre vecinos ficticios; habilidades, valores aprendidos y recuerdos no se convierten en alelos. Los descendientes empiezan sin aprendizaje copiado, conservan un primer episodio propio de nacimiento y reciben prácticas culturales iniciales por crianza. La población se limita a 32; los nacimientos consumen recursos y requieren condiciones locales. Se conserva una memoria reciente acotada y un resumen de hábitos; no se acumula una copia ilimitada de cada paso.

Si más adelante hace falta variación lingüística, una generación opcional podrá realizar una intención ya decidida. Nunca controlará el movimiento ni detendrá el mundo. Embeddings, modelos locales y servicios de inferencia requieren una carencia demostrada, no son requisitos de la carta.

## Guardado, ausencia y errores

El estado, sus hechos correspondientes y las entradas aplicadas se guardan de forma coherente en transacciones. Una confirmación de gesto persistente solo se envía después de su guardado; repetir su identificador devuelve el mismo resultado, sin aplicar el efecto otra vez.

El snapshot conserva celdas activas en tuplas JSON versionadas (`tiles-tuple-v1`) para evitar repetir veinte nombres de campo por celda, sin cuantización. El lector admite objetos y tuplas; los archivos de regiones conservan objetos. Se rechazan valores opcionales presentes nulos o no finitos antes de escribir. La copia del estado para cada transacción aprovecha que las celdas son planas; individuos, estructuras, proyectos, lotes y recuerdos mantienen copias independientes. Las pruebas verifican identidad, contadores monotónicos, recuperación y conservación material.

Se conservan un punto de recuperación anterior y una copia de seguridad. Al arrancar se valida la versión y la integridad del estado antes de avanzar. Un fallo de lectura no crea silenciosamente otro mundo: se conserva la evidencia y se recupera un estado válido mediante una operación explícita.

Hay dos ausencias diferentes:

- **Isa cierra el navegador:** el servidor sigue avanzando y guardando. Su última visita sirve para seleccionar la crónica, no para calcular hambre o afecto.
- **El servicio se detiene:** la primera versión recupera el último estado confirmado y retoma desde allí. El intervalo de caída queda registrado como pausa; no se inventan encuentros ni se simulan meses retrospectivos para disimularla.

Esta política evita un sistema de recuperación temporal complejo. La entrega debe mostrar con honestidad las pausas técnicas y la reconexión. Si falla el guardado, no se confirman más cambios persistentes: se protege el último estado coherente y se informa la indisponibilidad.

## Conexión e interacción

El protocolo V5 conserva ventanas de cámara con origen absoluto y órdenes individuales idempotentes; añade investigar, fabricar, cosechar alimento, reserva alimentaria visible, salud, vitalidad, productos, procedimientos y organización observada. La vista de un fallecimiento conserva información de identidad y retira los controles del cuerpo ausente. Ventanas distintas del mismo paso son válidas; una vista antigua no puede sustituir un paso posterior. El intercambio JSON incluye estado inicial, actualizaciones, solicitud de gesto u orden, resultado y error comprensible. Se envían vistas completas acotadas por cliente; no hay una simulación nueva asociada a cada conexión.

`technology-organization.ts` adapta recibos materiales a `organization.ts`. Agrupa operaciones anidadas sin contar dos veces el desgaste, comprueba continuidad de inventarios y separa transferencias de producción. El análisis derivado se reutiliza entre proyecciones del mismo objeto, paso y contador de ejecuciones; no modifica la simulación. Una ventana incompleta o un balance inconsistente se informa como evidencia insuficiente. Las condiciones de organización y sus límites científicos están en [CIENCIA.md](CIENCIA.md).

Los recibos tecnológicos del servicio todavía son un búfer reciente de 256 entradas dentro del snapshot; no existe archivo persistente de procedimientos y ejecuciones fuera de él. Un actor sin recibos en la ventana puede conservar productos cuyo inventario inicial no se conoce. El adaptador no puede deducirlo del inventario final sin evidencia adicional. El observador experimental multisemilla acumula sus propios contadores completos; esa instrumentación no amplía las garantías del servicio.

Cada vista lleva versión y secuencia. El cliente descarta vistas antiguas y obtiene una nueva al reconectar. Un cliente lento no puede acumular mensajes sin límite: recibe la vista reciente disponible.

Los gestos se validan en el servidor: sesión autorizada, forma y objetivo válidos, límite de frecuencia e identificador único. La confirmación de recepción distingue entre una entrada inválida y una invitación válida que el habitante no atendió. La interfaz comunica esa diferencia con claridad.

## Acceso, material personal y alojamiento

La primera entrega se diseña privada para Steven e Isa. Una contraseña verificada con scrypt y una sesión revocable controlan lectura y gestos; las credenciales se guardan fuera del repositorio y del código del navegador. No hay una plataforma de cuentas individuales ni mundos separados por persona. Un enlace difícil de adivinar no sustituye el control de acceso.

La selección de recuerdos debe indicar qué contenido puede ver esa audiencia. El material original se consulta en su ubicación autorizada y no se copia al repositorio, a logs, a prompts externos ni a la base operativa del mundo. Los textos que entren a la aplicación se revisan; también se revisa el contenido derivado que aparezca en diario o fichas.

Si se retira un recuerdo, se retiran sus derivados accesibles y se evita reintroducirlo al restaurar copias. El mecanismo concreto se documenta al incorporar datos reales. El consentimiento para una carta privada no equivale a autorización para una web pública.

Para entregar se necesita alojamiento con proceso persistente, HTTPS y disco persistente para SQLite. Debe seguir funcionando con el ordenador personal del autor apagado. Proveedor, coste y publicación se concretan con los recursos autorizados; el plan no contrata ni despliega infraestructura.

Una vista pública de solo lectura puede añadirse después con su contenido revisado. No se necesita inicialmente dividir el frontend, el mundo, la base, una bóveda y la voz entre proveedores distintos.

## Comprobaciones que demuestran el producto

Los controles causales de cuerpos, ecología, aprendizaje, genética, cooperación, invención y organización están en [CIENCIA](CIENCIA.md#controles-que-pueden-contradecir-el-diseño). Los criterios de aceptación del producto pertenecen a [PLAN](../PLAN.md#orden-de-construcción). La integración debe cubrir además:

| Propiedad | Evidencia de ingeniería necesaria |
|---|---|
| Determinismo y cámara | Mismas fuentes, estado y entradas producen el mismo mundo; consultar terreno no cambia azar, historia ni regiones activas. |
| Transacción | Snapshot, archivos, hechos y confirmaciones corresponden al mismo paso. Fallar el commit conserva colas pendientes y no confirma gestos. |
| Identidad y recuperación | IDs monotónicos sin reutilización; parentescos y autores resolubles, sin registros posteriores al corte consultado ni resurrección. |
| Archivo y memoria | Terreno y legados reaparecen tras reinicio; cachés acotadas conservan referencias necesarias y el crecimiento persistente se mide por separado. |
| Acceso y mundo compartido | Dos clientes comparten estado, cámaras independientes y órdenes idempotentes; sin sesión no hay lectura ni escritura y la revocación se aplica a conexiones y entradas pendientes. |
| Navegador | Vistas antiguas descartadas, reconexión, fallecimiento sin controles inválidos, acciones animadas por hechos y comparación gráfica equivalente. |
| Operación y fallos | Copia en destino nuevo, lectura sin migración del origen, reinicio y recuperación explícita; un estado inválido no crea otro mundo. |

Las pruebas unitarias, navegador, soak con commit por paso y observación multisemilla responden preguntas distintas. Los comandos están en README y los resultados ejecutados en EVIDENCIA. Comparar varias semillas sin intervenciones permite descubrir fallos de continuidad que no aparecen en fixtures; no demuestra fiabilidad indefinida. Los hashes identifican el código observado, y cambiar reglas exige nueva evidencia.

El teléfono físico, el alojamiento definitivo y el contenido personal final siguen pendientes. Las escenas íntimas se revisan en privado; las pruebas con otras personas usan material sintético o aprobado. La evaluación busca reconocimiento y comprensión, sin pedir que se confirme una emoción predeterminada.

## Siguiente arquitectura propuesta, no implementada

**Una memoria causal archivada, con conocimiento local finito y producción guiada por necesidades observadas.** Es trabajo futuro, separado de V5 activo. Debe permitir nuevas recetas después de llenar la caché y reconstruir ventanas de materiales sin aumentar indefinidamente la RAM. No arregla por sí sola demografía, división del trabajo ni mantenimiento. El frente de inventarios de apertura tiene un ensayo en el worktree `/tmp/atlas-opening-checkpoints`, sin integrar en main, activar ni incluir en las mediciones vigentes; los otros frentes permanecen como propuestas.

La propuesta se elaboró con consulta textual a Gemini mediante Antigravity y revisión posterior del código. La respuesta externa fue evidencia de diseño, sin acceso al repositorio, secretos, base privada ni ejecución. Sus sugerencias se corrigieron: archivar no debe esperar a que desaparezcan todos los conocedores; los programas ya son secuencias planas acotadas, y guardar recibos después del snapshot de forma asíncrona rompería la durabilidad necesaria. Las fuentes conceptuales están en [CIENCIA](CIENCIA.md#investigación-pendiente-diversidad-y-continuidad-causal).

| Frente y posible propietario | Cambio concreto | Criterio que puede hacerlo fallar |
|---|---|---|
| 1. Contratos tecnológicos — propietario de `shared/technology.ts` y `world/technology.ts` | Separar definición inmutable de receta —ID, firma, versión de leyes, programa, autor y padres— de usos, fabricación y utilidad mutable. El contador de identidad deja de depender de la longitud del catálogo residente. | Evicción o recuperación no reutiliza IDs, cambia programas ni deja un producto apuntando a una receta distinta. |
| 2. Archivo transaccional — propietario de Store y snapshot | Archivar definiciones y recibos en SQLite junto al snapshot; mantener cola pendiente hasta commit y limitar trabajo admitido por paso. Las transferencias conservan pares y los agregados se calculan después de asegurar recibos durables. | Un fallo entre escrituras conserva la cola y el corte anterior; ningún snapshot confirmado depende de recibos todavía no persistidos. |
| 3. Ventanas completas — propietario del adaptador de organización | Guardar inventarios físicos de todos los actores actuales al abrir épocas, con paso, último recibo y digest. Reconstruir intervalos mediante deltas completos y agregados idempotentes por rango. Muertes y salidas cierran existencias explícitamente. | Un actor quieto no pierde su inventario inicial; si falta un movimiento el resultado sigue desconocido. No deducir apertura desde cierre ni censar para siempre a todos los fallecidos como inventarios vivos. |
| 4. Caché y resolución — propietario de tecnología con contrato de archivo acordado | Usar 256 como presupuesto de definiciones residentes, con referencias durables desde lotes, proyectos y procedimientos derivados. Retirar el freno por generación 32 manteniendo límites de operaciones, entradas, trabajo y consultas. Reutilizar programas previos sin expandir toda la genealogía. | Se superan 256 identidades históricas y generación 32 con RAM acotada; reinicio, copias y cortes anteriores resuelven exactamente sus dependencias. |
| 5. Aprendizaje y redescubrimiento — propietario de sociedad y aprendizaje | Separar la caché del servidor del conocimiento finito de cada actor. Enseñar, olvidar o investigar tiene causas y costes. Permitir ensayos pagados con objetos desconocidos; hoy `localInputs` exige conocer su receta. Distinguir padres culturales de muestras materiales. | Perder al último conocedor elimina fabricación sabida hasta enseñanza o redescubrimiento real; heredar o comprar un objeto no entrega su receta. Un ensayo nuevo conserva identidad y procedencia propias. |
| 6. Reposición y coordinación — propietario de decisiones y sociedad | Priorizar producción, aprendizaje e intercambio según desgaste, reservas, demandas pendientes y proveedores conocidos localmente. Describir roles mediante trabajo y dependencias reales; compromisos repetidos pueden fundamentar instituciones revisables posteriores. | Retirar un proveedor indispensable altera entregas y trabajo aunque queden vínculos sociales o ciclos estructurales; no hay profesiones, facciones ni información global impuestas. |
| 7. Diversidad y evaluación — propietario de búsqueda y experimentos | Explorar nichos de capacidades y contextos, con calidad basada en beneficio y coste observados. Reservar intentos exploratorios cuya utilidad sigue desconocida; no exigir superar siempre un récord global. | La novedad sin efecto no recibe utilidad ficticia. Comparaciones emparejadas miden diversidad útil, reproducción de herramientas y coste de exploración, no solo número de nombres. |

Los escritores de tecnología se serializan entre los frentes 1, 4 y 7; archivo y adaptador acuerdan antes el contrato de épocas y referencias. La división anterior es de responsabilidades posibles, no siete ramas autorizadas simultáneamente.

La aceptación conjunta exige varias generaciones humanas y varios recambios completos de herramientas con materia conservada; retirar una entrada o productor indispensable debe interrumpir su dependencia y restaurarlo permitir recuperación observable. Un ciclo histórico mantenido no demuestra disponibilidad actual de quienes saben ejecutarlo. La extinción sigue siendo un fallo aunque el análisis de una ventana antigua permanezca favorable.

Los riesgos principales son duplicar masa al reconstruir transferencias y perder referencias al archivar o recuperar. IDs, integridad, corte temporal y commit atómico deben comprobarse juntos. Una frontera material solo se añadirá si su fabricación y reparación participan causalmente en el circuito; los límites del inventario o de una comunidad no constituyen esa frontera. El archivo puede crecer en disco y necesita presupuesto medido: memoria finita no significa almacenamiento ilimitado.

## Mantener pequeño el proyecto

Terminar una etapa del plan antes de sumar sistemas. Medir rendimiento antes de ampliar población o cambiar renderer. Mantener un documento canónico por tema: PLAN conserva intención y estado de las ideas; REGLAS define mecanismos; CIENCIA fuentes y límites; EXPERIENCIA interacción y voz; CONSTRUCCION arquitectura; README operación; EVIDENCIA resultados de la revisión vigente. Los enlaces evitan repetir especificaciones. Git conserva historia y versiones anteriores; no crear copias históricas ni documentos de fase que compitan con los canónicos.

No se recuperan automáticamente plantillas de CI, comandos de operación, configuraciones de proveedores ni rutas de otros repositorios. Se documentan únicamente los comandos que realmente construyen, comprueban y ejecutan esta aplicación.

Al informar una entrega, distinguir lo diseñado de lo implementado y de lo observado. Nombrar los archivos cambiados, las comprobaciones ejecutadas y lo que no se probó. Este plan queda listo cuando su alcance es coherente; el producto quedará listo cuando la experiencia completa funcione y la carta tenga la voz de Steven.
