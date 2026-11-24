# Plan maestro de implementación de V23

Base de lectura: `v24-base` (`849a895`). Todas las rutas y líneas se refieren a ese árbol. La implementación parte de `sprint/v24-core` (`f2a91f9` hoy), que ya cambia `index.ts` (+94 líneas), `sim-worker.ts` (+369) y `whispers.ts` (+189). Por eso el carril M0 vuelve a medir los rangos sobre `v24-core` antes de cortar. Las horas y las líneas son estimaciones: nada de esto se ha medido.

Piezas que integra: `ARQ-motor.md`, `ARQ-materia.md`, `cinta-sonnet.md`, `poda-sonnet.md`, `leyes-opus.md` e `inventario-determinismo.md`. Donde se contradicen, manda §1.2.

---

## 1. Convenciones

### 1.1 Ramas, worktrees y entregas

- **Rama de integración:** `sprint/v23l-core`, creada desde `sprint/v24-core` cuando el otro equipo lo declare cerrado (typecheck y suite en verde). La `l` es de «libre»: ya existen ramas `sprint/v23-*` de las leyes v23 (`v23-spikes`, `v23-chem-universal`, `v23-hunting-herding`…) y así no chocan.
- **Un carril por rama y worktree:** rama `sprint/v23l-<carril>` en el worktree `AtlasParaIsa-anexo/worktrees/v23l-<carril>`, abierto desde la punta de `v23l-core` al empezar cada ola. `node_modules` se copia con `cp -al`, como enlaces duros.
- **Pruebas por carril:** cada carril corre `npm run typecheck` y sus pruebas. Solo el integrador corre la suite completa (`timeout 1200 npm test`, en segundo plano).
- **Trabajos por cloud-offload (GPT, Grok):** duran 30 minutos como mucho y no commitean. Esos carriles se trocean en **tiquetes de ≤ 30 min**, cada uno con su lista cerrada de ficheros. El coordinador del carril (un subagente Claude) verifica cada tiquete, lo commitea y lanza el siguiente.
- **Revisión:** toda entrega la revisa un modelo distinto del que la escribió. Opus cierra cada ola con una revisión final del diff integrado.
- **Ficheros del integrador.** Pertenecen al carril **I** de cada ola: `src/world/index.ts` (barril), `mundo/{tipos,crear,validar,migrar}.ts`, `src/world/params.ts`, `src/shared/types.ts`, `package.json` (desde la ola 1) y `RULES_VERSION`. Los demás carriles no los editan: entregan los cambios que necesitan en el mensaje de entrega y el integrador los aplica.
- **Regla de pruebas:** una prueba que importa un módulo borrado es del carril que lo borra. Si lo borran dos carriles, se la queda el primero por orden alfabético.
- **Pantalla (decisión «toda función nueva se ve»):** en cada ola, un único carril V posee los ficheros del cliente que no son del reproductor. Los demás carriles publican sus datos en la vista o el fotograma y dicen en una línea qué hay que mostrar.

### 1.2 Reconciliación entre piezas (vinculante para los contratos)

| Choque | Decisión del plan |
|---|---|
| `Libro`: el motor usa `BigInt64Array` y la materia `Float64Array` entero. | Hay un solo `Libro` en `world/materia/tipos.ts`, con `enVuelo`, `fuentes` y `sumideros`, cada uno un `Float64Array(NE+1)` entero ≤ 2⁵³. El índice NE es la energía en J. Lo usan el motor, la poda y la materia. `flujoBorde` de la poda no se implementa: la comprobación por región usa el libro de cada hilo. |
| `Intento` del motor frente a `IntentoMateria`. | Un solo `Intento` en `motor/contratos.ts`. `materia` pasa a ser `Float64Array` de pares `[SustanciaId, cuantos]` y no un vector por elemento. La `parte` (exacta, digerible o agua) va en `dato`. Se borra `IntentoMateria`. |
| Gestación: el motor tiene un protocolo con `ProponerCria`, `Concebido` y `Rechazado`; la materia, un escritor único y una pareja que solo aporta información. | Gana la materia, por mínima. La pareja aporta el genoma, que se lee de dos columnas nuevas del frente público: `genoma` (16 f32) y `pareja` (uid de su mejor vínculo fértil, que hace de consentimiento). Salen esos tres `TipoIntento` y la garantía de cría. |
| `Clase` aparece en los dos contratos. | La de la materia pasa a llamarse `ClaseSustancia`. |
| Comunidades: propagación de etiquetas (leyes) frente a componentes conexas (materia). | Componentes conexas de los vínculos mutuos ≥ 0,3, con identidad por solapamiento (`ARQ-materia` §3.3). |
| Fauna: huella (leyes) o nada (materia). | Sin huella. La densidad la acotan la comida y el coste de moverse. Se quita la métrica de ocupación de F1. |
| `reduccion.ts`, `agregados.ts` y `guardia.ts`: conectar (poda) o borrar (motor). | Borrar (decisión 11): los dueños por chunk los sustituyen. Lo hace M2b en la ola 1, junto con `personas-motor.ts`, su único importador. |
| Adaptador `Balance` escalar (leyes) frente a vistas heredadas (materia). | Vistas heredadas (`materia/vistas.ts`). No se escribe ninguna implementación escalar desechable. |
| La cinta graba `Corte{vista: WorldView}` y el motor emite un `Fotograma` binario. | El motor entrega `Fotograma` y `EnlaceCinta` (créditos, `pedirCompleto` y la `cadencia` de la cinta). El hilo `carta-tape` construye el `Corte` desde el `Fotograma`, fuera del hilo de simulación. En la ola 1 lo construye desde `projectTapeFrame`. |
| Cadencia de guardado. | Cada 2.400 ticks (un día de mundo), con un mínimo de 10 s de pared entre guardados. La materia se guarda en la misma operación (`MateriaCheckpoint`). |
| Decisión en GPU. | `decisionGpu: 'siempre'` (decisión 3, al pie de la letra). |
| `reproductionEnabled`. | Se queda solo como pausa manual del operador. Nada la escribe solo. |
| Gobernador (`server/governor.ts`). | Se borra entero en la ola 0. |
| Plantillas fundadoras. | 6 linajes animales más 1 plantilla vegetal por bioma. Después solo hay genes continuos. |
| `migrateWorld` V3–V14. | Se borra en la ola 4. `Store.load` rechaza cualquier versión distinta de 15 (mundo nuevo, decisión 12). |

---

## 2. Troceo mecánico de `src/world/index.ts` (carril M0, ola 0)

El fichero tiene 2.721 líneas en `v24-base`. M0 lo parte en 18 módulos sin cambiar la conducta. Se permite extraer funciones dentro de `bodyAndAction` y `performWork`, para que comer, beber, recolectar y perseguir tengan cada uno su dueño. La verificación es que los **digestos dorados sean idénticos** antes y después: es el último uso del determinismo. `index.ts` queda como barril que reexporta la API actual con las mismas firmas, así que tests, servidor y scripts no se tocan.

