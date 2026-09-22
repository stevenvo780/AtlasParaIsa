# Reglas del prototipo

## Candidato V9: competencia observada al preparar reservas

Sobre V8 `eaa2709`, esta propuesta declara **reglas 9**, conservando protocolo 9 y
SQLite 4. Al planear una reserva familiar descarta una fuente cuyo stock observado
puede agotar antes un cosechador visible, ya presente y con trabajo avanzado. Usa
la duración y capacidad físicas existentes; no anticipa elecciones futuras ni
asigna propiedad sobre fuentes. Empates y una ventaja temporal ambigua se admiten;
una intención próxima a reevaluarse o una necesidad urgente también dejan abierta
la incertidumbre. La previsión no consume ni reserva recursos.

La selección para comer, las órdenes explícitas, los costes y los requisitos de
reproducción conservan sus reglas. El trabajo parcial sólo se conserva en un sitio
que siga siendo viable. La migración V8→V9 valida y copia el estado histórico sin
reescribir existencias, genes o trabajo. [Controles y límites de V9](REVISION-CONTENCION-V9-2026-09-22.md).
La propuesta no acredita publicación ni una mejora general de reproducción.

## Candidato V8: provisión familiar local, 22 de septiembre de 2026

Sobre V7 publicado desde `3dd615e`, esta rama declara **reglas 8**, manteniendo
protocolo 9 y SQLite 4. Una intención familiar viable puede planear una cosecha
pequeña físicamente rentable, con las mismas rutas percibidas, esfuerzo, decadencia
y asimilación del motor. La previsión no otorga comida ni energía. El objetivo
validado no se reemplaza por trabajo parcial de otro objetivo. El filtro general
para comer y las reglas reproductivas/corporales no cambian. Los costes, controles
y límites están en la [revisión V8](REVISION-FAMILIA-V8-2026-09-22.md). Es una
propuesta en evaluación; no acredita publicación ni sostenibilidad demográfica.

## Candidato V7, revisión del 22 de septiembre de 2026

La fuente candidata declara **reglas 7, protocolo 9 y SQLite 4**. Aún no acredita una
nueva publicación ni el cierre de la feature 002. Su [revisión y controles](REVISION-2026-09-22.md)
separan los resultados de las referencias históricas que siguen abajo.

Los vecinos fundadores expresan sus alelos mediante la misma ley que sus descendientes;
la caracterización de S/I se conserva. La intención de formar pareja excluye los mismos
parentescos que la reproducción. La enseñanza exige práctica y una posibilidad material
local; no se acredita cooperación enseñando cooperación repetidamente. Una técnica
intermedia puede enseñarse para completar instrucciones ya recordadas. El selector puede
planificar esa cadena dentro de su memoria finita, con materias, herramientas, desgaste,
combustible, energía y trabajo completos. El pronóstico no crea existencias ni enseña
recetas desconocidas; cada acción vuelve a evaluar el estado físico real.

Si beber de un recipiente requiere recuperar capacidad corporal, el agente descansa
localmente cuando puede recuperarla; su sed sólo baja después de retirar agua efectiva.
Cuando la sed fuerza una búsqueda urgente, conserva un destino local viable hasta
alcanzarlo. Percibir agua, un obstáculo o una necesidad que gane la elección puede
interrumpirlo; no obtiene conocimiento de fuentes fuera de su percepción.
Estas correcciones no aumentan longevidad, reservas, nacimientos por intervalo ni el
presupuesto del gobernador.

El lector conserva la compatibilidad con estados V6 válidos mediante una copia y cambio
de versión: no reescribe rasgos, hechos, recibos o existencias históricos. La política de
publicación sigue exigiendo un mundo nuevo separado, mientras los reinicios de esa misma
versión conservan su último estado confirmado. Esta compatibilidad no promete que V6 y
V7 produzcan la misma trayectoria futura.

El protocolo 9 evita repetir dos constantes en cada objeto con metadatos de agua.
El formato de agua versión 1 fija 50 000 cuantos por unidad y denominador de fuga
1 000 000. El cliente conserva lectura de la forma completa anterior, rechaza constantes
contradictorias y distingue contenido desconocido, recipiente vacío y objeto incapaz.
No se redondea agua, se eliminan objetos ni se cambia la instantánea durable.

## Referencia histórica para grabación

