# Orden exacto de la raíz al recargar páginas

El gate de integración de3d1b644 detectó una diferencia que las1142 pruebas
existentes no ejercían: en el transporte paginado, eliminar `metadata.tiles` y
reinsertarlo al final cambiaba el orden enumerable de la raíz. El control acotado
reprodujo la diferencia en semilla1,tick120: `deepStrictEqual` pasaba, pero el
primer cambio de orden era la clave raíz7, `people` en vez de `tiles`. Ambos
buffers tenían1901206 bytes. Al ordenar sólo el contenedor raíz como la referencia,
conservando todos los hijos y aliases, coincidían todos los bytes y el digesto
completo, incluidos parámetros. Ese diagnóstico conservó exit1.

La primera aserción no acotada fue terminada por el kernel el22 de septiembre a
las12:30:55UTC, PID1700738, con116224908KiB de RSS anónimo. El formateo del diff
grande es la hipótesis consistente con la reproducción; no existe perfil de heap
del proceso muerto para atribuir cada reserva. El verificador sustituto informa
primera ruta, hashes y tamaños sin imprimir el mundo; usa heap4GiB y cgroup6GiB
sin swap. El piloto fallido alcanzó208924KiB de RSS. El servidor público se
comprobó activo, sin reinicios y con health correcto después del incidente.

La reparación conserva `world.tiles:null` como marcador de posición dentro del
manifest. Los valores de terreno siguen únicamente en las páginas. El lector
exige ese marcador propio exactamente null antes de reemplazarlo por el array;
el reemplazo conserva el orden original sin un índice redundante. El formato
paginado es experimental y aún no estaba publicado. Las instantáneas compactas
históricas mantienen sus bytes y sus lectores.

Ocho negativos previos fallaban. Tras la reparación pasan ocho combinaciones de
orden raíz original/tiles primero/tiles último/inverso y parámetros default o
personalizados; comparan contra el codec compacto incluyendo `-0`. Cada una
rechaza marcador ausente, array, booleano y número. La selección de169 pruebas
incluye las65 de páginas,12 de recuperación,84 de números finitos y8 nuevas:
**169 pass,0 fail,0 skip**,9,107s. Typecheck verde. La paridad larga y la suite
conjunta posterior se documentan en el gate de integración; estas focales por sí
solas no cierran T100 ni prueban dos millones de teselas.

Artefactos originales conservados en `/tmp/atlas-t100-integration-parity*` y
`/tmp/atlas-snapshot-parts-order-{red,focal,typecheck}.log`. La revisión independiente
acotada se conserva en `/tmp/atlas-t100-integration-parity-bounded-review.md`.
