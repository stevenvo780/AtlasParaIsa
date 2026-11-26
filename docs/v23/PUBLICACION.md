# Publicación de V23 en la torre

Este procedimiento prepara el relevo de V22. La ejecución de hoy es el ensayo local y la simulación del procedimiento. La publicación requiere una ventana autorizada por Steven y el SHA de integración aprobado. Las cifras y el resultado del ensayo se registran en el [contrato de preparación](../evidencia-2026-11-25/publication-v23.json).

## Qué cambia

Steven abrirá un mundo nuevo desde el mismo dominio. La aplicación pedirá otra vez la contraseña habitual porque el mundo arranca con su propia base de datos. La cinta de V23 empieza con ese mundo y permite recorrer lo grabado desde el reproductor.

| Aspecto | Configuración V23 |
|---|---|
| Cómputo | Motor turbo con un dueño y CPU, `CARTA_MOTOR_HILOS=1`, sin dispositivos asignados a `CARTA_MOTOR_GPU`. Transporte y escritura de la cinta en sus propios hilos. |
| Leyes | `guardadoCompleto`, `fotograma`, `cohesion`, `natalidad`, `comunidades`, `materia`, `cuerpos`, `fauna`, `tecnica`, `obra` e `intentos` encendidos. `duenos`, `rebalanceo` y `materiaGpu` quedan apagados. |
| Mundo | `AtlasParaIsa-anexo/mundos/v23-AAAAMMDD`, recién creado y sembrado con entropía al arrancar. El guardado completo conserva en la misma operación el mundo y su materia. Cadencia de guardado de 200 ticks y ventana de eventos de 2.400 ticks. |
| Observación | Modo observador y deltas de red. La cinta binaria multinivel reside en `cinta/`, con índice `cinta.idx.sqlite` y segmentos por nivel. Poda a partir de un presupuesto de 50.000.000.000 B (50 GB decimales) que también reserva 4 GiB libres para el disco del mundo. |
| Retiradas | `CARTA_TAPE_MAX_FRAMES`, configuración CUDA, `gobernador.presupuestoMs=5000` y los valores fijos de `limites.*` de V22. El servidor calcula los límites de anticorrupción de un mundo abierto nuevo a partir del anfitrión. |
| Respaldo | Cada hora, copia SQLite verificada del mundo en el destino de la V23 con retención de 24. La cinta tiene su propio respaldo horario de L1–L4. |

El launcher versionado anterior a este cambio describe V22 (`a7ec79b`) sobre el mundo V21. `docs/ESTADO.md` describe un relevo previo de V21, y la viñeta de `CLAUDE.md` todavía describe V14. Para preparar el retorno, identifica el binario, el mundo y las unidades que atienden el dominio justo antes de la intervención. Guarda sus rutas y configuración tal como estén instaladas.

## Simulación y publicación

La simulación muestra todo el procedimiento. Es la única modalidad que corresponde ejecutar durante esta preparación. Se puede añadir un SHA y, a continuación, una fecha `AAAAMMDD`. Sin argumentos adicionales se usan `HEAD` y la fecha de la torre.

```bash
bash scripts/publicar-v23.sh --simular
```

En la ventana autorizada, ejecuta `bash scripts/publicar-v23.sh SHA AAAAMMDD` desde un worktree de preparación con `node_modules` local. Sustituye `SHA` y `AAAAMMDD` por el commit y la fecha aprobados. Conserva `AtlasParaIsa-anexo/publicaciones/v23-AAAAMMDD-rollback/`, el expediente de retorno que genera el script.

1. Comprobar que el proceso público ejecuta `publico-v22` y tiene abierto `mundos/v21-20261124/world.sqlite`. Verificar el montaje de respaldos y el espacio. Guardar el launcher de V22, las unidades y el estado de los timers en el expediente.
2. Ejecutar `scripts/deploy-check.sh` sobre el SHA final y conservar el informe en el expediente. El build y el smoke se hacen en un worktree aislado con una copia de las dependencias instaladas.
3. Pausar los respaldos horarios y el vigilante durante el corte. Ejecutar `atlas-respaldo-publico.service` y comprobar que generó una copia nueva e íntegra bajo `/mnt/Data2/respaldos-atlas-v21`. El respaldo comprueba el SQLite antes de comprimir. Guardar su ruta en el expediente.
4. Parar el servicio público y verificar que el proceso terminó y el socket `100.64.0.1:3000` quedó libre.
5. Crear `AtlasParaIsa-anexo/worktrees/publico-v23-AAAAMMDD` en detached HEAD, copiar `node_modules` y construir allí. Verificar el HTML del cliente y el entrypoint del servidor.
6. Crear `mundos/v23-AAAAMMDD`. Solo se transfiere `access.scrypt` desde el mundo anterior, con permisos `0600`.
7. Instalar las unidades V23 de servidor y respaldo y su archivo `~/.config/atlas-para-isa/publicacion-v23.env`. Este archivo indica las rutas del worktree, del mundo y de los respaldos. Los destinos son `/mnt/Data2/respaldos-atlas-v23-AAAAMMDD` para el mundo y el subdirectorio `cinta/` para L1–L4. Ejecutar `systemctl --user daemon-reload`.
8. Arrancar el servicio nuevo y comprobar `/health` y los estáticos por `https://atlas.humanizar.tech`. Exigir avance de ticks, guardado con materia y `ultimoTickGuardado` positivo, con `estado=ok`, `recargas=0` y sin violaciones. Habilitar los timers V23 y recuperar el estado previo del vigilante. Completar con una entrada de Steven desde el navegador y comprobar que se muestran el mundo y la cinta. Añadir la evidencia del despliegue al contrato antes de actualizar `docs/ESTADO.md`.

