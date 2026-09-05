# Cómo construir y comprobar la primera entrega

Referencia de alcance: [PLAN.md](../PLAN.md). Referencia de comportamiento: [EXPERIENCIA.md](EXPERIENCIA.md).

Estado del código: prototipo reversible V4, con interfaz WebGL2/Canvas 2D/DOM, servidor HTTP/WebSocket, autenticación privada, SQLite y pruebas ejecutables. El [README](../README.md) documenta los comandos reales y [EVIDENCIA.md](EVIDENCIA.md) el estado comprobado y activado. Los recuerdos son sintéticos; no hay publicación ni alojamiento contratado. Los comandos, versiones y resultados de otros repositorios no se trasladan como capacidades existentes.

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
  world/       reglas, necesidades, animales, invenciones, ecología y sociedad
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

Las reglas y el protocolo están en versión 4, mientras SQLite mantiene esquema 2. La migración valida la versión de origen antes de enriquecerla. Conserva las celdas y campos anteriores y asigna valores nuevos reproducibles; los acumulados nuevos empiezan en la migración, sin inventar antecedentes. La fauna V3 se materializa una vez por unidad existente; una colección V4 vacía es un dato explícito que impide regenerarla. Los refugios previos reciben un plano básico. Las regiones guardan identidades y estructuras junto a terreno; la cámara solo proyecta esos datos. Una versión desconocida o corrupta se rechaza y nunca dispara un mundo nuevo silencioso.

## Una única verdad del mundo

El servidor decide qué ocurre para todos los clientes. Cada navegador dibuja, interpola posiciones y envía solicitudes al mismo mundo; abrir otra sesión no crea una simulación personal. Mover una cámara no cambia el estado de los habitantes. Las órdenes de clientes distintos entran al mismo orden de aplicación, sujeto a validación y guardado.

Un paso de simulación sigue un orden estable:

1. Incorporar entradas aceptadas.
2. Actualizar ambiente, recursos y necesidades.
3. Construir percepción local y recuperar recuerdos pertinentes.
4. Elegir o continuar acciones; resolver efectos y encuentros.
5. Actualizar memoria, hábitos, comunidades, posibles nacimientos y estadísticas.
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

El snapshot conserva la codificación de celdas activas en tuplas JSON versionadas (`tiles-tuple-v1`) introducida en V3 para evitar repetir veinte nombres de campo por celda. Mantiene los números originales sin cuantización. El lector admite snapshots de objetos y tuplas; los archivos de regiones conservan su formato de objetos y el esquema SQLite sigue en versión 2. Se rechazan valores opcionales presentes nulos o no finitos antes de escribir, para no confundir corrupción con ausencia. La copia del estado para cada transacción aprovecha que las celdas son planas; los individuos y estructuras mantienen copias independientes. La retirada de regiones conserva también fauna y edificios. Las pruebas verifican identidades, contadores monotónicos y recuperación sin duplicación ni envejecimiento oculto.

Se conservan un punto de recuperación anterior y una copia de seguridad. Al arrancar se valida la versión y la integridad del estado antes de avanzar. Un fallo de lectura no crea silenciosamente otro mundo: se conserva la evidencia y se recupera un estado válido mediante una operación explícita.

Hay dos ausencias diferentes:

- **Isa cierra el navegador:** el servidor sigue avanzando y guardando. Su última visita sirve para seleccionar la crónica, no para calcular hambre o afecto.
- **El servicio se detiene:** la primera versión recupera el último estado confirmado y retoma desde allí. El intervalo de caída queda registrado como pausa; no se inventan encuentros ni se simulan meses retrospectivos para disimularla.

Esta política evita un sistema de recuperación temporal complejo. La entrega debe mostrar con honestidad las pausas técnicas y la reconexión. Si falla el guardado, no se confirman más cambios persistentes: se protege el último estado coherente y se informa la indisponibilidad.

## Conexión e interacción

El protocolo V4 conserva ventanas de cámara con origen absoluto y órdenes individuales idempotentes; incorpora animales, planos, estructuras y sus estadísticas. Las nuevas órdenes humanas son ensayar diseños y reparar. Ventanas distintas del mismo paso son válidas; una vista antigua no puede sustituir un paso posterior. El intercambio JSON incluye estado inicial, actualizaciones, solicitud de gesto u orden, resultado y error comprensible. Se envían vistas completas acotadas por cliente; no hay una simulación nueva asociada a cada conexión.