| Módulo nuevo | Contenido (`index.ts` de v24-base) | Dueño ola 1 | ola 2 | ola 3 |
|---|---|---|---|---|
| `mundo/tipos.ts` | 58-75, 98-157 (`WorldContext`, `RULES_VERSION`, constantes, `Experience`, `Habit`, `Person`, `Memory`, `World`) | I | I | I |
| `mundo/geometria.ts` | 76-97 (`clamp`, `distance`, `hypot2`, `HYPOT2_EXACT`) | I | PO2 (borra `HYPOT2_EXACT`) | I |
| `mundo/crear.ts` | 158-316 (`random`, `phaseAt`, `walkable`, `addEvent`, `deathContext`, `remember`, `createWorld`, `initializePerson`, `assignFounderAge`, `seededTraits`) | I | I | I |
| `mundo/ecologia.ts` | 317-418 (`ecology`) | — | W | — |
| `decision/sentidos.ts` | 419-673 (`Candidate`, `ventajaComparativa`, `soaCell`, `tile*`, `foodStock`, `bodily*`, `immediateMeal`, `perceivedRoutes*`, `drinkingBody`, `needRates`, `localRestQuality`, `canRecoverWaterHandling`, `personById`, `placeById`) | M2b | — | B |
| `decision/politica-persona.ts` | 674-753 (`creditCausalOutcome`, `ensurePersonPolicy`, `localPolicyObservation`, `precomputePolicyScores`) | M2b | — | — |
| `decision/personas.ts` | 755-1586 (borradores de módulo, `choose`, `actionLabel`, `explorationTarget`, `valueKey`, `outcome`) | M2b | — | — |
| `actuar/mover.ts` | 1587-1738 (`roadEffortFactor`, `move`) | — | M4b | — |
| `actuar/interacciones.ts` | 1739-1780 (`share`) y 2089-2145 (`encounters`) | S | M5 | — |
| `actuar/cuerpo.ts` | 1781-1920 (`bodyAndAction`, sin lo extraído) | — | M4b | B |
| `actuar/recursos.ts` | comer y beber, extraídos de 1827-1866; 1921-1923; recolectar, extraído de `performWork` | — | W | B |
| `actuar/caza.ts` | 1924-2004, más la persecución extraída de `bodyAndAction` (~1785-1830, ~1900-1920) | — | M4b | F |
| `actuar/trabajo.ts` | 2005-2088 (`workEffort`, `forageDuration`, `workDuration`, `performWork`, química emergente 2063-2069) | — | M4b | T1 |
| `actuar/gestos.ts` | 2146-2194 (`applyGesture`) | E | M4b | — |
| `mundo/paso.ts` | 2195-2274 (`medirFase`, `FASES_SERIALES`, `fraccionSerial`, `stepWorld`, `advanceTick`) | M2b | M4a | — |
| `demografia/morir.ts` | 2275-2294 (`transferEstate`) | — | M4b | B |
| `demografia/nacer.ts` | 2295-2415 (`ELECCION_POR_AFINIDAD`, `reproduce`, `fertile`) | — | M4b | N |
| `mundo/validar.ts` | 2416-2571 (`assertCommon`, `assertWorld`) | I | I | I |
| `mundo/migrar.ts` | 2572-2721 (`migrateWorld`, `upgradeV3`…`V14`) | I | I | I (borrado en la ola 4) |

**Cuidado en M0:** las importaciones cíclicas entre módulos están permitidas para funciones, pero ninguna constante de nivel de módulo puede depender de otro módulo del ciclo. Los borradores de `choose` (755-776) se quedan en `decision/personas.ts`. La comprobación es `npm run typecheck`, una ejecución de `node --test` sobre `tests/determinismo-hardware.test.ts` y los digestos dorados de 4 semillas × 2.400 ticks.

---

## 3. Olas

```
Ola 0  Cimientos ─────► Ola 1  Motor libre + librerías ─► Ola 2  Dueños + mundo material ─► Ola 3  Vida y técnica ─► Ola 4  Cierre ─► Publicación V23
(M0 solo, luego         (percepción repartida, GPU,      (escritores únicos, intentos,      (cuerpos de átomos,  (poda de vistas,
 contratos, red,         química/arena/cinética,          fotograma binario, materia en      natalidad pagada,    20 caídas, panel
 operación, poda         cinta nueva, comunidades,        teselas, cinta en el cliente,      fauna y caza          final, docs)
 segura, control)        escucha)                         persistencia sin replay)           generales, técnica)
```

**Dependencias duras:**

- M0 precede a todo lo que toca `src/world`.
- Los contratos (0B) preceden a la ola 1.
- M1, M2b y M3 preceden a M4.
- Q, A, P y L preceden a W.
- W precede a B.
- B se integra antes que N, F y T (dentro de la ola 3; los cuatro se escriben en paralelo contra el contrato `Cuerpo`).
- La cinta C1 precede a M6 y a C2.
- M6 precede a C3.

**Orden de integración dentro de cada ola:** primero el motor y después las leyes, para medir la equivalencia del motor con leyes iguales antes de que cambien.

### Ola 0 — Cimientos (≈ 1,5–2 días de reloj)

Contratos congelados, poda que no quita protección, red de seguridad nueva y control medido. Las leyes no cambian, salvo que se borra el gobernador.

| Carril | Objetivo | Ficheros en propiedad exclusiva | Implementa | Revisa | Dificultad | Líneas / horas | Verificación |
|---|---|---|---|---|---|---|---|
| **0A M0** | Partir `index.ts` sin cambiar la conducta | `src/world/index.ts` y los 18 módulos de §2. Corre solo: nadie toca `src/world` mientras dura | Sonnet | GPT-6.1 Sol | media | ~2.750 movidas, ~200 nuevas / 5 h | Digestos dorados idénticos en 4 semillas, `test:paridad` y suite en verde |
| **0B Contratos** | Congelar las interfaces de las cuatro piezas con §1.2 aplicado | `src/world/motor/contratos.ts`, `src/shared/materia.ts`, `src/shared/naturaleza.ts`, `src/world/materia/tipos.ts`, `src/shared/cinta.ts`, `src/shared/fotograma.ts` | Opus | GPT-6.1 Sol | alta | ~900 nuevas / 6 h (empieza en paralelo con 0A y ajusta las importaciones al terminar M0) | typecheck; un test de tipos que importa todos; Opus firma la congelación |
| **0C Red de seguridad** | Invariantes, propiedades, panel y reproducción estadística | `src/world/invariantes.ts`, `src/server/diagnostico.ts`, `tests/lib/propiedades.ts`, `tests/invariantes.test.ts`, `tests/propiedades-mundo.test.ts`, `scripts/lab/panel.ts`, `scripts/lab/reproducir.ts` | GPT-6.1 Sol (6 tiquetes) | Sonnet | media | ~1.400 / 10 h | 0 violaciones duras sobre `v24-core`; sobrecoste del muestreador ≤ 1 % (`scripts/perf/paso-servidor.ts`); `panel.ts` emite el veredicto M1–M6 de `poda-sonnet` §7 |
| **0D Operación** | El mundo no se para para siempre; sin gobernador ni prioridad | `server/app.ts` (`gobernar` 437-470 y 892; recarga 928-955; `/health`→`Salud` 973; enganche del `Muestreador`), `server/main.ts`, `server/gateway.ts` (salida 75 en 60-72), `server/governor.ts` (borrar, 374), `server/resumen-vivo.ts:79`, `server/hardware-limits.ts:187` (reserva de 4 hilos), `world/ecosystem-kernel.ts:195-275` (fallo de GPU → CPU), `world/gpu/autoprueba.ts` (humo con tolerancia 1e-9 y sin `--fmad=false`), `scripts/systemd/torre/{atlas-vigilante.service,.timer,vigilante.sh}`; borrar `atlas-publico.prioridad.conf`; `tests/recuperacion.test.ts`; borrar `tests/gobernador*.test.ts` y `tests/curva-techo.test.ts` | GPT-6.1 Sol (5 tiquetes) | Sonnet | media | +550 / −1.250 / 8 h | `recuperacion.test.ts` (GPU muerta a mitad de paso, `throw` en `stepWorld` → recarga); `systemd-analyze --user verify`; arranque de 10 min con `CARTA_DATA_DIR` temporal |
| **0E Poda segura** | Borrar lo que no tiene importador y poner en cuarentena la paridad | Borrar `world/halo.ts` (776) + `tests/halo-radios.test.ts`, `paralelo/identidades.ts` (250) + test, `soa/personas.ts` (485) + test. Mover las 19 pruebas de la Ola 1 de `poda-sonnet` §4 a `tests/paridad/`; script `test:paridad` en `package.json`. **Empieza cuando M0 está en verde** | Haiku | Sonnet | baja | −2.900, ~2.650 movidas / 3 h | typecheck; `npm test` sin las pruebas en cuarentena; `npm run test:paridad` en verde (sigue valiendo hasta la ola 2) |
| **0F Enmienda** | Constitución 2.0.0 y guía de validación | `.specify/memory/constitution.md` (texto de `poda-sonnet`, final), `docs/VALIDACION.md`; etiqueta `control-v24-determinista` sobre `v24-core` | Sonnet | Opus | baja | ~250 / 2 h | Revisión de Opus contra las 12 decisiones |
| **0G Control** | Medir la referencia antes de cambiar el motor | Ninguno (corre en el worktree `v24-core` congelado) | Haiku lanza `panel.ts` | Opus lee | baja | 0 / 1 h y 12 corridas de fondo | 12 semillas (las 4 del panel: 51926, 19104, 19101 y 19103, más 8) × 30 días: el motor viejo es determinista, así que la varianza sale de las semillas. Resultado en `docs/evidencia-<fecha>/control-v24.json` |
| **I0** | Integrar y subir los contratos | Ficheros del integrador | Sonnet | Opus | — | 3 h | Puerta 0 |

