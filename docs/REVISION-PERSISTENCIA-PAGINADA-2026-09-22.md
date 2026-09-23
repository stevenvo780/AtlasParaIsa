# Persistencia paginada y recuperación verificada

La integración de T100 introduce SQLite5 y páginas de terreno en una transacción
con el snapshot y sus archivos. Conserva reglas9 y protocolo9. T100 y GateA0 siguen
abiertos: los límites por hardware y el roundtrip de dos millones de teselas son
el bloque siguiente. El build público permanece en V7`3dd615e`, SQLite4.

## Cambios ejecutables

Los snapshots pequeños conservan sus bytes compactos. Por encima de32768 teselas,
el terreno se codifica en páginas de4096 filas, referenciadas por SHA256 desde
un manifest; cada página tiene un máximo de4MiB y los metadatos8MiB. El umbral de
transporte no amplía por sí mismo los límites del mundo. Rotación, archivos,
páginas y recolección se confirman juntos; se conservan las páginas referenciadas
por los tres slots. Una lectura usa una transacción coherente. Los consumidores
de backups y benchmarks leen ambos formatos y la medida de tamaño incluye las
páginas, además del manifest.

La codificación rechaza NaN e infinitos en los cinco campos numéricos obligatorios
de teselas antes de escribir. La revisión anterior sólo los atrapaba en los
guardados profundos: JSON podía convertirlos a null en guardados ligeros, dejando
un cuerpo con checksum válido que no podía recargarse. Los controles cubren ambos
formatos, guardado en caliente y primero después de cargar, rollback de archivos
y colas, valores ordinarios y ceros negativos. No se encontró evidencia de que
la simulación sana produjera esos no finitos; el fallo reproducido era la barrera
de persistencia ante un estado inválido.

La recuperación explícita deja pasar errores operativos inesperados de lectura,
conservando su identidad. Después de revocar sesiones y recolectar páginas, exige
el cuerpo/digest/fecha elegidos y valida el mundo junto a sus archivos **antes de
COMMIT**. Una revisión independiente reprodujo y cerró seis fallos: mutación de
leyes o crónica mediante triggers y errores de lectura ocultados por fallback.
Pasaron24 controles independientes, sin alterar bases reales.
[Procedencia](evidencia-2026-09-22/t100-recovery-independent.json).

El primer gate de1142 pruebas pasó, pero la paridad externa detectó que las páginas
movían `tiles` al final de las propiedades raíz. La reparación conserva un marcador
null validado en su posición. Ocho negativos anteriores pasan ahora, además de
169 focales; el incidente de memoria del primer verificador y su sustitución
acotada están documentados en
[orden del snapshot](evidencia-2026-09-22/t100-snapshot-order.md).

## Controles de integración

La suite final de `b7b8583` pasó **1153/1153 pruebas, cero fallos y cero omisiones**,
en192,504s. Typecheck verde. Se ejecutó con NVRTC explícito para ambas GPU y un
límite de12GiB para el grupo de pruebas, sin swap; heap máximo4GiB por proceso.
Un corte mientras estaba activo registró un pico del grupo de5815562240 bytes;
no se presenta ese corte como el máximo definitivo del run completo.
[Ejecuciones y hashes de logs](evidencia-2026-09-22/t100-phase3-gates.json).

El build y smoke del commit exacto `b7b8583` pasan en otro worktree, con limpieza
comprobada. [Gate exacto](evidencia-2026-09-22/t100-phase3-exact-gate.json).
Seis trayectorias de1200 ticks comparan contra `ed4a6e0`: semillas1/51926/20260905,
formato compacto y páginas forzadas, guardado cada20, recarga600/1200 y clones
descartados cada120. Coinciden el World completo, bits numéricos, undefined, aliases,
orden, parámetros, digesto completo y diez tablas durables. Las únicas diferencias
permitidas de fuente son snapshot.ts, snapshot-parts.ts y store.ts; hashes iguales
antes y después. [Paridad completa](evidencia-2026-09-22/t100-phase3-parity.json).
El verificador usa heap4GiB y cgroup6GiB sin swap; máximo observado609760KiB.

El diagnóstico portable51926 también se integró: extrae ambos motores e instrumento
por SHA, valida los22 parámetros públicos capturados y requiere un piloto. Tres
pruebas incluyen dos pilotos reales de2400 ticks, contratos alterados y rechazo
de checkpoints con semilla/versión ajena aunque su checksum sea correcto.
Protocolo y límites: `docs/ops/default-seed-2026-09-22.md`, retirado de main con su instrumento y
conservado en el tag `archivo/campanas-20260922`.

## Lo que este bloque no acredita

- No se activaron límites por hardware, comportamiento de comunidades/fauna,
  paralelismo ni deshacer del paso. No hay certificación de escala2M ni p95<50ms.
- El perfil de rendimiento de páginas sigue siendo una medición compartida y
  acotada; no demuestra capacidad del servidor envejecido.
- Los validadores antiguos todavía pueden usar Error ordinario sin código como
  rechazo semántico. No se afirma clasificación universal de errores inesperados.
- El hueco del preflight de backup se cerró después en `efed3c7`: lectura de la
  copia terminada y recorrido de chunks e identidades diferidos. La revisión
  sigue siendo acotada a esos consumidores; [controles y límites](REVISION-BACKUP-2026-09-22.md).
- No se repitió Chromium en este cambio de persistencia; el gate anterior V9
  conserva18/18. No se publicó este build ni se reinició o repobló el mundo público.
- Los resultados demográficos siguen siendo una evidencia distinta; el contraste
  V8/V9 de trece días no demuestra mejora del recambio.
