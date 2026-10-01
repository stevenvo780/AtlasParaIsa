# Reproducción y entrega del objetivo 9

Guía documental para una reproducción autorizada futura. El panel original ya terminó: identidad y cobertura PASS; puerta de coste **NO CUMPLIDA**. Typecheck y suite final PASS; candidato conservado únicamente en su rama local. No se implementa la ley material ni se modifica main, público, carta, servicios o protocolos existentes. Un selftest no sustituye las trayectorias.

## Identidad de la entrega

| Archivo | SHA256 verificado |
|---|---|
| `scripts/lab/validar-ciclo-material.ts` (517 líneas) | `4d8b6dfdf3ca640af7c9f922f7458243d9470a6030d1ddaf925789464625e78d` |
| `/datos/tmp-atlas-lab/datos-lab/CODEX9-PROTOCOLO-EVENTOS-v3.json` | `20a1328c73ae202d951804a6fd5b1b5af5b4883beaff65b076fe0527e9aaf7fa` |
| `/datos/tmp-atlas-lab/balance/codex9/run_guarded.mjs` | `26ea519ae9e94566da078928004551ffb36bf8d62c906e32c43dfe2295aeb60f` |
| `/datos/tmp-atlas-lab/balance/codex9/run_qa_night_guarded.mjs` (sólo QA nocturno) | `285a9f7c103765edc85edb2b49ddcedfa78d67fd85dcb81d4771091e86e8f458` |
| `/datos/tmp-atlas-lab/datos-lab/DISENO-CICLO-MATERIAL-20261001.md` | `edf3ef8711a73e2339a2999ad6d82af89dfee0d188a8bb7ef601f2b7007af08b` |

Baseline: `bb483260b2489fe62b113d620e5f56e5f3676dbc`. El manifiesto existente contiene67 archivos TS, `baseCommit`, `archiveSHA256` y `files[{path,sha256}]`; declara para el tar `37785411452a3bd8b6d4ea4127527160921c052b2c81ac3b9f047688373571c1`. Este último valor se leyó del manifiesto; no se volvió a hashear el tar aquí. El runner coteja los67 archivos y restringe diferencias a los cinco módulos de V3; registra fuentes, runner, runtime y protocolo al inicio/final.

## Preparación en rutas libres

Las rutas siguientes **ya existen** y se conservan, salvo el worktree propio retirado después del commit. No repetir creación/copia sobre rutas ocupadas; no borrar, resetear ni sobrescribir para hacer funcionar un comando. La rama final conserva el candidato: crear otra rama sólo desde el baseline no incorpora el observador. `ENTREGA-LOCAL.json` externo identifica el commit; `ENTREGA-MANIFEST.json` versionado identifica las fuentes/evidencias. Para restaurar sólo el worktree en su ruta libre:

```sh
set -eu
REPO=/datos/workspaces/personal/AtlasParaIsa
LAB=/datos/tmp-atlas-lab
WT=/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/ciclo-material
BASE=$LAB/datos-lab/codex9-main-source
ARCHIVE=$LAB/datos-lab/codex9-main-source.tar
NODE=$LAB/codex9-runtime/codex9-node
WRAPPER=$LAB/balance/codex9/run_guarded.mjs
PROTOCOL=$LAB/datos-lab/CODEX9-PROTOCOLO-EVENTOS-v3.json
test ! -e "$WT"
git -C "$REPO" worktree add "$WT" sprint/ciclo-material-20261001
cp -a "$LAB/codex9-runtime/node_modules" "$WT/node_modules"
test -f "$ARCHIVE" && test -f "$BASE/SOURCE-MANIFEST.json"
test -x "$NODE" && test -x "$LAB/balance/codex9/launcher-init-codex9.bash"
test -d "$BASE/node_modules"
```

El runtime es una copia ejecutable real con basename `codex9-node`, no un symlink al binario del sistema; su versión debe satisfacer `package.json`. Las dependencias durables están copiadas en `$LAB/codex9-runtime/node_modules` y el baseline ya apunta allí; no depende del worktree retirado ni necesita instalar/cambiar versiones. Se conserva `SOURCE-MANIFEST.json` con sus67 entradas. Si faltara el export, reconstruir en rutas libres con `git archive` del commit baseline y pathspec `src/world src/shared src/server package.json tsconfig.json`, comprobar SHA del tar y generar ese esquema con todos los `.ts` ordenados y SHA real. Las rutas del runner/lanzadores deben conservarse; no editar el protocolo para admitir fuentes diferentes.