Total de la ola 0: ≈ 38 h de agente, ≈ 9.000 líneas tocadas (la mitad movidas).

### Ola 1 — Motor libre con dueño único, librerías de materia y cinta nueva (≈ 3–4 días)

Hay un solo dueño (el hilo de simulación) y la percepción se reparte entre todos los hilos y la GPU (decisión 3). La materia se construye como librería con su laboratorio, sin conectarla al mundo todavía. La cinta nueva sustituye al anillo. Comunidades, escucha y los topes de fauna pasan a ser leyes sin topes.

| Carril | Objetivo | Ficheros en propiedad exclusiva | Implementa | Revisa | Dif. | Líneas / horas | Verificación |
|---|---|---|---|---|---|---|---|
| **M1 Núcleo** | Piscina única persistente, barrera con plazo, SAB crecible, buzón, registro y contadores | `motor/{buzon,contadores,registro}.ts`, `paralelo/{piscina,barrera,particion}.ts`, `soa/{arena,terreno}.ts` (Terreno y TerrenoDueno, `versionPagina`, `duenoChunk`), `soa/morton.ts` (`mortonCode` sacado de `gpu/reparto.ts`). Borrar `piscina.ts:173-191,343-357` (retardos adversariales) y `particion.ts:9-54` (órdenes) | GPT-6.1 Sol (8 tiquetes) | Opus | alta | +1.100 / −250 / 12 h | `motor-buzones`, `motor-fallos` (worker muerto, plazo de 60 s → `fatal`), crecimiento concurrente del SAB con lectores |
| **M2a Fauna SoA y fin de sus topes** | Fauna entera en SoA; todos deciden cada tick | `animals.ts` (`choose` en :628 → `Plan`; borrar :16, :23, :1041-1046, :858-998 y :86/:188), `soa/{organismos,fauna}.ts`, `decision/fauna.ts`; borrar `paralelo/fauna-motor.ts` (713) y `fauna-worker.ts` (484) | GPT-6.1 Sol (7 tiquetes) | Sonnet | alta | +900 / −1.400 / 12 h | `motor-frente` (CRC); decisiones por tick / vivos = 1. **El commit que quita los topes se integra después de medir la equivalencia** |
| **M2b `choose` troceado y F2 repartida** | Percepción (unas 10 `Consulta` y 3 `ConsultaOrganismo`) en cualquier hilo; candidatos fríos y elección en el dueño | `decision/{personas,sentidos,politica-persona,percepcion,planes}.ts`, `mundo/paso.ts` (F0–F6 con T=1); BFS desde `personas-worker.ts:29,166-243`. Borrar `paralelo/personas-motor.ts` (831), `personas-worker.ts` (407), `reduccion.ts` (351), `agregados.ts` (224), `guardia.ts` (101) y `gpu/reparto.ts` (salvo morton, ya movido) | Opus | GPT-6.1 Sol | extrema | +1.400 / −1.950 / 18 h | Equivalencia de la elección frente al `choose` viejo (reparto de acciones χ², KS de distancias), 1 frente a 32 hilos |
| **M3 GPU de decisión** | Kernel `percibir` (BFS 15×15, argmin, red 12→8→12, W·rasgos); dos tarjetas por EMA; la VRAM deja de ser autoridad | `gpu/{canal,percibir-gpu,puente}.ts` (borrar `runTick`, `flushToHost` y `vramAhead` en :580 y :782-816, el modo repartido en :744 y las ramas `sharded` en :332-569), `world/ecosystem-kernel.ts` (pasa de 0D a M3), `scripts/gpu/{servidor-gpu.py,percibir.cu}`; borrar `politica-gpu.ts` (762), `compute-policy-gpu.py` (596), `compute-ecology-gpu.py`, `compute-ecology.cu`, `compute-ecology-core.mjs` y `compute-ecology-clients.mjs`; quitar `--fmad=false` (`compute-ecology-gpu-resident.py:149`) | GPT-6.1 Sol (8 tiquetes) | Opus | alta | +1.100 / −2.300 / 16 h | Lote de 4.000 vencidos en ≤ 3 ms; ≤ 2 MB por tick; matar el servidor en cada fase sin perder el tick; GPU frente a CPU por estadística |
| **M8 Pruebas y banco del motor** | Invariantes I-B, I-R, I-F, I-K y el banco | `tests/motor-*.test.ts`, `scripts/lab/equivalencia-motor.ts`, `scripts/banco-motor.mts` | GPT Terra (5 tiquetes) | Sonnet | media | ~900 / 8 h | Pasan con T=1 y T=32 |
| **Q Química** | `productos()` (mínimo de energía libre), memo y registro de un solo escritor | `world/materia/{quimica,servicio}.ts`, `scripts/lab-materia.mts`, `tests/materia-quimica.test.ts` | Opus | Fable (solo la matemática: `realizable`, saturados, Pauling, balance) + GPT-6.1 Sol (pruebas) | extrema | ~1.300 / 20 h | I4; banco de `productos` con p99 < 50 ms y ≤ 16 átomos; reacciones de control (CH₄+O₂, CaCO₃ a T alta, pirólisis de madera) |
| **A Arena y libro** | Lotes de 120 B sobre la arena crecible de M1; libro; códec del punto de control | `world/materia/{arena,libro,checkpoint}.ts`, `tests/materia-arena.test.ts` | GPT-6.1 Sol (4 tiquetes) | Sonnet | alta | ~800 / 10 h | I1, I3, I7 (fuzz con 32 hilos y 10⁵ intentos con nonces repetidos); ida y vuelta del punto de control |
| **P Cinética y transporte** | `pasoLote` (Arrhenius, ξ entero) y fluir (materia y calor) | `world/materia/{paso,fluir,paso-worker}.ts` | GPT-6.1 Sol (5 tiquetes) | Opus | alta | ~900 / 12 h | I2 (energía exacta), I5 (dividir un lote: KS p > 0,01), ms por lote con 1 y 28 hilos |
| **L Leyes de uso** | Romper y copiar (`Ecuacion` balanceada por eliminación entera, `quemar`) | `world/materia/{romper,copiar}.ts`, `tests/materia-leyes.test.ts` | Sonnet | GPT-6.1 Sol | alta | ~700 / 10 h | Prueba por ley; Liebig; el balance de toda plantilla conserva átomos |
| **S Comunidades** | Componentes conexas, vínculos `{v,t}` que decaen, `convivir` por lado | `society.ts` (borrar :604-621, :642-676, :694-811 y :813-895; `convivir` :134 deja de escribir en los dos extremos), `lineage.ts:226-250`, `actuar/interacciones.ts` (`encounters`) | Sonnet | GPT Terra | media | +400 / −650 / 8 h | Experimento C1 en el panel; prueba de que un grafo cortado se parte en dos comunidades |
| **E Escucha** | Gen 8 «escucha»; oír ∝ escucha²·calma·audibilidad | `genetics.ts` (GENE_COUNT 8, validación :67), `whispers.ts:141-172`, `actuar/gestos.ts`, `scripts/lab/escucha.mts` | Grok 4.7 (respaldo: GPT Luna; trabajo que no bloquea a nadie) | Sonnet | baja | ~250 / 4 h | W1 (Spearman de escucha frente a latencia < 0; pendiente padre→hijo en [0,6; 1,1]) |
| **C1a Cinta: escritor** | Contrato `Corte`, bloques crc32, 5 niveles, catálogo, épocas, podador por bytes; el motor deja de esperar | `server/cinta/{formato,escritor,catalogo,reducir,poda}.ts`, `server/tape-worker.ts`, `server/sim-worker.ts` (adaptador `Corte` sobre `projectTapeFrame`; borrar :416 y :267) | GPT-6.1 Sol (8 tiquetes) | Sonnet | alta | ~1.400 / 14 h | I1–I4, I6 e I7 de `cinta-sonnet` §7; `beforeStep` no devuelve nunca `false` por la cinta |
| **C1b Cinta: lector** | Índice en RAM, LRU de keyframes, pool de lectores y rutas `/api/cinta/*` (alias `/api/tape/*`) | `server/cinta/{lector,lector-worker}.ts`, `server/gateway.ts`, `server/app.ts:530-553,1020-1035` | GPT Terra (4 tiquetes) | Sonnet | media | ~700 / 8 h | Salto con p95 < 100 ms sobre 5 GB sintéticos; el bucle HTTP no se bloquea |
| **V1 Pantalla** | Indicador de salud, panel «Motor», barra de escucha, grafo de comunidades | `client/{telemetry-hud,inspector-view,game,landscape}.ts` y un panel nuevo `client/panel-motor.ts` | Sonnet | Muse wonder-spark (experiencia de uso) | media | ~600 / 8 h | Prueba de extremo a extremo por elemento; FPS sin regresión (`v24-client-fps.test.ts`) |
| **I1** | Integrar en orden: M1 → M2b → M3 → M8 → **equivalencia** → M2a (topes) → S → E → Q, A, P, L → C1 → V1 | Ficheros del integrador | Sonnet | Opus | — | 8 h | Puerta 1 |

