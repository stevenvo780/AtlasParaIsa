# Quickstart — medir el techo y verificar el determinismo cruzado

> **Estado (2026-09-22): etapas B–F congeladas.** No se reanudan hasta que los 16 fundadores
> lleguen a 100 días con 3 generaciones en el 90 % de las semillas
> (`docs/REVISION-NOCHE-2026-09-22.md`). La etapa A está integrada y solo sigue abierta T100. Este
> documento conserva el diseño original: el estado de cada tarea está en [tasks.md](tasks.md) y lo
> publicado en `docs/ESTADO.md`. T116 y T135 siguen asignadas a `grok/*`, que la flota ya no
> permite; se reasignan al descongelar.

> Desde la torre kratos, rama `002-mundo-ilimitado`. **Todo se corre en un worktree**, nunca en el árbol principal: el servidor público corre con `cwd` aquí y sirve `dist/client` **en caliente**. `npm run build` y `npm run check` solo al publicar, con el servidor parado.

```sh
git worktree add /tmp/002-med 002-mundo-ilimitado && cd /tmp/002-med
ln -s /datos/workspaces/personal/AtlasParaIsa/node_modules node_modules
```

## 0. Verde antes de empezar

```sh
npm run typecheck
npm test                    # ~10 min; world.test.ts ~5 min. NUNCA sin --test-timeout
```

## 1. Sonda del hardware (una vez por máquina)

```sh
python3 scripts/compute-hardware.py
```
Debe listar 32 CPUs, las dos GPU con su VRAM libre y `cuInit=0`. Si `navigator.gpu` sale `undefined`, es lo esperado: WebGPU no es una vía en este Node.

## 1 bis. Lo que hoy te frena antes de que te frene el hardware (revisión 2026-09-19)

Cuatro topes de software rechazan un mundo grande **antes** de que el p95 llegue a nada. Hasta que **T100** (Gate A0) los derive de `params.limites.*`, cualquier medida por encima de 65 536 teselas activas fallará al guardar y al cargar, no por lentitud:

```sh
grep -n "65536" src/server/snapshot.ts src/world/index.ts src/world/animals.ts
grep -n "communities.length > 8\|communities.length >= 8" src/world/index.ts src/world/society.ts
grep -n "chunks).length > 256" src/world/index.ts
```
Si esos greps siguen dando resultados, **no midas el techo de teselas todavía**: lo que medirías es el tope, no la máquina. La tabla completa de correcciones está en `research.md` §6.

## 2. El techo de HOY (línea base, antes de tocar nada)

```sh
# Techo de habitantes: sube la población hasta que el p95 toca gobernador.presupuestoMs
npm run techo -- --escala habitantes --hilos 1 --seed 51926 --salida artifacts/techo/base

# Techo de teselas activas: sube el territorio activo hasta el mismo criterio
npm run techo -- --escala teselas   --hilos 1 --seed 51926 --salida artifacts/techo/base-teselas

cat artifacts/techo/base/curva.md
```
Cada punto trae `{escala, p50, p95, tickHz, rss, teselasActivas, teselasPorHabitante, fraccionSerial}`. **Esta curva es el control de todas las etapas**: sin ella, ninguna cifra de «después» significa nada.

Línea base medida 2026-09-19 (para contrastar): ≈**40 habitantes** a 10 Hz con 1 hilo, p50 del paso **206 ms** a 40 hab / 5 días; en el banco de 2 400 pasos, día simulado **43 510 ms**, p50 del par clon+paso **17,82 ms**, RSS **524,3 MiB**.

## 3. El techo TRAS CADA ETAPA

