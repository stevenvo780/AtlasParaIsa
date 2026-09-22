# T100 revisión R3: modo de admisión histórico explícito

La revisión independiente creó con el binario anterior snapshots válidos cuyos límites
reservados T102 eran menores que el mundo. 4a rechazaba después esos archivos porque
activaba inmediatamente los números. La raíz fijó el contrato de compatibilidad antes
del parche: conservar los cuatro números, declarar su aplicación y cubrirla con el digesto.

Se incorpora el parámetro tipado `limites.aplicacion`, con valores `historicos` y
`parametros`. El motor nuevo usa por defecto `parametros`. Una instantánea anterior
sin perfil y sin modo se lee como `historicos`: los guards efectivos son los antiguos,
pero permanecen intactos sus cuatro números reservados y todos los demás parámetros.
La opción explícita `parametros` permite aplicar esos números posteriormente.

La marca forma parte de WorldParams y del digesto completo existente. No se añadió
un campo oculto a World ni un WeakMap de excepciones. **El digesto anterior cambia
por esta clave nueva declarada**; no se ha eliminado ninguna ley del control para
presentar una falsa igualdad. El roundtrip dentro del formato nuevo sí exige el digesto
completo exacto. Los valores efectivos se derivan únicamente del modo y los números.

Los snapshots nuevos de reglas 9 llevan params completos y perfil v2, incluso con
defaults. El perfil incluye el modo y los cuatro valores efectivos. Contradicciones,
perfil v2 sin marca y marca sin perfil fallan cerrado. El perfil v1 experimental sigue
leyéndose como `parametros`; al retirar sus metadatos se conserva esa interpretación.
Para formatos de reglas anteriores el encoder conserva la representación histórica de
params sin la clave que no podían expresar: sus números y bytes ordinarios no cambian.

V9 no puede distinguir un legacy auténtico de un documento al que se hayan borrado
**ambas** marcas; aplica guards históricos. No se promete detectar ese caso. La futura
ley 10 deberá exigir la pareja de marcas explícitas. Los gates de fundación y natalidad
de reglas 9 permanecen intactos; esta corrección no activa defaults ambientales.

## Pruebas y alcance

- Tests escritos antes del parche: **35 casos, 13 rojos y 22 controles verdes**.
  Cuatro controles validan con reglas 8 las fixtures de límites bajos que representan
  configuraciones históricas admisibles. Registro `limites-legacy-mode-baseline.tap`.
- Después: **35/35 verdes**, incluyendo los cuatro límites reservados a 1, transporte
  inline/segmentado y la cadena load → step → save → cierre → reapertura. Se conservan
  agua personalizada, arrays ordenados y `-0`; las lecturas de RAM/heap/cgroup se sustituyen
  por funciones que lanzarían si se invocaran. Se comparan todas las tablas ante corrupción.
- Conjunto focal: **413/413, cero skips**, 18,04 s, y typecheck verde. Incluye los guards
  R1/R2, límites, snapshots, Store, archivos, params, fauna, recuperación y migración V1.
  Registros en `/tmp/atlas-t100-preflight/limits-r3-*`.

Se actualizan los controles de representación para exigir params y perfil v2 explícitos;
no se suprimen los controles de finitud, números exactos ni orden enumerable. Los tests
del codec extraen sus params antes de comparar el World, como ya exige Store.

No se ha ejecutado aquí una suite completa ni una nueva prueba de dos millones.
El piloto previo permanece identificado como exploratorio, sin deadline/guard de disco
completo, y no cierra T100. Faltan el resolver host, la admisión al activar/materializar,
la ley conductual y el gate grande aislado. **El hardware no cambia esta corrección:**
load, migración, step y save usan sólo parámetros y modo persistidos.
