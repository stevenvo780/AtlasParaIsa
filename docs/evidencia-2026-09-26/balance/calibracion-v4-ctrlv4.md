# Calibración descriptiva CTRLV4 a 60 días

Solo controles, sin elección de lectura ni preregistro. Wilson 95 % se calcula entre resultados conocidos. La fracción identificada del panel usa siempre 20 semillas: una incompleta o desconocida puede fallar o aprobar.

| Lectura | Aprueban / 20 | n conocido | Desconocido completo | Incompletas | Cota panel / 20 | Fracción conocida | Wilson 95 % conocidos |
|---|---:|---:|---:|---:|---:|---:|---:|
| v3 | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |
| A | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |
| A_prima | 2/20 | 20 | 0 | 0 | 0.100–0.100 | 0.100 | 0.028–0.301 |
| B_clasesR100_base5 | 9/20 | 18 | 2 | 0 | 0.450–0.550 | 0.500 | 0.290–0.710 |
| B_clasesR100_sinFundadores | 5/20 | 19 | 1 | 0 | 0.250–0.300 | 0.263 | 0.118–0.488 |
| C_comunidades_base5 | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |
| C_comunidades_sinFundadores | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |
| C_linajes_base5 | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |
| C_linajes_sinFundadores | 0/20 | 20 | 0 | 0 | 0.000–0.000 | 0.000 | 0.000–0.161 |

## Solo controles vivos al día 60

Desglose de sensibilidad: las extinciones no prueban especificidad de la lectura entre mundos vivos.

| Lectura | Cumple | Falla | Desconocido | Fracción conocida | Wilson 95 % |
|---|---:|---:|---:|---:|---:|
| v3 | 0 | 14 | 0 | 0.000 | 0.000–0.215 |
| A | 0 | 14 | 0 | 0.000 | 0.000–0.215 |
| A_prima | 2 | 12 | 0 | 0.143 | 0.040–0.399 |
| B_clasesR100_base5 | 9 | 3 | 2 | 0.750 | 0.468–0.911 |
| B_clasesR100_sinFundadores | 5 | 8 | 1 | 0.385 | 0.177–0.645 |
| C_comunidades_base5 | 0 | 14 | 0 | 0.000 | 0.000–0.215 |
| C_comunidades_sinFundadores | 0 | 14 | 0 | 0.000 | 0.000–0.215 |
| C_linajes_base5 | 0 | 14 | 0 | 0.000 | 0.000–0.215 |
| C_linajes_sinFundadores | 0 | 14 | 0 | 0.000 | 0.000–0.215 |

## Decisiones de implementación y límites

- A y A′ empiezan en el primer día con cero fundadores mortales. Si falta ese día, quedan desconocidas. A′ elimina la entropía agregada de oficios, pero el componente conducta todavía contiene un one-hot del oficio dominante.
- B informa clases funcionales rarificadas a 100 usos. C informa comunidad y linaje por separado. Base 5 y base sin fundadores son variantes descriptivas, sin seleccionar una.
- B exige subida relativa de 5 % de la media del tramo; C exige subida absoluta de 0,02. Se usa Mann–Kendall exportado por el evaluador, con Hamed–Rao + AR(1).
- Una réplica extinta falla todas las lecturas al corte, como en C8 v3; se conserva el estado de la serie sin esa regla en el JSON.
- Los valores B pueden exceder 1 y C puede ser negativo por corrección de permutaciones. Por eso no pasan por la validación [0,1] de C8 v3.
- Una serie con nulos o huecos interiores no puede aprobar: queda desconocida. El evaluador congelado aplica además una cota pesimista a esos huecos, que aquí no está exportada.
- Los intervalos de Wilson son descriptivos y no corrigen la selección de alternativas ni prueban generalización. Hay que atender también a los desconocidos.
- Esta tabla no prueba potencia frente a leyes nuevas ni reemplaza un preregistro v4 decidido por Steven.
