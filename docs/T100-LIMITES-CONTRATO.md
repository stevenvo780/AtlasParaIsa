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

## 4b/4c ejecutados (2026-09-22, cierre parcial de T100 y revisión adversarial)

**Ley conductual (NO cerrada; decisión pendiente del integrador).** El tope de fundación de
`society.ts` deja de ser el literal `>= 8` y sale a parámetro: hoy lo lee
`foundingCommunityCap(world)` (`params.ts`), que devuelve `limites.comunidades`. **El default
sigue siendo 8, o sea que la conducta de hoy no cambia**, y eso NO es lo que pide FR-002
(«MUST salir a parámetro con default sin tope», `spec.md:138`, repetido en `tasks.md:61`).
Se deja así, contra la letra de FR-002, por cuatro razones medidas y en conflicto entre sí,
que el integrador o Steven deben resolver:

1. El control que la propia T100 exige («digesto idéntico antes y después: solo se relajan
   validaciones, no se cambia ninguna regla») es incompatible con cualquier forma de retirar
   el tope. `digestoCanonico` incluye los params efectivos, así que hasta una clave NUEVA con
   el default de hoy y sin ningún lector mueve el digesto: medido en este worktree,
   `createWorld(51926)` a 60 pasos pasa de `fa9c0523…` a `b2ccd87e…`.
2. El preflight de T100 exige que el cambio de conducta «se declare y contraste POR SEPARADO»
   de relajar validaciones, y la sección 4c de este contrato ya reservaba **Reglas 10** para
   retirar este gate. Retirarlo aquí lo metería en el commit del Gate A0, del que salen todos
   los worktrees de la etapa A, y rebasaría en silencio el control de todas las tareas que
   vienen detrás.
3. La constitución (II) sólo acepta un cambio de reglas **con medición**: réplicas, control y
   métricas. Hoy no hay ninguna trayectoria alcanzable que ejerza el gate, así que no hay nada
   que medir. Medido el 2026-09-22 en este worktree: semilla 51926 con defaults se estanca en
   **3 comunidades** y ~43 habitantes a los 11 días simulados (26 400 ticks), y semillas 1/7/51926
   a 2400 pasos dan 4/1/3 comunidades; con el calendario de nacimientos acelerado
   (`poblacion.intervaloComprobacionTicks=10,nacimientosPorComprobacion=20`) el mundo llega a
   4000 ticks con 25 habitantes, **3 comunidades y 0 % de gente sin `communityId`**. El gate
   de ocho sólo muerde a la escala de SC-004 (miles de habitantes), que es justamente la que
   esta feature todavía no alcanza.
4. Versionarlo con FR-020 (la otra salida que da `tasks.md:61`) exige subir `RULES_VERSION`
   de 9 a 10, y eso toca `tests/rules-version.test.ts` (`assert.equal(RULES_VERSION, 9)`), la
   cadena de migración y una fila de `docs/EVIDENCIA.md` con réplicas — ninguno de esos
   ficheros está en el alcance de T100 y la evidencia no se puede producir hoy (punto 3).

**Lo que sí queda resuelto en el código**: el `>= 8` ya no está escrito a mano, el operador
puede levantarlo sin recompilar (`CARTA_PARAMS='limites.comunidades=N'`, probado), y el único
lector de conducta tiene nombre propio y contrato escrito (`foundingCommunityCap`), de modo
que el día de Reglas 10 el cambio es de una línea con su versión y su evidencia.
**Coste declarado que el integrador debe conocer**: mientras la ley lea `limites.comunidades`,
subir ese número para ADMITIR un mundo grande sube también el tope de fundación. Es un cambio
de conducta, no de validación. Separarlo en una clave propia hoy rompe el control del punto 1;
por eso no se hizo y por eso está escrito aquí y en el propio código.

**Techo de cría animal.** `reproduce` calcula su capacidad con `limitsOf(world).fauna` en vez de
`MAX_STORED_ANIMALS`. La constante sobrevive sólo como valor histórico de admisión (`assertAnimals`
por defecto), ya derivada de `DEFAULT_PARAMS`, y no gobierna ninguna ley. `scripts/soak.ts` ya no
publica `maximumStoredAnimals: MAX_STORED_ANIMALS` (393 216 fijos, que desde este cambio no
gobiernan nada) sino `storedAnimalsLimit: limitsOf(world).fauna`, el techo real de ese mundo.
El `throw` de `stepAnimals` sigue siendo anticorrupción: la activación de un chunk puede
materializar fauna dormida, así que un límite por debajo de la fauna ya existente falla ruidoso.

**Resolver del host** (`src/server/hardware-limits.ts`). `presupuesto = min(RAM física, cgroup v2)
· 0,5`, acotado por `heap de V8 · 0,6`; de ahí regiones enteras a `BYTES_PER_ACTIVE_TILE` por
tesela activa, y de las regiones las teselas (`×256`) y la fauna (`×6`, ley estructural). Nunca
por debajo de los defaults de hoy. Es admisión, no garantía de RSS ni de latencia (eso lo gobierna
el p95, ruling R17). Se evalúa **sólo** al crear mundo nuevo: `AppOptions.params` acepta una función
y `app.ts` la llama únicamente en la rama `?? createWorld(...)`; `load`, `previous`, migración y
validación de respaldos jamás preguntan por la máquina. Precedencia: defaults deterministas →
límites resueltos → overrides explícitos de `deploymentParams` (`CARTA_PARAMS`).

