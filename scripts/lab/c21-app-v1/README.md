# C21 App/HTTP v1 — preparado, sin ejecutar

Ownership: sólo este directorio, `.orchestration/c21-app-v1/` y
`recursos/C21-APP-PREPARED-v1.{md,json}` en este checkout. Autoría solicitada:
Sol6.1 alto, cuenta secundaria explícita; cuota desconocida. Sin sondeo OAuth,
subdelegación, cambios de cuenta, permisos o sandbox. El proveedor/modelo efectivo
no se puede verificar mediante estas lecturas locales.

## Contrato y denominador

Autoridad local: `specs/003-criterios-realismo/durability-protocol.md` y
`docs/CRITERIOS-REALISMO.md`, C21/B13. El perfil exacto v3 está en el worktree
`criterios-realismo-20261003/specs/003-criterios-realismo/contracts/thresholds.v3.json`;
su C21 se copia sin reinterpretación en
`.orchestration/c21-app-v1/C21-AUTHORITY-EXTRACT.json`. Los originales y su SHA256
están en `MANIFEST.json.authorityPins`. Se conserva `PROVISIONAL` en 12 clientes,
3600 segundos y ≥10 puntos por fase; pérdidas y diferencias de mundo/reloj ==0
son obligaciones heredadas. Las ventanas usan `(apertura,cierre]`.

`case-plan.json` conserva 20 B-G/F +24 A-G/F +13 D +4 S =61 casos primarios,
además de54 entradas adicionales de transacciones/inicialización/lectura. Todas
las clasificaciones empiezan UNKNOWN. La implementación no convierte este plan
en evidencia ejecutada ni reduce el denominador a los mecanismos disponibles.
Los extras `between-writes` son cobertura pendiente, no una enumeración completa
de escrituras internas: una campaña de fronteras necesitará desglosarlas con hooks
y nuevo preregistro revisado.

## Mecanismo implementado

`run.py` prepara una copia propia de fuentes y dependencias pinadas y compila
secuencialmente servidor y cliente dentro de `output/stage`. No usa `npm`, main,
tests, instalación, paquetes nuevos ni acceso remoto. El runtime es otro paso:
`worker.mjs` importa **App real compilada**, Store y el lock real. Usa reloj real,
scheduler automático de App, semilla51926 y defaults; no cambia leyes ni añade
wrappers de COMMIT. La compilación de TypeScript7/Vite puede crear procesos hijos;
todos quedan en la misma unidad limitada del ejecutor nativo.

`main.ts` rechaza PORT=0; el worker reserva un puerto loopback efímero elegido por
el OS, lo libera y enlaza App al mismo puerto con su origin exacto. Una colisión
termina el ensayo. No acepta otra dirección ni un puerto alternativo. READY sólo
declara procedencia operativa (Node/SQLite, puerto, PID, carga real, instanceId).
Health y login no acreditan una orden durable.

Autenticación real: `POST /api/login`, contraseña sintética nueva en memoria,
`access.scrypt` sintético en `output/data`, cookie real, Host/Origin habilitados.
No se leen credenciales públicas ni se hereda entorno. Una sesión propia se
comparte explícitamente entre doce clientes lógicos HTTP independientes para
respetar el límite real de6 logins/minuto por loopback. Esto no prueba doce
sesiones independientes ni doce suscriptores WS.

Cada cliente mantiene secuencia monotónica entre épocas y `gesture.id` único.
Envía `POST /api/gesture` con `kind=command,order=auto` para un vecino observado;
cada quinta secuencia usa `c21-missing-agent` como rechazo manual conocido. No
se cambian recuerdos ni se usa remember/plant como sustituto de balance material.
El intento, envío real y resultado HTTP íntegro se registran por separado.
HTTP200 cuenta sólo cuando el cuerpo es GestureResult válido. `accepted=false`
se conserva y concilia también. Cada resultado recibido se coteja contra
`inputs.fingerprint/body/result/tick/ordinal` por una conexión SQLite `mode=ro`,
sin Store como oráculo. El fingerprint reproduce la tupla exacta del Store pinado.
La secuencia es del cliente: App no expone una secuencia HTTP adicional.

Cuatro clientes rápidos, cuatro lectores lentos y cuatro con operaciones HTTP sin
lectura alternan una/dos cámaras con solapamiento. Los no lectores realmente envían
HTTP sin recibir respuesta; cada séptima secuencia elegible deja también una orden
con resultado no recibido. Eso es incertidumbre observada, no ACK. Cortes al mismo
tick/versión/instanceId comparan exactamente campos físicos compartidos; los ticks
sin corte común quedan desconocidos. Los hashes por tesela y los primeros desacuerdos
se guardan; nombres/recuerdos se omiten de las observaciones de cámara.

Tres ventanas suman3600s planeados en campaña, o60s planeados en diagnóstico.
Los tiempos efectivos de cada cliente y las pausas/reintentos se registran; no se
afirma de antemano cobertura continua de3600s para los doce. Tras la primera ventana:
SIGSTOP del hijo verificado, observación real de estado detenido, corte SQLite
consistente de **todas las tablas/columnas**, SIGKILL, segundo corte cerrado,
igualdad lógica exacta, reapertura real de Store/App y reintentos de todos los ACK
y envíos inciertos con los mismos IDs. Tras la segunda ventana: SIGTERM, cierre
real, corte cerrado y reapertura. El último corte verifica todos los resultados
recibidos. Los envíos inciertos nuevos de la última ventana se conservan como tales.

