# T142: poda de vínculos de los fallecidos sin sondear cada superviviente por cada muerte

Base: `5e0556f`. Rama `sprint/002-e0-t142`, worktree `/datos/workspaces/personal/AtlasParaIsa-n-E0-t142`.
Commit del cambio: `75b1117`. Ejecución: la tarea está asignada a `gemini/pro · high`. Se delegó dos
veces con `access=write` y las dos agotaron los 1 800 s del MCP sin escribir ningún fichero (el árbol
quedó limpio). Un intento intermedio falló al arrancar: `--effort is not supported for model "Gemini
3.1 Pro (High)"`. Tras esas dos vueltas, Claude Opus implementó, probó y midió el cambio.

## Antes de tocar: el código ya no es el de la cita, y la tarea tal como está escrita no se puede cerrar

- La cita `lineage.ts:141` hoy corresponde a `for (const person of world.people) for (const id of departed) delete person.bonds[id];`,
  dentro de `advancePopulation` (≈ línea 149 en `5e0556f`). Es la misma lógica: vivos × muertes llamadas
  a `delete`.
- **Un índice inverso incremental guardado aparte no es correcto en este código.** `bonds` es un
  `Record<string, number>` que se escribe directamente: en `society.ts` (`bond()` y `acercar()` desde
  `convivir`), en `index.ts` (nacimientos e `initializePerson`) y en 27 sitios de los tests. Además,
  `cloneWorld` copia el mundo entero en cada paso del servidor (`motor.clonPorPaso=true`). Un índice
  guardado en un `WeakMap` o en una caché del módulo quedaría obsoleto con la primera escritura directa
  y moriría con cada clon. Un campo nuevo en `World` cambiaría el digesto y la instantánea. Mantener el
  índice exigiría tocar `society.ts` e `index.ts` (T141 trabaja en esos ficheros, regla 1) y seguiría
  sin detectar las escrituras directas de los tests.
- **La reciprocidad no es un índice válido con el contrato actual.** En el motor, la presencia de clave
  es mutua. `bond()` escribe los dos sentidos, `convivir` llama a `acercar(a,b)` y a `acercar(b,a)`,
  que siempre escribe una clave ausente (0,2 < 0,5), y `upgradeV3` vació todos los vínculos. Medido:
  **0 vínculos unidireccionales** en las tres réplicas de estrés (muestreo cada 600 pasos). Aun así,
  `assertWorld`/`assertPopulation` aceptan vínculos unidireccionales y los tests los construyen: el test
  de `tests/lineage.test.ts:40` (`s.bonds[a.id] = 0.8` sin la inversa) exige que la clave desaparezca
  al morir `a`. También los construyen `comunidades-vivas.test.ts:165-168` y `e2e.spec.ts:327`.
  Si la poda buscara a quién borrar sólo en las claves del fallecido, esas entradas dejarían claves
  colgando y el siguiente `assertWorld` fallaría. La mutación M1 de abajo lo
  demuestra: con esa poda caen tres tests.
- **Cota.** Para que la poda sea exacta con toda entrada que el contrato admite hay que mirar, para cada
  superviviente, cada id fallecido o cada una de sus claves: Ω(min(vivos × muertes, Σ claves de los
  vivos)). Un adversario puede esconder una clave unidireccional en cualquier superviviente. El cierre
  literal «coste lineal en muertes» (O(Σ grado de los fallecidos)) sólo es alcanzable si la presencia
  mutua pasa a ser un invariante **validado** (ver «Pendiente»). T142 entrega la cota exacta alcanzable
  sin tocar otros ficheros y **no debe marcarse cerrada** por ese criterio.

## Qué cambió

