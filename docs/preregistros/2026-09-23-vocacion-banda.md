# Preregistro — vocación de linaje, saturación local y banda (23 de septiembre de 2026)

Escrito ANTES de implementar o correr ninguna de estas leyes. Autoría: síntesis (Opus) sobre tres lentes independientes (datos, código, experimento/teoría) y crítica adversarial (Sonnet); decisiones finales del orquestador. Datos de origen en `/datos/tmp-atlas-lab/c8-diag/` y `/datos/tmp-atlas-lab/datos-lab/` (laboratorio, fuera de git).

## Definición de C8 congelada

C8 se decide con `scripts/lab/criterio-terminado.mts` tal como está en la etiqueta `c8-v3-preregistro` (serie `diversidadConductaVentana`, Mann-Kendall creciente unilateral p < 0,05 con corrección Hamed-Rao + AR(1) y subida de Sen ≥ 0,02 en los días 5..60). Historia: v1 `diversidadConducta` → v2 `diversidadConductaActiva` (22-09 21:45) → v3 `diversidadConductaVentana` (23-09 09:03, tras el modelo nulo que mostró que las series acumuladas caen solo por la edad). Las series secundarias se informan junto a la que decide; `diversidadConductaTiempo` cumple en varias semillas de B (29, 101, 202, 404, 707) y NO decide (ver `scripts/lab/README.md`).

## Línea base (brazo B = reglas 10 + conflicto legible, 12 semillas × 60 días, techo de laboratorio 100)

C1–C7 en 8/12; C8 en 0/12 (subidas de Sen de la ventana al día 60: 5 +0,021 con p = 0,25, 29 −0,024, 101 +0,037 con p = 0,16, 202 −0,088, 404 −0,133, 505 −0,062, 606 −0,087, 707 −0,098); extinguidas 13 (día 24), 17 (26), 23 (26) y 303 (16). H-DIV-1 (habituación 0, BH0) y H-DIV-2 (cortejo 1, BC1): C8 0/6 cada una al día 40 con 2 extinciones cada una → refutadas.

## Diagnóstico

VEREDICTO MEDIDO (evaluador oficial v3 sobre los dia-NNN.json existentes, sin simular; informes en /tmp/claude-1000/-datos-workspaces-personal-AtlasParaIsa/71b6da8a-24fe-445a-abe9-a2469c7538ac/scratchpad/sint/inf-l60v3-40.json e inf-r6-40.json). En B la diversidad de ventana no está estancada: BAJA. Al día 60, B-202 da una subida de Sen de −0,088 (−1,6e-3/día, p = 1) y B-606, −0,087. Al día 40, las 8 supervivientes fallan C8: 5 −0,024, 29 −0,013, 101 −0,008, 202 −0,080, 404 −0,054, 505 −0,045, 606 −0,126, 707 −0,127. Sin tocar la métrica, una ley tiene que añadir ≈ +0,2 al día 60 frente a B, de forma gradual. La potencia medida en experimento/datos/potencia-c8.txt pide una pendiente sostenida de ≥ 0,003/día desde el techo (0,95 de aprobación con techo en el día 10; 0,62 con techo en el día 17). Si desaparece el escalón del techo, basta con 0,002/día (0,92).

QUÉ ES V. V es casi función del reparto diario del tiempo activo (lente de datos: R² 0,74; research β −1,03; approach −0,24). Además, la lluvia es global y sincroniza a todos: la pendiente de V frente a la fracción de lluvia vale −0,12 a −0,29 al techo (r −0,41 a −0,90 en B-5/101/606/29), y eso da un ruido ≈ 5 veces el de muestreo. El índice funciona como «el que gana se lo lleva todo»: el día 11 de B-606, con lluvia 0,75, research fue la dominante de 93 de 98 personas y V cayó a 0,148.

TRES TRAMOS.
(1) Joroba de crecimiento: 0,42–0,45 en los días 5–14.
(2) Escalón al llegar al techo, de −0,03 a −0,08. El techo del laboratorio apaga casi siempre la reproducción (reproducción activa 0,00–0,09 en B-606, días 9–17). Con ella desaparecen el cortejo y la provisión familiar, y la gente se vuelve sedentaria: la mediana del radio de giro diario pasa de 4–8 celdas a 1,1–1,8 (B-5, B-101, B-606, BH0-5). El tiempo ocioso lo absorbe research, la acción de reserva universal.
(3) Deriva lenta de 60 días, que es la que hace negativa la tendencia. El candidato de hogar de settlementOpportunity (society.ts:233, motivo «Vuelve a un lugar conocido…») sube de 0,18–0,22 a 0,31–0,36 del tiempo activo en 202, 404, 606 y 707 y pasa a ser la dominante. V baja a la vez: 202 0,44→0,37, 404 0,45→0,32, 606 0,38→0,31, 707 0,42→0,33. En 606 y 707 research sí cae (0,25→0,13 y 0,21→0,09), y las recetas en uso bajan (404: 262→126; 707: 268→124). Pero el hueco lo llena approach, no la variedad.

POR QUÉ NO CRECE. Ninguna fuerza que cruce generaciones diversifica; todas homogeneizan:
- al nacer se reinician skills, values, activity y technology;
- la cultura se hereda como media de los padres, sube como un trinquete y converge por bond (sharing 0,56→0,94; desviación de stewardship 0,15→0,03);
- la varianza genética es máxima en los fundadores;
- values converge a la misma tabla, porque las recompensas son constantes;
- la habituación empuja a todos al mismo reparto;
- todo lo acumulable se satura en una sola vida: habilidad máxima media 0,92–0,95 a partir de 12 días de edad; recetas 32/32 y objetos 15,5/16 entre los 6 y 9 días.
Sí hay individualidad persistente dentro de la vida: ICC por persona 0,42–0,68, fidelidad al oficio 0,75 frente a un nulo de 0,64, y V observado menos nulo de intercambiabilidad de +0,06 a +0,31 en B-5. Pero cada nacimiento la borra. El juguete de la lente de teoría coincide: solo una variable heredada que empiece homogénea, no se mezcle y acumule error de copia da una subida sostenida con N fijo (vertical ε = 0,25: 19/20; mezcla: 1/20; umbral: meseta, 8/20; habituación: 2/20).

