# IIT aplicada a *Una Carta Para Isa*

> Este documento no afirma que la simulación es consciente. Afirma que la
> Teoría de la Información Integrada (Integrated Information Theory, IIT) ofrece
> una vara cuantitativa para distinguir **agencia integrada** (Pilar 4: "decisión
> emergente") de **agencia modular** (un montón de `if/else` sumando outputs).
> Si decimos que la agencia es emergente y los subsistemas son separables sin
> pérdida de información, somos hipócritas. IIT nos da el termómetro.

---

## 1. Conceptos clave

### 1.1 Información integrada (φ, "phi")

Tononi, G. (2004). *An information integration theory of consciousness*. **BMC
Neuroscience**, 5:42. https://doi.org/10.1186/1471-2202-5-42

φ mide cuánta información un sistema genera **como un todo** que excede la suma
de la información que sus partes generarían independientemente. Operativamente:

- Se considera un sistema `S` con estado actual `s`.
- Se busca la "partición de información mínima" (Minimum Information Partition,
  MIP): la división de `S` en partes `{P1, P2, ...}` que **menos** destruye la
  estructura causa-efecto.
- φ es la distancia entre la estructura causa-efecto de `S` y la unión de las
  estructuras causa-efecto de las partes bajo la MIP.

Si φ ≈ 0, el sistema es **descomponible**: existe una partición tal que las
partes, operando aisladas, reproducen el todo. Si φ > 0, hay información que
**sólo existe** en el sistema integrado.

### 1.2 Estructura causal y MICE

Oizumi, M., Albantakis, L., & Tononi, G. (2014). *From the phenomenology to the
mechanisms of consciousness: Integrated Information Theory 3.0*. **PLoS
Computational Biology**, 10(5): e1003588.
https://doi.org/10.1371/journal.pcbi.1003588

IIT 3.0 reformula φ como propiedad de la "estructura causa-efecto máximamente
irreducible" (Maximally Irreducible Cause-Effect Structure, MICE). Para cada
subconjunto de mecanismos del sistema se construye su repertorio de causas
posibles (qué estados pasados llevarían al estado actual) y de efectos posibles
(qué estados futuros pueden seguir). Los repertorios que **no** pueden
factorizarse en repertorios de subsistemas más pequeños componen la MICE. φ del
sistema es la suma ponderada de las irreductibilidades de los mecanismos de la
MICE.

### 1.3 Principio de exclusión

Sólo un conjunto candidato puede llevar la etiqueta "sistema" en una región
dada del espacio causal: aquel cuyo φ es máximo dentro de los conjuntos que se
solapan. Esto es operacionalmente crucial para el proyecto: cuando preguntamos
"¿cuál tiene mayor φ — el agente, el mundo, o el acoplado?", el principio de
exclusión nos dice que la respuesta determina **dónde vive la integración**.

---

## 2. Mapeo al proyecto

Tres candidatos a "sistema":

| Sistema | Mecanismos | Estados |
|---|---|---|
| **Agente solo** | drives, memoria episódica, memoria semántica, política utility, LLMPolicy, perception | `Drive[]` × `EpisodicBuffer` × `SemanticMemory` × `Personality` |
| **Mundo solo** | ECS (Position, Homeostasis, Bondable, Lifecycle...), clock, landmarks, intentions, interaction, places, ambient | `EcsStore` × `ClockState` × `EventLog` × `recentMoments` |
| **Acoplado** | unión de los dos anteriores **más** el bucle perception→decide→action→interaction→homeostasis→lifecycle | producto cartesiano + estado del bucle |

### 2.1 Argumento informal sobre qué sistema tiene mayor φ

**Agente solo**: la utility-AI (`packages/ai-agency/src/decision/utility.ts`)
es casi separable. Cada drive contribuye linealmente a la utility; la softmax
es una mezcla, pero el dominante se identifica con `dominantDriveId`. Excepción
interesante: la consolidación semántica (`memory/semantic.ts`) integra
episodios → facts de forma no factorizable (el peso de un fact depende del
conjunto entero de episodios, no de subgrupos). El LLM, por su naturaleza
recurrente, introduce integración real. φ esperado: **bajo a moderado**.

**Mundo solo**: ECS es por diseño descomponible — componentes independientes
sobre entidades independientes. Los sistemas (`systems/*.ts`) introducen
acoplamiento (interaction modifica bond de ambos, lifecycle lee bond). Pero el
acoplamiento es **diádico** y local; no hay redes profundas de feedback dentro
del mundo per se. φ esperado: **bajo**.

**Acoplado**: aquí es donde aparece la propiedad interesante. El lazo
`Perception → decide → Action → interaction → Bond → Homeostasis → Perception(t+1)`
forma una red causal cerrada **entre** agente y mundo donde ninguna mitad
puede predecir su propio futuro sin la otra. Pilar 1 (death by disconnection)
es precisamente esto: separar agente de su acoplado al partner produce
trayectoria muy distinta (muere). φ esperado: **el más alto**.

**Conjetura central a defender**: `φ(acoplado) > φ(agente) + φ(mundo)`. Si
falla, la metáfora "el vínculo es condición de existencia" es decorativa.

---

## 3. Cómo medir un proxy de φ

El cálculo exacto de φ es **#P-difícil** (Mayner et al., 2018, *PyPhi: A
toolbox for integrated information theory*, PLoS Comp Bio 14(7): e1006343). Para
nuestros sistemas con cientos de variables continuas es intractable. Proponemos
proxies que conservan la intuición y son medibles en TS puro.