Cada vista lleva versión y secuencia. El cliente descarta vistas antiguas y obtiene una nueva al reconectar. Un cliente lento no puede acumular mensajes sin límite: recibe la vista reciente disponible.

Los gestos se validan en el servidor: sesión autorizada, forma y objetivo válidos, límite de frecuencia e identificador único. La confirmación de recepción distingue entre una entrada inválida y una invitación válida que el habitante no atendió. La interfaz comunica esa diferencia con claridad.

## Acceso, material personal y alojamiento

La primera entrega se diseña privada para Steven e Isa. Una contraseña verificada con scrypt y una sesión revocable controlan lectura y gestos; las credenciales se guardan fuera del repositorio y del código del navegador. No hay una plataforma de cuentas individuales ni mundos separados por persona. Un enlace difícil de adivinar no sustituye el control de acceso.

La selección de recuerdos debe indicar qué contenido puede ver esa audiencia. El material original se consulta en su ubicación autorizada y no se copia al repositorio, a logs, a prompts externos ni a la base operativa del mundo. Los textos que entren a la aplicación se revisan; también se revisa el contenido derivado que aparezca en diario o fichas.

Si se retira un recuerdo, se retiran sus derivados accesibles y se evita reintroducirlo al restaurar copias. El mecanismo concreto se documenta al incorporar datos reales. El consentimiento para una carta privada no equivale a autorización para una web pública.

Para entregar se necesita alojamiento con proceso persistente, HTTPS y disco persistente para SQLite. Debe seguir funcionando con el ordenador personal del autor apagado. Proveedor, coste y publicación se concretan con los recursos autorizados; el plan no contrata ni despliega infraestructura.

Una vista pública de solo lectura puede añadirse después con su contenido revisado. No se necesita inicialmente dividir el frontend, el mundo, la base, una bóveda y la voz entre proveedores distintos.

## Comprobaciones que demuestran el producto

| Comprobación | Evidencia necesaria |
|---|---|
| Cámara independiente | Ventanas negativas y lejanas no cambian estado, azar ni descubrimientos. |
| Archivo de regiones | Modificar, abandonar, guardar, reiniciar y regresar conserva terreno, estructuras y descubrimientos. |
| Construcción y aprendizaje | Materiales y trabajo necesarios; éxito y fracaso modifican valores, y desactivar la actualización conserva costes y habilidades. |
| Control individual | Desplazamiento físico más allá del mapa anterior, necesidades urgentes y retorno a autonomía. |
| Ecología | Agotar un recurso altera crecimiento o rutas; se explican entradas y pérdidas; no aparecen cantidades negativas ni recuperación oculta. |
| Agua y fauna | Suelo húmedo y océano no dan agua potable; recarga acotada, caza con débito y migración sin duplicación; reproducción animal consume biomasa y agua. |
| Fauna individual y presupuesto | Identidades y edad biológica conservadas en archivo; superar el presupuesto por paso reparte actividad sin perder individuos ni detener el mundo. |
| Invención y estructuras | Gramática válida, costes únicos, linaje cultural conocido, depósitos conservativos, utilidad cero sin beneficio y reparación con costes. |
| Arraigo autónomo | Una semilla sin órdenes forma comunidades y cooperación; retirar recursos puede cambiar el atractivo del hogar sin teletransporte. |
| Herencia y crianza | Cada locus recibe aporte de ambos progenitores; variar aprendizaje no reescribe alelos; descendencia conserva costes, condiciones, límites y experiencia propia. |
| Cooperación y comunidades | Materiales, trabajo, trueque y enseñanza producen cambios reales; pertenencia depende de confianza y cultura locales, con alternativas para revisarla. |
| Disputa y turnos | Dos personas distintas compiten con la misma acción por la misma fuente escasa; controles de abundancia, urgencia, confianza y apertura; espera efectiva sin inventar recursos. |
| Cuerpo y vínculo | Cambiar una necesidad o una interacción altera una elección y una señal corporal. La distancia por sí sola no determina deterioro afectivo. |
| Memoria causal | Mismo estado y semilla con y sin una memoria pertinente: cambia una elección prevista. Un recuerdo irrelevante sirve de control y no debe producir ese mismo efecto. |
| Agencia individual | S e I muestran preferencias diferentes bajo condiciones comparables; las intenciones no son anuladas después por un paseo aleatorio. |
| Cultura | Una costumbre tiene una cadena de acciones e imitación identificable; desactivar el aprendizaje elimina esa transmisión. |
| Reproducción de ejecución | Mismo estado inicial, reglas y entradas aplicadas en los mismos pasos y orden producen el mismo estado de simulación, independientemente del dibujo. |
| Continuidad | Recargar conserva el mundo; cerrar todas las pestañas no detiene el servidor; reiniciar conserva cuerpo, memoria, intención y azar guardados. |
| Mundo compartido | Dos clientes con cámaras distintas reciben el mismo paso y población; una orden aceptada es visible para ambos; desconectar clientes no multiplica ni detiene pasos. |
| Renderizado | Comparar escena equivalente con y sin WebGL2; documentar dispositivo, cachés, pérdida de contexto y alternativa 2D, sin llamar GPU física al software. |
| Fallos | Estado corrupto no inicia un mundo nuevo; un error de guardado no recibe confirmación exitosa; un gesto reenviado no duplica efectos. |
| Acceso y privacidad | Una petición sin sesión no lee ni modifica el mundo privado. Bundle, mensajes y logs no incluyen conversaciones originales ni datos personales no aprobados. |
| Crónica | Cada episodio mostrado corresponde a hechos guardados; no se inventan escenas para llenar una ausencia o una caída. |
| Móvil y experiencia | En un dispositivo real se puede entrar, leer, explorar, encontrar a S e I y usar gestos sin sonido. Se comprende al menos una causa y una consecuencia. |

