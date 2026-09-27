# Calibración descriptiva CTRLV4 a 60 días

Solo controles, sin elección de lectura ni preregistro. Wilson 95 % se calcula entre resultados conocidos. La fracción identificada del panel usa siempre 40 semillas: una incompleta o desconocida puede fallar o aprobar.

| Lectura | Aprueban / 40 | n conocido | Desconocido completo | Incompletas | Cota panel / 40 | Fracción conocida | Wilson 95 % conocidos |
|---|---:|---:|---:|---:|---:|---:|---:|
| v3 | 0/40 | 40 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.088 |
| A | 0/40 | 40 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.088 |
| A_prima | 3/40 | 40 | 0 | 0 | 0.075–0.075 | 0.075 | 0.026–0.199 |
| B_clasesR100_base5 | 17/40 | 38 | 2 | 0 | 0.425–0.475 | 0.447 | 0.301–0.603 |
| B_clasesR100_sinFundadores | 10/40 | 39 | 1 | 0 | 0.250–0.275 | 0.256 | 0.146–0.411 |
| C_comunidades_base5 | 0/40 | 40 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.088 |
| C_comunidades_sinFundadores | 0/40 | 40 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.088 |
| C_linajes_base5 | 0/40 | 40 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.088 |
| C_linajes_sinFundadores | 1/40 | 40 | 0 | 0 | 0.025–0.025 | 0.025 | 0.004–0.129 |

## Solo controles vivos al día 60

Desglose de sensibilidad: las extinciones no prueban especificidad de la lectura entre mundos vivos.

| Lectura | Cumple | Falla | Desconocido | Fracción conocida | Wilson 95 % |
|---|---:|---:|---:|---:|---:|
| v3 | 0 | 29 | 0 | 0.000 | 0.000–0.117 |
| A | 0 | 29 | 0 | 0.000 | 0.000–0.117 |
| A_prima | 3 | 26 | 0 | 0.103 | 0.036–0.264 |
| B_clasesR100_base5 | 17 | 10 | 2 | 0.630 | 0.442–0.785 |
| B_clasesR100_sinFundadores | 10 | 18 | 1 | 0.357 | 0.207–0.542 |
| C_comunidades_base5 | 0 | 29 | 0 | 0.000 | 0.000–0.117 |
| C_comunidades_sinFundadores | 0 | 29 | 0 | 0.000 | 0.000–0.117 |
| C_linajes_base5 | 0 | 29 | 0 | 0.000 | 0.000–0.117 |
| C_linajes_sinFundadores | 1 | 28 | 0 | 0.034 | 0.006–0.172 |

## Decisiones de implementación y límites

- A y A′ empiezan en el primer día con cero fundadores mortales. Si falta ese día, quedan desconocidas. A′ elimina la entropía agregada de oficios, pero el componente conducta todavía contiene un one-hot del oficio dominante.
- B informa clases funcionales rarificadas a 100 usos. C informa comunidad y linaje por separado. Base 5 y base sin fundadores son variantes descriptivas, sin seleccionar una.
- B exige subida relativa de 5 % de la media del tramo; C exige subida absoluta de 0,02. Se usa Mann–Kendall exportado por el evaluador, con Hamed–Rao + AR(1).
- Una réplica extinta falla todas las lecturas al corte, como en C8 v3; se conserva el estado de la serie sin esa regla en el JSON.
- Los valores B pueden exceder 1 y C puede ser negativo por corrección de permutaciones. Por eso no pasan por la validación [0,1] de C8 v3.
- Una serie con nulos o huecos interiores no puede aprobar: queda desconocida. El evaluador congelado aplica además una cota pesimista a esos huecos, que aquí no está exportada.
- Los intervalos de Wilson son descriptivos y no corrigen la selección de alternativas ni prueban generalización. Hay que atender también a los desconocidos.
- Esta tabla no prueba potencia frente a leyes nuevas ni reemplaza un preregistro v4 decidido por Steven.
