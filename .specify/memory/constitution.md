# Constitución de Una Carta Para Isa (AtlasParaIsa)

## Principios

### I. Simulación autoritativa, determinista y verificable
El servidor es la única verdad: un mundo, un reloj (10 pasos/s, `TICKS_PER_DAY = 2400`), cámaras independientes. Toda regla nueva tiene semilla reproducible, coste explícito (materia, energía, tiempo, desgaste) y una prueba que puede refutarla. Nada se "arregla" con rescates ocultos ni con constantes que hacen imposible morir.

### II. Evidencia antes que impresión
Un cambio de reglas se acepta solo con medición: réplicas con semillas distintas, control (mundo sin el cambio) y métricas fijadas ANTES de tocar el código. El resultado se registra en `docs/EVIDENCIA.md` con SHA, semillas, duración y límites. "Parece mejor" no cierra nada.

### III. Reglas simples que se componen
Preferir pocas leyes locales (cuerpo, necesidad, material, memoria) que generen complejidad, a sistemas nuevos con casos especiales. Si un comportamiento exige una excepción, primero se pregunta qué regla está mal.

### IV. Diversidad y muerte con sentido
Los habitantes deben diferir por genes, historia y aprendizaje, y morir por causas legibles y raras a corto plazo. La homogeneidad y la mortalidad temprana son BUGS de diseño, no rasgos. Cada muerte queda explicada en la crónica con causa material.

### V. Rendimiento medido, cómputo aprovechado
La torre tiene 32 hilos, 125 GiB y dos GPU. Los experimentos corren en paralelo (procesos/worker_threads), los benchmarks comparan Node, workers y GPU con la misma escena, y la simulación de un mundo servido cabe en un núcleo sin bloquear la red (p95 de paso < 50 ms con 32 habitantes).

### VI. Experiencia que emociona sin mentir
La interfaz es bella y legible (WebGL2 con alternativa Canvas), enseña causas, no adornos. Un modo ligero garantiza que un teléfono real pueda observar y leer la carta aunque no simule ni dibuje el mundo completo. La intimidad de la carta (S e I, recuerdos autorizados) se protege: sin biografía no revisada.

## Restricciones técnicas
TypeScript estricto, Node 22, Vite, `ws`, SQLite nativo de Node (`node:sqlite`). Sin frameworks nuevos ni servicios externos. Sin LLM en el bucle de simulación. Cambios de esquema SQLite versionados con migración y política de "mundo nuevo por versión publicada" mientras dure la etapa de pruebas. Origen único con `CARTA_ORIGIN`; nunca desactivar la comprobación de Host/Origin.

## Flujo de trabajo y puertas de calidad
1. `npm run typecheck && npm test` verdes antes de cada commit; `npm run build` verde antes de publicar.
2. Toda tarea de reglas trae su experimento en `scripts/lab/` con semillas y réplicas, y su fila en `docs/EVIDENCIA.md`.
3. Tareas independientes se ejecutan en paralelo (subagentes) sobre ficheros distintos; una sola integración por fase.
4. Ramas `NNN-nombre`; se integra a `main` con typecheck, tests y build verdes. La versión servida en `https://atlas.humanizar.tech` se reconstruye solo desde `main`.

## Gobernanza
Esta constitución manda sobre planes y tareas. Una excepción debe justificarse en `plan.md` (Complexity Tracking) con la alternativa simple rechazada y por qué. Steven es la única autoridad sobre la carta (texto, recuerdos, S e I).

**Version**: 1.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
