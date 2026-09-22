# Comparación familiar V7 → V8, trece días

Las seis corridas terminaron 31200 ticks el 22 de septiembre a las 11:30:31 UTC.
La revisión raíz comprobó las 78 ventanas diarias y sus balances de nacimientos,
muertes, causas, actividad y censos. Las seis bases cargan readonly desde slot0,
sin retroceso, con reglas, parámetros y población esperados; los hashes de base y
WAL permanecieron intactos. [Procedencia](evidencia-2026-09-22/family-v8-13d-provenance.json),
[análisis](evidencia-2026-09-22/family-v8-13d-analysis.json) y
[checkpoints](evidencia-2026-09-22/family-v8-13d-checkpoints.json).

| Semilla | Mortales V7 → V8 | Nacimientos | Muertes | Generaciones vivas |
|---|---:|---:|---:|---|
| 1007 | 0 → 0 | 0 → 0 | 14 → 14 | Ninguna en ambos |
| 1012 | 15 → 24 | 11 → 19 | 10 → 9 | 0–2 → 0–5 |
| 1013 | 22 → 20 | 25 → 27 | 17 → 21 | 0–4 → 1–5 |

El resultado es mixto. En 1007 la extinción se desplaza del tick29257 al29568, sin
ningún nacimiento en ambos brazos. En 1012 aumenta el recambio. En 1013 aparecen
más nacimientos y generaciones, pero también más muertes y menor población final.
Los usos técnicos útiles realizados por mortales pasan de 626/2014/2482 a
636/2068/2706, respectivamente; eso no demuestra beneficio demográfico causal.
Los episodios de cooperación de todos los roles pasan de 32/358/543 a 28/432/473.

Estas tres semillas se eligieron para diagnóstico a partir de observaciones previas;
no constituyen validación reservada. Cada brazo usa fuentes congeladas, igual
instrumento, cadencia20 y motor físico sin gobernador. Los tiempos concurrentes no
acreditan rendimiento del servidor. La candidata V8 sigue separada de main y del
build público. El resultado no justifica declarar sostenibilidad ni superioridad
general, ni ajustar leyes materiales para conseguir una cifra de población.
