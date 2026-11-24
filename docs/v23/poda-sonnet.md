# Poda del determinismo y nueva red de seguridad (decisiones 2, 4, 11) + operación

Base leída: worktree `v24-base` (solo lectura) e `inventario-determinismo.md`. Las cifras marcadas «estimado» no se han medido.

## 1. Idea central

1. Sin determinismo se pierde un contrato (mismo estado, mismo bit). Lo sustituyen tres: **invariantes** (siempre ciertas, comprobadas en pruebas y muestreadas en producción), **propiedades** (ciertas para todo mundo válido) y **estadística** (el mundo sano se parece a sí mismo entre réplicas).
2. Orden: primero se añade la red nueva sin borrar nada; luego se pone en cuarentena la vieja; se borra solo cuando el carril que rompe el bit a bit aterriza («quien rompe, poda»).
3. El guardado por repetición (`replay`) depende del determinismo y muere; el guardado por páginas se queda.
4. Un fallo ya no pausa el mundo para siempre: GPU degrada a CPU, un fallo de paso recarga el último guardado verificado, un vigilante externo reinicia si el paso se para. Sin prioridad especial.
5. Lo que ya no se puede reproducir se diagnostica con bitácora, volcados pre/post de la región, caja negra y reproducción estadística desde un respaldo.

## 2. Modelo de datos (contratos a congelar)

```ts
// src/world/invariantes.ts (nuevo; cada carril registra las suyas)
export type Gravedad = 'blanda' | 'dura';           // blanda: se corrige y se cuenta; dura: bitácora + volcado + recuperación
export interface Violacion { id: string; gravedad: Gravedad; tick: number; region?: string;
  detalle: string; esperado?: number; observado?: number; muestra?: unknown }
export interface RegionRef { chunkX: number; chunkY: number }   // 16x16 teselas (CHUNK_SIZE, terrain.ts:7)
export interface Invariante {
  id: string;                       // 'materia.atomos', 'refs.comunidad', 'demografia.balance'
  carril: string; gravedad: Gravedad;
  cadaTicks: number;                // cadencia en producción
  alcance: 'global' | 'region';
  comprobar(mundo: World, region?: RegionRef): Violacion[];  // solo lectura; corre en la barrera de fin de paso
  reparar?(mundo: World, v: Violacion): void;                // solo blandas (recortar a 0, quitar referencia colgante)
}
export function registrar(inv: Invariante): void;
export class Muestreador { constructor(fraccionPaso = 0.01);
  paso(mundo: World, stepMs: number): Violacion[] }            // recorre invariantes y regiones en ronda hasta gastar 1 % del paso

// Libro de materia y energía (lo entrega el carril materia; los contadores son enteros que solo crecen)
export interface Libro { entradas: Float64Array; salidas: Float64Array;      // [elemento] átomos que entran (lluvia, siembra) y salen (disipación declarada)
  energiaEntra: number; energiaDisipada: number;
  flujoBorde: Float64Array }                                                 // [region*4+borde][elemento], se pone a cero en cada comprobación

// src/server/diagnostico.ts (nuevo)
export interface RegistroBitacora { t: string; tick: number; reglas: number; commit: string; hilos: number;
  gpu: ('ok' | 'cpu')[]; rssMiB: number; ultimaFase: string; violacion?: Violacion; volcado?: string; recuperacion?: 'gpu-a-cpu' | 'recarga' | 'salida' }
export interface CajaNegra { tick: number; fasesMs: Record<string, number>; hilosActivos: number;
  gpu: ('ok' | 'cpu')[]; rngCoordinador: number; intents: number; rssMiB: number }
export interface Salud { status: 'ok' | 'paused'; tick: number; pasosPorSegundo: number; p95StepMs: number;
  duras24h: number; blandas24h: number; gpu: 'ok' | 'cpu' | 'sin'; recuperaciones: number; ultimaViolacion?: string }
```

