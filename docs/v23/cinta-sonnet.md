# Cinta de toda la vida del mundo (decisión 10) — propuesta

Base leída: `v24-base`. Cifras de hoy: 1,6 GB de `world.tape.sqlite` para 20.000 fotogramas (≈ 80 KB por fotograma, keyframes incluidos), `TICKS_PER_DAY` = 2.400, Node v22.23.3 (trae `zlib` con zstd).

## 1. Idea central

1. La cinta deja de ser un anillo de fotogramas por tick y pasa a **grabación multirresolución** (estilo RRD). El hilo escritor, que ya tiene el estado en memoria, emite a la vez 5 niveles con paso fijo: L0 ≈ 4 ticks, L1 ≈ 32, L2 ≈ 300 (1/8 de día), L3 = 1 día, L4 = 10 días.
2. **No hay adelgazador que relea y reconstruya.** Cada nivel tiene su cuota en bytes y el «podador» solo borra el segmento más antiguo del nivel excedido (un `unlink`, O(1)). Nunca toca al motor ni compite con el escritor.
3. El motor nunca espera a la cinta. Hoy `beforeStep` lo frena con 64 fotogramas sin acuse (`sim-worker.ts:416`). Pasa a entregar «cortes» al ritmo que la cinta publica en un `SharedArrayBuffer`; si la cinta se atrasa, ella sube su paso, el motor no se detiene.
4. Los ficheros son **segmentos append-only inmutables** más un catálogo SQLite diminuto (≈ 10⁴ filas). Saltar a cualquier día es una búsqueda binaria en RAM más la lectura de un bloque. Respaldar es copiar segmentos sellados una sola vez.
5. Sin determinismo la cinta es el único registro. Por eso se versiona por **épocas**: un reinicio o una restauración abre una época nueva y la historia huérfana queda marcada, no se descarta en silencio (hoy `tape-store.ts:296`).

## 2. Modelo de datos

### Disco (`<mundo>/cinta/`)

```
cinta.idx.sqlite        catálogo (WAL): epocas, bloques, serie, hitos, catalogo, marcadores
n0/seg-000001.cnt …     L0, segmentos de 64 MiB, append-only; se sellan al llenarse
n1/ … n4/               igual
```

**Bloque** (unidad de lectura y de escritura, ~32 fotogramas):

```
'CNT1' | u8 nivel | u32 nFotogramas | f64 t0 | f64 t1 | u32 crc32 | u32 lenKf
KF  (zstd/gzip: vista completa del primer fotograma + teselas registradas)
{ f64 t | u32 len | delta (formato TapeClientDelta de shared/tape-delta.ts, sin cambios) } × (n-1)
```

El formato de delta del cliente no cambia; así se reutilizan `applyClientTapeDelta` y `clientDelta`.

**Reducciones por nivel** (función pura `reducir(nivel, estado)`):

| Nivel | Paso (ticks) | Contenido |
|---|---|---|
| L0 | 4 (adaptativo ×2 si hay atraso) | vista completa cuantizada, como hoy |
| L1 | 32 | personas y fauna individuales sin telemetría (sin hambre, fatiga…); teselas con cambio significativo |
| L2 | 300 | personas con id, posición, estado y comunidad; **fauna como densidad por chunk 16×16 y especie**; teselas de bioma, terreno y estructura |
| L3 | 2.400 | estructuras, comunidades, densidad de personas por chunk, solo «notables» individuales (con hito) |
| L4 | 24.000 | estructuras, comunidades, mapa de calor, serie |

**Flujos que no se adelgazan nunca** (tablas en el catálogo): `serie` (una fila por 200 ticks con población, fauna, nacimientos, muertes, estructuras, compuestos, `simHz`; ≈ 2 KB por día de mundo), `hitos` (la crónica sin pérdida) y `catalogo` (compuestos y objetos nuevos con fórmula y enlaces, para que el cliente los nombre).

### Tipos a congelar (`src/shared/cinta.ts`, sustituye a `shared/tape.ts`)