Total de la ola 1: ≈ 180 h de agente, ≈ 15.000 líneas tocadas (≈ 7.000 borradas).

### Ola 2 — Dueños por chunk, mundo material y fotograma binario (≈ 4–5 días)

Cada chunk tiene un escritor único, con intentos y garantía. El fotograma se escribe en paralelo. Las teselas pasan a ser lotes de átomos, con las vistas heredadas y un sumidero declarado para comer. La cinta llega al cliente. Se quita el guardado por replay. Aquí se rompe el bit a bit y se poda.

| Carril | Objetivo | Ficheros en propiedad exclusiva | Implementa | Revisa | Dif. | Líneas / horas | Verificación |
|---|---|---|---|---|---|---|---|
| **M4a Dueños** | Coordinador, workers dueños, reparto Morton, migración con `v8.serialize`, `instantanea()` y `cargar()` con época | `motor/{coordinador,dueno-worker,bloques,reunir}.ts`, `mundo/paso.ts`, `paralelo/{piscina,barrera,particion}.ts`; borrar `paso.ts` `FASES_SERIALES`, `withArchiveReadBatch` y el bucle serie (hoy `index.ts:2203-2216,2226,2253`) | Opus | GPT-6.1 Sol | extrema | +1.800 / −400 / 24 h | I-R, I-F, I-K; equivalencia con 1, 8 y 32 hilos y con 32 + GPU; ≥ 300 Hz en el banco con 270 personas |
| **M4b Actuar por intentos** | Las ~25 escrituras cruzadas pasan a intentos; nacimiento con un solo escritor (la gestante) | `actuar/{mover,cuerpo,caza,trabajo,gestos}.ts`, `demografia/{nacer,morir}.ts` (nacer: deja de debitar a ambos padres, `index.ts:2342`; columnas `genoma` y `pareja` del frente) | Sonnet | Opus | alta | +700 / −500 / 12 h | I-N (ningún uid repetido, cada parto con su gestación); `grep` sin escrituras sobre `Person` ajenas en `actuar/` |
| **M5 Interacciones** | `Tomar`, `Dar`, `Depositar`, `Golpear`, `Vincular` y `Ensenar` aplicados por el dueño destino; garantías terminales | `actuar/interacciones.ts`, `motor/aplicar.ts` | GPT-6.1 Sol (5 tiquetes) | Opus | alta | ~800 / 10 h | I-C exacto (con sumidero declarado), I-B (≤ 2 ticks), I-S (frontera en [0,9; 1,1]; χ² de victorias por hilo) |
| **M6 Fotograma** | Fotograma binario escrito por los dueños; adaptador para la cinta; fuera la proyección y el clon por tick | `motor/fotograma.ts`, `server/cinta/vista.ts` (`fotogramaAVista` → `Corte`), `server/sim-worker.ts` (borrar :233-416, :430-434), `server/app.ts` (borrar :831-836); borrar `world/gpu/autoprueba.ts` y sus llamadas en `main.ts:93-110` | GPT-6.1 Sol (6 tiquetes) | Sonnet | alta | +900 / −800 / 12 h | I-V (un tick por fotograma, sucesos contiguos, `saltados` contados); el adaptador da lo mismo que `projectTapeFrame` sobre el mismo estado |
| **PS Persistencia** | Guardado completo sin replay; materia binaria en el mismo guardado; cadencia por ticks | `server/store.ts` (borrar :136, :287, :493-690, :1579-1626, :1675-1693), `server/snapshot.ts:74`, `server/snapshot-parts.ts`, `shared/exact-json.ts` (borrar → `JSON.stringify`), `lineage.ts:122`, `world/digesto.ts` (se reduce a utilería de pruebas, ~70 líneas) | GPT-6.1 Sol (5 tiquetes) | Sonnet | media | +500 / −1.400 / 8 h | Ida y vuelta `load(save(w))`; `kill -9` a mitad de guardado → carga el anterior; cero importaciones de `digesto` en `src/` |
| **W Mundo material** | Tesela = Suelo + Agua + Vida; aire por página; roca latente; comer, beber y recolectar = `mover` hacia un sumidero declarado; vistas que escriben los escalares de hoy | `world/materia/{mundo,vistas}.ts`, `mundo/ecologia.ts`, `actuar/recursos.ts`, `ecosystem.ts`, `terrain.ts`, `forest.ts`, `agua.ts`, `soa/terreno.ts`, `world/ecosystem-kernel.ts` (borrar :281-458); borrar `ecology-kernel.ts`, `ecologia-constantes.ts` y `scripts/compute-ecology*` (8) | Opus | GPT-6.1 Sol | extrema | +1.800 / −2.200 / 28 h (incluye 1 día de calibración por equivalencia de flujos) | Puerta E2 de la materia (§4); los 8 fenómenos de la tabla de cordura en un mundo de 64×64 |
| **G GPU de materia** (recortable) | `pasoLote` en CUDA con la misma semántica | `scripts/gpu/{materia.cu,materia_kernel.py}`, `world/gpu/materia-gpu.ts` | GPT-6.1 Sol (5 tiquetes) | Opus | alta | ~900 / 12 h | I1–I3 en GPU; I8 (permutación frente a P) |
| **C2a Cinta en el cliente** | Reproductor por fotogramas y niveles; insignia de escala; botón «Presente»; serie; marcadores por perfil | `client/{dvr-player,dvr-bar}.ts`, `server/cinta/marcadores.ts` | Sonnet | Muse wonder-spark | media | ~1.000 / 12 h | Pruebas del reproductor con cinta sintética multinivel; al entrar retoma el marcador a 1× |
| **C2b Respaldo de la cinta** | Enlaces duros y `rsync --ignore-existing` de L1–L4 y del catálogo a `/mnt/Data2` | `scripts/respaldo-cinta.sh`, `scripts/systemd/torre/atlas-respaldo-cinta.{service,timer}` | GPT Luna (2 tiquetes) | Sonnet | baja | ~300 / 4 h | I8 de la cinta (grabar, respaldar, borrar, restaurar; hash de 200 fotogramas igual) |
| **PO2 Poda del bit a bit** | Borrar la paridad, ahora rota | `tests/paridad/*` (borrar), cirugía en `v22-world-hotpaths`, `v22-seasonal-gpu-ecology`, `ecology-paralela`, `paralelo-ecologia`, `paralelo-adversarial`, `gpu-autoprueba`, `v12-full-hardware-evolution` y `v17-emergencia-largo-plazo`; `mundo/geometria.ts` (fuera `HYPOT2_EXACT`); `package.json` sin `test:paridad` | Haiku | Sonnet | baja | −4.000 / 5 h | Suite en verde; `grep` sin «0 ULP» ni `digestoCanonico` en las aserciones de `tests/*.test.ts` |
| **V2 Pantalla** | Color de tesela por composición, fuego y humo, capa «Hilos», dueño por chunk | `client/{landscape,terrain-field,road-geology-art,structure-art,telemetry-hud,inspector-view,game}.ts` | Opus | Muse wonder-spark | media | ~800 / 10 h | Extremo a extremo por fenómeno; FPS sin regresión |
| **I2** | Integrar en orden: M4a → M4b → M5 → M6 → PS → **equivalencia** → W → G → C2 → V2; `PROTOCOL_VERSION` 11 y `Tile.mat` en `shared/types.ts` | Ficheros del integrador | Sonnet | Opus | — | 10 h | Puerta 2 |