La referencia privada activa para grabación es **`03470e3`**, con reglas/protocolo 6 y SQLite 4, publicada y comprobada el 6 de septiembre de 2026. Incluye agua contenida, claros físicos y afinaciones de elección corporal y construcción, además del catálogo resoluble, memoria técnica finita y cuerpo compartido. [EVIDENCIA.md](EVIDENCIA.md#matriz-v6-cerrada-a-veinticinco-días) distingue la captura de 113,35 días de la matriz V6: tres semillas terminaron con 30, 18 y 1 vecinos mortales, y la tercera ya no tiene recambio posible. La fuente experimental `189791d` añade journal sin modificar estas leyes; `4a05bb5` incorpora validación incremental del archivo y continúa sin publicar. Ni las pruebas ni la trayectoria favorable acreditan continuidad indefinida. El [objetivo rector](../GOAL.md) conserva las capacidades pendientes. Las unidades no tienen equivalencia biológica demostrada ni puntúan el amor. La memoria y diferencias provisionales de S e I esperan la voz de Steven.

## Tiempo, paisaje y recursos

El territorio se genera por **regiones de 16 × 16 celdas**, con seis biomas coherentes y coordenadas firmadas. No tiene el borde del mapa inicial; el intervalo técnico es `[-10 000 000, 10 000 000)`. La población inicial conserva catorce vecinos ficticios y S e I. Un paso representa 100 ms; un día del modelo contiene 2400 pasos, cuatro minutos. Amanecer, día, atardecer y noche aportan distinta luz. Cada sesenta segundos simulados se decide el tiempo atmosférico con un generador cuya semilla y estado se guardan.

Humedad, vegetación y alimento están entre 0 y 1 por celda. Cada diez pasos se actualizan los recursos:

- La lluvia y el agua vecina aportan humedad; evaporación y luz la reducen.
- La combinación de luz y humedad favorece vegetación; la sequedad provoca pérdidas.
- Luz, humedad y vegetación permiten regenerar alimento con una capacidad máxima. De noche no hay ese crecimiento.
- Cosechar retira alimento y una pequeña cantidad de vegetación de la celda. El gesto de sembrar introduce explícitamente hasta 0.12 de vegetación y no añade alimento.

V3 añade fertilidad, biomasa vegetal, cultivo, tránsito y una capa celular continua. Esta capa considera los ocho vecinos y favorece ciertos patrones de dos o tres vecinos vivos, modulados por luz, humedad y fertilidad. Influye en el suelo y crecimiento; sequedad y pisoteo la reducen. Es una regla propia inspirada en autómatas celulares, sin implementar Conway ni Lenia. La madera puede recuperarse lentamente consumiendo biomasa bajo condiciones favorables; la piedra no regenera. Cultivar prepara suelo y crecimiento; caminar deja huellas que dificultan la recuperación.

El agua potable es una reserva finita entre 0 y 1 por celda, separada de la humedad del suelo. Charcos, manantiales, humedales y celdas de agua dulce pueden almacenarla. La lluvia recarga solo esos depósitos, los manantiales aportan hasta 0.002 por actualización y la evaporación reduce la reserva. El océano mantiene agua potable igual a cero: su intercambio de agua salada no lo hace bebible. El suelo húmedo común no es una fuente para los habitantes.

Liebres, ciervos, jabalíes, peces, lobos y zorros son individuos persistentes. `animals.ts` conserva sus identidades; `Tile.fauna` es una proyección de compatibilidad, nunca una segunda población que también se reproduzca. Caben seis individuos por celda. El límite de datos residentes es 393216, correspondiente al máximo técnico de 65536 celdas por seis individuos. Por paso avanzan hasta 8192 iniciadores residentes: fisiología, reloj biológico y acciones; hasta 1024 toman decisiones. Un receptor residente fuera del turno puede recibir daño o pagar costes de reproducción causados por un iniciador, sin ejecutar metabolismo, locomoción ni envejecer por esa interacción. Los animales archivados están fuera de la lista residente y permanecen congelados. Es una aproximación por presupuesto, no una capacidad acreditada del servidor a diez pasos por segundo. Comparten con los habitantes `advanceNeeds` de `needs.ts`, con tasas específicas, hambre, sed, energía y fatiga; además tienen salud y mortalidad propias.

Sus seis parámetros heredables son velocidad, percepción, metabolismo, carnivoría, eficiencia hídrica y camuflaje. La percepción local, los recursos y hasta doce recuerdos recientes influyen en explorar, pastar, beber, descansar, cazar o huir. La memoria tiene vigencia acotada y no revela recursos remotos. Los peces usan el hábitat acuático; la fauna terrestre evita agua y edificios. El agua y la biomasa consumidas se debitan del entorno. Depredar exige una presa individual alcanzable; la muerte se resuelve una vez aunque coincidan varios depredadores.

Reproducirse requiere dos progenitores compatibles, madurez, recuperación desde la reproducción anterior, condiciones corporales suficientes, espacio y recursos. Paga costes corporales, 0.06 de biomasa y 0.012 de agua del modelo. La descendencia recibe parámetros de ambos progenitores con variación acotada y memoria propia vacía. La inanición, deshidratación, depredación y senescencia pueden causar muerte animal. La edad biológica y el presupuesto de actividad deben respetar la congelación al archivar; las pruebas de integración verifican esa continuidad. Estos animales no adquieren cultura, oficios ni construcción humanas.

No hay regeneración instantánea para fabricar un encuentro ni un balance termodinámico completo. V5 añade salud, vitalidad, envejecimiento y muerte de vecinos ficticios, con liquidación explícita de sus reservas. S e I tienen una protección externa de diseño, descrita abajo.

Solo las regiones alrededor de habitantes avanzan su ecología. Las demás se archivan y quedan congeladas hasta reactivarse; la cámara consulta terreno y modificaciones sin activar regiones, producir historia ni consumir el azar del clima. SQLite crece con la exploración: extensión procedural no significa almacenamiento ilimitado.

### Claros y arboledas

V6 incorpora una nueva distribución inicial de madera. Un candidato de raíz por bloque global de 2 × 2 celdas y dos campos suaves de hábitat, de escalas 24 y 8, producen claros y agrupaciones en bosque y pradera. Las raíces pueden quedar juntas; el bloque limita densidad, sin imponer obstáculos de movimiento. En las parcelas forestales elegidas se conserva el stock local de hasta doce unidades. No se reducen existencias de regiones ya guardadas para aclarar su dibujo.

Un claro nuevo con madera cero comienza como suelo, bayas, flores o roca según su estado; no se convierte en tocón. Los tocones reales conservan la posibilidad de regenerar bajo las condiciones y costes existentes. Una celda guardada con madera positiva mantiene su depósito aunque no corresponda a una raíz del generador nuevo; una existencia cero no se rellena al cargar. Alimento, vegetación, humedad, agua y los demás campos comparados conservan sus valores iniciales. La distribución es una decisión del modelo, sin calibración botánica. La captura privada y la matriz V6 incluyen estas reservas, pero no aíslan su efecto sobre supervivencia. [EVIDENCIA](EVIDENCIA.md#claros-físicos-y-lectura-del-paisaje) registra las comparaciones y sus fuentes.

## Cuerpos, elecciones y vínculo

Desde `7d8777c`, `body.ts` centraliza avance fisiológico, esfuerzo, asimilación, hidratación y descanso; `needs.ts` conserva la entrada compatible. Humanos y fauna usan esas operaciones en sus acciones reales, con sus tasas existentes. La asimilación y la hidratación reciben solo cantidades ya retiradas del recurso local. El refactor conserva las ecuaciones, el orden de cálculo y los resultados anteriores; no añade unidades físicas, capacidades sociales animales ni continuidad fuera de las regiones activas. La protección de S e I, la reproducción y las pausas sociales mantienen sus reglas específicas. [EVIDENCIA](EVIDENCIA.md#núcleo-corporal-compartido-en-el-código) conserva las pruebas de paridad y sus controles negativos; la publicación privada se acredita por separado.

Cada persona percibe hasta siete celdas de distancia. Compara explorar, comer, cosechar alimento para reserva, beber, cazar, descansar, acercarse, acompañar, tomar espacio, compartir, recolectar materiales, cultivar, construir, ensayar diseños, investigar procesos, fabricar productos, reparar y cooperar según sus necesidades y posibilidades locales. Una intención suele durar tres segundos, con revisión anticipada ante alimento o agua agotados y necesidades urgentes. Cada seis pasos puede avanzar una celda por un camino de tierra; no cruza agua ni se teletransporta.

Hambre, sed, fatiga y energía de actividad usan una escala de 0 a 1. La sed crece más deprisa en desierto; hambre o sed extremas reducen energía. El movimiento consume energía y aumenta fatiga; descansar recupera capacidad de actividad, condicionado por alimento y calidad del refugio. La energía representa disposición para actuar, no una magnitud termodinámica. Una persona sin alimento y con hambre máxima no recupera energía indefinidamente por descansar. Beber retira hasta 0.006 de agua potable por paso y reduce la sed en hasta tres veces esa cantidad.

Comer cosecha como máximo 0.0035 de alimento por paso. Puede guardar un cuarto de lo cosechado en una reserva de hasta 0.25; el resto se consume. Consumir una unidad del alimento del modelo reduce hasta 4.8 unidades de hambre y recupera hasta 1.2 de energía, siempre dentro de sus cotas. Compartir consume 0.025 de reserva del donante, reduce hasta 0.12 de hambre del receptor y recupera hasta 0.03 de su energía; el donante paga un pequeño coste de actividad.

**Cosechar alimento (`forage`)** es una tarea física distinta de comer: exige llegar a la celda y completar `ceil(18 × (1 − 0.25 × habilidad))` trabajos. Cada trabajo consume 0.0003 de energía y añade `0.00025 × (1.2 − 0.4 × resiliencia)` de fatiga. Retira hasta 0.06 de alimento, limitado por la existencia real y el espacio hasta 0.25 de reserva; también reduce vegetación en una décima de lo cosechado. Todo el alimento pasa a la reserva: la cosecha no reduce hambre ni recupera energía directamente. La orden explícita termina después del intento y conserva los costes pagados.

S e I pueden buscar cercanía o necesitar espacio. Un encuentro requiere proximidad y acciones compatibles de ambos; alguien que está explorando o comiendo no recibe automáticamente efectos de compañía porque el otro se acerque. Una pausa compartida puede aliviar fatiga y recuperar algo de actividad, sin crear alimento. Compartir tiempo también puede llevar a tomar espacio. Estar lejos no produce por sí solo un castigo afectivo, y cerrar el navegador no entra en estas reglas.

### Elección según recuperación y riesgo físico

El selector afinado pondera descanso por la recuperación que permite el estado alimentario e hídrico. Su evaluación usa las operaciones corporales existentes sobre una copia: prever una comida, una bebida o un descanso no modifica reservas ni acredita utilidad. La referencia de descanso con calidad unitaria mide solo ese factor nutricional; no atribuye esa calidad al lugar ocupado.

El riesgo evitable añade una prioridad acotada `3.1 × D / (salud + D)`, con cero si no hay daño evitado. `D` es la reducción de daño por hambre, sed o exposición estimada durante un día del modelo —2400 pasos—, descontando viaje y trabajo previstos. Salud y daño usan la misma escala; un día y el peso 3.1 son heurísticas del selector, sin calibración biológica. La senescencia queda fuera de ese incentivo porque protegerse no la elimina. S e I conservan motivos de cuidado aunque superen su edad máxima protegida. No cambian daño, edad, fertilidad ni costes reales.

La protección coincide con la ley demográfica: beneficio del refugio habilitado, terreno de refugio y estructura con techo en la celda, con condición mayor que 0.1. Puede favorecer comer o trabajar a cubierto, además de descansar. Construir o reparar para obtenerla exige que exista la oportunidad local admitida; el pronóstico no regala materiales, progreso ni protección antes de completar la tarea.

Comida, agua y presas se evalúan mediante caminos dentro de las siete celdas percibidas. Una fuente visible aislada por agua no satisface la necesidad; la presa debe seguir viva y su adquisición pasar el presupuesto nominal de viaje y trabajo del planificador. Ese presupuesto no introduce una prohibición física nueva: el esfuerzo real conserva su saturación de energía en cero. Una comida disponible evita premiar una caza especulativa por encima de consumirla. Sin adquisición viable, hambre y sed mantienen la búsqueda local pagada, con destinos alcanzables, aunque el cuerpo esté bajo techo. Esto corrige quedarse descansando junto a recursos inaccesibles; no garantiza hallar recursos antes de morir.

Los controles incluyen comida y agua debitadas, fuentes aisladas, presa inasequible para el planificador y refugio averiado. Un contrafactual natural breve redujo exposición al llegar y reparar un techo; un laboratorio de hambre corrigió inmovilidad bajo cubierta, pero su variante más frágil murió después por exposición. [EVIDENCIA](EVIDENCIA.md#publicación-para-grabación) conserva los negativos y el alcance; esos casos no acreditan supervivencia generacional del conjunto.

## Memoria y costumbre

Los cinco recuerdos iniciales están marcados como **ejemplos sintéticos**. Se activan por lugar y contexto: por ejemplo, un compañero cansado cerca del claro puede hacer que acompañar resulte más atractivo. Un recuerdo irrelevante no aumenta puntuaciones. Recordar desde la interfaz refuerza temporalmente una posibilidad contextual; no impone acción ni reconciliación.

Una costumbre nace al presenciar **dos acciones útiles de compartir** cerca de un lugar. Cada observador guarda quién actuó, para quién, en qué paso y con cuánto alimento. Luego puede repetir la conducta y volver al lugar si percibe una oportunidad útil. El lugar no adquiere una tradición por un temporizador. Los contadores de uso aumentan cuando ocurre cuidado real.

Cada persona conserva hasta ocho experiencias y tres hábitos. Cada hábito retiene dos evidencias iniciales, aunque los hechos antiguos salgan de la crónica reciente, limitada a 120 eventos. El registro persistente de hechos y entradas del servidor es independiente de esta ventana visible y puede crecer con el uso; no se acredita almacenamiento ilimitado ni una política de retención para biografía real.

El interruptor interno `learningEnabled` desactiva la imitación de hábitos y, en V5, las oportunidades de enseñar habilidades y recetas a otra persona. Compartir alimento y comerciar objetos pueden continuar. Investigar o fabricar por cuenta propia conserva su práctica técnica; este interruptor no apaga todo cambio interno. Las pruebas y comparaciones con semillas emparejadas se identifican en [EVIDENCIA.md](EVIDENCIA.md).

## Herencia, práctica y descendencia

Cada habitante tiene siete pares de genes simulados: curiosidad, sociabilidad, disposición al trabajo, cuidado, resiliencia, plasticidad y cooperación. Son parámetros del modelo, sin atribuir ADN ni perfiles psicológicos reales a los personajes. La media de cada par expresa su parámetro; la resiliencia modula el coste de fatiga del movimiento y trabajo dentro de un margen reducido.

Las habilidades generales aumentan tras actividad útil o enseñanza. La práctica tecnológica aprende también de un ensayo físico fallido que consumió materia, sin atribuirle producto ni utilidad. Los valores por contexto y acción cambian con resultados observados: `Q ← Q + α × (resultado − Q)`, acotados a ±0.3. La plasticidad heredable determina `α`, entre 0.04 y 0.20; los fundadores comienzan con 0.12. Un trabajo fallido aporta resultado negativo. El contexto se captura al decidir, antes de recibir el resultado. El aprendizaje cambia valores, habilidades y prácticas, sin reescribir los alelos. Las etiquetas de oficio describen las actividades con al menos tres resultados útiles y no intervienen en las decisiones.

Cada descendiente recibe un alelo de cada progenitor por locus. La variación tiene probabilidad 0.08 por aporte, hasta ±0.08 por alelo, siempre acotado entre 0 y 1. La semilla y la identidad del descendiente hacen reproducible esta recombinación sin consumir el azar del clima. La ficha muestra generación, progenitores, variaciones, plasticidad y cooperación; no expone todos los alelos internos.

Los nacimientos se comprueban cada 120 pasos, como máximo uno por comprobación y hasta **32 habitantes vivos**, incluyendo S e I. Participan únicamente dos vecinos ficticios distintos de la misma comunidad, a no más de tres celdas, con confianza **mutua** de al menos 0.3 y reserva de al menos 0.1 cada uno. Debe existir un lugar compartido a cuatro celdas del primer progenitor; **no tiene que ser un refugio**. Además de madurez y recuperación reproductiva variables, se exige edad anterior a la senescencia, salud de al menos 0.55, vitalidad de al menos 0.5, hambre y sed de hasta 0.45, energía de al menos 0.6 y fatiga de hasta 0.65. Cada progenitor paga 0.08 de alimento y 0.08 de energía; el descendiente recibe 0.10 de alimento. S e I no participan en esta regla.

El descendiente nace en el lugar de un progenitor y empieza sin habilidades, valores aprendidos, hábitos, recorridos, recetas, productos ni recuerdos copiados. Registra su llegada como primera experiencia propia. Recibe la media de las tres prácticas culturales de sus progenitores como crianza inicial, separada del genoma. La transmisión de procedimientos requiere aprendizaje posterior; tener un progenitor inventor no entrega sus herramientas ni su conocimiento.

La preparación local de crianza busca una pareja conocida a siete celdas, de la **misma comunidad**, con confianza mutua de al menos 0.3 y aptitud corporal/reproductiva de ambos. Requiere un lugar percibido a siete celdas del actor y a cuatro de al menos uno de los dos. Puede motivar cosechar hasta una reserva objetivo de **0.12**; cuando el actor alcanza ese objetivo y la pareja conserva al menos 0.1, favorece acercarse físicamente. Para reunirse elige entre lugares percibidos por ambos el de menor suma de distancias, con desempate por identidad; si no existe, se acerca a la pareja. No paga costes ni produce un nacimiento por anticipado. Mantiene proximidad para la comprobación periódica sin garantizar su resultado.

Mientras esa oportunidad local existe, compartir conserva la reserva objetivo y utiliza excedentes; hambre del receptor **mayor o igual a 0.8** permite usar esa reserva, siempre que exista la porción real y se respeten las necesidades del donante. La misma comunidad sigue siendo una condición. La comparación corregida de quince días conserva generaciones nuevas en ambas semillas; cambiar conjuntamente preparación, reserva y acercamiento no aísla el efecto de cada regla. EVIDENCIA conserva sus resultados y límites.

### Salud, longevidad y cierre de una vida

`demography.ts` deriva dos parámetros de los alelos existentes: resiliencia `r` y actividad `a`, ambos entre 0 y 1. Actividad corresponde al locus de disposición al trabajo. Estos compromisos son decisiones del modelo, sin calibración humana:

| Magnitud | Regla |
|---|---|
| Multiplicador de demanda de alimento | `0.85 + 0.4r + 0.2a` |
| Multiplicador de demanda de agua | `1.15 − 0.35r + 0.15a` |
| Madurez | `(1.8 + 0.3r + 0.1a) × 2400` pasos, redondeados |
| Recuperación desde el último nacimiento | `(0.8 + 0.5r + 0.1a) × 2400` pasos, redondeados |
| Edad máxima | `(11 + 4r − a) × 2400` pasos, redondeados |
| Inicio de senescencia | 75% de la edad máxima, redondeado |

La resiliencia reduce daño de exposición y demanda hídrica, pero aumenta demanda alimentaria y demora la reproducción. La actividad aumenta ambas demandas y reduce longevidad. Los multiplicadores participan en el crecimiento efectivo de hambre y sed; no son etiquetas de ficha. Ninguno aumenta necesariamente toda forma de éxito.

Después de las acciones, cada habitante avanza una vez su edad, salud y vitalidad. Hambre extrema, sed extrema y lluvia sin protección suficiente causan daño; alimentación, agua, energía y descanso permiten recuperación acotada. La senescencia acumula daño con la edad y la edad máxima termina la vida del vecino. La persona anciana conserva sus acciones y conocimiento mientras vive, pero deja de ser elegible para reproducirse. No se simula una infancia ni una fisiología humanas completas.

Por estas reglas, tener vecinos vivos no basta para conservar recambio. Si quedan menos de dos vecinos anteriores a la senescencia, contando también a los inmaduros, no podrá formarse otra pareja reproductora sin nuevos entrantes; la edad no retrocede y S/I no se reproducen. Tener dos o más solo conserva posibilidad por edad: todavía exige coincidencia temporal, cercanía, confianza, comunidad y recursos. Es una consecuencia de las condiciones existentes, no un umbral nuevo de nacimiento ni una regla de rescate.

Las muertes del paso se determinan antes de repartir pertenencias: otro vecino que muere simultáneamente no puede recibirlas. Alimento, madera, piedra, productos y residuos pasan únicamente a supervivientes a dos celdas, respetando capacidad. El remanente se registra como pérdida de reservas utilizables, sin aparecer como alimento o materia nuevos en el suelo. La identidad fallecida se retira una vez; se actualizan vínculos y comunidades y no nace automáticamente un sustituto. La causa terminal archivada no describe todas las lesiones previas: una muerte por senescencia puede seguir a daño acumulado por hambre, sed o exposición.

Para S e I, si la transición causaría muerte, la política externa mantiene salud mínima 0.05 y vitalidad mínima 0.08. Conservan necesidades, costes y edad; la protección no resucita una identidad fallecida ni modifica los alelos. Esta excepción de diseño no es una ventaja evolutiva adquirida ni un resultado de autopoiesis.

El registro de una vida conserva identidad, parentesco, genoma, rasgos demográficos, fechas y causa de muerte. El caché residente retiene las referencias necesarias a progenitores de vivos e inventores de planos o recetas, más las 32 identidades recientes, con límite 600. El archivo SQLite conserva las demás; si las referencias excedieran el caché, se rechaza el estado en vez de borrar un ancestro requerido. El límite de vivos es independiente del total histórico de vidas. El formato y la recuperación están en [CONSTRUCCION.md](CONSTRUCCION.md).

En `7d8777c`, una receta fuera de la caché puede resolver a su autor fallecido desde el archivo de identidades, respetando el corte temporal. Conservar autoría no exige cargar todas las biografías ni enseñar el procedimiento a quien consulta su referencia.

## Materiales y construcción

Recolectar requiere hasta 18 pasos de trabajo y retira una unidad base disponible de madera o piedra. Una herramienta de corte o abrasión puede aumentar esa extracción, limitada por el recurso real y el espacio del inventario. Cultivar requiere hasta 45 pasos y una madera: aumenta cultivo, fertilidad y crecimiento, sin alimento inmediato; una herramienta con capacidad de cultivo puede añadir preparación de suelo. Cazar requiere hasta 45 pasos, retira un animal individual y aporta alimento según especie. Estas tres labores reducen hasta un 25% de su tiempo con habilidad. Una construcción usa el coste completo de su plano; el refugio básico conserva seis maderas, tres piedras y 90 trabajos. `completeConstruction`, `invent` y `repair` centralizan el débito de sus respectivas tareas de estructuras; los procesos tecnológicos tienen su propio débito material.

La construcción autónoma compara el servicio adicional local de un plano con las instalaciones funcionales que ya se perciben: protección, agua, alimento y cultivo, considerando condición, reservas y costes. No interpreta usos históricos como ocupación actual ni inventa población para justificar otra obra. La reparación compara recuperación marginal, hasta siete celdas, sobre estructuras con condición menor que 0.95; una estructura dañada pero redundante no gana por estar dañada. Se mantienen las órdenes explícitas, la recolección y los débitos materiales y laborales existentes. Menos edificios no demuestra por sí solo mejor supervivencia; las comparaciones previas mostraron también efectos demográficos adversos.

### Planos, búsqueda y efectos

Un plano es un multiconjunto canónico de componentes. Los nombres describen la receta; las funciones y los costes provienen de sus componentes, sin cambiar el genoma humano.

| Componente | Madera | Piedra | Trabajo | Función |
|---|---:|---:|---:|---|
| Armazón | 2 | 1 | 20 | Sostiene techo; el segundo aumenta durabilidad. |
| Techo | 4 | 2 | 70 | Protección; otro techo amplía captación y descanso. |
| Cisterna | 2 | 3 | 40 | Capacidad de 0.6 de agua, recogida solo con lluvia real. |
| Granero | 3 | 1 | 35 | Capacidad de 0.7 de alimento aportado. |
| Huerta | 2 | 1 | 30 | Irriga cuatro vecinos consumiendo agua de cisterna. |
| Hogar | 1 | 2 | 30 | Mejora descanso en lluvia/noche con combustible. |

Cada receta tiene uno o dos armazones y al menos un techo, sin más techos que armazones. Huerta requiere cisterna. Cisterna, granero y huerta admiten hasta dos módulos y el hogar uno; hasta ocho componentes y cuatro módulos por armazón. El coste total no supera doce maderas ni ocho piedras. El registro admite 64 planos, conservando ancestros y referencias de edificios archivados. El constructor admite 512 estructuras activas. Este espacio de invención es finito.

Ensayar requiere práctica, una madera, energía y necesidades suficientes, y 1200 pasos entre ensayos personales. El contexto usa recursos observados en cuatro celdas y reservas de vecinos próximos. Durante tiempo claro la expectativa de lluvia es un supuesto explícito basado en humedad; únicamente la lluvia ocurrida llena la cisterna.

Se proponen doce variantes: seis combinaciones funcionales comunes a todos los contextos y seis cruces o mutaciones de recetas conocidas. Se descartan recetas inválidas y firmas existentes. Se comparan utilidad contextual prevista, utilidad por coste y distancia a diseños registrados mediante dominancia de Pareto; la selección pondera esos objetivos con 0.76, 0.16 y 0.08. Exige utilidad prevista mayor de 0.035 y mejora de 2% sobre lo conocido. Los padres culturales provienen de diseños propios, edificios observados a cinco celdas o contactos próximos con confianza y apertura suficientes. El azar local de investigación no consume el generador del clima.

Cada ensayo completado cuesta una madera y 60 trabajos, incluido el fracaso. Un diseño aceptado registra autor, variantes anteriores y generación. Su utilidad observada empieza en cero: una predicción no equivale a uso. Los controles exigen que el descanso sin beneficio adicional no incremente utilidad y que captar o verter agua no se confunda con consumo de un habitante.

Cada diez pasos el desgaste reduce condición en 0.00018 con tiempo claro o 0.00028 bajo lluvia, dividido por durabilidad. Con condición menor o igual a 0.1 cesan las funciones. Una cisterna recoge hasta `0.012 × techos × condición` de lluvia, limitada por espacio libre. Conserva el agua dentro del edificio hasta que un habitante la bebe o una huerta la consume; no la vierte automáticamente a otra reserva. `waterAvailable` permite percibir esa fuente y `takeWater` debita exactamente la cantidad bebida. Una huerta reparte hasta `0.008 × módulos × condición` de agua entre cuatro suelos vecinos hasta humedad 0.75; no crea alimento instantáneo.

Un granero recibe hasta 0.012 por visitante próximo y ciclo desde inventario real por encima de 0.12, si el donante no tiene hambre alta. Retirar alimento debita exactamente el depósito; su consumo se acredita una vez. La calidad base del techo es 0.82; otro techo añade 0.09 y otro armazón 0.03, escalados por condición. El hogar puede añadir 0.12 con lluvia/noche y consume 0.0005 de madera del ocupante por paso de descanso activo. Reparar exige treinta trabajos y una madera y recupera hasta 0.4 de condición, sin rellenar reservas.

Beber agua de cisterna, retirar alimento y recibir recuperación corporal adicional actualizan una media acotada de utilidad. La recuperación se compara con lo que habría ocurrido al exterior, respetando saturación del cuerpo. Captar lluvia, aportar alimento e irrigar conservan sus contadores materiales, sin incrementar usos ni utilidad observada. Las oportunidades culturales pueden transmitir un diseño observado; una obra en marcha conserva su receta. Producción, almacenamiento, consumo y beneficio corporal se registran por separado para poder comprobar su causalidad.

`adaptationEnabled`, `noveltyEnabled` y `shelterBenefitEnabled` permiten controles de aprendizaje por resultados, incentivo de novedad/inicio de investigación y beneficio del techo. `learningEnabled` controla imitación y enseñanza social; `cooperationEnabled`, cooperación y dinámicas comunitarias; `reproductionEnabled`, nacimientos de vecinos. Desactivar nacimientos no desactiva mortalidad. Estos interruptores internos no son botones de la interfaz. Las referencias y simplificaciones están en [CIENCIA.md](CIENCIA.md).

## Tecnología procedural: materiales, operaciones y aprendizaje

El catálogo tecnológico empieza vacío y es independiente de los planos de edificios. Un programa declara entradas cuantificadas y una secuencia de operaciones; el nombre no produce sus funciones. Los lotes guardan composición de madera, piedra y agua, propiedades físicas normalizadas, procedencia, receta e identidad. Una unidad del inventario de madera o piedra equivale a **1000 cuantos enteros de masa**; una unidad normalizada de agua potable equivale a 50000. El agua se obtiene únicamente de la celda ocupada y se debita de su reserva finita.

| Operación primitiva | Transformación representada |
|---|---|
| Combinar | Integra sustratos y modifica cohesión, interfaces y palanca; una unión puede ayudar. |
| Separar | Concentra un material y aparta los otros como residuo, con pérdida de cohesión. |
| Formar | Produce geometría de filo, hueco, lámina, vara o grano, retirando material. |
| Abrasionar | Modifica filo y porosidad, con desgaste y residuos. |
| Calentar | Aumenta temperatura y cocción mineral, modifica dureza y fragilidad; consume combustible. |
| Enfriar | Reduce temperatura normalizada; puede recibir ayuda de contención. |
| Comprimir | Reduce porosidad y modifica cohesión, flexibilidad y forma. |
| Trenzar | Requiere suficiente matriz flexible de madera y modifica alineación, cohesión y aislamiento. |

Cada instrucción tiene intensidad entera de 1 a 4. Mezclar varias entradas exige combinar primero. Un fluido puede no conservar una forma, un material sin fibras no puede trenzarse y una matriz orgánica sobrecalentada puede fallar. Las divisiones y el desgaste distribuyen cuantos por composición sin crear ni perder un elemento por redondeo. Son leyes abstractas de materiales: no modelan moléculas, química completa, conducción térmica ni termodinámica real.

Las capacidades de corte, contención, aislamiento, cultivo, unión y abrasión se calculan a partir de propiedades, masa, integridad y temperatura. Los productos conservan propiedades al convertirse en entradas de otros procesos. Las herramientas pueden ayudar o ser un requisito obligatorio: cada operación admite tipos concretos de catalizador y la ausencia del requerido impide ejecutar el proceso. Todos los requisitos declarados deben satisfacerse, no son alternativas intercambiables. Aquí «catalizador» incluye herramientas que se desgastan, una analogía tecnológica distinta de un catalizador químico ideal.

Investigar propone secuencias nuevas, cruces y mutaciones de recetas aprendidas y sustratos disponibles. Puede sustituir materia prima por un producto existente o incorporar otra entrada. Cada persona utiliza su conocimiento y existencias locales; el catálogo mundial no enseña por sí solo. El azar depende de semilla, identidad e intentos personales, sin mover el generador del clima. Las recetas conservan autor, lugar, padres culturales, generación, firma de programa y capacidades. Novedad programática o funcional prevista no equivale a utilidad observada.

Un proyecto conserva su secuencia y progreso. Requiere `10 + 3 × entradas + Σ(3 + intensidad × factor)` trabajos, con factor 3 para calentar y 1 para las demás operaciones. Cada trabajo cobra `0.00045 × (1 − 0.2 × habilidadTecnológica − 0.1 × prácticaDeFabricación)` de energía y añade 0.00032 de fatiga; la práctica es el número de éxitos de esa receta dividido por diez, limitado a 1. Es un coste adicional a las necesidades corporales. Cada calentamiento consume `50 × intensidad` cuantos de madera combustible, primero de residuo disponible y después del inventario; esa materia queda contabilizada como combustible gastado no reutilizable.

Una orden explícita de investigar o fabricar que sea incompatible con el tipo del proyecto anterior lo cancela: conserva trabajo y energía pagados y registra un intento fallido sin producir, consumir ni devolver materia. Otras órdenes y urgencias corporales suspenden el proyecto, conservando su progreso. Antes de liquidar las pertenencias de un fallecido también se cancela su proyecto pendiente.

Las demandas repetidas se suman antes del débito. Sin entradas suficientes no aparece producto. Si faltan recursos al completar un trabajo ya iniciado, su coste corporal permanece pagado. Si falla la transformación tras retirar materia, las entradas quedan como residuos y el combustible continúa gastado. Por cada material se exige: **importaciones = productos actuales + residuos transportados + combustible gastado + pérdidas de legados**. Madera y piedra aún sin importar al proceso pertenecen al inventario general; transferirlas entre personas no crea una segunda entrada tecnológica.

Usar una herramienta retira al menos un cuanto y, normalmente, `ceil(demanda × (2 + 8 × (1 − tenacidad)))`, limitado por su masa. La materia retirada pasa al residuo del usuario y la potencia disminuye con la integridad; si no alcanza el desgaste solicitado, el efecto también se reduce. El uso genera un recibo, pero solo un beneficio positivo aplicado después acredita utilidad, una vez. En recolección se mide la extracción adicional frente a la extracción sin herramienta con el mismo recurso y capacidad; en cultivo se mide la preparación adicional realmente obtenida. El coste de desgaste no desaparece si el resultado externo fue nulo. En fabricación, una ayuda se compara con la misma operación sin ella.

Fabricar reproduce una receta conocida con sus costes y entradas actuales. Una orden explícita puede iniciarla aunque el selector autónomo esté en espera o ya exista una herramienta intacta. Aprender una receta posterior no obliga a conocer la fabricación de sus insumos: pueden obtenerse por intercambio. La competencia por persona y receta registra intentos, éxitos, trabajo y beneficio vivido; la prioridad usa esa práctica propia, no la utilidad global conseguida por otros. Las etiquetas describen práctica, sin profesiones fijas que impongan acciones.

Los presupuestos materiales son explícitos: **hasta doce operaciones y cuatro entradas por programa, 4000 cuantos por entrada, dieciséis productos por persona y 256 recibos recientes**. Al completar un producto con inventario lleno, el de menor capacidad se convierte en residuo conservado y queda registrado. La revisión anterior `bf6431b` limitaba la historia a 256 recetas y generación tecnológica 32: al llenarse cesaban las propuestas nuevas, aunque se podían fabricar técnicas conocidas. El catálogo conectado a Store desde `7d8777c` sustituye esos dos frenos por archivo y memoria finita, descritos abajo; las operaciones y recursos siguen acotados.

El observador separa dependencias estructurales, arranque desde entradas externas y flujos realmente ejecutados. Contabiliza entradas, productos, combustible gastado, residuos, desgaste, transferencias internas y pérdidas. Un recibo ausente, una transacción incompleta o una existencia sin causa impiden certificar el intervalo. Los componentes fuertemente conectados (SCC) solo identifican ciclos. El resultado mantiene `boundary: 'not-modeled'` y `autopoiesisEstablished: false`; sus criterios científicos y limitaciones se detallan en [CIENCIA.md](CIENCIA.md).

### Agua contenida y preparación autónoma

**Contrato V6 incluido en la versión para grabación.** El agua líquida de un objeto se conserva aparte del agua que compone su material. Una unidad de agua potable ambiental equivale a **50000 cuantos**; la escala de masa material mantiene **1000 cuantos por unidad**. El contenido añade peso al inventario y al coste de transporte; no modifica composición ni masa inicial del recipiente. Estos números son unidades propias del modelo, sin equivalencia calibrada a litros o kilogramos.

La capacidad depende de masa sólida, contención, cohesión y porosidad, sin consultar nombre, identidad o generación de la receta. Se calcula con enteros: `floor(8 × masaSólida × contención × cohesión × (1 − porosidad))`, después de cuantizar propiedades a millonésimas. La fuga combina porosidad, falta de cohesión y pérdida de integridad, hasta un máximo de 0,1 % del contenido por paso. Se conserva el resto fraccionario para que guardar, recargar o esperar no evite las pérdidas. Reducir capacidad, transformar o destruir un soporte derrama el exceso; transferencia y herencia conservan el contenido del objeto completo. Las fugas y derrames se contabilizan como pérdidas ambientales; no se devuelven automáticamente a una fuente ni al residuo químico.

Llenar exige posesión, fuente local finita, capacidad, espacio de carga y presupuesto corporal. Cada acción admite hasta **250 cuantos**, cobra 0,00045 de energía y añade 0,00032 de fatiga por trabajo de manipulación; no puede repetirse para el mismo actor y paso. El débito de la fuente corresponde exactamente a lo recibido. Ni llenar ni transportar acredita utilidad: solo la hidratación realmente aplicada al beber registra beneficio.

El planificador autónomo considera las propiedades observables de sus propios recipientes después de hidratarse directamente y cuando sus otras necesidades permiten preparar una reserva. Fija una meta según demanda de 180 pasos, retención prevista y capacidad disponible; no inicia otra preparación si ya lleva al menos el 65 % de la reserva deseada. El trabajo dura como máximo dieciséis pasos y guarda objeto, fuente, cantidad inicial, meta y comienzo. Urgencia corporal, una orden incompatible, pérdida del objeto o de la fuente cancelan el plan; no devuelven el trabajo pagado. La bebida local conserva prioridad y el agua transportada cubre un déficit efectivo.

El balance global exige **llenado = contenido actual + consumido + pérdidas ambientales**. Los recibos separan apertura, cierre, fuente, consumo, fuga, derrame, transferencia y transporte; gasto y beneficio acompañan acciones reales. Solo una época completa permite reconstruir los movimientos por actor y objeto. Un hueco de recibos mantiene desconocida la explicación de ese intervalo, aunque el balance agregado sea válido. [EVIDENCIA](EVIDENCIA.md#transporte-de-agua-v6-integrado) conserva controles de costes, continuidad y observación autónoma.

### Inventarios de apertura

**Activo en la revisión privada.** El checkpoint de versión 1 conserva el paso, contador de ejecuciones y motivo de apertura (`initial`, `migration`, `history-gap` o `roster-change`). Captura al final de un paso los inventarios tecnológicos de **todos** los actores actuales, incluidos vacíos y quietos: ID de cada lote, receta, masa y composición, más residuos por material. Son copias independientes y ordenadas. Materias primas generales y comida corporal no se incorporan a esa apertura tecnológica; las materias primas siguen entrando mediante recibos de importación al usarse.

La época observada empieza en el paso siguiente. Solo admite ejecuciones posteriores al contador guardado, con secuencia completa. La frontera debe coincidir por ambos criterios: los recibos retenidos anteriores o iguales al contador no pueden tener un paso posterior al checkpoint, y los posteriores deben tener un paso mayor. Así una apertura no divide un paso ni oculta movimientos dentro del intervalo declarado. El inventario inicial de la primera transacción de cada actor se compara con su apertura capturada; cada cierre debe enlazar con la apertura siguiente y el último con el inventario final observado. Siguen siendo necesarias las transacciones anidadas completas, los recibos de catalizadores requeridos y ambos lados de cada transferencia interna.

Un actor sin transacciones conserva **lotes y residuos exactos** respecto de la apertura: una alteración silenciosa impide verificar su balance. Para actores con transacciones, los recibos existentes agrupan productos por receta y residuos por material; esa continuidad **no acredita la identidad o composición de cada lote durante todo el intervalo**. Conservar lotes exactos en el checkpoint no amplía retrospectivamente el detalle de aquellos recibos.

Si el búfer pierde movimientos de la época, el resultado permanece desconocido. Al terminar el paso completo, después de muertes, herencias y nacimientos, se captura una apertura física nueva para una época futura; no se certifica el intervalo perdido. Un cambio de población también reinicia la época de forma conservadora. En el mismo paso de esa rotación todavía no hay un intervalo completo. Un V5 antiguo sin checkpoint recibe una apertura en su paso de carga, marcada como migración, sin atribuirla al pasado ni reescribir la base de origen. Al recargar un checkpoint existente se conserva y valida su frontera.

El checkpoint viaja dentro del snapshot y su transacción e integridad ya existentes. Capturarlo no modifica recursos, decisiones, identidades ni azar. Este método mejora la evidencia prospectiva; no produce herramientas, conocimientos ni una frontera material por sí mismo.

### Recibos durables

El búfer reciente conserva 256 recibos. El servicio añade una cola íntegra previa al commit y un archivo SQLite de definiciones, estadísticas y ejecuciones. Un origen durable declara hasta qué serial no se conserva historia: migrar un mundo antiguo puede archivar su tramo reciente, pero no reconstruye los recibos ya descartados. La secuencia posterior debe ser completa y coincidir con el estado confirmado. Un hueco dentro de la cobertura declarada es un error; un prefijo expresamente desconocido sigue desconocido.

El guardado confirma definiciones, estadísticas, recibos y snapshot juntos y solo entonces vacía las colas. El máximo de 65536 recibos pendientes exige confirmar antes de continuar cuando se agota; no habilita pérdida silenciosa. Este control de almacenamiento no aporta materia ni modifica las leyes de fabricación. El adaptador de organización todavía no consulta el archivo para recomponer épocas antiguas, por lo que siguen aplicando las aperturas y límites de observación anteriores.

### Catálogo resoluble y memoria técnica

**Activo desde `7d8777c`, conservado en V6.** El motor mantiene un catálogo histórico en SQLite, una caché de hasta **256 definiciones residentes** y memoria local de hasta **32 instrucciones por persona**. Investigación, fabricación, uso y enseñanza consultan referencias archivadas cuando hace falta. La consulta aporta al motor una definición y sus estadísticas, pero no concede instrucciones, práctica ni conocimiento de recursos remotos a ningún habitante. La publicación comenzó con catálogo vacío en un mundo normal nuevo; la adopción de snapshots anteriores válidos mediante Store es una capacidad de compatibilidad comprobada en copia.

El catálogo conserva IDs, firmas, autores y ascendencia cultural fuera de RAM. Llenar la caché ya no impide proponer una receta; tampoco existe el freno histórico de generación 32 en este modo. Identidades y generaciones siguen limitadas por enteros seguros, y permanecen los presupuestos de operaciones, entradas, materia, trabajo, productos, memoria y disco. Un motor independiente que no adopte el catálogo mantiene los límites anteriores. El archivo de planos constructivos es otro sistema y conserva su gramática y presupuesto.

La memoria usa recencia y protege las instrucciones de proyectos en curso. Enseñar o completar un ensayo puede incorporar una instrucción; los usos de una técnica ya conocida actualizan su recencia. Olvidar retira recuerdos docentes asociados y la práctica que ya no tiene soporte en instrucciones, objetos o proyectos. Portar un producto permite usar sus prestaciones físicas sin saber fabricarlo; comprarlo, heredarlo o resolver su ficha no enseña su receta. La selección de sustratos para investigar todavía exige conocer el procedimiento de un producto derivado; experimentar a partir de un objeto desconocido sigue pendiente.

Redescubrir mediante un ensayo pagado un programa que ya existe en el archivo conserva **la misma identidad, firma, autor y ascendencia**. El ensayo produce su propio recibo e incrementa fabricación y aprendizaje del actor; no reasigna autoría ni crea novedad histórica ficticia. Inventar una variante válida y distinta sí puede incorporar otra definición. La novedad funcional sigue siendo una clasificación de seis capacidades cuantizadas; utilidad solo aumenta por efectos realmente obtenidos.

El catálogo mantiene además una cola de hasta **65536 definiciones nuevas o estadísticas modificadas**, independiente de su evicción de la caché. Store verifica el prefijo comprometido, coincidencia de las referencias residentes, estadísticas y acumulados antes de confirmar sus cambios con los recibos del paso. Estadísticas o funciones inventadas sin registros que las respalden, un hueco cubierto o una firma incompatible impiden el commit y la confirmación de órdenes. Solo `COMMIT` permite vaciar ambas colas; un fallo conserva el estado pendiente para reintentar. La continuidad observada en copia y los ensayos de laboratorio se registran por separado en [EVIDENCIA](EVIDENCIA.md).

## Cooperación, cultura y comunidades

Una oportunidad local de cooperación depende de recursos, práctica, confianza y predisposición. Tras acercarse y trabajar, puede transferir una madera o piedra necesaria para una obra o proceso, añadir trabajo a una construcción o caza, intercambiar materias, enseñar una habilidad superior o mostrar una receta conocida que ya fabricó con éxito. El intercambio se decide sobre personas percibidas a siete celdas y se completa a no más de 1.5. Enseñar una receta cuesta al docente 0.003 de energía y 0.002 de fatiga; no se añade otra vez el coste social general de 0.005 y 0.004. Conserva quién enseñó, a quién y cuándo; no transmite productos, episodios ni alelos. `learningEnabled: false` bloquea enseñanza de habilidades y recetas, incluyendo la llamada directa al transmisor.

Un producto puede intercambiarse por una unidad real de madera o piedra si resuelve una falta de capacidad para recolectar/cultivar, un insumo de un procedimiento solicitado o un catalizador obligatorio. El vendedor no entrega un objeto que su propia tarea necesita, el comprador debe tener capacidad de inventario y el pago no puede aumentar la carencia de sus materias reservadas. El lote conserva identidad, masa y propiedades; dos recibos vinculados registran salida y entrada. Comprar no enseña su receta. Una ayuda de materia prima responde a la demanda del proyecto propio del receptor y no adelanta trabajo gratis. Estos intercambios físicos continúan con aprendizaje social desactivado; `cooperationEnabled: false` los bloquea.

Cada persona tiene tres prácticas adquiridas: compartir, cuidado del entorno y apertura. La primera influye en ofrecer alimento; cuidar el entorno favorece cultivo y reduce el incentivo a cazar la última unidad cuando el hambre no es extrema. Compartir o cooperar con éxito y ciertos resultados de cultivo, recolección y caza ajustan esas prácticas. El contacto positivo aproxima las tres prácticas de ambos participantes, con efecto mayor cuanto más semejantes eran. Apertura interviene en la cooperación entre comunidades y en coordinar turnos. Las prácticas cambian fuera del genoma.

Cada 120 pasos, confianza ganada con contactos a seis celdas, semejanza cultural y un lugar cercano pueden formar una comunidad de al menos tres miembros; caben hasta ocho comunidades. La identidad no se asigna a los fundadores. Un miembro puede dejarla si su cultura se distancia de la media al menos 0.3, la confianza interna media cae por debajo de 0.35 y tiene al menos dos contactos cercanos externos con confianza de 0.3 y distancia cultural menor de 0.2. La lejanía por sí sola no rompe pertenencia.

Los hogares se eligen por calidad observada: agua, alimento, techo y confianza cercana. Esa memoria modifica oportunidades de permanencia y retorno físico. La información lejana pierde vigencia y un lugar agotado deja de justificar arraigo. No se introduce una comunidad inicial para producir un resultado social ni se impide salir por una frontera artificial. La prueba autónoma y el contraste de recursos deben acompañar las pruebas de formación de grupos en escenarios preparados.

Una disputa exige dos personas distintas con comunidad, próximas, con necesidad urgente en ambas, **misma acción de comer, beber o cazar y misma fuente aún disponible pero escasa**. Los umbrales de escasez son hasta 0.06 de alimento, 0.12 de agua o una unidad de fauna. Deben haber pasado 180 pasos desde sus disputas anteriores. La confianza de al menos 0.55 o la apertura media de al menos 0.65 permite acordar un turno: una persona espera doce pasos y deja el acceso a la otra sin aumentar la reserva. Dentro de un grupo, una confianza de al menos 0.25 también evita la disputa sin imponer ese acuerdo.

Si no se dan esas protecciones, el conflicto reduce confianza, aumenta fatiga y tensión y hace que una persona ceda el intento durante treinta pasos. Puede ocurrir dentro de una comunidad o entre comunidades; la diferencia de grupo sola no lo causa. No hay violencia, robo, guerras ni gobiernos.

## Gestos, tareas y una única verdad

Seleccionar cualquier habitante permite solicitar desplazamiento, exploración, cosecha de alimento, recolección de materiales, cultivo, construcción, diseño de edificios, investigación de procesos, fabricación, reparación, caza, bebida, cooperación, descanso o retorno al modo autónomo. Las tareas requieren trayecto físico y respetan urgencias corporales; una tarea admite destinos hasta 4096 celdas de distancia. El buscador de caminos examina un entorno local acotado, por lo que no promete resolver cualquier laberinto distante. Los animales se inspeccionan y siguen sin órdenes humanas. Los gestos ambientales requieren tierra percibida por un habitante.

Sembrar, invitar y recordar tienen tres segundos de separación dentro del mundo. Se validan celda, tipo y contexto. Una invitación dura treinta segundos simulados y solo la perciben personas cercanas; hambre, fatiga y necesidad de espacio pueden hacer que la ignoren. El recordatorio dura sesenta segundos y necesita un recuerdo disponible y su lugar.

Un único mundo del servidor recibe las solicitudes de todos sus clientes. Su CPU avanza diez pasos por segundo, valida sesión, formato y frecuencia, asigna paso y orden, aplica el gesto en una copia del estado y guarda antes de confirmar. Repetir un identificador con el mismo contenido devuelve el resultado guardado; reutilizarlo para otra petición se rechaza. Cada navegador recibe normalmente dos proyecciones por segundo y dibuja su propia cámara; no simula otra población ni accede al generador aleatorio o a los hábitos internos completos. El servicio admite hasta doce conexiones WebSocket simultáneas.

Con el mismo estado e iguales entradas, la evolución es reproducible. La exploración combina rumbo individual reproducible y un registro acotado de 192 celdas recientes; elegir otra acción por memoria o aprendizaje no desplaza el azar futuro de la lluvia. Así se mantienen emparejadas las condiciones atmosféricas en los controles causales.

## Estadísticas, versiones y comprobaciones

La versión para grabación usa **reglas/protocolo 6 y SQLite 4** para agua contenida. Su lector valida primero el estado V5, rechaza campos líquidos falsamente etiquetados como V5 y añade contabilidad vacía sin llenar objetos ni fuentes. Esta compatibilidad no cambia la política de mundo nuevo al publicar.

**Política de pruebas durante esta etapa de desarrollo:** por decisión de Steven, cada nueva versión publicada empieza un mundo limpio en el paso cero, con archivos e historias anteriores resguardados y contraseña estable. Es una operación de publicación, aunque reglas o protocolo conserven su número; no es una regla biológica ni una respuesta automática a errores. Reconectar o reiniciar sin cambiar de versión conserva el último estado confirmado. No se restaura un mundo viejo encima del nuevo ni se reinicia el código o Git. Las sesiones anteriores no pasan al mundo nuevo: se ingresa otra vez con la misma contraseña. [README](../README.md#nuevas-versiones-de-pruebas) define el alcance y [EVIDENCIA](EVIDENCIA.md#publicación-con-mundo-nuevo) registra su aplicación anterior a `7d8777c` y la [publicación para grabación](EVIDENCIA.md#publicación-para-grabación) de `03470e3`. Empezar otra ejecución no acredita continuidad, cooperación ni recuperación de la anterior.

El panel «Vida del mundo» separa población, necesidades, acciones y generaciones de los recursos de las regiones activas. Los acumulados registran acciones reales; la serie reciente conserva hasta 96 muestras, una cada 60 pasos. Fauna, agua y biomas no son un censo de todo el territorio procedural ni solo de la cámara. El rendimiento distingue pasos, guardado, proyección y memoria del servidor de cuadros, cachés y dispositivo gráfico de cada navegador; no mide ocupación de GPU.

V6 conserva **SQLite, esquema 4**, con reglas y protocolo 6. El archivo tecnológico amplía persistencia sin reinterpretar las definiciones materiales históricas. Migrar un estado V4 válido lo copia, añade tecnología vacía, inicializa salud y vitalidad y conserva su edad `tick − bornAt`; los acumulados nuevos empiezan en cero. No crea recetas retrospectivas ni rellena recursos. Leer en modo de solo lectura no cambia el esquema. Un origen fuera de cota se rechaza antes de migrar, sin recortar materia. El inicio V5 archivó el V4 inválido y creó un mundo nuevo; la actualización a `bf6431b` conservó ese mismo V5 al pasar de SQLite 3 a 4. La publicación posterior de `7d8777c` archivó aquella ejecución e inició otra sin cambiar el esquema. [EVIDENCIA](EVIDENCIA.md#publicación-para-grabación) distingue estos antecedentes de la versión para grabación.

Las vidas archivadas son inmutables por identidad, con fecha y digest; su lectura aplica el corte temporal del snapshot. Las regiones conservan versiones por clave y paso. Recuperar un estado anterior en una copia separada no puede incorporarle fallecimientos o versiones futuras del archivo. El caché reciente no reemplaza ese historial persistente ni promete disco ilimitado. Los detalles de almacenamiento, validación y recuperación corresponden a [CONSTRUCCION.md](CONSTRUCCION.md); versiones desconocidas o estados corruptos requieren recuperación explícita, sin crear automáticamente otro mundo para ocultar el fallo.

Las pruebas incluyen controles de recursos y costes, necesidades, memoria pertinente e irrelevante, aprendizaje activado o desactivado, herencia y descendencia, cooperación, comunidades, archivo y continuidad. Los resultados ejecutados, sus cifras y límites se registran en [EVIDENCIA.md](EVIDENCIA.md); esta descripción de reglas no sustituye esa evidencia.

Estos resultados acreditan propiedades del modelo. No demuestran conciencia, una teoría general del cuidado ni que la carta tenga ya la identidad de la pareja. La revisión del contenido real y la prueba de experiencia en un teléfono físico siguen formando parte de la entrega pendiente.

## Parámetros del mundo (`src/world/params.ts`, sprint 2026-09-19)

El módulo `src/world/params.ts` introduce la interfaz `WorldParams` para parametrizar de forma desacoplada la biología, genética, demografía, ecología y persistencia de la simulación. La configuración vive en un `WeakMap` asociado a la instancia de cada mundo sin alterar la estructura del objeto `World`, y se inicializa con `DEFAULT_PARAMS`, un objeto congelado cuyos valores reproducen el comportamiento previo bit a bit. La función `parseParams` procesa diccionarios, cadenas clave-valor o cadenas JSON, validando estrictamente cada parámetro contra los intervalos definidos en `PARAM_RANGES` y lanzando una excepción con un mensaje claro si alguna clave no existe o si el valor numérico queda fuera de rango.

**Los params viajan en la instantánea (R8, 2026-09-19).** Como viven en un `WeakMap` por instancia, un mundo reconstruido desde JSON los perdía: `load()` devolvía un mundo medido con `DEFAULT_PARAMS` aunque se hubiera guardado con otros, y la misma `assertWorld` que aprueba el mundo vivo podía rechazar su archivo. `encodeSnapshot` escribe ahora un campo versionado (`paramsEncoding: 'params-v1'`, `params`) junto a la instantánea —fuera del objeto `World`, que sigue sin llevarlos— y `load()` los restaura con `setParams` **antes** de la validación. Dos consecuencias explícitas: (a) **con los defaults no se escribe nada**, así que la instantánea de un mundo por defecto es bit a bit la de antes de esta ley, y toda instantánea sin campo —cualquiera anterior a R8— se lee como `DEFAULT_PARAMS`; (b) un campo presente se valida contra `PARAM_RANGES` como cualquier entrada: un dígeste recalculado no legitima un parámetro imposible (`Invalid snapshot parameters`).

**Precedencia (R6, 2026-09-19).** De menor a mayor autoridad: `DEFAULT_PARAMS` → params de la instantánea → configuración explícita del despliegue (`CARTA_PARAMS` y la cadencia de producción). `createApp` acepta `params` y se los pasa a `createWorld` al generar un **mundo nuevo** —antes `main.ts` los fijaba DESPUÉS de que `createApp` hubiera generado el terreno, así que `agua.cuencas` no llegaba a tiempo a la generación—; un **mundo cargado** conserva los de su instantánea y el despliegue se aplica **encima, clave a clave**: `parseParams(input, base)` clona `base` en vez de los defaults, y `deploymentParams(base)` (`src/server/deployment-params.ts`) es la receta única que usan producción y las pruebas.

El escalón intermedio tiene que ser alcanzable de verdad. En la primera versión de esta ley `main.ts` hacía `setParams(app.world, parseParams(cadena))` y `parseParams` devuelve siempre un `WorldParams` **completo** (clon de los defaults con los overrides encima), de modo que la línea reemplazaba el objeto entero y borraba los params de la instantánea en el único camino de despliegue real: un mundo generado con `agua.cuencas=1` se recargaba, se medía y se volvía a guardar con 0,4 sin decir nada, simulando un régimen distinto del que lo generó (ronda de corrección R2). Hoy sobrevive toda clave que el despliegue no nombre; reproducción en el worktree con la receta literal de `main.ts` y sin `CARTA_PARAMS`: guardado `agua.cuencas=1, poblacion.maxima=50` → antes `0,4 / 40`, ahora `1 / 50`, con `persistencia.cadaTicks=20` impuesto por el despliegue en ambos casos. **El mundo público no cambia con esto:** su instantánea es anterior a R8 y no declara params, así que su base es `DEFAULT_PARAMS` y el resultado es bit a bit el de siempre.

La refutación está en `tests/params-instantanea.test.ts`: un mundo generado con `agua.cuencas=1` tiene el agua potable de ese régimen (no la del default), un mundo guardado con `agua.cuencas=0.8,poblacion.maxima=50` los conserva al recargar con el mismo dígeste, la receta del despliegue conserva del mundo cargado toda clave que no nombra mientras impone la cadencia, y la instantánea sin campo vuelve a `DEFAULT_PARAMS` por identidad.

**T102, configuración tipada (2026-09-22).** `PARAM_DESCRIPTORS` declara el tipo de cada hoja;
`PARAM_RANGES` conserva sus tuplas numéricas para los consumidores existentes. Se aceptan
booleanos `true`/`false`, enums y arrays JSON además de números. Por ejemplo:
`motor.hilos=8,motor.gpu=[1,0],motor.orden=inverso,motor.clonPorPaso=false`.
Las comas dentro de JSON pertenecen al valor: en el laboratorio
`--param 'motor.hilos=1,8' 'motor.gpu=[],[0],[0,1]'` crea seis combinaciones.
Los arrays conservan su orden, se copian y se congelan; tipos incorrectos, valores no finitos,
claves desconocidas y elementos duplicados en las listas se rechazan.

| Opción reservada | Default | Valores aceptados |
|---|---|---|
| `motor.clonPorPaso` | `true` | booleano |
| `motor.hilos` | `1` | entero de 1 a 512 |
| `motor.soaTerreno`, `motor.particionarPersonas` | `false` | booleano |
| `motor.gpu` | `[]` | índices enteros seguros no negativos, únicos, sin consultar el hardware |
| `motor.orden` | `natural` | `natural`, `inverso`, `adversarial` |
| `persistencia.paginasSucias`, `red.deltas` | `false` | booleano |
| `gobernador.senales` | `["p95"]` | lista no vacía, sin duplicados; sólo `p95` hasta T161 |
| `limites.teselasActivas`, `limites.chunks` | `65536`, `256` | enteros de 1 a `Number.MAX_SAFE_INTEGER` |
| `limites.comunidades`, `limites.fauna` | `8`, `393216` | enteros de 1 a `Number.MAX_SAFE_INTEGER` |

Estas opciones se validan y persisten, pero **T102 no activa backends, deltas ni nuevas señales,
ni cambia los topes de validación o fundación de comunidades**. La ejecución sigue usando el
motor V7 y el gobernador p95 existentes. Los límites son declaraciones pendientes de T100;
no se calculan con memoria o CPU del host. El rango de un índice GPU no acredita que exista
ese dispositivo. Las etapas posteriores deben validar su capacidad real al conectarlas.

El formato `params-v1` sigue siendo legible: un snapshot anterior completa las claves nuevas
con estos defaults y conserva sus overrides históricos. Los defaults siguen sin ocupar un
campo en el snapshot; los overrides antiguos incorporan las nuevas claves al próximo guardado.
`digestoCanonico` conserva todos los parámetros: añadir configuración cambia su hash aunque
el estado físico sea igual. El control separado `scripts/verify-params-baseline.ts` compara
estado completo, orden, aliases, `undefined` y bits numéricos frente a V7, sin debilitar ese digesto.

| Parámetro | Default (calibrado 2026-09-19) | Rango | Ley que controla | Tarea |
| :--- | :--- | :--- | :--- | :--- |
| `cuerpo.longevidadBaseDias` | 11 | [4, 60] | Longevidad base para el cálculo de edad máxima | T001 · R3 |
| `cuerpo.longevidadPorResiliencia` | 4 | [0, 20] | Aumento de longevidad por rasgo de resiliencia | T001 |
| `cuerpo.longevidadPorActividad` | 1 | [0, 8] | Reducción de longevidad por actividad acumulada | T001 · R3 |
| `cuerpo.senescenciaInicioFraccion` | 0.75 | [0.25, 0.99] | Fracción de `maximumAge` donde arranca el desgaste y el riesgo de senescencia | T010 · R3 |
| `cuerpo.riesgoSenescenciaDiario` | 0.04 | [0, 1] | Tasa base diaria del hazard de mortalidad por senescencia | T010 |
| `cuerpo.riesgoSenescenciaPendiente` | 10 | [0, 50] | Pendiente Gompertz de aceleración del riesgo de senescencia | T010 |
| `cuerpo.cuidadoReduceRiesgo` | 0.6 | [0, 1] | Fracción de riesgo/desgaste mitigable por salud y vitalidad plenas | T010 |
| `genes.varianzaFundadores` | 0.15 | [0, 1] | Varianza gaussiana del desplazamiento alélico de los fundadores (heterocigosis inicial) | T011 |
| `genes.tasaMutacion` | 1 | [0, 10] | Multiplicador de la tasa de mutación en linajes | T011 |
| `poblacion.maxima` | 40 | [1, 128] | Techo de crecimiento reproductivo (distinto del techo estructural `MAX_POPULATION=128`) | T012 |
| `poblacion.intervaloComprobacionTicks` | 120 | [1, 10000] | Intervalo de ticks entre comprobaciones de reproducción | T001 |
| `poblacion.nacimientosPorComprobacion` | 2 | [0, 20] | Nacimientos máximos generados por comprobación | T012 |
| `recursos.capacidadBosque` | 1 | [0, 10] | Capacidad de carga (`K`) de vegetación y comida en bosque | T013 |
| `recursos.capacidadPastizal` | 0.7 | [0, 10] | Capacidad de carga (`K`) de vegetación y comida en pastizal | T013 |
| `recursos.capacidadOtros` | 0.35 | [0, 10] | Capacidad de carga (`K`) de vegetación y comida en otros biomas | T013 |
| `recursos.velocidadRegeneracion` | 1 | [0, 10] | Multiplicador de la tasa base de regeneración ecológica | T013 |
| `recursos.decaimientoFertilidad` | 0.001 | [0, 1] | Tasa de decaimiento proporcional por tick de la fertilidad del suelo | T013 |
| `recursos.decaimientoComida` | 0.0001 | [0, 1] | Tasa de descomposición y pérdida de comida por tick | T013 |
| `persistencia.cadaTicks` | 1 (producción fija 100 vía `deployment-params.ts`, ruling R19; antes 20) | [1, 10000] | Cadencia en ticks para el guardado periódico en disco | T021 |
| `persistencia.ventanaEventosTicks` | 0 (sin poda; abrir con `CARTA_PARAMS`) | [0, 1000000] | Ventana de retención temporal para la poda de eventos y chunks | T021 |
| `agua.cuencas` | 0.4 | [0.05, 1] | Umbral de ruido de cuenca bajo el cual una tesela conserva su agua potable de origen | T035 |

> **Rangos de longevidad (revisión de R3, 2026-09-19).** Los tres rangos marcados «R3» se estrecharon respecto de
> T001 porque los anteriores declaraban legales valores que el motor no podía correr. La ley de T010 exige
> `madurez < inicio de vejez < edad máxima` para CUALQUIER genoma, y esa condición depende del genoma: con
> `longevidadBaseDias=1` rompía el 57 % de 2000 genomas uniformes, con 2 el 16 %, con 3 el 0,5 % y con 4 ninguno
> (`localRandom`, sal «probe-r3»). La rotura no se oía al parsear sino a mitad de corrida, cuando nacía el primer
> cuerpo desafortunado, y salía del camino caliente (`bodilyDamage`, `bodyAndAction`, `projectWorld`): una réplica
> de laboratorio moría tras horas y en el servidor público un `CARTA_PARAMS` así habría matado el bucle de tick.
> Un rango por clave no puede expresarlo todo —`longevidadBaseDias=4` y `longevidadPorActividad=8` son legales por
> separado y juntos dan una edad máxima negativa—, así que `parseParams` y `setParams` llaman además a
> `assertLongevityLaw`, que evalúa la ley en las cuatro esquinas de (resiliencia, actividad) ∈ {0,1}²: las tres
> edades son afines en ese par antes de redondear, así que las cuatro esquinas acotan todo el interior. Cuesta
> 201 ns por llamada (el 0,02 % del presupuesto de 50 ms por paso del gobernador) y se paga al fijar los params,
> no dentro del tick. La guarda de `demographicTraits` sigue en su sitio, degradada a aserción de estado imposible.

### Leyes nuevas (calibradas 2026-09-19, fallback analítico; barrido T031 pendiente post-evento)

Las cinco leyes descritas a continuación formalizan las dinámicas físicas, biológicas y de persistencia identificadas en la revisión técnica, ya desplegadas en producción con sus defaults calibrados (commit `835f3d5`, 11:19). Cada una responde a una causa confirmada, asume un coste explícito conforme al Principio I de la constitución y cuenta con pruebas automatizadas que delimitan su refutación. Los valores por defecto de la tabla anterior son el **fallback analítico** de `research.md` adoptado por el límite de tiempo del sprint (ruling R14 del ledger `.superpowers/sdd/tasks/progress.md`): el barrido empírico masivo T031 (rejilla de 16 combinaciones × 8 réplicas × 25 días sobre senescencia, más un barrido de entorno en paralelo) todavía no se ejecutó y queda pendiente post-evento junto con T032 (confirmación larga, 16 réplicas × 25 días).

#### Senescencia como riesgo

Se sustituye el corte abrupto `if (state.age >= traits.maximumAge) {…death='senescence'}` (código previo, `demography.ts:23,82`) por un hazard Gompertz determinista implementado en `src/world/demography.ts`. `maximumAge` (línea 28) y `senescenceStart = round(maximumAge · senescenciaInicioFraccion)` (línea 33, default 0,75) delimitan el intervalo donde operan dos dinámicas simultáneas: un desgaste cúbico saturado de la salud (`senescenceDamage`, líneas 58-62, escalado por la constante `SENESCENCE_WEAR_PER_DAY=0,25` y atenuado por `(1 − cuidadoReduceRiesgo · care)`, con `care = clamp(health · (vitality₀+vitality₁)/2)`) y un riesgo de mortalidad (`mortalityRisk`, líneas 65-82) que integra el hazard sobre el intervalo de edad transcurrido: `hazard = riesgoSenescenciaDiario · geneRelief · (maximumAge / (2400 · riesgoSenescenciaPendiente)) · (exp(exponent(a₁)) − exp(exponent(a₀)))`, con `exponent(age) = riesgoSenescenciaPendiente · ((age − maximumAge)/maximumAge − cuidadoReduceRiesgo · care)` y `geneRelief = 1 − resilience · SENESCENCE_GENE_RELIEF` (constante 0,4); la probabilidad de morir en el paso es `1 − exp(−hazard)`, saturada en 1 si el exponente supera 700 (nunca "inmuniza" a una edad no acotada). La tirada (líneas 115-117) usa `localRandom(seed, \`senescence:${personId}:${tick}:${age}\`)`: es pura en `(personId, tick)`, así que las ~9 llamadas de previsión por persona y tick (`index.ts`, `family.ts`) dan siempre el mismo resultado sin aplicar daño hasta el paso real. La causa de muerte se sigue registrando como `senescence`; S e I protegidos no fallecen por esta vía (pisos `PROTECTED_HEALTH_FLOOR=0,05`, `PROTECTED_VITALITY_FLOOR=0,08`). Este cambio corrige la causa C1: con el corte incondicional, no había ninguna muerte hasta el día 7,4 mientras la población subía de 16 a 32, y luego la ola de senescencia extinguía el mundo hacia el día 15 (494 de 496 muertes, el 99,6 %, eran por este decreto — línea base de 14 réplicas × 25 días, ver EVIDENCIA.md). Conforme al Principio I de la constitución, la ley no introduce rescates artificiales: el coste explícito se manifiesta en el desgaste orgánico acumulado y en la inversión constante de energía y alimento requerida para sostener salud y vitalidad y así mitigar el hazard. La ley queda sujeta a refutación en `tests/senescencia.test.ts`, que comprueba que un cuerpo sano con `age = maximumAge` no muera con certeza en un tick, que la mortalidad acumulada a `2× maximumAge` sea superior a 0,95 en cuerpos descuidados e inferior a 0,5 en cuerpos con salud y vitalidad plenas (medido con 2000 semillas), y que el resultado sea estrictamente reproducible ante una misma semilla.

#### Capacidad de carga por bioma y decaimiento de fertilidad

En `src/world/index.ts` (`ecology()`, líneas 203-229, corre cada 10 ticks) y `src/world/ecosystem-kernel.ts` (línea 97), la regeneración ilimitada se reemplaza por un modelo de crecimiento logístico con capacidad de carga espacial `K = recursos.capacidad{Bosque|Pastizal|Otros}` según el bioma del tile (`tile.biome`), ahora diferenciada por defecto (bosque=1, pastizal=0,7, otros=0,35; antes las tres valían 1). El incremento de biomasa responde a `growth = velocidadRegeneracion · light · moisture · 0,007 · headroom`, con `headroom = 1 − vegetation/K` (frena el crecimiento cerca del límite), aplicando la misma contención logística a la comida (`foodHeadroom = 1 − food/K`) junto con una pérdida continua modelada por `decaimientoComida`. La fertilidad del suelo incorpora además una merma explícita `− decaimientoFertilidad · fertility` en `ecosystem-kernel.ts:97` (`tile.fertility = clamp(fertility + life·0,0012 − traffic·0,0007 − cultivation·0,0002 − decaimientoFertilidad·fertility)`). Esto resuelve la causa C6 identificada en `ecosystem-kernel.ts:94` e `index.ts:203`, donde la fertilidad estática en 1,0 y la ausencia de capacidad de carga saturaban de alimento el 100 % de las celdas de tierra, medido a `t=1251`. El coste explícito de esta dinámica es la limitación material: la biomasa extraída por los habitantes ya no se regenera de forma instantánea ni uniforme en todo el mapa, y exige desplazamiento y gasto de energía metabólica para forrajear en un entorno finito. La regla se refuta en `tests/recursos.test.ts`, verificando que los valores `K=1, velocidad=1, decaimientos en 0` reproducen el estado previo bit a bit tras 2 días, y que una celda saturada sin lluvia decaiga. *(Calibrado 2026-09-19, fallback analítico de `research.md`; barrido T031 pendiente post-evento.)*

#### Agua en cuencas

Ley nueva de T035, sin precedente en el código previo, que resuelve la parte de SC-004 sobre regiones sin agua superficial (medida "antes" en 0,0-0,8 % de regiones secas, muy por debajo del umbral ≥30 %, con el agua potable dispersa en casi todos los chunks — `docs/evidencia-2026-09-19/sc004-antes-recursos.md`). `src/world/agua.ts` define `ruidoCuenca(seed, x, y)`, un ruido espacial de baja frecuencia (escala ~24 celdas, mismo método hash entero + `fade` + interpolación bilineal que usa `terrain.ts` para elevación/humedad, determinista) y `enCuenca(seed, x, y, cuencas) = ruidoCuenca(seed, x, y) < cuencas`. En `src/world/ecosystem.ts:61`, la asignación de agua potable de una tesela queda condicionada a ese relieve: `result.drinkingWater = ocean ? 0 : potable > 0 && ruidoCuenca(seed, tile.x, tile.y) >= cuencas ? 0 : potable;` — fuera de la cuenca (ruido ≥ `agua.cuencas`) la tesela pierde su agua potable de origen (manantial, charca o humedal), aunque conserva `moisture` (la lluvia sigue funcionando igual). Con `cuencas=1` el ruido nunca alcanza el umbral y no se filtra nada (control bit a bit); con el default desplegado `agua.cuencas=0,4`, el informe de T035 midió en un fixture de 4 chunks un salto de 0 % a 75 % de regiones sin agua superficial y de 3,92 a 15-16 celdas de distancia media a agua potable, muy por encima de los umbrales ≥30 %/>6 de SC-004 (`.superpowers/sdd/tasks/T035-report.md`). La regla se refuta en `tests/agua.test.ts`: `cuencas=1` reproduce el mundo semilla 4821 idéntico tras 1 día; `cuencas=0,4` da ≥30 % de regiones sin agua superficial y distancia media >6 en un mundo de 4 chunks; el resultado es determinista entre dos mundos idénticos.

#### Elección de pareja y reemplazo

La reproducción en `src/world/index.ts` (`reproduce`, línea 932) abandona la selección posicional del primer habitante del arreglo y adopta una búsqueda basada en afinidad determinista entre candidatos elegibles, considerando proximidad espacial (distancia ≤3), vínculo mutuo existente (`bonds≥0,3` en ambos sentidos) y exclusión de parentesco cercano mediante `closeKin` en `src/world/lineage.ts`, con desempate por `pairTie`. Los nacimientos quedan regulados por el tope paramétrico `poblacion.maxima` (ahora 40, antes fijo en 32) y hasta `poblacion.nacimientosPorComprobacion` nacimientos por comprobación (ahora 2, antes 1) si hay hueco, emitiendo un evento en la crónica con los progenitores y la ubicación. La ley corrige la causa reproductiva detallada en `index.ts:906-931`, donde un nacimiento por comprobación de 120 pasos y la prioridad por orden de inserción concentraban la paternidad y congelaban la mezcla al llegar al tope de 32. Es importante distinguir `poblacion.maxima` (techo funcional de crecimiento, evaluado en `reproduce()`) de `MAX_POPULATION=128` (`src/world/index.ts:31`), el techo estructural duro usado por `assertWorld` (`index.ts:1039,1070`, vía `Math.max(MAX_POPULATION, poblacion.maxima)`) para dimensionar los arreglos válidos de personas y actores de eventos; este segundo techo se corrigió de 32 a 128 en el commit `c331799` del sprint, tras detectarse que el checkpoint tecnológico abortaba la simulación al superar los 32 habitantes. El coste explícito radica en el tiempo y la energía dedicados a la interacción social y la cercanía física necesarias para consolidar afinidad antes de procrear, y en el propio tope paramétrico que sigue impidiendo el crecimiento sin límite. La verificación en `tests/family.test.ts` y `tests/demography.test.ts` refuta la regla si el coeficiente de Gini del número de hijos por progenitor no se mantiene por debajo de 0,5 tras 10 días con 32 habitantes (población fija del escenario de prueba, independiente del default de `poblacion.maxima`), si ocurre incesto directo, o si el resultado deja de ser determinista ante la misma semilla.

#### Persistencia

La rutina de guardado en `src/server/app.ts:189` (`stepOnce`) condiciona la llamada a `store.save` a la presencia de gestos válidos o al cumplimiento de la cadencia `world.tick % persistencia.cadaTicks === 0`; un gesto confirmado siempre fuerza un guardado inmediato en su propio paso. El default de `params.ts` mantiene `cadaTicks=1` (bit a bit igual al comportamiento previo); producción lo sobreescribe a `cadaTicks=20` (2 s a 10 Hz) en `PRODUCTION_PARAMS` (`src/server/deployment-params.ts`), que además admite la variable de entorno `CARTA_PARAMS` para ajustar cualquier parámetro sin tocar código (p. ej. `CARTA_PARAMS='persistencia.ventanaEventosTicks=20000'`). En cada guardado, `src/server/store.ts` ejecuta `assertWorld(world, world.version, this.context)` (línea 658) antes de codificar el snapshot — la escritura exige la misma ley de frontera que la lectura, así que ya no se archiva un estado que `load()` luego rechazaría. Si `persistencia.ventanaEventosTicks > 0` y se cumple el intervalo, `save()` poda eventos con `tick < world.tick − ventana` (conservando un dígeste de continuidad verificable sin releer lo borrado) y, para los chunks archivados, conserva solo la versión vigente de cada clave; el default de `params.ts` sigue en `ventanaEventosTicks=0` (sin poda) — **no se abrió todavía en producción**, queda en el checklist de T043. Los respaldos forman una **cadena de tres eslabones** (`SNAPSHOT_SLOTS = [0, 1, 2]`, `store.ts`): cada guardado copia el slot 0 al slot 1, y cada `DEEP_CHECKPOINT_EVERY_SAVES=100` guardados confirmados copia además al slot 2, de modo que el eslabón más profundo mide minutos y no el último guardado. Hasta la ronda R2 (2026-09-19) esa profundidad era **inalcanzable**: el slot 2 se escribía y no lo leía nadie. Hoy la recorren los dos caminos, con leyes distintas y deliberadas:

- **En caliente (`load()`)** se salta únicamente el **daño físico** de un eslabón —fila ausente, checksum roto o JSON ilegible—, que es justo para lo que existen las copias. Una instantánea que se lee entera pero **infringe una ley** no se sustituye por un respaldo: taparía un estado inválido en vez de recuperarlo, así que sigue fallando cerrada con su mensaje de siempre (Constitución VI). Además, un respaldo solo entra en caliente si el archivo durable **no guarda nada posterior** (gestos, regiones dormidas, identidades, observaciones técnicas o sucesos de la crónica): si el archivo avanzó, adoptarlo tiraría lo ya vivido y el arranque se niega con `Backup snapshot is behind the durable archive`.
- **En recuperación explícita (`previous()`, `npm run recover:previous -- <dir> [--slot 1|2]`)** se rebobina al primer respaldo **verificable** desde el eslabón pedido (1 por defecto, con caída automática al 2), en una copia NUEVA que poda entradas y hechos posteriores y revoca las sesiones. El comando informa de qué eslabón restauró, y la copia recuperada empieza su propia cadena (no hereda los respaldos del original, que serían posteriores al punto restaurado).

**Un cuerpo no verificado nunca entra en un respaldo (ronda de corrección R2).** La rotación copia el slot 0 tal cual, así que leer la cadena en caliente abrió un agujero nuevo: con el slot 0 físicamente dañado el arranque ya no se negaba, y el primer guardado —cada `cadaTicks=20`, unos 2 s en producción— copiaba ese cuerpo podrido encima del respaldo que acababa de salvar el arranque. Es decir, «fallar cerrado con la red intacta» se convertía en «arrancar solo y borrar la red», con el slot 2 normalmente ausente porque exige cien guardados de la misma ejecución. Hoy `save()` solo rota cuando el cuerpo del slot 0 se lee entero: tras un rescate se salta la copia 0 → 1 (y la 0 → 2), y la rotación se reanuda sola en el guardado siguiente, cuando el slot 0 ya es una instantánea escrita y verificada por el propio proceso. Reproducción del escenario del revisor, antes → después: `slot 1` pasaba a `{}` en el primer guardado; ahora conserva el mundo del respaldo (tick 0) mientras el slot 0 avanza a tick 2, y en el guardado siguiente la cadena vuelve a su forma normal (slot 0 = 3, slot 1 = 2). La otra puerta ya estaba cerrada y sigue cerrada: una conexión que **no** ha cargado no puede guardar sobre un slot 0 ilegible, porque la línea base de la crónica lo rechaza (`baseline snapshot checksum mismatch`).

**Un rescate se cuenta, no se esconde (ronda de corrección R2).** Adoptar un respaldo es un retroceso, y mientras fue silencioso la crónica que Isa lee publicaba «el mundo retoma desde su último momento guardado», que tras un rescate es falso. `load()` devuelve ahora el eslabón adoptado, por qué se saltó cada uno y el momento del eslabón dañado; con eso `app.ts` (a) avisa por consola al operador, (b) declara `respaldo: { slot, retrocesoSegundos }` en `/health` y (c) redacta el suceso de pausa con la verdad: «El último momento guardado no se pudo leer y el mundo retoma desde un respaldo anterior», con la causa diciendo qué eslabón se adoptó y cuánto se perdió. El retroceso se mide en **segundos de servicio**, no en pasos, y es deliberado: el cuerpo que superaba al respaldo es ilegible, así que sus pasos no se pueden saber; cuando ni su fila existe, el suceso lo dice sin número en vez de inventarlo. Sin rescate, el suceso conserva palabra por palabra la frase de siempre. Refutación en `tests/rescate-respaldo.test.ts`.

Advertencia honesta sobre la profundidad: el contador de guardados que gobierna el slot 2 vive **en memoria del proceso** (`store.ts`, `private saves = 0`), no en `metadata`; es deliberado, porque el mismo contador obliga a la revisión completa (`assertWorld`) en el primer guardado de cada proceso. En la práctica eso significa que el respaldo profundo aparece tras cien guardados **de la misma ejecución** (≈200 s de servicio continuo con `cadaTicks=20`) y que un ciclo de reinicios más rápido que eso nunca lo escribe.

El motor SQLite corre con `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` (antes `FULL`, cuyo fsync por tick consumía el 48 % del tiempo de paso — hallazgo C3), de modo que un corte de luz arriesga como máximo el último commit (≤`cadaTicks` pasos, ≤2 s en producción), nunca una base corrupta. El bucle del servidor usa un `setTimeout` re-planificado con compensación de deriva (`app.ts:333-336`) en vez de `setInterval`, apoyado en la métrica `runtime.tickHz`. Esta ley resuelve las causas C3/C12 (`app.ts:142-146`, p95 de 131,9 ms por clonado y guardado síncrono en cada paso con 32 habitantes, sobre un presupuesto constitucional de p95 < 50 ms), C5 (`store.ts:598-603`, crecimiento sin poda de ~7 KB/tick, unos 260 MB por hora real) y H2 (`store.save()` aceptaba antes un estado que `load()` rechazaría; reproducido). La refutación corre en `tests/server.test.ts`, `tests/store-*.test.ts` y `tests/chronicle-store.test.ts`: con cadencia 20, un gesto fuerza guardado inmediato; la poda conserva la última versión de cada chunk y los eventos dentro de la ventana; y `load()` bajo escritura concurrente no falla. La cadena de respaldo tiene su propia refutación en `tests/store-persistence.test.ts`: con el slot 0 dañado se adopta el slot 1; con los slots 0 y 1 dañados se llega al slot 2 y `previous()` lo restaura (devolviendo `2`) en una copia que arranca con un único respaldo; si el archivo durable guardó algo posterior al respaldo, el arranque se niega en vez de tirar lo ya vivido; y el guardado que sigue a un rescate deja intacto el respaldo que lo salvó —también el profundo— y reanuda la rotación en cuanto la cadena está sana.

*Los defaults de la tabla de arriba están calibrados y desplegados en producción desde el 2026-09-19 (commit `835f3d5`), pero como fallback analítico de `research.md`: el barrido empírico T031 (rejilla de calibración con réplicas del laboratorio) todavía no se ejecutó por el límite de tiempo del sprint y queda pendiente post-evento junto con T032; sus resultados, si difieren, se registrarán aquí y en EVIDENCIA.md.*
