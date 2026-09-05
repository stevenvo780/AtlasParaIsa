# Reglas del prototipo

Estas reglas describen los mecanismos **V5 del código en integración** en `src/world/`. No afirman que esa versión esté desplegada: la revisión privada continúa en V4 hasta que [EVIDENCIA.md](EVIDENCIA.md) documente otro estado comprobado. Las unidades del modelo no tienen equivalencia biológica demostrada ni puntúan el amor. La memoria y las diferencias provisionales de S e I son ejemplos de diseño pendientes de la voz de Steven.

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

## Cuerpos, elecciones y vínculo

Cada persona percibe hasta siete celdas de distancia. Compara explorar, comer, beber, cazar, descansar, acercarse, acompañar, tomar espacio, compartir, recolectar, cultivar, construir, ensayar diseños, investigar procesos, fabricar productos, reparar y cooperar según sus necesidades y posibilidades locales. Una intención suele durar tres segundos, con revisión anticipada ante alimento o agua agotados y necesidades urgentes. Cada seis pasos puede avanzar una celda por un camino de tierra; no cruza agua ni se teletransporta.

Hambre, sed, fatiga y energía de actividad usan una escala de 0 a 1. La sed crece más deprisa en desierto; hambre o sed extremas reducen energía. El movimiento consume energía y aumenta fatiga; descansar recupera capacidad de actividad, condicionado por alimento y calidad del refugio. La energía representa disposición para actuar, no una magnitud termodinámica. Una persona sin alimento y con hambre máxima no recupera energía indefinidamente por descansar. Beber retira hasta 0.006 de agua potable por paso y reduce la sed en hasta tres veces esa cantidad.

Comer cosecha como máximo 0.0035 de alimento por paso. Puede guardar un cuarto de lo cosechado en una reserva de hasta 0.25; el resto se consume. Consumir una unidad del alimento del modelo reduce hasta 4.8 unidades de hambre y recupera hasta 1.2 de energía, siempre dentro de sus cotas. Compartir consume 0.025 de reserva del donante, reduce hasta 0.12 de hambre del receptor y recupera hasta 0.03 de su energía; el donante paga un pequeño coste de actividad.

S e I pueden buscar cercanía o necesitar espacio. Un encuentro requiere proximidad y acciones compatibles de ambos; alguien que está explorando o comiendo no recibe automáticamente efectos de compañía porque el otro se acerque. Una pausa compartida puede aliviar fatiga y recuperar algo de actividad, sin crear alimento. Compartir tiempo también puede llevar a tomar espacio. Estar lejos no produce por sí solo un castigo afectivo, y cerrar el navegador no entra en estas reglas.

## Memoria y costumbre

Los cinco recuerdos iniciales están marcados como **ejemplos sintéticos**. Se activan por lugar y contexto: por ejemplo, un compañero cansado cerca del claro puede hacer que acompañar resulte más atractivo. Un recuerdo irrelevante no aumenta puntuaciones. Recordar desde la interfaz refuerza temporalmente una posibilidad contextual; no impone acción ni reconciliación.

Una costumbre nace al presenciar **dos acciones útiles de compartir** cerca de un lugar. Cada observador guarda quién actuó, para quién, en qué paso y con cuánto alimento. Luego puede repetir la conducta y volver al lugar si percibe una oportunidad útil. El lugar no adquiere una tradición por un temporizador. Los contadores de uso aumentan cuando ocurre cuidado real.

Cada persona conserva hasta ocho experiencias y tres hábitos. Cada hábito retiene dos evidencias iniciales, aunque los hechos antiguos salgan de la crónica reciente, limitada a 120 eventos. El registro persistente de hechos y entradas del servidor es independiente de esta ventana visible y puede crecer con el uso; no se acredita almacenamiento ilimitado ni una política de retención para biografía real.

El interruptor interno `learningEnabled` desactiva la imitación de hábitos y, en V5, las oportunidades de enseñar habilidades y recetas a otra persona. Compartir alimento y comerciar objetos pueden continuar. Investigar o fabricar por cuenta propia conserva su práctica técnica; este interruptor no apaga todo cambio interno. Las pruebas y comparaciones con semillas emparejadas se identifican en [EVIDENCIA.md](EVIDENCIA.md).

## Herencia, práctica y descendencia

Cada habitante tiene siete pares de genes simulados: curiosidad, sociabilidad, disposición al trabajo, cuidado, resiliencia, plasticidad y cooperación. Son parámetros del modelo, sin atribuir ADN ni perfiles psicológicos reales a los personajes. La media de cada par expresa su parámetro; la resiliencia modula el coste de fatiga del movimiento y trabajo dentro de un margen reducido.

