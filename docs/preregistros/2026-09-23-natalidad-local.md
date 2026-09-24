# Preregistro — natalidad por reposición local, NAT-L (23 de septiembre de 2026, noche)

Escrito antes de fusionar la ley y antes de lanzar cualquier réplica con ella. Diseño: Opus (`/datos/tmp-atlas-lab/delegaciones/natalidad-diseno.md`, 23-09 ~21:30; solo lectura, sin simulaciones largas). Implementación desactivada por defecto: rama `sprint/natalidad-local-20260923`. Preregistro y decisiones: Opus. Plan maestro: T4 (natalidad). Campaña independiente de C8: corre cuando el ciclo 1 de C8 libere CPU, y su control lleva las reglas vigentes en ese momento.

## Diagnóstico que lo motiva

- Hoy manda un número, no la ecología. El cupo global (`poblacion.nacimientosPorComprobacion` = 2 por ventana de 120 pasos) da exactamente 40 nacimientos al día desde que la población pasa de ~250–400 habitantes: en el público (1 696 → 1 791 nacimientos en 2,375 días), en el gemelo `f1c/SEM-51926` desde el día 22, en SEM-3141 desde el 20 y en los cuatro mundos «grande». La meseta ≈ 40 × 17,3 días de vida media ≈ 690 es un tope fijo de software, contrario a FR-013/R17 (el límite lo pone el hardware).
- Sin el cupo, la natalidad libre (b₀ ≈ 0,135 por habitante y día, días 8–20 del gemelo) frente a una mortalidad de ≈ 0,062 duplicaría la población cada ~10 días hasta chocar con el hardware o sobreexplotar el agua.
- La comida no limita (capacidad de reposición 7–31 veces la del agua; 0 muertes por hambre de 1 121 en el público). El agua sí aprieta localmente: con radio 12, mediana de x = personas/capacidad de reposición de agua de 0,61–0,64 y 22–34 % de la gente con x > 1, aunque en conjunto se repone 3–6 veces más agua de la que se bebe, lejos de donde vive la gente.

## Ley (valor por defecto 0 = mundo bit a bit igual a las reglas vigentes)

- `poblacion.natalidadLocal` = α ∈ [0, 4] y `poblacion.radioProvision` = R ∈ [4, 32] (16 por defecto, inerte con α = 0).
- Para cada pareja candidata de `reproduce()`, con L su lugar: A_L y C_L = reposición diaria esperada de agua (fuentes en cuenca con la lluvia media del clima, manantiales, cisternas con estado > 0,1) y de comida (rendimiento sostenible de las teselas de tierra) a ≤ R de L; K_L = α·min(A_L/demanda de agua, C_L/demanda de comida); x_L = n_L/K_L con n_L = todas las personas vivas a ≤ R (crías, S e I incluidas, porque beben); K_L = 0 ⇒ x_L = ∞.
- Se concibe solo si x_L < 1 y, para cada progenitor p, `tick − p.lastBirth ≥ T_p/(1 − x_L)` (T_p = su `fertilityCooldown` genético). Con α > 0 no hay cupo global. Sin azar, sin campos nuevos en el mundo, sin crear recursos ni impedir muertes. Blurton Jones 1986; Ellison 2003; el freno preventivo de Malthus.
- Brazo: α = 1 (equivalencia física entre lo repuesto y lo demandado, no se ajusta) y R = 16 (de las cifras del diagnóstico, calibradas con 51926 y el V10; ninguna semilla de decisión se miró).
- Sin reajustar α ni R después de ver datos: cualquier cambio es otro preregistro con otras semillas.

## Hipótesis

H-N: con α = 1 y R = 16, la natalidad deja de estar fijada por un número y pasa a depender del agua y la comida que se reponen donde vive la gente; la población se regula por debajo de esa reposición sin oscilar ni explotar, y el mundo sigue vivo (C1–C8 no empeoran). Predicción central declarada: sin redistribución espacial la meseta queda por debajo del cupo (N\* ≈ 430–550 en el patrón del gemelo); con reparto libre ideal sobre el territorio ocupado, ≈ 1 700–2 000. Se espera un valor intermedio y se informa, pero el nivel solo decide la adopción (abajo), no la validez del mecanismo.

