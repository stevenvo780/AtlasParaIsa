# T100 revisión R1: versión semántica antes de resolver páginas

El lector segmentado podía encontrar una página ausente antes de comprobar que la
versión de reglas del manifiesto era desconocida. Store.load interpretaba ese fallo
físico y adoptaba otro slot. La revisión independiente reprodujo el mismo borde en
el padre de 4a: es un problema heredado, no una regresión introducida por los límites.

`readSnapshotLimits` ahora comprueba primero que la versión sea un entero entre 1 y
RULES_VERSION. Un manifiesto de reglas desconocidas falla con SnapshotSemanticError
antes de consultar páginas, tanto con perfil explícito como con representación legacy.
No se modifica el fallback permitido cuando sólo hay daño físico.

Antes: cuatro negativos rojos y dos controles verdes sobre 8106123. Después: seis
casos verdes, con tablas intactas y transacción cerrada. Los errores no formatean el
World ni el contenido completo de las tablas. `npm run typecheck` y el focal de
snapshots/recuperación están verdes; logs en `/tmp/atlas-t100-preflight/limits-r1-*`.
El hardware no puede cambiar este resultado.