CONTRADICCIONES RESUELTAS.
(a) La lente de datos proyectaba que B-606 aprobaría C8 por el hundimiento de research. Los 60 días reales la refutan: B-606 da −0,087, porque approach sustituyó a research.
(b) Approach al techo es la vuelta al hogar y no costumbre ni cortejo: según los motivos de B-606, «Vuelve a un lugar conocido» ocupa 0,14–0,32 del tiempo activo; «Recuerda el cuidado compartido» y «Recuerda el vínculo» ocupan ≤ 0,02. La lente de código acierta.
(c) El «sin bucle de práctica» de la lente de código y los «individuos persistentes» de la lente de datos son compatibles: hay persistencia por rasgos y por lugar, pero ningún refuerzo, y se reinicia en cada nacimiento.
(d) La fuente del ruido que la teoría no identificó es la lluvia (confirmado arriba).
(e) Se confirma la predicción teórica de que BH0 y BC1 no aprobarían: 0/6 cada uno al día 40.
(f) El mecanismo «faltan novatos, falta enseñanza» es solo correlacional y la lente de código lo contradice en el agregado (2,08 frente a 2,09 enseñanzas por persona y día). No lo uso.

Sospecha sin medir: approach crece porque sube la calidad del hogar (viable() suma 0,25 por instalaciones y 0,3·confianza media en los vecinos, y los vínculos se saturan).

## Prototipos ya corridos por la lente de experimento

Fuente: /datos/tmp-atlas-lab/c8-diag/experimento/ (proto/ con la copia del mundo; diferencias frente a R11 solo en src/world/index.ts y params.ts). Las cifras están recalculadas sobre dias.jsonl y personas-NNN.jsonl.

PROTO0-5: la copia con las leyes a 0 reproduce bit a bit l60v3/B-5 en los días 1–2 (V 0,4176 y 0,4794). La vía de prototipado es fiel.

B-5-H0d11 (habituación 0 desde el día 11, rama pareada):
- V días 12–20: 0,338 frente a 0,319 (+0,019);
- ICC de research por persona 0,418→0,584; fidelidad al oficio 0,748→0,781 (nulo 0,644→0,662).
Más persistencia individual y algo de nivel, pero ninguna tendencia.

BH0-5 (habituación 0 desde el inicio): días 11–20, 0,366 frente a 0,327 (+0,039). En el laboratorio r6 al día 40, BH0 da C8 0/6 con subidas +0,018, +0,021, −0,112, −0,086, −0,040 y −0,049, y dos extinciones (404 el día 25, 505 el día 19). BC1 da C8 0/6, subidas de −0,117 a +0,019, y extinciones de 202 (día 30) y 505 (día 25). Frente a B, cada uno mejora en 4 de 6 semillas; la diferencia pareada tiene una desviación típica de ≈ 0,06–0,07, que es ruido caótico. H-DIV-1 y H-DIV-2 quedan refutadas.

PRAC1 (conducta.practica = 1: cada oficio suma práctica·(habilidad del oficio − media de sus habilidades), explorar incluido, solo sin urgencias):
- Nivel al techo: semilla 5, días 12–19, 0,453 (sd 0,037) frente a 0,317 (sd 0,062), +0,136; semilla 101, días 14–20, 0,499 (sd 0,010) frente a 0,353 (sd 0,036), +0,146.
- En crecimiento sube menos (+0,059 en la 5, días 5–11; +0,044 en la 101, días 5–13), así que ELIMINA el escalón del techo.
- Reduce la sincronía por lluvia: pendiente de V frente a lluvia −0,215→−0,127 (5) y −0,120→−0,020 (101); desviación del residuo 0,036→0,021 y 0,042→0,010.
- Baja approach al techo (0,11–0,22 frente a 0,18–0,31) y research (101: 0,07–0,17 frente a 0,21–0,34). El radio de giro se mantiene en 1,6–5,1 frente a 1,1–1,8.
- Pero no da tendencia en 20 días: meseta, como predice la teoría, porque las habilidades se saturan.
- Y MATA JÓVENES. En la 101, 76 muertes frente a 47 hasta el día 20; 39 frente a 7 con menos de 8 días de edad; esos muertos dedicaban a explorar el 0,44 de su último día frente al 0,12. En la 5, 8 frente a 4 muertes de menos de 8 días (explorar 0,30 frente a 0,03). El crecimiento es más lento: techo en el día 14 frente al 9 (101) y en el 12 frente al 10 (5).
- Causa: explorar suma habilidad por cada celda nueva, así que la ley crea exploradores especialistas que se alejan y mueren.

PO1-5, PO1-101 y PO1H-5 (practicaOficios = 1 sin explorar; PO1H añade que la cría hereda el 50 % de las habilidades de a): interrumpidos entre los días 4 y 7, sin conclusión. PO1-5, días 5–7: 0,431 frente a 0,411; 1 muerte frente a 2.

Lectura. La práctica es el único prototipo que cambia la FORMA a favor de C8: quita el escalón, reduce a la mitad el ruido de lluvia y frena la deriva de approach. Aun así es una ley de nivel. PO1H no puede dar tendencia: los fundadores ya se especializan al azar durante su vida (la diversidad existe desde la generación 0) y la herencia de habilidades se satura, así que tampoco empieza homogénea.

## Hipótesis preregistradas

### H1 · OFICIO DE LINAJE (vocación heredada + práctica de oficios) (prioridad 1)

**Mecanismo.** Transmisión vertical uniparental de una vocación con error de copia, en la línea de Cavalli-Sforza y Feldman 1981 y de la deriva cultural neutra de Bentley, Hahn y Shennan 2004. Es la variable lenta que falta: empieza en 0 en la fundación, no se mezcla entre progenitores, no se aprende ni converge por conformidad y acumula ≈ ε²/3 de varianza por generación. La media de generación sube ≈ 0,15 al día, de ≈ 1 en el día 5 a ≈ 8 en el día 60, así que la desviación de la vocación crece ×2,8 dentro de la ventana y V sube de forma gradual con el recambio, sin meseta. Entre el 29 y el 52 % de las decisiones ready se deciden por menos de 0,05, así que sesgos de 0,05 a 0,15 reordenan oficios. La práctica de oficios (sin explorar) fija temprano el sesgo heredado y aporta lo que mostró PRAC1: quita el escalón del techo, reduce el ruido de lluvia y frena la deriva de approach. Así la subida de la vocación se lee con potencia.