Disposición: anillo de 256 `CajaNegra` en memoria (≈ 50 KB); preimagen de 8 chunks muestreados (≈ 4 MB a 2 000 B/tesela, `hardware-limits.ts` BYTES_PER_ACTIVE_TILE); bitácora `<CARTA_DATA_DIR>/diagnostico/invariantes.jsonl` (rota a 64 MiB × 8) y volcados `diagnostico/volcados/<tick>-<id>.json.gz` (tope 200 o 2 GiB). `/health` (app.ts:973 hoy solo `status`) pasa a devolver `Salud`.

Contrato para el carril motor: el azar de los hilos es una columna `azar: Uint32Array` por actor (xorshift32) y los contadores de identidad son `Uint32Array` con `Atomics.add`; `world.rng` (index.ts:158) queda solo para el coordinador.

## 3. Algoritmos y leyes

**Muestreo en producción** (hilo coordinador, tras la barrera, nunca durante una fase):
```
cada paso: presupuesto = 0.01 * stepMs
  para inv en ronda(invariantes) con (tick % inv.cadaTicks == 0) y coste_estimado <= presupuesto restante:
     regiones = global ? [null] : siguientes K del cursor rotatorio (K adaptativo por EMA de ms/región)
     para r en regiones: vs = inv.comprobar(mundo, r); actualizar EMA
  para v en vs: blanda -> reparar + contar; dura -> volcar(preimagen[r], estado actual) + bitácora + contar
  si duras en 10 min >= 3 (misma id o región): lanzar recuperación 'recarga'; si en 1 h >= 3 recargas: salir(75)
```
Truco barato para finitud: la suma de una columna `Float64Array` es finita si y solo si todos sus valores lo son (NaN e Infinity se propagan); solo si falla se busca el índice.

**Invariantes iniciales** (existen datos hoy): finito y no negativo en teselas, personas, fauna (cubre `assertCommon`, index.ts:2416); referencias (comunidad, vínculos, autores de receta: lo que `assertWorld` ya valida, index.ts:2455+); ids únicos; coherencia con índices (conteo por celda de fauna y `tile-index`/`rejilla` recontado en la región muestreada; miembros de comunidad contra `communityId`); balance demográfico `Δpoblación = nacimientos − muertes` (C6 de `criterio-terminado.mts`); acumulados que no decrecen; agua y masa química (hoy comprobadas solo en `v20-chemistry` y `v20-roads`). Con la química nueva: **átomos enteros** y `Σ_e átomos_e(mundo) = inicial_e + entradas_e − salidas_e` exacto en el mundo (cada 1 200 pasos) y por región muestreada con `flujoBorde` (cada 600). Energía: `E_fin = E_ini + entra − disipada − trabajo` con tolerancia relativa 1e-9, solo si cada transformación escribe en el libro. Si el carril materia usa flotantes, la tolerancia es 1e-9 relativa y la deriva se vigila en el panel.

**Degradación GPU**: en `ecosystem-kernel.ts:201,221,255,275` el `catch` hoy relanza y el paso falla. Nuevo: si el error viene del puente GPU, `dropGpuBridge`, `this.gpuOff.add(dispositivo)`, bitácora `gpu-a-cpu`, y el paso sigue por la rama de workers CPU de la misma función (`hilos = max(2, availableParallelism)`). Como el paso es en sitio, un error a mitad de fase ecológica descarta ese paso: recarga del último guardado (abajo). `gpuParitySession` (autoprueba.ts:156) pasa a «prueba de humo»: sin `--fmad=false` (108-110), comparación con tolerancia relativa 1e-9 en lugar de `Object.is` (137), presupuesto 5 s; un dispositivo que falla se apaga, el mundo sigue.

**Recuperación** (app.ts:928-955 hoy `failed = true` para siempre): clasificar el error. `SessionRevoked` se mantiene. GPU: degradar. Cualquier otro: `recargar()` = `store.load()` del último guardado verificado (≤ `persistencia.cadaTicks` pasos atrás), descartar el mundo en memoria, reabrir pools, anotar en bitácora, y avisar a la cinta para truncar fotogramas posteriores al tick restaurado. Tres recargas en una hora: `process.exit(75)` (gateway.ts:60-72 hoy marca `fatal` pero no sale, así que `Restart=always` nunca actúa).

