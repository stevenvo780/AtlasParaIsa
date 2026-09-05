# Autopoiesis en *Una Carta Para Isa* — auditoría estricta

> Sospecha de origen: usamos "autopoiético" en `four-pillars.md` y en
> docstrings, pero ¿de verdad el sistema produce los componentes que lo
> sostienen, o sólo simula la apariencia? Este documento responde sin
> autoindulgencia y propone cómo acercarse al criterio sin inflar la palabra.

---

## 1. Definición operacional

Maturana, H. R., & Varela, F. J. (1980). *Autopoiesis and Cognition: The
Realization of the Living*. Boston Studies in the Philosophy of Science,
vol. 42. D. Reidel Publishing. (Original: Maturana & Varela, 1972, *De Máquinas
y Seres Vivos*. Editorial Universitaria, Santiago de Chile.)

> "Una máquina autopoiética es una máquina organizada como una red de procesos
> de producción de componentes que (i) a través de sus interacciones y
> transformaciones continuamente regeneran y realizan la red de procesos
> que los produjo; y (ii) la constituyen como una unidad concreta en el
> espacio en el cual existen, especificando el dominio topológico de su
> realización como tal red."  
> — Maturana & Varela (1980), p. 78–79.

De ahí los **cinco criterios** (Varela, Maturana, & Uribe, 1974, *Autopoiesis:
The organization of living systems, its characterization and a model*,
BioSystems 5(4): 187–196):

1. **Identifiable boundary**: el sistema posee un límite identificable que lo
   distingue del entorno.
2. **Constitutive components**: el sistema está constituido por componentes
   producidos por procesos internos.
3. **Mechanistic system**: el sistema es una red de procesos mecanísticamente
   describibles.
4. **Boundary self-production**: el límite mismo es producto de los procesos
   constituyentes (no impuesto externamente).
5. **Operational closure**: los procesos del sistema están operacionalmente
   cerrados — la red produce los componentes que producen la red.

El criterio fuerte es el (5): clausura operacional. Sin ella, el sistema es
sólo "auto-organizado" (Ashby, von Foerster) pero no autopoiético en el
sentido de Maturana-Varela.

---

## 2. Auditoría del agente actual

### 2.1 Límite identificable — ✓ parcial

`AgentId` (string en `packages/ai-agency/src/types.ts`) discrimina self/mundo.
`Perception` (mismo archivo) ya separa explícitamente `partner` de
`environment`. La frontera está codificada — pero es **declarativa**, no
producida: el agente no construye su frontera; el bootstrap se la asigna.

Veredicto: cumple en forma débil. La frontera persiste por convención, no por
proceso.

### 2.2 Auto-producción de componentes — ✗

Aquí está la falla principal. Los componentes del agente
(`EpisodicBuffer`, `SemanticMemory`, `Personality`, `Drive[]`,
`LLMClient`, `VectorStore`) son **instanciados externamente** por el harness
en `services/realtime/src/agency.ts` y en los tests. El agente no los crea
ni los regenera.

**Sin embargo**, hay un dominio donde sí ocurre auto-producción débil:

- **Memoria episódica**: `EpisodicBuffer.remember()`
  (`packages/ai-agency/src/memory/episodic.ts`) produce nuevos `InternalEvent`
  internos a partir de la propia operación del agente (sus acciones generan
  los `EpisodicEvent` que luego almacena).
- **Memoria semántica**: `consolidate(episodes, prior)`
  (`packages/ai-agency/src/memory/semantic.ts`) produce `SemanticFact[]` a
  partir de la memoria episódica que el agente mismo produjo.

Este sub-circuito **sí** es autopoiético en sentido estricto: la red
(episódico→semántico→prompt→decisión→episódico) regenera sus propios
componentes (los facts y los episodes son productos internos).

Veredicto: la **memoria** es autopoiética; el agente **completo** no.

### 2.3 Distinción self/world — ✓

`perception.partner` vs `perception.environment` es la operación de
distinción. `getDrive(drives, "bond")` (interno) vs `perception.partner`
(externo) sostiene la separación durante la decisión.

### 2.4 Auto-mantenimiento — ✓ parcial

`packages/sim-core/src/systems/homeostasis.ts` implementa el lazo correctivo
clásico: setpoint → error → corrección. Cumple Cannon/Damasio. Pero:

- Auto-mantenimiento **mientras vivo**: sí (el sistema regula activamente
  contra perturbaciones).
- Auto-mantenimiento **post-muerte**: no. `lifecycle.ts` marca `alive = false`
  y no hay regeneración. Pilar 1 dice que esto está bien — la muerte es
  irreversible y eso es la metáfora. Aquí autopoiesis y la metáfora
  **coinciden**: un autopoiético que pierde clausura **muere**.

### 2.5 Clausura operacional — ✗

El LLM externo rompe clausura. `LLMPolicy.decideAsync` hace HTTP a un servicio
de inferencia que **no es producido por el agente**. Cada utterance depende
de un proceso completamente exógeno.

Esto es análogo a una célula que dependiera de proteínas sintetizadas afuera:
ya no es autopoiética; es heteropoiética. No es necesariamente malo
(autopoiesis no es la única virtud), pero **no podemos llamarla autopoiética**.

---

## 3. Veredicto: proto-autopoiético

El sistema **completo** no satisface los cinco criterios. Pero contiene
**sub-circuitos autopoiéticos genuinos**:

1. **Lazo episódico-semántico** (memoria que se consolida a sí misma).
2. **Lazo homeostático** (drives que se regulan contra perturbaciones).
3. **Lazo perception-action** vía mundo (cumple acoplamiento estructural en
   sentido de Maturana, no autopoiesis stricto sensu).

Llamémosle **proto-autopoiético**. El nombre honra el origen sin abusar de él.

---

## 4. Propuestas para acercarse a clausura operacional

Cuatro intervenciones de tamaño moderado, ordenadas de menos a más
ambicioso.

### 4.1 Metabolismo del corpus

El agente selecciona activamente **qué fragmentos del corpus retener** en su
memoria semántica vs cuáles descartar, basado en relevancia interna (drives,
historia reciente).

Hoy: el RAG (`packages/narrative/src/retrieve/rag.ts`) sirve todo bajo demanda;
no hay "digestión".

Propuesta: añadir `SemanticMemory.metabolize(fragments, currentDrives)` que
incorpora fragmentos a un cache interno con prioridad afectiva, y un proceso
de **catabolismo** que descarta los menos referenciados después de N ticks.
Esto convierte al corpus de input pasivo en componente producido por el
agente.

### 4.2 Regulación afectiva de la propia política

Hoy: `softmaxTemperature(personality)` (`personality/traits.ts`) lee
temperatura desde personality fija. La política **no modula su propia
estocasticidad**.

Propuesta: que `temperature` se ajuste como función de
`affectiveState.distress`: alto distress → baja temperatura (decisiones más
conservadoras), distress bajo → temperatura alta (exploración). Esto cierra
un lazo: estado interno → política → acción → estado interno. Es clausura
parcial en el dominio decisional.

Fuente conceptual: Friston, K. et al. (2017). *Active Inference: A Process
Theory*. Neural Computation 29(1): 1–49. La precisión (precision) del modelo
es modulada por el estado afectivo.

### 4.3 Reparación post-error de la voz

Hoy: si el LLM emite una utterance que rompe el manifesto, se valida y se
descarta (`validateUtterance` en `llm-client.ts`). El agente **no aprende**
del rechazo.

Propuesta: registrar rechazos en una "cicatriz" persistente
(`Personality.failedUtterancePatterns: string[]`) que se inyecta en el
prompt siguiente como negative-prompt. Después de K rechazos del mismo
patrón, bajar `temperature` por X ticks. Esto convierte al manifesto de
filtro externo en presión interna selectiva sobre la producción del agente.

### 4.4 Bootstrap interno de drives (la propuesta fuerte)

Hoy: `Drive[]` con `viableRange` se asignan en bootstrap y nunca cambian.

Propuesta: añadir `Drive.viableRange` mutable, donde el rango se **adapta
lentamente** a la historia del agente. Si un agente ha sobrevivido meses
con bond promedio 0.3, su rango viable mínimo desciende. Esto modela
plasticidad homeostática (cf. Sterling & Eyer, 1988, *allostasis*).

**Riesgo**: rompe Pilar 1 (death by disconnection) si el rango se adapta
demasiado. Solución: imponer floor inferior absoluto a `viableRange.min`.

---

## 5. Test de autopoiesis débil

Archivo objetivo: `packages/ai-agency/tests/integration/autopoiesis-weak.test.ts`.

**Hipótesis**: después de N ticks de simulación, la **distribución de
`SemanticFactKind`** acumulada en cada agente debe diferir significativamente
de la distribución inicial (idealmente vacía o trivial).

```ts
describe("autopoiesis débil: el agente produce su propia red semántica", () => {
  it("la distribución de SemanticFactKind diverge de la inicial", async () => {
    const agent = bootstrapAgent({ semantic: emptySemanticMemory() });
    const world = bootstrapWorld({ seed: 7 });

    for (let t = 0; t < 5000; t++) {
      const { agent: nextAgent, world: nextWorld } = await tickWithAgent(
        world, agent
      );
      // ...
    }

    const dist = histogramOfFactKinds(agent.semantic.facts);
    const initialDist = uniform(SemanticFactKindCount);

    const klFromInitial = klDivergence(dist, initialDist);
    expect(klFromInitial).toBeGreaterThan(0.5); // nats
    // Y debe haber al menos 3 SemanticFactKind distintos representados
    expect(Object.keys(dist).length).toBeGreaterThanOrEqual(3);
  });
});
```

**Criterio adicional**: la distribución debe ser **diferente entre Steven e
Isa** si tienen `Personality` distintas. La autoproducción es individualizada;
si converge a la misma distribución para ambos, los agentes son réplicas, no
individuos autopoiéticos.

---

## 6. Cierre

El proyecto no es autopoiético en sentido estricto y no necesita serlo para
honrar la metáfora. Pero **debe** preservar y expandir los sub-circuitos
autopoiéticos que ya tiene (memoria episódica-semántica, homeostasis), porque
ahí vive la propiedad operacional que Maturana llamó "la organización de lo
vivo". Cada propuesta de §4 acerca un componente más a la clausura sin
sacrificar la coherencia técnica.

La muerte por desconexión, leída a través de Maturana, no es castigo
narrativo: es la **única consecuencia matemática** de un sistema cuya
organización depende del acoplamiento. Esa es la idea más bella que la teoría
nos regala y la que el código ya implementa correctamente
(`packages/sim-core/src/systems/lifecycle.ts`). El resto es perfeccionar el
detalle.