Las habilidades generales aumentan tras actividad útil o enseñanza. La práctica tecnológica aprende también de un ensayo físico fallido que consumió materia, sin atribuirle producto ni utilidad. Los valores por contexto y acción cambian con resultados observados: `Q ← Q + α × (resultado − Q)`, acotados a ±0.3. La plasticidad heredable determina `α`, entre 0.04 y 0.20; los fundadores comienzan con 0.12. Un trabajo fallido aporta resultado negativo. El contexto se captura al decidir, antes de recibir el resultado. El aprendizaje cambia valores, habilidades y prácticas, sin reescribir los alelos. Las etiquetas de oficio describen las actividades con al menos tres resultados útiles y no intervienen en las decisiones.

Cada descendiente recibe un alelo de cada progenitor por locus. La variación tiene probabilidad 0.08 por aporte, hasta ±0.08 por alelo, siempre acotado entre 0 y 1. La semilla y la identidad del descendiente hacen reproducible esta recombinación sin consumir el azar del clima. La ficha muestra generación, progenitores, variaciones, plasticidad y cooperación; no expone todos los alelos internos.

Los nacimientos se comprueban cada 120 pasos, como máximo uno por comprobación y hasta **32 habitantes vivos**, incluyendo S e I. Participan únicamente dos vecinos ficticios distintos de la misma comunidad, a no más de tres celdas, con confianza de al menos 0.3 y reserva de al menos 0.1 cada uno. Debe existir un lugar compartido a cuatro celdas del primer progenitor; **no tiene que ser un refugio**. Además de madurez y recuperación reproductiva variables, se exige edad anterior a la senescencia, salud de al menos 0.55, vitalidad de al menos 0.5, hambre y sed de hasta 0.45, energía de al menos 0.6 y fatiga de hasta 0.65. Cada progenitor paga 0.08 de alimento y 0.08 de energía; el descendiente recibe 0.10 de alimento. S e I no participan en esta regla.

El descendiente nace en el lugar de un progenitor y empieza sin habilidades, valores aprendidos, hábitos, recorridos, recetas, productos ni recuerdos copiados. Registra su llegada como primera experiencia propia. Recibe la media de las tres prácticas culturales de sus progenitores como crianza inicial, separada del genoma. La transmisión de procedimientos requiere aprendizaje posterior; tener un progenitor inventor no entrega sus herramientas ni su conocimiento.

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

Las muertes del paso se determinan antes de repartir pertenencias: otro vecino que muere simultáneamente no puede recibirlas. Alimento, madera, piedra, productos y residuos pasan únicamente a supervivientes a dos celdas, respetando capacidad. El remanente se registra como pérdida de reservas utilizables, sin aparecer como alimento o materia nuevos en el suelo. La identidad fallecida se retira una vez; se actualizan vínculos y comunidades y no nace automáticamente un sustituto.

Para S e I, si la transición causaría muerte, la política externa mantiene salud mínima 0.05 y vitalidad mínima 0.08. Conservan necesidades, costes y edad; la protección no resucita una identidad fallecida ni modifica los alelos. Esta excepción de diseño no es una ventaja evolutiva adquirida ni un resultado de autopoiesis.

El registro de una vida conserva identidad, parentesco, genoma, rasgos demográficos, fechas y causa de muerte. El caché residente retiene las referencias necesarias a progenitores de vivos e inventores de planos o recetas, más las 32 identidades recientes, con límite 600. El archivo SQLite conserva las demás; si las referencias excedieran el caché, se rechaza el estado en vez de borrar un ancestro requerido. El límite de vivos es independiente del total histórico de vidas. El formato y la recuperación están en [CONSTRUCCION.md](CONSTRUCCION.md).

## Materiales y construcción

Recolectar requiere hasta 18 pasos de trabajo y retira una unidad base disponible de madera o piedra. Una herramienta de corte o abrasión puede aumentar esa extracción, limitada por el recurso real y el espacio del inventario. Cultivar requiere hasta 45 pasos y una madera: aumenta cultivo, fertilidad y crecimiento, sin alimento inmediato; una herramienta con capacidad de cultivo puede añadir preparación de suelo. Cazar requiere hasta 45 pasos, retira un animal individual y aporta alimento según especie. Estas tres labores reducen hasta un 25% de su tiempo con habilidad. Una construcción usa el coste completo de su plano; el refugio básico conserva seis maderas, tres piedras y 90 trabajos. `completeConstruction`, `invent` y `repair` centralizan el débito de sus respectivas tareas de estructuras; los procesos tecnológicos tienen su propio débito material.

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