**Vigilante** (`scripts/systemd/torre/atlas-vigilante.{service,timer}` + `vigilante.sh`, cada 30 s): lee `/health`; reinicia con `systemctl --user restart atlas-publico.service` si hay 3 fallos HTTP seguidos, si `status=paused`, o si `tick` no avanza en 120 s. Guarda cola de `journalctl` y el `/health` en `diagnostico/vigilante/`. Máximo 3 reinicios por hora: después deja el servicio parado y escribe `diagnostico/VIGILANTE-DETENIDO` (evita bucles con un mundo corrupto; `Store.load` ya retrocede al respaldo previo).

**Panel estadístico** (§7). **Política de versión**: los carriles no tocan `RULES_VERSION` (index.ts:62, evita conflictos); el integrador sube +1 en cada integración que cambie leyes o esquema (V23 = 15, una sola vez). En duda, sube. `Store.load` rechaza un mundo con versión distinta con mensaje explícito (cada versión empieza mundo nuevo, GOAL.md).

## 4. Qué se borra y qué se conserva

Aviso: de las 4 190 coincidencias del inventario, `digest` en `store.ts` (158), `snapshot-parts.ts` (68) y `technology-archive.ts` (58) es en su mayoría **suma SHA de integridad de filas SQLite**: se conserva. Solo muere la familia `digestoCanonico`.

**Ola 2 (sin importador en src/, seguro desde ya)** ≈ 2 900 líneas:
- `src/world/halo.ts` (776) y `tests/halo-radios.test.ts` (927): inventario de radios de lectura para equivalencia de particiones; la fase B es de solo lectura sobre el mundo congelado y no necesita halo. 18 commits de mantenimiento desde V14.
- `src/world/paralelo/identidades.ts` (250) y `tests/identidades.test.ts` (301): prefix-sum ordenado de contadores; se sustituye por `Atomics.add` (los ids legibles `descendant-N` se conservan).
- `src/world/soa/personas.ts` (485) y `tests/soa-personas.test.ts` (150): **borrar por defecto**; solo si el carril de decisión en hilos/GPU lo adopta antes de la etapa 4 se conserva, y entonces sin la regla «orden de inserción como dato».

**Ola 1 (cuarentena, mover a `tests/paridad/`, fuera del glob `tests/*.test.ts`; nuevo script `test:paridad`)** ≈ 2 650 líneas, puras de paridad o digesto dorado: `determinismo-hardware` (299), `kernel-digest` (57), `digesto-stream` (47), `perf-store-save-parity` (204), `perf-pop400-tech-inventions` (110), `perf-society-parity` (101), `society-perf-parity` (137), `v18-motors-perf` (57), `v17-perf-hotpath` (140), `fauna-hotpath-parity` (111), `v18-hotpath-parity` (140), `v18-r3-scale-parity` (115), `perf-personas-core-parity` (226), `v18-store-save-perf` (278), `store-replay` (321), `snapshot-numeric-archive` (159), `snapshot-numbers` (71), `exact-json` (35), `lineage-numeric-identity` (59). Siguen compilando (typecheck incluye `tests`) y corren de noche mientras exista el motor viejo.

**Cirugía de aserciones en pruebas mixtas** (no se mueven): `v22-world-hotpaths` (quitar «0 ULP», dejar paginación y costes; ojo: tiene una modificación sin commitear en v24-base), `v22-seasonal-gpu-ecology` (quitar 0 ULP y «digesto en serie vs 4 hilos»), `ecology-paralela`, `paralelo-ecologia`, `paralelo-adversarial` (quitar el orden invertido; conservar bootstrap de workers y «un throw por región espera a todos»), `gpu-autoprueba` (reescribir a tolerancia), `v12-full-hardware-evolution`, `v17-emergencia-largo-plazo`. Regla mecánica: se borra toda aserción que compare dos trayectorias o dos rutas de código; se conserva toda la que compare antes/después de guardar, cargar o restaurar (`restauracion-paso`, `store-guardado`, `snapshot-recovery-boundary`, `rendimiento-identidad`, que prueba índices contra la referencia ingenua: es corrección, no paridad).

