# T118: Laboratorio consciente del hardware

Worktree: `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/t118-lab-hardware` · Rama: `sprint/t118-lab-hardware-20261119`.

## Ficheros tocados

- `scripts/lab/replica.ts`
- `scripts/lab/barrido.ts`
- `scripts/lab/resumen.ts`
- `scripts/lab/README.md`
- `tests/lab-hardware.test.ts` (nuevo)
- `specs/002-mundo-ilimitado/informes/T118-report.md` (nuevo)

## Qué cambió y por qué

1. **`scripts/lab/replica.ts`**:
   - Acepta las banderas opcionales `--hilos <N>`, `--gpu <lista>` (p. ej. `[]`, `[0]`, `[0,1]`) y `--orden <natural|inverso|adversarial>`, aplicándolas sobre `params.motor.{hilos, gpu, orden}` y validándolas íntegramente con `parseParams` (`src/world/params.ts`).
   - Mide las 13 fases del paso (`FaseNombre`, T107) mediante `FaseMedicion` en `stepWorld` y el tiempo de `store.save` dentro del bucle de simulación.
   - Registra en `replica.json` (nivel raíz, sin añadir claves a `dia-NNN.json` ni a `replica.json.resumen`, preservando intactos los contratos de `tests/lab.test.ts` y `tests/instrumentos-lab.test.ts`):
     - `teselasActivas` (`world.tiles.length`),
     - `teselasPorHabitante` (`world.tiles.length / Math.max(1, world.people.length)`),
     - `fases` (ms medios por paso en cada una de las 13 fases),
     - `fraccionSerial` (`fraccionSerial(fases)` ∈ `[0, 1]`).
   - Calcula `digestoMundoFinal` con `digestoCanonico(world)` normalizando únicamente las opciones de backend de hardware (`motor.hilos`, `motor.gpu`, `motor.orden`) a sus valores por defecto durante el cálculo del hash, de modo que dos backends distintos produzcan exactamente el mismo `digestoMundoFinal` cuando el estado del mundo y las leyes materiales coinciden bit a bit.

2. **`scripts/lab/barrido.ts`**:
   - Acepta `--hilos`, `--gpu` y `--orden` en la CLI, los valida con `parseParams` antes de crear el directorio de salida, los reenvía a cada proceso hijo de `replica.ts` y los conserva en el marcador de réplica abortada (`writeAbortedMarker`), manteniendo intacto el soporte existente de `--param motor.hilos=1,2`, `--param "motor.gpu=[], [0], [0,1]"`, etc.

3. **`scripts/lab/resumen.ts`**:
   - Agrupa para la verificación de determinismo las réplicas que comparten `seed`, `digest`, `metricasVersion` y parámetros de mundo no asociados al backend de hardware (excluyendo `motor.hilos`, `motor.gpu` y `motor.orden`).
   - Compara tanto las series diarias como `digestoMundoFinal` entre backends: si todas las réplicas de cada semilla coinciden, publica `determinismo.semaforo = "🟢"` y `determinismo.estado = "🟢 DETERMINISTA"` (con el desglose en `determinismo.comparacionesBackend`); si alguna diverge, publica `determinismo.semaforo = "🔴"` y `determinismo.estado = "🔴 ROTO"` nombrando los backends y réplicas divergentes, marca en rojo (`🔴`) todos los grupos implicados y sale con código `1`.
   - Agrega `teselasActivas`, `teselasPorHabitante`, `p95Ms` y `fraccionSerial` por grupo y backend en `curvaTeselas` (`resumen.json`) y añade la sección `## Curva p95(teselasActivas) y hardware` en `resumen.md`.

## Cómo se prueba

```bash
npm run typecheck
npx tsx --test tests/lab-hardware.test.ts tests/lab.test.ts tests/lab-resumen.test.ts tests/lab-barrido.test.ts tests/instrumentos-lab.test.ts
```

- `tests/lab-hardware.test.ts`:
  1. Verifica que `replica.ts` acepta `--hilos`, `--gpu`, `--orden`, registra `teselasActivas`, `teselasPorHabitante`, `fases` y `fraccionSerial` en `replica.json`, y que `--hilos 1` (así como `--hilos 4 --gpu [0,1] --orden adversarial`) produce exactamente el mismo `digestoMundoFinal`, `dia-001.json` y `resumen` (salvo tiempos) que sin banderas.
  2. Verifica que `replica.ts` y `barrido.ts` rechazan valores fuera de rango o mal formados en `--hilos`, `--gpu` y `--orden`, y que `barrido.ts` reenvía las tres banderas a cada réplica.
  3. Ejecuta un barrido real de 2 réplicas × 2 backends (`motor.hilos=1,2`) y comprueba que produce `🟢 DETERMINISTA` y la tabla/curva `p95(teselasActivas)` / `teselasPorHabitante`, y que al inyectar una rotura sintética de `digestoMundoFinal` en uno de los backends `resumen.ts` la detecta como `🔴 ROTO` con código de salida `1`.

## Cifras medidas (ANTES / DESPUÉS con control)

- **Control de paridad (`seed=51926`, 1 día = 2400 ticks, `persistencia.cadaTicks=300`)**:
  - **ANTES (sin banderas de hardware)** vs **DESPUÉS (`--hilos 1 --gpu [] --orden natural` y `--hilos 4 --gpu [0,1] --orden adversarial`)**:
    - `digestoMundoFinal`: idéntico bit a bit en las tres corridas.
    - `dia-001.json` y `replica.json.resumen` (sin campos de reloj): idénticos campo a campo.
    - `teselasActivas`: `2304`, `teselasPorHabitante`: `100.17` (`2304 / 23` habitantes finales).
- **Suites verificadas**:
  - `npm run typecheck`: 0 errores.
  - `tests/lab-hardware.test.ts` + `tests/lab.test.ts`: 9/9 verdes.
  - `tests/lab-resumen.test.ts` + `tests/lab-barrido.test.ts` + `tests/instrumentos-lab.test.ts`: 43/43 verdes.

## Invarianza respecto al hardware

**El hardware no puede cambiar el resultado del mundo con este cambio**: las banderas `--hilos`, `--gpu` y `--orden` sólo seleccionan la configuración de ejecución en `params.motor` y la instrumentación (`fases`, `fraccionSerial`, `teselasActivas`, `teselasPorHabitante`) es estrictamente de lectura fuera de las leyes del mundo, conservando bit a bit el `digestoCanonico` del estado simulado.
