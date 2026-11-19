# Feature Specification: criterios revisables de realismo

**Feature Branch**: `codex/criterios-realismo-20261003`

**Created**: 2026-10-03

**Status**: Draft — R1 documental, pendiente de revisión Sol independiente

**Input**: Objetivo12 de Steven: adoptar B01–B16 como C9–C24, conservar C1–C8 y su evaluador, especificar medidas/umbrales provisionales y preparar instrumentos de observación, evaluador lector y línea base futura.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Revisar el significado de cada criterio (Priority: P1)

Como autor/coordinador quiero distinguir qué exige la meta, qué medida la representa y qué aún no se puede comprobar, para que ninguna cifra candidata se convierta silenciosamente en aceptación.

**Why this priority**: habilita revisión antes de construir instrumentos o mirar candidatas.

**Independent Test**: revisión del contrato por otra persona con las fuentes y los 48 casos/8 controles diseñados, sin ejecutar el motor.

**Acceptance Scenarios**:

1. **Given** C9–C24 adoptados pero umbrales sin aprobación definitiva, **When** reviso un criterio, **Then** encuentro campos observables, fórmula, unidad, ventana, denominador, censura/exposición, evidencia, origen, estatus y casos PASS/FAIL/UNKNOWN.
2. **Given** seis controles de60d y una propuesta de panel8, **When** consulto agregados, **Then** veo6 veredictos y el gate8 como insuficiente; no se calcula un aprobado8 sobre6.
3. **Given** una decisión C8 fallida y un indicador nuevo favorable, **When** leo la tabla conjunta, **Then** C8 conserva el fallo y su canal original.

### User Story 2 - Observar sin alterar el mundo (Priority: P1)

Como investigador quiero datos de exposición, materia y causalidad sin que medir cambie las decisiones, para poder atribuir los resultados a las leyes del mundo.

**Why this priority**: una observación que altera física o azar invalida la evidencia.

**Independent Test**: futura comparación de seis semillas×1200 pasos con/sin instrumento y entradas equivalentes, comparando cada tick y verificando activos/archivo/RNG/IDs.

**Acceptance Scenarios**:

1. **Given** el mismo estado y entradas incluido gobernador, **When** activo la observación, **Then** cada estado físico sigue idéntico y el coste de observar se reporta aparte.
2. **Given** un suministro protegido a un mortal, **When** observo su uso, **Then** la materia permanece en conservación y la dependencia queda excluida del éxito autónomo.
3. **Given** un stream faltante, **When** emito cobertura, **Then** lo declaro ausente y ningún cero inventado acredita ausencia del fenómeno.

### User Story 3 - Evaluar evidencia y límites sin falsos positivos (Priority: P1)

Como revisor quiero evaluar artefactos sin ejecutar el mundo, para reproducir decisiones y detectar instrumentos incompletos, errores materiales o éxitos vacíos.

**Why this priority**: permite refutar al evaluador con datos independientes del motor.

**Independent Test**: futura batería sintética manual: PASS/FAIL/UNKNOWN por criterio, límites exactos y ocho controles transversales, sin importar motor ni generar fixtures a partir del resultado del evaluador.

**Acceptance Scenarios**:

1. **Given** datos completos con oportunidades y cero servicios requeridos, **When** evalúo, **Then** falla la exigencia positiva; si faltan oportunidades, queda UNKNOWN.
2. **Given** una infracción válida y otra subgate sin datos, **When** evalúo, **Then** conservo FAIL y UNKNOWN por separado, sin aprobar el frente.
3. **Given**10 de apertura+2 entradas=5 cierre+4 consumo+1 residuo externo+2 pérdidas y3 de transferencia interna, **When** evalúo balance, **Then** cierra sin sumar3 como entrada.
4. **Given** distinta población al mismo tick, **When** se reclama igualdad física exacta, **Then** el reclamo falla; si cambian entradas del gobernador, la comparación exacta no es equivalente.

### User Story 4 - Mantener puertas técnicas, personales y posteriores (Priority: P2)

