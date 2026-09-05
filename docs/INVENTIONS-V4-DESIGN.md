# Invenciones y estructuras funcionales V4

El plano es un genotipo cultural: un multiconjunto tipado de componentes determina forma, coste y funciones. No modifica el ADN de los habitantes. Los nombres describen la receta; no conceden capacidades.

## Gramática y costes

| Componente | Madera | Piedra | Trabajo | Efecto |
| --- | ---: | ---: | ---: | --- |
| frame | 2 | 1 | 20 | Sostiene un techo; el segundo aumenta durabilidad |
| roof | 4 | 2 | 70 | Protege el descanso; el segundo amplía captación y protección |
| cistern | 2 | 3 | 40 | Capacidad de 0,6 agua por componente; captura lluvia real |
| granary | 3 | 1 | 35 | Capacidad de 0,7 alimento por componente; reserva compartida |
| garden | 2 | 1 | 30 | Convierte agua de cisterna en humedad de cuatro vecinos |
| hearth | 1 | 2 | 30 | Mejora descanso en lluvia/noche, consumiendo madera del ocupante |

Cada plano tiene 1–2 entramados, al menos un techo y tantos techos como entramados como máximo. Huerta requiere cisterna. Los depósitos y huertas admiten hasta dos módulos; el hogar uno. Hay como máximo ocho componentes y cuatro módulos por entramado. Los costes sumados nunca superan el inventario construible: 12 maderas y 8 piedras. Algunas combinaciones sintácticas, como dos cisternas con los costes actuales, quedan excluidas por presupuesto. El plano base conserva exactamente 6 maderas, 3 piedras y 90 trabajos.

El registro admite hasta 64 planos, sin desalojar ancestros ni referencias de edificios archivados. El espacio actual es finito: cuando no queda una combinación útil y novedosa, investigar puede fallar. No se presenta como evolución abierta sin límite.

## Investigación y selección

La práctica se obtiene de construcción, cultivo y recolección, más habilidades adquiridas. La oportunidad exige práctica ≥0,2, una madera, energía ≥0,45, necesidades corporales ≤0,72 y 1200 pasos entre ensayos personales. Busca una carencia local de agua, comida o descanso ≥0,35 y una mejora construible. El motor la incorpora a su elección autónoma; no requiere órdenes.

El contexto usa exclusivamente un radio de cuatro celdas y recursos portátiles próximos. La estimación de lluvia futura durante tiempo claro es un **prior explícito basado en humedad**, no una historia climática medida. Durante lluvia real vale uno. Esta expectativa sirve para diseñar; jamás llena un depósito.

Cada búsqueda propone doce hijos: seis controles funcionales, compartidos por todos los contextos, y seis cruces o mutaciones de recetas conocidas. Los controles permiten comparar carencias sin confundirlas con falta de candidatos. Las operaciones restantes cruzan conteos de dos padres o añaden, eliminan y sustituyen módulos. Se rechazan genotipos inválidos y firmas ya registradas; un lote puede tener menos de doce candidatos válidos y únicos. `localRandom(seed, personId+tick)` mantiene el PRNG del clima intacto.

Los tres objetivos Pareto son utilidad funcional contextual, utilidad por coste y distancia mínima a los genotipos registrados. El frente se ordena por valor normalizado (0,76), eficiencia (0,16) y novedad (0,08). El elegido debe superar 0,035 de utilidad y mejorar un 2 % la mejor receta conocida. Los padres provienen de invenciones propias, edificios observados a ≤5 celdas o contactos a ≤3 celdas con confianza/apertura suficientes. Nunca se consulta culturalmente una receta remota solo porque exista en el registro.

Cada ensayo completado paga una madera y 60 trabajos, incluso si no encuentra novedad. Solo un diseño válido, nuevo y útil incrementa `accepted`. El plano registra autor, padres y generación `1 + max(generación de padres)`. Su `uses` y `usefulness` empiezan en cero: la predicción no se convierte en evidencia.

## Efectos conservativos