**Ola 3 (cuando aterrice el motor no determinista; la dispara el carril motor)**:
- `store.ts`: ramas de `replay`: 136 (`REPLAY_KEY`), 287 (`replayCache`), 493-690 (`replayParent`…`replayFloor`), 1579-1626 y 1675-1693; `snapshot.ts:74` (`readSnapshotReplay`, `assertReplayPath`, tipos); `params.ts:53,232,474` (`persistencia.paginasSucias`). Se conserva la rotación de respaldos slot 1/2 (store.ts:1619-1621). Hoy está apagada en producción (`paginasSucias:false`, publico.sh no la activa), así que no cambia nada visible.
- `src/shared/exact-json.ts` (124): `stringifyExact` (≈ 30 usos en `store.ts`, `snapshot.ts:178,198,216,347`, `snapshot-parts.ts:162,297`, `lineage.ts:122`) pasa a `JSON.stringify`; el `-0` deja de importar.
- `src/world/digesto.ts` (335): se queda como utilería **solo de pruebas** (≈ 70 líneas: `canonical`, `digestoCanonico`, `diferenciaCanonica`; fuera `IncrementalRegionHasher` 244-335 y las máscaras de claves neutras `paramsParaDigesto` 24-67). Así no se editan los 87 tests que lo importan. Prueba nueva: ningún fichero de `src/` lo importa.
- Selector `motor.orden`: `particion.ts:9,19-30`, `piscina.ts:180`, `fauna-motor.ts:590-690`, `personas-motor.ts:521-791`, `reduccion.ts:219-223`, `params.ts:77,235,472`.
- `index.ts:77-97` (`hypot2`, `HYPOT2_EXACT`): usar `Math.hypot` o comparar distancias al cuadrado.
- Plano frente a SoA (0 ULP): lo decide el carril motor; con él se borran los tests de la Ola 1 que queden.
- `gpu/reparto.ts`: `repartirPaginas`, `DEFAULT_GPU_THROUGHPUT` (solo tests) fuera; `mortonCode` con BigInt (12-20) se simplifica si el perfil lo pide.

**Ola 4**: scripts de paridad y bancos con digesto: `scripts/verify-integration-parity.ts`, `verify-params-baseline.ts`, `verify-clone-trajectory.mts`, `perf/identidad*.ts` (3), `lab/digesto-control.ts`, `lab/reproduce-cupo20-8103.mts`, `benchmark-clone-aged.mts`; de los 23 scripts que importan digesto, los demás pierden solo la parte de comparación. Las 166 piezas de `docs/evidencia-*` y `specs/` son registro histórico: no se tocan; `docs/EVIDENCIA.md` recibe una nota de cabecera con la fecha del cambio.

**Se conserva (no es determinismo)**: `guardia.ts` (101): sin digesto, una carrera de datos solo se ve así; fuzz de «fase B no escribe» con 8 hilos. `reduccion.ts` y `agregados.ts`: la confirmación ordenada sobre existencias finitas sigue siendo semántica de contención; se simplifica el orden después. `genetics.ts:22 localRandom` y los demás azares por etiqueta: no cuestan ni estorban; no se tocan salvo que el carril dueño del fichero lo reescriba.

**Decisión 11 por fichero** (conectar o borrar): `reduccion`, `agregados`, `personas-worker.faseBPersona`, `personas-motor` (`empaquetar`, `escenaDesdeMundo`, `confirmarFaseCPersonas`; ~450 líneas hoy solo en tests): **conectar**, es exactamente la decisión 3 (personas en todos los hilos y GPU ya). `identidades`, `halo`, `soa/personas`: borrar (arriba). `gpu/puente.ts` `runTick`/`flushToHost` (~90, VRAM autoritativa): lo decide el carril GPU en la etapa 4; valor por defecto, borrar si no entra en el panel. `barrera`, `paginas`, `soa/arena`, `soa/presencia`: tienen importador en src/ y se quedan.

## 5. Migración por etapas