**Ley.** (1) conducta.vocacion = ε (default 0; propuesto 0,1; rango [0; 0,3]).
- Estado opcional Person.vocacion: Record sobre los 10 oficios de RASGO_DEL_OFICIO (index.ts:297) SIN explorar.
- Los fundadores no tienen el campo.
- En el nacimiento (index.ts ≈1333, junto a skills/activity/values: {}): hijo.vocacion[k] = a.vocacion[k] + ε·(2u_k − 1), donde a es el progenitor del que se clona la cría y u_k sale de localRandom(world.seed, `vocacion:${id}`) en orden fijo de oficios. Luego se centra (suma cero, como ventajaComparativa) y se acota a ±0,3. Hay que sobrescribir o borrar el campo que copia structuredClone(a).
- En choose(), solo en contexto ready (sed, hambre y cansancio ≤ 0,5; la misma guarda que aptitud, index.ts:443) y tras el bloque de aptitud (index.ts ≈812): cada candidato de oficio distinto de explorar suma vocacion[acción].
(2) conducta.practicaOficios = p (default 0; propuesto 1; código ya escrito en experimento/proto/src/world/index.ts): en ready, cada oficio salvo explorar suma p·(skills[oficio] − media de las habilidades de oficio sin explorar).
- Con los defaults a 0 no se crea el campo, no se llama a localRandom y no se suma nada: el digesto es idéntico. Hay que comprobarlo como PROTO0-5 y con los digestos de control.
- Es LOCAL: la vocación pasa del cuerpo del progenitor en el nacimiento, igual que hoy el genoma y la cultura; después es memoria propia. La práctica es el propio cuerpo. No lee posiciones ni estado de nadie fuera del nacimiento.
- Es DETERMINISTA: localRandom se indexa por el id del hijo y no depende del orden de actualización.
- Obra en el esquema: campo opcional validado en index.ts:1675 (numericMap −0,3..0,3, ≤ 10 claves), más instantánea y migración de reglas 11 (ausente = 0).

**Predicción y refutación.** Panel fijo de 8 semillas: robustas 5, 29, 101 y 202; frágiles 13, 17, 23 y 303. 60 días, techo-lab 100, parámetros de B más ε = 0,1 y p = 1, sin reajustar. Se compara con l60v3/B en las mismas semillas.

PUERTA EN EL DÍA 20. (a) Seguridad: muertes con menos de 8 días de edad hasta el día 20 ≤ 1,5× B en ≥ 3/4 robustas (PRAC1-101 dio 39 frente a 7), y ninguna robusta extinguida. (b) Manipulación: varianza de la vocación entre mortales vivos en el día 20 ≥ 2× la del día 8. Si falla (a) o (b), se detiene el brazo.

DECISIÓN EN EL DÍA 60. ÉXITO si se cumplen las tres:
- C8 oficial v3 cumple en ≥ 3/4 robustas;
- la pendiente de Sen de los días 20..60 es > 0 en ≥ 3/4, así que es tendencia y no escalón;
- subida(H1) − subida(B) ≥ +0,08 en ≥ 3/4 (B: 202 −0,088; al día 40, 5/29/101 −0,024/−0,013/−0,008).
Predicciones intermedias: nivel del techo (días 15–25) ≥ B + 0,06; desviación del residuo tras quitar la lluvia (días 15–60) ≤ 0,8× B; varianza de la vocación día 60/día 10 ≥ 3; ICC por linaje del oficio dominante creciente del día 15 al 55; fracción con research dominante (días 50–60) ≤ B − 0,10.
REFUTADA si ocurre cualquiera:
- C8 ≤ 1/4;
- la pendiente de los días 20..60 ≤ 0 en ≥ 2/4;
- la varianza de la vocación no llega a duplicarse entre el día 8 y el 60;
- más de 1 extinción adicional entre las robustas.
INCONCLUSO con 2/4: el mismo brazo, sin tocar parámetros, se corre en 404/505/606/707.
Frágiles, sin daño: primera extinción no más de 3 días antes que en B en ≥ 3/4, y nacimientos al día 12 ≥ 0,8× B (B: 22/12/25/1).

**Riesgo para C1–C7.** C1/C2: la práctica retrasó el techo entre 2 y 5 días en PRAC1 y puede empeorar las frágiles.
C6: muertes jóvenes. Explorar se excluye de las dos leyes, y la puerta del día 20 lo vigila.
C7: research baja (en PRAC1-101, 0,07–0,17 del tiempo activo), pero el uso ajeno de B está en ≈ 0,5 frente a un umbral de 0,15.
C4: algunos linajes pueden evitar cooperate o share. El margen es amplio (enseñanza 39 %, comida 48 % en B-5).
La selección sobre la vocación puede reducir su varianza: se mide.
Es estado nuevo por persona: exige validación, instantánea y migración de reglas 11.

### H2 · VOCACIÓN + SATURACIÓN LOCAL (estabilizador alternativo a la práctica) (prioridad 2)

**Mecanismo.** El mismo motor lento de H1, la vocación heredada con error. En lugar del refuerzo por práctica, la estabiliza una dependencia NEGATIVA de la frecuencia percibida localmente: la teoría del umbral de respuesta (Bonabeau, Theraulaz y Deneubourg 1998) y la propusieron las tres lentes por separado. Si muchos vecinos visibles hacen el mismo oficio, ese oficio atrae menos a cada uno. Eso rompe el «todos a research» de los días de lluvia y hace que las vocaciones distintas se complementen en vez de converger al ganador común. Se usa si H1 falla la puerta de seguridad (muertes jóvenes o techo más lento por la práctica) o si su nivel no aparece.

