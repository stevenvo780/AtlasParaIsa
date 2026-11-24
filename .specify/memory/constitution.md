# Constitución de Una Carta Para Isa (AtlasParaIsa)

## Principios

### I. Mundo autónomo, observado, sin reloj humano
El servidor simula a la máxima velocidad que permite el hardware. `TICKS_PER_DAY = 2400` mide el tiempo del mundo, no el del observador. Toda vista, en vivo o histórica, es una reproducción de lo grabado a la velocidad que elija quien mira. Quien mira no dirige el curso del mundo. El servidor es la única autoridad sobre el estado; las cámaras son independientes.

El mundo público es irrepetible. Corre en paralelo libre, sin paridad entre hilos ni entre CPU y GPU, sin digestos de valor fijo, y nace sembrado con entropía real. Para pruebas y depuración se conserva el modo de un solo hilo (`T=1`), sin GPU y con semilla explícita: las leyes no leen el reloj de pared ni usan azar sin sembrar, y la misma semilla da la misma corrida.

Toda regla nueva tiene coste explícito (materia, energía, tiempo, desgaste) y una medición que puede refutarla. Nada se arregla con rescates ocultos ni con constantes que hacen imposible morir.

### II. Evidencia antes que impresión
Un cambio de reglas se acepta con medición: semillas, réplicas, un control y métricas con umbrales fijados antes de tocar el código. En el mundo público el efecto se lee en la distribución de las réplicas. En el modo de un solo hilo la semilla hace estable la prueba. El resultado se registra en [docs/EVIDENCIA.md](../../docs/EVIDENCIA.md) con SHA, semillas, réplicas, duración y límites. «Parece mejor» no cierra nada. Un veredicto desconocido no aprueba. El procedimiento está en [docs/VALIDACION.md](../../docs/VALIDACION.md).

### III. Reglas simples que se componen
Pocas leyes locales (cuerpo, necesidad, material, memoria) que generen complejidad, antes que sistemas nuevos con casos especiales. Si un comportamiento exige una excepción, primero se pregunta qué regla está mal.

### IV. Diversidad y muerte con sentido
Los habitantes difieren por genes, historia y aprendizaje, y mueren por causas legibles y raras a corto plazo. La homogeneidad y la mortalidad temprana son fallos de diseño, no rasgos. Cada muerte queda explicada en la crónica con causa material.

### V. Límite del hardware, sin reguladores
Hilos, GPU y orden de ejecución pueden cambiar el resultado. El límite lo pone el hardware: hilos, memoria y GPU. Ningún tope de software ni ningún regulador frena la natalidad, la fauna o la técnica según el reloj de pared. El servicio compite en igualdad con los demás trabajos de la máquina. Una aceleración se adopta si acelera el mundo real; el código de escala que el mundo real no ejecuta se conecta o se borra.

### VI. Átomos conservados, invariantes comprobadas
Suelo, agua, vida, cuerpos y objetos están hechos de átomos. Los átomos se conservan: cada alta y cada baja tiene asiento. La energía se contabiliza. También se comprueba lo que debe ser cierto siempre: nada negativo ni no finito, referencias válidas, identificadores únicos, población y fauna coherentes con sus índices. Una violación en el mundo público deja bitácora, porque esa corrida no se repite. Un fallo degrada (GPU a CPU), recarga el último guardado verificado o reinicia el servicio, y lo deja escrito. El estado persiste; no se borra el mundo para ocultar una corrupción.

### VII. Lo nuevo se ve, y la carta no miente
Toda función nueva tiene una señal en la vista. Lo que no se puede ver no se da por hecho. La interfaz enseña causas, no adornos. Un teléfono puede observar y leer la carta: la vista es una reproducción y no exige simular ni dibujar el mundo completo. La intimidad de la carta (S e I, recuerdos autorizados) se protege: sin biografía no revisada. S e I quedan fuera del éxito demográfico.

### VIII. Código limpio, sin sobredocumentación
Lo mínimo que cumple. Se borra lo que se sustituye: sin código muerto ni banderas viejas. Un comentario solo donde el porqué no sea evidente. Los principios viven aquí; cómo se valida un cambio, en la guía; la medición, en la evidencia.

## Restricciones técnicas
TypeScript estricto, Node 22, Vite, `ws`, SQLite nativo de Node (`node:sqlite`). Sin frameworks nuevos ni servicios externos. Sin LLM en el bucle de simulación. Cada versión publicada empieza en un mundo nuevo. El esquema se versiona, y un mundo de otra versión no se convierte en silencio. Origen único con `CARTA_ORIGIN`; nunca desactivar la comprobación de Host/Origin.

## Flujo de trabajo y puertas de calidad
1. `npm run typecheck` y las pruebas del cambio (invariantes y propiedades, en un solo hilo con semilla) verdes antes de cada commit. `npm run build` verde antes de publicar.
2. Antes de publicar, el panel corto: 4 semillas × 3 réplicas × 30 días. Después de publicar, el panel largo: 8 semillas × 60 días. Umbrales y diagnóstico, en la guía de validación.
3. Tareas independientes van en paralelo sobre ficheros distintos; una sola integración por fase.
4. Se integra a `main` con typecheck, pruebas y build verdes. Lo servido en `https://atlas.humanizar.tech` se reconstruye solo desde `main`.

## Gobernanza
Esta constitución manda sobre planes y tareas. Una excepción se justifica en el plan de la tarea, con la alternativa simple rechazada y por qué. Steven es la única autoridad sobre la carta (texto, recuerdos, S e I).

**Version**: 2.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-11-24
