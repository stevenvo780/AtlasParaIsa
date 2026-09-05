# Ciencia, modelos y comprobaciones

Estas referencias orientan mecanismos y preguntas. La aplicación no reproduce organismos ni acredita sentimientos, conciencia o fidelidad biográfica. Las unidades y fórmulas son decisiones de diseño comprobables en este código.

## Necesidades y aprendizaje

Keramati y Gutkin vinculan recompensa y reducción de desviaciones de variables internas bajo supuestos definidos. Aquí orienta que comer, descansar y protegerse dependan del estado corporal. [Artículo original, eLife, 2014](https://elifesciences.org/articles/04811).

El selector combina hambre, sed, fatiga, predisposiciones, oportunidades locales y valores por contexto y acción. Tras resultados útiles o trabajo fallido actualiza `Q ← Q + α × (resultado − Q)`, con límites ±0.3. V3 permite heredar `α` entre 0.04 y 0.20; los fundadores comienzan con 0.12. El contexto se captura antes del resultado. Esta media incremental es una implementación pequeña propia, no una reproducción completa del algoritmo del artículo. La práctica y la enseñanza desarrollan habilidades; seleccionar una tarea por sí solo no las aumenta.

## Herencia, plasticidad y aprendizaje

Hinton y Nowlan muestran en un modelo computacional cómo el aprendizaje puede modificar las posibilidades de evolución sin transferir lo aprendido al genotipo. Esa distinción orienta separar herencia y adaptación durante la vida. [Artículo original, Complex Systems, 1987, alojado por Hinton](https://www.cs.toronto.edu/~hinton/absps/evolution.htm).

V3 implementa siete loci diploides de diseño: cinco predisposiciones, plasticidad y cooperación. Cada descendiente recibe un alelo de cada progenitor, con variación acotada. Sus genes expresan parámetros de la simulación; no describen genética humana. Habilidades, hábitos, valores aprendidos y recuerdos no se codifican ni copian en los alelos. La cultura inicial se recibe por una regla separada de crianza y cambia con experiencias e interacciones. Las etiquetas profesionales resumen práctica y no controlan el selector.

Los nacimientos de vecinos requieren recursos, confianza, cercanía, comunidad y un lugar compartido; consumen reservas y respetan un máximo de 32 habitantes. S e I quedan fuera de esta regla. Cada descendiente empieza sin aprendizaje copiado y guarda su nacimiento como primera experiencia propia. No hay mortalidad de habitantes ni un experimento de selección multigeneracional que demuestre el efecto Baldwin. La presencia de herencia y plasticidad, por sí sola, no acredita ese resultado.

## Entorno y construcción

La construcción de nicho estudia cómo organismos modifican recursos que después afectan a otros. Aquí orienta observar cómo cultivar, transitar y construir cambian oportunidades futuras. El prototipo no reproduce el modelo de evolución genética de ese trabajo. [Laland, Odling-Smee y Feldman, PNAS, 1999](https://pubmed.ncbi.nlm.nih.gov/10468593/).

Werfel, Petersen y Nagpal demuestran coordinación constructiva mediante percepción local y cambios compartidos del entorno. Su sistema persigue estructuras diseñadas. Nuestro refugio consume recursos, requiere trabajo y mejora descanso; no equivale a una ciudad autoorganizada. [Artículo original, Science, 2014](https://ssr.princeton.edu/sites/g/files/toruqf2946/files/documents/science2014-termes.pdf).

## Reglas locales e imitación

Lenia produce patrones complejos mediante reglas celulares locales. Es una referencia para investigar regularidades emergentes; este motor no implementa Lenia ni el Juego de la Vida, y esos patrones no demuestran conciencia. [Chan, Complex Systems, 2019](https://www.complex-systems.com/abstracts/v28_i03_a01/).

La capa celular V3 usa una regla continua de vecindad que responde a luz, humedad, fertilidad y tránsito. Modifica biomasa y suelo con costes y pérdidas explícitos. Agua potable y humedad son variables distintas: lluvia y recarga limitada alimentan depósitos visibles, mientras el océano mantiene agua potable en cero. La fauna se representa mediante existencias finitas de liebres, ciervos, jabalíes y peces por celda; migrar conserva unidades entre celdas y alimentarse o reproducirse consume biomasa y agua. Estas son simplificaciones ecológicas propias, sin química, hidrología o animales individuales completos.

El torneo de Rendell y colaboradores estudia beneficios de copiar información en entornos definidos y la importancia de su actualidad. Nuestra imitación identifica acciones observadas, efectos útiles y quién hizo qué. [Artículo original, Science, 2010](https://lalandlab.wp.st-andrews.ac.uk/files/2015/08/rendell_et-al_2010.pdf).

## Cultura, cooperación y coordinación local

Axelrod modela influencia cultural entre vecinos: la similitud favorece interacción y la interacción puede aumentar similitud, sin exigir homogeneidad global. Su modelo utiliza rasgos discretos y posiciones fijas. V3 toma esa idea como inspiración, con habitantes móviles y tres prácticas continuas —compartir, cuidado del entorno y apertura— que se aproximan mediante contacto positivo. No reproduce sus reglas ni acredita sus resultados de polarización. [Artículo original, Journal of Conflict Resolution, 1997](https://web.mit.edu/curhan/www/docs/Articles/15341_Readings/Culture_and_Identity/Axelrod-1997.pdf).

Compartir y cuidar el entorno cambian también por consecuencias observadas: alteran la valoración de compartir alimento, cultivar y conservar la última unidad de fauna. La apertura afecta a cooperación exterior y turnos. Confianza local, prácticas compatibles y un lugar compartido permiten formar comunidades. La pertenencia puede cambiar cuando coinciden baja confianza interna, diferencia cultural y al menos dos contactos cercanos compatibles fuera del grupo; no se asigna una facción fija por identidad o genética.

Couzin y colaboradores muestran, en un modelo de movimiento colectivo, cómo información de una parte del grupo puede orientar decisiones sin que todos identifiquen quién está informado. Aquí la relación es una inspiración para percepción y coordinación locales: un vínculo cercano puede influir en la exploración, y la cooperación transfiere recursos, trabajo o habilidad. No se implementa su modelo de bandadas ni se acredita consenso colectivo. [Artículo original, Nature, 2005](https://www.nature.com/articles/nature03236).

Las reglas de ayuda, trueque, enseñanza y disputa son decisiones explícitas de este prototipo. Una disputa necesita dos participantes distintos urgidos, la misma acción y la misma fuente todavía disponible pero escasa, además de confianza y apertura insuficientes. Puede ser interna o entre grupos. Confianza o apertura altas permiten una espera de doce pasos para turnarse; el desacuerdo añade tensión y cede un intento, sin violencia ni recursos nuevos. Ninguno de los artículos se presenta como validación de esta regla concreta ni de una teoría general del conflicto humano.

## Controles que pueden contradecir el diseño

| Mecanismo | Control | Qué medir |
|---|---|---|
| Aprendizaje por resultados | Desactivar actualización, conservar acciones y costes | Valores posteriores a éxitos y fracasos, elecciones posteriores |
| Predisposición | Igualar solo los rasgos que participan en la regla | Diferencias de actividad y coste en condiciones equivalentes |
| Herencia | Mantener progenitores y semilla, anular variación | Un aporte de cada progenitor por locus, descendiente reproducible |
| Plasticidad | Cambiar tasa de aprendizaje con iguales resultados | Diferente actualización de valores sin alterar alelos |
| Descendencia | Retirar una condición de nacimiento o desactivar reproducción | Costes, población acotada y ausencia de aprendizaje copiado |
| Agua potable | Comparar depósito, suelo húmedo y océano | Recarga limitada, consumo real y ausencia de agua potable salada |
| Fauna | Agotar biomasa/agua; variar orden de celdas | Débitos, nacimientos con costes, ausencia de duplicación al migrar |
| Exploración por novedad | Retirar únicamente incentivo de novedad | Cobertura y revisitas, conservando caminar |
| Techo útil | Conservar estructura y coste, retirar beneficio corporal | Recuperación de fatiga y energía |
| Imitación | Desactivar aprendizaje social conservando compartir | Transmisión con cadena de evidencia |
| Cooperación | Cambiar solo material, trabajo o diferencia de habilidad disponibles | Transferencias y resultados reales, sin duplicar inventario |
| Cultura | Conservar genes y variar prácticas, contacto o resultados | Elección, actualización cultural y pertenencia revisable |
| Disputa | Variar abundancia, acción, fuente, urgencia o confianza | Ausencia de conflicto sin sus causas y espera efectiva del turno |
| Oficio descriptivo | Cambiar solo la etiqueta | Ninguna alteración de decisiones |
| Cámara | Consultar diferentes lugares del mismo estado | Ningún cambio de simulación, azar ni descubrimientos |

Las comparaciones parten del mismo estado y semillas emparejadas. Los tests ejecutados y las métricas se registran en [EVIDENCIA.md](EVIDENCIA.md); esta tabla no afirma que se haya realizado un estudio exhaustivo de todos los mecanismos. La ecología congelada en regiones inactivas y el crecimiento del archivo en disco son simplificaciones explícitas. La simulación compartida se ejecuta en CPU del servidor; el dibujo WebGL2/Canvas 2D ocurre en cada cliente y no entrena ningún modelo. Ninguna prueba mide conciencia o amor.