**Ley.** conducta.vocacion = 0,1, idéntica a H1, más conducta.saturacionLocal = s (default 0; propuesto 0,3; rango [0; 1]).
- En choose(), contexto ready, tras la vocación: cada candidato de oficio salvo explorar resta s·(número de mortales visibles cuya acción actual es esa misma / número de mortales visibles).
- Los visibles son nearbyPeople, a ≤ RADIUS = 7 celdas (index.ts:432), y hace falta ver al menos 2.
- No toca comer, beber, descansar, approach ni los actos de vínculo.
- Es local: la acción actual de otro es visible, con precedente en la ley vigente (other.action === 'build'/'hunt' en cooperationOpportunity y partner.action en accompany).
- Es determinista: un recuento sin azar ni orden de actualización. Con s = 0 no resta nada, y es bit a bit.

**Predicción y refutación.** El mismo panel, 60 días y la misma puerta en el día 20 que H1 (manipulación de la vocación y ninguna robusta extinguida). Umbrales del día 60 iguales a H1: C8 en ≥ 3/4 robustas, pendiente de los días 20..60 > 0 en ≥ 3/4, y ganancia frente a B ≥ +0,08 en ≥ 3/4.
Predicciones propias:
- en días con lluvia ≥ 0,5, la fracción de personas con research dominante ≤ B − 0,15;
- la pendiente de V frente a lluvia al techo, en valor absoluto, ≤ 0,5× la de B (B: −0,12 a −0,29);
- nivel del techo ≥ B + 0,04.
REFUTADA con C8 ≤ 1/4, con la pendiente de los días 20..60 ≤ 0 en ≥ 2/4, o si la sincronía por lluvia no baja (pendiente ≥ 0,8× la de B en ≥ 3/4).

**Riesgo para C1–C7.** La lluvia puede desviar gente hacia oficios de poco valor, lo que da exposición (C6): el refugio no se toca, pero hay que vigilar las muertes por exposure.
Puede dispersar la ayuda a obras (assist) y reducir constructionHelp (C4; margen amplio).
Menos research lleva a menos recetas (C7; margen amplio).
No añade estado por persona más allá de la vocación.

### H3 · VOCACIÓN SOLA (ley mínima) (prioridad 3)

**Mecanismo.** Comprueba si la variable lenta basta sin estabilizador. Aplica el criterio de código limpio: si una ley basta, no se adoptan dos. Se corre en dos casos: si H1 aprueba, para saber si la práctica es necesaria; o si H1 y H2 fallan la seguridad. La teoría y los datos (B baja −0,0016/día y tiene el escalón del techo) hacen esperar una mejora de tendencia insuficiente para C8. Se preregistra así para no leerlo después como sorpresa.

**Ley.** Solo conducta.vocacion = 0,1, tal como en H1: herencia uniparental desde a con error ε, centrada y acotada a ±0,3; suma en ready solo a oficios sin explorar; los fundadores sin campo.
Lo demás en B: conducta.practicaOficios = 0 y conducta.saturacionLocal = 0.
Localidad, determinismo y default bit a bit, como en H1.

**Predicción y refutación.** El mismo panel, 60 días y la misma puerta de manipulación en el día 20.
Predicción preregistrada:
- subida(H3) − subida(B) ≥ +0,05 en ≥ 3/4 robustas;
- la pendiente de los días 20..60 es mayor que la de B en ≥ 3/4;
- C8 cumple en ≤ 2/4, lo esperado.
Se ADOPTA en lugar de H1 si C8 cumple en ≥ 3/4 sin daño, porque es la ley más simple.
El mecanismo queda REFUTADO (la vocación no mueve la tendencia en el mundo real) si la ganancia frente a B es < +0,03 en ≥ 2/4 aunque la varianza de la vocación crezca ≥ 3× entre los días 10 y 60. En ese caso se abandona la vía de transmisión tal como está diseñada.

**Riesgo para C1–C7.** Es el más bajo de los tres: solo reordena oficios sin urgencias y no introduce la exploración especialista ni la saturación.
Quedan dos riesgos. La selección de linajes con vocaciones ventajosas (caza, recolección) puede reducir la varianza. Y hay estado nuevo por persona: validación, instantánea y migración.

## Cohesión de banda (contra las extinciones por aislamiento)

LEY social.banda: «expedición pequeña + correa». Parámetros: b (peso; default 0 = hoy; propuesto 1) y social.bandaMax m (tamaño máximo de grupo; propuesto 6; no influye con b = 0).

QUÉ ATACA. Diagnóstico de las 03:00 más el embudo de las 11:50. En las cuatro semillas que caen, los adultos fértiles no emparentados DEJAN DE CONVIVIR durante la ventana fértil sincrónica de los fundadores (días 0 a ~7,4).
- Régimen seco (303, 17): hacia t ≈ 0,5 días, 13–14 de cada 15 tienen sed > 0,7 a la vez. Con los rumbos áureos (heading = n·2,39996; index.ts:201 y 1336), la novedad (+2) y el término de rumbo de explorationTarget (0,2 por celda; index.ts:866–872), la búsqueda estalla en abanico. El único término de compañía exige un vínculo > 0,3 dentro de la vista, y los fundadores nacen con bonds: {}.
- Régimen de charcas (13, 23): las charcas se secan y la gente se dispersa sin ninguna fuerza que la reúna.
- Resultado: 10 grupos para 10 personas en la 303, con el vecino a 74 celdas en el día 5. Cada foco queda en una pareja con sus hijos, es decir, una isla de parientes. Los nacimientos se paran tras los días 8–12 (13: 22; 17: 12; 23: 26; 303: 1 en total).

REGLAS (solo vecinos mortales; los compañeros son vecinos mortales visibles a ≤ RADIUS = 7, nunca S ni I). Sin estado nuevo, sin candidato nuevo y sin azar.
(A) Expedición pequeña. En explorationTarget, que también usa la búsqueda de agua (index.ts:836): si la persona ve c compañeros que están explorando, con 1 ≤ c ≤ m − 1, el término de rumbo usa el rumbo efectivo. Ese rumbo es la media circular de su heading (peso 1) y del de esos compañeros (peso b cada uno). Los heading se leen de una instantánea tomada al inicio del paso y person.heading no se escribe, así que la ley no depende del orden de actualización, el defecto que el verificador encontró en agua.rebano. Con c ≥ m no hay alineación y el grupo grande se parte con los rumbos de siempre.
(B) Correa. En contexto ready (sed, hambre y cansancio ≤ 0,5) y con 1 ≤ c ≤ m − 1, se descartan los destinos de exploración que queden a más de RADIUS − 1 de todos los compañeros visibles, siempre que quede al menos uno. Nunca actúa con urgencia corporal ni sobre beber, comer, descansar o refugiarse.
(C) Quien está solo (c = 0) conserva la conducta de hoy.

