# T138 — Banco de red a escala con desglose obligatorio por campo

Rama: `sprint/t138-banco-red-20261119`. Cierra la medición de SC-005 para T134
sobre un mundo recién creado: el banco es el instrumento, no una regla nueva.

## Qué se tocó

- `scripts/banco-red.mts` (nuevo): levanta un servidor real (`createApp` +
  HTTP/WebSocket; puerto efímero reservado con una sonda `listen(0)`, el
  patrón de `tests/lib/net.ts`, porque `createApp` necesita el `origin` con
  puerto antes de escuchar) sobre un `CARTA_DATA_DIR` temporal que se limpia
  al salir de cada escala. Inyecta habitantes sintéticos válidos —clones
  estructurales de un vecino real, fuera de `stepWorld`, solo para medir
  tamaño— hasta el total de cada escala: unos 40 dentro del viewport medio
  (12×8, rejilla junto a (1,1)) y el resto distribuido en el terreno lejano
  (500,500)+, fuera de todo viewport. Conecta hasta 12 clientes WebSocket
  (por defecto 12; `--clientes C`, `--escalas 40,1000,10000`, `--pasos P`,
  `--salida <json>`) con viewports distintos. Cada paso es un ciclo de
  difusión por el mensaje público `{type:'viewport'}` y mide
  `Buffer.byteLength(rawMessage)` de cada `state` recibido.
- `package.json`: script `"banco:red": "tsx scripts/banco-red.mts"`.
- `tests/banco-red.test.ts` (nuevo): corre el banco a 40 / 1 000 / 10 000
  habitantes con 3 clientes × 2 pasos y verifica el desglose, el techo y los
  campos acotados (abajo).
- `specs/002-mundo-ilimitado/tasks.md`: T138 marcada como hecha.

No se tocó ninguna fórmula del mundo ni `projectWorld`: el banco mide el
contrato vigente de T134, no lo cambia.

## Cómo se mide

Para cada escala: bytes por paso por cliente (media y p95 de los mensajes
crudos `state`), egress total, mensajes descartados (esperados − recibidos
tras agotar la espera) y sockets terminados (cierres antes del desmontaje).
El desglose suma bytes UTF-8 de `JSON.stringify(campo)` para `tiles`,
`people`, `communities`, `blueprints`, `technology`, `events`, `animals`,
`structures`, `stats`, `demography`, `organization`, `memories` y `places`,
más el sobrecoste de envoltura (total − suma de campos: claves, resto de
escalares, `performance`, `instanceId` y `regionesVivas` que añade el
servidor); la suma coincide con el total por construcción y la prueba exige
que quede dentro de ±2 % (medido: 0,00 % en las tres escalas). Entre 1 000 y
10 000, con los mismos 40 visibles, un campo acotado se declara creciendo si
superara 1,5× + 1 KiB (lineal sería ≈10×).

## Cifras medidas (12 clientes, 5 pasos, esta torre, 2026-11-19)

| Métrica | 40 hab. | 1 000 hab. | 10 000 hab. |
|---|---:|---:|---:|
| Habitantes en vista media (12×8) | 24 | 40 | 40 |
| `state` en vista media (B) | 49 211 | 66 125 | 66 130 |
| `state` en vista media (KiB) | 48,1 | 64,6 | 64,6 |
| Bytes/paso/cliente, media (B) | 98 016 | 113 080 | 113 085 |
| Bytes/paso/cliente, p95 (B) | 273 568 | 290 482 | 290 488 |
| Egress total (B) | 5 880 955 | 6 784 794 | 6 785 111 |
| Mensajes descartados | 0 | 0 | 0 |
| Sockets terminados | 0 | 0 | 0 |

El p95 corresponde al cliente con viewport máximo (40×28): sus teselas
dominan ese mensaje. La media mezcla los 12 viewports distintos.

### Desglose por campo del `state` en viewport medio (bytes UTF-8)

| Campo | 40 hab. | 1 000 hab. | 10 000 hab. |
|---|---:|---:|---:|
| tiles | 18 653 | 18 653 | 18 653 |
| people | 25 065 | 41 789 | 41 789 |
| communities | 500 | 693 | 694 |
| blueprints | 2 | 2 | 2 |
| technology | 464 | 464 | 464 |
| events | 300 | 300 | 300 |
| animals | 2 | 2 | 2 |
| structures | 2 | 2 | 2 |
| stats | 1 281 | 1 281 | 1 281 |
| demography | 94 | 94 | 94 |
| organization | 892 | 892 | 892 |
| memories | 972 | 972 | 972 |
| places | 2 | 2 | 2 |
| sobrecoste de envoltura | 982 | 979 | 983 |
| **Total** | **49 211** | **66 125** | **66 130** |

A 40 habitantes solo hay 24 inyectados visibles (16 fundadores fuera de la
vista media); por eso `people` crece de 40 a 1 000 habitantes y queda plano
de 1 000 a 10 000, que es la comparación que cierra el criterio: ningún
campo acotado por viewport (`people`, `communities`, `blueprints`, `tiles`)
crece entre 1 000 y 10 000 (ratios 1,000 / 1,001 / 1,000 / 1,000) y el
`state` medio se mantiene en 64,6 KiB < 120 KiB (122 880 B) en ambas.

## Alcance honesto de la medida

El mundo del banco es recién creado y los sintéticos no portan ítems
tecnológicos, así que `technology` (464 B) no ejercita el hallazgo ya
documentado en `tests/world-view-size.test.ts` (FR-026): en un mundo crecido
varios días, `technology.items` de `projectTechnology` recorre toda la
población y domina el `state`. Ese campo no está en la lista de acotados de
T138 y su arreglo no es fichero de esta tarea; queda nombrado aquí para que
la tabla no se lea como si lo refutara. Las cifras históricas de la tarea
(270 503 B con 16 habitantes en 40×28) son anteriores a la dieta de T134 y
ya no son la línea base: hoy ese viewport da ≈284 KiB en crudo por las
teselas, y el techo de 120 KiB se verifica en el viewport medio, como pide
el cierre de T134.

## Pruebas

- `npm run typecheck` — 0 errores.
- `npx tsx --test tests/banco-red.test.ts tests/world-view-size.test.ts` —
  11/11 verdes (3 del banco + 8 de tamaño de vista). La prueba del banco
  afirma, a 10 000 habitantes con ~40 visibles: `state` < 122 880 B,
  `people` solo con los visibles y sin ningún id `lejos-*` en el cable,
  `communities` con `memberCount` ≥ 9 000 pero < 100 miembros enviados, el
  desglose dentro de ±2 % en las tres escalas, 0 descartados y 0 sockets
  terminados.
- `npm run banco:red -- --salida <json>` — las cifras de las tablas de arriba
  (12 clientes por defecto).

Reproducir: `npm run banco:red` o, reducido,
`npx tsx scripts/banco-red.mts --clientes 3 --pasos 2 --salida /tmp/banco.json`.

## Hardware

El hardware no puede cambiar el resultado de este cambio: el banco no toca
ninguna fórmula del mundo, ningún reparto ni ninguna ruta que dependa del
número de hilos o de la capacidad medida; solo cuenta bytes de mensajes
reales. Las cifras absolutas (egress, p95) son de esta torre y de un mundo
recién creado; en otra máquina hay que volver a correr el banco, no asumirlas.
