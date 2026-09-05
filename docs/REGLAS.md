# Reglas del prototipo

Estas reglas describen V3 en `src/world/index.ts`, `ecosystem.ts`, `genetics.ts`, `society.ts` y `statistics.ts`. Son unidades de un modelo sencillo; no representan medidas biológicas ni una puntuación del amor. La memoria y las diferencias provisionales de S e I son ejemplos de diseño pendientes de la voz de Steven.

## Tiempo, paisaje y recursos

El territorio se genera por **regiones de 16 × 16 celdas**, con seis biomas coherentes y coordenadas firmadas. No tiene el borde del mapa inicial; el intervalo técnico es `[-10 000 000, 10 000 000)`. La población inicial conserva catorce vecinos ficticios y S e I. Un paso representa 100 ms; un día del modelo contiene 2400 pasos, cuatro minutos. Amanecer, día, atardecer y noche aportan distinta luz. Cada sesenta segundos simulados se decide el tiempo atmosférico con un generador cuya semilla y estado se guardan.

Humedad, vegetación y alimento están entre 0 y 1 por celda. Cada diez pasos se actualizan los recursos:

- La lluvia y el agua vecina aportan humedad; evaporación y luz la reducen.
- La combinación de luz y humedad favorece vegetación; la sequedad provoca pérdidas.
- Luz, humedad y vegetación permiten regenerar alimento con una capacidad máxima. De noche no hay ese crecimiento.
- Cosechar retira alimento y una pequeña cantidad de vegetación de la celda. El gesto de sembrar introduce explícitamente hasta 0.12 de vegetación y no añade alimento.

V3 añade fertilidad, biomasa vegetal, cultivo, tránsito y una capa celular continua. Esta capa considera los ocho vecinos y favorece ciertos patrones de dos o tres vecinos vivos, modulados por luz, humedad y fertilidad. Influye en el suelo y crecimiento; sequedad y pisoteo la reducen. Es una regla propia inspirada en autómatas celulares, sin implementar Conway ni Lenia. La madera puede recuperarse lentamente consumiendo biomasa bajo condiciones favorables; la piedra no regenera. Cultivar prepara suelo y crecimiento; caminar deja huellas que dificultan la recuperación.

El agua potable es una reserva finita entre 0 y 1 por celda, separada de la humedad del suelo. Charcos, manantiales, humedales y celdas de agua dulce pueden almacenarla. La lluvia recarga solo esos depósitos, los manantiales aportan hasta 0.002 por actualización y la evaporación reduce la reserva. El océano mantiene agua potable igual a cero: su intercambio de agua salada no lo hace bebible. El suelo húmedo común no es una fuente para los habitantes.

Liebres, ciervos, jabalíes y peces son existencias enteras por celda, con un máximo de seis; no son agentes individuales con identidad ni genoma. Cada cincuenta pasos pueden migrar a un vecino compatible con mejores recursos, debitando origen y acreditando destino sin duplicarse. Consumen biomasa y agua; la escasez de cualquiera de las dos reduce la población y aporta fertilidad. Cada doscientos pasos, una población local de al menos dos puede añadir una unidad pagando 0.12 de biomasa y 0.025 de agua adicionales. No se reproduce una celda vacía. Los herbívoros también aprovechan humedad vegetal; los peces consumen la reserva acuática de su celda.

No hay regeneración instantánea para fabricar un encuentro ni un balance termodinámico completo. Hay reproducción de fauna y descendencia de vecinos con condiciones explícitas; no hay muerte de habitantes.

Solo las regiones alrededor de habitantes avanzan su ecología. Las demás se archivan y quedan congeladas hasta reactivarse; la cámara consulta terreno y modificaciones sin activar regiones, producir historia ni consumir el azar del clima. SQLite crece con la exploración: extensión procedural no significa almacenamiento ilimitado.

## Cuerpos, elecciones y vínculo

Cada persona percibe hasta siete celdas de distancia. Compara explorar, comer, beber, cazar, descansar, acercarse, acompañar, tomar espacio, compartir, recolectar, cultivar, construir y cooperar según sus necesidades y posibilidades locales. Una intención suele durar tres segundos, con revisión anticipada ante alimento o agua agotados y necesidades urgentes. Cada seis pasos puede avanzar una celda por un camino de tierra; no cruza agua ni se teletransporta.