| Etapa | Qué toca (dueño único) | Cómo se mide |
|---|---|---|
| E0 enmienda | `.specify/memory/constitution.md`, `GOAL.md`, `README.md`, `PLAN.md`, `CLAUDE.md`, `AGENTS.md`, nuevo `docs/VALIDACION.md`; etiqueta git `control-v24-determinista` | `grep -rni "determinista\|10 pasos" ` solo en histórico |
| E1 red nueva (aditiva) | `src/world/invariantes.ts`, `src/server/diagnostico.ts`, `tests/lib/propiedades.ts`, `tests/invariantes.test.ts`, `tests/propiedades-mundo.test.ts`, `scripts/lab/panel.ts`, `scripts/lab/reproducir.ts` | panel de control en v24-base: 0 violaciones duras; sobrecoste de invariantes ≤ 1 % con `scripts/perf/paso-servidor.ts`; calibrar pasos/s por réplica |
| E2 operación | `main.ts`, `gateway.ts`, `app.ts:928-973`, `ecosystem-kernel.ts:195-275`, `autoprueba.ts`, `scripts/systemd/torre/*`; borrar `atlas-publico.prioridad.conf` | `tests/recuperacion.test.ts`: GPU muerta en pleno paso, `throw` en `stepWorld`, mundo sigue; `systemd-analyze --user verify` |
| E3 limpieza segura | Ola 2 y Ola 1; `package.json` (`test:paridad`) | `typecheck` y `npm test` verdes; duración medida antes/después (no se promete cifra) |
| E4 poda con motor | Ola 3, en el commit del carril motor | cero imports de `digesto` en `src/`; panel de equivalencia contra el control con leyes iguales |
| E5 red completa | invariantes de materia/fauna de cada carril; panel corto | veredicto del panel (§7) |
| E6 documentación y scripts | Ola 4; `docs/REGLAS.md`, `docs/CONSTRUCCION.md`; `scripts/lab/README.md` (754 líneas, casi todo «determinista» y «bit a bit»); `RULES_VERSION` 15 | grep limpio; `rules-version.test.ts` reducido a `world.version === RULES_VERSION` |
| E7 publicación | V23 en mundo nuevo, vigilante activo, panel largo 8×60 después | `/health` con `Salud`, vigilante probado matando el proceso |

Orden recomendado (decisión del orquestador, §10): el motor aterriza **antes** que las leyes nuevas. Mientras las leyes sean las mismas, el motor viejo (etiqueta, worktree `v24-base`) es un control determinista y la comparación estadística nuevo/viejo sustituye a la paridad. En cuanto cambian las leyes, ese control se pierde.

## 6. Coste de cómputo y memoria (estimado)

- Invariantes: tope 1 % del paso. Una página de 256 teselas × ~10 campos × 8 B ≈ 20 KB ≈ 10-20 µs; 100 páginas ≈ 2 ms. Control global por suma de columnas: 500 k teselas ≈ 40 MB ≈ 10 ms, una vez cada 600 pasos. Escala con el muestreo, no con el mundo, salvo ese barrido global.
- Memoria: caja negra 50 KB, preimágenes 4 MB, volcados ≤ 2 GiB en disco. Bitácora sana ≲ 1 MiB/día.
- Vigilante y `/health`: despreciables.
- Panel corto (4 semillas × 3 réplicas × 30 días = 12 corridas × 72 000 pasos): referencia medida, el mundo vivo V14 con 28 hilos y dos GPU hizo 72 000 pasos en 13 099 s (5,5 pasos/s, 588 habitantes; `live-world-dual-gpu-30d-20261119.json`). Una réplica de 1-2 hilos irá más lenta: 2-5 h cada una; 12 a la vez con 2 hilos ≈ 24 hilos, **3-6 h de reloj**, hasta 10× más si la población se dispara sin el cupo de natalidad. Tope de reloj preregistrado de 8 h: lo que falte se evalúa al último día común y se marca «truncado». Calibrar en E1.
- Panel de equivalencia de modos (lab, no `npm test`): 4 semillas × 3 modos (1 hilo / 28 hilos / 28 hilos + GPU) × 3 réplicas × 3 días (7 200 pasos) = 36 corridas cortas, ≈ 2-3 h con la torre libre.
- Pruebas por propiedades: 25 casos × 150 pasos de mundos pequeños ≈ 5-10 s por propiedad.

## 7. Invariantes y pruebas que sustituyen a la paridad

