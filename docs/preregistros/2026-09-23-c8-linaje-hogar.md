# Preregistro — vocación fuerte de linaje y hogar por rendimiento marginal (23 de septiembre de 2026, noche)

Escrito antes de implementar las leyes y antes de que el control del panel llegue al día 20. C8 sigue congelado en la etiqueta `c8-v3-preregistro`; el evaluador y el instrumento de `main` (2ee2658) son byte a byte los de esa etiqueta. Diseño: Fable 5.1 (diagnóstico, modelos de juguete y potencia sobre el fondo real; scripts en `/datos/tmp-atlas-lab/c8-diag/`); preregistro y decisiones: Opus. Plan maestro: F2 (campaña C8), ciclo 1 de 2.

## Diagnóstico que lo motiva (cifras de l60v3/B y f21/PUB)

- Lo que cae es la ETIQUETA, no el perfil. En B (techo 100), el componente `oficios` del índice (entropía del oficio dominante del día) explica el 80–95 % de la caída de la ventana en las seis semillas que caen (Sen×55: −0,15 a −0,25 en 202, 404, 606 y 707); la distancia por pares (`conducta`) es casi estacionaria (0,35–0,43).
- La joroba de los días 5–14 (0,42–0,45) no es composición etaria: recalculada solo con adultos sigue ahí. Es una fase (reproducción activa, economía material viva, radio de giro 4–8 celdas) que acaba por el techo o por la densidad y el agotamiento.
- La diversidad está ENTRE hogares, no dentro: en 80 de 80 días-réplica la distancia media entre clústeres espaciales (0,38–0,44) supera a la de dentro (0,15–0,33). Los grupos visibles son de 2–5 personas y la red de vínculos no crece.
- La deriva lenta negativa es económica: alrededor de hogares sedentarios se agotan madera, piedra y fauna (madera media de los adultos 4–6 → 1–2 entre los días 5 y 20; la madera no vuelve a crecer en casillas con tránsito ≥ 0,35), la tecnología se satura y el tiempo lo llena `approach` de volver a casa (0,13–0,20 → 0,28–0,36 en la condición pública, r con la población +0,52…+0,88 dentro de cada semilla).
- Sin techo de laboratorio (f21, días 20–48) la ventana también baja y supera a la de con techo solo en 4/8: el techo no fabrica la caída (veredicto formal de F2.1 al día 60).
- La prueba exige una forma concreta (efectos sumados a las 8 series reales de B, evaluador portado y comprobado): un efecto que se satura antes del día ~25 no aprueba ni con +0,30; hace falta ≥ +0,15 que siga creciendo hasta el día ≥ 35.
- Por eso las leyes de vida (práctica, saturación, aptitud, habituación) dan nivel y no pendiente, y la práctica hizo redundante a la vocación en H1b. La única clase de mecanismo que en el juguete produce la forma exigida es la deriva neutra de un sesgo heredado por un solo progenitor, SIN práctica (Cavalli-Sforza y Feldman 1981; Bentley, Hahn y Shennan 2004). Potencia estimada de H-A sola: ~0,45–0,6 por semilla; P(mayoría de 12) entre 0,25 y 0,65, menor si la deriva de `approach` continúa después de la meseta de población. De ahí el segundo brazo, que ataca la deriva.

## Leyes (default 0 = mundo bit a bit igual a reglas 11)

- **H-A · vocación fuerte de linaje** (`conducta.vocacion` = ε, `conducta.vocacionTope`): cada cría hereda del progenitor del que se clona un sesgo por oficio (los de `RASGO_DEL_OFICIO` sin `explore`) con error de copia uniforme ±ε, centrado a suma cero y proyectado a ±tope; fundadores, S e I sin campo. Solo en contexto `ready`, cada oficio suma su sesgo. Sin práctica ni saturación. Brazo: ε = 0,3, tope = 0,9 (juguete: +0,19 al día 60; sobre fondo real 5/8; con 0,1/0,3 solo +0,07).
- **H-B · hogar por rendimiento marginal** (`social.hogarTrabajo` = r): en `settlementOpportunity`, la provisión de un lugar se multiplica por `1 − r·(1 − trabajo)`, con `trabajo = clamp01((madera + piedra)/12 + fauna/2)` sumado en su radio 4. Un hogar rodeado de casillas agotadas pierde calidad y se cambia a un lugar visible más rico (umbral +0,12 y radio 6 intactos). Charnov 1976; Binford 1980; Kelly 1995. Brazo: r = 1 (solo actúa cuando el entorno está casi agotado, por el clamp).

