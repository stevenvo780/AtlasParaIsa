1. T1 completó 20/20 controles originales y T1b añadió otros 20/20; T4 dispone de 40.
2. La orden del 27-09 canceló la reposición automática: no se lanzaron más controles extra.
3. Se detuvieron y archivaron sin borrar 24 controles bajo día 45; los de día ≥45 no se interrumpieron.
4. Las 14 originales del portátil y PUB2-606/707 de torre terminaron; 26/26 relanzadas conservan 1109/1109 solapes diarios.
5. La auditoría de campaña acredita 51/52 corridas: solo HOG-2010 falla técnicamente tras día 24.
6. El evaluador C8 congelado reprodujo el día 20; los tres brazos dan DATOS_INCOMPLETOS en día 60, sin decisión C8 válida.
7. F2.1 queda refutada: PUB2 supera a B en 4/8 subidas Sen frente al umbral preregistrado de 6/8.
8. La atribución causal al techo no está identificada: PUB2/B difieren en código y parámetros; reproducción PUB2=1 es inferida.
9. T4 en 40 controles: v3 y A aprobaron 0, A′ 3, B 17 o 10, y C 0 o 1 según la base; Steven elegirá la lectura v4.
10. T5 cerró el diagnóstico descriptivo con 52 fuentes únicas; el público responde ok y C8 válido queda pendiente.

# Informe de laboratorio Codex — 26–27 de septiembre de 2026

**Estado:** cierre del laboratorio con C8 día 60 incompleto. Fuentes: bitácora del laboratorio, JSON de `balance/` y sus copias en esta rama. No se cambiaron leyes, `src/`, `tests/`, evaluadores congelados, preregistros ni el mundo público.

## T1 · Controles y operación

Las nueve CTRLV4 originales incompletas se relanzaron desde día cero con `667454d`; el panel 6001–6020 cerró **20/20** a día 60 y **464/464** días históricos solapados iguales tras excluir tiempos/RSS. La ampliación predeclarada 6021–6040 cerró **20/20**, 1200 días y **6/6** solapes. La tabla T4 de 20 se conservó íntegra y la de 40 es separada.

Al sustituirse la meta de ocupación, se detuvieron los gestores de torre y portátil. Salidas y logs de **7** controles de torre y **17** de portátil con día <45 se archivaron sin borrado. Los controles ya en día ≥45 no se interrumpieron ni se incorporaron automáticamente al panel de 40. No se iniciaron nuevas semillas de control.

## T2 · C8, ciclo 1

Las doce CTRL2 del panel están completas con el código y parámetros congelados. HOG-2010, en su relanzamiento oficial, repitió `Invalid contained water state or receipt.` después de día 24: **24/24** informes compartidos son iguales, pero faltan día 25–60 y `replica.json`. Una copia desechable en `d2ebf11` reprodujo **24/24** días canónicos y la [pila completa](hog-stack-diagnostic-20260927.log) sitúa el error en `assertWaterExecution`, guardia compuesto de `fill` de `technology-water.ts:79–86`, durante `Store.save`. La pila no identifica qué disyunto falló ni el tick exacto; la copia diagnóstica no es fuente C8. La entrada explícitamente roja del evaluador tiene **56 directorios reales y 2883 hardlinks** y se revalidó antes y después.

El [corte 20](decision-c8-d20-dirents-regresion.json) del evaluador congelado reprodujo VOC **7/12 DETENER**, HOG **11/12 CONTINUAR** y VOCHOG **7/12 DETENER**; identidad CTRL/CTRL2 **240 días, cero diferencias**. El [corte 60](decision-c8-d60.json) dice **`DATOS_INCOMPLETOS` en los tres brazos**. VOC y VOCHOG habían parado por seguridad en día 20; HOG conserva el fallo técnico. Este archivo documenta la imposibilidad de decidir C8 con el panel actual; no es una aprobación ni una refutación válida del brazo.

## T3 · F2.1

Los ocho PUB2 están completos: 505 ya existía; 5/29/101/202/404 proceden de las originales sincronizadas del portátil; 606/707 son de torre. El [veredicto](veredicto-f21.json) compara la subida Sen ×55 de `diversidadConductaVentana` en días 5–60 con los ocho B pareados de `l60v3`. PUB2 es mayor en **4/8** (202, 404, 505, 606), menor en 5, 29, 101 y 707; el umbral era **≥6/8**, por lo que la predicción direccional y la conjunta quedan **refutadas**. No hay nulos ni extinciones en esos tramos. La fracción activa PUB2=1 se deduce del modo sin techo; no está observada día a día. Como SHA y parámetros PUB2/B difieren, el efecto aislado del techo no se puede atribuir.

