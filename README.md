# Una Carta Para Isa

Un mundo procedural compartido que continúa mientras el navegador está cerrado: biomas, recursos agotables, animales individuales, exploración, construcción, aprendizaje y comunidades. **`7d8777c` está activo en la revisión privada**, con reglas/protocolo 5 y SQLite 4. La publicación del 6 de septiembre inició un mundo normal desde cero, archivó el anterior y conservó la contraseña y el acceso TLS. Las dos réplicas de veinticinco días pertenecen al cierre biológico anterior; no acreditan continuidad indefinida ni describen este mundo nuevo. El [objetivo rector](GOAL.md) reúne la visión de mundo y carta; [EVIDENCIA.md](docs/EVIDENCIA.md#publicación-con-mundo-nuevo) registra la publicación comprobada. S e I son nombres provisionales; vecinos y cinco recuerdos iniciales son ficticios.

La aplicación local está implementada y la revisión privada mantiene el acceso existente. La voz final de Steven, los recuerdos reales revisados, la prueba en un teléfono físico y el alojamiento definitivo siguen pendientes. No hay publicación pública ni infraestructura nueva contratada.

La versión activa conecta el archivo tecnológico con investigación y fabricación: 256 define la caché residente, mientras las identidades y generaciones tecnológicas pueden seguir creciendo en SQLite. Cada persona conserva hasta 32 instrucciones. La interfaz distingue ese conocimiento de los objetos que lleva y de los detalles disponibles en la vista. También están activos el núcleo corporal común de humanos y animales y las transiciones visuales del suelo basadas en estados locales. EVIDENCIA separa la validación compilada, la continuación autónoma en copia y la comprobación privada; las observaciones largas multisemilla de esta fuente siguen pendientes. El trabajo posterior sobre agua V6 sigue siendo candidato y no forma parte de esta publicación.

## Arrancar en local

Requiere Node.js **22.22 o posterior de la rama 22**; esta implementación se comprobó con **22.22.3**. El manifiesto también admite Node.js 24 o posterior, sin acreditar aquí esas versiones. Se usa `node:sqlite`, que en Node.js 22 muestra un aviso de API experimental.

Desde la raíz del repositorio:

```sh
npm ci
npm run access -- init
npm run build
npm start
```

`access init` pide una contraseña de entre 12 y 256 caracteres sin mostrarla en la terminal. Guarda un registro scrypt en `data/access.scrypt`, con permisos privados; no guarda la contraseña legible. Si ya existe una credencial, conserva el archivo y termina sin reemplazarlo.

Abre **http://127.0.0.1:3000** e ingresa con esa contraseña. Usa exactamente ese origen: el servidor comprueba `Host` y el origen de las solicitudes. Arrastra para explorar, usa la rueda para acercarte y selecciona un habitante en el mapa o el censo. «Autónomo» devuelve sus decisiones. [EXPERIENCIA.md](docs/EXPERIENCIA.md#participación-de-isa) explica órdenes, fichas, fauna, procedimientos y gestos; los recursos del panel corresponden a regiones activas, no a todo el territorio.

**Todos los clientes conectados al mismo servicio comparten un único mundo persistente.** El backend mantiene un estado y un reloj de simulación a diez pasos por segundo, guarda cada paso y envía normalmente dos vistas por segundo a cada cliente. Cada navegador conserva su cámara y dibuja la región solicitada; abrir otra pestaña no crea habitantes ni otra simulación. Las órdenes aceptadas de todos los clientes actúan sobre ese mundo común.

La CPU del servidor ejecuta la simulación y el guardado; cada navegador dibuja con sus recursos gráficos. El límite actual es **12 conexiones WebSocket simultáneas**, incluidas varias pestañas de una persona. La distribución del trabajo y los límites gráficos están en [CONSTRUCCION.md](docs/CONSTRUCCION.md#arquitectura-implementada).

Cerrar todas las pestañas no detiene el mundo. Al detener el proceso y arrancarlo de nuevo **sin cambiar de versión**, recupera el último estado confirmado y registra una pausa técnica; no inventa encuentros durante la caída. La publicación de una nueva versión de pruebas tiene la [política de comienzo desde cero](#nuevas-versiones-de-pruebas) descrita abajo.

## Revisar desde la torre que aloja Docker

Dentro de este contenedor Linux, `npm run preview:local` arranca la aplicación en dos sesiones de tmux propias, con `socat` como terminación HTTPS y un certificado local autofirmado. Requiere `tmux`, `socat` con OpenSSL y `openssl`, además de la compilación. El comando muestra la IP privada del contenedor y el puerto **3443**; el puerto interno del servidor es **3123**. `CARTA_PREVIEW_IP` permite elegir otra IPv4 privada asignada al contenedor.

El navegador de la torre debe aceptar el certificado local. La contraseña se genera una vez y se conserva con permisos privados en `~/.local/state/atlas-para-isa-preview/password`, fuera del repositorio. Se consulta localmente; el comando no la imprime en los logs. El mundo de revisión vive en `~/.local/state/atlas-para-isa-preview/world` y se conserva entre arranques de la misma versión. `preview:local` no publica por sí solo una versión nueva ni reinicia el mundo.

```sh
npm run preview:local
npm run preview:local -- status
npm run preview:local -- stop
```

Este acceso por IP de la red bridge está pensado para la propia torre Linux. No publica un puerto en la LAN ni en Internet. Las sesiones sobreviven al cierre de esta terminal, pero no se acredita reinicio automático del contenedor ni alojamiento definitivo. La persistencia tras recrearlo depende de conservar el directorio indicado.

## Configuración

| Variable | Valor por defecto | Uso |
|---|---|---|
| `CARTA_DATA_DIR` | `data`, relativo al directorio de trabajo | Directorio del mundo SQLite, la credencial y el bloqueo de instancia. También lo usan los comandos de acceso y recuperación. |
| `HOST` | `127.0.0.1` | Dirección de escucha. Fuera de loopback exige configurar un origen HTTPS. |
| `PORT` | `3000` | Puerto TCP, entre 1 y 65535. |
| `CARTA_ORIGIN` | `http://127.0.0.1:<PORT>` | Origen exacto visible en el navegador. Un origen HTTPS activa cookies `Secure` y HSTS. |
| `CARTA_PASSWORD` | Sin valor | Alternativa operativa a `access.scrypt`, suministrada fuera del repositorio. No hace falta para el arranque interactivo anterior. |

Para alojamiento hacen falta **una sola instancia**, un proceso persistente, disco persistente para SQLite y terminación HTTPS con soporte WebSocket. `CARTA_ORIGIN` declara el origen autorizado; no instala certificados ni convierte por sí solo el servidor HTTP en HTTPS. El proveedor y la publicación requieren la decisión del dueño.

## Acceso y revocación

La sesión dura hasta catorce días y puede cerrarse desde la aplicación. Para revocar todas las sesiones del mundo seleccionado:

```sh
npm run access -- revoke
```

Las conexiones y los gestos pendientes vuelven a comprobar la sesión antes de confirmar cambios. Revocar sesiones no cambia la contraseña; alguien que la conserve puede volver a ingresar. La rotación de credenciales no tiene todavía un comando automático: se configura una credencial revisada y se reinicia el servicio.

## Copia y recuperación explícita

Crea una copia SQLite coherente en una **ruta nueva**. El comando rechaza sobrescribir un destino existente:

```sh
npm run backup -- ./backups/carta-revision-01.sqlite
```

El CLI abre el origen en modo de solo lectura, sin migrar el esquema de un servicio anterior. La copia contiene el mundo y sus registros operativos; debe permanecer privada. `access.scrypt` es un archivo separado y no forma parte de la copia SQLite. Copiar una base no acredita que su estado pueda migrarse: la validación del lector puede rechazarla. El defecto conservado en el archivo V4 está en [EVIDENCIA.md](docs/EVIDENCIA.md#servicio-privado-v5-y-archivo-v4).

Para recuperar o inspeccionar una ejecución anterior, usa un **directorio de datos nuevo** y un build compatible. Se valida la copia, se revocan sus sesiones y se conserva el mundo de origen. Estos comandos no sirven para reemplazar el mundo de una nueva versión de pruebas con un estado viejo:

```sh
CARTA_DATA_DIR=./data-restored npm run restore -- ./backups/carta-revision-01.sqlite
CARTA_DATA_DIR=./data-restored npm run access -- init
CARTA_DATA_DIR=./data-restored npm start
```

Detén el servicio anterior antes de usar el mismo puerto. No borres el directorio original para recuperar otro mundo.

Si el estado actual no es válido pero existe un punto anterior verificable en la misma base, recupéralo también en un directorio nuevo:

```sh
npm run recover:previous -- ./data-previous
CARTA_DATA_DIR=./data-previous npm run access -- init
CARTA_DATA_DIR=./data-previous npm start
```

Esta operación retira en la copia las entradas y los hechos posteriores al punto recuperado y revoca las sesiones. Conserva el archivo original. Si la base o el punto anterior no se pueden validar, el comando falla; no genera silenciosamente otro mundo.

## Nuevas versiones de pruebas

Por decisión de Steven, **durante esta etapa de desarrollo cada nueva versión de pruebas publicada empieza un mundo limpio en el paso cero**, aunque no cambien los números de reglas, protocolo o esquema. Antes de reemplazar la instancia se resguardan de forma privada y coherente su base, archivos e historia junto al build correspondiente. El mundo nuevo usa almacenamiento separado del archivo anterior y conserva la contraseña existente. Las sesiones anteriores no se heredan: hay que ingresar de nuevo con la misma contraseña. No se restaura un estado viejo encima de él.

La política se aplica al publicar una versión para probarla, no a cada edición, commit o compilación. El repositorio y su historial Git conservan los avances. Reconectar, cerrar el navegador o reiniciar el servicio sin cambiar de versión mantiene el mundo confirmado; una corrupción, un crash o un fallo de guardado no autorizan borrarlo para ocultar el problema. Los mundos archivados siguen disponibles para diagnóstico en copias separadas, sin mezclarlos con la ejecución nueva.

La publicación de **`7d8777c` se completó el 6 de septiembre de 2026** con la semilla normal `51926`, dieciséis habitantes y paso inicial cero. El mundo anterior de `bf6431b` quedó archivado junto a su build; sus órdenes, sesiones e historia no pasaron al nuevo. [EVIDENCIA](docs/EVIDENCIA.md#publicación-con-mundo-nuevo) registra el archivo exacto, el acceso comprobado y la observación con dos navegadores. Repetir la operación para esa misma publicación no crea otro mundo. Fue un procedimiento revisado, sin añadir un CLI general de publicación o reset.

## Actualizar conservando el mundo

Esta sección describe la actualización anterior y la compatibilidad de los lectores. La publicación de nuevas versiones de pruebas sigue ahora la política de mundo limpio indicada arriba.

La actualización de SQLite 3 a 4 se comprobó primero en una copia y después conservó el mundo, los archivos de acceso y sus cuatro sesiones. [EVIDENCIA](docs/EVIDENCIA.md#actualización-sin-reiniciar-el-mundo) enlaza preflight, activación, comprobación privada y archivo del build, base y script anteriores. Fue un procedimiento revisado para ese candidato, no un CLI general añadido al proyecto.

El catálogo integrado en `614b25d` y validado en `7d8777c` está ahora activo, en un mundo nuevo. Su lector también admite snapshots antiguos válidos: Store añade metadatos de catálogo y aplica memoria local finita; puede olvidar instrucciones y práctica sin soporte, pero no rellena recursos ni modifica cuerpos o parentescos. Guardar confirma esa adopción. El acceso `readOnly` conserva la base de origen, aunque la representación cargada en memoria adopte el catálogo cuando el esquema lo admite. Esta compatibilidad se comprobó en copia y es distinta del comienzo desde cero de la publicación. Deben conservarse juntos base y build anteriores: el lector antiguo no tiene el contrato de las referencias tecnológicas que ya salieron de RAM.

Una actualización debe mantener inactivos los CLI independientes de acceso y almacenamiento y cualquier escritura SQL directa. El lease SQLite `world.lock` excluye otras instancias del servidor, pero esos comandos no comparten el lease. Comparar el estado durable antes de reemplazar archivos detecta cambios previos; no convierte el reemplazo en una transacción universal.

Se comprueba el backend en loopback antes de exponerlo por TLS. Si ya se intentó arrancar el backend nuevo, un fallo conserva la base actual y detiene solo los servicios propios; no se restaura una base antigua sobre un mundo que pudo avanzar. La recuperación explícita en copia descrita arriba sigue siendo una operación distinta y revoca las sesiones de esa copia.

## Territorio y continuidad

El mundo se genera por regiones de 16 × 16 celdas con coordenadas positivas y negativas; no conserva el borde de 40 × 28. El límite técnico es ±10 millones de celdas, con extremo superior excluido. La cámara recibe ventanas de hasta 96 × 64. Solo los alrededores de los habitantes avanzan: las regiones archivadas conservan sus cambios y congelan su ecología. El archivo en disco puede crecer con la exploración.

La versión activa usa reglas/protocolo **5** y SQLite **4**. El lector valida el origen antes de migrar. La actualización anterior a `bf6431b` conservó el mundo y sus sesiones al pasar de SQLite 3 a 4; `7d8777c` comenzó otro mundo según la política vigente. El archivo V4 anterior conserva su defecto de madera fuera de cota: el inicio V5 fue un mundo nuevo autorizado, no una migración exitosa de ese V4. El contrato de archivo y recuperación está en [CONSTRUCCION.md](docs/CONSTRUCCION.md#territorio-procedural-y-archivo); [EVIDENCIA.md](docs/EVIDENCIA.md#actualización-sin-reiniciar-el-mundo) registra aquel cambio de esquema.

En `bf6431b`, 256 recetas y generación tecnológica 32 detenían la búsqueda. El servicio `7d8777c` separa esos límites de la historia durable y mantiene acotados caché, memoria, proyectos y colas pendientes. Snapshot, definiciones, estadísticas y recibos se confirman juntos; un fallo conserva las colas y no confirma órdenes. El disco puede crecer y no hay almacenamiento ilimitado ni reconstrucción de episodios perdidos. La construcción conserva su gramática de seis componentes. [REGLAS](docs/REGLAS.md#catálogo-resoluble-y-memoria-técnica) y [CONSTRUCCION](docs/CONSTRUCCION.md#archivo-tecnológico) detallan el contrato.

## Desarrollo y comprobaciones

| Comando | Qué hace |
|---|---|
| `npm run dev` | Ejecuta el servidor TypeScript con `tsx`; sirve la interfaz ya compilada en `dist/client`. No incluye recarga automática del cliente. |
| `npm run typecheck` | Comprueba los tipos de aplicación, pruebas y scripts. |
| `npm test` | Ejecuta las pruebas Node de mundo y servidor. |
| `npm run build` | Compila la interfaz con Vite y el servidor con TypeScript. |
| `npm run check` | Ejecuta tipos, pruebas Node y compilación, en ese orden. |
| `npm run test:e2e` | Ejecuta las pruebas de navegador disponibles con Playwright. Requiere sus navegadores instalados. |
| `npm run test:smoke` | Comprueba el servidor compilado, contraseña, reinicio tras `SIGKILL` y revocación en un mundo temporal. Requiere `npm run build`. |
| `npm run test:soak` | Simula cinco días del modelo con guardado SQLite por paso, reinicio y copia; escribe `artifacts/soak.json`. |
| `npx tsx scripts/evolution.ts --days 15 --seeds 51926,20260905 --output artifacts/evolution-nueva.json` | Observa dos réplicas autónomas, con SQLite cada 120 pasos, reinicio intermedio y copia final. No mide commit por paso. |

`SOAK_DAYS` permite entre 3 y 60 días del modelo. Un día equivale a 2400 pasos: **cuatro minutos simulados**. La ejecución acelerada mide el motor y el guardado; no acredita varios días de operación real ni sustituye la prueba en un móvil físico.

El observador multisemilla admite entre 15 y 25 días y de una a 32 semillas distintas. Usa una ruta de salida nueva para conservar comparaciones. El soak corregido `soak-v5-provision.json` y la extensión terminada de veinticinco días `evolution-v5-extended.json` tienen salida 0 en sus registros `.execution.json`. La observación corregida anterior `evolution-v5-provision.json` conserva salida 143 de causa indeterminada, aunque su informe y comprobaciones estén completados. `soak-v5.json` y `evolution-v5.json` corresponden a la base anterior. [EVIDENCIA](docs/EVIDENCIA.md) interpreta cada resultado con sus fuentes. No ejecutes compilaciones que reemplacen el build de una revisión activa: valida un candidato en salida y mundo temporales separados. Las fuentes y los artefactos deben corresponder al mismo código.

Las pruebas incluyen controles emparejados de alimento, refugio, encuentro, recuerdo pertinente/irrelevante y aprendizaje desactivado, además de fauna individual, invención, ecología, archivo y renderizado. [EVIDENCIA.md](docs/EVIDENCIA.md) registra los resultados de la revisión vigente y Git conserva los anteriores; un mecanismo implementado o un comando documentado no equivalen a una ejecución aprobada.

Para las pruebas de navegador, ejecuta primero `npx playwright install chromium` y `npm run build`. La [evidencia de esta entrega](docs/EVIDENCIA.md) registra los resultados y sus límites.

## Mapa del proyecto

- `src/world/`: reglas deterministas, terreno, ecología, fisiología compartida, animales, invenciones, memoria, genética, sociedad y estadísticas.
- `src/server/`: HTTP/WebSocket, sesión privada, transacciones y continuidad.
- `src/client/`: paisaje con cachés y WebGL2/Canvas 2D, carta, fichas, estadísticas, crónica y controles accesibles en DOM.
- `src/shared/`: contrato de datos visible; el navegador no recibe el estado interno completo.
- `tests/` y `scripts/`: comprobaciones y operaciones locales.

El [plan](PLAN.md), la [experiencia](docs/EXPERIENCIA.md), la [construcción](docs/CONSTRUCCION.md) y las [reglas implementadas](docs/REGLAS.md) explican el alcance y sus límites. La simulación no depende de un LLM en ejecución.