### 3.1 Proxy 1 — divergencia KL bajo partición

Para un sistema con estado `s_t` y dinámica observada `P(s_{t+1} | s_t)`:

1. Estimar la distribución `P_full(s_{t+1} | s_t)` empíricamente a partir de N
   simulaciones desde `s_t` con seeds distintas.
2. Partir `s_t = (a_t, w_t)` (agente, mundo) y simular **dos sistemas separados**
   donde cada mitad evoluciona ignorando perturbaciones del otro (forzar
   `Perception.partnerPresent = false`, `interaction` deshabilitado).
3. Estimar `P_part(a_{t+1}|a_t) · P_part(w_{t+1}|w_t)`.
4. Proxy φ ≈ `KL(P_full || P_part)`.

Esto es la formulación de φ-empírico de Barrett & Seth (2011), *Practical
measures of integrated information for time-series data*, PLoS Comp Bio 7(1):
e1001052.

### 3.2 Proxy 2 — redundancia mutua

Información mutua `I(A_t; W_{t+1}) + I(W_t; A_{t+1}) − I((A,W)_t; (A,W)_{t+1})`.
Cuando agente y mundo son redundantes (cada uno predice al otro) el proxy
crece; cuando son independientes, decrece.

### 3.3 Proxy 3 — dependencia funcional histórica

Para cada decisión `d_t` registrada, medir cuánto cambia la **probabilidad
softmax** de la acción elegida si se ablacionan retroactivamente: (a) la
memoria episódica, (b) la memoria semántica, (c) la percepción de partner.
Si la suma de las tres contribuciones marginales `<` contribución conjunta,
hay integración no aditiva. Es la versión decisional del Synergy de Williams
& Beer (2010, arXiv:1004.2515).

---

## 4. Propuesta concreta de test

Archivo objetivo: `packages/ai-agency/tests/integration/phi-proxy.test.ts`.

```ts
// Pseudo-código
describe("phi-proxy: acoplado > agente + mundo", () => {
  it("KL del sistema acoplado supera suma de partes", async () => {
    const seedWorld = bootstrapWorld({ seed: 42 });
    const N = 200;

    // 1. Empirical distribution under full coupling
    const fullTrajectories = await Promise.all(
      Array.from({ length: N }, (_, k) =>
        runTicks(seedWorld, 100, { policySeed: k })
      )
    );
    const pFull = histogramOfActions(fullTrajectories);

    // 2. Partitioned: agent runs without partner perception
    const decoupled = await Promise.all(
      Array.from({ length: N }, (_, k) =>
        runTicks(seedWorld, 100, {
          policySeed: k,
          overridePerception: (p) => ({ ...p, partnerPresent: false }),
        })
      )
    );
    const pPart = histogramOfActions(decoupled);

    const phiProxy = klDivergence(pFull, pPart);

    expect(phiProxy).toBeGreaterThan(PHI_THRESHOLD); // p. ej. 0.3 nats
  });
});
```

Criterio de éxito: φ-proxy ≥ `PHI_THRESHOLD` (calibrado por baseline trivial:
sistema con drives random y sin homeostasis debe dar ≈ 0).

---

## 5. Lo que NO probamos

- No afirmamos conciencia fenoménica. IIT es controversial en su salto de
  estructura causal a *qualia* (cf. Bayne, 2018, *On the axiomatic foundations
  of the integrated information theory of consciousness*, Neuroscience of
  Consciousness 1, niy007). Nos quedamos con la mitad operacional: φ como
  métrica de integración causal.
- No buscamos maximizar φ a costa de la metáfora. Si subir φ requiere ofuscar
  el código, la decisión correcta es bajar φ.
- El proxy KL no es φ. Es un test necesario, no suficiente: φ > 0 implica
  proxy > 0; el converso no es estricto.

Lo que sí ganamos: una afirmación falsable. Si el test falla, el proyecto
**necesita** más integración (ej.: feedback fisiología → política, memoria
compartida entre entidades, etc.).
