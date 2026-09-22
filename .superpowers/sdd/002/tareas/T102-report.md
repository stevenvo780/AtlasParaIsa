# T102: configuración tipada, todavía inactiva

Base: `3dd615ee069d9d61f51a4c74f85d33c15a4583e0` (V7). Worktree:
`/datos/workspaces/personal/AtlasParaIsa-params-a0-20260922`, rama `sprint/params-a0-20260922`.
Codex nativo ejecutó el trabajo como fallback autorizado: Claude/cloud-offload no estaba
disponible. Un subagente nativo implementó laboratorio y revisó parser/controles; no se atribuye
la ejecución al Sonnet indicado originalmente por el plan. El preflight de Spec Kit pasó,
sin extensiones, checklists, data-model ni contratos adicionales.

## Cambio y alcance

- `src/world/params.ts`: booleanos, enum, arrays y enteros del motor/límites; descriptores tipados
  separados de las tuplas numéricas existentes. Defaults deterministas. Arrays propios,
  congelados, sin duplicados ni ordenación implícita. Sólo `p95` como señal; lista vacía rechazada.
- `src/shared/param-syntax.ts` y `scripts/lab/barrido.ts`: comas externas a JSON, manteniendo
  sweeps numéricos y producto cartesiano. `[0,1]` representa una configuración con dos dispositivos, no dos jobs.
- `tests/params.test.ts`, `tests/params-instantanea.test.ts`, `tests/lab-barrido.test.ts`:
  negativos, precedencia, arrays, recarga y compatibilidad con snapshots anteriores.
- `scripts/verify-params-baseline.ts`: control físico reproducible frente a un árbol base;
  `docs/REGLAS.md`: sintaxis, defaults y límites de la capacidad activa.

Ningún consumidor selecciona estos flags todavía. No se activan GPU, workers, deltas o páginas
sucias ni se levantan topes. El parche aislado no cambia T100, leyes materiales, versión 7,
Store ni `digestoCanonico`; la integración incorpora por separado familia V8 y dos correcciones
de validación. El hardware no puede cambiar el resultado de T102: no se consulta CPU, RAM ni
inventario GPU para resolver defaults o validar el parser.

Se preservan las formas numéricas válidas históricas (incluidas notación científica y bases
aceptadas por `Number`); se eliminan coerciones accidentales de arrays/BigInt/objetos a número.
La revisión encontró que `Array.from(array)` podía obedecer un iterador personalizado y saltarse
valores inválidos. La copia ahora recorre índices; el negativo comprueba ese caso. Otro negativo
garantiza que un objeto rechazado no ejecute su conversor para formar el mensaje de error.

## Evidencia

- `npm run typecheck`: verde.
- `node --import tsx --test tests/params.test.ts tests/params-instantanea.test.ts tests/lab-barrido.test.ts`:
  **45/45**, cero fallos/omisiones, 23,241 s. Log: `/tmp/atlas-t102-focal-20260922.tap`.
- Barrido: 24 combinaciones tipadas, rechazo sintáctico antes de crear salida y marcadores de
  réplicas fallidas con los mismos parámetros normalizados; pruebas V7 de timeout intactas.
- Snapshot: flags/arrays/enum sobreviven a otra conexión SQLite, clon y overrides; recodificar
  el snapshot tipado produce los mismos bytes. Un snapshot `params-v1` anterior completa campos
  nuevos conservando sus overrides. Parámetros corruptos fallan aunque se recalcule el checksum.
- Control físico: semillas **1, 51926, 20260905**, cada una con defaults y opciones reservadas,
  **1200 ticks** por trayectoria, guardado cada 20, recargas en 600/1200 y clon descartado cada 120.
  Las seis trayectorias coinciden con V7 en estado completo residente, journals pendientes,
  bits numéricos, `undefined`, orden y aliases. El digesto completo conserva la configuración y
  cambia; el control físico está separado explícitamente. Resultado y hashes de fuentes:
  `docs/evidencia-2026-09-22/t102-params-baseline.json`.
- Los 69 hashes de fuentes del baseline fueron contrastados contra `git show 3dd615e:src/...`.
  El script comprueba antes/después que sólo difieren `world/params.ts` y `shared/param-syntax.ts`.
- `git diff --check`: verde.

Primer ensayo descartado: `v8.serialize` codificó el mismo cero como entero o double según la
representación interna de V8. `assert.deepEqual` del mundo era igual; los bytes de ese serializador
no eran canónicos. El control definitivo codifica cada número como sus ocho bytes IEEE-754 y
declara orden/referencias, sin alterar el digesto de producción.

Reproducir desde el worktree aislado T102, no desde la integración V8 (el control exige
que sólo difieran sus dos módulos; el temporal no contiene datos públicos):

```bash
baseline_dir="$(mktemp -d /tmp/atlas-t102-baseline.XXXXXX)"
git archive 3dd615ee069d9d61f51a4c74f85d33c15a4583e0 src package.json | tar -x -C "$baseline_dir"
ln -s "$(pwd)/node_modules" "$baseline_dir/node_modules"
node --import tsx scripts/verify-params-baseline.ts "$baseline_dir" 1200
```

## Entrega original y cierre conjunto

Por coordinación explícita, se entrega parche sin commit. La suite completa redundante se
interrumpió para no superponerla con el gate V8 y las réplicas: su log
`/tmp/atlas-t102-full-20260922.tap` **no acredita una suite completa**. Sólo se terminó su grupo
propio verificado 1031258; no se tocaron family, el batch ni producción. El gate completo se
ejecutó después de integrar con el arreglo independiente de validación de parámetros de Store.
El resultado conjunto fue **939/939, cero fallos/omisiones**, 501.707 s, con CUDA disponible;
typecheck, build, 18/18 E2E y smoke verdes. T102 queda cerrado; T100 y Gate A0 siguen abiertos.
La integración añade seis comparaciones físicas de 1200 ticks contra familia V8 y compara
las diez tablas durables salvo snapshots. Véase `docs/REVISION-INTEGRACION-A0-2026-09-22.md`.
La separación posterior de los tres cambios técnicos sobre V7 (`6c9e88c`) pasa
923/923 tests sin omisiones, typecheck, build/smoke exactos y seis comparaciones adicionales
contra `6ddadaf`, con el mismo alcance de estado y tablas.

El control físico recarga con la misma conexión y no compara filas del archivo SQLite externo.
La prueba de parámetros abre otra conexión; no se ensayó un reinicio completo del proceso del
servidor en este frente. No se midió ganancia de rendimiento ni se activó aceleración. No hay
publicación, cambios de reglas, datos públicos o credenciales en el parche.

La revisión independiente detectó un límite previo: JSON convierte `-0` en `0`, también
en parámetros numéricos. Los controles anteriores no prueban preservación universal de
bits a través de snapshots. Se registra para persistencia/T100; no se debilita el digesto.