```ts
export type Nivel = 0 | 1 | 2 | 3 | 4;
export const CINTA = { pasos: [4, 32, 300, 2400, 24000], fpsNormal: 6, topeBytes: 50e9,
  cuotas: [0.48, 0.24, 0.12, 0.08, 0.06] /* de topeBytes; 2 % de margen */ } as const;

/** Lo que el motor entrega a la cinta. Sustituye a projectTapeFrame+record. */
export interface Corte {
  seq: number;                              // monótono, uno por corte (no es un tick)
  t: number;                                // reloj de referencia en ticks = mínimo de las regiones activas
  regiones?: [regionId: number, tick: number][]; // ausente si el reloj es global (== t)
  vista: WorldView;                         // proyección pública sin campos privados
  tilesCambiadas: Tile[] | 'todas';         // desde el corte anterior; 'todas' solo tras abrir/bifurcar
  hitos: Hito[];                            // eventos desde el corte anterior, sin pérdida
  catalogo: EntradaCatalogo[];              // compuestos/objetos nuevos desde el corte anterior
  hz: number;
}
export interface Hito { t: number; tipo: string; id: string; importancia: number; cuerpo: unknown }
export interface Apertura { instanciaId: string; tMundo: number; snapshotId: string }

export interface CintaMeta {
  version: 3; epoca: number; t0: number; t1: number; hz: number; bytes: number; topeBytes: number;
  niveles: { nivel: Nivel; paso: number; t0: number; t1: number; bytes: number; fotogramas: number }[];
  bifurcaciones: { epoca: number; desde: number; hasta: number; motivo: 'reinicio' | 'restauracion' }[];
  lagunas: { t0: number; t1: number }[];
  serie: SeriePunto[];                      // decimada a ≤ 400 puntos para el rango pedido
}
export interface ChunkReq { t: number; n: number; nivel?: Nivel | 'auto'; epoca?: number;
  x?: number; y?: number; w?: number; h?: number }
export interface ChunkResp { nivel: Nivel; paso: number; epoca: number; t0: number; t1: number;
  hayMas: boolean; cambioDeNivelEn?: number; baseFrame?: WorldView; deltas: TapeClientDelta[] }
export interface Marcador { perfil: string; nombre?: string; t: number; nivel: Nivel; velocidad: number; en: number }
```

### Qué necesita la cinta del motor (si no hay tick global)

1. `t` monótono que **sobrevive a reinicios** (se guarda en el snapshot). Con relojes por región, `t` = mínimo de las regiones activas y `regiones` lleva cada reloj. El cliente interpola por entidad con su reloj de región.
2. Un **corte coherente**: se toma en una barrera entre épocas del motor (hoy, el final de `stepWorld`). Que no tenga que parar todas las regiones: basta con que cada región entregue su estado al cierre de un paso y el corte lleve su `tick`.
3. Acumuladores `hitos`, `catalogo` y `tilesCambiadas` desde el corte anterior. Cuestan casi nada, y dejan de depender de que el evento siga vivo en `view.events` cuando se muestrea cada N ticks.
4. Lee atómicamente `cadencia[0]` (SAB, ticks entre cortes) y `pedirCompleto[0]`. Con eso se borran `tapeKeyframeDue` y `partialTiles`.
5. `abrir(Apertura)` antes del primer corte.
6. Una forma visible estable por entidad (`forma: number`, derivado de la estructura atómica) para que el cliente dibuje sin conocer átomos. La cinta **no** graba átomos (ver §10).

## 3. Algoritmos

### Ingesta (hilo `carta-tape`, único escritor)

```
al recibir Corte c:
  estado.aplicar(c)                            // vista actual + espejo de teselas registradas
  hitos/serie/catalogo → catálogo (en lote)
  si c.t >= próximoPaso[0]: emitir(L0, diff(estado, previoL0))
  para k = 1..4: si c.t >= próximoPaso[k]: emitir(Lk, diff(reducir(k, estado), previoLk))
  cada ~32 fotogramas por nivel: sellar bloque → append al segmento + fdatasync
       → UNA transacción de catálogo (fila de bloque con off/len/crc) → actualizar índice en RAM
  si segmento ≥ 64 MiB: sellar y abrir el siguiente
  cadencia[0] = paso0 × (atraso > 8 cortes ? 2 : (inactivo 2 s ? ½ : 1)), acotado a 4..32
podar(): para nivel k con bytes > cuota×tope: borrar segmento más antiguo no fijado (pin) y sus filas
         (catálogo primero; unlink después). Si aún pasa de topeBytes×1,02: baja L0 y L1 primero.
```

La poda no reconstruye nada porque los niveles ya se escribieron. Con un pico, el único mecanismo de alivio es subir `paso0` (la cinta pierde resolución, el motor sigue). El atraso se mide con acuses, como hoy, pero **no frena**.