## T4 · Lecturas v4 calibradas solo en controles

| Lectura en 40 CTRLV4 | Aprueban | Fallan | Desconocidos |
|---|---:|---:|---:|
| C8 v3 y A, cada una | 0 | 40 | 0 |
| A′ | 3 | 37 | 0 |
| B, R100 desde día 5 | 17 | 21 | 2 |
| B, R100 sin fundadores | 10 | 29 | 1 |
| C, comunidades y linajes desde día 5 | 0 | 40 | 0 |
| C, linajes sin fundadores | 1 | 39 | 0 |

La [tabla de 20](calibracion-v4-ctrlv4.json) y la [de 40](calibracion-v4-ctrlv4-40.json) incluyen intervalos y decisiones de implementación. El objetivo descriptivo de fallo ≥90 % se observa en v3/A, A′ y C, no en B; no se extrapola a todos los mundos ni se elige lectura v4.

## T5 · Economía de hacer, solo lectura

El [balance final](diagnostico-economia-hacer-final-20260927.json) validó **52 fuentes únicas** (20 CTRLV4, 12 CTRL2, 8 PUB2, 12 B), 60 días, manifiestos, ticks y procedencia. Mediana de tiempo persona-tick en gather+build+craft+hunt, días 5–14 → 26–35 → 51–60:

| Brazo | Hacer (n por ventana) | Diversidad de ventana (n por ventana) |
|---|---|---|
| CTRLV4 | 0,146188 (20) → 0,076387 (14) → 0,065829 (14) | 0,406541 (20) → 0,375203 (14) → 0,368251 (14) |
| CTRL2 | 0,118648 (12) → 0,072315 (11) → 0,053397 (11) | 0,399582 (12) → 0,360928 (11) → 0,351549 (11) |
| PUB2 | 0,152314 (8) → 0,080549 (8) → 0,070988 (8) | 0,433521 (8) → 0,382802 (8) → 0,360347 (8) |
| B | 0,155501 (12) → 0,113266 (8) → 0,119364 (8) | 0,415664 (11) → 0,390343 (8) → 0,363072 (8) |

La [lectura mecanística](diagnostico-economia-hacer.md) registra cuatro hipótesis refutables: escasez espacial, saturación de utilidad de obras, reposición de herramientas y competencia temporal del cortejo. Sondas de tres semillas muestran pérdida de madera en sitios fijos con cobertura conocida, pero los JSON diarios no contienen stock espacial ni motivos de rechazo; población, edad y supervivencia cambian las bases. Las 40 CTRLV4 aportan una sensibilidad descriptiva separada. Ninguna correlación prueba una causa.

## T6 · Integridad y entrega

Procedencia portátil **14/14**, 42 testigos y 550 solapes; PUB2 torre **2/2**, seis testigos y 71 solapes. El [verificador total](verificacion-solapes-relanzadas.json) acredita **26/26, 1109/1109**, cero diferencias. La [auditoría](auditoria-campanas-codex.json) devuelve estado `fallo` y exit2 esperado solo por HOG-2010 (**51/52** completas). El diagnóstico de HOG no se usa como fuente C8.

En el worktree aislado pasaron `npm run typecheck` y `npm run build`. La suite completa registrada tuvo **1636 pasadas, 2 fallidas, 9 omitidas**: `resumen-vivo.test.ts:48` falla también aislada; `connection.test.ts:335` pasó aislada después de fallar bajo carga. No se alteró código prohibido para forzar un verde. Los solapes acreditan informes diarios, no igualdad de SQLite interno.

**Qué queda fuera de este cierre:** reparar el fallo de HOG-2010 y volver a obtener un panel C8 válido para día 60; Steven debe elegir y preregistrar cualquier lectura v4 antes de medir leyes. El guardia `fill` identificado no revela por sí solo la condición interna inválida. La salud pública respondió `200/ok` por HTTPS y por la ruta interna con Host correcto el 27-09 a las 16:42; no se tocó el servicio ni su mundo. No se lanzaron experimentos adicionales tras la orden de cerrar hitos.
