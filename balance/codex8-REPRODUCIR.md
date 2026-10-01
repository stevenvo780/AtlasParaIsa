# Evidencia de Codex8

Entrada principal: [auditoria-realismo-20260930.md](auditoria-realismo-20260930.md).

Este paquete versiona instrumentos, métricas agregadas y manifiestos, sin mundos
SQLite, cartas, inputs, sesiones ni credenciales. Los seis respaldos privados y
las copias de diarios permanecen en `/datos/tmp-atlas-lab/datos-lab/codex8-*`.
Las rutas absolutas de los manifiestos son procedencia local, no recursos remotos.

Para repetir desde la torre, recrear el worktree propio en
`AtlasParaIsa-anexo/worktrees/auditoria-realismo` desde esta rama y copiar
`node_modules`. No usar `main`, servicios atlas ni datos vivos. Mantener
`TMPDIR=/datos/tmp-atlas-lab`, CPUs 6–31 y nice19, registrando prioridad efectiva
inicial/final. Los runtimes copiados usados por la auditoría están en
`/datos/tmp-atlas-lab/codex8-runtime/`; no cambian servicios ni reglas del host.

El lector público es `scripts/lab/auditar-realismo.py`; solo acepta SQLite en
`/datos/tmp-atlas-lab/datos-lab/codex8-respaldos`. Elegir una salida nueva con
`--output`, y verificarla con `codex8-verificar-publicos.py`. No sustituir cifras
canónicas si falla un guard. Los CSV describen intervalos entre respaldos, no
inventan historia diaria de usos.

La reproducción C8 se divide en dos procesos: primero ejecutar
`codex8-c8-recalcular.mts` con el Node propio, loader tsx del worktree y destino
scratch positional; luego `codex8-c8-recalcular.py --node-json <scratch.json>
--output <otro-scratch.json>`. El lector verifica el manifiesto de fuentes
históricas y el digest de `18062f5`; ese código está copiado localmente en
`codex8-c8-copia/source-world`. El criterio congelado se importa sin editarlo.
Usar resultados nuevos solo si los guards pasan y las cifras coinciden.

`codex8-laboratorio-cifras.json` declara las tres copias/cortes, cada réplica y
denominadores de ventana. El verificador final vuelve a calcular las series
desde los diarios copiados. Las siete réplicas parciales son descriptivas, sin
evaluación del panel de cupo. No se espera ni relanza ningún proceso.

El recálculo completo de esas 42 series está en
`codex8-laboratorio-recalcular.py --output <salida-nueva.json>`; verifica los
manifiestos y rechaza sobrescribir un destino existente. El cambio de finales
de línea de los CSV queda probado sin cambios de filas en
`codex8-csv-formato.json`.

Validación del código del producto: typecheck y suite completos verdes, antes
del commit de esta rama. El instrumento Python se compila y sus reglas de
censo pasan pruebas sintéticas independientes. No se construyó ni publicó la
aplicación. Los replays con deriva de prioridad quedan identificados como
fallidos; sus salidas no reemplazan los resultados aceptados.
