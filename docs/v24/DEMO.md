# Primer demo de Una Carta Para Isa

El demo debe permitir entrar, orientarse en un paisaje vivo, seguir a un habitante y volver a un momento de su historia. La simulación avanza a la velocidad que permita el equipo. La cinta tiene su propio reloj y la cámara no decide qué regiones existen ni qué sucede en ellas. La intención y el alcance científico siguen en [GOAL.md](../../GOAL.md).

## Qué debe poder observarse

| Experiencia | Evidencia |
|---|---|
| El agua cambia lo que hace un cuerpo | Cotejar una bebida con la cantidad finita extraída y el alivio de sed. Un cuerpo que encuentra agotada la fuente no obtiene ese alivio. |
| Un camino afecta a quien lo transita | Con dos rutas comparables, observar preferencia y coste cuando una tiene pavimento material. Transferir o desgastar ese material debe modificar la ventaja. |
| Una casa ofrece refugio | En lluvia equivalente, comparar una cubierta instalada con la misma obra tras perder la cubierta. Cotejar salud y balance material. |
| Una historia es legible en el teléfono | Abrir una vida, llegar a Historia y usar pausa, línea de tiempo y Presente sin perder la ficha. Verificar el intervalo servido y el paisaje en escritorio y móvil. |
| El mundo sigue cuando nadie lo mira | Comparar una captura con el mundo guardado, reiniciar sobre una copia de laboratorio y volver a leer el corte en la cinta. La cámara y el ritmo de reproducción son independientes. |

Las pruebas causales pueden intervenir en un fixture para aislar un efecto. El demo presenta como emergente solo lo que se haya observado surgir en una corrida sin esa intervención. Registrar la procedencia de cada observación.

## Cómo se construye y se mide

1. Agrupar cambios disjuntos de leyes, instrumentos y vista en una ola. Conservar las pruebas deterministas cortas, concentradas en el mecanismo alterado. Revisar de forma independiente el balance material, el transporte entre dueños y el guardado.
2. Integrar sobre un SHA y reproducir un recorrido real de la carta en Chromium. Usar credenciales y mundos de laboratorio, sin contenido nuevo de S e I. Guardar capturas locales y errores de interfaz.
3. Ejecutar una sola comparación por ventana final con los mismos estados de partida. Medir CPU con uno y dos dueños y dos dueños con GPU0. Comparar una siembra y un guardado material sellado con el mismo reloj inicial dentro de cada pareja. Reportar p50/p95/p99, tiempo de paso y de espera, RAM, tandas CUDA confirmadas dentro de la ventana, tráfico, caída a CPU y guardados. Se elige por el paso completo y la integridad.
4. Reservar la prueba prolongada de servidor, el panel de semillas y el crecimiento a escala para el candidato que supere esos controles. Registrar mortales vivos, residentes y activos por ventana, además del territorio. El volumen almacenado y la escala que se puede simular son mediciones distintas.

Las responsabilidades de CPU, VRAM, RAM y discos están en [HARDWARE.md](HARDWARE.md). El material de la carta y los recuerdos autorizados solo los cambia Steven.

## Primer corte medido

En `4deaee1`, las pruebas de laboratorio acreditaron bebida y alivio de sed con débito material, preferencia de ruta por piedra instalada y refugio bajo una cubierta que pierde su efecto al desgastarse o desmontarse. Las 11 pruebas focales y la compilación pasaron. Un recorrido autenticado en Chromium abrió Historia, pausó la cinta, buscó un corte anterior y volvió al presente con la ficha abierta en 1440 × 900 y 390 × 844.

| Escena | CPU y un dueño | CPU y dos dueños | GPU0 y dos dueños |
|---|---:|---:|---:|
| Siembra de 200 mortales | 95,6 ms/paso | 73,5 ms/paso | 76,0 ms/paso |
| Copia de laboratorio desde el tick 3.316 | 88,3 ms/paso | 86,9 ms/paso | 91,8 ms/paso |

Son medias de dos bloques con 30 pasos de calentamiento y 60 medidos por brazo, en los mismos seis núcleos físicos del primer dominio L3. Las 12 corridas conservaron el balance exacto y tuvieron cero violaciones. En 320 tandas confirmadas, la 5070 Ti reportó 0,22 ms por tanda y el recorrido observado por el dueño promedió 2,03 ms. En estas escenas la referencia para la siguiente ola es CPU. La selección final exige medir el candidato con las leyes integradas y una variedad mayor de cargas.
