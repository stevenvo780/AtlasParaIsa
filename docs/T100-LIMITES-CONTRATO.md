# T100: límites persistidos — contrato previo a la implementación

Base: `3d1b6444a0f3ccce329c404902347c774f9070fe` (reglas 9), más la corrección
de orden de claves `b7b8583` integrada como `fb3691c`. Esta fase no cambia
la ley de familias, el gobernador, la cadencia de guardado ni los costes materiales.
Las fases anteriores resolvieron V1/errores semánticos, `-0` y transporte segmentado.

## 4a. Admisión y persistencia, sin nuevas conductas

### Corrección de contrato tras revisión R3 (antes del parche)

El perfil 4a inicial no conservaba la operabilidad de snapshots antiguos que declaraban
límites T102 inferiores a sus cantidades: esos números eran opciones inactivas y podían
ser válidos en el binario anterior. Se añade por decisión explícita de la raíz
`params.limites.aplicacion: 'historicos' | 'parametros'`, con default nuevo `parametros`.
Los cuatro números declarados nunca se reemplazan ni se acotan al migrar.

Un snapshot legacy sin perfil y sin marca se interpreta como `historicos`; sus límites
efectivos son los cuatro guards históricos, aunque sus números reservados sean menores.
Esto permite cargar, avanzar, guardar y volver a cargar sin activar esas opciones.
El modo `parametros` usa los cuatro números declarados. El modo es tipado, persistido
y automáticamente incluido en el digesto completo; no vive en un WeakMap oculto.

Los nuevos snapshots usan `limitsProfile` versión 2, con `aplicacion` y los cuatro
límites **efectivos**, además de params explícitos incluso para sus defaults. Se exige
la marca en params, el modo concordante y las cuatro cantidades efectivas correctas.
El perfil experimental v1 sigue leyéndose como `parametros`; nunca activa un mundo
histórico. Perfil v2 sin marca, marca sin perfil y contradicciones se rechazan antes
de resolver páginas. Borrar ambos puede ser indistinguible de un snapshot legacy
auténtico de reglas 9: se aplican guards históricos, sin prometer detectar ese caso.
La futura ley 10 deberá exigir el modo y el perfil en toda snapshot nueva de esa ley.

Esta clave cambia de forma declarada el digesto completo de parámetros. No se elimina
del control para fingir igualdad con el binario anterior. El contraste físico conserva
todas las leyes antiguas y comprueba por separado la marca esperada; los roundtrips del
nuevo binario siguen exigiendo digesto completo exacto. Los negativos y la cadena legacy
se escriben antes del parche en `tests/limites-legacy-mode.test.ts`.

Los cuatro valores declarados son `params.limites.{teselasActivas,chunks,comunidades,fauna}`.
Son enteros seguros positivos. Sus defaults del motor siguen siendo deterministas.
El modo `parametros` los aplica a validación; `historicos` conserva su declaración
sin activar opciones que T102 había aceptado como reservadas.

Todo snapshot nuevo de reglas 9 o posteriores lleva un perfil de transporte
`limitsProfile: {version: 2, aplicacion, teselasActivas, chunks, comunidades, fauna}`.
Sus claves son cerradas y sus cuatro valores deben coincidir con los límites efectivos;
un checksum correcto no convierte una contradicción en válida. El lector verifica
el perfil y las cantidades antes de expandir tuplas/páginas y elimina el perfil al
reconstruir World. No hay nueva ley oculta en un WeakMap: el digesto completo sigue
incluyendo los cuatro valores efectivos dentro de params.

Un snapshot sin perfil ni modo se admite con los límites históricos, aunque declare
valores T102 mayores o menores. V1 conserva además su geometría de 1120 celdas; las versiones anteriores
a 9 no pueden usar el perfil para ampliar sus límites. Primero se verifica el mundo
legacy y después se migra. Los parámetros existentes se conservan exactamente; no se
consulta hardware durante load, previous, migración ni validación de baselines.
Al guardar el mundo migrado se declara el modo histórico y su perfil explícito,
sin recalcular ni reemplazar los cuatro valores reservados.

Los contadores de admisión provienen del modo y los parámetros declarados. Los límites
históricos siguen disponibles para formatos anteriores y su continuidad explícita.
Se conserva por ahora el gate conductual de ocho comunidades y
el techo de reproducción animal de reglas 9: retirarlos requiere una fase separada.
Los límites de 256 celdas por chunk y seis animales por celda son leyes estructurales,
no techos globales que deban elevarse.

Pruebas mínimas: 65792 celdas/257 chunks; doce comunidades; cantidades exactas y una
unidad por encima para cada límite; perfiles ausentes, desconocidos, parciales,
contradictorios o no finitos; legado con params amplios no elude sus límites; archivos
SQLite reabiertos y recuperación explícita con formatos inline y segmentado. Todo
rechazo deja tablas y colas intactas. La comparación durable parte del World confirmado
tras save, pues éste consume journals/chunks retirados; sus archivos se controlan aparte.

## 4b. Resolver de creación en el host

