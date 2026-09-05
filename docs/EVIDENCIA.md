# Evidencia de la implementación

Fecha: 5 de septiembre de 2026. Prototipo local con datos sintéticos. No se ha publicado una URL ni configurado alojamiento. La apertura personal y los recuerdos reales siguen pendientes del autor.

Actualización operativa, 16:15 UTC: revisión privada arrancada dentro de `ws-steven` en **https://172.26.0.4:3443**, solicitada por Steven. Se verificaron HTTPS, login, cookie segura/HttpOnly y WebSocket en Chromium desde el contenedor. [Resultado del servicio vivo](../artifacts/live-preview.json) y [captura](../artifacts/live-preview.png). La ruta desde el navegador físico de la torre queda pendiente de su comprobación. El certificado es local autofirmado; los procesos viven en sesiones tmux propias y el mundo en `~/.local/state/atlas-para-isa-preview/world`. El [README](../README.md#revisar-desde-la-torre-que-aloja-docker) documenta arranque y cierre. No hay publicación en Internet ni alojamiento externo contratado.

## Resultado observable

La aplicación integra una región de 40 × 28 celdas, S e I, catorce vecinos, recursos finitos, cinco recuerdos identificados como ejemplos y una costumbre de compartir aprendida por observación. La cámara, las fichas, la crónica y los tres gestos funcionan en navegador. El servidor mantiene el mundo sin pestañas abiertas, guarda antes de confirmar un gesto y recupera el último paso confirmado al reiniciar.

Capturas de la aplicación ejecutándose con el servidor real: [escritorio](../artifacts/desktop.png) y [móvil emulado](../artifacts/mobile.png). El cliente no contiene credenciales, conversaciones originales ni una segunda simulación.

## Comprobaciones ejecutadas

| Gate | Resultado | Evidencia |
|---|---|---|
| `npm run check` | Tipos, 43 pruebas Node y compilación aprobados; cero fallos y cero skips. | [Salida literal](../artifacts/check.txt). |
| `npm run test:e2e` | 4/4 pruebas Chromium: escritorio, móvil táctil emulado, desconexión/reconexión/revocación y fallo de guardado con secuencia sin cambios. | [Salida literal](../artifacts/e2e.txt). |
| `npm run test:smoke` | Arranque del servidor compilado, configuración scrypt, lectura privada, avance sin navegador, reinicio tras `SIGKILL`, sesión persistida, revocación y salida ordenada. | [Resultado](../artifacts/smoke.json). |
| `npm run test:soak` | 12 000 pasos, cinco ciclos completos, guardado SQLite en cada paso, reapertura y copia exactamente iguales. | [Medición](../artifacts/soak.json). |

Entorno observado: Node.js 22.22.3, SQLite integrado, TypeScript 7.0.2, Vite 8.2.2, Playwright 1.63.0 y Chromium 153.0.8010.12. La prueba móvil usa un viewport de 390 × 844 con tacto y movimiento reducido; escritorio usa 1440 × 1100. Se comprobó ausencia de desbordamiento horizontal y errores JavaScript en los recorridos visuales.

La ejecución prolongada fue **acelerada**: veinte minutos del modelo en 25,52 segundos de pared. El percentil 95 de paso más commit fue 3,29 ms; el máximo, 57,28 ms; RSS máximo, 151,1 MiB. La proyección mayor medida ocupó 177 618 bytes. Quedaron guardados 166 hechos de cuidado, 34 de aprendizaje, 19 encuentros y 13 cambios ecológicos. Estas mediciones corresponden a este contenedor y esta semilla; no acreditan fiabilidad indefinida ni rendimiento en el teléfono de Isa.

## Contrastes y fallos corregidos

Las quince pruebas del mundo incluyen recuerdo pertinente frente a ausencia y recuerdo irrelevante; alimento y refugio presentes frente a agotados; contacto compatible frente a distancia o exploración; y aprendizaje activo frente a desactivado sin retirar la acción de compartir. La sociedad autónoma transmite la costumbre en tres semillas y cambia conductas de S e I. El historial de aprendizaje conserva su procedencia aunque se recorte la crónica visible.

Las dieciocho pruebas del servidor cubren rollback conjunto de estado, hechos y entradas; reintentos con el mismo identificador; conflicto de contenido; corrupción de estado y tablas; revocación antes de la transacción; caída del proceso; copias; y bloqueo del destino durante recuperación. Un reintento ya confirmado conserva su resultado si un guardado posterior falla. Las diez pruebas del cliente verifican secuencias, pausas, sesión revocada, confirmaciones, conectividad y respuestas HTTP tardías que no deben perder el gesto siguiente.

La revisión independiente detectó y se corrigieron: carrera del bloqueo de instancia, revocación entre recepción y commit, recreación silenciosa de tablas faltantes, respuesta incorrecta a un reintento durante pausa, pérdida del estado de pausa por secuencia repetida y controles bloqueados después de un rechazo definitivo. El navegador reveló además que desconectarse podía seguir mostrando «En vivo»; la versión comprobada escucha los cambios de conexión y detecta silencio del servidor.

## Trabajo entre modelos

| Modelo invocado | Aporte comprobado |
|---|---|
| Claude Opus, vía CLI nativo | Propuesta sustancial del renderer Canvas y dirección visual; adaptada y comprobada localmente. |
| Gemini 3.8 Flash High, vía Antigravity | Revisión causal incorporada: contacto mutuamente compatible, procedencia del aprendizaje y separación del azar ecológico. |
| Grok 4.6, vía CLI con sesión activa | Casos adversariales de commit, reintento, revocación y recuperación, utilizados para diseñar las pruebas. |
| Claude Fable 5.1 | Revisión independiente de fallos del servidor; sus conclusiones se contrastaron con reproducciones y pruebas. |
| Codex y subagentes nativos | Implementación e integración local, correcciones, pruebas, revisión de propuestas y documentación. |

Se enviaron especificaciones técnicas y código del prototipo mediante tareas de texto. No se enviaron recuerdos reales ni credenciales. La simulación entregada no necesita ninguno de estos proveedores para funcionar.

La selección se contrastó con los anuncios oficiales de [Gemini 3.8 Flash](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/) y [Claude Fable 5.1](https://www.anthropic.com/claude/fable), y el catálogo de [Grok](https://docs.x.ai/developers/models); la disponibilidad operativa se verificó con los CLIs de esta sesión.

## Qué no se probó y qué falta

- Teléfono físico de Isa, Safari/iOS, otros navegadores, lector de pantalla y valoración personal de la experiencia.
- HTTPS, proxy, disco y proceso persistente en un proveedor real; fallo físico de disco y operación durante días de tiempo real.
- Apertura escrita por Steven y recuerdos reales aprobados. No hay importación de chats ni biografía real. El retiro de biografía y sus derivados/copias se diseñará antes de incorporar esos datos.
- Mortalidad, generaciones, mundos infinitos y las demás ampliaciones excluidas por el plan.

Para abrir la aplicación local hay que configurar una contraseña privada con `npm run access -- init` y seguir el [README](../README.md). No se dejó un servicio público ni una contraseña de demostración permanente. Los mundos usados en pruebas se crearon en directorios temporales propios y se retiraron al terminar.