### Bifurcaciones al abrir (`abrir(Apertura)`)

```
if apertura.instanciaId != meta.instanciaId: mover cinta/ a cinta.huerfana-<ts>/, empezar de cero
sea tCinta = meta.t1
if apertura.tMundo < tCinta:        // reinicio o restauración: el mundo olvidó (tCinta - tMundo)
    nuevaÉpoca(); marcar bloques con t > tMundo como huérfanos (epoca anterior, visibleHasta = tMundo)
    hito('bifurcacion', desde=tMundo, hasta=tCinta, motivo)
else if apertura.tMundo > tCinta:   // cinta perdida o más vieja que el mundo
    hito('laguna', tCinta..tMundo); fuerza corte completo
primer corte = 'todas' (keyframe en todos los niveles)
```

Los huérfanos permiten `?epoca=k` y son lo primero que borra el podador.

### Lectura y salto

```
chunk(t, n, nivel='auto'):
  nivel = más fino con cobertura en t (cobertura = intervalos en RAM, por nivel y época visible)
  bloque = búsqueda binaria en nivel.bloques por t        // µs
  kf = caché LRU de keyframes (por lector) o pread+descomprimir
  primer fotograma = el del keyframe más cercano ≤ t (sin aplicar deltas) → "primer pintado"
  resto = aplicar deltas hasta n fotogramas o fin de nivel; si el nivel termina, cambioDeNivelEn
  recorte a cámara en el lector (nunca se reconstruye el mundo entero para pedir una vista)
```

Se arregla también `removedTiles = oldOrder` (tape-store.ts:668-673): el parche de teselas se calcula por conjunto, no reenviando todo el recorte.

## 4. Qué se borra y qué se conserva

**Se borra**
- `tape-store.ts` completo (700 líneas): anillo y `prune` (431-448), descarte silencioso (296), copias de `Patch/applyPatch/applyObjectPatch` (14-43, 99-103, 137-187), que duplican `shared/tape-delta.ts:8-107`.
- `shared/tape.ts:24` (`TAPE_DEFAULT_MAX_FRAMES`), `:21` (`TAPE_KEYFRAME_INTERVAL`), `:18` (`TAPE_BASE_TICKS_PER_SEC`).
- `maxFrames`/`CARTA_TAPE_MAX_FRAMES`: `main.ts:34,40`, `sim-worker.ts:163,448`, `app.ts:66,530`, `gateway.ts:230`, `publico.sh`.
- `sim-worker.ts:416` (backpressure), `:267` (`tapeKeyframeDue`), `:339-357` (rama `record`).
- `app.ts:530-553`: `TapeWriter` en proceso; `createApp` usará la misma fachada que el worker.
- Pruebas `v21-tape-store`, `v22-tape-worker`: se reescriben contra §7.

**Se conserva**
- `shared/tape-delta.ts` íntegro (contrato de delta y `applyClientTapeDelta`).
- De `tape-store.ts`: `tileChangedSignificantly` (74-87), `project` (458-495), `clientDelta` (498-545) y el cuantizado de `projectTapeFrame` (233-264), movidos a `src/server/cinta/`.
- El hilo `carta-tape` y su arranque (`sim-worker.ts:435-466`), la sesión obligatoria en `/api/` (`app.ts:997`) y el gzip de la respuesta HTTP.
- `scripts/respaldo.sh` solo para `world.sqlite`.

## 5. Migración por etapas

Cada etapa deja el mundo funcionando. Propietarios disjuntos entre paréntesis.

