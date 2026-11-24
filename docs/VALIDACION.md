# Validación

Cómo se acepta un cambio bajo la [constitución](../.specify/memory/constitution.md) 2.0.0. El mundo público es irrepetible. Las pruebas que exigen la misma corrida usan el modo de un solo hilo (`T=1`), sin GPU y con semilla explícita. Los umbrales se fijan antes de tocar el código. Cada métrica se cierra en cumple, falla o desconocido, y desconocido no aprueba. El registro va a [EVIDENCIA.md](EVIDENCIA.md) con SHA, semillas, réplicas, duración y límites.

## Invariantes

Se comprueban en la suite y, por muestreo, en el mundo que corre. Son duras la conservación de átomos, la energía según el libro, nada negativo ni no finito, las referencias válidas, los identificadores únicos y la coherencia de población y fauna con sus índices. Una blanda se corrige y se cuenta. Una dura deja línea en la bitácora de invariantes. En una puerta: 0 violaciones duras, y blandas a lo sumo 1e-6 por comprobación de región.

## Propiedades, en un solo hilo con semilla

Las pruebas por propiedades corren en `T=1`, sin GPU y con semilla explícita. La entrada sale de esa semilla. Si una falla, imprime la semilla: en este modo, dos corridas con la misma semilla dan el mismo resultado, y el digesto de prueba sirve para comprobarlo. Un caso que se ejecuta con varios hilos o con GPU se repite tres veces y falla si falla alguna, porque ahí la corrida ya no se repite.

Cubren, como mínimo: un paso que conserva las invariantes; la ida y la vuelta de guardar y cargar; la restauración tras un fallo inyectado; acumulados que no decrecen e identificadores únicos; la conservación de átomos en una secuencia de operaciones; y un mundo que sigue siendo válido si la GPU se apaga a mitad de un paso.

## Panel corto, antes de publicar

4 semillas × 3 réplicas × 30 días. Semillas: 51926, 19104, 19101 y 19103. Una réplica es otro arranque del mismo mundo. Fuera del modo de un solo hilo, la misma semilla no repite la corrida. Son doce corridas. Un día de mundo son 2.400 ticks.

| | Umbral |
|---|---|
| M1 | 0 de 12 extinciones de mortales antes del día 30 |
| M2 | población mortal ≥ 16 el día 30 en ≥ 10 de 12, y el mínimo de los días 20 a 30 ≥ 8 |
| M3 | recambio (C2) y causas de muerte legibles con balance exacto (C6) |
| M4 | log₂(población del día 30 / población del día 15) dentro de [−1, +4] en ≥ 11 de 12; si no, revisión humana |
| M5 | 0 violaciones duras; blandas ≤ 1e-6 por comprobación de región |
| M6 | 0 pasos de más de 30 s; memoria residente ≤ 70 % de la RAM |

M1 informa y no cierra la puerta mientras la cohorte fundadora sea una sola generación de la misma edad: esa extinción temprana ya ocurre con las leyes anteriores. Cuando el arranque ya no dependa de esa cohorte, M1 vuelve a ser umbral duro.

Doce corridas ven una rotura grande. Con 0 extinciones, la cota superior al 95 % de la probabilidad de extinción queda cerca del 22 %. Una regresión fina puede no verse.

## Panel largo, después de publicar

8 semillas × 60 días, con los criterios C1 a C8 de [criterio-terminado.mts](../scripts/lab/criterio-terminado.mts): supervivencia, recambio, generaciones, cooperación, conflictos, muertes, tecnología y diversidad. Corre en el laboratorio después de publicar la versión en su mundo nuevo. No sustituye al panel corto.

## Un fallo que no se puede reproducir

La corrida pública no se repite. La bitácora de invariantes señala el tick, la regla y la región. El volcado del estado en la violación, los pasos recientes y la cinta dejan ver lo ocurrido. Para estimar si vuelve a pasar se recarga el guardado anterior y se avanza hasta ese tick N veces, en un solo hilo y con más hilos. El informe es una fracción: «ocurre en k de N».