- `src/world/lineage.ts`: nueva `pruneBonds(survivors, departed)` exportada. En `advancePopulation`
  sustituye la línea citada en el mismo punto del flujo: después de filtrar `world.people` y antes de
  limpiar comunidades. Borra exactamente las claves propias de cada superviviente que son ids
  fallecidos. `delete` nunca reordena las claves que quedan, así que valores y orden coinciden con la
  versión anterior, también con ids con forma de entero, que JS enumera antes y en orden numérico.
  Elige, sólo por coste, entre dos recorridos exactos:
  - **sondeo** con pocas muertes: para cada superviviente, `Object.hasOwn` por cada id fallecido y
    `delete` sólo si la clave existe. `delete` de una clave ausente es una llamada al runtime de V8,
    así que el sondeo cuesta 1,5–2× menos que hoy aunque sigue siendo vivos × muertes;
  - **barrido** cuando las muertes superan `BOND_SCAN_RATIO = 4` veces el grado medio (+1). Cada
    superviviente recorre sus claves una vez contra el `Set` de fallecidos, con coste Σ claves,
    **independiente del número de muertes**. El grado se estima con una muestra determinista de hasta
    64 supervivientes espaciados por posición. El 4 se calibró con copias de vínculos hechas como
    `cloneState`: el cruce medido está entre 3 y 8 muertes por vínculo medio.
  La elección depende sólo de los datos. Los dos recorridos dan el mismo resultado, y los bonds de los
  fallecidos no se tocan.
- `tests/lineage.test.ts`: dos tests nuevos; los existentes no cambian.
  1. **1 000 muertes entre 2 000 personas** (el test que pide la tarea). El PRNG es determinista
     (mulberry32), con un 70 % de vínculos mutuos y un 30 % unidireccionales, ids `7`, `42`, `1000` y
     `3`, un superviviente con 300 claves unidireccionales hacia fallecidos, un fallecido sin vínculos y
     una clave con el propio id. El caso pasa por `advancePopulation` real. Se compara con el bucle
     literal de siempre aplicado a un `structuredClone`, usando `Object.entries` por superviviente, así
     que el orden de claves también se compara. Se comprueba además que los bonds de los fallecidos
     quedan intactos y que `assertPopulation` pasa. Después muere una persona más, lo que ejerce el
     sondeo, y se compara con la misma referencia.
  2. **`pruneBonds` directa por los dos recorridos**, con un `Proxy` que registra `ownKeys` para
     afirmar qué recorrido se tomó. Casos: 0, 1 y 2 muertes con claves enteras mezcladas (sondeo); 50
     muertes con grado ≈ 2 y un vínculo unidireccional entrante a un fallecido que no lo tiene
     (barrido); 25 muertes con grado ≈ 66 (sondeo con muestreo).

## Cómo se prueba

- `npm run typecheck`: verde.
- `TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test tests/lineage.test.ts`: **12/12**, 0 fallos,
  0 omitidos, 0,57 s. El test de 1 000 muertes tarda 0,24 s.
- **Mutaciones** (en un worktree temporal desde `75b1117`; todas mueren):
  - M1, poda sólo por reciprocidad: fallan 3 tests, entre ellos el antiguo de la línea 38.
  - M2, barrido que reconstruye `bonds` con las claves ordenadas: fallan los 2 tests T142.
  - M3, sondeo que olvida una muerte: fallan los 2 tests T142.
  - M4, barrido siempre: falla la afirmación de recorrido.

## Controles de digesto (`digestoCanonico`, base `5e0556f` frente a `75b1117`)