## Brazos, panel y condición

- Brazos: **VOC** (ε 0,3; tope 0,9), **HOG** (r 1), **VOCHOG** (ambas), **CTRL** (reglas 11 por defecto, ya lanzado sobre `main` 2ee2658; bitácora del laboratorio 23-09 19:18).
- Panel de decisión: semillas 2001–2012; fuera de muestra: 2013–2016. Fijadas antes de conocer la hipótesis (bitácora 19:18). Nunca usadas antes.
- Condición del público: sin techo de laboratorio, cupo global de 40 nacimientos/día, 60 días, `persistencia.cadaTicks=300`.
- Identidad obligatoria antes de lanzar: la rama de las leyes con ε = 0 y r = 0 da los mismos `dia-001/002.json` (fuera de p50/p95/rss) que CTRL en 2001 y 2002. Si no, CTRL se repite sobre la rama.
- Sin reajustar ε, tope ni r después de ver datos: cualquier cambio es otro preregistro con otras semillas.

## Instrumentos nuevos (solo lectura; no tocan la decisión de C8)

`vocacionVarianza`, `vocacionEntropiaArgmax`, `vocacionCoincidencia` (fracción de la ventana cuyo oficio dominante del día coincide con su vocación más alta; base esperada sin ley ≈ 0,12–0,15), `diversidadConductaVentanaGen1` (la ventana solo con mortales de generación ≥ 1: la puerta dura de la crítica del 23-09, nunca instrumentada hasta ahora), `approachHogar`, `maderaMediaAdultos`, `piedraMediaAdultos` y `muertesMenores8Dias`.

## Puerta del día 20 (frente a CTRL, pareado por semilla)

Seguridad, en cada brazo (se detiene el brazo si falla cualquiera):
- extinciones ≤ CTRL + 1;
- nacimientos acumulados ≥ 0,8× CTRL en ≥ 9/12;
- muertes con < 8 días de edad ≤ 1,5× CTRL en ≥ 9/12;
- cooperaciones acumuladas ≥ 0,6× CTRL en ≥ 9/12.

Manipulación y acoplamiento:
- VOC y VOCHOG: `vocacionVarianza` del día 20 > la del día 10 en 12/12; mediana del panel de `vocacionCoincidencia` en los días 15–20 ≥ 0,30; ganancia pareada de la ventana (media de los días 15–20) ≥ +0,03 en ≥ 7/12. Si la varianza crece pero el acoplamiento falla, la vía de transmisión latente queda muerta definitivamente (no se corren variantes).
- HOG y VOCHOG: `maderaMediaAdultos` media de los días 15–20 ≥ 1,2× CTRL en ≥ 7/12.

## Decisión del día 60 (evaluador de la etiqueta; extinguidas = fallo)

- ÉXITO de un brazo: C8 oficial en ≥ 7/12 **y** `diversidadConductaVentanaGen1` cumpliendo MK + Sen ≥ 0,02 en ≥ 7/12 **y** pendiente de Sen de los días 20..60 > 0 en ≥ 7/12 **y** C1–C7 en ≥ 6/12. Entonces se corre el fuera de muestra (2013–2016) con ese brazo y CTRL, y la adopción exige C8 en ≥ 3/4. El umbral de 7/12 (más duro que la mayoría del criterio de terminado) compensa que se prueban tres brazos.
- REFUTADO un brazo: C8 ≤ 4/12; o ≥ 2 extinciones más que CTRL; o cooperaciones del día 60 < 0,5× CTRL en ≥ 6/12. Para VOC además: Sen 20..60 ≤ 0 en ≥ 6/12 con `vocacionCoincidencia` ≥ 0,30 (acoplado pero sin tendencia: el fondo manda). Para HOG además: `approachHogar` de los días 46–60 ≥ CTRL − 0,02 en ≥ 8/12 (no ataca la causa).
- INCONCLUSO (5–6/12 en C8): decide el fuera de muestra con ≥ 3/4, sin reajustar.
- Predicciones intermedias que se informan, no deciden: VOC — ganancia pareada de la ventana en los días 46–60 ≥ +0,12 (mediana), `oficios` ≥ CTRL + 0,15, varianza de la vocación día 60/día 10 ≥ 3, entropía del argmax día 60 ≥ 0,75, Sen 20..60 > CTRL en ≥ 9/12. HOG — madera media de los adultos en los días 30–60 ≥ 1,5× CTRL, `approachHogar` de los días 46–60 ≤ CTRL − 0,05, Sen 20..60 ≥ CTRL + 0,05 en ≥ 7/12, recetas en uso del día 60 ≥ 1,3× CTRL.

