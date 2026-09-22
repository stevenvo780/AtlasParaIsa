# Corrección de la revisión independiente del codec: frontera de recuperación

Base de la revisión: `cc83409`, conservada en un worktree congelado. El fix de
números requeridos (`d27b8be`) es independiente; esta corrección parte de él.
No cambia las leyes, parámetros por defecto ni cadencias del mundo.

La revisión detectó que `previous()` trataba cualquier excepción al verificar un
slot como permiso para intentar otro. También detectó que un trigger al revocar
sesiones podía reemplazar el cuerpo y checksum por otro mundo válido con
`agua.cuencas=0.7`, aunque el elegido tenía 0.8. Otro trigger borraba la crónica:
la carga posterior al COMMIT detectaba el daño, pero la copia ya estaba modificada.

La reparación separa lectura/decodificación de la validación histórica. Los
incumplimientos conocidos del codec y de sus parámetros tienen un tipo explícito
(`SnapshotSemanticError`), diferente del daño físico. Sólo esos dos tipos
autorizan saltar los bytes de un candidato en recuperación explícita. Los errores
del reader/lookup —incluido `Error` ordinario sin `code`— se propagan intactos, sin
visitar slot 2 ni crear un destino. No se clasifican mensajes mediante regex.

Después de decodificar, los validadores históricos de mundo/archivo todavía
informan rechazos mediante `Error` ordinario; esa compatibilidad se conserva de
forma explícita. Las subclases inesperadas de JavaScript y los errores Node/SQLite
con `code` se propagan también en esa etapa. No se afirma que todos los
validadores históricos hayan adquirido errores tipados.

La copia ahora compara, después de TODAS las escrituras —incluidas revocación y
GC—, cuerpo, digest y fecha contra el snapshot exactamente emitido. Un segundo
mundo válido con un checksum correcto no cumple esa identidad. Luego carga y
valida el mundo y sus archivos con la transacción todavía abierta, y comprueba
que el archivo no retenga datos posteriores al checkpoint. Sólo entonces ejecuta
COMMIT. Un rechazo revierte todas las tablas de la copia; el origen no se escribe.

Evidencia nueva: **7 negativos rojos y 4 controles verdes** contra la primera
implementación, más **1 rojo** para el `Error` ordinario del lookup contra la
primera reparación. Resultado final: **12/12 nuevos**, **285/285 focales**, cero
omitidos, typecheck y build verdes. Se conservan controles positivos de ambos
formatos, recuperación del mundo exacto y fallback explícito ante checksum roto
o parámetros inválidos conocidos. Las pruebas revisan todas las tablas de origen
y copia, cierran/reabren SQLite y verifican el digesto completo.

```sh
npm run typecheck
node --import tsx --test --test-concurrency=2 tests/snapshot*.test.ts tests/store*.test.ts tests/archive.test.ts tests/backup-cli.test.ts tests/chronicle-store.test.ts tests/technology-store-review.test.ts tests/recovery*.test.ts tests/migration-params-v1.test.ts
npm run build
```

Logs en `/tmp/atlas-snapshot-phase3-review/`: `recovery-boundary-baseline.tap`,
`recovery-boundary-ordinary-error-red.tap`, `recovery-boundary-final.tap`,
`recovery-typecheck.log`, `recovery-build.log`. La revisión independiente original
conserva además `adversarial-review.test.ts` y sus fixtures bajo esa misma raíz.
La integración corre la suite completa conjunta; no se publicó esta rama ni se
afirma cerrar T100 o su roundtrip de dos millones de teselas.