**Control oficial** (`scripts/lab/digesto-control.ts`, 2 400 pasos, base `HISTORICAL_PARAMS`). La
columna «B» es el juego de laboratorio B `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
Se quitó `social.memoriaDisputa=8`: esa clave no existe en `5e0556f` y `parseParams` la rechaza
(«Parámetro desconocido»), igual en la base que en esta rama.

| semilla | params | base | T142 | |
|---|---|---|---|---|
| 7 | por defecto | `2b6392411920e59b…` | `2b6392411920e59b…` | igual |
| 42 | por defecto | `fb7036cb898aa9b3…` | `fb7036cb898aa9b3…` | igual |
| 51926 | por defecto | `bff69c2fdf0ea2b5…` | `bff69c2fdf0ea2b5…` | igual |
| 7 | B | `ceb05d5b4151eb90…` | `ceb05d5b4151eb90…` | igual |
| 42 | B | `12ab9b88dd578103…` | `12ab9b88dd578103…` | igual |
| 51926 | B | `38b08b64eb9d4251…` | `38b08b64eb9d4251…` | igual |

**El control oficial no ejerce el cambio: en 2 400 pasos no muere nadie.** Por eso se añadieron dos
controles que sí lo ejercen. Sus herramientas están en `/datos/tmp-atlas-lab/t142-tools/`, fuera del
repositorio. `estadistica.mts` usa el mismo régimen que `digesto-control` (Store temporal y guardado
antes del primer paso), y se comprobó que da el mismo digesto `bff69c…` que el control oficial para la
semilla 51926. `masiva.mts` usa `createWorld` y `stepWorld` sin Store.

- **Estrés natural**: 14 400 pasos con `cuerpo.longevidadBaseDias=4,genes.edadFundadoresMinDias=3,genes.edadFundadoresMaxDias=5`,
  las cinco leyes de natalidad de reglas 10 y `social.vinculoConvivencia=0.01`.

  | semilla | muertes | claves podadas | grado medio | unidireccionales | base | T142 |
  |---|---|---|---|---|---|---|
  | 7 | 8 | 56 | 8,8 | 0 | `4d1564b24b80c3b0…` | igual |
  | 42 | 14 | 120 | 9,6 | 0 | `58f5916b99b567a2…` | igual |
  | 51926 | 9 | 86 | 10,3 | 0 | `5c75f1d6f57c6508…` | igual |

  Aquí muere como mucho una persona por paso, así que sólo se ejerce el sondeo.
- **Muerte masiva de extremo a extremo** (`createWorld(51926)` + `stepWorld`): se clonan N habitantes
  de los fundadores, con vínculos mutuos locales de grado ≈ 8, y D muertes simultáneas en el primer
  paso. Ejerce el barrido.

  | N | D | pasos | recorrido | digesto (base = T142) |
  |---|---|---|---|---|
  | 600 | 300 | 5 | barrido | `320d0ab230227ab0…` |
  | 2 000 | 1 000 | 3 | barrido | `c83b98c179034782…` |
  | 2 000 | 20 | 3 | sondeo | `eab1a9dd25145f64…` |

## Coste medido

Condiciones: torre compartida, con carga media de 12 a 16 durante las mediciones finales y de 60
durante la primera pasada, que se descartó. Las cifras son medianas.

**El sitio aislado** (`t142-tools/banco.mts`): vínculos mutuos, ids `descendant-N`, copiados como
`cloneState`. Se muestra un extracto; la tabla completa está en `/datos/tmp-atlas-lab/t142-banco-2.md`.

| P | grado | muertes | antes ms | después ms | razón |
|---|---|---|---|---|---|
| 2 000 | 8 | 1 | 0,38 | 0,33 | 1,2× |
| 2 000 | 8 | 256 | 13,2 | 2,2 | 6,0× |
| 8 000 | 8 | 1 | 6,5 | 3,8 | 1,7× |
| 8 000 | 8 | 64 | 27,9 | 6,4 | 4,4× |
| 8 000 | 8 | 1 000 | 235,5 | 13,9 | 17,0× |
| 8 000 | 32 | 1 000 | 164,9 | 18,1 | 9,1× |
| 32 000 | 8 | 1 | 30,1 | 15,5 | 1,9× |
| 32 000 | 8 | 256 | 303,4 | 42,3 | 7,2× |
| 32 000 | 8 | 1 000 | 903,2 | 36,9 | 24,5× |
| 32 000 | 32 | 1 000 | 455,2 | 63,8 | 7,1× |

En régimen de barrido, el coste de «después» ya no crece con las muertes: con P = 32 000 y grado 8,
256 muertes cuestan 42 ms y 1 000 muertes cuestan 37 ms. Con 2 a 16 muertes y grado 32 el resultado
es 0,9–1,4×, dentro del ruido: el sondeo con `hasOwn` sobre objetos en modo diccionario cuesta lo
mismo que hoy.

**`advancePopulation` completo** en el escenario de la tarea (`t142-tools/escena.mts`, grado ≈ 16).
Incluye el pase de demografía O(P) de cada paso.

| N | muertes | antes ms | después ms |
|---|---|---|---|
| 2 000 | 1 | 4,6 | 3,6 |
| 2 000 | 16 | 7,0 | 5,2 |
| 2 000 | 1 000 | 48,0 | 26,4 |
| 8 000 | 64 | 50,4 | 31,2 |
| 8 000 | 1 000 | 258,3 | 54,4 |
| 32 000 | 1 | 79,8 | 72,3 |
| 32 000 | 1 000 | 1 251,1 | 137,1 |

**Relevancia para T144.** Con P ≤ 2 000 y como mucho una muerte por paso, la poda cuesta menos de
0,4 ms y no mueve el p95. T142 elimina el pico de una mortandad simultánea, que antes era vivos ×
muertes, y el término P × muertes a gran escala. Quedan dos términos en `advancePopulation`, fuera del
alcance de T142:
- `dying.find(...)` dentro del bucle de registros (≈ línea 187): O(muertes²), unos 5·10⁵
  comparaciones con 1 000 muertes;
- el `world.structures.filter` de refugio por persona dentro de `transitions`: O(P × estructuras)
  cuando `shelterBenefitEnabled`.

## Pendiente, fuera del alcance declarado (regla 1)

Para cerrar T142 con «coste lineal en muertes» hay que declarar la **presencia mutua de vínculos**
como invariante validado: `a` tiene la clave `b` si y sólo si `b` tiene la clave `a`. Con eso,
`pruneBonds` puede tomar a quién podar de las claves de cada fallecido, con coste O(Σ grado de los
fallecidos) y exacto sobre todo mundo válido. Hace falta:
1. comprobarlo en `assertPopulation` (`lineage.ts`), con coste O(Σ claves), en la carga y en la
   validación profunda;
2. corregir los fixtures que construyen vínculos unidireccionales: `tests/lineage.test.ts:40`,
   `tests/comunidades-vivas.test.ts:165-168` y `tests/e2e.spec.ts:327`, y buscar otros con un
   primer pase de la suite con la validación activa;
3. verificar sobre una copia de respaldo que el mundo publicado V10 lo cumple antes de desplegar. El
   motor nunca crea vínculos unidireccionales, pero endurecer una validación de carga afecta al
   reinicio del servidor público.

Estimación con el banco: con P = 32 000 y 1 000 muertes, el sitio pasaría de unos 40–60 ms (barrido)
a unos 1 000 × grado operaciones, menos de 1 ms. La decisión es del integrador o de Steven, porque
cambia qué instantáneas acepta `assertWorld`.

## Hardware

**El hardware no puede cambiar el resultado de este cambio.** La elección entre sondeo y barrido
depende sólo de los datos: el número de muertes y el grado de una muestra tomada por posición. Los dos
recorridos borran exactamente las mismas claves, y no se consultan relojes, hilos, CPU ni memoria.
Otro hardware sólo cambia cuánto tarda.

## Solapes

No hay solape con T141 (`society.ts`, `index.ts`, `rejilla.ts`) ni con T143
(`technology-checkpoint.ts`). Sólo se tocaron `src/world/lineage.ts` y `tests/lineage.test.ts`, y no
se marcó ninguna casilla de `tasks.md`.
