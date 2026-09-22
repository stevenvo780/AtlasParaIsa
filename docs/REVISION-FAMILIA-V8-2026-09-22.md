# V8: reservar alimento mediante una cosecha local útil

Propuesta sobre `3dd615ee069d9d61f51a4c74f85d33c15a4583e0` (V7 publicado). Trabajo
aislado en `sprint/family-reserve-v8-20260922`. Reglas **8**, protocolo **9**, SQLite
**4**: cambia la planificación autónoma; no cambian el formato de red ni el archivo.
Esta rama no se publica ni declara terminado GOAL.md.

## Causa y corrección

La búsqueda para comer exige alimento >0.025. La intención familiar reutilizaba ese
filtro, aunque `forage` podía continuar con >=0.005 y almacenar una cosecha pequeña
útil pagando todo el trabajo. La réplica diagnóstica 1007 de V7 mostró 23 decisiones
con intención familiar y máximos locales de 0.00708–0.01257. Después predominó otro
bloqueo: individuos aptos dispersos, sin pareja apta cercana. Ese segundo fenómeno
no queda resuelto por permitir cosechas pequeñas.

La intención familiar vigente examina alimento físicamente alcanzable, próximo a
la pareja conocida. Usa la duración/esfuerzo reales de forrajeo, `planAffordable`,
decadencia observada, carga transportada y tasas corporales del terreno percibido.
Exige conservar la aptitud prevista y que el rendimiento potencial de consumir la
cosecha exceda el coste de disposición corporal. La previsión es privada; guardar
alimento no acredita energía ni reduce hambre. No predice regeneración ni conoce
terreno remoto. Clima futuro, competencia y movimiento de la pareja siguen siendo
inciertos. Se conserva el trabajo parcial solamente si corresponde al objetivo
familiar validado; las órdenes explícitas mantienen su prioridad existente.

No cambian el filtro para comer, los costes materiales/corporales, edad/genética,
gates reproductivos, población, S/I ni la carta. V7→V8 valida antes de migrar y sólo
cambia la versión, conservando estado, parámetros, historia y reservas.

## Refutación y costes

`tests/family-forage-planning.test.ts`: semillas 51926 y 51927, entorno declarado
seco con 0.012 de alimento finito. Sin órdenes posteriores, recoger en la misma
celda tarda 18 ticks y gana 0.0119; a dos pasos tarda 25 y gana 0.0118. Toda reserva
ganada coincide con el déficit del suelo frente al control de igual decadencia.
Energía disminuye, hambre/fatiga aumentan y no se fuerza ningún nacimiento.
Sin comida, confianza, lugar, cercanía, rendimiento neto o aptitud prevista se
rechaza el motivo. Siete pasos para esa cosecha cuestan más que su rendimiento
potencial y se rechazan. Hay controles de continuidad válida, objetivo viejo
inválido y orden explícita. Ablación previa V7: fallan 8 positivos y pasan 3
controles; quitar sólo la guarda de continuidad reproduce el objetivo incorrecto.

Validación sobre esta rama: focales 94/94; instrumento 3/3; `npm run typecheck` y
`npm run build` verdes. `npm test`: **912 pass, 0 fail, 3 skips**, 484.35 s; esas tres
pruebas no ejecutaron CUDA porque faltaba `COMPUTE_NVRTC` en ese comando. Log completo
`/tmp/atlas-family-v8-full.tap`; no se presenta ese resultado como paridad GPU.
Focal posterior con `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so`:
`tests/compute-ecology.test.ts` **14/14, cero omisiones**, 4.94 s; incluye GPU 0, GPU 1
y ambas juntas. Log `/tmp/atlas-family-v8-cuda.tap`. No se repitió la suite completa.

Microperfil previo, 300 consultas de calentamiento y 2000 medidas por brazo con
bloques alternados: CPU media control→propuesta 0.285702→0.286409 ms (16 personas,
una fuente) y 0.293877→0.406747 ms (64 personas, fuentes densas). Sólo mide elegir
en un fixture, no un paso de servidor, SQLite o p95 con gobernador.

## Controles históricos

Rebaseline explícito de dos pruebas de trayectoria; no se cambian sus horizontes,
semillas ni parámetros. Los controles aislados de agua/kernel retienen sus hashes.

| Control | V7 | V8 |
|---|---|---|
| Mundo 51926, 600 ticks | `06ce08ae78df91ac` | igual |
| Kernel aislado | `deabb0731215da45` | igual |
| Demografía 51926, día 1 | `32969bf8a6c5fd01` | igual |
| Demografía 51926, día 2 | `cc29d3747073ab13` | `93a4fb6e74d7fec3` |
| Demografía 51926, día 3 | `1ca1c608cd4a071f` | `3e1459914a7a5078` |
| Agua 4821, día 1, cuencas=1 | `6a049c8502a8b22cd7d6792b7a20f49f0a4e0641002d63e92cf5f9573e74dac9` | `ad4b5dd88eba765a3df24ccb96296ddfcc740312f4f4842f51c2ba25a4c5270b` |

