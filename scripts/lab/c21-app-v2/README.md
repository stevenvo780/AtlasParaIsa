# C21 App v2 — autoría estática para cápsula privada

Paquete nuevo, no ejecutado. Cuenta solicitada SECUNDARIA explícita, Sol6.1 high;
identidad efectiva del proveedor y cuota no verificadas por archivos. No cambia
sandbox/auth ni usa delegación. Sólo rutas propias dentro de este checkout.

`run.py` es una entrada **exclusiva del ejecutor nativo autorizado por Root**.
El autor sólo analizó Python/JSON, hashes y diff; no ejecutó Node, imports TS/App,
npm, build, tests, sockets, SSH, systemd, DBus ni biología. Cada argv está en el
MANIFEST y exige nuevo GO, componente CPU nativo suministrado por Root y admisión
fresca. El GO_QA_ONLY60 de v1 no autoriza ejecutar este paquete ni LONG.

## Implementación observable

- Doce conexiones TCP WebSocket auténticas `/ws?ack=1`, sin negociar deflate;
  manejan fragmentación RFC6455, ping/pong, cierre y `trozos` de aplicación.
  Reensamblan el `state` completo antes de enviar exactamente
  `{type:'ack',sequence:world.sequence}`. Esos ACK sólo liberan proyecciones.
  La compresión WS negociada queda fuera del alcance y UNKNOWN.
- Cuatro rápidos, cuatro ACK lentos (espera real 2 s) y cuatro no lectores
  durante episodios reales de 10 s con un `state` pendiente. Luego leen y
  responden; **no** se afirman cuatro conexiones permanentemente no lectoras
  durante una hora. El heartbeat real no se deshabilita. `app.flujo` verifica
  las doce conexiones por puerto TCP y `enviados-acuses<=1`.
- Doce clientes HTTP con IDs por cliente; `command/rest` real, resultados
  completos aceptados y rechazados cotejados con `inputs`, fingerprint y
  ordinal. Login usa una identidad sintética y una sesión compartida; las
  sesiones reales acumuladas se cuentan por hash no publicado. Máximo cinco
  intentos de login en cualquier ventana de 60 s. No hay doce identidades.
- Exposición continua: abre después de doce upgrades, doce estados y doce
  flujos confirmados; mide `closing-opening` con reloj monotónico real. Una
  caída aborta esa exposición. 60 s diagnóstico y >=3600 s campaña; los
  reinicios de la matriz ocurren después y no rellenan una hora abreviada.
- Opt-in del worker: `store.save` y `store.db.exec` de la **misma** instancia
  propia, más `flushTechnology` en esa instancia. No edita módulos ni Store.
  Requiere credencial propia 0600, DB propio, loopback y pipe cookie aleatoria.
  IPC acepta sólo tipos registrados y PID/starttime/pgrp/session/cgroup vivos.
  Parent señala sólo el PID hijo exacto verificado; nunca pkill/killall/host.
- Los COMMIT de `prepareTechnology/withTechnologyReads` se ignoran mientras no
  haya `BEGIN IMMEDIATE` dentro del `save` ligado al ID HTTP real. B01 es antes
  de ese BEGIN; B02 exacto se observa al entrar a `flushTechnology` después de
  sesiones y comprobaciones anteriores. `WRITE_AFTER_BEGIN` es un hook auxiliar
  y no sustituye B02. `WRITE_BEFORE_COMMIT` corresponde a B10, **no B02**.
  A01 se bloquea tras retornar COMMIT real, antes de `saves++`, retorno de
  Store, resolve del Promise o HTTP200. No se infieren fases mediante timeout.
- Candidatos/fases sólo reciben testigo si los args reales de save incluyen
  el Gesture ID. B10/A01 cotejan filas reales del mismo DB con fingerprint,
  tick, ordinal, body y result; tras COMMIT exigen transacción terminada y
  cambios positivos. Un hook sin vínculo es UNKNOWN_OPERATION_BINDING.
- El cliente `HeaderProbe` envía HTTP real y registra bytes recibidos y EOF.
  Se exige cero bytes hasta la muerte del worker. A01 prueba K1 sin HTTP200
  entregado mediante barrera antes de resolve; **no** declara haber retenido
  un HTTP200 upstream ni necesita proxy. A11/proxy no está implementado.
- Cada fase registrada F observa al menos 10 segundos reales la barrera;
  esa espera es un presupuesto de observación, no un umbral del protocolo ni
  diez repeticiones. El protocolo enumera diez puntos B y doce A con G/F, no
  obliga a inventar diez réplicas de B01/A01. G queda UNKNOWN: SIGTERM diferido
  por ejecución síncrona no demuestra cierre antes de COMMIT.
- Conserva K0/K1 completo antes/después de kill con lectura independiente de
  todas las tablas/columnas/filas retenidas y tipos SQLite. En recuperación
  bloquea tras Store.load **antes de createApp**, compara corte íntegro y
  slot/tick/instanceId; luego permite la escritura real de pausa del arranque.
  Reintenta mismos IDs; A01 exige el resultado original exacto. Otro cuerpo
  con ese ID debe producir HTTP409. Sin reparar ni borrar copias fallidas.