| Etapa | Trabajo | Ficheros | Cómo se mide |
|---|---|---|---|
| **E1** Contrato, L0 y épocas (A) | Congelar `cinta.ts`; formato de bloque; escritor L0; catálogo; `abrir`/bifurcación; adaptador `Corte` sobre el `projectTapeFrame` actual; SAB de cadencia; alias `/api/tape/*` → lector L0 | nuevos `src/shared/cinta.ts`, `src/server/cinta/{formato,escritor,catalogo}.ts`; tocan `tape-worker.ts`, un parche en `sim-worker.ts` | ida y vuelta exacto; `beforeStep` jamás devuelve `false` por la cinta; ms/fotograma p95 |
| **E2** Niveles y poda (A) | `reducir` L1–L4, `serie`, `hitos`, `catalogo`, podador por bytes | `src/server/cinta/{reducir,poda}.ts` | bytes ≤ tope×1,02 con firehose 2×; coberturas sin huecos |
| **E3** Lectura e índices (B) | lector con índice en RAM, LRU de keyframes, **pool de 2-4 hilos lectores** fuera del hilo HTTP, tope de bytes por respuesta, rutas `/api/cinta/*` | `src/server/cinta/lector.ts`, `lector-worker.ts`, `gateway.ts`, `app.ts:1020-1035` | salto p95 < 100 ms en frío; el bucle HTTP no se bloquea |
| **E4** Cliente (C) | `dvr-player.ts` por fotogramas, niveles y cambio de escala; barra con insignia de escala, «Presente» y serie; marcadores y fijación (pin) | `src/client/{dvr-player,dvr-bar,game}.ts`; `src/server/cinta/marcadores.ts` | pruebas del reproductor con cinta sintética multinivel |
| **E5** Respaldo (D) | `scripts/respaldo-cinta.sh`, unidades systemd, restauración | `scripts/`, `scripts/systemd/torre/` | prueba de restauración (§7, I8) |
| **E6** Retirada (A) | borrar lo de §4; conversor opcional `scripts/cinta-migrar.ts` (~100 líneas) del formato viejo a L0 de un mundo que se arrastre | los de §4 | `npm run typecheck && npm test` verdes |
| **E7** Sectores espaciales (B) | **condicional**: si el keyframe medido supera ≈ 5 MB, partirlo en sectores de 64×64 teselas comprimidos por separado; el lector solo decodifica los de la cámara | `formato.ts`, `lector.ts` | salto p95 sigue < 100 ms con 50.000 entidades |
| **E8** Carga y calibración (todos) | cinta sintética de 50 GB, ráfaga a 2×Hz, restauración, caída del escritor | `scripts/perf/` | §6 y §7 con números reales |

El mundo nuevo V23 nace ya con el formato nuevo (decisión 12), así que la migración de datos es opcional. El lector del formato viejo no se mantiene.

## 6. Coste de cómputo y memoria

Supuestos explícitos: motor a H = 300 Hz (no medido en V23), 80 KB por fotograma L0 (medido hoy), `paso0` = 4.

- **Escritura L0**: H/4 × 80 KB = 6 MB/s ≈ 21 GB/h; 48 MB por día de mundo (≈ 20 KB por tick). Cuota L0 = 24 GB ≈ 500 días de mundo ≈ 55 min de reloj de pared a 300 Hz.
- **Niveles superiores** (por día de mundo): L1 ≈ 1,1 MB, L2 ≈ 80 KB, L3 ≈ 12 KB, L4 ≈ 1 KB (estimación: L1 ≈ 15 KB por fotograma comprimido). L1 con 12 GB cubre ≈ 10.000 días; L2-L4 cubren la vida entera con holgura. **Toda la vida del mundo cabe a resolución L1 mucho antes de agotar los 50 GB.**
- **CPU del escritor**: un fotograma L0 ≈ 3-5 ms (diff + zstd/gzip nivel 1) → 75 fps × 4 ms ≈ 0,3 hilo. L1-L4 añaden ~10 %. Si H sube o la población crece, `paso0` sube a 8, 16 o 32, de modo que el coste por hora de mundo se mantiene y el motor no nota nada. Medir si zstd gana ≥ 1,5× a gzip en la etapa E1; si no, queda gzip.
- **Poda**: `unlink` de ≈ 0,1 segmento por minuto; despreciable. Se ejecuta con `nice`/`ionice` idle en el propio hilo `carta-tape`.
- **Memoria del escritor**: 2 × vista (≈ 2-5 MB hoy; 100 MB con 50.000 entidades) más el espejo de teselas registradas (≈ 150 B por tesela registrada; con 4 M teselas, ≈ 600 MB, ya así hoy en modo disperso). Índice en RAM: ≈ 12.000 bloques × 64 B < 1 MB.
- **Lector**: LRU de ≈ 8 keyframes decodificados por hilo, acotado a 256 MB. Salto en frío, keyframe de 2 MB: pread 1 ms + descompresión 7 ms + `JSON.parse` 12 ms + proyección y recorte 5 ms ≈ 25-40 ms para el primer fotograma; con 31 deltas más ≈ 60 ms. Crece ≈ 14 ms por MB de keyframe; pasar de 5 MB dispara E7.
- **Escala**: bytes de L0 ∝ H × entidades; la cuota por bytes hace que la ventana L0 se acorte cuando el mundo crece, sin tocar L1+.

