# Continuación del barrido reservado de 30 días

Este instrumento recupera observaciones físicas de los timeouts terminales del lote `batch-2026-09-22T09-21-07-615Z`. Conserva la ley y el instrumento congelados de cada brazo. El resultado original permanece `timeout`; cada continuación tiene otro manifiesto, SQLite, deadline y resultado. No publica ni modifica datos del servidor.

## Contrato predeclarado

- Un único censo al preparar el manifiesto. Incluye sólo resultados `timeout` anteriores al corte, sin un escritor o descendiente identificado en ese censo. Excluye jobs activos, no observados, errores y éxitos completos, con motivos explícitos. No incorpora después las semillas que terminen durante la continuación.
- Cuatro workers, un intento por job, deadline de seis horas que incluye copia, carga, pasos y cierre. Horizonte absoluto 72000 ticks; guardar cada 20; hasta 2400 pasos por segmento diario. Ninguna parada anticipada por extinción ni rescate de recursos.
- Hasta 256 GiB nuevos y reserva libre de 64 GiB, comprobados antes de admisiones y entre días; no es una cuota de filesystem y puede haber crecimiento dentro del segmento activo. No elimina originales ni evidencia para ganar espacio.
- Fuentes baseline V6 y candidata V7 del lote congelado; mismo `metrics.ts` y `coherence.ts`, verificados por hashes. Sin `createApp`, gobernador, scheduler, clientes o red. El SHA de origen de una fuente dirty es procedencia; los hashes identifican sus bytes.
- Dependencias locales existentes; no instalaciones. Congela el driver completo en el directorio del intento y firma manifiesto/driver por SHA-256. La fuente del motor nunca se edita.

## Admisión

La copia completa usa SQLite readonly `VACUUM INTO ?`, con rutas parametrizadas. Se preserva una copia inmutable privada y otra de trabajo. Se exige `quick_check`, checksum y tick del slot0, misma semilla, reglas y parámetros, ninguna adopción de slots anteriores ni normalización del mundo al cargar. Se compara el estado residente y los parámetros antes/después de `Store.load`; todos los arrays conservan su orden. Un fallo deja evidencia y `admission_error`, sin fallback.

Los archivos de terreno dormido, tecnología, crónica y fallecidos viajan en la base entera. No basta copiar el JSON del mundo. Se restauran sus lectores con el contexto de Store. El proceso nuevo reinicia cachés y calendarios de validación/backups: no se promete SQLite binariamente idéntico. La prueba previa verificó equivalencia física, archivos lógicos y métricas al reiniciar, incluyendo un proceso nuevo y la rotación divergente del slot2.

Los diarios originales se copian una vez con checksum. Un hueco histórico anterior al checkpoint impide una serie completa; sólo puede reconstruirse el diario omitido cuyo límite coincide exactamente con el checkpoint. Nunca se obtiene población pasada extrapolando desde habitantes finales.

## Métricas y comparación

La primera ventana continúa hasta el siguiente múltiplo absoluto de 2400. La actividad SQL siempre consulta desde el inicio exclusivo de ese día: el prefijo vive en la copia y el sufijo se agrega al continuar. No sumar métricas previamente agregadas ni empezar la consulta en el checkpoint. Contadores acumulados se leen una vez al final de cada día.

El instrumento físico original conserva `metricasVersion: 2`; el sobre nuevo declara `continuationSchema: 1`. Los campos de tiempos heredados son `null`. El primer día partido no tiene bloque de tiempos; los días nuevos completos pueden registrar observaciones operativas separadas. Ningún tiempo de estos procesos concurrentes certifica rendimiento del servidor ni se combina con tiempos históricos. `reproductionPausedTicks=0` requiere el motor sin gobernador y la bandera habilitada antes y durante todo tramo.

`strata/*.json` y `strata-total.json` separan usos/beneficio por actor **mortal, S, I y desconocido**, y además cruzan actor con inventor. El roster combina personas vivas con `legacy`, por lo que incluye actores muertos al final y comprueba sus límites de vida. La transmisión docente→aprendiz se informa por dos vistas distintas: episodio de aprendizaje de receta y cooperación de enseñar. No se suman esas vistas ni se atribuye beneficio causal a un episodio.

La comparación usa parejas de la misma semilla y el mismo límite diario. Si falta un brazo, no forma par. El horizonte final exige finalización certificada en ambos brazos. Estratificación ausente queda `null`. Incluye todos los estados originales y nuevos, semillas pendientes y advertencia del sesgo de completitud/extinción; nunca transforma timeout en extinción o éxito.

## Ejecución

Desde el worktree dedicado, después de `npm run typecheck` y el test focal:

```sh
node --import tsx scripts/lab/continuation-audit/runner.ts prepare /ruta/lote-original/batch.json /ruta/worktree/artifacts/continuation/intento-nuevo
node --import /ruta/worktree/node_modules/tsx/dist/loader.mjs /ruta/intento-nuevo/driver/runner.ts run /ruta/intento-nuevo/manifest.json
```

Preparar no ejecuta simulación. El comando `run` rechaza un manifiesto iniciado anteriormente y nunca sobrescribe otro intento. El piloto usa explícitamente modo `control`, dos fixtures previos de semilla51926 y un horizonte de un día; ese modo no cambia el contrato de producción.

Cada worker tiene un grupo/sesión propios. Timeout o señal del runner envían TERM, esperan una gracia acotada y después KILL. Se comprueba el grupo incluso si el líder ya murió y se conserva su identidad contra reutilización. Un descendiente inesperado impide declarar éxito. Nunca se señalan procesos originales ni ajenos. Hay deadlines finitos; no se instala polling del lote anterior.

Archivos operativos: `started.json` contiene el PID del runner; `results/*.running.json`, los workers; `results/*.json`, resultado y tick durable; `attempts/*/progress.json`, último día completo; `finished.json`, cierre; `comparison.json`, pares físicos. Ante timeout, el estado final lo define `results/<id>.json`, aunque `attempt.json` conserve su última fase antes de la señal. Los logs son privados y el entorno de workers no hereda credenciales.

La revisión independiente añadió una defensa final: después de salir el worker, el
runner exige checksum válido, horizonte durable, semilla, reglas y parámetros de la
admisión; una discrepancia impide el estado de éxito. El intento ya congelado
`reserved-2026-09-22T11-35-53Z` usa driver
`c4ad3becceb5f1927834a8ee9db69d0cda8a48ac201e1a8a8f666c9e4118ec04`
y no contiene esta defensa. No se modifican sus bytes ni procesos: antes de usar sus
resultados como cierres certificados se debe auditar adicionalmente cada checkpoint
final con las mismas condiciones. Se admitieron 34 timeouts, se conservaron 24
completos originales y se excluyeron seis activos en ese único corte.

Validación focal: copia SQLite real con WAL y apóstrofe, rechazo de checkpoint corrupto/retroceso/cambio, huecos diarios, actor muerto versus inventor y S/I, proceso resistente a TERM, descendiente resistente tras salida del líder, fallo al registrar un proceso recién creado, y trayectoria real recargada frente a ininterrumpida. Ninguno de esos controles prueba supervivencia a treinta días ni equivalencia universal: cada checkpoint requiere admisión individual.

Integración `5954616`: **8/8 controles focales sin omisiones**, typecheck y
build/smoke del commit exacto verdes. Se añadió después del gate de 946 pruebas de
persistencia, sin cambios nuevos en `src/`; no se presenta como una nueva suite
completa de 954 pruebas. [Registro](../evidencia-2026-09-22/continuation-integration-gate.json).