Ablación adicional privada: V8 y todos los helpers físicos nuevos, reemplazando
sólo el selector familiar y su guarda de objetivo por el control previo. Reproduce
exactamente los cuatro hashes históricos de agua/demografía V7. Script
`/tmp/atlas-family-v8-selector-ablation.mts`, salida
`/tmp/atlas-family-v8-selector-ablation.log`. Esto atribuye el cambio de trayectoria
al selector, sin afirmar que la trayectoria V8 sea demográficamente mejor.

El estado t8000 de 51926 sigue teniendo 29 personas y 256 recetas. Medición UTF-8:
cámara 12×8 **193942 bytes**, cámara 40×28 **407936 bytes**; máximos 200/420 KiB
intactos. Ahorro frente a definiciones completas **142018 bytes**, campos de programa
omitidos **49900 bytes**. También pasan máximos 64/640 KiB y ratio 0.83. No se
modificó la prueba ni se aumentó ningún presupuesto.

## Experimento fijado antes de resultados

`scripts/lab/family-reserve-batch.ts prepare` congela V7 de `3dd615e` y esta fuente
V8, un instrumento común y sus hashes. `check <directorio>` verifica el contrato;
`run <directorio>` ejecuta tres pares **1007/1012/1013**, **13 días/31200 ticks**,
`engine=world`, Store real cada 20 ticks, seis procesos a nice 10, **una hora por
réplica en ambos brazos**, sin gobernador. Sólo escribe bajo
`artifacts/family-reserve-v8-20260922/`, rechaza sobrescribir corridas y conserva
bases/errores/timeout. No toca el lote reservado existente. 1007 es diagnóstico
conocido; los otros dos se eligieron sin leer sus resultados. No cambiar semillas,
horizonte ni deadline según el resultado candidato. Tiempo agotado no es éxito.

Registra mortalidad/causas, nacimientos, generaciones, cooperación, uso útil y su
beneficio separados entre mortales/S/I. Un observador externo puro registra
actividad de provisión por tick y snapshots de parejas/cuerpos cada 120 ticks.
Los deltas corporales/de reserva son **netos del tick**, pueden incluir eventos
simultáneos y no equivalen al coste aislado de trabajo. Las parejas son muestras,
no todas las oportunidades transitorias. No se atribuye una interrupción a una
causa interna no observable. Las pruebas del instrumento comparan la trayectoria
completa observada/control y rechazan contratos alterados.

Comparar únicamente intervalos equivalentes de cada par, incluyendo fallos y
réplicas incompletas. No agregar sólo las terminadas ni interpretar tres semillas
como una tasa poblacional. El antecedente 1007 antiguo llegó extinto en ambos
brazos a 30 días; esta corrección no demuestra por sí sola sostenibilidad ni explica
toda diferencia temporal de extinción. Faltan resultados de estos pares, revisión
independiente y gate de servidor antes de considerar integrar/publicar V8.

## Ejecución congelada

Lote `artifacts/family-reserve-v8-20260922/batch-2026-09-22T10-44-21-140Z`, preparado
y arrancado el 22 de septiembre. Seis hijos confirmados. SHA de origen de ambos
`3dd615ee069d9d61f51a4c74f85d33c15a4583e0`; la candidata declara `rootDirty: true`
porque se congeló antes del commit del módulo. Los hashes identifican el contenido
ejecutado, no se confunde ese origen con una revisión limpia del candidato:

- Fuente base: `783b2dc78b0361a51e390c2e015429a984c50f8b1b6ce73bbd941d7e4d30778d`.
- Fuente candidata: `43399ac163978a1ccaf5b3f30fbbc9e3e590c99a2da0cb1365cbfd87e8d2cbde`.
- Instrumento común: `12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542`.
- Lanzador: `51cca7ca31602cc40f361432bd42e65e5fab4edc4e8ba65787b1d97ed949fddb`.

Prioridad real comprobada al arrancar con `getpriority`/`sched_getscheduler`: las
seis réplicas heredaron nice 6 y SCHED_IDLE; el incremento `nice -n 10` dio **nice 16**
en todas. Más baja prioridad que la prevista, mismo trato a ambos brazos. No se
cambiaron prioridades, deadline ni fuentes una vez iniciado el lote. Sus tiempos
no miden capacidad del servidor. Los resultados de 13 días siguen pendientes.
