# Modelo de datos y capacidades requeridas

Estado R1: diseño revisable. Los nombres exactos del wire contract están en [schema](contracts/observation.schema.json); esta tabla identifica brechas según las fuentes asignadas, sin búsqueda de src ni verificación de nuevas campañas.

## Entidades, relaciones y transición

`RunManifest` identifica versión/semilla/params/estado inicial/inputs/gobernador/backend/intervenciones y control. Tiene una o más épocas; `Epoch` tiene apertura confirmada, registros con secuencia y cierre común. Estado planeado→en curso→complete/partial/aborted; nueva apertura tras history-gap inicia nueva época sin recuperar lo perdido. Ventana abierta en start y cerrada en end; ningún record tras actualWindow.endTick acredita esa época.

`Capability` declara disponible/partial/unavailable por familia/campos. `Stream` declara cobertura y oportunidades, no prueba por sí sola su completitud. `ObservationRecord` contiene familia/payload y refs a entradas/efectos/procedencia; estructura estricta por familia. Las ausencias se alojan en fieldCoverage por campo, capability/gaps; conservar payload parcial no vacío con valores válidos, jamás ceros ficticios. causalContext/source-order conserva evento y fase común entre familias; sin orden fuente causalUNKNOWN.

`Stock` pertenece a frontera/material/owner/región/escala/reloj y corte. `Flow` referencia extremos/material/tipo/conversión: interno sale y entra con único transferId; externo cruza frontera; consumo/pérdida abandonan compartimentos según definición; residuo retenido cambia stock, no salida. Apertura+cierre incluyen protegidos. Cálculo por frontera limitada no se promueve a frontera mundial completa.

`Person/Product/Structure/Knowledge` preservan identidad material, autoría y genealogía. `Service` enlaza efecto aplicado con usuario/receptor/función/pago/causa; `Replacement` enlaza viejo con nuevo y sus servicios, no sólo receta. `Exposure` separa activo/archivo/multiescala con reloj local; `Death` incluye todos los eventos disponibles de vida corta y motivo explícito de límites. `Migration` registra cohorte, viabilidad, viaje, residencia y consumo, independiente de visita/home etiquetado.

`Role/Conflict/Ecology/Rejection` (Rejection incluye accepted/rejected y oportunidades/períodos) registran consecuencias locales y gates, no asignan conductas al motor. `Digest/Cost/Fault/Review/Method` son artefactos de puerta separados; hash físico no sustituye recuperación durable de historia ni recibo personal.

`Evaluation` conserva subveredictos y calidad de inputs, profile hash y refs. `Panel` referencia resultados de las semillas planeadas, no copia sólo las aprobadas. Los resultados son inmutables respecto a un perfil sellado; nuevo dato/perfil crea otra evaluación identificada, no cambia una anterior en silencio.

## Medidas existentes y ausencias a resolver

