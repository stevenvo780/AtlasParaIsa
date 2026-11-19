# Diagnóstico de estabilidad V13 y plan de remediación (2026-11-18)

Diagnóstico en solo lectura del mundo público **V13** (`AtlasParaIsa-anexo/mundos/v13-20260930/world.sqlite`, detenido limpiamente el 2026-11-17 13:13:51 -05 en `tick 22.206.700`, **día 9.252,79**, **641 habitantes vivos**, `369.708` nacimientos, `369.083` muertes, `0` OOM/crashes) y plan para lograr una simulación estable en disco, RAM, arranque y respaldos a largo plazo.

## 1. Causa raíz verificada (24,43 GiB en disco · 24,85 GiB RAM al arranque · timeouts de respaldo)

1. **91,03 % de la base (`22,24 GiB` de `24,43 GiB`) proviene de dos tablas append-only sin poda ni compactación**:
   - `technology_definitions`: **11.098.963 filas** = **16,17 GiB** (`66,18 %`, ~1.199 recetas/día simulado; la columna `signature` se triplica entre columna, JSON `body` e índice `UNIQUE(signature)`).
   - `technology_stats`: **29.274.568 filas** = **6,07 GiB** (`24,85 %`, ~3.164 filas/día simulado; guarda todas las versiones históricas aunque ningún lector de simulación consulta estadísticas pasadas).
   - El resto está acotado o es menor: `chunks` (`1,06 GiB`), `technology_executions` (`0,48 GiB`, 234,7 M recibos podados correctamente por `pruneExecutions`), `legacy` (`0,36 GiB`), `freelist` (`0,125 GiB`), `events` (`0,08 GiB`), `snapshot_parts` + `snapshots` (`0,08 GiB`).
2. **Por qué se inventan ~1.199 recetas/día indefinidamente** ([technology.ts](../src/world/technology.ts)):
   - `localInputs()` pasa masas enteras sin cuantizar (`residue` `150..1000`, `product` `200..1000`) a `programSignature`, generando cientos de definiciones distintas para el mismo programa según el desgaste exacto.
   - `technologyOpportunity()` usa un enfriamiento muy corto (`45` ticks), fuerza `research` cada 3 intentos (`attempts % 3 !== 0`) y, cuando el inventario (`16` objetos) está lleno o ya hay buenas herramientas, salta `craft` y recicla objetos en bucle (`recycleToFit`).
   - `finishProject()` registra permanentemente cualquier programa que no se desintegre aunque sea no-op o estrictamente dominado, y [index.ts](../src/world/index.ts) refuerza positivamente `research` (`+0,12`) incluso sin mejora funcional.
3. **Por qué `atlas-publico.service` marcó 24,85 GiB de pico RAM**:
   - No fue fuga de heap V8 (~426 MiB reales de Node); en cgroups v2 `memory.peak` cuenta el **page-cache del kernel**.
   - Al arrancar en frío, `Store.load()` ([store.ts](../src/server/store.ts)) ejecuta `PRAGMA quick_check` sobre los 24,43 GiB completos y `TechnologyArchive.summarizeDefinitions()` ([technology-archive.ts](../src/server/technology-archive.ts)) ejecuta `ORDER BY length(id), id` **sin índice** (`USE TEMP B-TREE FOR ORDER BY` sobre 11,1 M filas), barre definiciones dos veces, re-decodifica padres ~25 M veces, consulta `loadLegacy()` sin caché 11,1 M veces y re-decodifica definiciones 30 M veces al leer `technology_stats`.
4. **Por qué `scripts/respaldo.sh` falló por timeout (900 s) en el 50 % de las ejecuciones y llegó a 44,5 GiB de page-cache**:
   - `VACUUM INTO` reconstruye desde cero los índices B-tree de 11,1 M definiciones + 29,3 M stats hacia el HDD `/mnt/Juegos`, sin `TMPDIR`/`SQLITE_TMPDIR` ni cota `MemoryHigh=` en la unidad de respaldo.