Total de la ola 2: ≈ 150 h de agente, ≈ 18.000 líneas tocadas (≈ 9.700 borradas).

### Ola 3 — Vida y técnica sobre átomos (≈ 4–5 días)

Cuerpos de átomos, natalidad pagada, fauna sin especies con caza y ganadería generales, y tecnología y obra sobre lotes. Salen todos los topes de la decisión 7 que quedan. Los carriles N, F, T1 y T2 se escriben en paralelo con B contra el contrato `Cuerpo` y `VistaCuerpo`, que está congelado desde la ola 0. Se integran después de B.

| Carril | Objetivo | Ficheros en propiedad exclusiva | Implementa | Revisa | Dif. | Líneas / horas | Verificación |
|---|---|---|---|---|---|---|---|
| **B Cuerpos** | Tejido, Reserva, Digestivo y Embrión; digestión con κ; morir deja un cadáver; fuera el sumidero | `world/materia/cuerpo.ts`, `body.ts` (borrar :21-69), `demography.ts` (umbrales :88-93 → reserva), `actuar/{cuerpo,recursos}.ts`, `demografia/morir.ts`, `decision/sentidos.ts` (`needRates` → vistas del cuerpo) | Opus | GPT-6.1 Sol | extrema | +1.000 / −450 / 18 h | Libro exacto en cada tick de laboratorio, sin sumidero; causas de muerte frente a la ola 2 |
| **N Natalidad pagada** | Fértil si la reserva lo paga; gestación 1:1 en átomos; el aborto devuelve los átomos al digestivo | `world/natalidad.ts`, `demografia/nacer.ts`, `family.ts:50-57`; borrar `natalidad-local.ts` (224) y `tests/natalidad-local.test.ts` | GPT-6.1 Sol (4 tiquetes) | Opus | alta | +450 / −700 / 8 h | N1 (adaptado al panel de 30 días); pruebas «sin reserva no concibe» y «el aborto conserva» |
| **F Fauna, caza y ganadería** | Cuerpo y gestación pagada para toda la fauna; sin especies en las reglas; miedo, habituación, romper y extracción | `animals.ts` (borrar :53, :124-125, :135-165, :471-476, :785-795, :807-822, :1063-1071 y :1114-1119), `decision/fauna.ts`, `actuar/caza.ts` (borra `HUNT_ORGANIC`…`tendNearbyAnimal`, hoy 1924-2004), `soa/{fauna,alarma}.ts`, `ecosystem.ts:10` (pasa de W a F en esta ola) | GPT-6.1 Sol (8 tiquetes) | Opus | alta | +1.200 / −1.300 / 18 h | F1, H1 y I10 (`grep` sin `.species` ni `linajeFundador` en `src/world` fuera de la proyección) |
| **T1 Técnica sobre lotes** | `ProcesoMaterial` (calentar, mojar, unir, romper con patrón); olvido de recetas; carga por masa; fuera la química vieja y sus topes | `technology.ts` (borrar :40-46, :97, :135-162, :176-236, :319-355, :536, :647-654, :701-760, :849 y :911), `technology-catalogue.ts` (:24, :85), `technology-memory.ts:111-117`, `tecnologia-complejidad.ts`, `shared/technology.ts:3-12`, `world/materia/proceso.ts`, `actuar/trabajo.ts`, `server/technology-archive.ts`; borrar `world/chemistry.ts` (977), `shared/chemistry.ts` (208), `material-affordances.ts` (170) y `technology-water.ts` (381) con sus pruebas, incluida `v23-chem-universal.test.ts` | Opus | GPT-6.1 Sol | extrema | +1.500 / −3.200 / 26 h | Q1; procesos que se completan; cerámica, cal o metal en ≥ 2 de 4 semillas; I10 (sin 512/6/16/32 ni `maxInputs`) |
| **T2 Obra** | Piezas de obra como lotes; caminos de piedra; fuera los topes de estructuras | `inventions.ts` (:20-21, :31-36, :238), `shared/life.ts`, `world/materia/piezas.ts` | GPT-6.1 Sol (6 tiquetes) | Sonnet | alta | +800 / −900 / 14 h | Estructuras que se degradan por química y desgaste; `grep` sin `MAX_STRUCTURES` ni `MAX_BLUEPRINTS` |
| **M7 Reparto** | Rebalanceo Morton por tiempo de pared; `hilos:'auto'` | `motor/rebalanceo.ts`, `server/hardware-limits.ts`, `scripts/banco-motor.mts` | GPT Terra (3 tiquetes) | GPT-6.1 Sol | media | ~400 / 6 h | Desequilibrio ≤ 1,3; con 16 hilos de carga ajena, ≥ 40 % del Hz en reposo y sin corrupción |
| **C3 Fuera la cinta vieja** | Borrar el anillo y sus constantes | Borrar `server/tape-store.ts` (700), `shared/tape.ts:18,21,24`, `maxFrames` y `CARTA_TAPE_MAX_FRAMES` (`main.ts:34,40`, `sim-worker.ts:163,448`, `app.ts:66,530`, `gateway.ts:230`); reescribir `v21-tape-store` y `v22-tape-worker` contra I1–I10 | Haiku | Sonnet | baja | −1.300 / 4 h | Suite en verde; `grep` sin `TAPE_DEFAULT_MAX_FRAMES` |
| **V3 Pantalla** | Cuerpo (reserva, agua, embrión, carga), gestación, crías y cuidadores, sprite según la masa, persecución, miedo y habituación, «ordeñó/esquiló», ficha de sustancia, montones, hornos y metal al rojo | `client/*` salvo el reproductor | Opus | Muse wonder-spark | media | ~1.000 / 14 h | Extremo a extremo por fenómeno; FPS sin regresión |
| **I3** | Integrar en orden: M7 → B → N → F → T1 → T2 → C3 → V3; quitar el sumidero de las vistas; `params` `poblacion` y `social` limpios | Ficheros del integrador | Sonnet | Opus | — | 12 h | Puerta 3 |