```sh
# A (paso residente): el mismo comando, 1 hilo. Objetivo ≥ 250 habitantes, p50 ≤ 25 ms
npm run techo -- --escala habitantes --hilos 1 --salida artifacts/techo/etapa-a

# B (SoA + workers): teselas con 28 workers. Objetivo ≥ 2 M teselas activas
npm run techo -- --escala teselas --hilos 28 --salida artifacts/techo/etapa-b

# C (GPU residente): teselas con la 5070 Ti. Objetivo 18,4 M ≤ 20 ms en el tick ecológico
npm run techo -- --escala teselas --hilos 28 --gpu 0 --salida artifacts/techo/etapa-c

# D (deltas): bytes por paso y por cliente, con 10 000 habitantes inyectados
npm run banco-red -- --habitantes 10000 --clientes 12 --pasos 1000 --salida artifacts/red/etapa-d
# Objetivo: < 120 KiB en viewport medio, < 250 KiB en 96x64, ≤ 2,81 MiB/s con 12 clientes,
#           0 mensajes descartados y 0 sockets terminados

# E (particiones de personas): habitantes con 28 workers. Objetivo ≥ 4 000, fracción serial ≤ 5 %
npm run techo -- --escala habitantes --hilos 28 --salida artifacts/techo/etapa-e

# F (gobernador): 30 días sin tope, mirando el techo observado
npm run lab -- --replicas 4 --dias 30 --param motor.hilos=28 --salida artifacts/lab/etapa-f

# SC-013 (el límite lo pone el hardware): 100 días, NO 30. Con 30 días el calendario de
# nacimientos (2 cada 120 ticks, params.ts:49) topa el experimento en 1 200 nacimientos y
# taparía el efecto del hardware. Escribe la cota del calendario junto a la cifra medida.
npm run lab -- --replicas 4 --dias 100 --param motor.hilos=1 --salida artifacts/lab/sc013-1hilo
npm run lab -- --replicas 4 --dias 100 --param motor.hilos=28 --salida artifacts/lab/sc013-28hilos
```

Comparar siempre contra el control:

```sh
npm run lab:resumen -- artifacts/techo/etapa-a --control artifacts/techo/base
```
El resumen marca 🔴 si la misma semilla con el mismo digesto de reglas da métricas de mundo distintas: eso es una rotura de determinismo, no una mejora.

## 4. Verificar el determinismo cruzado — **lo que no puede fallar nunca**

### 4.1 La prueba de la suite

```sh
# Modo corto (600 pasos, <= 3 min MEDIDOS): 4 semillas x 7 escenas x backends de CPU + adversarial
# Compara por barrera con hash incremental POR REGION; el digesto completo solo al final
# del paso y en los hitos (1 200 y 2 400). Con el mundo entero por barrera tardaria ~1 h.
npx tsx --test --test-timeout=600000 tests/determinismo-hardware.test.ts

# Modo largo (2 400 pasos): obligatorio en cada gate de etapa
CARTA_DETERMINISMO_LARGO=1 npx tsx --test --test-timeout=1800000 tests/determinismo-hardware.test.ts

# Con GPU (etapa C en adelante). Sin esta variable los backends de GPU salen SKIPPED, nunca PASSED
COMPUTE_NVRTC=/opt/cuda/targets/x86_64-linux/lib/libnvrtc.so.13 \
  npx tsx --test --test-timeout=1800000 tests/determinismo-hardware.test.ts
```

Los 9 backends: `{hilos:1}`, `{hilos:2}`, `{hilos:4}`, `{hilos:8}`, `{hilos:28}`, `{orden:'adversarial'}`, `{gpu:[0]}`, `{gpu:[1]}`, `{gpu:[0,1]}`. El **adversarial** corre las particiones en orden inverso, con un número de hilos distinto en cada paso y con retardos de reloj real: es el único que demuestra que el **diseño** no depende del orden de llegada, y no solo que hoy coincide.

Cuando falla, no dice «algo cambió»: dice **tick, fase, página, campo e índice** del primer desacuerdo, porque compara **tras cada barrera**.

### 4.2 A mano, el caso que pide el spec (SC-001)

```sh
# El mismo mundo al día 5, con 1 hilo y con 16 hilos: el digesto debe ser IDÉNTICO
npm run lab:replica -- --seed 51926 --dias 5 --params motor.hilos=1  --salida /tmp/d1
npm run lab:replica -- --seed 51926 --dias 5 --params motor.hilos=16 --salida /tmp/d16
diff <(jq -r .digesto /tmp/d1/replica.json) <(jq -r .digesto /tmp/d16/replica.json) && echo "IDÉNTICO"
```
Repetir con `motor.hilos=28`, `motor.orden=inverso`, `motor.orden=adversarial`, `motor.gpu=[0]`, `motor.gpu=[1]` y `motor.gpu=[0,1]`. **Todos deben dar el mismo digesto.** Si uno difiere, `diferenciaCanonica` (en `src/world/digesto.ts`) localiza el primer campo distinto.

Ojo: el digesto correcto es `digestoCanonico`, **no** `encodeSnapshot`. `encodeSnapshot` sustituye `retiredChunks` por `[]` y depende del orden de inserción de las claves de cada `Record`: un mundo con el terreno dormido corrupto pasaría su hash sin inmutarse.