**En `npm test`** (sin dependencias nuevas, la constitución prohíbe frameworks): `tests/lib/propiedades.ts` con `propiedad(nombre, {casos, semilla}, generador, comprobación)`; al fallar imprime la semilla de la **entrada** (la entrada sí es reproducible; la ejecución, no, así que cada caso se repite 3 veces y falla si falla alguna).
1. Un paso preserva todas las invariantes en mundos aleatorios (semilla, parámetros dentro de `PARAMETER_LIMITS`, hilos 1 y 4).
2. Ida y vuelta: `load(save(w))` estructuralmente igual (`digestoCanonico` sobre el mismo proceso, válido).
3. Restauración tras fallo inyectado (se conserva `restauracion-paso`).
4. Acumulados monótonos, ids únicos, contadores ≥ sufijo de todo id.
5. Conservación de átomos en toda secuencia aleatoria de operaciones (cuando exista el libro).
6. Fase B sin escrituras con `motor.depuracion` y 8 hilos.
7. Degradación: apagar la GPU en pleno paso deja el mundo válido.

**Panel corto de pre-publicación** (`scripts/lab/panel.ts`: `barrido.ts` + `criterio-terminado.mts` + invariantes; semillas 51926, 19104, 19101, 19103 como en la verificación de V21; réplica = reinicio del mismo mundo; la misma semilla ya no da lo mismo). Umbrales fijados antes:
- M1 extinción de mortales antes del día 30: 0 de 12 (duro).
- M2 población mortal ≥ 16 al día 30 en ≥ 10/12 y mínimo de los días 20-30 ≥ 8.
- M3 C2 recambio y C6 causas legibles con balance exacto (ya existen).
- M4 crecimiento: log2(pob₃₀/pob₁₅) ∈ [−1, +4] en ≥ 11/12; fuera, revisión humana (régimen nuevo sin cupo).
- M5 invariantes: 0 violaciones duras; blandas ≤ 1e-6 por comprobación de región.
- M6 rendimiento: p95 del paso ≤ presupuesto, 0 pasos > 30 s, RSS ≤ 70 % de la RAM.
- Veredicto por métrica: cumple / falla / desconocido; nunca aprueba por defecto (convención de `criterio-terminado`).
Potencia honesta: con 12 corridas y 0 extinciones, la cota superior al 95 % de la probabilidad de extinción es ≈ 22 %; si la variación entre corridas es del 40 % (supuesto, no medido), solo se ven diferencias de medias de 30-45 %. El panel detecta roturas grandes, no regresiones finas.

**Panel de equivalencia de modos** (sustituye 0 ULP CPU/GPU/hilos): por métrica (población, nacimientos, biomasa media, diversidad) prueba de permutación estratificada por semilla entre cada modo y 1 hilo, α = 0,01/8 (Bonferroni), más margen de equivalencia ±20 %. Si falla, se repite una vez con 3 réplicas más antes de declarar.

**Panel largo 8×60** (después de publicar): criterios C1-C8 completos.

**Diagnóstico sin reproducción**: la bitácora apunta al tick; el volcado (preimagen + estado en la violación + caja negra de los últimos 256 pasos) y la cinta permiten **ver** lo ocurrido. `scripts/lab/reproducir.ts --respaldo <sqlite> --hasta-tick T --intentos 50 --hilos 1,8,28` recarga el guardado anterior y avanza hasta T muchas veces; informa la fracción de intentos que viola. Es reproducción estadística: «ocurre en 7 de 50».

## 8. Cómo se ve en pantalla

- **Indicador de salud del mundo** en la cabecera: verde (sin duras en 24 h de reloj), ámbar (blandas), rojo (duras o recuperación). Tooltip: violaciones 24 h, última recuperación, GPU `ok`/`cpu`. Alimentado por `Salud` en `/health` y en la vista.
- **Marcas en la cinta**: ticks con violación o recuperación como muescas rojas en el deslizador; clic salta ahí.
- **Aviso de retroceso**: tras una recarga, «el mundo retrocedió al paso T por una recuperación»; la cinta se trunca en T.

## 9. Riesgos y mitigaciones

