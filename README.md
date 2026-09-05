# Una Carta Para Isa

Un mundo procedural que continúa mientras el navegador está cerrado: seis biomas, agua y recursos agotables, animales individuales, exploración, invención, construcción, aprendizaje y comunidades. Parte de dieciséis habitantes y permite descendientes de vecinos hasta un máximo de 32. Es un **prototipo reversible V4 en validación** de la carta de Steven para Isa; la revisión privada continúa en V3 hasta completar la actualización. S e I son nombres provisionales; los vecinos y los cinco recuerdos iniciales son material ficticio identificado.

La aplicación local está implementada. La voz final de Steven, los recuerdos reales revisados, la prueba en un teléfono físico y el alojamiento privado siguen pendientes. No se ha publicado ni contratado infraestructura.

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

Abre **http://127.0.0.1:3000** e ingresa con esa contraseña. Usa exactamente ese origen: el servidor comprueba `Host` y el origen de las solicitudes. El paisaje ocupa la pantalla. Arrastra para explorar, usa la rueda para acercarte y selecciona cualquier habitante en el mapa o el censo. Puedes seguirlo, dirigir su destino o pedirle explorar, recolectar, cultivar, construir, cazar, beber, cooperar y descansar; «Autónomo» devuelve sus decisiones. Las fichas explican necesidades, habilidades, materiales, parentesco, experiencias y relaciones. Los gestos son sembrar, invitar y recordar; una invitación aceptada puede ser ignorada por los habitantes.

«Vida del mundo» reúne población, historia reciente, paisaje, comunidades y rendimiento. La pestaña «Fauna» permite buscar, seleccionar y seguir animales, con sus necesidades, genes y actividad. Las órdenes de los habitantes incluyen ensayar diseños y reparar; los animales se observan sin recibir esas órdenes humanas. Los diseños muestran componentes, costes, procedencia y utilidad adquirida por uso.

Los recursos y la fauna contados corresponden a **regiones activas del servidor**; no son un censo del territorio procedural completo ni solo de lo que mira la cámara. La pestaña de rendimiento distingue tiempos de simulación y guardado, memoria del proceso y medidas gráficas de este navegador.

**Todos los clientes conectados al mismo servicio comparten un único mundo persistente.** El backend mantiene un estado y un reloj de simulación a diez pasos por segundo, guarda cada paso y envía normalmente dos vistas por segundo a cada cliente. Cada navegador conserva su cámara y dibuja la región solicitada; abrir otra pestaña no crea habitantes ni otra simulación. Las órdenes aceptadas de todos los clientes actúan sobre ese mundo común.

La CPU del servidor ejecuta ecología, decisiones, herencia, sociedad y guardado. Cada navegador utiliza sus propios recursos gráficos para dibujar; WebGL2 puede usar la GPU del dispositivo cliente. No se utiliza la GPU del servidor para simular ni se entrena un modelo. El límite actual es **12 conexiones WebSocket simultáneas** —incluidas varias pestañas de una persona—; no se acredita capacidad para cientos de clientes.

Cerrar todas las pestañas no detiene el mundo. Al detener el proceso y arrancarlo de nuevo, recupera el último estado confirmado y registra una pausa técnica; no inventa encuentros durante la caída.

## Revisar desde la torre que aloja Docker

Dentro de este contenedor Linux, `npm run preview:local` arranca la aplicación en dos sesiones de tmux propias, con `socat` como terminación HTTPS y un certificado local autofirmado. Requiere `tmux`, `socat` con OpenSSL y `openssl`, además de la compilación. El comando muestra la IP privada del contenedor y el puerto **3443**; el puerto interno del servidor es **3123**. `CARTA_PREVIEW_IP` permite elegir otra IPv4 privada asignada al contenedor.

El navegador de la torre debe aceptar el certificado local. La contraseña se genera una vez y se conserva con permisos privados en `~/.local/state/atlas-para-isa-preview/password`, fuera del repositorio. Se consulta localmente; el comando no la imprime en los logs. El mundo de revisión vive en `~/.local/state/atlas-para-isa-preview/world` y se conserva entre arranques.

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

La copia contiene el mundo y sus registros operativos; debe permanecer privada. `access.scrypt` es un archivo separado y no forma parte de la copia SQLite.

Para restaurar, usa un **directorio de datos nuevo**. Se valida la copia, se revocan sus sesiones y se conserva el mundo de origen:

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

## Territorio y continuidad

