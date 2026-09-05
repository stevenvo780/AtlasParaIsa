# Evidencia de la ampliación procedural

Fecha: 5 de septiembre de 2026. Revisión privada V2 con datos sintéticos. La voz final del autor, recuerdos reales y prueba en teléfono físico siguen pendientes.

## Resultado observable

El paisaje ocupa la pantalla completa y la cámara puede recorrer coordenadas positivas, negativas y lejanas. El terreno se genera por regiones de 16 × 16, con seis biomas, agua, vegetación, alimento, madera y piedra. Los dieciséis habitantes exploran, descubren regiones y construyen refugios mediante recursos y trabajo.

Se puede seleccionar cualquier habitante, seguirlo y pedirle desplazarse, explorar, recolectar, cultivar, construir o descansar. Las órdenes respetan desplazamiento físico, necesidades y costes; «Autonomía» devuelve la elección de tareas. Las habilidades y especialidades describen práctica adquirida; los valores por contexto cambian con resultados favorables o desfavorables.

Capturas del servidor real de prueba: [escritorio a pantalla completa](../artifacts/desktop-fullscreen.png), [móvil emulado](../artifacts/mobile-fullscreen.png), [inspector móvil](../artifacts/mobile-inspector.png) y [terreno lejano](../artifacts/distant-terrain.png).

## Comprobaciones ejecutadas

| Comprobación | Resultado | Evidencia |
|---|---|---|
| Tipos y pruebas Node | 77/77, cero fallos y cero skips | [Salida Node](../artifacts/tests-v2.txt) |
| Compilación Vite y servidor | Aprobada | [Salida](../artifacts/build-v2.txt) |
| Navegador Chromium | 5/5: pantalla completa, control individual, cámara lejana, móvil, conexión, revocación y pausa | [Salida](../artifacts/e2e-v2.txt) |
| Servidor compilado | Arranque, autenticación, avance, SIGKILL, recuperación y revocación | [Resultado](../artifacts/smoke.json) |
| Ejecución prolongada | 7200 pasos y guardado por paso; reinicio y copia idénticos, cero fallos | [Medición V2](../artifacts/soak-v2.json) |

Entorno: Node.js 22.22.3, TypeScript 7.0.2, Vite 8.2.2, Playwright 1.63.0 y Chromium 153. Escritorio 1440 × 900; móvil emulado 390 × 844 con tacto y movimiento reducido. No se observaron errores JavaScript ni desbordamiento horizontal en los recorridos.

La ejecución acelerada representó tres días del modelo en 243,26 segundos de pared: 255 regiones descubiertas, 212 refugios, 50 hechos de cuidado y 21 de aprendizaje. Paso y commit tuvieron p95 **62,07 ms**, máximo **640,96 ms** y RSS máximo **190,82 MiB**. El pico supera el presupuesto nominal de 100 ms y puede producir pausas visibles; no se acredita latencia constante.

La memoria activa alcanzó 62 regiones y 15 872 celdas. El archivo tuvo 375 regiones, 556 revisiones y una base de 35,29 MB. La vista inicial mayor medida fue 202 627 bytes. Una medición independiente de ventanas máximas de 96 × 64 llegó a aproximadamente 928 KB por vista; no fue una prueba de carga de red. La simulación activa es acotada, pero el archivo en disco puede crecer.

## Causalidad, recuperación y revisión

Las pruebas conservan los controles originales de alimento, agua/luz, techo, contacto compatible, recuerdo pertinente frente a ausente e irrelevante, y transmisión social con tres semillas emparejadas. Las ampliaciones comprueban:

- Generación independiente del orden, continuidad entre regiones y coordenadas negativas o lejanas.
- Cámara sin efectos sobre estado, azar, archivo ni descubrimientos.
- Construcción real seguida de retirada de la región, guardado, reinicio y regreso con recursos, estructura e historia conservados.
- Costes necesarios de materiales y trabajo; habilidades solo tras resultado útil.
- Fracaso que cambia una elección autónoma posterior, frente a control con actualización desactivada y los mismos costes.
- Contexto del aprendizaje capturado antes del resultado; efecto acotado de resiliencia sobre fatiga.
- Etiqueta de oficio sin efecto causal sobre la decisión.
- Desplazamiento físico, desvío alrededor de un río y final explícito de órdenes encerradas.
- Recolección dirigida que alcanza un recurso cercano y completa el trabajo aunque se reevalúe la intención durante el trayecto.
- Reintentos idempotentes y conflictos si cambia el habitante o la orden.
- Regiones archivadas con integridad comprobada y recuperación anterior sin incorporar revisiones futuras.

La migración se probó también con motor y SQLite V1 reales del commit `cb89b21`, tras 1800 pasos: se conservaron las 1120 celdas, los 16 cuerpos, 89 eventos, memorias, intenciones y azar. La región original se completa con celdas procedurales para formar regiones enteras. Las sesiones y huellas de gestos anteriores se conservan.

La revisión independiente detectó y se corrigieron atribución del aprendizaje al contexto posterior, metadatos activos insuficientemente validados, proyección de campos desconocidos, orden bloqueada sin terminación y excepción de archivo durante comunicación de una pausa. Sus reproducciones finales pasaron. Un error al leer una región de cámara no pausa la simulación; un fallo al confirmar el mundo conserva el estado guardado y usa una vista ya validada para comunicarlo.

## Revisión privada y conservación del progreso

La aplicación se mantiene en **https://172.26.0.4:3443**, con el acceso privado existente. Se hizo una copia íntegra antes de la ampliación y otra después del cierre ordenado de V1, en el directorio privado de revisión, fuera del repositorio. El último paso V1 antes del cambio fue **34155**.

El certificado es local autofirmado. Los procesos siguen en las sesiones tmux propias `carta-isa-world` y `carta-isa-https`; el mundo queda en `~/.local/state/atlas-para-isa-preview/world`. El lanzador conserva la credencial y corrige el destino explícito del panel tmux al detenerse.

La comprobación del servicio migrado está en [live-preview-v2.json](../artifacts/live-preview-v2.json) y su [captura](../artifacts/live-preview-v2.png). Corresponde a Chromium desde el contenedor; no verifica la ruta desde el navegador físico de la torre. No se contrató alojamiento ni se publicó en Internet.

## Trabajo paralelo

| Participante | Aporte de esta ampliación |
|---|---|
| Gemini 3.8 Flash High | Propuesta sustancial de ruido global, continuidad y biomas, adaptada y comprobada localmente |
| Claude Opus | Propuesta sustancial de HUD, controles e interacción, integrada y medida con navegador |
| Claude Fable | La llamada de esta fase agotó su tiempo sin resultado; no se cuenta como revisión exitosa |
| Codex y subagentes nativos | Arquitectura, motor, integración, archivo, migración, pruebas, revisión independiente y documentación |

No se enviaron credenciales ni recuerdos reales a proveedores. El juego funciona sin LLM durante la simulación. Los resultados multimodelo y mediciones de la versión base permanecen en el historial anterior de este documento; no se presentan como ejecuciones nuevas.

## Qué no se probó

- Teléfono físico, Safari/iOS, lector de pantalla y valoración personal de Isa.
- Alojamiento externo, reinicio automático del contenedor, fallo físico de disco y varios días de operación real.
- Rendimiento constante de 100 ms, miles de habitantes o almacenamiento ilimitado.
- Reproducción, herencia, evolución genética, ciudades complejas, gobiernos o mercados.
- Contenido íntimo real, conciencia, emociones humanas o validación general de una teoría científica.

Los mecanismos y límites están en [REGLAS.md](REGLAS.md) y las fuentes primarias en [CIENCIA.md](CIENCIA.md). Los artefactos V1 se conservan como evidencia histórica, separada de las mediciones V2.