POR QUÉ ASÍ. m = 6 es el tamaño del grupo de fundadores de cada lugar inicial (index.ts:185–188). Por construcción salen ~3 expediciones de ≤ 6 personas, en lugar de un rebaño de 16. Esto corrige el fallo de agua.rebano: formó expediciones (R 0,82 frente a 0,12; 303 pasó de 3 a 36 nacimientos al día 12), pero el rebaño único tomó la dirección seca y hundió 17 (7→2, 9 muertes por sed), 505 (36→4) y 404 (101→55). Un grupo de 4 a 6 fundadores no parientes, todos fértiles en los días 0–7, contiene 2 o 3 parejas posibles cuyas crías no son parientes entre sí: se cierra la isla de parentesco.
Tampoco repite los fracasos anteriores:
- la exposición de arraigo (exposición 11→34), porque no hay atracción que crezca con la distancia ni actúa bajo urgencia;
- la no localidad de reencuentro, cortejo y H2 (posiciones fuera de la vista);
- los retornos por memoria que no funcionaron (hogar ancestral: sin efecto; cortejo local v1: polariza, 404 pasa de 43 a 3).
Es local porque solo usa la dirección de marcha visible y la posición de quien está a la vista. Es determinista.

COMPATIBILIDAD CON C8. No añade candidatos ni toca las puntuaciones de oficios; solo cambia el destino y el rumbo de explorar en grupos de 1 a 5 compañeros visibles. En mundos densos (al techo hay c ≥ 6 y un radio de giro de 1–2 celdas) queda inactiva: no toca V, approach ni el código de H1–H3, que actúan sobre oficios en ready. Además amortigua el riesgo principal de cualquier ley de C8, las extinciones caóticas de semillas marginales (BH0 perdió 404 y 505; BC1 perdió 202 y 505).

PREDICCIÓN PRERREGISTRADA. Brazo B + banda, b = 1 y m = 6, sin reajustar; panel de 8 semillas; 60 días.
En las frágiles:
- P1 (se forman grupos): grupos de mortales el día 1 (enlace a 8 celdas) ≤ 0,6× B, y pares fértiles no emparentados a ≤ 3 celdas el día 2 ≥ 2× B (≥ 3 si B = 0), en ≥ 3/4.
- P2 (sigue naciendo gente): nacimientos al día 20 ≥ 1,5× B (B: 22/12/26/1) y más de 0 nacimientos entre los días 12 y 20 (B: 0/0/1/0), en ≥ 3/4.
- P3 (sobreviven): ≥ 2/4 con ≥ 16 mortales el día 40 (B: 0/4; se extinguen entre los días 16 y 26).
- P5 (sin riesgo correlacionado): muertes por sed al día 12 ≤ 1,5× B + 2 en cada semilla (B: 9/7/17/4).
- P4 (sin daño a las robustas): 0 extinciones; techo alcanzado no más de 2 días después que en B (B: días 10/11/9/17); C1–C7 en el día 60 en 4/4; V de ventana media (días 15–60) dentro de ±0,03 de B; approach al techo dentro de ±0,02.
REFUTADA si ocurre cualquiera de estas cosas:
- P1 falla en ≥ 2/4;
- P1 se cumple pero P2 falla en ≥ 3/4, y entonces el cerrojo no era la distancia;
- P4 falla;
- P5 falla en ≥ 2 semillas.
Confirmación fuera de muestra, sin reajustar: 1007 (seca), 1055, 1066 y 1084, exigiendo P2 en ≥ 2/4 sin daño.

## Plan

REGLA DE EJECUCIÓN. Un brazo cada vez, 8 réplicas en paralelo (8 hilos), 60 días con techo-lab 100. La línea base B del panel ya existe en l60v3; solo faltan los días 50–60 de las semillas 5, 29 y 101, que están terminando. Los análisis se hacen con ≤ 2 procesos Python.

PASO 0: sin simular salvo 2 días de identidad.
- Worktree desde R11 (reglas 10 + conflicto B + instrumento v3). Se implementan conducta.vocacion, conducta.practicaOficios (reutilizando experimento/proto), conducta.saturacionLocal y social.banda, todas con default 0.
- Tests: digesto idéntico con los defaults, con los digestos de control y 2 días frente a l60v3/B-5 como hizo PROTO0-5. Además, herencia determinista de la vocación, fundadores sin campo, validación e instantánea.
- Medidas nuevas del laboratorio, que se informan aparte y no tocan C8 v3: varianza de la vocación; ICC por linaje del oficio dominante; fracción de personas con research dominante; reparto de approach por motivo; muertes por causa y edad (< 8 días); radio de giro; grupos del día 1 y pares fértiles no emparentados a ≤ 3 celdas (embudo).

ORDEN DE BRAZOS.
1. H1 (vocación 0,1 + práctica 1) sobre el panel de 8, con la puerta del día 20 (seguridad y manipulación). Si pasa la puerta, sigue hasta el día 60 y se decide con los umbrales preregistrados.
2. Cohesión, B + banda (b = 1, m = 6), sobre el panel de 8. Es independiente de C8 y se evalúa sobre todo en las frágiles.
3. Ramas según el resultado de H1:
   - aprueba: H3 (vocación sola) para decidir si la práctica sobra; se adopta la ley más simple que apruebe;
   - falla la seguridad: H2 (vocación + saturación 0,3);
   - la vocación no crece o no mueve la tendencia (refutación de H1): se abandona la vía de transmisión y no se corren H2 ni H3;
   - queda inconcluso (2/4): el mismo brazo en 404/505/606/707, sin reajustar.
4. Candidato final (la mejor ley de C8 más banda) sobre las 12 semillas de l60 (5 13 17 23 29 101 202 303 404 505 606 707) × 60 días, con el criterio oficial de mayoría, más 1007/1055/1066/1084 fuera de muestra para la supervivencia.
Nunca se reajustan parámetros sobre las mismas semillas después de ver los datos.