## 7. Invariantes y pruebas (sustituyen a la paridad)

- **I1** Ida y vuelta: para estados sintéticos con semilla, `leer(escribir(c))` es igual a la proyección cuantizada (igualdad profunda, no de bits de motor).
- **I2** `t` estrictamente creciente por época; el catálogo no tiene solapes ni huecos salvo `lagunas` declaradas.
- **I3** Coherencia entre niveles: para todo corte que cae en varios niveles, `L(k)` es igual a `reducir(k, L0)`; `reducir` es pura y se prueba sola.
- **I4** Presupuesto: bajo ráfaga 2×Hz los bytes ≤ `topeBytes × 1,02`; el contador de `beforeStep` bloqueados por cinta es 0; `paso0` sube y vuelve a bajar.
- **I5** Salto: 1.000 `t` aleatorios en una cinta de ≥ 5 GB, caché fría, p95 < 100 ms en cada nivel.
- **I6** Caída: matar el hilo escritor con un `kill` en puntos inyectados (mitad de bloque, entre `fdatasync` y commit, mitad de poda); al reabrir, `quick_check` ok, cola truncada al último bloque confirmado, ninguna fila apunta a un fichero ausente.
- **I7** Bifurcación: reinicio con `tMundo < tCinta`, restauración, cinta perdida y `instanciaId` distinto producen respectivamente época nueva + hito, idem, laguna + hito, y cinta huérfana apartada.
- **I8** Respaldo: grabar, respaldar, borrar, restaurar, abrir; hash de 200 fotogramas leídos antes y después idéntico; segmento truncado o con `crc32` malo se detecta en `--verificar`.
- **I9** Auditoría física de la serie (sustituye al digesto golden): entre dos puntos consecutivos de una misma época, `Δpoblación = nacimientos − muertes (± inmigración declarada)`. Detecta eventos perdidos por el escritor.
- **I10** Poda: nunca queda un `pin` activo sin cubrir ni un segmento referenciado borrado.

## 8. Cómo se ve en pantalla

- **Barra de transporte** (`dvr-bar.ts`): serie de población de toda la vida (arrastrable), marcas verticales para bifurcaciones y lagunas, y botón **«Presente»** con el desfase al lado («a 4 d 6 h del presente»).
- **Velocidad normal** = 6 fotogramas por segundo **del nivel actual**, no 6 ticks. En L0 (paso 4) son 24 ticks/s; en L3, 6 días por segundo. Una insignia dice la escala: «Detalle completo · 1 s = 4 min de mundo», «Resumen diario · 1 s = 6 días». Las velocidades siguen siendo 0,5×–25× del 1×.
- **Al entrar**: se pide el marcador del perfil y se reanuda ahí a 1× con un aviso breve («Retomando en el día 41 · el presente está a 12 días»). Si ese punto ya quedó en un nivel grueso, se muestra el nivel que haya con la insignia; no hay mensaje de error.
- **Zonas adelgazadas**: L1 no muestra barras de hambre ni fatiga en el inspector (campo ausente → se oculta); L2 dibuja la fauna como manchas de densidad (capa de calor ya existente en `game.ts`) y las personas como puntos con id; L3-L4 dibujan estructuras en pixel-art, comunidades y mapa de calor. Entre niveles hay un fundido corto (`discontinuity: true`), sin interpolar posiciones.
- **Bifurcación**: cuando el cabezal cruza una, una línea en la crónica («El mundo se reinició: se perdieron 3,7 días no guardados»).

### Marcadores y perfil

