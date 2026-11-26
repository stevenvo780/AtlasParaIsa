# Candidato de publicación V24

El [perfil](../../scripts/systemd/torre/perfil-v24.sh) contiene los parámetros que comparten el servidor y el laboratorio. Arranca un mundo abierto con límites de admisión derivados del host, activa las leyes hasta `intentos` y usa dos dueños CPU. La pasarela sirve la aplicación habitual en modo observador y turbo. La cinta DVR recibe fotogramas y sucesos de la simulación y permite volver al presente. El visor de dos cortes en puerto 3143 usa el exportador de laboratorio y su propio contenido estático.

El perfil incluye cortes transferibles con teselas y personas directas, fotogramas de los dueños, sucesos directos, guardado vivo en el persistidor y hasta tres pasos de adelanto. Conserva el guardado cada 200 ticks, una ventana de sucesos de 2400 ticks y el formato `snapshot-parts-v5` con pesos separados. La cinta conserva el tope de 50 GB. Para la ruta GPU, la digestión presentó divergencia y la revalidación F2 no compensó en el paso completo con poblaciones pequeñas. La base F64 compartida sigue apagada hasta verificar paridad y latencia de la implementación segura.

El ensayo de Fedora con `1a9ed23` avanzó de 585 a 50.471 ticks en 7.200 s. Guardó hasta 50.400, recuperó un fotograma con la misma huella y reanudó en el tick 50.477 tras reabrir el 50.475. La afinidad efectiva fue 0–19. La evidencia y el origen del ensayo están en `AtlasParaIsa-anexo/archivo/v24-orquesta/fedora/observacion-sostenida-1a9ed23/`.

## Repetición sobre el SHA de salida

Carga el perfil desde el checkout exacto que vaya a publicarse y congela los parámetros del panel en un anfitrión con los límites de admisión objetivo. El panel compara el mundo y el despacho de dos dueños CPU y conserva la configuración efectiva. Las opciones de corte, escritura, solapamiento, emisión DVR y autenticación corresponden a las pruebas del servidor.

```bash
source scripts/systemd/torre/perfil-v24.sh
bash scripts/lab/panel-demo.sh --puerta fijar --perfil-entorno --salida "$MANIFIESTO"

# En copias del mismo SHA, con el mismo manifiesto.
bash scripts/lab/panel-demo.sh --puerta correr --manifiesto "$MANIFIESTO" \
  --semillas 7,51926,19101,19102 --salida "$RESULTADO_TORRE" --concurrencia 1
bash scripts/lab/panel-demo.sh --puerta correr --manifiesto "$MANIFIESTO" \
  --semillas 19103,19104,19105,19106 --salida "$RESULTADO_FEDORA" --concurrencia 1

# Una vez reunidas las dos salidas.
bash scripts/lab/panel-demo.sh --puerta evaluar "$RESULTADO_TORRE" "$RESULTADO_FEDORA"
```

Con Node y Chromium de Playwright instalados, ejecuta la observación desde ese checkout. Usa una ruta nueva en NVMe para los resultados y el mundo temporal.

```bash
npm run build
source scripts/systemd/torre/perfil-v24.sh
ATLAS_DEMO_OBSERVACION_SEGUNDOS=7200 timeout --signal=TERM --kill-after=30s 7800s \
  node scripts/lab/demo-observacion.mjs "$PWD" "$EVIDENCIA_NVME_NUEVA" --perfil-entorno
```

El ensayo usa un puerto de loopback efímero y un acceso sintético. Debe acreditar avance continuo, guardados, recuperación de un fotograma con la misma huella y reanudación con el mismo perfil. Revisa también las tres vistas de Chromium y los diagnósticos de salud. Comprueba por separado el lanzador en loopback con un mundo nuevo y acceso sintético, desde el arranque de producción hasta un guardado y la lectura autenticada de la cinta.

## Corte autorizado

La puerta requiere el panel formal de ocho semillas, la verificación del software y la prueba sostenida del SHA integrado. Registra el SHA y el informe de cada prueba antes de cambiar la publicación.

1. Prepara un worktree detached con el SHA aprobado y su build. Prepara un directorio de mundo vacío en NVMe y conserva el acceso privado copiando únicamente `access.scrypt` con modo `0600`. Reserva rutas propias de respaldo para mundo y cinta.
2. Guarda y verifica el respaldo de la publicación activa. Conserva su worktree, su mundo, su cinta, sus unidades y su entorno como conjunto de vuelta. Confirma el servicio y la ruta activa con el contrato vigente en [ESTADO](../ESTADO.md). Tras detener el servidor previo, verifica que terminó su proceso y liberó el puerto.
3. En el corte se elegiría `scripts/systemd/torre/publico-v24.sh` en `ExecStart` de la instancia única. El lanzador requiere `CARTA_DATA_DIR` y `PORT`. Conserva el bind, los orígenes HTTPS y los proxies autorizados del despliegue, y repunta los respaldos al nuevo mundo. Si se configura `CARTA_CINTA_DIR`, asígnale también una ruta exclusiva de V24. El lanzador `publico.sh` corresponde a V23.
4. Comprueba por el dominio el SHA servido, los activos, los guardados y la cinta DVR con acceso privado. Verifica el destino de ambos respaldos. Para volver, detén V24, confirma que el puerto quedó libre y restaura las unidades y el entorno junto al mundo, la cinta y el código previos. Los mundos se conservan en sus propias rutas.
