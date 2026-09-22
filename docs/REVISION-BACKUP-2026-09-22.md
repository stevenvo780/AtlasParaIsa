# Copias verificadas después de VACUUM

Los commits `5b7ba24` y `efed3c7` cierran dos huecos de `npm run backup`
(`scripts/storage.ts`).
La lectura previa sólo verificaba una versión anterior de la fuente: un escritor
podía confirmar después otro mundo, inválido aunque SQLite fuese consistente,
y VACUUM copiarlo antes de que el CLI anunciase éxito. Ahora se abre la copia con
un Store nuevo y readonly, y se valida antes de anunciarla como coherente.

La revisión independiente encontró además archivos diferidos que `Store.load()`
no visita: regiones dormidas e identidades fuera de la caché residente. El CLI
recorre todas sus claves y versiones retenidas mediante `loadChunk` y `loadLegacy`,
dentro de la misma transacción de lectura que el mundo. Rechaza checksums, cuerpos,
claves o fechas inválidas. Itera registros sin materializar otro archivo completo.
Los esquemas antiguos que carecen de esas tablas siguen siendo legibles y no se
migran. Una copia rechazada queda preservada con permisos0600; no se reescribe ni
se anuncia como válida.

## Evidencia

- El control de carrera confirma una escritura después del preload y antes de
  VACUUM; el cuerpo conserva checksum válido y falla su ley. Antes daba éxito;
  ahora sale1 en formatos compacto y paginado. Una base sin mundo también falla.
- Doce controles adicionales: dos copias válidas con WAL vivo, y diez negativos
  de checksum/semántica de chunks e identidades, incluida una versión vieja de
  un chunk cuyo registro más reciente sigue sano. Los diez daban éxito con
  `5b7ba24` y fallan cerrado con `efed3c7`. Todos conservan bytes fuente/WAL/copia.
  SQLite quick_check sigue dando ok: no sustituye estas comprobaciones.
- Focales **18/18**; typecheck verde. Suite completa de `efed3c7`:
  **1170/1170, cero fallos y cero omisiones**,166,563s. Cgroup12GiB sin swap,
  heap4GiB, concurrencia8 y NVRTC explícito para ambas GPU.
- Build y smoke del SHA exacto pasan en un worktree aislado; no se construyó ni
  reinició el servidor público. [Ejecuciones](evidencia-2026-09-22/backup-copy-gates.json).
- Revisión independiente final: **22/22**, sin omisiones; incluye cuatro
  negativos propios de escritura posterior al preload y los18 controles del
  cambio. Los dos chunks dormidos que seguían dando éxito ahora se rechazan.

El primer intento de los controles nuevos usó un nombre incorrecto del parámetro
de ventana y no llegó a ejercitar la copia; se conserva aparte. Tras corregir el
instrumento se observaron los diez rojos descritos. Otro lanzamiento rechazó una
opción de concurrencia dentro de NODE_OPTIONS; la suite efectiva la recibió como
argumento del runner. Ninguno de esos intentos se cuenta como verificación.

## Alcance

Se comprueba el mundo con los archivos que ya valida Store.load y cada registro
de las dos tablas diferidas indicadas. No se afirma una auditoría nueva de todas
las relaciones genealógicas históricas ni de toda tabla arbitraria que pueda
añadirse. No se cambian restore/previous, biología ni reglas de simulación. No hay
medición de duración del backup a escala2M, prueba de corte eléctrico, Chromium
nuevo ni publicación de este build.
El respaldo horario `scripts/respaldo.sh` mantiene su comprobación SQLite
quick_check; esta entrega no le añade la verificación semántica del CLI.
