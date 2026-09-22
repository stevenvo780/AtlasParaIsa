# T100 revisión R2: rechazar cantidades antes de crear tuplas

La llamada inline evaluaba `encodeSnapshotTileRows(world.tiles)` antes de entrar en
`snapshotRecord`, por el orden normal de evaluación de argumentos de JavaScript.
Por tanto creaba tuplas incluso cuando el conteo de una colección ya era inválido.

El encoder prepara y valida primero el record, y sólo después asigna sus tuplas a
la propiedad tiles ya existente. No borra/reinserta la clave ni cambia el serializer
de números, opcionales o metadatos.

Cuatro getters sentinela dieron el error de expansión antes del parche. Después
no se leen cuando teselas/chunks/comunidades/fauna exceden el límite. Un quinto
control con cantidades válidas prueba que el getter sí se lee y que su RangeError
inesperado se propaga por identidad. Typecheck y 109 focales de límites, números,
campos requeridos, orden enumerable y snapshot están verdes; registros en
`/tmp/atlas-t100-preflight/limits-r2-*`. El hardware no cambia el resultado.