Hambre, sed, fatiga y energía de actividad usan una escala de 0 a 1. La sed crece más deprisa en desierto; hambre o sed extremas reducen energía. El movimiento consume energía y aumenta fatiga; descansar recupera capacidad de actividad, condicionado por alimento y calidad del refugio. La energía representa disposición para actuar, no una magnitud termodinámica. Una persona sin alimento y con hambre máxima no recupera energía indefinidamente por descansar. Beber retira hasta 0.006 de agua potable por paso y reduce la sed en hasta tres veces esa cantidad.

Comer cosecha como máximo 0.0035 de alimento por paso. Puede guardar un cuarto de lo cosechado en una reserva de hasta 0.25; el resto se consume. Consumir una unidad del alimento del modelo reduce hasta 4.8 unidades de hambre y recupera hasta 1.2 de energía, siempre dentro de sus cotas. Compartir consume 0.025 de reserva del donante, reduce hasta 0.12 de hambre del receptor y recupera hasta 0.03 de su energía; el donante paga un pequeño coste de actividad.

S e I pueden buscar cercanía o necesitar espacio. Un encuentro requiere proximidad y acciones compatibles de ambos; alguien que está explorando o comiendo no recibe automáticamente efectos de compañía porque el otro se acerque. Una pausa compartida puede aliviar fatiga y recuperar algo de actividad, sin crear alimento. Compartir tiempo también puede llevar a tomar espacio. Estar lejos no produce por sí solo un castigo afectivo, y cerrar el navegador no entra en estas reglas.

## Memoria y costumbre

Los cinco recuerdos iniciales están marcados como **ejemplos sintéticos**. Se activan por lugar y contexto: por ejemplo, un compañero cansado cerca del claro puede hacer que acompañar resulte más atractivo. Un recuerdo irrelevante no aumenta puntuaciones. Recordar desde la interfaz refuerza temporalmente una posibilidad contextual; no impone acción ni reconciliación.

Una costumbre nace al presenciar **dos acciones útiles de compartir** cerca de un lugar. Cada observador guarda quién actuó, para quién, en qué paso y con cuánto alimento. Luego puede repetir la conducta y volver al lugar si percibe una oportunidad útil. El lugar no adquiere una tradición por un temporizador. Los contadores de uso aumentan cuando ocurre cuidado real.

Cada persona conserva hasta ocho experiencias y tres hábitos. Cada hábito retiene dos evidencias iniciales, aunque los hechos antiguos salgan de la crónica reciente, limitada a 120 eventos. El registro persistente de hechos y entradas del servidor es independiente de esta ventana visible y puede crecer con el uso; no se acredita almacenamiento ilimitado ni una política de retención para biografía real.

El interruptor interno `learningEnabled` permite un experimento: desactivar la imitación de hábitos conserva las mismas acciones de compartir, pero elimina la transmisión de esa costumbre por observación. Las pruebas incluyen una escena causal controlada y población autónoma con semillas emparejadas, incluyendo efectos sobre S e I.

## Herencia, práctica y descendencia

Cada habitante tiene siete pares de genes simulados: curiosidad, sociabilidad, disposición al trabajo, cuidado, resiliencia, plasticidad y cooperación. Son parámetros del modelo, sin atribuir ADN ni perfiles psicológicos reales a los personajes. La media de cada par expresa su parámetro; la resiliencia modula el coste de fatiga del movimiento y trabajo dentro de un margen reducido.

Las habilidades aumentan tras actividad útil o enseñanza. Los valores por contexto y acción cambian con resultados observados: `Q ← Q + α × (resultado − Q)`, acotados a ±0.3. La plasticidad heredable determina `α`, entre 0.04 y 0.20; los fundadores comienzan con 0.12. Un trabajo fallido aporta resultado negativo. El contexto se captura al decidir, antes de recibir el resultado. El aprendizaje cambia valores, habilidades y prácticas, sin reescribir los alelos. Las etiquetas de oficio describen las actividades con al menos tres resultados útiles y no intervienen en las decisiones.