Total de la ola 3: ≈ 140 h de agente, ≈ 14.000 líneas tocadas (≈ 7.900 borradas).

### Ola 4 — Cierre (≈ 2 días más los paneles)

| Carril | Objetivo | Ficheros | Implementa | Revisa | Dif. | Líneas / horas | Verificación |
|---|---|---|---|---|---|---|---|
| **I4 Poda final** | Fuera los escalares heredados de `Tile` (`shared/types.ts:27`) y `LAYOUT` (`soa/terreno.ts:40-50`): las vistas se derivan en la proyección; `mundo/migrar.ts` borrado; `Store.load` rechaza las versiones distintas de 15; `RULES_VERSION = 15`; `rules-version.test.ts` reducido | Ficheros del integrador, `soa/terreno.ts`, `world/proyeccion.ts`, `materia/vistas.ts` | Sonnet | Opus | media | −1.200 / 8 h | Suite en verde; el cliente pinta solo desde `Tile.mat` |
| **PO4 Scripts y docs técnicos** | Ola 4 de `poda-sonnet` (scripts de paridad y bancos con digesto); `docs/REGLAS.md` (:12, :475, :479, :748-772, :803); `docs/CONSTRUCCION.md:46,217`; `scripts/lab/README.md` | Esos ficheros | Haiku (primera pasada) | Sonnet | baja | −1.500 / 5 h | `grep -rni "determinista\|bit a bit\|0 ULP"` sin resultados fuera de `docs/evidencia-*` y `specs/` |
| **C4 Calibración de la cinta** | Cinta sintética de 50 GB, ráfaga a 2×Hz, restauración y caída del escritor; ajuste de `paso0` y de cuotas; E7 (sectores) solo si el keyframe pasa de 5 MB | `scripts/perf/cinta-*.mts` | GPT Terra (3 tiquetes) | Sonnet | media | ~300 / 6 h | I4, I5 e I10 de la cinta con números reales |
| **V4 Pantalla** | Panel «Materia» (reparto de los 8 elementos entre compartimentos y sustancias aparecidas) | `client/panel-materia.ts` y su entrada en `game.ts` | Sonnet | Muse wonder-spark | media | ~400 / 6 h | Extremo a extremo |
| **D Documentos** | Reescritura final (§7) | `GOAL.md`, `README.md`, `PLAN.md`, `docs/ESTADO.md`, `AGENTS.md`, `CLAUDE.md`, `docs/EVIDENCIA.md` (nota de cabecera) | Sonnet | Opus | baja | ~600 / 6 h | Revisión de Opus contra las decisiones |
| **Ensayos** | 20 `kill -9` en fases aleatorias; panel de equivalencia de modos; panel corto final | `scripts/lab/caidas.mts` | GPT Terra | Opus lee los veredictos | — | ~150 / 4 h y paneles | Puerta 4 = puerta de publicación |

Total de la ola 4: ≈ 45 h de agente, ≈ 4.200 líneas tocadas.

### Tamaño total

| | Ola 0 | Ola 1 | Ola 2 | Ola 3 | Ola 4 | Total |
|---|---|---|---|---|---|---|
| Horas de agente | 38 | 180 | 150 | 140 | 45 | **≈ 550** |
| Líneas tocadas | 9.000 | 15.000 | 18.000 | 14.000 | 4.200 | **≈ 60.000** (≈ 27.000 borradas) |
| Reloj | 1,5–2 d | 3–4 d | 4–5 d | 4–5 d | 2 d + ½ d de publicación | **≈ 15–18 días** |

El camino crítico es M0 → 0B → M2b → M4a → W → B → T1. Lo que lo alarga son las calibraciones de W y de B, no la escritura de código.

---

## 4. Puertas entre olas

**Comunes a todas las olas.** Una ola no se cierra si falla alguna:

1. `npm run typecheck` y `timeout 1200 npm test` en verde en `v23l-core`.
2. Invariantes: 0 violaciones duras en la suite y en el panel; blandas ≤ 1e-6 por comprobación.
3. Arranque: el servidor del worktree con `CARTA_DATA_DIR` temporal sirve `/health` = `ok` durante 30 min, y el vigilante no actúa.
4. **Panel corto** (`scripts/lab/panel.ts`): semillas 51926, 19104, 19101 y 19103 × 3 réplicas × 30 días, con los umbrales preregistrados M1–M6 de `poda-sonnet` §7:
   - M1: 0 de 12 extinciones de mortales.
   - M2: población ≥ 16 el día 30 en ≥ 10 de 12, y mínimo ≥ 8 entre los días 20 y 30.
   - M3: recambio y causas de muerte con balance exacto.
   - M4: log₂(pob₃₀/pob₁₅) ∈ [−1, +4] en ≥ 11 de 12.
   - M5: 0 violaciones duras.
   - M6: 0 pasos de más de 30 s y RSS ≤ 70 % de la RAM.

   El veredicto es por métrica (cumple, falla o desconocido). Las réplicas se lanzan con el mismo nombre de proceso que el público («carta-isa»), para que ninguna caiga en `SCHED_IDLE`. El portátil (20 hilos) corre 4 de las 12.