## Brazos, semillas y condición

- CTRL = las reglas vigentes en `main` al lanzar (11, o 12 si C8 adopta un brazo), corrido sobre la rama de la ley con α = 0 para tener los instrumentos nuevos. NAT = CTRL + `poblacion.natalidadLocal=1,poblacion.radioProvision=16`. El manifiesto de ejecución fija el sha y los parámetros exactos antes de lanzar.
- Condición del público: sin techo de laboratorio, límites de admisión del anfitrión (`hostParams`), `persistencia.cadaTicks=300`, 60 días. Alarma `--techo-lab 5000` en NAT y en CTRL: tocarla cuenta como explosión (fallo), aunque el techo cambie la dinámica desde ese momento.
- Identidad antes de lanzar: la rama con α = 0 da los mismos `dia-001/002.json` que `main` en 4001 y 4002 (fuera de p50Ms, p95Ms, rss y las claves nuevas del instrumento).
- **Etapa 1, cribado de 20 días** (solo puede detener, nunca ajustar): semillas 4101–4104 × {CTRL, NAT-R16, NAT-R12, NAT-R24}. Solo NAT-R16 tiene puertas; R12 y R24 describen la sensibilidad a R.
- **Etapa 2, decisión a 60 días**: semillas 4001–4012 × {CTRL, NAT}; fuera de muestra 4013–4016. Ninguna usada antes (la serie 4xxx no aparece en ninguna bitácora ni campaña).
- Panel de seguridad descriptivo (no decide; solo si hay CPU libre): 51926 (gemelo del público) y los regímenes frágiles 13, 17, 23 y 303, × {CTRL, NAT}.

## Instrumento `natalidadLocal` (solo lectura; definiciones exactas)

Por día d, en cada `dia-NNN.json`:
- `nacimientosDia` = nacimientos de mortales del día.
- `xNacimientos` = {p10, p50, p90} de x_L evaluado por la ley en el lugar de cada nacimiento del día, en el momento de concebir; null si no hubo nacimientos. En CTRL (α = 0) se calcula igual con α = 1 como sonda pasiva, sin decidir nada.
- `xFertiles` = {p10, p50, p90} de x con α = 1 y el mismo R en la posición redondeada de cada mortal fértil vivo al final del día; null si no hay ninguno.
- `bloqueadasPorLey` = parejas candidatas que la ley rechazó en el día (0 con α = 0).
- `kOcupado` = K con α = 1 sobre la unión de las teselas a ≤ R de algún mortal vivo al final del día (cada tesela y cada cisterna cuentan una sola vez); `nSobreKOcupado` = personas vivas (S e I incluidos) / `kOcupado`.
- `limitante` = {agua, comida}: fracción de los nacimientos del día en que el término mínimo de K_L fue el agua o la comida.
La implementación debe coincidir con estas definiciones; si no coincide, se corrige la implementación o se declara la diferencia en el manifiesto ANTES de lanzar.

## Puertas de la Etapa 1 (día 20, NAT-R16 frente a CTRL, pareado por semilla)

La Etapa 2 no se lanza si falla cualquiera:
- ninguna extinción de NAT en una semilla donde CTRL vive;
- nacimientos acumulados de NAT ≥ 0,5× CTRL en 4/4;
- muertes por sed de NAT ≤ CTRL + 3 en 4/4;
- mediana de `xNacimientos.p50` de los días 10–20 < 0,75 en ≥ 3/4;
- ninguna réplica toca la alarma de 5 000.
Si se detiene, lo siguiente es un preregistro nuevo con otras semillas (y, si procede, otro α o R).

## Decisión del día 60 (una salida por semilla y una por brazo, con precedencia)