Como Steven quiero que una línea biológica favorable no cierre por sí sola durabilidad, hardware, carta ni entrenamiento.

**Why this priority**: cada puerta necesita evidencia y autoridad propias.

**Independent Test**: evaluación futura de artefactos de copia/benchmark/experiencia/método, sin publicar ni modificar carta.

**Acceptance Scenarios**:

1. **Given** snapshot recuperado pero crónica durable perdida, **When** evalúo C21, **Then** falla durabilidad.
2. **Given** GPU con kernel rápido pero coste completo peor, **When** se rechaza su adopción, **Then** esa decisión puede ser conforme; adoptarla como mejora falla.
3. **Given** pruebas emuladas favorables sin recibo de Steven ni teléfono físico, **When** evalúo C23, **Then** aceptación personal y experiencia física siguen UNKNOWN.
4. **Given** método conforme y entrenamiento sin empezar, **When** evalúo C24, **Then** method puede PASS y training/final siguen UNKNOWN.

### Edge Cases

Cohorte/denominador vacíos; referencia cero; seis semillas frente a ocho; actor muerto o nacido tarde; vida con menos de tres eventos; archivo con reloj propio; transferencia duplicada; residuo retenido; cambio de época; control no emparejado; frontera parcial; trabajo protegido indirecto; fuente sin destino viable; cambio de contenido después de revisión; backend no disponible; duración60d frente a100d; pérdida de campo obligatorio y evidencia contradictoria. Las reglas exactas están en el contrato canónico, no se infieren de contadores agregados.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: La entrega MUST definir C9–C24 uno a uno y su trazabilidad a GOAL/constitución/B01–B16 en [CRITERIOS-REALISMO](../../docs/CRITERIOS-REALISMO.md), identificando todo umbral provisional.
- **FR-002**: Cada criterio MUST especificar campos, fórmula, unidad, ventana, denominador, exposición/censura, evidencia/control necesarios y condiciones PASS/FAIL/UNKNOWN.
- **FR-003**: C1–C8 MUST conservarse íntegros, incluido C8 por tendencia; la tabla futura sólo incorpora su salida congelada identificada.
- **FR-004**: El sistema MUST separar veredicto por réplica, calidad instrumental y gate de panel, informando todos los desconocidos/abortados en el denominador planeado.
- **FR-005**: La línea base MUST ser6 semillas nuevas verificadas×60d. Un gate candidato8 MUST quedar pendiente sobre6; paridad6×1200 MUST identificarse como ensayo técnico separado.
- **FR-006**: S/I y dependencias protegidas MUST excluirse del éxito autónomo e incluirse en conservación; transferencias internas MUST contarse una sola vez.
- **FR-007**: Datos ausentes MUST dar UNKNOWN y ausencia observada MUST distinguirse de falta de oportunidad. Ninguna exigencia positiva MUST aprobar por conjunto vacío.
- **FR-008**: Conservación MUST declarar frontera/unidades/reloj y distinguir entrada externa, transferencia, regeneración, consumo, residuo retenido y pérdida.
- **FR-009**: Comparaciones MUST fijar cohortes, ventanas, control y parámetros antes de mirar candidatas; medidas relativas MUST distinguirse de puntos porcentuales y definir referencia cero.
- **FR-010**: Instrumentación MUST limitarse a observar, sin mutar física/decisiones/azar/reloj ni introducir auxilios; identidad con/sin observación MUST comprobarse a mismo tick con entradas iguales.
- **FR-011**: El evaluador MUST leer exclusivamente artefactos, validar su evidencia y explicar subveredictos con referencias; no iniciar ni corregir el mundo.
- **FR-012**: Los casos sintéticos MUST tener oráculo independiente del motor y detectar falsos positivos, límites exactos y pérdida de evidencia; su diseño MUST distinguirse de ejecución.
- **FR-013**: C21 durabilidad, C22 paridad/capacidad/coste, C23 experiencia/revisión personal y C24 método/entrenamiento MUST tener puertas y artefactos separados.
- **FR-014**: C23 MUST mantener revisión personal por Steven; C24 MUST mantener training/final pendientes cuando sólo method sea conforme.
- **FR-015**: Contratos MUST representar datos/capacidades faltantes, versiones, origen, ventanas/cobertura, protección y calidad; no suponer que los observables nuevos ya existen.
- **FR-016**: Las tareas MUST poder asignarse a un escritor por archivo, con dependencias y gates de validación en worktree. Esta entrega MUST dejar toda implementación/aceptación sin cerrar.