5. **Hz medido.** Con `scripts/banco-motor.mts` y con el mundo real de 270 personas, el Hz no puede bajar más de un 30 % respecto a la ola anterior, salvo cuando la puerta propia de la ola exige más.
6. `grep` I10 acumulado: no reaparece ningún tope ni lista ya quitada.

**Propias de cada ola:**

| Puerta | Además de las comunes |
|---|---|
| **0** | Digestos dorados idénticos antes y después de M0, por última vez; `test:paridad` en verde y luego en cuarentena; `recuperacion.test.ts` en verde; `systemd-analyze --user verify` del vigilante; control v24 terminado y archivado (hace falta antes de cerrar la ola 1). Hz igual al de `v24-core` (el motor no cambia). |
| **1** | **Equivalencia del motor con leyes iguales** (antes de integrar los topes de fauna, S y E): 4 semillas × 3 réplicas × 3 días con 1, 8 y 32 hilos y con 32 + GPU; permutación con α = 0,01/8 y margen de ±20 % frente al control. Paso ≤ 20 ms con 270 personas; F2 ≥ 10× con 32 hilos; GPU: 4.000 vencidos en ≤ 3 ms, ≤ 2 MB por tick, caída probada en cada fase. Materia en laboratorio: I1–I7, tabla de cordura de 8 fenómenos (Q + P + L + A), banco de `productos` con p99 < 50 ms. Cinta: I1–I7 y salto con p95 < 100 ms. Leyes: C1 y W1 dentro del panel. |
| **2** | I-C exacto con el sumidero declarado, I-B, I-R, I-N, I-F, I-K e I-S; equivalencia entre 1, 8 y 32 dueños. **Hz: ≥ 300 en el banco del motor con 270 personas, y ≥ 50 con el mundo real completo (10× V22).** Puerta E2 de la materia: mediana de población el día 30 ≥ 0,8× el control, nacimientos cada día en ≥ 10 de 12 y fenómenos visibles. I8 entre CPU y GPU de materia, si G entra. Cinta: el navegador reproduce L0–L4, retoma el marcador y salta al presente; restauración del respaldo. Un `kill -9` → `Store.load` y época nueva sin replay. |
| **3** | Libro exacto sin sumidero en cada tick de laboratorio y cada 2.400 en el panel; N1, F1 (sin ocupación), H1 (30 días, dentro del panel), C1 y Q1; I9 (sumideros de N, P, Ca y Fe por debajo del umbral a 30 días); cerámica, cal o metal en ≥ 2 de 4 semillas; desequilibrio de reparto ≤ 1,3; ≥ 40 % del Hz con 16 hilos ajenos; I10 completo (decisiones 7 y 8). |
| **4** (publicación) | 20 de 20 caídas `kill -9` vuelven al último guardado con época nueva y la cinta marca lo huérfano; panel de equivalencia de modos en verde; **panel corto final 4 × 3 × 30** con todas las leyes, en verde; cinta de 50 GB sintética con bytes ≤ tope × 1,02 y salto con p95 < 100 ms; `npm run build` en el worktree de publicación; `scripts/deploy-check.sh <sha>`. |

**Si una puerta falla:** el carril culpable no se integra y la ola se alarga. Para las puertas demográficas (olas 2 y 3) se reserva un día de calibración por ola, solo sobre las constantes de `shared/naturaleza.ts` (η, m0, ν, γ, κ₀, τ). No se permiten rescates en la ley.

---

## 5. Riesgos del plan y recortes

### Riesgos

1. **Calibración de W y B** (40 constantes químicas más ν, γ, s y κ₀): el mundo puede quedar estéril o arder entero. Es el mayor riesgo de calendario. Mitigación: equivalencia de flujos en W, puerta E2 con 12 réplicas, un día de calibración por ola y la tabla de cordura como puerta en la ola 1.
2. **M4a es extremo** y la latencia de un tick entre organismos cambia la conducta (comer de un chunk vecino, cazar, criar). Mitigación: los contratos y el modo T=1 vienen desde la ola 1, la equivalencia entre 1 y 32 dueños y la prueba I-S de frontera.
3. **Cuello de botella en Opus:** implementa M2b, Q, M4a, W, B, T1 y V2–V3, y revisa la mitad de lo demás. Mitigación: subagentes Opus en paralelo dentro de cada ola. Las entregas de Opus las revisa GPT-6.1 Sol, no otro Opus.
4. **Tiquetes de 30 min sin commit (GPT y Grok):** hay muchos carriles de GPT-6.1 Sol en paralelo (6 en la ola 1). Mitigación: tiquetes con una lista cerrada de ficheros; el coordinador del carril commitea; antes de cada ola se consulta el saldo y se reparte entre Sol y Terra.
5. **Deriva de líneas:** `v24-core` ya movió `index.ts`, `sim-worker.ts` y `whispers.ts`. Todas las referencias de este plan son de `v24-base`. M0 y cada carril las vuelven a localizar por el nombre de la función, no por el número.
6. **Conflictos en ficheros compartidos** (`params.ts`, `shared/types.ts`, `package.json`). Mitigación: solo los toca el integrador.
7. **Ciclos de importación tras M0.** Mitigación: la regla de §2 y un arranque en frío dentro de la puerta 0.
8. **Se pierde el control tras la ola 1:** cuando cambian las leyes (S, M2a, después W), el control v24 solo sirve para las distribuciones gruesas. Desde la ola 2 mandan los umbrales absolutos M1–M6. La potencia es limitada: con 12 corridas solo se ven diferencias de medias del 30–45 %.
9. **Competencia en la torre:** el público actual sigue con su drop-in de prioridad hasta la publicación, y los paneles (≈ 24 hilos) compiten con él y entre sí. Mitigación: parte del panel en el portátil y el veredicto por estado, no por reloj.
10. **Disco:** `/datos` está al 79 % (245 GB libres). La cinta de 50 GB, más los paneles y los worktrees, lo aprieta. Mitigación: `statfs` al arrancar la cinta y la limpieza de §7 antes de la ola 2.
11. **Grok agota el tiempo:** solo se le da E, que no bloquea a nadie, con GPT Luna de respaldo.

### Qué recortar primero (sin incumplir ninguna decisión)

Por orden:

1. **G** (GPU de materia): a la escala de hoy basta la CPU. La decisión 3 habla de la decisión de personas y fauna, no de la química.
2. **E7** (sectores espaciales de la cinta), que ya es condicional.
3. Respaldo de L0 (queda L1–L4).
4. `hilos:'auto'` (se queda el rebalanceo).
5. Marcadores en el servidor (basta `localStorage` para retomar donde uno lo dejó).
6. Fundido entre niveles y recibos causales en el inspector.
7. Capa «Hilos» (el panel «Motor» se queda).
8. Serie histórica del panel «Materia» (la ficha de sustancia se queda).
9. Volcados de preimagen y caja negra (la bitácora se queda).
10. Borrado de `migrateWorld` (es limpieza: `Store.load` rechaza versiones igualmente).
11. Escenas de 30.000 personas en el banco.

**No se recorta** nada que materialice las decisiones 1–12: motor libre, decisión repartida en GPU, química por valencias, todo de átomos, fin de los reguladores, caza y ganadería generales, escucha heredable, cinta de vida entera con retomar y «Presente», poda del código de escala y una sola publicación en un mundo nuevo.

---

## 6. Consecuencias que Steven debe conocer