El mundo se genera por regiones de 16 × 16 celdas con coordenadas positivas y negativas; no conserva el borde de 40 × 28. El límite técnico es ±10 millones de celdas, con extremo superior excluido. La cámara recibe ventanas de hasta 96 × 64. Solo los alrededores de los habitantes avanzan: las regiones archivadas conservan sus cambios y congelan su ecología. El archivo en disco puede crecer con la exploración.

Las reglas y el protocolo visible de esta ampliación están en **versión 4**; el esquema SQLite permanece en **versión 2**. La migración valida las versiones anteriores antes de añadir campos. Las existencias de fauna V3 se convierten en identidades reproducibles, conservando sus cantidades; una población vacía guardada permanece vacía. Los refugios existentes reciben un diseño básico. Los nuevos contadores comienzan en la migración y no reconstruyen acontecimientos anteriores. La evidencia final de migración y reinicio se registra por separado.

Liebres, ciervos, jabalíes, peces, lobos y zorros tienen cuerpo, percepción, memoria local y seis parámetros heredables. Pueden consumir recursos, desplazarse, huir, depredar, reproducirse y morir por causas del modelo. Comparten la función de necesidades con los humanos, con tasas propias; no construyen ni forman comunidades humanas.

Los habitantes ensayan combinaciones válidas de armazón, techo, cisterna, granero, huerta y hogar. Construir, experimentar y reparar cuestan materiales y trabajo. Una cisterna necesita lluvia, el granero almacena alimento aportado y la huerta consume agua; la utilidad observada exige uso. Es una gramática finita de componentes, sin invención ilimitada de nuevas leyes físicas. Los lugares con recursos y vínculos pueden convertirse en hogares recordados, favorecer retornos físicos y perder atractivo al agotarse.

Siete pares de genes de diseño permiten recombinación mendeliana simplificada y variación acotada. La tasa de aprendizaje es heredable; las habilidades, preferencias aprendidas y experiencias no se copian al genoma. Los vecinos pueden tener descendencia con costes, recursos, confianza, una comunidad y un lugar cercano compartidos; ese lugar no tiene que ser un refugio. S e I quedan fuera de esa regla. Cada descendiente empieza sin aprendizaje heredado y registra su nacimiento como primera experiencia propia. No hay muerte de habitantes, gobiernos ni un resultado demostrado del efecto Baldwin. [CIENCIA.md](docs/CIENCIA.md) explica las referencias y límites.

El paisaje usa cachés de dibujos y un compositor WebGL2 cuando está disponible, con alternativa Canvas 2D ante indisponibilidad, software detectado o pérdida de contexto. El diagnóstico distingue hardware identificado, software e identidad no verificada. Los FPS y tiempos de dibujo son medidas locales; no acreditan que todos los equipos usen una GPU física ni miden su porcentaje de ocupación.

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

`SOAK_DAYS` permite entre 3 y 60 días del modelo. Un día equivale a 2400 pasos: **cuatro minutos simulados**. La ejecución acelerada mide el motor y el guardado; no acredita varios días de operación real ni sustituye la prueba en un móvil físico.

Las pruebas incluyen controles emparejados de alimento, refugio, encuentro, recuerdo pertinente/irrelevante y aprendizaje desactivado, además de fauna individual, invención, ecología, archivo y renderizado. [EVIDENCIA.md](docs/EVIDENCIA.md) registra los resultados de la revisión vigente y Git conserva los anteriores; un mecanismo implementado o un comando documentado no equivalen a una ejecución aprobada.

Para las pruebas de navegador, ejecuta primero `npx playwright install chromium` y `npm run build`. La [evidencia de esta entrega](docs/EVIDENCIA.md) registra los resultados y sus límites.

## Mapa del proyecto

- `src/world/`: reglas deterministas, terreno, ecología, fisiología compartida, animales, invenciones, memoria, genética, sociedad y estadísticas.
- `src/server/`: HTTP/WebSocket, sesión privada, transacciones y continuidad.
- `src/client/`: paisaje con cachés y WebGL2/Canvas 2D, carta, fichas, estadísticas, crónica y controles accesibles en DOM.
- `src/shared/`: contrato de datos visible; el navegador no recibe el estado interno completo.
- `tests/` y `scripts/`: comprobaciones y operaciones locales.

El [plan](PLAN.md), la [experiencia](docs/EXPERIENCIA.md), la [construcción](docs/CONSTRUCCION.md) y las [reglas implementadas](docs/REGLAS.md) explican el alcance y sus límites. La simulación no depende de un LLM en ejecución.