Los presupuestos son explícitos: **256 recetas, generación tecnológica máxima 32, hasta doce operaciones y cuatro entradas por programa, 4000 cuantos por entrada, dieciséis productos por persona y 256 recibos recientes**. Al completar un producto con inventario lleno, el de menor capacidad se convierte en residuo conservado y queda registrado. El catálogo conserva ancestros; al llenarse cesa la propuesta de recetas nuevas, aunque pueden fabricarse las conocidas. Estos límites permiten composición creciente dentro de un espacio finito, no creatividad ilimitada.

El observador separa dependencias estructurales, arranque desde entradas externas y flujos realmente ejecutados. Contabiliza entradas, productos, combustible gastado, residuos, desgaste, transferencias internas y pérdidas. Un recibo ausente, una transacción incompleta o una existencia sin causa impiden certificar el intervalo; un búfer recortado puede dejar una ventana posterior completa si conserva todos sus movimientos. Los componentes fuertemente conectados (SCC) solo identifican ciclos. El resultado mantiene `boundary: 'not-modeled'` y `autopoiesisEstablished: false`; sus criterios científicos y limitaciones se detallan en [CIENCIA.md](CIENCIA.md).

## Cooperación, cultura y comunidades

Una oportunidad local de cooperación depende de recursos, práctica, confianza y predisposición. Tras acercarse y trabajar, puede transferir una madera o piedra necesaria para una obra o proceso, añadir trabajo a una construcción o caza, intercambiar materias, enseñar una habilidad superior o mostrar una receta conocida que ya fabricó con éxito. El intercambio se decide sobre personas percibidas a siete celdas y se completa a no más de 1.5. Enseñar una receta cuesta al docente 0.003 de energía y 0.002 de fatiga; no se añade otra vez el coste social general de 0.005 y 0.004. Conserva quién enseñó, a quién y cuándo; no transmite productos, episodios ni alelos. `learningEnabled: false` bloquea enseñanza de habilidades y recetas, incluyendo la llamada directa al transmisor.

Un producto puede intercambiarse por una unidad real de madera o piedra si resuelve una falta de capacidad para recolectar/cultivar, un insumo de un procedimiento solicitado o un catalizador obligatorio. El vendedor no entrega un objeto que su propia tarea necesita, el comprador debe tener capacidad de inventario y el pago no puede aumentar la carencia de sus materias reservadas. El lote conserva identidad, masa y propiedades; dos recibos vinculados registran salida y entrada. Comprar no enseña su receta. Una ayuda de materia prima responde a la demanda del proyecto propio del receptor y no adelanta trabajo gratis. Estos intercambios físicos continúan con aprendizaje social desactivado; `cooperationEnabled: false` los bloquea.

Cada persona tiene tres prácticas adquiridas: compartir, cuidado del entorno y apertura. La primera influye en ofrecer alimento; cuidar el entorno favorece cultivo y reduce el incentivo a cazar la última unidad cuando el hambre no es extrema. Compartir o cooperar con éxito y ciertos resultados de cultivo, recolección y caza ajustan esas prácticas. El contacto positivo aproxima las tres prácticas de ambos participantes, con efecto mayor cuanto más semejantes eran. Apertura interviene en la cooperación entre comunidades y en coordinar turnos. Las prácticas cambian fuera del genoma.

Cada 120 pasos, confianza ganada con contactos a seis celdas, semejanza cultural y un lugar cercano pueden formar una comunidad de al menos tres miembros; caben hasta ocho comunidades. La identidad no se asigna a los fundadores. Un miembro puede dejarla si su cultura se distancia de la media al menos 0.3, la confianza interna media cae por debajo de 0.35 y tiene al menos dos contactos cercanos externos con confianza de 0.3 y distancia cultural menor de 0.2. La lejanía por sí sola no rompe pertenencia.

Los hogares se eligen por calidad observada: agua, alimento, techo y confianza cercana. Esa memoria modifica oportunidades de permanencia y retorno físico. La información lejana pierde vigencia y un lugar agotado deja de justificar arraigo. No se introduce una comunidad inicial para producir un resultado social ni se impide salir por una frontera artificial. La prueba autónoma y el contraste de recursos deben acompañar las pruebas de formación de grupos en escenarios preparados.

Una disputa exige dos personas distintas con comunidad, próximas, con necesidad urgente en ambas, **misma acción de comer, beber o cazar y misma fuente aún disponible pero escasa**. Los umbrales de escasez son hasta 0.06 de alimento, 0.12 de agua o una unidad de fauna. Deben haber pasado 180 pasos desde sus disputas anteriores. La confianza de al menos 0.55 o la apertura media de al menos 0.65 permite acordar un turno: una persona espera doce pasos y deja el acceso a la otra sin aumentar la reserva. Dentro de un grupo, una confianza de al menos 0.25 también evita la disputa sin imponer ese acuerdo.