### 4.3 Paridad de la GPU en caliente

```sh
# Autoprueba de arranque: 4096 celdas x 100 invocaciones, Object.is contra el kernel de CPU
COMPUTE_NVRTC=/opt/cuda/targets/x86_64-linux/lib/libnvrtc.so.13 npm run gpu:autoprueba
```
Un solo bit distinto desactiva esa GPU **para la sesión**, lo registra con dispositivo y driver, y el mundo sigue en CPU. Es lo que hace honesta la frase «el hardware solo cambia la velocidad» frente a una actualización de driver.

### 4.4 Banco de cómputo (CPU vs workers vs GPU, misma escena)

```sh
node scripts/compute-ecology-benchmark.mjs --celdas 1000000 --repeticiones 6 \
  --nvrtc /opt/cuda/targets/x86_64-linux/lib/libnvrtc.so.13
```
Cifras de referencia medidas hoy a 1 M celdas: Node 1 hilo **47,30 ms** · workers×4 **23,97** · workers×8 **19,41** · GPU 5070 Ti **219,03** (de los cuales **0,40 ms** son kernel, ~23 ms driver y **~196 ms IPC** del subproceso). Si el banco lanza `Baseline core changed`, es el candado viejo anclado a `95ff0d2`: lo arregla T108.

## 5. Laboratorio consciente del hardware

```sh
npm run lab -- --replicas 8 --dias 10 \
  --param motor.hilos=1,8,28 --param motor.gpu=[],[0] \
  --concurrencia 4 --salida artifacts/lab/hardware
```
Con `--param motor.hilos=...` el barrido corre el producto cartesiano de backends sobre las mismas semillas y `resumen.md` marca 🔴 si dos backends de la misma semilla dan digestos distintos. **Baja `--concurrencia` cuando cada réplica usa muchos hilos**: 30 procesos × 28 workers no caben en 32 hilos.

## 6. Levantar local sin tocar `data/`

```sh
npm run build   # SOLO en el worktree, nunca en el árbol principal
CARTA_DATA_DIR=$(mktemp -d) CARTA_PASSWORD=<12+ caracteres> \
HOST=127.0.0.1 PORT=3212 CARTA_ORIGIN=http://127.0.0.1:3212 \
node dist/server/server/main.js
```
Con el servidor arriba, el `state` publica `performance.fases`, `performance.gobernador` (estado, señal disparadora, **techo observado**, `teselasPorHabitante`) y `performance.tickHz`. Ese es el panel donde se lee el límite del día.

## 7. Antes de publicar

```sh
npm run respaldo              # SIEMPRE primero; VACUUM INTO, no .backup
# parar el servidor (ventana 0 del tmux `atlas`: Ctrl-C)
npm run build                 # SOLO aquí, con el servidor parado
# relanzar (Enter en el mismo pane) y comprobar en el state:
#   tickHz ≈ 10 · p95StepMs < 50 · gobernador.techoObservado poblado
```
Si subió `RULES_VERSION` (etapa E), aplica «mundo nuevo por versión publicada»: renombrar `data/world.sqlite` antes de relanzar. **Lo decide Steven.**

---

## Chuleta de parámetros de esta feature

| Parámetro | Default (= hoy) | Para qué |
|---|---|---|
| `motor.clonPorPaso` | `true` | Revierte la etapa A |
| `motor.hilos` | `1` | Workers del paso (A–F) |
| `motor.soaTerreno` | `false` | Revierte el SoA de terreno (B) |
| `motor.particionarPersonas` | `false` | Revierte el paralelismo de personas (E) |
| `motor.gpu` | `[]` | Dispositivos CUDA a usar (C) |
| `motor.orden` | `'natural'` | `'inverso'` / `'adversarial'` para la prueba de determinismo |
| `motor.depuracion` | `false` | Buffers de solo lectura en la fase B (E) |
| `persistencia.paginasSucias` | `false` | Revierte al blob monolítico (D) |
| `red.deltas` | `false` | Revierte al `state` completo (D) |
| `gobernador.senales` | `['p95']` | Revierte al gobernador de hoy (F) |
| `gobernador.presupuestoMs` | `50` | El presupuesto de p95 que define el techo |

Cada etapa se apaga en el servidor público cambiando **un parámetro**, sin desplegar.