Por semilla (NAT frente a CTRL en la misma semilla):
- **Segura** = NAT no se extingue (salvo que CTRL también se extinga) Y nunca toca 5 000 Y fracción de muertes por sed ≤ máx(1,5× CTRL, CTRL + 0,03) Y fracción de muertes por hambre ≤ CTRL + 0,01 Y fauna del día 60 ≥ 0,5× CTRL.
- **Mecanismo** = coeficiente de variación de `nacimientosDia` en los días 30–60 > 0,15 Y la mediana de `xNacimientos.p50` en los días 30–60 < la mediana de `xFertiles.p50` en los mismos días. (Con el cupo los nacimientos son exactamente 40 al día y el CV es ≈ 0; el ruido de Poisson solo daría ≈ 0,16, así que el segundo término es el que muestra que la ley actúa).
- **Regulada** = población máxima < 5 000 Y amplitud sin tendencia < 0,15 (media móvil de 5 días de la población en los días 30–60; residuo de la recta ajustada a su logaritmo; máximo − mínimo del residuo < 0,15: el crecimiento lento con el territorio no cuenta como oscilación) Y `nSobreKOcupado` de los días 45–60 dentro de ±10 % de su media.

Por brazo, en este orden:
1. DATOS INCOMPLETOS: falta un `dia-060.json` que no sea por extinción, o una clave requerida → se repite la réplica (es determinista); si no se puede, cuenta como fallo.
2. INSEGURO: menos de 10/12 semillas seguras, o NAT con más de una extinción más que CTRL → refutada por seguridad.
3. VÁLIDA EN PANEL: mecanismo en ≥ 10/12 Y regulada en ≥ 9/12 Y C1–C7 (evaluador de la etiqueta `c8-v3-preregistro`) cumplidos a la vez en ≥ (las semillas en que CTRL los cumple) − 1 Y cada criterio C1…C7 por separado en ≥ el de CTRL − 1 Y C8 en ≥ el de CTRL − 1.
4. Cualquier otro caso → NO VÁLIDA (sin «inconcluso»).

**Fuera de muestra** (solo si VÁLIDA EN PANEL): NAT y CTRL en 4013–4016; confirma si mecanismo y seguridad se cumplen en ≥ 3/4.

**Adopción** (reglas nuevas y mundo público nuevo) = VÁLIDA EN PANEL Y confirmada fuera de muestra Y nivel: mediana, sobre las 12 semillas, del cociente pareado de la población media de los días 50–60 NAT/CTRL ≥ 0,8. Si es válida y confirmada pero el nivel queda por debajo de 0,8, la salida es VÁLIDA SIN ADOPCIÓN, y la hipótesis siguiente es la dispersión por hacinamiento (`social.hogarHacinamiento`, en otro preregistro): una ley que baja la población del público no se adopta solo por ser más coherente.

## Qué se informa además (no decide)

Población y nacimientos al día, `kOcupado` y chunks explorados, `limitante` (se predice agua en > 95 % de los nacimientos), `bloqueadasPorLey`, causas de muerte, fauna, p50/p95 del paso, rss, bytes de la instantánea y recibos por guardado, C8 v3 como descripción, y los brazos R12/R24 del cribado. Predicciones del diseño que se contrastan: crecimiento temprano del 70–90 % del control; meseta sin redistribución hacia los días 25–35 y después ≤ 2 %/día al ritmo del territorio; muertes por hambre 0; en las semillas secas (7, 17, 303) ningún nacimiento hasta llegar a ≤ 16 celdas de una fuente.

## Riesgos declarados

- Población por debajo de la del cupo si la gente no se redistribuye (N\* ≈ 430–550 en el patrón del gemelo): lo recoge la condición de nivel de la adopción.
- Arranques secos: sin nacimientos hasta encontrar agua; más extinciones en semillas frágiles. Lo vigilan la seguridad y el panel descriptivo.
- La fauna bebe el mismo agua y no entra en n: K de los humanos puede estar sobrestimado hasta ~2×. Lo vigilan las muertes por sed y la fauna.
- Las parejas bloqueadas siguen cortejando (`reproductiveReadiness` no cambia): más `approach` puede empeorar la deriva que daña C8. Por eso C8 no puede empeorar más de una semilla.
- Coste: `reproduce()` sin cupo recorre a todos en cada paso y la ley lee ~800 teselas por lugar evaluado (con memoria por lugar dentro del paso). Se mide p95 del paso en ambos brazos.
- Con la ley en el público, `gobernador.presupuestoMs=5000` deja de ser inocuo si la población pasa de ~1 000: antes de publicar se le plantea a Steven un presupuesto de ritmo real.