## 2. Plan de estabilización en dos fases

### Fase A — Infraestructura y persistencia (**sin cambiar `RULES_VERSION` ni `digestoCanonico`**)

1. **A1 · Compactación incremental de `technology_stats` + índice `technology_stats(tick)`**: bajo `persistencia.ventanaEventosTicks > 0`, retener solo la última fila por receta `<= min(tick - ventana, minTick(slots 0..2))` en lotes acotados por guardado (sin cambiar lo que devuelven `load()` ni `previous()`).
2. **A2 · Eliminar el `TEMP B-TREE` y las re-decodificaciones $O(N)$ de `Store.load()`**:
   - Índice `CREATE INDEX IF NOT EXISTS technology_definitions_order ON technology_definitions(length(id), id)`.
   - Validar padres y `technology_stats` contra el mapa compacto ya verificado en el primer barrido (evita ~55 M re-decodificaciones SHA-256 + JSON).
   - Memoizar `loadLegacy()` con sentencia preparada durante `load()` y ejecutar `assertTechnologyCache` antes que `assertTechnologyReceipts`.
   - Cachear definiciones inmutables en `archivedRecipeMemo` por `(dataVersion, schemaCookie)` en vez de invalidarlas en cada `save()`.
3. **A3 · Escalar poda de ejecuciones, desacoplar `slot 2` y reclamar `freelist`**:
   - Escalar `TECHNOLOGY_PRUNE_ROWS_PER_SAVE` proporcionalmente a `pending.length * 2` para no saturarse por encima de ~700 habitantes.
   - Rotar `slot 2` por ticks persistidos en vez de un contador en memoria (evita que reinicios congelen la poda).
   - Activar `PRAGMA auto_vacuum = INCREMENTAL` + `incremental_vacuum(256)` en bases nuevas.
4. **A4 · Endurecer `scripts/respaldo.sh` y su unidad systemd**:
   - Fijar `TMPDIR`/`SQLITE_TMPDIR`, `MemoryHigh=3G`, `IOSchedulingClass=idle`, `Nice=15` en la unidad de respaldo.
   - Evaluar `sqlite3 -readonly "$DB" ".backup '$destino'"` (paso único WAL sin reconstruir índices, validado con [respaldo.test.ts](../tests/respaldo.test.ts)) y apuntar los respaldos a `/mnt/Data2` (mayor holgura libre) o con retención acotada.

### Fase B — Leyes locales de invención (**`RULES_VERSION` → 12**, con preregistro y panel de control en laboratorio)

Sin imponer ningún techo fijo de recetas ni generaciones (respetando [GOAL.md](../GOAL.md) y [REGLAS.md](REGLAS.md)):

1. **B1 · Cuantizar dosis en `localInputs()`**: escalonar `residue` y `product` (p. ej. múltiplos de 250/500) preservando la conservación entera exacta de masa.
2. **B2 · Puerta local de novedad o mejora en `finishProject()` + refuerzo honesto**: mantener intacto el redescubrimiento pagado de firmas existentes; registrar una definición nueva solo si descubre una clase funcional nueva o mejora/domina en Pareto localmente a sus padres, y aplicar refuerzo negativo a ensayos estériles.
3. **B3 · Enfriamiento y oportunidad realistas en `technologyOpportunity()`**: parametrizar el enfriamiento (histórico `45` en `HISTORICAL_PARAMS`; candidato V12 mayor), quitar el salto forzado `attempts % 3 !== 0` frente a `craft` necesario y bajar la especulación cuando el inventario ya está lleno de herramientas útiles.
4. **B4 · Evitar mutaciones no-op obvias en `proposeTechnologyProgram()`**: no proponer pasos sin efecto físico local (p. ej. `cool` sin `heat`, `separate` sobre un solo material).
