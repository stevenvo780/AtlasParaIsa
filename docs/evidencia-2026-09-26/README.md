# Evidencia del laboratorio — 26 de septiembre de 2026

Este directorio reúne **copias de scripts y resultados agregados** de la tanda de laboratorio. Es un índice de procedencia, no un veredicto final. Los datos diarios, manifiestos de réplica y logs permanecen en los directorios de las campañas; aquí no se copiaron mundos SQLite, páginas de snapshot ni estado personal crudo. Las rutas de origen dentro de algunos JSON identifican el almacén temporal leído y pueden dejar de existir cuando termine una réplica.

## Código y procedencia

| Elemento | Procedencia y alcance |
|---|---|
| CTRLV4 | Réplicas desde el código congelado `667454d5e0232885d78c37775d6a5619f516872d` (`lab-v4`). |
| HOG, CTRL2 y PUB2 | Réplicas desde el código congelado `d2ebf11d51c3221477d88c7045faeafa2a229683` (`lab-c8`). |
| [Gestor ejecutado](scripts/analysis/launch-codex-campaigns-executed.py) | Copia de la versión que lanzó las réplicas. Consérvese para interpretar la ejecución histórica. |
| [Gestor endurecido](scripts/analysis/launch-codex-campaigns.py) | Versión posterior con controles adicionales; **no** sustituye retroactivamente al gestor ejecutado. |
| [Scripts de análisis](scripts/analysis/) | Copias de los analizadores y verificadores de esta entrega. Cada copia debe cotejarse byte a byte con `scripts/analysis/` del commit de entrega. Los SHA congelados anteriores identifican el **código de las réplicas**, no el commit de estos analizadores. |

Las copias de scripts se conservan byte a byte respecto de sus originales en la rama al cerrar la entrega. Eso no significa que los `dia-NNN.json` de una réplica antigua y su relanzada sean idénticos en bytes: la comparación de determinismo excluye campos de tiempo y RSS, canonicaliza el JSON y compara SHA-256 del resultado normalizado.

## Resultados presentes

| Artefacto | Qué acredita y qué no |
|---|---|
| [C8 día 20](balance/decision-c8-d20.json) | Corte de seguridad de referencia: VOC y VOCHOG recibieron `DETENER`; HOG recibió `CONTINUAR`. **No** es una decisión del día 60. |
| [Prueba roja HOG-2010](balance/verificacion-fallo-hog-2010.json) y [verificador](scripts/analysis/verificar-hog-2010.py) | La corrida archivada y la relanzada contienen exactamente los días 1–24, con SHA-256 canónicos iguales para los 24 JSON diarios y huellas de ambos logs. Ambas carecen de días 25 y 60 y de manifiesto final. La relanzada volvió a fallar con `Invalid contained water state or receipt.`. El JSON marca estado `rojo`; no se clasifica como extinción ni parada planificada. |
| [Agregados de snapshots](balance/) | Sondas de economía de CTRLV4-6009, 6013 y 6018: cifras derivadas, digest del cuerpo y metadatos de lectura. Las comparaciones pre/post deben respetar semilla, centro y cobertura de teselas; cobertura cambiante impide llamar agotamiento a una diferencia de stock observado. |

Los snapshots se leyeron de SQLite temporales del **laboratorio** en modo de solo lectura. Sus digest permiten identificar los cuerpos observados, pero los JSON agregados no contienen teselas completas ni permiten reconstruir el mundo. El diagnóstico de economía basado en series diarias y estas sondas es descriptivo: no prueba una causa única de la caída de `gather`, `build`, `craft` y `hunt`, ni completa por sí solo el balance de costes, reparación y utilidad exigido por [GOAL.md](../../GOAL.md).

## Estado y cierre pendiente

La decisión C8 del día 60 **no es válida mientras HOG-2010 no tenga una réplica completa**. El fallo repetido tras el día 24 bloquea ese corte bajo el evaluador congelado. VOC y VOCHOG se detuvieron por la regla de seguridad del día 20; si el evaluador muestra `DATOS_INCOMPLETOS` para ellos en un corte posterior, esa etiqueta reflejaría la parada planificada, no un nuevo veredicto favorable.

Faltan los resultados completos y la auditoría final de CTRLV4, CTRL2 y PUB2; la evaluación F2.1 con PUB2 completo; la tabla de calibración v4 sobre los veinte controles completos; y el recálculo de economía con los datos finales. Los futuros JSON, tablas e informe final deberán indicar su fecha de corte, entradas, cantidad de réplicas válidas, SHA-256 de procedencia y límites de interpretación. Su mera presencia en `balance/` no cambia este estado: el informe final deberá declarar explícitamente los gates y los bloqueos que persistan.