1. **Falsos negativos**: sin digesto, una regresión sutil pasa. Mitigación: invariantes duras, panel, volcados; se acepta la pérdida de sensibilidad.
2. **Carreras de datos invisibles**: antes un digesto distinto las delataba. Mitigación: guardia de solo lectura en fuzz y escrituras solo en el coordinador o en rangos exclusivos (`particion.ts`).
3. **Falsos positivos por escritura concurrente**: se comprueba solo en la barrera de fin de paso, en el coordinador.
4. **Bucle de reinicios con mundo corrupto**: tope de 3 recargas/h en proceso y 3 reinicios/h en el vigilante; `Store.load` ya retrocede al respaldo.
5. **Borrar protección demasiado pronto**: Ola 0 antes que nada, cuarentena antes que borrado, borrado dentro del commit del carril que rompe la paridad; todo reversible por git.
6. **Recuperación que esconde bugs**: un servicio que se cura solo falla en silencio. Por eso `Salud` y el indicador de pantalla.
7. **Libro de materia en flotantes**: la conservación exacta solo es posible con enteros; con flotantes, tolerancia y deriva.
8. **Cinta y recarga**: dos escritores sobre el estado; el carril cinta debe truncar al restaurar.

## 10. Consecuencias y decisiones para el orquestador

**Consecuencias que Steven debería conocer**
- La confianza pasa de «idéntico al bit» a «estadísticamente parecido». Una regresión de leyes menor del 30 % puede no verse en 12 corridas. Es el precio de la decisión 2.
- Sin prioridad especial, el panel (≈ 24 hilos) y el mundo público (28 hilos + GPU) se pisan en una torre de 32; ambos tardan más y los tiempos del panel son ruidosos (se juzga por estado, no por reloj). Las réplicas de laboratorio ya no cederán por `SCHED_IDLE` de ananicy. Se mantiene el nombre de proceso «carta-isa» (publico.sh) para que el servicio no caiga en la regla idle; sin el drop-in queda en peso normal. También compite por RAM: con `max-old-space-size=65536` un OOM puede matar a un vecino; opcional `MemoryHigh=96G` para que el núcleo recupere en vez de matar.
- Quitar la paridad libera la GPU: FP64 con `--fmad=false` es probablemente un lastre en las GeForce de consumo (no perfilado aquí) (la relación FP64:FP32 suele ser 1:64; dato de fabricante, no medido aquí). Kernels FP32 podrían ser un orden de magnitud más rápidos; cambian resultados, ya permitido.
- La auto-recuperación puede ocultar fallos reales si nadie mira; de ahí el indicador.
- Las afirmaciones de `docs/EVIDENCIA.md` basadas en «digestos iguales» siguen siendo ciertas para sus commits, pero no se pueden reverificar con el motor nuevo.
- No se podrá reabrir un mundo de otra versión si se cortan las migraciones (candidato; no medido el ahorro).

**Decisiones que quedan**
1. Que el motor aterrice antes que las leyes nuevas (control estadístico) o todo junto (decisión 12 literal). Recomiendo lo primero.
2. `soa/personas.ts`: adoptar o borrar (por defecto borrar).
3. Cortar `migrateWorld` V6-V13 y `LEGACY_WORLD_LIMITS` (index.ts, snapshot.ts:30), con `Store.load` rechazando versiones ajenas.
4. Exigir átomos enteros y el libro `Libro` al carril materia.
5. Cadencia de guardado como cota de pérdida en una recuperación (hoy `persistencia.cadaTicks=200` + intervalo de reloj en turbo).
6. Propiedad de `app.ts`, `ecosystem-kernel.ts` y `store.ts`: los toca motor, cinta y operación; propongo un solo dueño por etapa (operación en E2, antes de E4).
7. Tope de reloj del panel (8 h) y semillas del panel.

## Texto propuesto de la enmienda a la constitución (versión 2.0.0, 2026-11-24)