Si no se dan esas protecciones, el conflicto reduce confianza, aumenta fatiga y tensión y hace que una persona ceda el intento durante treinta pasos. Puede ocurrir dentro de una comunidad o entre comunidades; la diferencia de grupo sola no lo causa. No hay violencia, robo, guerras ni gobiernos.

## Gestos, tareas y una única verdad

Seleccionar cualquier habitante permite solicitar desplazamiento, exploración, recolección, cultivo, construcción, diseño de edificios, investigación de procesos, fabricación, reparación, caza, bebida, cooperación, descanso o retorno al modo autónomo. Las tareas requieren trayecto físico y respetan urgencias corporales; una tarea admite destinos hasta 4096 celdas de distancia. El buscador de caminos examina un entorno local acotado, por lo que no promete resolver cualquier laberinto distante. Los animales se inspeccionan y siguen sin órdenes humanas. Los gestos ambientales requieren tierra percibida por un habitante.

Sembrar, invitar y recordar tienen tres segundos de separación dentro del mundo. Se validan celda, tipo y contexto. Una invitación dura treinta segundos simulados y solo la perciben personas cercanas; hambre, fatiga y necesidad de espacio pueden hacer que la ignoren. El recordatorio dura sesenta segundos y necesita un recuerdo disponible y su lugar.

Un único mundo del servidor recibe las solicitudes de todos sus clientes. Su CPU avanza diez pasos por segundo, valida sesión, formato y frecuencia, asigna paso y orden, aplica el gesto en una copia del estado y guarda antes de confirmar. Repetir un identificador con el mismo contenido devuelve el resultado guardado; reutilizarlo para otra petición se rechaza. Cada navegador recibe normalmente dos proyecciones por segundo y dibuja su propia cámara; no simula otra población ni accede al generador aleatorio o a los hábitos internos completos. El servicio admite hasta doce conexiones WebSocket simultáneas.

Con el mismo estado e iguales entradas, la evolución es reproducible. La exploración combina rumbo individual reproducible y un registro acotado de 192 celdas recientes; elegir otra acción por memoria o aprendizaje no desplaza el azar futuro de la lluvia. Así se mantienen emparejadas las condiciones atmosféricas en los controles causales.

## Estadísticas, versiones y comprobaciones

El panel «Vida del mundo» separa población, necesidades, acciones y generaciones de los recursos de las regiones activas. Los acumulados registran acciones reales; la serie reciente conserva hasta 96 muestras, una cada 60 pasos. Fauna, agua y biomas no son un censo de todo el territorio procedural ni solo de la cámara. El rendimiento distingue pasos, guardado, proyección y memoria del servidor de cuadros, cachés y dispositivo gráfico de cada navegador; no mide ocupación de GPU.

El código en integración usa **reglas y protocolo 5; SQLite, esquema 3**. Migrar un estado V4 lo valida y copia, añade tecnología vacía, inicializa salud y vitalidad y conserva su edad `tick − bornAt`; los acumulados nuevos empiezan en cero. No reescribe la biografía previa, crea recetas retroactivas ni rellena ceros de recursos. Leer en modo de solo lectura no cambia el esquema de la base. Al abrir para escritura, la actualización transaccional añade el archivo de identidades.

Las vidas archivadas son inmutables por identidad, con fecha y digest; su lectura aplica el corte temporal del snapshot. Las regiones conservan versiones por clave y paso. Restaurar un estado anterior no puede incorporarle fallecimientos o versiones futuras del archivo. El caché reciente no reemplaza ese historial persistente ni promete disco ilimitado. Los detalles de almacenamiento, validación y recuperación corresponden a [CONSTRUCCION.md](CONSTRUCCION.md); versiones desconocidas o estados corruptos requieren recuperación explícita, sin reiniciar la carta.

Las pruebas incluyen controles de recursos y costes, necesidades, memoria pertinente e irrelevante, aprendizaje activado o desactivado, herencia y descendencia, cooperación, comunidades, archivo y continuidad. Los resultados ejecutados, sus cifras y límites se registran en [EVIDENCIA.md](EVIDENCIA.md); esta descripción de reglas no sustituye esa evidencia.

Estos resultados acreditan propiedades del modelo. No demuestran conciencia, una teoría general del cuidado ni que la carta tenga ya la identidad de la pareja. La revisión del contenido real y la prueba de experiencia en un teléfono físico siguen formando parte de la entrega pendiente.