Las comparaciones causales mantienen iguales las demás condiciones. No se llama integración a una diferencia provocada simplemente por eliminar acciones posibles del grupo de control. Para resultados probabilísticos se usan varias semillas emparejadas y se registra el efecto observado, sin convertirlo en una medida de conciencia.

El código incorpora comandos de tipos, pruebas y compilación (`npm run check`), pruebas de navegador (`npm run test:e2e`) y una ejecución acelerada con guardado por paso (`npm run test:soak`). Las suites cubren mecanismos y controles concretos; la lista anterior también incluye criterios de revisión. Las cifras aprobadas, condiciones medidas y omisiones deben consultarse en [EVIDENCIA.md](EVIDENCIA.md), sin trasladar recuentos de versiones anteriores al cierre actual.

Antes de entregar se comprueban también reconexión, reinicio, restauración de copia y varios ciclos de día y noche. El script de ejecución prolongada registra duración, configuración, recursos y fallos en `artifacts/soak.json`; es una ejecución acelerada, no una estancia equivalente en tiempo real. Una prueba prolongada no acredita por sí sola fiabilidad indefinida. El teléfono físico, el alojamiento privado y el contenido personal final siguen pendientes.

Las escenas con datos íntimos se revisan en privado. Las pruebas con otras personas usan material sintético o aprobado para esa audiencia. La evaluación busca saber si se reconoce a la pareja y se entienden las decisiones, no pedirle a alguien que confirme una emoción predeterminada.

## Mantener pequeño el proyecto

Terminar una etapa del plan antes de sumar sistemas. Medir rendimiento antes de ampliar población o cambiar renderer. Mantener un documento canónico por tema: PLAN conserva intención y estado de las ideas; REGLAS define mecanismos; CIENCIA fuentes y límites; EXPERIENCIA interacción y voz; CONSTRUCCION arquitectura; README operación; EVIDENCIA resultados de la revisión vigente. Los enlaces evitan repetir especificaciones. Git conserva historia y versiones anteriores; no crear copias históricas ni documentos de fase que compitan con los canónicos.

No se recuperan automáticamente plantillas de CI, comandos de operación, configuraciones de proveedores ni rutas de otros repositorios. Se documentan únicamente los comandos que realmente construyen, comprueban y ejecutan esta aplicación.

Al informar una entrega, distinguir lo diseñado de lo implementado y de lo observado. Nombrar los archivos cambiados, las comprobaciones ejecutadas y lo que no se probó. Este plan queda listo cuando su alcance es coherente; el producto quedará listo cuando la experiencia completa funcione y la carta tenga la voz de Steven.