QUÉ SE DESCARTA Y POR QUÉ.
- BH0 y BC1: C8 0/6 al día 40 y dos extinciones cada uno. H-DIV-1 y H-DIV-2 están refutadas.
- BAPT (aptitud 1): C8 0/8, dos extinciones y una pendiente más negativa que B en 6/8.
- PRAC1 (práctica con explorar): crea exploradores especialistas que mueren jóvenes (39 frente a 7) y retrasa el techo 2–5 días.
- PO1H (herencia de habilidades) como vía de transmisión: las habilidades se saturan en una vida y los fundadores ya son diversos, así que no hay subida.
- Ya no hacen falta las corridas PO1 y PO1H interrumpidas, porque H1 las sustituye.
- Acumulación técnica y nichos por herramienta: recetas y objetos se saturan a los 6–9 días de edad (32/32 y 15,5/16) y homogeneizan a los adultos.
- Como brazos solos para C8, investigación por carencia, hogar per cápita o fisión, refugio con aforo y cría de fauna desacoplada: son leyes de nivel o de ruido, o arriesgan la cohesión y la demografía. La saturación local queda solo como estabilizador en H2.
- Cultura sin fundido: acoplamiento débil a la conducta (pesos 0,12–0,15); queda para después.
- Rebaño sin tope y cualquier cohesión no local: correlación de riesgo y no localidad ya medidas.
- La proyección por composición de la lente de datos: refutada por el día 60 real.
- Cambiar la métrica: prohibido. Las dudas de medida (joroba desde el día 5, «el ganador se lo lleva todo», grupos vitalicios g3–g5, sesgo de la entropía con N pequeño) se usan solo para interpretar.

## Ajustes adoptados de la crítica

- H1: puerta dura adicional del día 60 — el índice de ventana calculado SOLO con mortales de generación ≥ 1 (sin fundadores) debe cumplir también Mann-Kendall creciente y subida ≥ 0,02 en ≥ 3/4 robustas, y la ICC por linaje del oficio dominante debe crecer; si no, la subida se atribuye a un escalón y no a la transmisión.

- La definición de C8 queda congelada en la etiqueta `c8-v3-preregistro` y la decisión final citará esa versión y el historial v1→v2→v3.

- Los resultados se informan con la serie que decide y las secundarias (`diversidadConductaTiempo` incluida) en la misma tabla.

- Banda: «reduce» (no «amortigua») el riesgo correlacionado del rebaño; la predicción P5 decide si el riesgo que queda es aceptable.


## Crítica completa

**Veredicto.** Verificación hecha sin simular (re-lectura de código en R11, re-ejecución de `npx tsx scripts/lab/criterio-terminado.mts --entrada /datos/tmp-atlas-lab/datos-lab/l60v3 --dia 60` sobre los dia-NNN.json existentes, cruce con /datos/tmp-atlas-lab/c8-diag/lentes-completas.json, /datos/tmp-atlas-lab/datos-lab/bitacora.md, scripts/lab/README.md e `historial de git` de criterio-terminado.mts). El diagnóstico se sostiene bien en los datos: repetí a mano las cifras clave (B-202 subida de Sen −0,088 a −1,60e-3/día p=1; B-606 −0,087; B-5 día 40 −0,0242; C1–C7 8/12 y C8 0/12; R5 agua.rebano 17 7→2, 505 36→4, 404 101→55; BAPT 0/8 con 2 extinciones; potencia-c8.txt) y coinciden exactamente. También comprobé literalmente las citas de código (society.ts:233 `settlementOpportunity`/"Vuelve a un lugar conocido…" con la fórmula viable() 0,25+0,3·confianza EXACTA; index.ts heading=n·2,399963…; RASGO_DEL_OFICIO; guardas `if (aptitud>0)`/`if (p===0)` que hacen creíble el "default reproduce bit a bit"). Las tres hipótesis y la ley de banda son locales (usan solo cuerpo/memoria propia o vecinos ≤ RADIUS visibles, nunca S/I ni posiciones fuera de la vista) y deterministas (localRandom indexado por id, sin dependencia de orden de actualización), siguiendo patrones ya existentes en el código (waterMemory de un solo progenitor, guardas de default 0). No encontré números fabricados ni citas de código incorrectas.

Dicho esto, hay tres puntos reales que un revisor adversarial no debería dejar pasar, ninguno fatal pero todos accionables (detalle y arreglo en "objeciones"): (1) la síntesis omite que `diversidadConductaTiempo` —una serie oficial del mismo evaluador— SÍ pasa Mann-Kendall+Sen en varias de las mismas semillas B (29, 202, 404, 707) al día 60, y no cita la razón ya documentada (README) de por qué se descarta (colapso del componente "oficios" por dominancia de rest); (2) la serie decisiva de C8 lleva tres revisiones en <24 h (v1→v2 21:45 22-09 →v3 commit 5329242, 09:03:33 23-09, ~17 s antes del primer día de l60v3), cada una justificada pero siguiendo a una racha de "C8 falla" de la versión anterior — riesgo de métrica en movimiento que debería congelarse/versionarse antes de correr H1–H3/banda; (3) el criterio de éxito de H1 (vocación+práctica) al día 60 no exige, como puerta dura, que el índice calculado SOLO sobre descendientes muestre la misma tendencia — dado que "práctica" sola (PRAC1) ya demostró producir un escalón de nivel y no una tendencia, existe riesgo de aprobar H1 por mezcla composicional (fundadores + descendientes desplazados) en vez de diversificación real; el plan ya prevé H3 para aislar esto pero solo como rama posterior, no como parte de la decisión de H1 mismo. Con esas tres correcciones (mayormente de transparencia y de mover chequeos ya previstos a condición dura), el plan es sólido y falsable tal como está escrito.