## Riesgos declarados

- C4: linajes con sesgo negativo en `cooperate`/`share` pueden bajar el volumen de cooperación un 20–40 % (la variedad viene de las oportunidades, que no cambian). Umbrales 0,6× en el día 20 y 0,5× en el 60.
- C7: menos `research` en la mitad de los linajes; B tiene uso ajeno de 0,43–0,50 frente a 0,15 exigido.
- HOG: más cambios de hogar significan más viajes y pueden dispersar a los fértiles (el modo de fallo de las semillas frágiles); lo vigila la puerta de natalidad.
- Selección de linajes: una vocación ventajosa podría dominar y bajar la varianza; se mide con la entropía del argmax.
- El juguete reprodujo el éxito de «vocación + práctica» que el mundo refutó, así que sus tasas son cotas superiores.
- Tras dos ciclos fallidos de F2 se vuelve a Steven con los datos, sin tercer ciclo (plan maestro).

## Revisión 1 (antes de correr ningún brazo) — sustituye las reglas de decisión y las puertas de arriba

Motivo: crítica adversarial de GPT-6 Astra (23-09 ~20:00; veredicto «rehacer las reglas de decisión antes de correr»). Se conservan las leyes, los cuatro brazos, las semillas, la condición y C8 congelado. Todo lo de esta sección prevalece sobre las secciones «Puerta del día 20» y «Decisión del día 60» de arriba.

**Declaración sobre el control.** CTRL (reglas 11, `main` 2ee2658) se lanzó a las 19:18. Al escribir el preregistro original y esta revisión NO se leyó ningún dato suyo: solo se listó un directorio (existía `dia-022.json` de CTRL-2001 al hacer el commit 4726307). Como CTRL no tiene los instrumentos nuevos, se repite como **CTRL2** sobre la rama de las leyes con las leyes a 0 (misma dinámica), y el CTRL original sirve como comprobación de identidad a 60 días: todas sus claves de `dia-NNN.json` (fuera de p50Ms, p95Ms, rss y las claves nuevas) deben ser iguales a las de CTRL2, día a día. Las comparaciones con el control usan CTRL2.

**Congelación.** Antes de leer cualquier dato de VOC, HOG, VOCHOG o CTRL2 se congelan en `main`: el commit de la rama de las leyes (manifiesto: sha, parámetros exactos por brazo, orden de lanzamiento) y un evaluador ejecutable de esta decisión (`scripts/lab/decision-c8-linaje.mts`), probado con casos sintéticos contradictorios. Solo hay dos cortes: día 20 (seguridad) y día 60 (decisión). Una réplica que falle por causa técnica se repite idéntica (es determinista); si no se puede reproducir, cuenta como fallo.