Cada descendiente recibe un alelo de cada progenitor por locus. La variación tiene probabilidad 0.08 por aporte, hasta ±0.08 por alelo, siempre acotado entre 0 y 1. La semilla y la identidad del descendiente hacen reproducible esta recombinación sin consumir el azar del clima. La ficha muestra generación, progenitores, variaciones, plasticidad y cooperación; no expone todos los alelos internos.

Los nacimientos se comprueban cada 120 pasos, como máximo uno por comprobación y hasta **32 habitantes totales**. Participan únicamente dos vecinos ficticios distintos de la misma comunidad: edad de al menos 4800 pasos, al menos 2400 desde el último nacimiento, cercanía de hasta tres celdas, confianza de al menos 0.3, hambre y sed bajas, energía suficiente y reserva de al menos 0.1 cada uno. Debe existir un lugar compartido cercano; **no tiene que ser un refugio**. Cada progenitor paga 0.08 de alimento y 0.08 de energía; el descendiente recibe 0.10 de alimento. S e I no participan en esta regla.

El descendiente nace en el lugar de un progenitor y empieza sin habilidades, valores aprendidos, hábitos, recorridos o recuerdos copiados. Registra su llegada como primera experiencia propia. Recibe la media de las tres prácticas culturales de sus progenitores como crianza inicial, separada del genoma. La edad habilita reproducción, sin simular infancia completa, selección natural estudiada ni mortalidad humana.

## Materiales y construcción

Recolectar requiere hasta 18 pasos de trabajo y retira una unidad disponible de madera o piedra. Cultivar requiere hasta 45 pasos y una madera: aumenta cultivo, fertilidad y crecimiento, sin alimento inmediato. Cazar requiere hasta 45 pasos, retira una unidad de fauna y aporta alimento según especie. Un refugio exige hasta 90 pasos, seis maderas y tres piedras, descontadas juntas al completarse; no puede terminar sin esos materiales. La habilidad reduce hasta un 25% del tiempo de trabajo. Los refugios mejoran el descanso y permiten encuentros y costumbres locales.

`adaptationEnabled`, `noveltyEnabled` y `shelterBenefitEnabled` permiten controles de aprendizaje por resultados, incentivo de novedad y beneficio del techo. `learningEnabled` conserva su significado separado de imitación de hábitos de compartir. `cooperationEnabled` controla cooperación y dinámicas comunitarias; `reproductionEnabled` permite desactivar nacimientos de vecinos. Estos interruptores internos no son botones de la interfaz. Las referencias y simplificaciones están en [CIENCIA.md](CIENCIA.md).

## Cooperación, cultura y comunidades

Una oportunidad local de cooperación depende de recursos, práctica, confianza y predisposición. Tras acercarse y trabajar, puede transferir una madera o piedra necesaria para una obra, añadir trabajo a una construcción o caza, intercambiar una madera por una piedra o enseñar una habilidad realmente superior. Inventarios, trabajo o habilidad cambian; cooperar consume actividad del donante y aumenta confianza. La enseñanza es una vía distinta de los hábitos controlados por `learningEnabled`.

Cada persona tiene tres prácticas adquiridas: compartir, cuidado del entorno y apertura. La primera influye en ofrecer alimento; cuidar el entorno favorece cultivo y reduce el incentivo a cazar la última unidad cuando el hambre no es extrema. Compartir o cooperar con éxito y ciertos resultados de cultivo, recolección y caza ajustan esas prácticas. El contacto positivo aproxima las tres prácticas de ambos participantes, con efecto mayor cuanto más semejantes eran. Apertura interviene en la cooperación entre comunidades y en coordinar turnos. Las prácticas cambian fuera del genoma.

Cada 120 pasos, confianza ganada con contactos a seis celdas, semejanza cultural y un lugar cercano pueden formar una comunidad de al menos tres miembros; caben hasta ocho comunidades. La identidad no se asigna a los fundadores. Un miembro puede dejarla si su cultura se distancia de la media al menos 0.3, la confianza interna media cae por debajo de 0.35 y tiene al menos dos contactos cercanos externos con confianza de 0.3 y distancia cultural menor de 0.2. La lejanía por sí sola no rompe pertenencia.