## Proyecciones y artefactos sin pérdida

El índice nativo registra bytes crudos/comprimidos, tiempos reales de escritura
gzip y lectura retenida por segmento. El coste por hora no se mide en autoría;
Root puede medirlo en la cápsula diagnóstica antes de admitir LONG. No se declara
PASS ni se extrapola duración a partir de ese coste.

Todos los payloads completos de cliente y todas las filas de los cortes se
conservan en segmentos gzip-6/mtime0. Hay hashes del fichero, del payload y del
flujo íntegro, contador por registro y conteo por tabla/corte; el lector verifica
los bytes retenidos, no una copia de memoria. El monitor cuenta stage, deps,
build, DB/WAL, HOME/TMP/cache, evidencias y logs. Exceder el cap detiene el ensayo;
no se recortan pruebas, historia ni métricas para llegar al cierre.

Las comparaciones entre clientes conservan cada entidad completa en el
solapamiento (tiles, people, animals, structures, blueprints, places); para igual
cámara comparan toda la proyección salvo `performance`, bloque operativo vivo
retenido completo. Saltos de secuencia pueden resultar de coalescing; no se
inventan estados ni historia faltante.

Para SQLite↔cliente, un GET real se bloquea en su salida sólo si coincide con el
tick/digest durable real. Python retiene un corte íntegro en una transacción RO.
`projection.mjs` usa otra conexión Store readOnly sobre esa DB quieta y genera
la proyección completa de todos los campos de `projectWorld`, instanceId y
regionesVivas. Se compara con el payload recibido por HTTP, ligado por SHA.
No coincide tick → UNKNOWN, nunca igualdad inferida. `performance` se conserva
pero se verifica como bloque operativo, pues no está almacenado en SQLite.
**El proyector usa el codec de producción bajo prueba**: no reemplaza el ledger
manual independiente F21-B/C ni prueba por sí mismo semántica de historia.

## Matriz y restricciones pendientes

`case-plan.json` mantiene las 115 entradas y los expected originales byte a
byte como valores JSON, más bindings v2 explícitos. Ninguna entrada se marca
PASS por autoría ni por mecanismo técnico. Hooks F cubren sólo B01/B02/B10/A01;
S01–S04 tienen observaciones parciales reales preparadas y siguen UNKNOWN por
ledger/paquetes faltantes. No hay ejecutores de B03–B09, A02–A12 exactos, G,
D02–D13, commits adicionales ni adapter completo v3. No se inventan fallos I/O,
backup, power-loss, migración, publicación o aceptación biológica.

Faltan nuevo GO diagnóstico, native CPU component, diagnóstico nativo v2,
finReview GO_LONG, preregistro/ledger independiente firmado y admisión larga.
ROOT debe revisar la legalidad del monkeypatch y emitir el remapeo B10 explícito.
Los archivos v1 y el sibling coordinador quedan intactos.

## Recursos y entrega a Root

Propuesta: 4 CPU, 8 GiB, 16 GiB **total** de salida, 64 MiB logs totales; deadline
900 s diagnóstico, **7200 s campaña**. La hora no se multiplica/extrapola.
Presupuesto conservador: 3600 exposición + 720 preparación + 540 arranques/RO
readers + 40 holds F + 720 cortes/reconciliaciones + 360 HTTP/teardown = 5980 s;
7200 deja margen operativo para los subconjuntos implementados. La duración de
los 115 ensayos exactos sigue UNKNOWN: faltan sus ejecutores y fixtures. Es presupuesto previo, no tiempo medido ni PASS.
Costo máximo teórico: 1 CPU-h diagnóstico, 8 CPU-h campaña bajo 4 CPU.
Una admisión 3900 s sería rechazada por alcance/deadline. Solicitar a Root
aprobación concreta de 7200 s y 16 GiB; no modificar floors/guards: global CPU80%,
MemAvailable44 GiB, disco220 GiB, outpool60 GiB, parent32 GiB; serie24/std39/meta1
son bindings declarados y deben ser conciliados por el componente CPU de Root.

`MANIFEST.json` contiene origen SHA v1, 105 archivos de cierre fuente Node
(102 src + package/package-lock/tsconfig.server), 5 extras de stage, cierre tipado
exhaustivo de dependencias incluido cada uno de ocho symlinks y los bytes .vite.
No hay cachés compartidas nuevas ni exclusiones de .vite. Stage copia enlaces
relativos y se verifica pre/mid/post. Si el build cambia dependencias copiadas,
se aborta; la fuente no se recongela ni se ignora la deriva.

Comprobación permitida al autor:
`/usr/bin/python3.14 -I scripts/lab/c21-app-v2/static-audit.py`.
Sólo AST/JSON/hash/diff, sin importar módulos runtime. JS syntax y todas las
pruebas nativas quedan NOT_RUN. Fixtures manuales y método estricto están en
`manual-fixtures.json`; `review.py` admite un registro offline y nunca inicia
Node. El resultado más favorable de ese lector sigue siendo C21 UNKNOWN.