- **Calendario:** son unas 550 horas de agente y 15–18 días de reloj, no días sueltos. La publicación única (decisión 12) hace que cualquier puerta demográfica que falle en la ola 2 o en la 3 retrase toda la V23. No se puede publicar «medio V23».
- **Nace una ley:** toda acción sobre otro organismo o sobre otro chunk se aplica al tick siguiente, y cada cual ve a los demás un tick atrás. Cambia la conducta y se calibra en el panel.
- **Con la población de hoy, la GPU resta** (latencia del viaje) y 32 hilos ganan poco. Casi toda la aceleración viene del fotograma binario y de quitar la proyección y la clonación por tick. La decisión 3 se cumple igual.
- **El observador nunca alcanza al motor:** a unos 300 Hz el mundo avanza unos 450 días por hora y la reproducción a 1× de L0 consume unos 36. Lo que se ve al volver es casi siempre un nivel resumido (L1–L2), con la escala a la vista.
- **Una caída pierde mundo:** con guardado por día de mundo (mínimo 10 s de pared), se pierden ≤ 1–1,25 días de mundo a 300 Hz. La cinta lo marca como época huérfana. Ningún fallo se puede volver a ejecutar: la depuración pasa a ser estadística («ocurre en 7 de 50»).
- **La química es plausible, no real:** 8 elementos (sale el azufre), una valencia por elemento, unidades de fórmula de ≤ 8 átomos y los isómeros se funden. La cinta no graba átomos, solo la forma y el compuesto principal.
- **La población y la fauna las regula la materia.** No se conoce el equilibrio antes del panel. Pueden desaparecer linajes («se perdieron los lobos»), algunas regiones se secarán y la escucha puede extinguirse si obedecer mata. Siguen existiendo números de la naturaleza (η, m0, τ, la tabla de elementos) en un único fichero.
- **Sin prioridad propia:** cuando la torre está cargada, el presente avanza más despacio. Se mantiene el nombre «carta-isa» solo para que el servicio no caiga por debajo de los demás (en `SCHED_IDLE`). Sin el drop-in, compite en igualdad.
- **Memoria:** la tesela pasa a ocupar unas 5 veces más. El mundo no tiene tope de software; el límite es la RAM.

---

## 7. Limpieza

**Al cerrar cada ola:** `git worktree remove` de cada `v23l-<carril>` integrado (la rama conserva los commits). Los directorios `CARTA_DATA_DIR` temporales de laboratorio se borran cuando su veredicto queda archivado en `docs/evidencia-<fecha>/`.

**Antes de la ola 2 (por el disco).** Proponer a Steven:

- Quitar los worktrees `publico-v11` … `publico-v20` (incluidos `-r2` y `-r3`), `v23-spikes`, `v24-baseline-bench`, `criterios-realismo-20261003` y los `v24-*` ya integrados.
- Los mundos de `AtlasParaIsa-anexo/mundos/` **no se tocan sin su OK**.

**Tras publicar:**

- Se quitan los worktrees de V22 y V21 después de 14 días de V23 sana. El mundo V22 queda detenido e intacto.
- Se borran las ramas `sprint/v23l-*` ya fusionadas (las remotas solo con su OK) y los temporales del scratchpad.
- Las modificaciones sin commitear de `scripts/systemd/torre/{publico.sh,atlas-respaldo-publico.service}` en el árbol principal se reconcilian **antes** de que 0D toque ese directorio: el operador decide si son la configuración viva del público actual.

**Documentos que se reescriben al final (carril D, ola 4):**

- `.specify/memory/constitution.md`: ya enmendada en 0F (2.0.0); se revisa la fecha y que el flujo diga «panel corto antes, panel largo 8×60 después».
- `GOAL.md` :18, :20 y :41: sin «un reloj para todos» ni determinismo como resguardo.
- `docs/ESTADO.md`: V23, commit, mundo, servicios, procedimiento de publicación. Es la única fuente.
- `AGENTS.md` y `CLAUDE.md`: pasan a ser punteros breves (bloque de `poda-sonnet` §10). La viñeta larga de publicación se va a `ESTADO.md`.
- `README.md` :57, :90, :220-251 y :263.
- `PLAN.md` :16, :101, :115, :245, :281 y :436.
- `docs/VALIDACION.md` (de 0F, con los paneles reales).
- `docs/EVIDENCIA.md`: nota de cabecera con la fecha del cambio.
- **Contrato de publicación** `docs/evidencia-<fecha>/publication-v23.json`: commit, `RULES_VERSION` 15, mundo, semillas, veredictos de los paneles, Hz medido, tope de la cinta y unidades systemd.

---

## 8. Publicación de V23 en un mundo nuevo

1. `bash scripts/deploy-check.sh <sha>` sobre el commit de `v23l-core` que pasó la puerta 4. Steven da el OK para fusionar en `main` con typecheck, pruebas y build en verde. Push de `main` y de las ramas de trabajo con `gh` como credencial.
2. `systemctl --user start atlas-respaldo-publico.service` y verificar la copia del mundo público vigente (ver `docs/ESTADO.md`).
3. `systemctl --user stop atlas-publico.service`; verificar que no queda el proceso «carta-isa» ni el puerto 100.64.0.1:3000.
4. `git worktree add --detach ../AtlasParaIsa-anexo/worktrees/publico-v23 <sha>`. Copiar `node_modules` y correr `npm run build` **allí** (nunca en el árbol principal).
5. Mundo nuevo: `AtlasParaIsa-anexo/mundos/v23-<fecha>/` vacío. Se copia `access.scrypt` del mundo anterior, sin manejar la contraseña. La cinta va en `<mundo>/cinta/` con un tope de 50 GB, y se comprueba con `statfs` que hay espacio.
6. `scripts/systemd/torre/publico.sh`:
   - `CARTA_DATA_DIR` y `cwd` pasan al mundo y al worktree nuevos.
   - Fuera `CARTA_TAPE_MAX_FRAMES`, `gobernador.presupuestoMs` y los `limites.*` derivados por la RAM.
   - `persistencia.cadaTicks=2400`.
   - Se conserva el nombre de proceso «carta-isa».
7. Unidades:
   - Borrar `~/.config/systemd/user/atlas-publico.service.d/` (`atlas-publico.prioridad.conf`).
   - Repuntar `atlas-respaldo-publico.service` al mundo nuevo.
   - Instalar `atlas-respaldo-cinta.{service,timer}` y `atlas-vigilante.{service,timer}`.
   - Copiar las unidades de `scripts/systemd/torre/` a `~/.config/systemd/user` y hacer `systemctl --user daemon-reload`.
8. `systemctl --user start atlas-publico.service atlas-vigilante.timer atlas-respaldo-cinta.timer`.
9. Comprobar por el dominio:
   - `/health` devuelve `Salud` con `ok`, el tick avanza y Hz > 0.
   - Los assets y `/api/cinta/meta` responden.
   - El cliente retoma un marcador y «Presente» salta al final.
   - Tras el primer guardado, el estado durable está en disco.
10. Prueba en vivo del vigilante:
    - `kill -9` del proceso → reinicio, carga del último guardado y época nueva marcada en la cinta.
    - El mundo V22 queda detenido e intacto: **no se arranca**.
11. Se escriben `docs/ESTADO.md` y `publication-v23.json` y se commitean.
12. Después: el panel largo de 8 × 60 en el laboratorio (decisión 12), con sus réplicas repartidas entre la torre y el portátil.