- Cada diez pasos la condición decae 0,00018 en claro o 0,00028 bajo lluvia, dividido por durabilidad. Con condición ≤0,1 todas las funciones cesan.
- La cisterna recoge `min(capacidad libre, 0,012 × techos × condición)` solamente cuando llueve. El grifo transfiere hasta 0,018 a `tile.drinkingWater`, hasta 0,08 de reserva pública, debitando exactamente el depósito. Los habitantes usan la acción de beber existente, que también debita agua real.
- La huerta reparte hasta `0,008 × módulos × condición` de agua disponible entre cuatro terrenos adyacentes, hasta humedad 0,75. Cada aumento de humedad tiene un débito equivalente de cisterna. No incrementa comida, vegetación ni cultivo instantáneamente; la ecología posterior sigue necesitando agua/luz.
- Un granero recibe hasta 0,012 por visitante próximo y ciclo desde inventario real por encima de 0,12, solo si el donante no tiene hambre alta. No crea ni duplica alimento. `takeFood` devuelve la cantidad retirada; el consumidor es responsable del único crédito o consumo. La reserva funcional se conserva sin un modelo de deterioro alimentario adicional.
- La calidad base del techo es 0,82; otra cubierta añade 0,09 y otro entramado 0,03, escalados por condición. Un hogar añade hasta 0,12 únicamente con lluvia/noche y combustible. `recordFacilityRest` quema 0,0005 madera del ocupante por paso de descanso con hogar activo; un edificio vacío no quema madera.
- Reparar exige 30 trabajos y una madera y recupera hasta 0,4 de condición. La elección autónoma propone mantenimiento por debajo de 0,6. No rellena depósitos ni repara gratuitamente.

Los usos reales —transferencia por grifo, depósito/retiro, irrigación y descanso observado— refuerzan la utilidad del plano mediante media exponencial acotada en [0,1]. Cada 60 pasos, una persona puede adoptar un plano cultural observado y más útil para su contexto. Una obra en curso conserva el plano elegido.

## Contrato de integración

`completeConstruction`, `invent` y `repair` son los únicos puntos de débito de sus materiales y trabajo. El motor acumula el trabajo íntegro antes de llamar; no debe cobrar dos veces ni aplicar descuento de habilidad al umbral de construcción. La construcción también crea lugar, contador de asentamiento y evento, con depósitos iniciales vacíos.

`stepStructures` avanza únicamente edificios activos con una celda de refugio existente. El backend es dueño del archivado, la reactivación y la materialización de refugios antiguos; el módulo no regenera edificios desaparecidos. El máximo activo del constructor es 512.

Helpers públicos: `defaultBlueprint`, `validBlueprint`, `blueprintCost`, `blueprintSignature`, `blueprintAffordances`, `constructionCost`, `inventionContext`, `inventionCandidates`, `paretoCandidates`, `inventionOpportunity`, `invent`, `completeConstruction`, `stepStructures`, `foodAvailable`, `takeFood`, `facilityRestQuality`, `recordFacilityRest`, `repairOpportunity` y `repair`.

## Evidencia y límites

`tests/inventions.test.ts`: 13 pruebas de gramática/capacidad, cobro exacto y único, conservación de agua y comida, irrigación sin alimento, apagado/reparación, combustible, Pareto, determinismo y separación del PRNG, contrastes agua/comida/descanso, conocimiento local/recombinación, fallo pagado y selección autónoma en una escena controlada.

También se verificaron 25 pruebas existentes de `world.test.ts` y `procedural.test.ts`, y `tsc --noEmit`. La sonda sin alteraciones `createWorld(51926)` + 2400 llamadas a `stepWorld` + `assertWorld` obtuvo 12 ensayos, 6 aceptados y edificios nuevos de granero doble, hogar y cisterna. Esta última recogió 0,01197936 agua real. Es una medición de esta revisión: cambios en otros sistemas pueden cambiar los conteos. En esa ventana no hubo depósitos ni retiros de grano y los prototipos de huerta y doble cubierta aún no se habían construido; esas funciones sí están cubiertas con controles causales.

La propuesta matemática de apoyo fue una delegación textual a `claude/fable`, terminada en 118,8 segundos. Se adaptó a los contratos y escalas reales: no se incorporaron historial climático ficticio, eliminación de ancestros ni capacidades ajenas al inventario. El código y sus pruebas se implementaron y verificaron localmente.

No se probaron despliegue, base de datos viva ni renderizado desde este frente; son responsabilidades de integración/UI. No se usó `dist`. El checkpoint local de este frente incluye únicamente este documento, el módulo y sus pruebas.
