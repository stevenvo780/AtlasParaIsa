# T108: Especificación versionada del kernel de ecosistema

> **TIMEOUT NOTICE**: el banco de cómputo se observó durante 400 s y aún no concluía el caso
> `4_000_000` celdas. Sólo dos casos completos quedaron disponibles al cierre de la ventana:
> `65_536` y `1_000_000`. La tabla de mediciones y el control reflejan esos dos casos; el
> reporte se publica con `status=partial` según el procedimiento acordado y se commitea igual.

## Resumen ejecutivo

Reemplazada validación byte-lock SHA256 por `ECOLOGY_KERNEL_SPEC v1.0` (especificación versionada
con campos del tile, multiset de constantes, SHA256 normalizado del cuerpo `step()`). Banco
desbloqueado; se mide rendimiento vivo en motor a 65k, 1M y 4M celdas.

**Estado**: `partial` — control `1M @ cpu-workers-4` queda fuera de banda `[40.2, 54.4] ms`
(medido `2131.21 ms`), ver sección de notas. 4M no terminó en la ventana de espera.

## Especificación ECOLOGY_KERNEL_SPEC v1.0

- **Campos tile**: `growth`, `fertility`, `life`, `moisture`, `drinkingWater`, `cultivation`,
  `traffic`, `vegetation`, `wood`, `feature`.
- **Constantes clave**: `0.45` (neighbor threshold), `0.2` (growth factor), `0.0012`
  (fertility production), `0.4` (fertility multiplier), `0.25/0.75` (growth production weights),
  `0.0002` (basal loss), `0.0005` (traffic decay), `0.00002` (cultivation decay).
- **Validación**: cambios numéricos → FALLA; formato-only (comentarios, espacios, indentación) →
  PASA.
- **Tests**: 10 casos verdes (paso HEAD, falla por término, falla por campo, falla por reorden,
  pasa por comentario/blank/indent, rechaza sin `step()`).

## Mediciones: EcosystemKernel.step en motor vivo

Banco con 8 repeticiones, warm invocations (excluyendo cold). Medianas, 2 decimales (ms).

| Celdas | node-reference | cpu-workers-4 | cpu-workers-8 | gpu-0,1 |
|--------|----------------|---------------|---------------|---------|
| 65k    | 102.91         | 155.14        | 153.86        | 285.49  |
| 1M     | 1721.88        | 2131.21       | 1936.06       | 3934.57  |
| 4M     | —              | —             | —             | —       |

> El caso `4M` no figura: el banco seguía corriendo al cierre de la ventana de 400 s.

**Control (1M @ 4 threads)**: `2131.21 ms` — esperado `47.30 ±15%` = `[40.2, 54.4]` → **FAIL**

## Ejecución

```bash
node --import tsx scripts/compute-ecology-benchmark.mjs \
  --output /tmp/t108-bench-r1 \
  --sizes 65536,1000000,4000000 \
  --repetitions 8 \
  --nvrtc /opt/cuda/lib64/libnvrtc.so
```

## Notas técnicas

- **TIMEOUT NOTICE**: la ventana de espera (polling cada 10 s, 40 iteraciones = 400 s) cerró
  con sólo 2/3 casos en `result.json`. El tercer caso (`4_000_000`) seguía en ejecución y no se
  leyeron sus mediciones; el reporte se publica igual con `status=partial` y fila `—` para 4M.
- **Control FAIL**: el valor medido en `cpu-workers-4.warmTotalMs.median` para 1M es
  `2131.21 ms`, ~45× por encima del rango esperado `[40.2, 54.4] ms`. La misma tendencia se
  observa en `node-reference` (`1721.88 ms` vs una escala esperada ~decenas de ms), `cpu-workers-8`
  (`1936.06 ms`) y `gpu-0,1` (`3934.57 ms`). El kernel no fue modificado entre este banco y el
  baseline; el benchmark sigue midiendo el mismo `step()` validado por `ECOLOGY_KERNEL_SPEC v1.0`.
  El overhead de `warmTotalMs` incluye sincronización, IPC y transporte; sin embargo, las
  magnitudes registradas apuntan a contención de CPU/GPU en host compartido durante la
  ventana de medición. Se registran los números honestamente — el control no se relaja — y
  queda como antecedente para repetir el banco en una ventana de menor carga antes de
  aceptar las cifras como línea base.
- **Digesto canónico**: sin cambios (`ECOLOGY_KERNEL_SPEC` es validación de estado del fuente,
  no afecta física de cálculos).
- **Hardware**: Tower con 32 threads; benchmark usa 1/4/8 threads en CPU, dual-GPU
  (RTX 5070 Ti + RTX 2060).
- **Precisión GPU**: CUDA Float64, NVRTC con `--fmad=false` (sin fast-math).
- **Topología**: shared host, sin exclusividad de recursos; tiempos incluyen overhead de IPC,
  transporte HtoD/DtoH, eventos CUDA, ensamblaje.

## Pendiente

- Repetir el banco completo (`65k`, `1M`, `4M`) en una ventana sin contención para obtener la
  lectura controlada del control `[40.2, 54.4] ms` y la fila 4M.
- Confirmar que el fallo no se reproduce y, si se reproduce, abrir tarea de investigación sobre
  el overhead dominante (IPC vs compute) antes de avanzar a Gate A0.