## Guardas y selftest

El wrapper espera2 segundos antes de establecer la frontera de lanzamiento; registra la prioridad recibida y fija **nice absoluto19 una sola vez** en sus hilos, antes de guardas/hijo. El runner fija19 antes de su guarda inicial. No basta `nice -n19`, que es relativo; tampoco se repara prioridad durante trabajo. Ambos exigen CPU6–31 y `TMPDIR=/datos/tmp-atlas-lab`; deriva, timeout o salida no0 invalidan la ejecución. El wrapper observa descendientes cada0,5 segundos: deriva/procesos íntegramente entre muestras pueden escapar. Los checkpoints del runner complementan esa guarda, no prueban observación continua.

Elegir labels y archivos de salida nuevos. El wrapper rechaza un JSON existente y abre el log con creación exclusiva; no reutilizar los labels originales. `--selftest` inicializa y comprueba fixtures/estadística; **0 llamadas reales a stepWorld**, sin trayectorias de1200 pasos.

```sh
cd "$WT"
env -u LD_PRELOAD -u CODEX9_LAUNCHER_INIT -u CODEX9_INIT_AUDIT TMPDIR="$LAB" taskset -c 6-31 \
  "$NODE" "$WRAPPER" runner-selftest-repro 120 \
  "$NODE" --import tsx scripts/lab/validar-ciclo-material.ts --selftest --protocol "$PROTOCOL" --base "$BASE"
```

## Gate real autorizado, sin LD_PRELOAD

Ejecutarlo sólo después de la barrera del orquestador y cuando no compita con el benchmark en marcha. Una única instancia; ninguna simulación pública como entrada. V3 fija semillas17001–17006, familias `fresh`/`material-stressed`, dos rondas ABBA/BAAB y cuatro brazos: **96 mundos medidos×1200 pasos=115.200**, más calentamiento A1/B1 de300 pasos cada uno (**600**, semilla16999), excluido del coste. Cada trayectoria medida dura **0,5 días**, no20 días. El diseño B propone otro experimento de8 pares×20 días y semillas candidatas18001–18008; no se ejecuta ni se declara reservado por este gate.

```sh
env -u LD_PRELOAD -u CODEX9_LAUNCHER_INIT -u CODEX9_INIT_AUDIT TMPDIR="$LAB" taskset -c 6-31 \
  "$NODE" "$WRAPPER" gate-v3-repro 7200 \
  "$NODE" --import tsx scripts/lab/validar-ciclo-material.ts --run --authorized \
  --protocol "$PROTOCOL" --base "$BASE" --out "$LAB/balance/codex9/gate-v3-repro-report.json"
```

`--authorized` no cambia umbrales: confirma una barrera previa. El criterio V3 exige identidad íntegra de mundo/parámetros y tablas SQLite, fuentes/recursos/cobertura válidos y límite superior del IC95 % de sobrecoste≤1 % en **CPU y pared, en cada familia**, sin excluir semillas ni ruido incómodo. Incluye inicialización/ingest/export/serialización y E/S buffered del observador; no acredita fsync ni rendimiento del público. El wrapper escribe `gate-v3-repro.json/.log`; el informe científico es el archivo de `--out`. Revisar ambos, incluidos fallos parciales y warmup; salir0 por sí solo no completa las demás puertas.

## Typecheck y suite: puertas separadas

`npm run typecheck` final PASS con `typecheck-npm-final.json` (1,115552599s); suite completa PASS con `suite-v4-night.json/.log`:1645 pruebas,1636 aprobadas,9 omitidas,0 fallos/canceladas/todo;370,216954931s guardados,741 muestras y116.894 comprobaciones de hilos,0 incidencias. Los intentos anteriores se conservan y no sustituyen este resultado. El intento `suite-v3` fue rechazado por afinidad y **no es PASS**. El final `suite-v4-night` usa npm/shims sin preload y wrapper separado `run_qa_night_guarded.mjs`. Sólo es válido con reloj **America/Bogota,00≤hora<07**: comprueba la ventana en cada muestra y cierre, nice19 por hilo y máscara no vacía contenida en0–31; el padre usa taskset0–31, timeout1200. Esa política nocturna procede del objetivo8; **no modifica V3, runner, wrapper original ni gate científico**. Para reproducción autorizada en esa ventana, con label libre:

```sh
env -u LD_PRELOAD -u CODEX9_LAUNCHER_INIT -u CODEX9_INIT_AUDIT TMPDIR="$LAB" \
  PATH="$LAB/balance/codex9/qa-path-bin-v1:$PATH" taskset -c 0-31 \
  "$NODE" "$LAB/balance/codex9/run_qa_night_guarded.mjs" suite-v4-night-repro 1200 \
  "$NODE" /usr/lib/node_modules/npm/bin/npm-cli.js test
```

Los shims `qa-path-bin-v1/node` y `bash` tienen shebang absoluto a la copia real `launcher-init-codex9.bash` y hacen exec de las copias absolutas conservando `"$@"`. No fijan prioridades ni cargan bibliotecas. PATH debe conservarse; una ruta absoluta al binario del sistema los elude y un fake-bin antepuesto por tests sigue primero. Cambia argv0 y el `$0` predeterminado de bash-c; no cambian argumentos posteriores, sanitización ni TMPDIR anidado. Leer `qa-path-README.md` y `qa-path-hashes-v1.json`. Smoke registrado: **6,063484254s**, válido,0incidencias; deploy-check focal: **9/9PASS**, **13,359187917s** guardados,0incidencias. Esos resultados focales no sustituyen la suite final. suite-v3 abortó por16hilos nativos con afinidad0–25, aunque nice19 era correcto: esa máscara está permitida por objetivo8 en la ventana nocturna de QA final, no por la guarda fija6–31. El helper C permanece como intento histórico, **no como comando recomendado**. No reinyectar preload, reparar deriva, alterar tests o saltarlos. El benchmark continúa sin helper ni LD_PRELOAD.

## Resultados y entrega

Informe real `gate-v3-result.json`: **96 mundos,115.200 pasos medidos+600warmup**, `identityPassed:true`, `fixturePassed:true`, coste **NO CUMPLIDA**. Tabla exacta de `cost.families`: valores en **fracción**, donde0,01=1 %; IC bilateral95 %, sin exclusiones.

| Familia | Métrica | Estimación | IC95 % inferior | IC95 % superior | Upper≤0,01 |
|---|---|---:|---:|---:|---|
| fresh | CPU | 0.010485738350988998 | -0.0019508887458672597 | 0.02436459873645902 | false |
| fresh | pared | -0.0056357323438847445 | -0.04989920594868762 | 0.04819634770794898 | false |
| material-stressed | CPU | -0.006789306009749601 | -0.02068122874332694 | 0.007562237407618904 | true |
| material-stressed | pared | 0.01681770210764254 | -0.03285848775004702 | 0.07770795772921435 | false |

CPU fresh y pared estresados tienen estimación>1 %; pared fresh queda sin resolver por incertidumbre, aunque su estimación sea negativa. CPU estresados cumple únicamente su subpuerta. `gate-v3-real.json`: code1/validfalse por fallo científico,0incidencias de recursos,3757,963578108s y sin timeout/preload. La comprobación numérica independiente `codex9-verificacion-gate-final.json` reporta0diferencias. Esto no autoriza omitir el umbral de pared ni declarar aceptado el instrumento.

`QA-FINAL.json` concilia las puertas y hashes finales. El recibo externo `ENTREGA-LOCAL.json` registra commit, rama y retirada del worktree propio; el manifiesto versionado registra SHA de fuentes/evidencias. La entrega se cierra informando **puerta A NO CUMPLIDA**, con diseño B sin implementar. Ese cierre no acepta la ley, el instrumento ni criterios biológicos. No se añadió una variable de backend.

El orquestador deberá entregar el commit/patch candidato y manifiesto final, hashes de protocolos/fuentes/runtime, informes completos y revisión adversarial, con puertas cumplidas o **NO CUMPLIDAS** por separado. El diseño material permanece propuesta; `explicitRuinInModel:false` y `salvagePotential.recoveryImplemented:false` describen el instrumento actual. Coste nominal/salvamento potencial no son masa recuperada. Bitácora y marca FIN pertenecen al orquestador y no se escriben desde esta guía.