- [media] diagnostico (V estancada/decreciente en B; ninguna serie de diversidad sube): diversidadConductaTiempo (misma familia oficial de series del evaluador, scripts/lab/instrumentos.ts, decidida en modo auto si Ventana/Activa faltan) SÍ cumple Mann-Kendall creciente con p<0,05 y subida de Sen ≥0,02 al día 60 en varias de las MISMAS semillas B usadas para el diagnóstico: B-29 (Sen 4,01e-3/día, subida 0,2204, p=1,2e-7), B-202 (subida 0,1913, p=3,8e-5), B-404 (subida 0,1728, p=0,0003), B-707 (subida 0,1957, p=0,0352) — verificado corriendo el evaluador oficial de R11 sobre /datos/tmp-atlas-lab/datos-lab/l60v3. La síntesis no menciona esta divergencia ni cita el motivo, ya documentado en scripts/lab/README.md (líneas ~299-303), de por qué Tiempo no decide (su componente 'oficios' colapsa hacia 0 porque 'rest' domina como acción de casi todos, así que Tiempo mide sobre todo cuánto se descansa, no diversidad real). Sin esa cita, el diagnóstico es vulnerable exactamente a la pregunta que la crítica adversarial pide vigilar: ¿alguna serie sube por un artefacto y no se está reportando? — Arreglo: Añadir una línea en el diagnóstico citando scripts/lab/README.md sobre por qué diversidadConductaTiempo no decide, y reportar su valor junto al de Ventana en la tabla de resultados por semilla para que la discrepancia quede documentada, no omitida.

- [media] diagnostico / marco metodológico ('sin tocar la métrica'): La serie decisiva de C8 se revisó tres veces en menos de 24 h: v1 'diversidadConducta' (antigua) → v2 'diversidadConductaActiva' (preregistro 2026-09-22 21:45, tras que v1 sobrerrepresentara explorar) → v3 'diversidadConductaVentana' (commit 5329242, 2026-09-23 09:03:33, tras documentar que las series acumuladas 'bajan' de 0,315 a 0,008 solo por envejecer, modelo nulo). Verifiqué que el commit v3 quedó ~17 s antes del primer dia-001.json de l60v3 (mtime 09:03:50), así que no se ajustó mirando ese conjunto — pero sí llegó justo después de que v2 acumulara fallos de C8 en l60, r2 y r5 durante la noche anterior (bitácora 09:15: 'el bloqueo del terminado es C8, 0/12'). Cada revisión tiene una razón estadística legítima y documentada, pero el patrón global (la vara de medir sigue moviéndose mientras se buscan leyes que la superen) es un riesgo real de grados de libertad del investigador sobre el programa completo, y el diagnóstico no lo reconoce ni fija la versión. — Arreglo: Congelar y etiquetar (git tag o hash citado) la definición de C8 usada ANTES de correr H1/H2/H3/banda de este plan, y declarar esa versión explícitamente en la decisión final de adopción (paso 4), junto con el historial v1→v2→v3 a la vista para que un revisor externo pueda juzgar si el criterio se movió en su favor.

- [media] H1 · OFICIO DE LINAJE (vocación heredada + práctica de oficios): El criterio de éxito al día 60 (C8 oficial ≥3/4, pendiente 20..60 >0, ganancia ≥+0,08) se evalúa sobre la población TOTAL, sin exigir como puerta dura que el índice de Ventana calculado SOLO sobre descendientes (excluyendo fundadores) muestre la misma tendencia. PRAC1 ya demostró que 'práctica' por sí sola produce un ESCALÓN de nivel (no una tendencia: +0,136/+0,146 al techo pero meseta en 20 días) que redistribuye tiempo entre oficios. Como la fracción de la población que son descendientes 'practicantes' crece con el recambio generacional (media de generación ≈1 en el día 5 a ≈8 en el día 60, según el propio mecanismo de H1), es posible que H1 apruebe C8 por una MEZCLA composicional (fundadores sin práctica + proporción creciente de descendientes con conducta desplazada por práctica) sin que la vocación individual esté realmente diversificándose entre personas. El diseño lo anticipa solo parcialmente: H3 (vocación sola) se corre 'si H1 aprueba', pero como rama POSTERIOR, no como condición de la propia aprobación de H1 en el día 60. — Arreglo: Promover a puerta dura del día 60 de H1: el índice de Ventana calculado únicamente sobre mortales con generación ≥1 (excluyendo fundadores) debe mostrar igualmente Mann-Kendall creciente y subida de Sen ≥0,02, y la ICC por linaje del oficio dominante (ya listada como 'predicción intermedia') debe pasar de informativa a parte de la condición de ÉXITO.

- [baja] cohesión (social.banda: expedición pequeña + correa): bandaMax=6 reduce el TAMAÑO del grupo expuesto a un rumbo compartido erróneo, pero no elimina geométricamente el mecanismo: la media circular de hasta 6 rumbos áureos co-ubicados puede seguir apuntando, por azar, hacia una región seca (el rumbo áureo de 6 fundadores consecutivos no está garantizado a repartirse en direcciones seguras). La frase 'amortigua el riesgo principal' expresa más confianza de la que el mecanismo por sí solo garantiza; el propio umbral P5 preregistrado (muertes por sed ≤1,5×B+2) ya lo compensa correctamente como red de seguridad, así que es más un matiz de redacción que un defecto de diseño. — Arreglo: Suavizar la afirmación ('reduce el riesgo' en vez de 'amortigua el riesgo principal') y dejar que P5 —tal como ya está planeado— sea la única juez de si el riesgo correlacionado remanente es aceptable.

## Adenda 1 (23-09, 15:50) — veredicto de la puerta del día 20 y H1b fuera de muestra

Escrita ANTES de correr H1b y el control B instrumentado.

**H1 detenido en la puerta del día 20 (regla del preregistro).** La manipulación exigía varianza de la vocación en el día 20 ≥ 2× la del día 8; resultó 1,70× (5), 1,77× (29), 1,72× (101) y 2,14× (202). Las cuatro frágiles se extinguieron como en B (13 día 30, 17 día 24, 23 día 23, 303 día 19); ninguna robusta se extinguió. Réplicas detenidas a los días 28–38.

**La puerta estaba mal especificada, no solo la ley.** Con varianza lineal en las generaciones (≈ ε²/3 por generación, el propio modelo de la síntesis) y generaciones medias ≈ 2,3 en el día 8 y ≈ 4 en el día 20, el cociente día 20 / día 8 ronda 1,7 sea cual sea ε. Se deja escrito como error de diseño del preregistro original; su veredicto (detener H1 en el panel) no se cambia.

