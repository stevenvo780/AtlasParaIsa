# Semilla pública: contraste V7 y V9 durante 25 días

Las dos réplicas de semilla51926 completaron60000 pasos, sin entradas y con los22
parámetros capturados del servidor público: guardado cada100, ventana24000 y
presupuesto50ms. El motor utilizado fue `world`: el gobernador no se ejecutó.
Son mundos nuevos con la semilla ya observada; no un replay del servidor público
ni una muestra reservada para evaluar superioridad.

| Resultado al día25 | V7 | V9 |
|---|---:|---:|
| Vecinos mortales vivos, excluidos S/I |137|144|
| Nacimientos acumulados |190|179|
| Muertes mortales |67|49|
| Generaciones mortales vivas |2–10|2–10|
| Usos útiles acumulados de vecinos |12407|12761|
| Beneficio acumulado de esos usos |1700,484|1628,164|
| Cooperaciones acumuladas, todos los roles |5337|4708|

Ambas trayectorias conservan descendientes después del recambio de los catorce
fundadores mortales. V9 deja más vecinos y menos muertes, pero también menos
nacimientos, beneficio útil y cooperación acumulada. Una pareja de trayectorias
diagnósticas no demuestra una mejora general ni continuidad indefinida. No anula
las extinciones y el resultado adverso del contraste V8→V9 de13 días.

## Controles

Se verificaron las50 ventanas diarias: horizonte absoluto, balance de población,
causas de muerte, atribución de uso por rol y correspondencia con las muestras.
Una auditoría independiente abrió únicamente copias privadas de DB/WAL con el
Store congelado de cada motor. Los dos checkpoints corresponden a seed51926,
reglas7/9, tick60000, slot0, skipped vacío y cero entradas. Los22 parámetros son
exactos; el digesto del cuerpo decodificado coincide con el de la carga, sin
normalización. Run y día25 coinciden con el mundo; originales y copias conservan
sus bytes. [Análisis](evidencia-2026-09-22/default25-analysis.json),
[checkpoints](evidencia-2026-09-22/default25-checkpoints.json).

Motores `3dd615e` y `cf04ac4`, instrumento
`12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542`.
El wrapper privado congelado es
`68bdccf3e50e9cd990ca061dfcc5e82b7ce69f029fec07efae1b094600166733`.
Terminó a las13:00:48UTC; dos procesos, plazo simétrico2h y guardas de disco.
El wrapper precede la comprobación portable posterior de seed/versión: aquí la
auditoría independiente sí las comprueba. Se conserva el primer lanzamiento
interrumpido por ENOENT del observador de disco, sin sumarlo como otra réplica.
[Contrato operativo](ops/default-seed-2026-09-22.md).

## Diferencia respecto al mundo público

El mundo público V7 perdió sus vecinos. Cuatro backups históricos, descomprimidos
en privado y leídos sin modificar los originales, muestran seis nacimientos en
t2900; siete en t16300, con reproducción desactivada en ese snapshot; y todavía
siete en t46100 y t82000. La última copia sólo contiene S/I. Todos carecen de
entradas y sus checksums coinciden.
[Cortes de backups](evidencia-2026-09-22/default25-public-backups.json).
Ese estado confirma una pausa, pero no reconstruye su duración ni atribuye por sí
solo la extinción al gobernador. El snapshot se guarda antes de la decisión del
gobernador correspondiente a ese paso.

Un control adicional de1200 ticks compara el mismo V7 y parámetros en tres modos:
paso directo, paso con contexto de Store y createApp con reproducción explícitamente
habilitada. El digesto completo coincide en cada paso; quedan once cortes publicados.
[Control inicial](evidencia-2026-09-22/default25-app-control.json).
Esto descarta una divergencia inmediata del clon/contexto en ese prefijo, no una
diferencia posterior. No reproduce las pausas históricas ni los60000 ticks del
servicio. Los tiempos del lote compartido no son un benchmark del servidor.
