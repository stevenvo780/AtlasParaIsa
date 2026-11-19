# R0 PLACEBO — checkpoint de observación prospectiva

Estado: checkout editorial separado para diseñar instrumentación pasiva. No se ejecutó simulación ni se observó el pasado de nuevo.

## Punto de partida preservado

- Worktree: `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/desg-placebo-observacion-20261005`; branch `codex/desg-placebo-observacion-20261005`; original HEAD `6516c62e06fe2b22493e029022fab7f32388b674`. Al crearlo desde el worktree `desg-d-lab`, el árbol fuente estaba limpio. El commit original contiene 103 archivos bajo `src/`.
- El diagnóstico offline leyó y rehasheó **124 archivos originales** (120 diarios, 2 réplicas y 2 artefactos materiales) sin importar el motor ni invocar la simulación. Resultado: CTRL/PLAC, seed 18107, 60/60 digestos diarios iguales (ticks 2400–144000), 740 estructuras, 0 activaciones, estado final igual `ee6505ee27881c91b17a1745dc6ea32568473375b554b0d969d17690729a444c`.
- PLACEBO original: tick 4807, `thirst` reducido en 1 ULP. Ese cambio físico por sí solo no demuestra un flip conductual. Faltan decisiones locales pareadas de `choose()` entre los ticks 4807 y 144000; por ello `firstBehavioralFlip=UNKNOWN`. No se reinterpretan agregados diarios como prueba de decisiones iguales.
- Fuentes de evidencia: [resultado offline](/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/placebo-offline-read-v1/RESULTADO.md) (SHA `30b8ba10a615df6bac2c104583cfcc4c6c8346e394ccc2357e39fb3b050f1881`), [receipt offline](/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/placebo-offline-read-v1/receipt.json) (SHA `637eeb32743a51789d51a9edf92c8f4275fca1d9b072d85fcf447f38d7ee3b0e`), [lector original de solo lectura](/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/placebo-offline-read-v1/read-original-diaries.mts) (SHA `89e29e9c4bd94a94d15eb0117f3affb15bab3ece43ee8de74e50f51a3cce6150`).
- La review prospectiva cerrada por Muse es [REVIEW-v1.md](/datos/tmp-atlas-lab/orquestacion-20261003/muse-tmux/r0-placebo-prospective-v1/REVIEW-v1.md) (SHA `70b8ad3bd705a15cbbc46edbd71b1b834d1da5828d35960d909dcb27fcff7715`) y [REVIEW-v1.json](/datos/tmp-atlas-lab/orquestacion-20261003/muse-tmux/r0-placebo-prospective-v1/REVIEW-v1.json) (SHA `8de00f464652eab6c8511405803fb465d5f95579ca2cfb2c84b168d34267aa04`). Cubre observación del punto de decisión, definición de flip y casos `UNKNOWN`; no implica ejecución ni aceptación científica.

## Trabajo reservado

La autora secundaria Sol será propietaria de la instrumentación copiada y pasiva futura, incluidos hooks/observer y sus DTO/tests en el alcance que autorice ROOT. Este worktree solo contiene este checkpoint editorial.

La observación prevista se acopla al `choose(world, person)` original de `src/world/index.ts:426` y su commit de acción/target/razón/`decisionAt` alrededor de las líneas 834–859, sin recalcular ni llamar a `choose()` otra vez. Se prohíbe cambiar física, PRNG, orden de iteración, leyes, thresholds, PLACEBO/intervención de 1 ULP, evaluador o protocolo 9/36/60. El observador debe copiar el dato después de la decisión existente; no debe influir en ella.

Un resultado solo podrá ser `NO_FLIP` en una ventana completa y preregistrada con continuidad de pares CTRL/PLAC. Si hay decisión unilateral, censura, falta de campo, corte o día/ventana incompletos, se conserva `UNKNOWN`; una fila ausente no significa ausencia del fenómeno. Diferencias numéricas/metadatos sin cambio de `(action,target)` no cuentan como flip. La aceptación científica sigue siendo falsa salvo decisión y evidencia separadas.

No se modifica aquí el contrato ni se inicia prueba, campaña, build o simulación. La primera observación prospectiva requiere preregistro sellado antes de los datos y la autorización correspondiente.