> ### I. Mundo autónomo, observado, sin reloj humano
> El servidor simula a la máxima velocidad que permite el hardware: no hay tasa de pasos por segundo ni espera a un cliente. `TICKS_PER_DAY = 2400` mide el tiempo del mundo, no el del observador. Toda vista, en vivo o histórica, es una reproducción de lo grabado a la velocidad que elija quien mira. El servidor es la única autoridad sobre el estado; las cámaras son independientes. Toda regla nueva tiene coste explícito (materia, energía, tiempo, desgaste) y una medición que puede refutarla.
>
> ### II. Evidencia estadística antes que impresión
> Un cambio de reglas se acepta con medición: varias semillas, réplicas de cada semilla (el resultado depende de hilos y GPU), un control y métricas y umbrales fijados ANTES de tocar el código. La reproducibilidad bit a bit no es un requisito; el efecto debe verse en la distribución de réplicas. Se registra en `docs/EVIDENCIA.md` con SHA, semillas, réplicas, duración y límites.
>
> ### III y IV: sin cambios.
>
> ### V. Velocidad libre, límites del hardware, sin trato especial
> Hilos, GPU y orden de ejecución pueden cambiar el resultado. El límite lo pone el hardware, nunca un tope de software ni un reloj. El servicio compite en igualdad con los demás trabajos de la torre. Una aceleración se adopta si acelera el mundo real; el código de escala que el mundo real no ejecuta se conecta o se borra.
>
> ### VI. Invariantes en lugar de reproducibilidad
> Lo que debe ser cierto siempre se comprueba: conservación de átomos y energía por región, nada negativo ni no finito, referencias válidas, población y fauna coherentes con sus índices. Pruebas por propiedades y un panel estadístico sustituyen a las pruebas de paridad y a los digestos dorados. Cada violación en producción deja bitácora, volcado de la región y caja negra, porque no puede reproducirse bit a bit. Un fallo no pausa el mundo para siempre: degrada (GPU a CPU), recarga el último guardado verificado o reinicia el servicio, y lo deja escrito.
>
> ### VII. Experiencia que emociona sin mentir
> (Antes VI.) Se sustituye «Un modo ligero garantiza…» por «Un teléfono real puede observar y leer la carta: la vista es una reproducción que no exige simular ni dibujar el mundo completo». Se elimina «p95 de paso < 50 ms con 32 habitantes».
>
> **Flujo**: punto 1, «`npm run typecheck && npm test` (invariantes y propiedades) verdes antes de cada commit»; punto 2, «panel corto 4 semillas × 30 días con réplicas antes de publicar; panel largo 8 × 60 después». **Version**: 2.0.0 | Ratified: 2026-09-19 | Last Amended: 2026-11-24.

**Párrafos que quedan falsos**
- `GOAL.md:18` «un mundo y reloj para todos»; `GOAL.md:20` «El determinismo y la paridad CPU-GPU son un resguardo interno…» y «referencias equivalentes… fidelidad»; `GOAL.md:41` «observan el mismo mundo y reloj».
- `README.md:57` (modo ligero), `:90` («reloj de simulación a diez pasos por segundo»), `:220-251` («diagnóstico reproducible», «réplica individual determinista», «réplicas… deterministas»), `:263` («reglas deterministas»).
- `PLAN.md:16` («motor autoritativo y determinista»), `:101`, `:115` («digestos con/sin medición»), `:245`, `:281` («paridad bit a bit»), `:436`.
- `docs/REGLAS.md:12`, `:475` («StaticWorkerPool determinista»), `:479` (`motor.orden`), `:748-772` (sección «orden determinista de reducciones»), `:803`; `docs/CONSTRUCCION.md:46,217`.
- `AGENTS.md` y `CLAUDE.md` (viñeta de publicación, cifras de V14/V21, «determinista» en la de 002) pasan a punteros breves:

```
# Una Carta Para Isa — guía para agentes
- Estado publicado, comandos y operación: `docs/ESTADO.md` (única fuente).
- Meta: `GOAL.md`. La constitución manda: `.specify/memory/constitution.md`.
- Reglas: `docs/REGLAS.md`. Evidencia: `docs/EVIDENCIA.md`. Validación sin determinismo: `docs/VALIDACION.md`.
- El resultado depende de hilos y GPU: se valida con invariantes, propiedades y panel estadístico.
- Worktrees solo en `AtlasParaIsa-anexo/worktrees/`; nunca compilar en el árbol principal; no tocar `data/` ni `mundos/`.
- La carta (S e I, recuerdos) solo la cambia Steven.
```
El procedimiento de publicación (hoy en la viñeta larga) se mueve a `docs/ESTADO.md`.