**cgroup v2, corregido.** La primera versión leía `/sys/fs/cgroup/memory.max`, que es el cgroup
**raíz** y nunca declara ese fichero (comprobado: `cat /sys/fs/cgroup/memory.max` → «No existe el
fichero»). Bajo `atlas-servidor.service` —un servicio de usuario, cgroup
`/user.slice/user-1000.slice/user@1000.service/…`— un `MemoryMax=` se habría ignorado en silencio
y el mundo se habría dimensionado contra la RAM total. Ahora `cgroupMemory()` parte de la línea
`0::` de `/proc/self/cgroup` y toma el **mínimo** de `memory.max` del cgroup propio y de todos sus
ancestros; cgroup v1 no se interpreta y se declina (manda la RAM física). Cubierto con árboles
sintéticos en `tests/limites-host.test.ts` (tope propio, tope en una rodaja ancestra, mínimo de la
cadena, `max`, basura, negativo, v1) y con una lectura real de esta torre.

**`BYTES_PER_ACTIVE_TILE` = 2000, medido de nuevo.** La cifra anterior (1750, justificada con
«1707 B/tesela») venía de una medida defectuosa: `process.memoryUsage.rss()` es RSS
**instantáneo**, no pico, y se leía con el mundo escritor y el recargado vivos a la vez, sobre
2 097 152 copias de **una sola** tesela. La prueba ahora usa cuerpos heterogéneos (13 campos por
tesela, fracciones derivadas de la posición, dentro de los rangos de `validation.ts`), suelta el
mundo escritor antes de recargar y mide `process.resourceUsage().maxRSS`, que sí es pico.
Resultado (2026-09-22, heap configurado 6192 MiB, `CARTA_TEST_ESCALA=1`): escritura 168 891 ms,
lectura 153 368 ms, **RSS pico del escritor 2771 MiB (1386 B/tesela)**, RSS pico del proceso con
los dos mundos 3779 MiB (1888 B/tesela), 520 249 344 bytes en SQLite (248 B/tesela), digesto
idéntico al reabrir. Se adopta 2000 B —el pico de DOS mundos residentes— porque es la forma real del servidor
de hoy: `motor.clonPorPaso=true` clona el mundo en cada paso (desde PERF3, 2026-09-23, solo en los pasos
con gestos; el pico de dos mundos sigue dándose en ellos). Cuando el clon desaparezca del todo, esta
constante se vuelve a medir.

**Números de esta torre** (no son una constante del proyecto): `os.totalmem()` = 134 633 676 800 B,
`heap_size_limit` = 4 345 298 944 B, sin tope de cgroup ⇒ **5092 chunks / 1 303 552 teselas /
7 821 312 de fauna** para un mundo NUEVO, 19,9× las 65 536 teselas de hoy; `comunidades` sigue en 8
por la decisión pendiente de arriba. El techo depende de `NODE_OPTIONS`: con
`--max-old-space-size` mayor, el mismo host admite más. El informe anterior daba 5752 chunks, que
no es esta torre sino el caso sintético de 128 GiB con heap de 4 GiB fijado en la prueba.

**Prueba de 2 M teselas: quién la corre.** Sigue marcada lenta (`CARTA_TEST_ESCALA=1`, ~5,5 min y
~2,8 GiB), así que `npm test` no la ejecuta. Se corre **en el gate de la etapa A** (T110) y cada
vez que se toque `snapshot.ts`, `store.ts` o `hardware-limits.ts`, con
`CARTA_TEST_ESCALA=1 NODE_OPTIONS=--max-old-space-size=6144 npx tsx --test --test-timeout=900000
--test-name-pattern='2 097 152' tests/limites-anticorrupcion.test.ts`. Desvío declarado frente a
la sección 4c: escritor y lector son fases del MISMO proceso (no procesos separados) y no hay
`MemoryMax=8 GiB` ni `MemorySwapMax=0`. Lo que sí se cumple: cuerpos heterogéneos y de alta
precisión **con `-0`** (comprobado aparte que el códec lo conserva: un `growth = -0` guardado y
recargado sigue siendo `-0` y el digesto no cambia; la nota anterior de que «JSON no lo conserva»
era falsa), cierre y reapertura del SQLite, digesto completo idéntico y las cifras de arriba.

**Desvío de alcance declarado.** La lista de ficheros de T100 es `src/world/index.ts`,
`src/server/snapshot.ts`, `src/world/animals.ts`, `src/world/society.ts`, `src/world/params.ts` y
`tests/limites-anticorrupcion.test.ts`. Las fases 4b/4c tocaron además `src/server/hardware-limits.ts`
(nuevo), `src/server/app.ts` (sólo la firma de `AppOptions.params` y la rama de creación en
`createApp`), `src/server/main.ts` (la factory), `tests/limites-host.test.ts` (nuevo),
`scripts/soak.ts` (una línea del informe) y este documento. El resolver del host no puede vivir en
`src/world` (regla 2) ni servir de nada sin conectarlo, pero **debía declararse antes, no después**.
Aviso para el gate (regla 12): **T104 también edita `src/server/app.ts`**, en `stepOnce` y en la ruta
`SessionRevoked`. Los bloques son disjuntos de los de aquí, pero el merge los verá en el mismo fichero.