| C/familias | Evidencia actual en fuentes asignadas | Brecha que R2 debe declarar/observar |
|---|---|---|
| C9 structure/exposure/service | B01/A: estructuras/uses agregados;0 historia diaria estructural en auditoría | ledger ID/día, usuarios mortales, exposición, coste y efecto causal marginal; no se infiere de uses |
| C10 structure/repair/exposure | REGLAS describe desgaste/reparación; archivo congelado | secuencia de condición/lluvia/ley SHA/pago/beneficio; política ruina no decidida |
| C11 replacement/product/flow/knowledge | B03: observador anterior boundary=not-modeled, sin mantenimiento acreditado | identidad de lotes/recambios, origen completo, funciones indispensables, proveedor causal |
| C12 boundary/stock/flow/service | REGLAS: apertura tecnológica parcial y recibos; agua contenida con balance concreto | apertura de materia prima general/cuerpo/ecología/obras y flujos globales por tick; lotes continuos no acreditados por recibos agrupados |
| C13 person/death | C6 totales/causas y balance demográfico; no edad/historia desde esos totales | birth/death IDs, edad/localidad/eventos previos, censura/seguimiento y control8d |
| C14 knowledge/product/service | catálogo/conocimiento/enseñanza existentes, controles históricos locales | censo completo de conocedores, cadenas mortales con pago, dos recambios y pérdida total/redescubrimiento |
| C15 product/service | firmas/capacidades/caché archivo existentes, novedad de receta≠función | firma/mapeo preregistrados y servicios atribuibles a novedades; ablación causal; fixture archivo separado |
| C16 migration/exposure/stock | cambiosHogar/approachHogar citados en B08 | destino viable, viaje/consumo/permanencia, denominador expuesto/muertos, abandono con10d completos |
| C17 role/service/knowledge | oficio por resultados descrito; instituciones no acreditadas | matriz actor→función→receptor y tiempo; perfiles/control de proveedor e institución causal; no crear institución desde observer |
| C18 conflict/service/flow | C5 contador, reglas locales documentadas históricamente | episodios pareja/fuente/necesidades/coste/consumo/oportunidad recurrente/on-off |
| C19 ecology/exposure/stock/digest | fauna/material consumido históricos; lejanos congelados en reglas | clocks simultáneos y avance según política,4 regiones, flujos escala, cámaras0/1/12; falta de avance es brecha del motor, no del instrumento |
| C20 rejection/cost/digest | cupo40/d y gobernador documentados; no motivos completos | gates por intento y periodos de freno, inputs/decisiones gobernador, horizonte100d |
| C21 fault/digest | recuperación/copia y contratos históricos | nueva matriz≥10×2 fases,12clientes1h y vector durable de historia/inventarios/IDs en copias |
| C22 digest/cost | perfiles/kernel CPU/GPU históricos | escena/host/input trace equivalentes, coste integral/fps/red/RAM/disco, presupuestos actuales; disponibilidad backends no verificada |
| C23 review/service | E2E emulado histórico, pendientes teléfono/carta | tareas físicas/inspectores/contrafactuales y recibo de Steven actual; nunca importar biografía real |
| C24 method/cost/service | neuroevolución sin empezar en evidencia | preregistro/reserva/intervención/revisión del instrumento; training posterior pendiente |

Los términos “existe” de esta tabla describen documentación de la fuente y su SHA/fecha; R1 no certifica adapters actuales. R2 debe registrar `sourceRefs` y verificar formato de sus inputs antes de declarar available. Si un campo no se puede observar sin editar física/src, declararlo unavailable y abrir brecha separada. No extender ownership sólo porque falta una medida.

## Invariantes del modelo

IDs únicos y enteros seguros; cantidades finitas; windows/seq comunes por época; protección transitiva conservada; unidades/conversiones explícitas; cada ref de efecto/pago resoluble; apertura/cierre física independiente de cámara; stocks archivados al reloj real de su estado; denominadores fijos sin excluir muertes; control preregistrado válido; manifest de artefactos por hash. Las condiciones semánticas no expresables en JSON Schema son obligatorias en R2 según contracts/README. Ejemplo unavailable valida forma, no verdad ni PASS.

## Tipos conservados en v3

`RealMemoryInventory` es el censo completo de todos los recuerdos reales incorporados al contentHash, IDs/hashes/incorporación y autorización individual; `MemoryAuthorization` es recibo de Steven por ID/hash/contenido. `PersonalReceipt.authorizedMemoryIds` es resumen, no censo. Sólo metadata; `SyntheticReviewOracle` prueba expected técnico sin suplantar al recibo real. `ParameterSet`, `ConversionMatrix`, `ReproductionGates`, `ReproductionCoverage`, `SourceOrder`, `CausalPair`, `RunManifest`, `MetricDefinitions` y `SourceMetadata` completan tipos de referencia; catálogo exacto30 tipos en evidence.schema y reference-types.v3. Fuente documental no sustituye flujo, efecto o aprobación.

`CausalPair` exige control no intervenido en referencia/retirada/restauración simultáneas equivalentes; R y Q usan control contemporáneo por función con exposición/stock/regeneración/consumo. Antes/después aislado es diagnóstico causalUNKNOWN. Ver canon y README para fórmulas/cobertura.


Corrección acotada v3: Observation/Evaluation comparten identidad evidenceId/synthetic/runId/epochId/artifactRole con índice kind exacto, sin alias bundle. Evaluation enlaza inputObservationRef y hash de bytes conciliado. RunManifest declara época/rol y observationRef a hoja indexada, sin ciclos; C11/C17 resuelven cada brazo en su namespace y no acreditan causalidad por tener manifests. Service enlaza condición del mismo evento y SHA de ley/orden; law-inputs.entries conserva sourceEventId/sourceOrderRef. Ver reglas y casos G1 en contracts/README; baseline ausente conserva UNKNOWN marginal aun con FAIL C10 válido.
