# T100, fase 4a: admisión explícita persistida

Base física reglas 9, `3d1b644`, más la corrección de orden de snapshots `b7b8583`
(cherry local `fb3691c`). El contrato previo está en `docs/T100-LIMITES-CONTRATO.md`.

`params.limites` ahora gobierna la admisión de teselas, chunks, comunidades y fauna
en mundos actuales. El validador de estructuras usa también la capacidad de terreno.
`setParams` rechaza los cuatro límites si no son enteros seguros positivos. Las versiones
anteriores a 9 conservan los límites históricos durante su validación previa a migrar.

El envelope lleva `limitsProfile` versión 1 con los cuatro números explícitos, que
deben coincidir con los parámetros. Inline y páginas comprueban cantidades antes de
expandir las tuplas. El perfil desaparece del World reconstruido; el orden del resto
de claves se conserva. El snapshot actual añade este metadato: sus bytes completos
ya no son los del formato anterior. Las tuplas/páginas y el encoder histórico conservan
sus bytes ordinarios, y se mantiene el control de `-0` y opcionales ausentes.

La escritura valida las cantidades incluso en el guardado ligero; límites incumplidos
no se convierten en un snapshot durable inválido. Los lectores legacy sin perfil
verifican primero topes históricos, aunque params T102 declare límites amplios. Los
parámetros se conservan al migrar y el siguiente guardado declara el perfil. Esto activa
para validación opciones previamente reservadas, sin consultar hardware.

## Evidencia acotada

- Antes: 18 casos T100, **17 rojos y 1 control legacy verde**; registro
  `/tmp/atlas-t100-preflight/limits-red.tap`, sobre la base `3d1b644` sin fuentes nuevas.
- Después: **18/18 T100 verdes**, incluido SQLite real cerrado/reabierto con 65.792
  teselas y 257 chunks, doce comunidades, límites exactos y una unidad por encima,
  perfiles corruptos con checksum válido en ambos transportes y prohibición de bypass
  legacy. Se compara el digesto después de save y se verifican todas las tablas al rechazo.
- Focal conjunto: **367/367, cero skips**, 17,46 s; snapshot, Store, archivos, previous,
  parámetros, fauna y V1. Registro `/tmp/atlas-t100-preflight/limits-focal-final.tap`.
- `npm run typecheck` verde; no se ejecutó una suite completa propia.

Los tests de bytes se actualizaron para declarar exclusivamente el nuevo perfil;
conservan comparación exacta y un control independiente del encoder histórico sin perfil.
Sus fallos muestran mensajes acotados, evitando formatear cuerpos grandes en una aserción.

## Alcance pendiente

T100 continúa abierto: faltan resolver defaults host, admisión al activar/materializar,
ley 10 de comunidades/fauna y prueba de 2.097.152 celdas. El gate de fundación de ocho
comunidades y la política de reproducción de fauna de reglas 9 no se modificaron.
El guard de fauna al entrar a stepAnimals usa el parámetro; no promete rollback de un
stepWorld in-place que ya haya avanzado otras fases. Esta unidad no altera el gobernador,
sus presupuestos ni la cadencia de persistencia, y no acredita rendimiento de servidor.

**El hardware no cambia el resultado de esta fase:** sus límites son los parámetros
deterministas persistidos; no existe ninguna lectura de capacidad del host en el motor
ni en los lectores de snapshots. La resolución ambiental futura se limitará a crear
mundos nuevos, antes de persistir sus valores efectivos.