PID/starttime/session/cgroup deben coincidir antes de cada señal al grupo hijo.
El corte forzado se llama `AFTER_HTTP_AND_READONLY_CUT`: puede detener una transacción
posterior y **no fija B01–B10 ni A01–A11**. La comparación exacta se hace antes de
arrancar otra vez, porque el arranque agrega una pausa y rota snapshots legítimamente.
Después del arranque se exige slot0, tick e instanceId del corte cerrado y los mismos
resultados. No se exige igualdad binaria falsa de la DB tras el nuevo arranque.

El digesto Python preserva tipos SQL, bits de floats, blobs, todas las columnas y
filas, sin ordenar arrays JSON internos. Es independiente del productor pero no
equivale a un ledger material firmado ni a verificación semántica de todas las
cadenas. `quick_check` no es el criterio. WAL/synchronous=NORMAL sólo permite este
alcance de muerte de proceso, nunca pérdida de alimentación.

## Una cápsula para el ejecutor nativo

**No lanzar desde el sandbox autor.** No se ejecutó aquí Node, App, World, npm,
build, suite, unidad, daemon, socket ni DBus. Se permite aquí sólo AST Python,
lecturas/hash/JSON/diff. La sintaxis JS completa está pendiente: el primer argv de
preparación nativa es `node --check` y falla antes de importar App si hay un error.

El ejecutor nativo debe usar su mecanismo de admisión ya aprobado por root, una
sola unidad propia, preflight fresco y reconciliación de reservas G3/FULL/P0c y del
recibo Store v2. No inferir capacidad libre del recibo anterior. Caps propuestos
agregados:4 CPU,8GiB RAM,2GiB output completo,64MiB logs;900s absolutos diagnóstico
o4800s campaña, incluyendo copia/build/runtime/cortes/reintentos. Build180s por
paso, arranque60s, HTTP10s y oráculo15s. Son caps operativos, no umbrales C21.
Coste máximo teórico: diagnóstico1CPU-h, campaña5.33CPU-h; sin GPU. Las dependencias
existentes ocupan aproximadamente129MiB antes de copiar. El monitor interno suma
stage/dist/deps/home/cache/tmp/data/DB/WAL/SHM/logs/evidencia, y aborta ante fallo de
monitor o cruce de límites. El monitor externo de host debe preservar el público
y parar sólo esta unidad si supera la admisión del host. No hay nueva instalación.

Crear un recibo JSON propio con `schema=c21-app-native-admission/v1`,
`authorizedBy=root`, SHA256 exacto de `MANIFEST.json`, `runId=c21-app-...`, modo,
durationSeconds, issuedAt/expiresAt UTC, cgroupPath de **esa misma unidad**, y
`preflightFresh/reservationsReconciled/hostMonitorActive=true` sólo cuando existe
la evidencia externa correspondiente. El runner exige cgroup v2 y lee los caps
reales; una declaración JSON sola no crea ni limita una unidad. Admisión de arranque
fresca ≤900s; expiresAt limita el inicio, el timeout absoluto limita todo el job.
El ejecutor preserva el recibo de host/reservas y sus hashes junto al resultado.

`MANIFEST.json.nativeArgv.diagnostic` contiene el argv exacto para una sola cápsula
inicial de60s; sustituir únicamente `{admission}` por la ruta absoluta del recibo.
Usar argv estructurado/`execve` o equivalente, nunca `shell=True` ni heredoc
interpolado. `nativeArgv.campaign` está preparado por3600s; no queda autorizado por
un diagnóstico ni por la existencia de este archivo. No encadenar ambas ejecuciones
automáticamente. Root envía el ejecutor y decide la campaña posterior.

El entorno de los hijos se construye desde cero en `run.py`: PATH/LANG y todas las
rutas privadas quedan registradas en `run-manifest.json` antes del primer spawn.
No heredar CARTA_PASSWORD, CARTA_PARAMS, CARTA_PROXY_IP, NODE_OPTIONS, proxies ni
tokens. El output sólo puede ser una raíz nueva dentro de
`.orchestration/c21-app-v1/runs/<runId>` en este cwd; destino ocupado se rechaza.
El recibo admission inicial permanece fuera de la raíz nueva hasta que el runner
lo copia. No borrar evidencia al cruzar cap. Teardown final de unidad/cgroup,
descriptores/procesos descendientes y reconciliación de reserva corresponden al
ejecutor nativo; el resultado interno registra sus hijos y señala esa dependencia.

## Alcance de salida

Diagnóstico <hora: `PARTIAL` si el mecanismo termina; jamás PASS global.
Campaña completa del mecanismo: `TECHNICAL_OBSERVATIONS_ONLY`; jamás aceptación.
Pérdida/alteración de resultados o de corte completo, rechazo conocido aceptado o
bifurcación observada: FAIL técnico preservado. Falta de recursos, fase, oportunidad
o evidencia: UNKNOWN. Un exit0 sólo indica fin de las observaciones permitidas.
`scientificAcceptance=false`, `globalCampaignAcceptance=false`, `c21=UNKNOWN`
siempre. El formato emitido es soporte local versionado, **no** bundle wire v3:
faltan el adapter/evidenceIndex, ledger independiente y revisión externa. Ninguno
de los115 casos planeados se publica como PASS por este runner.