**Instrumentos (definiciones exactas).** Cohorte W(d) = los mortales que cuentan para `diversidadConductaVentana` el día d (vivieron el día completo). Oficios de linaje L = oficios de `RASGO_DEL_OFICIO` sin `explore` (10).
- `vocacionVarianza`(d) = media sobre k ∈ L de la varianza poblacional (divisor n) de `vocacion[k]` entre los vivos con campo al final del día; null si n < 2.
- `vocacionEntropiaArgmax`(d) = −Σ p·ln p / ln|L| de la distribución del argmax (empate: el primero en el orden de L) entre los vivos con campo; null si nadie.
- `vocacionCoincidencia`(d) = entre las personas de W(d) con campo, fracción cuyo oficio dominante del día (más ticks entre L; empate: el primero en L; sin ticks en L = no coincide) es su argmax. CTRL2 no tiene vocación: su valor es null y NO se usa como base.
- `diversidadConductaVentanaGen1`(d) = la función oficial del índice sobre W(d) ∩ {generación ≥ 1}.
- `approachHogar`(d) = ticks de `approach` con destino de hogar (candidato de `settlementOpportunity`) / ticks sin `rest`, sumados sobre W(d).
- `maderaMediaAdultos`(d), `piedraMediaAdultos`(d) = media de `materials.wood`/`materials.stone` de los mortales vivos con edad ≥ 5 días al final del día.
- `muertesMenores8Dias` = acumulado de muertes de mortales con < 8 días de edad.
- `cambiosHogar`(d) = número de veces en el día que un mortal adopta un hogar distinto o pierde el suyo (dos contadores).
- `diversidadPerfilesJS`(d) = media, sobre pares de W(d), de la distancia de Jensen-Shannon (base 2) entre sus repartos de tiempo por acción sin `rest` (sin argmax ni componentes one-hot). Comprobación secundaria de diversidad sustantiva.
- Linajes: para cada mortal, su raíz = el fundador al que se llega siguiendo al progenitor transmisor. `linajesVivos`(d) = número de raíces con descendientes vivos; `linajesHerfindahl`(d) = Σ (cuota de vivos por raíz)².

**Evaluación por semilla.** C1–C8 con el evaluador de la etiqueta, forzando `--diversidad-campo` a la ventana. Gen1: la misma función de C8 (Mann-Kendall unilateral, Hamed-Rao + AR(1), p < 0,05, días 5..60, subida = pendiente de Sen × 55 ≥ 0,02) sobre `diversidadConductaVentanaGen1`. Tardía: pendiente de Sen de la ventana oficial en los días 20..60 > 0.
- **Éxito de semilla** (booleano conjunto) = cumple los 8 criterios Y Gen1 Y tardía.
- **Semilla segura en el día d** (booleano conjunto frente a CTRL2 en la misma semilla) = no extinguida Y nacimientos acumulados ≥ 0,8× CTRL2 Y (muertes con < 8 días / nacimientos) ≤ 1,5× la razón de CTRL2 + 0,02 Y cooperaciones de los días d−9..d ≥ 0,6× CTRL2 (0,5× en el día 60). Si CTRL2 se extingue en esa semilla, la semilla solo exige no extinguirse.

**Día 20 (único corte intermedio).** Un brazo se detiene si hay más de 3 semillas no seguras (menos de 9/12 seguras). Manipulación y acoplamiento (varianza, coincidencia, madera, ganancia de la ventana) se registran como diagnóstico y NO detienen: su falta de potencia no refuta el mecanismo.

**Día 60 — función de decisión por brazo, con precedencia (cada brazo recibe una sola salida).**
1. DATOS INCOMPLETOS: falta un `dia-060.json` que no sea por extinción, o un campo requerido → se repite la réplica; si no se puede, cuenta como fallo.
2. INSEGURO: menos de 9/12 semillas seguras en el día 60, o ≥ 2 extinciones más que CTRL2 → refutado por seguridad (no adoptable, sea cual sea C8).
3. ÉXITO EN PANEL: éxito de semilla en ≥ 7/12.
4. En cualquier otro caso → NO ÉXITO (sin categoría «inconcluso» ni rescate). Se registra como refutado si el éxito de semilla es ≤ 4/12.
VOCHOG hereda ambas: si en VOCHOG `approachHogar` de los días 46–60 no baja al menos 0,02 frente a CTRL2 en ≥ 5/12 semillas, se informa que el componente HOG no actuó.

**Fuera de muestra (confirmación única).** Si uno o más brazos obtienen ÉXITO EN PANEL, se elige UNO antes de abrir 2013–2016: el de más éxitos de semilla; en empate, el más simple (VOC, después HOG, después VOCHOG). Se corren ese brazo y CTRL2 en 2013–2016 y la adopción exige éxito de semilla en ≥ 3/4 Y las 4 seguras. No se prueba ningún otro candidato en esas semillas.

**Contraste frente al control (para atribuir el efecto a la ley).** Diferencia pareada por semilla de la subida de C8 (Sen × 55, días 5..60): brazo − CTRL2. «Mejora atribuible» si la diferencia es > 0 en ≥ 11/12 (prueba de signos unilateral, p = 0,0032 < 0,05/3). Además se informa la estimación factorial (VOC, HOG, interacción) con las 12 semillas. Cumplir terminado y atribuir la mejora son afirmaciones distintas y se informan por separado.