Una disputa exige dos personas distintas con comunidad, próximas, con necesidad urgente en ambas, **misma acción de comer, beber o cazar y misma fuente aún disponible pero escasa**. Los umbrales de escasez son hasta 0.06 de alimento, 0.12 de agua o una unidad de fauna. Deben haber pasado 180 pasos desde sus disputas anteriores. La confianza de al menos 0.55 o la apertura media de al menos 0.65 permite acordar un turno: una persona espera doce pasos y deja el acceso a la otra sin aumentar la reserva. Dentro de un grupo, una confianza de al menos 0.25 también evita la disputa sin imponer ese acuerdo.

Si no se dan esas protecciones, el conflicto reduce confianza, aumenta fatiga y tensión y hace que una persona ceda el intento durante treinta pasos. Puede ocurrir dentro de una comunidad o entre comunidades; la diferencia de grupo sola no lo causa. No hay violencia, robo, guerras ni gobiernos.

## Gestos, tareas y una única verdad

Seleccionar cualquier habitante permite solicitar desplazamiento, exploración, recolección, cultivo, construcción, caza, bebida, cooperación, descanso o retorno al modo autónomo. Las tareas requieren trayecto físico y respetan urgencias corporales; una tarea admite destinos hasta 4096 celdas de distancia. El buscador de caminos examina un entorno local acotado, por lo que no promete resolver cualquier laberinto distante. Los gestos ambientales requieren tierra percibida por un habitante.

Sembrar, invitar y recordar tienen tres segundos de separación dentro del mundo. Se validan celda, tipo y contexto. Una invitación dura treinta segundos simulados y solo la perciben personas cercanas; hambre, fatiga y necesidad de espacio pueden hacer que la ignoren. El recordatorio dura sesenta segundos y necesita un recuerdo disponible y su lugar.

Un único mundo del servidor recibe las solicitudes de todos sus clientes. Su CPU avanza diez pasos por segundo, valida sesión, formato y frecuencia, asigna paso y orden, aplica el gesto en una copia del estado y guarda antes de confirmar. Repetir un identificador con el mismo contenido devuelve el resultado guardado; reutilizarlo para otra petición se rechaza. Cada navegador recibe normalmente dos proyecciones por segundo y dibuja su propia cámara; no simula otra población ni accede al generador aleatorio o a los hábitos internos completos. El servicio admite hasta doce conexiones WebSocket simultáneas.

Con el mismo estado e iguales entradas, la evolución es reproducible. La exploración combina rumbo individual reproducible y un registro acotado de 192 celdas recientes; elegir otra acción por memoria o aprendizaje no desplaza el azar futuro de la lluvia. Así se mantienen emparejadas las condiciones atmosféricas en los controles causales.

## Estadísticas, versiones y comprobaciones

El panel «Vida del mundo» separa población, necesidades, acciones y generaciones de los recursos de las regiones activas. Los acumulados registran acciones reales; la serie reciente conserva hasta 96 muestras, una cada 60 pasos. Fauna, agua y biomas no son un censo de todo el territorio procedural ni solo de la cámara. El rendimiento distingue pasos, guardado, proyección y memoria del servidor de cuadros, cachés y dispositivo gráfico de cada navegador; no mide ocupación de GPU.

Reglas y protocolo visible usan versión 3; SQLite conserva esquema 2. Migrar V1/V2 preserva datos anteriores e inicializa los campos nuevos de forma reproducible; estadísticas y comunidades nuevas empiezan en la migración. Los ceros de recursos guardados no se interpretan como permiso para rellenarlos. Una versión desconocida o un estado corrupto requieren recuperación explícita, sin reiniciar la carta.

Las pruebas incluyen controles de recursos y costes, necesidades, memoria pertinente e irrelevante, aprendizaje activado o desactivado, herencia y descendencia, cooperación, comunidades, archivo y continuidad. Los resultados ejecutados, sus cifras y límites se registran en [EVIDENCIA.md](EVIDENCIA.md); esta descripción de reglas no sustituye esa evidencia.

Estos resultados acreditan propiedades del modelo. No demuestran conciencia, una teoría general del cuidado ni que la carta tenga ya la identidad de la pareja. La revisión del contenido real y la prueba de experiencia en un teléfono físico siguen formando parte de la entrega pendiente.
