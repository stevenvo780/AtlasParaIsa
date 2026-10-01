# Lanzamiento QA mediante PATH, sin LD_PRELOAD

Artefactos externos propios del objetivo 9. No cambian fuentes, pruebas, sanitización, servicios ni configuración del host. No son evidencia de cumplimiento del gate de coste del instrumento.

## Shims

Anteponer `/datos/tmp-atlas-lab/balance/codex9/qa-path-bin-v1` a PATH. Sus ejecutables `node` y `bash` son scripts con shebang absoluto a la copia REAL `/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.bash`. Ejecutan, respectivamente, las copias absolutas `codex9-node` y `launcher-init-codex9.bash` mediante `exec ... "$@"`. No establecen prioridades ni cargan bibliotecas adicionales.

Los argumentos posteriores a argv[0] se conservan, incluidos vacíos, espacios, comillas y dólares literales. argv[0] cambia al ejecutable copiado; también cambia el valor por defecto de `$0` en `bash -c` sin un nombre explícito.

`deploy-check.sh` conserva PATH cuando usa `env -i`; su TMPDIR anidado queda intacto. Un fake-bin que un test anteponga a PATH continúa primero. Una invocación absoluta al binario del sistema elude estos shims.

## Smoke único registrado

Se ejecutaron dos casos concurrentes de espera de seis segundos: PATH normal y `env -i` conservando PATH con TMPDIR/TMP/TEMP anidados. Ambos atravesaron bash y node por PATH, comprobaron los argumentos y terminaron con código 0. No hubo reparación de prioridad durante el trabajo.

Resultado: `qa-path-smoke-v1.json`, válido, fase guardada 6.063484254 s, 14 muestras, 350 comprobaciones de hilos, cuatro PID observados, cero incidencias. `qa-path-smoke-v1-cases.json` registra ambos casos; `qa-path-smoke-v1.log` conserva los recursos al principio y al final. El wrapper recibió nice -4 y estableció nice 19 una sola vez después de su pausa previa de dos segundos y antes del hijo. Todos los hilos observados durante el trabajo conservaron nice 19 y CPU 6-31. LD_PRELOAD e inicializador estaban ausentes.

Comando exacto usado, desde el worktree propio:

```bash
env -u LD_PRELOAD -u CODEX9_LAUNCHER_INIT -u CODEX9_INIT_AUDIT \
  TMPDIR=/datos/tmp-atlas-lab \
  PATH="/datos/tmp-atlas-lab/balance/codex9/qa-path-bin-v1:$PATH" \
  taskset -c 6-31 \
  /datos/tmp-atlas-lab/codex9-runtime/codex9-node \
  /datos/tmp-atlas-lab/balance/codex9/run_guarded.mjs \
  qa-path-smoke-v1 20 \
  /datos/tmp-atlas-lab/codex9-runtime/codex9-node \
  /datos/tmp-atlas-lab/balance/codex9/qa-path-smoke-v1.mjs
```

Este registro usa artefactos exclusivos: el guardian exige un label nuevo y el smoke rechaza un reporte o sandbox preexistente. No volver a ejecutar el mismo comando sobre sus evidencias.

## Límites

La guarda existente observa el árbol de procesos e hilos cada 0.5 s y aborta si encuentra deriva. Un proceso o cambio de prioridad que viva sólo entre muestras puede escapar. La transición inicial del script conserva brevemente el basename node/bash en el nombre del proceso; el smoke no observó una clasificación retrasada, pero no garantiza su ausencia en toda ejecución. Los shims dependen de que el padre haya establecido nice 19 y CPU 6-31 antes de generar hijos, y de que PATH permanezca disponible.

Este PASS acredita únicamente el smoke descrito, sin suite ni simulación. El focal deploy-check y la suite pertenecen al root. SHA-256 de shims, smoke y dependencias usadas: `qa-path-hashes-v1.json`.