**Multiplicidad, con sus supuestos.** Si cada semilla tuviera, bajo la hipótesis nula, una probabilidad q de un falso «cumple» de C8 (calibración: q = 0,04–0,07 con series planas AR(1)), P(≥ 7 de 12) = 1,1·10⁻⁷ a 4,8·10⁻⁶ por brazo, y la cota de la unión para tres brazos es ≤ 1,4·10⁻⁵. Esa q viene de series sintéticas: no es una garantía para estas poblaciones. El panel acredita estas 12 semillas en esta condición; generalizar exige el fuera de muestra.

**Alcance de las conclusiones.** Todo resultado vale para reglas 11 en la condición pública con cupo global de 40 nacimientos/día y sin gobernador activo. «Deriva neutra» solo se afirma si la concentración de linajes (`linajesHerfindahl`) no sube frente a CTRL2 y la subida de la ventana aparece también estratificando por generación. «Conducta cada vez más diversa» solo se afirma si `diversidadPerfilesJS` también sube (Sen de los días 5..60 > 0) en ≥ 7/12 y, para «sostenida al final», si su pendiente de Sen en los días 35..60 es > 0 en ≥ 7/12. Para HOG, «reubicación productiva» exige `cambiosHogar` > CTRL2 y madera/piedra de los adultos ≥ CTRL2, además de menos `approachHogar`.

**Presupuesto.** Este ciclo prueba exactamente estos tres brazos. Un segundo ciclo (el último antes de volver a Steven) es otro preregistro con semillas nuevas.

## Manifiesto de ejecución (congelado antes de lanzar; 23-09 19:58)

- Código de las réplicas: `d2ebf11` (src/ y scripts/ idénticos a `main` 4ff017f; entre ellos solo cambian pruebas). Torre: worktree `anexo/worktrees/lab-c8` (detached en d2ebf11). Portátil: clon de un bundle de d2ebf11 en `~/atlas-lab/lab-c8` (HEAD d2ebf11).
- Evaluador de la decisión: `scripts/lab/decision-c8-linaje.mts` en `main` 4ff017f (probado con casos sintéticos contradictorios). Un «campo requerido» es una clave presente en cada `dia-NNN.json`; un valor null legítimo lo trata la regla congelada de la serie.
- Parámetros comunes: `persistencia.cadaTicks=300,limites.teselasActivas=1303552,limites.chunks=5092,limites.fauna=7821312`. Los límites son los que el servidor público deriva del hardware en la torre y en el portátil (medido hoy); sin ellos la réplica de laboratorio se cae al pasar de 65 536 teselas (f1c/SEM-3141, bitácora). Son solo de admisión: no cambian la dinámica.
- Brazos: VOC = comunes + `conducta.vocacion=0.3,conducta.vocacionTope=0.9`; HOG = comunes + `social.hogarTrabajo=1`; VOCHOG = ambos; CTRL2 = comunes (leyes a 0). Semillas 2001–2012; 60 días; sin `--techo-lab`.
- Máquinas: VOC, HOG y VOCHOG en la torre (xargs -P 36); CTRL2 en el portátil (núcleos 6–19, nice 19; el servidor público conserva los núcleos 0–5). Los resultados del portátil se copian a `/datos/tmp-atlas-lab/datos-lab/c8panel/` antes de cada corte. Determinismo entre máquinas: mismo digesto Intel/AMD (23-09).
- CTRL original (2ee2658, límites por defecto) en 2001–2004: solo para la identidad CTRL/CTRL2.
- Identidad previa al lanzamiento: con las leyes a 0, `dia-001/002.json` de 2001 y 2002 iguales a los del CTRL original (fuera de p50/p95/rss; con exactamente las 12 claves de instrumento nuevas).
- Definiciones tal como están implementadas (se declaran antes de los datos): `approachHogar` cuenta los ticks de `approach` con el motivo de `settlementOpportunity` de todos los mortales durante el día, dividido por sus ticks sin `rest` (no solo la cohorte W(d)); `muertesMenores8Dias` cuenta al pasar el registro a `retiredLegacy` (puede ir con retraso respecto a la muerte, igual en todos los brazos); las cooperaciones de la seguridad son la diferencia de acumulados por tipo de los días d−9..d.