El servidor ejecuta una factory de parámetros sólo cuando Store.load no devuelve
mundo. El laboratorio resuelve sus parámetros antes de crear cada réplica. El motor
createWorld sigue independiente del host. RAM física, límite V8 y cgroup son entradas
del resolver del host; no se utiliza memoria libre fluctuante. Se reserva margen para
el proceso/host y se documenta la fórmula como límite de admisión, no garantía de RSS.
La precedencia es defaults deterministas → límites resueltos → overrides explícitos;
un override numéricamente igual al default sigue siendo explícito. El cargado aplica
sólo los overrides del operador existentes y nunca vuelve a resolver hardware.

Ownership host autorizado: `src/server/hardware-limits.ts`, `app.ts` (AppOptions y
creación lazy), `main.ts` (factory), `deployment-params.ts` si resulta necesario,
`scripts/lab/barrido.ts`/`replica.ts` y pruebas aisladas. La fórmula y la representación
del barrido se cerrarán con controles de precedencia antes de modificar estas rutas.

## 4c. Ley conductual y prueba grande

Reglas 10 se reservan para retirar el gate de ocho comunidades y el techo técnico de
nacimientos animales. El límite anticorrupción debe lanzar un error, nunca actuar como
política silenciosa de natalidad. Se mantienen madurez, coste, capacidad ecológica y
seis animales/celda. Los fallos de admisión que prometan atomicidad se prueban antes
de mutar. El laboratorio in-place debe marcar el run fallido y conservar su último
checkpoint, sin presentar un estado parcial como final válido.

La prueba grande estaba bloqueada hasta resolver el OOM del instrumento de paridad.
Tras corregir su salida de errores y el orden de claves del codec, la raíz autorizó
2.097.152 celdas / 8192 chunks, con MemoryMax=8 GiB, MemorySwapMax=0 y heap V8 de
6144 MiB. Writer y reader serán procesos separados y secuenciales; no se amplía el
presupuesto automáticamente ante un fallo. Tendrá cuerpos compactos
y de alta precisión, `-0`, cierre/reapertura en otro proceso, archivo externo y digesto
completo idénticos. Se registrarán heap configurado, RSS pico, bytes lógicos y tiempos;
no se cambiará el servicio público. La prueba de 65792 celdas no cierra este requisito.

El hardware sólo puede elegir parámetros al crear un mundo nuevo por una entrada host.
Una vez persistidos, los mismos parámetros y estado dan la misma ejecución con
independencia de la memoria de la máquina que los carga.

## 4b/4c ejecutados (2026-09-22, cierre de T100)

**Ley conductual.** El tope de fundación de `society.ts` deja de ser el literal `>= 8` y pasa
a leer `limitsOf(world).comunidades`. El default sigue siendo 8, así que todo mundo existente
y todo mundo nuevo con params por defecto reproduce HOY bit a bit: el digesto canónico de
`createWorld(seed)` es idéntico antes y después en las semillas 1, 7 y 51926 a 2400 pasos.
**Elevar `limites.comunidades` es un CAMBIO DE CONDUCTA declarado**, no una relajación de
validación: con 9 se funda una novena comunidad donde antes no se fundaba ninguna, y eso
altera pertenencia, cultura y el gate de reproducción (`reproduce` exige `communityId`).
Quien lo suba debe contrastarlo como cambio de reglas, no como admisión. Por eso el resolver
del host **no** deriva `comunidades` de la máquina: el hardware no decide conductas.
Reglas 10 siguen siendo el lugar para retirar el tope, no este commit.

**Techo de cría animal.** `reproduce` calcula su capacidad con `limitsOf(world).fauna` en vez de
`MAX_STORED_ANIMALS`. La constante sobrevive sólo como valor histórico de admisión (`assertAnimals`
por defecto, informe de `scripts/soak.ts`), ya derivada de `DEFAULT_PARAMS`, y no gobierna ninguna
ley. El `throw` de `stepAnimals` sigue siendo anticorrupción: la activación de un chunk puede
materializar fauna dormida, así que un límite por debajo de la fauna ya existente falla ruidoso.

**Resolver del host** (`src/server/hardware-limits.ts`). `presupuesto = min(RAM física, cgroup v2)
· 0,5`, acotado por `heap de V8 · 0,6`; de ahí regiones enteras a `1750 B` por tesela activa, y de
las regiones las teselas (`×256`) y la fauna (`×6`, ley estructural). `1750 B` es medida, no
estimación: la prueba de escala de 2 097 152 teselas / 8192 chunks dio RSS pico 3415 MiB
(1707 B/tesela) y 240 783 360 bytes en SQLite (115 B/tesela). Nunca por debajo de los defaults
de hoy. Es admisión, no garantía de RSS ni de latencia (eso lo gobierna el p95, ruling R17).
Se evalúa **sólo** al crear mundo nuevo: `AppOptions.params` acepta una función y `app.ts` la
llama únicamente en la rama `?? createWorld(...)`; `load`, `previous`, migración y validación de
respaldos jamás preguntan por la máquina. Precedencia: defaults deterministas → límites resueltos
→ overrides explícitos de `deploymentParams` (`CARTA_PARAMS`), que mandan aunque repitan el default.
El laboratorio (`scripts/lab/*`) todavía no llama al resolver: sus réplicas siguen con los defaults.