No hay usuarios (una sola contraseña, `auth.ts`). Se crea un **perfil** (UUID + nombre opcional) en `localStorage`; `PUT /api/cinta/marcador` cada 5 s mientras se reproduce y con `sendBeacon` en `pagehide`; `GET /api/cinta/marcador?perfil=`. Se guardan los 5 últimos por perfil. Si el servidor no responde, manda `localStorage`. Mientras un marcador esté vivo (14 días), el podador **fija** los segmentos L0 de `[t, t + 14 días de mundo]` (≈ 700 MB por marcador, tope 4 GB entre todos).

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Un fallo del escritor pierde la única fuente de verdad | bloque con `crc32`; `fdatasync` por bloque; pruebas I6; respaldo de L1-L4 cada hora; la cinta no frena ni tumba al motor, pero se avisa en `/api/cinta/meta` (`estado`) |
| Reproducir a «1×» desde el marcador alcanza zonas gruesas | fijación de 14 días + insignia de escala (§8); es un límite físico (§10) |
| Keyframes grandes rompen los 100 ms | primer pintado desde el keyframe sin deltas; E7 por sectores si pasa de ≈ 5 MB |
| Lecturas de cinta bloquean HTTP (hoy `readChunk` síncrono, hasta 240 fotogramas) | pool de lectores + tope de bytes por chunk + `n ≤ 120` |
| Tope de 50 GB y disco de `/datos` al 80 % (245 GB libres) | cuota por bytes y verificación al arrancar (`statfs`); L0 es lo primero que cede |
| Dos implementaciones del contrato de delta | se borra la del servidor; una sola en `shared/tape-delta.ts` |
| El otro equipo cambia `projectTapeFrame` mientras se hace E1 | E1 solo envuelve su salida en `Corte`; el contrato `Corte` es lo único congelado |
| Restaurar un respaldo antiguo del mundo con una cinta más nueva | regla de bifurcación (§3), probada en I7 |

## 10. Consecuencias y decisiones para el orquestador

**Consecuencias que Steven debe conocer**

1. **El observador nunca alcanzará al motor a velocidad normal.** Con H = 300 y `paso0` = 4, el motor avanza ≈ 450 días de mundo por hora y la reproducción a 1× en L0 consume ≈ 36 días por hora. Quien deje una pestaña viendo en vivo se queda 12× atrás cada hora. Lo que se ve «tras volver» es, casi siempre, una época ya resumida en L1-L2. Es inherente a las decisiones 1 y 10; lo mitigan la fijación del marcador (14 días) y la escala visible, no se elimina.
2. **Sin determinismo la cinta es irrecuperable**: un bug de grabación pierde historia para siempre; no hay reproducción para regenerarla. La suite I1-I10 y el respaldo importan más que antes.
3. **Reiniciar pierde mundo, no cinta**: tras caída, el mundo vuelve al último guardado (turbo guarda cada ≥ 30 s, `app.ts:872-873`), que a 300 Hz son ≈ 3,7 días de mundo que la cinta recuerda como época huérfana y el mundo no. Conviene que quien lleve la persistencia guarde por ticks y no por reloj de pared (fuera de mi pieza).
4. **Los átomos no entran en la cinta.** Graba la vista pública (forma, compuesto principal, estado), no la composición atómica. Inspeccionar un objeto o un cuerpo en el pasado muestra lo registrado en `catalogo`, no su estructura viva. Grabar átomos multiplicaría el tamaño por varios órdenes (decisión 6).
5. **Identidad**: los marcadores son por perfil de navegador, no por persona autenticada; cualquiera con la contraseña puede leer los marcadores ajenos.
6. **La cinta no regenera partidas**; nadie puede «volver a jugar desde aquí» (decisión 2).

**Decisiones abiertas para el orquestador**

1. Cuotas y tope: confirmar 50 GB en `/datos` (80 % usado) frente a un disco con más holgura.
2. `paso0` = 4 y el reparto 48/24/12/8/6 %: se calibran en E8 con el H real de V23.
3. Respaldo de L0 a `/mnt/Data2`: por defecto solo L1-L4 + catálogo (≈ 1-2 GB, cada hora); L0 (21 GB/h de escritura sostenida a 300 Hz sobre un disco lento) detrás de `RESPALDO_L0=1`. Procedimiento: instantánea del catálogo con `.backup`, enlaces duros de los segmentos que referencia (los sellados son inmutables; el activo se copia hasta `len_commit`), `rsync --ignore-existing` a baja prioridad, `crc32` verificado, y el espejo borra lo que ya no referencia el último catálogo tras 3 días.
4. Contrato `Corte` y los acumuladores del motor (§2): lo congela el equipo del motor en la etapa E1; sin ello no arranca nada.
5. Si el equipo de la UI v24 acepta la insignia de escala, la capa de densidad para L2+ y el botón «Presente» en la barra; son cambios en sus ficheros.
6. Conservar o no un lector del formato viejo para el público V22 durante la transición: propongo no conservarlo.