**H1b (nuevo, fuera de muestra).** La MISMA ley sin reajustar (conducta.vocacion 0,1, conducta.practicaOficios 1, sobre B) en semillas que no se han mirado con ella: 404, 505, 606 y 707, 60 días, techo 100.
- Puerta del día 20 corregida: seguridad (muertes con < 8 días de edad hasta el día 20 ≤ 1,5× las del control B instrumentado en ≥ 3/4, y ninguna extinción) y manipulación (varianza de la vocación creciente: día 20 > día 8 en 4/4; se informa el cociente).
- Decisión en el día 60, con los umbrales de H1: C8 oficial (etiqueta c8-v3-preregistro) en ≥ 3/4; pendiente de Sen de los días 20..60 > 0 en ≥ 3/4; subida(H1b) − subida(B) ≥ +0,08 en ≥ 3/4 (B de l60v3: 404 −0,133, 505 −0,062, 606 −0,087, 707 −0,098); y la puerta dura de la crítica (ventana calculada solo con mortales de generación ≥ 1).
- Si falla la seguridad o la decisión, se abandona la vía de transmisión tal como está diseñada.

**Control B instrumentado (BCTRL).** El código de la rama con todas las leyes en 0 (bit a bit igual a B) en 13, 17, 23, 303, 404, 505, 606 y 707 × 60 días, para tener con los instrumentos nuevos los valores de B que piden P1 de banda (grupos el día 1, pares fértiles el día 2) y la puerta de seguridad de H1b.

**BANDA a mitad de camino (no decide; se decide en el día 60).** P2 3/4 (13, 23, 303), P5 4/4, P4 por ahora sin extinciones y con techo a ≤ 2 días de B; P3 1/4 (13 con 87 mortales el día 40; 23 extinta el día 35, 303 el 31, 17 el 20).

## Adenda 2 (23-09, 17:48) — veredictos del día 60

Calculados con el evaluador de la etiqueta `c8-v3-preregistro`, byte a byte igual al de la rama del experimento (sha256 comprobado), sobre los `dia-NNN.json` crudos. Salidas: [`criterio-h1b-d60.json`](../evidencia-2026-09-23/criterio-h1b-d60.json), [`criterio-banda-d60.json`](../evidencia-2026-09-23/criterio-banda-d60.json), [`criterio-bctrl-d60.json`](../evidencia-2026-09-23/criterio-bctrl-d60.json) y [`criterio-l60v3-d60.json`](../evidencia-2026-09-23/criterio-l60v3-d60.json).

**BANDA: REFUTADA por dos vías independientes.**
- P1 falla en 4/4. Grupos de mortales el día 1: 6 frente a 7 en B, 10 frente a 13, 8 frente a 7 y 13 frente a 13; ninguno llega a ≤ 0,6× B. Pares fértiles no emparentados el día 2: 0, 0, 2 y 0, frente a 1, 0, 13 y 0 en B.
- P4 falla. La ventana media de los días 15–60 baja −0,091 en 29 y −0,052 en 101, y approach al techo sube +0,062, +0,024 y +0,023 en 29, 101 y 202. La ley sí toca C8, en contra de su propio diseño.
- Las demás: P2 3/4, P3 1/4 y P5 4/4.
- 13 se salva: 89 habitantes, 327 nacimientos y generaciones 9–19 al día 60. No es por el mecanismo previsto, porque P1 no se cumple. 17, 23 y 303 se extinguen (días 20, 35 y 31).
- C8 en 0 de 5 supervivientes. No se fusiona a main.

**H1b: REFUTADA.**
- C8 oficial 1/4: solo 606, con subida +0,140 y p = 0,019. 404 da −0,012, 707 −0,024, y 505 se extingue el día 43, cuando en B sobrevivía.
- Pendiente de Sen de los días 20..60: −1,3·10⁻³ (404), −1,8·10⁻² (505, hasta su extinción), +4,1·10⁻³ (606) y −3,5·10⁻⁴ (707). Es ≤ 0 en 3/4, así que se cumple la condición de refutación («≤ 0 en ≥ 2/4»).
- Ganancia pareada frente a B: +0,121 (404), +0,228 (606) y +0,075 (707). Supera +0,08 en 2/4, y el éxito exigía 3/4.
- Natalidad al día 20: 404 da 60 nacimientos frente a 127 en B, y 505 da 22 frente a 50. La puerta de seguridad corregida sí pasó en 4/4 (muertes de menores de 8 días ≤ 1,5× control); la ley frena la reproducción sin matar crías.
- 606 es un caso aislado y no se presenta como éxito. Con 4–7 % de falsos «cumple» por semilla (calibración de C8 v3), un aprobado entre 4 no distingue la ley del azar.
- Lo que sí queda medido: la vocación heredada acumula varianza (×4,4–5,8 del día 10 al 60) y frena la caída de la ventana en nivel (2–3 veces el ruido pareado de 0,06–0,07). No la convierte en subida en la mayoría.
- Conforme a la Adenda 1, se abandona la vía de transmisión tal como está diseñada. La vocación solo vuelve como base de una hipótesis nueva, con preregistro nuevo y semillas nuevas, nunca reajustada sobre 404–707.

**Desviación declarada.** La puerta dura de la crítica (ventana calculada solo con mortales de generación ≥ 1) y la ICC por linaje del oficio dominante nunca se instrumentaron. No cambian ningún veredicto, porque ambos brazos ya fallan con los criterios instrumentados, pero la predicción intermedia de la ICC queda sin evaluar.

**BCTRL** (el código de la rama con todas las leyes en 0) reproduce l60v3-B exactamente en sus 8 semillas: mismas fechas de extinción y mismas subidas de C8 (404 −0,1328; 505 −0,0621; 606 −0,0872; 707 −0,0981). Queda demostrado el determinismo entre versiones del código.

**Siguiente paso** (plan maestro del 23-09, bitácora del laboratorio 17:40): diagnóstico de C8 en condición pública. Es B sin techo de laboratorio, con el cupo público, en las 8 semillas que sobrevivieron en B, pareado con l60v3. Predicción anotada antes de ver datos: si el escalón de C8 lo fabrica el techo, la subida sin techo supera a la de B con techo en ≥ 6/8. Si no, el techo no explica el fallo y la hipótesis siguiente debe atacar la transmisión acumulable entre generaciones.