## Congelación

Antes de leer cualquier dato de NAT se congelan en `main`: el commit de la rama de la ley (manifiesto: sha, parámetros exactos por brazo, máquinas y orden de lanzamiento) y un evaluador ejecutable de estas reglas (`scripts/lab/decision-natalidad.mts`), probado con casos sintéticos contradictorios. Hay dos cortes: día 20 de la Etapa 1 y día 60 de la Etapa 2. Una réplica que falle por causa técnica se repite idéntica.

**Alcance.** El resultado vale para las reglas vigentes al lanzar, en la condición pública, sin gobernador activo y con α = 1, R = 16. «La ecología regula la población» solo se afirma si mecanismo y regulación se cumplen; «el límite lo pone el hardware» no se afirma con esta campaña (la población no llega a la escala del hardware).

## Revisión 1 (antes de lanzar nada y antes de fusionar la ley) — prevalece sobre lo de arriba

Motivo: crítica adversarial de Gemini 3.1 Pro (23-09 ~22:05; «congelar con estas correcciones»), comprobada contra el código. Se conservan la hipótesis, α, R, los brazos, las semillas y la condición.

**1. Demanda real, no constante.** La sed por paso depende de la tesela y de la fisiología (`bodilyNeedRates`: 0,00045 + 0,0002 en desierto, por `waterDemand` genético; el hambre, por `foodDemand`). El diseño usaba 0,36 fijo (y 0,38 en su propio diagnóstico): sobrestimaba K hasta un 45 % en desierto. Nueva definición: x_L = máx(W_L/(α·A_L), F_L/(α·C_L)), donde W_L y F_L son la suma de la demanda diaria de agua y de comida de las personas vivas a ≤ R de L, cada una calculada con la MISMA función del motor (`bodilyNeedRates` en su tesela, con su fisiología; S e I con la suya) × pasos por día / unidades por trago o bocado. Con A_L = 0 o C_L = 0 y alguien que demande, x_L = ∞. `K`, `kOcupado` y `nSobreKOcupado` se sustituyen por sus equivalentes de demanda: `kOcupado` = {agua: A, comida: C} sobre la unión ocupada y `nSobreKOcupado` = máx(W/A, F/C) sobre esa unión (α = 1). `limitante` es el término que da el máximo.

**2. El CV no demuestra el mecanismo.** A 12–40 nacimientos al día el ruido de Poisson ya da un CV de 0,16–0,29. El CV > 0,15 se queda como comprobación de que no hay cupo (se informa) y **sale de la decisión**. Mecanismo (por semilla) pasa a ser:
- brecha = mediana, sobre los días 30–60, de (`xFertiles.p50` − `xNacimientos.p50`) del mismo día; en CTRL se mide igual con la sonda pasiva (α = 1 sin decidir). Exige brecha(NAT) > brecha(CTRL): la ley desplaza los nacimientos hacia donde se repone más de lo que se consume, más de lo que ya ocurre sin ella;
- Y `bloqueadasPorLey` > 0 en al menos 15 de los 31 días 30–60 (la ley actúa, no es decorativa).
Umbrales por brazo sin cambios (mecanismo en ≥ 10/12). En la Etapa 1, la puerta de `xNacimientos` se mantiene.

**3. Nulos.** Las medianas y los mínimos de una ventana se calculan sobre los días con valor no nulo. Si en los días 30–60 hay menos de 20 días con `xNacimientos` y `xFertiles` a la vez no nulos, la semilla NO cumple mecanismo (no es «datos incompletos»: una clave presente con null es un dato). Para la amplitud y `nSobreKOcupado` se usan todos los días con población > 0; una semilla extinguida ya es no segura.

**4. Coherencia de la Etapa 1.** Los nacimientos acumulados del día 20 se cuentan con `nacimientosDia`, y las muertes por sed con las causas del registro de muertes, igual en ambos brazos.
