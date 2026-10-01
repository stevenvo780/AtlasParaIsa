# Ensayo propio de inicialización — 2026-10-01

La variante comprobada es `launcher-init-codex9.exec-argv0.so`, compilada desde `launcher-init-codex9.c` y `launcher-init-codex9.exec.c`. Utiliza la copia existente `codex9-runtime/codex9-node` y la copia propia `launcher-init-codex9.bash`. No modifica configuración, binarios originales ni servicios del host.

El constructor fija una sola vez nice 19 en los hilos ya existentes, verifica CPU 6–31 y TMPDIR, y asigna un nombre propio. Los wrappers de exec resuelven `node`/`bash` respetando PATH y sólo sustituyen los binarios del sistema o nuestras copias; no sustituyen programas personalizados que tengan esos nombres. Tanto la ruta ejecutada como argv[0] pasan a tener un nombre neutro. Los argumentos posteriores y el entorno funcional se conservan. No hay bucle de renice ni reparación posterior.

Las reglas leídas son `bash → Doc-View → nice -4` y `node → BG_CPUIO → nice 16`. Cambiar sólo comm, o proporcionar symlinks de PATH, no alcanzó: los smokes v1/v2 fueron rechazados a ≈0,51 s. Redirigir la ruta conservando argv[0] también fue rechazado en v3/v4. La combinación ruta/argv[0] neutros pasó **con la pausa inicial de 2 s del guardian de root**, que registra la prioridad recibida y establece 19 una vez antes de crear hijos. Una atribución más precisa del evento diferido del daemon no está demostrada por estos smokes.

`launcher-init-codex9.smoke-v5.json`: 6,569 s de fase guardada, 15 muestras, 313 hilos examinados, cinco PIDs observados y cero incidencias. Bash lanzó Node y Python por PATH; llegaron y terminaron a nice 19. Los logs y el audit JSONL conservan la evidencia de todos los ensayos fallidos y del aprobado. La guarda continúa abortando ante deriva y conserva su límite declarado de muestreo de 0,5 s.

Invocación del smoke ya comprobado (usar otro label/audit para repetir):

```sh
env TMPDIR=/datos/tmp-atlas-lab taskset -c 6-31 env \
  LD_PRELOAD=/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.exec-argv0.so \
  CODEX9_LAUNCHER_INIT=1 \
  CODEX9_INIT_AUDIT=/datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.smoke-v5.audit.jsonl \
  /datos/tmp-atlas-lab/codex9-runtime/codex9-node \
  /datos/tmp-atlas-lab/balance/codex9/run_guarded.mjs launcher-init-codex9.smoke-v5 20 \
  /datos/tmp-atlas-lab/codex9-runtime/codex9-node \
  /datos/tmp-atlas-lab/balance/codex9/launcher-init-codex9.smoke.mjs
```

**Límite pendiente:** no acredita nice 19 para todos los descendientes de la suite completa. `deploy-check.sh` usa `env -i`, elimina LD_PRELOAD y cambia TMPDIR a un sandbox propio. Los ejecutables estáticos tampoco ejecutan el constructor. No se reinyectó el preload en entornos sanitizados, no se alteró el test ni se modificó la sanitización. La variante no debe usarse para dar por aprobada la suite o el benchmark; cualquier ejecución debe conservar la guarda y registrar/abortar la deriva. No se lanzó ninguna suite masiva ni benchmark desde este frente.