### Key Entities

Criterio/subgate con origen y regla; réplica/ensayo con versión y entradas; ventana/época/cobertura; evento/stock/flujo con identidad y protección; control emparejado; artefacto técnico/personal; resultado por réplica y panel; registro de reserva/preregistro. Relaciones y formato se concretan en diseño, sin modificar leyes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un revisor puede encontrar todos los elementos de FR-002 en los16 criterios sin interpretar contadores como fenómenos.
- **SC-002**: Los48 casos diseñados y8 controles tienen una regla/subgate de contrato identificable; ningún caso de falta de evidencia ni seis-sobre-ocho puede resultar aprobación indebida.
- **SC-003**: El instrumento futuro conserva identidad física en los7200 ticks comparados de6×1200 y reporta cualquier primera divergencia; aquí queda diseñada esa puerta.
- **SC-004**: El evaluador futuro reproduce veredictos de oráculo manual y produce motivos/cobertura para todos los criterios sin acceder al motor.
- **SC-005**: La línea base futura muestra24 columnas×6 semillas con tres estados, procedencia de C1–C8 y puertas no cubiertas explícitas, sin declarar completada la meta.
- **SC-006**: C23 completo no pasa sin revisión personal vigente; C24 final no pasa sólo por método. Ambos límites pueden verificarse sin biografía real.
- **SC-007**: R1 deja contrato, especificación, plan, tareas y checklist en disco, con revisión documental y sin tareas de ejecución cerradas.

## Assumptions

Los frentes están adoptados; sus candidatos son provisionales. La revisión independiente posterior puede devolver ajustes de contrato antes de R2. La calibración requiere controles pertinentes futuros; los seis controles no constituyen todas las ablaciones. Políticas nuevas de ruina/avance lejano e instituciones ausentes requieren otro alcance. Decisiones personales no bloquean este diseño: se representan como pendientes. No se cambian motor, evaluadores congelados, carta, servicios ni datos existentes.

Corrección R1 documental: consumir exclusivamente realismo-v3 y perfil .v3.json;22 familias estables/30 tipos evidence. FieldCoverage parcial, SourceOrder entre familias, ReproductionGates accepted/rejected+cobertura oportunidades/frenos, inventario completo y autorizaciones individuales, CausalPair con control contemporáneo son obligatorios según contracts/README y reference-types.v3.json. Los ejemplos contracts/examples son diseños wire sin ejecutar; materializar48+8 y regresiones estructurales/semánticas/parser en R2. Validación Luna v2 (3/3+27 estructurales+4 parser, según coordinación) no certifica v3; G0 segunda revisión y G1 semántico siguen pendientes.26 tareas abiertas y un escritor por archivo; este texto no autoriza implementar ni ejecutar en R1.


R1 v3 corrige sólo dos incompatibilidades NO-GO del revisor job47510e03921d4091a2fac76ead47299f: (1) tipo/identidad/vínculo de bundles indexados y crossrun; (2) condición al servicio del mismo evento y SHA coherente. La aceptación de US3 exige ahora los probes de contracts/examples/g1-cases.v3.json: manifest.observationRef resoluble, negativos kind/schema/ref/run/época/rol y vínculo evaluation; balance parcial válido+efecto a condición0.1→FAIL C10 con baseline ausente→UNKNOWN marginal; sin orden/SHA contradictorio→UNKNOWN causal. Son ejemplos manuales, no realengine;48+8 diseños y26 tareas siguen abiertos. v2 formal PASS según coordinación no sella v3; NO-GO-R2 hasta revisión formal y Sol independientes.
