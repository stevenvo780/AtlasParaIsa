# Resultado de V8 frente a V9 a trece días

El contraste no acredita mejora demográfica. Las seis corridas terminaron los
31200 ticks previstos a las12:12:09UTC del22 de septiembre. La revisión comprobó
las78 ventanas diarias, balances de población, causas de muerte y actividad útil
separada por mortales y S/I. Se conservan
[análisis](evidencia-2026-09-22/family-v9-13d-analysis.json) y
[procedencia](evidencia-2026-09-22/family-v9-13d-provenance.json).

La revisión independiente recargó los seis checkpoints con sus propios motores
congelados desde copias privadas idénticas: slot0, sin fallback, reglas8/9,
semilla y22 parámetros exactos, tick31200, cero inputs y digesto completo intacto.
Los hashes DB/WAL de originales y copias no cambiaron. No abrió los originales
con SQLite. [Verificación de checkpoints](evidencia-2026-09-22/family-v9-13d-checkpoints.json).

| Semilla | Mortales V8 → V9 | Nacimientos | Muertes | Generaciones mortales vivas |
|---|---:|---:|---:|---|
|1007|0 → 0|0 → 0|14 → 14|Ninguna en ambos|
|1012|24 → 14|19 → 12|9 → 12|0–5 → 0–2|
|1013|20 → 20|27 → 27|21 → 21|1–5 en ambos|

En1007 la extinción pasa del tick29568 al30682, sin ningún nacimiento. Los
resultados de provisión familiar con aumento neto de inventario pasan de6 a9,
pero eso no basta para sostener familias. En1012 disminuyen nacimientos, población
y generaciones vivas. En1013 todas las métricas diarias físicas observadas son
iguales entre brazos; se excluyen únicamente tiempos y RSS de esa comparación.

Los usos técnicos útiles de mortales pasan de636/2068/2706 a631/1935/2706;
la cooperación acumulada de todos los roles pasa de28/432/473 a27/386/473.
No se suman las vistas de enseñanza a la cooperación ni se equipara uso técnico
con beneficio reproductivo. El coste corporal observado durante una intención
es neto del tick, no una atribución causal exclusiva a ese trabajo.

Las39 ventanas del brazo V8 reproducen exactamente las métricas físicas del
candidato V8 del experimento anterior, excluidos tiempos y RSS. Esta repetición
sirve como control del instrumento y la procedencia. No convierte estas semillas
ya observadas en un conjunto reservado ni permite generalizar una tasa de éxito.

El mecanismo local de V9 evita una cosecha finita donde otro individuo lleva
ventaja visible; sus controles causales se mantienen en
[la revisión del mecanismo](REVISION-CONTENCION-V9-2026-09-22.md). Que ese control
pase no demuestra que la población mejore. No se ajustó el margen temporal, las
semillas, el horizonte ni las métricas después de observar esta tanda.

Fuentes congeladas: V8`eaa2709` y V9`cf04ac4`; instrumento común
`12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542`.
Seis procesos,13 días,Store cada20 ticks,una hora por réplica,sin gobernador,
clientes ni entradas humanas. Los tiempos concurrentes no son un gate de
rendimiento ni reproducen las pausas del mundo público. La comparación aparte
V7/V9 de la semilla pública51926 conserva sus propios parámetros e instrumento;
no se mezcla con este resultado.

El build público continúa en V7`3dd615e`. GOAL.md y la sostenibilidad siguen
abiertos; este resultado no respalda publicar V9 como solución demográfica.