## Retorno a V22

Usa el expediente generado para esa publicación. Si el fallo ocurrió con V22 todavía en marcha y las unidades anteriores intactas, basta con iniciar los timers que figuren en `timers-activos.txt` si ya se habían pausado. Si se detuvo V22, sigue estos pasos.

1. Detén `atlas-vigilante.timer`, `atlas-respaldo-publico.timer` y `atlas-respaldo-cinta.timer`, y los auxiliares que estén ejecutándose. Si se arrancó V23, detén `atlas-publico.service`. Comprueba que el proceso terminó y el socket quedó libre.
2. Deshabilita los timers de `timers-habilitados-por-v23.txt`. Restaura en `~/.config/systemd/user/` cada unidad guardada en `unidades/`, conservando enlaces y permisos. Si alguna de las cinco unidades instaladas para V23 carece de copia anterior, retira ese archivo nuevo. Retira `~/.config/atlas-para-isa/publicacion-v23.env`, creado para este corte.
3. Instala `zz-v22-rollback.conf` del expediente en `~/.config/systemd/user/atlas-publico.service.d/` con permisos `0644`. El drop-in indica que `atlas-publico.service` debe ejecutar el `publico-v22.sh` conservado en el expediente. Así el retorno usa la configuración V22 aunque la unidad original apuntara al launcher compartido del árbol principal. Conserva ambos archivos en sus rutas mientras esté activo el retorno.
4. Ejecuta `systemctl --user daemon-reload`, arranca `atlas-publico.service` e inicia los timers de `timers-activos.txt`. Conserva el directorio V23 para diagnóstico y utiliza el worktree compilado y el mundo originales para V22.

Tras restaurar V22, comprueba por el dominio que `/health` responde, que los ticks avanzan y que el cliente vuelve a cargar. Verifica que el respaldo horario apunta al mundo de V22. Si su mundo original ya no se puede abrir, conserva el fichero y el respaldo previo al corte para una restauración explícita a una ruta separada. El SQLite de V23 solo se abre con el servidor V23.

## Límites del ensayo y riesgos

- La medición de 15 minutos usa loopback, almacenamiento temporal en `/tmp` y la prioridad del proceso de ensayo. El rendimiento en el NVMe público dependerá de la semilla, el tamaño del mundo y la carga de la torre. La proyección a 50 GB extrapola la pendiente observada y la poda puede empezar antes por cuota de nivel o espacio libre.
- Durante el ensayo la cinta declaró una laguna interior entre los ticks 2.085 y 2.093. El motor registró un fotograma saltado y los cortes consultados se pudieron leer antes y después del reinicio. El contrato conserva también las lagunas de los bordes.
- La protección de 50 GB cubre la cinta activa. El respaldo de cinta conserva L1–L4 y su herramienta no rota automáticamente las generaciones. El espacio consumido por las copias del mundo y de la cinta se vigila en `/mnt/Data2`.
- Dueños y rebalanceo siguen bloqueados por admisión de huella de fauna entre dueños. La GPU material sigue pendiente por el plazo y el coste medidos en las tarjetas. Las conclusiones demográficas de largo plazo dependen del panel del integrador.
- El dominio, el proxy y el montaje de respaldo se verifican durante la publicación autorizada. El ensayo local tiene su propia contraseña desechable y su propio puerto.

## Texto propuesto para `docs/ESTADO.md`

Insertar después del corte y completar los campos entre corchetes con evidencia de la publicación.

```markdown
## Vigente (mundo V23 desde [fecha y hora -05], en la TORRE)

Código `[SHA]`, worktree detached `AtlasParaIsa-anexo/worktrees/[worktree]`, mundo
`AtlasParaIsa-anexo/mundos/v23-[AAAAMMDD]`. Servido en <https://atlas.humanizar.tech>
y por TLS directo en VPN/LAN. Motor turbo, un dueño CPU, reglas V23 hasta `intentos`,
observador, guardado completo de mundo y materia y cinta binaria por niveles con presupuesto de 50 GB.
Se verificaron el avance, el guardado y los estáticos por el dominio en [hora] y el acceso al cliente en [hora].
Respaldos horarios del mundo en `[destino mundo]` y de L1–L4 en `[destino cinta]`.
V22 queda disponible para retorno con su worktree y su mundo originales.
[Contrato V23](evidencia-2026-11-25/publication-v23.json).
```

## Viñeta propuesta para `CLAUDE.md`

> - **Publicación vigente**. Ver `docs/ESTADO.md` para el SHA, mundo, rutas y evidencia del despliegue. La torre publica mediante `scripts/publicar-v23.sh` desde un worktree de preparación y con autorización de Steven. Usar `--simular` para revisar los pasos y `docs/v23/PUBLICACION.md` para ejecutar el corte y preparar el retorno. Construir en el worktree detached de publicación. Conservar el worktree, mundo y configuración anteriores hasta cerrar la ventana de retorno.
