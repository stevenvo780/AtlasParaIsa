# T100: claves propias de límites en la API directa

La revisión independiente de `7badc75` encontró que el conteo de claves
enumerables permitía compensar un modo heredado con una clave desconocida. El
parser de entrada JSON rechazaba esa clave, pero `setParams` aceptaba el objeto
directo y el guardado inline podía confirmar un snapshot que luego no cargaba.

`assertWorldLimits` exige ahora el conjunto exacto de claves propias (incluidos
símbolos y propiedades no enumerables) y que cada campo obligatorio sea propio
enumerable. Así también rechaza un campo obligatorio que JSON omitiría. No se
restringe el prototipo del objeto válido ni cambian números, modos o física.

El negativo reproducible es `tests/limites-own-properties.test.ts`: 17 casos,
9 rojos y 8 controles verdes antes; 17 verdes después. Cubre modo heredado,
campos obligatorios no enumerables, extras no enumerables/símbolos, rechazo de
`setParams` sin cambiar la asociación y guardados calientes en ambos formatos
sin modificar ninguna tabla ni las colas. Los positivos usan prototipos Object
y null. El conjunto focal de persistencia y parámetros pasó 430/430, sin skips;
`npm run typecheck` y `git diff --check` pasaron. No se ejecutó otra suite completa
ni el ensayo de dos millones durante esta corrección; los coordina integración.
