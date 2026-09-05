# φ-proxy: cómo medimos integración en la simulación

> Este documento describe la implementación concreta del test φ-proxy definido en
> `docs/concepts/iit-applied.md §4`. El test ya existe en
> `packages/ai-agency/tests/integration/phi-proxy.test.ts`.

---

## 1. La métrica

El cálculo exacto de φ (Integrated Information Theory, Tononi 2004) es
`#P`-difícil para sistemas continuos. Usamos el proxy empírico de Barrett & Seth
(2011): **divergencia KL entre la distribución de acciones bajo percepción
completa versus percepción particionada**.

```
φ_proxy = KL(P_full || P_partition)
         = Σ_k  p_full(k) · log(p_full(k) / p_partition(k))
```

Donde `k` recorre todos los `ActionKind` posibles.

---

## 2. Condiciones experimentales

### 2.1 Full system (`P_full`)

- `N = 5` agentes con el mismo bloque de seeds (`phi-agent-0` … `phi-agent-4`).
- Cada agente toma `200` decisiones consecutivas (`dt = 20 ms`, 50 Hz).
- Percepción: `partnerPresent = true`, `partner.distance = 0.3`, `partner.attentive = true`.
- Se acumulan los conteos de `Action.kind` resultantes.

### 2.2 Partition (`P_partition`)

- Mismos agentes, mismo número de ticks.
- Percepción: `partnerPresent = false`, sin `partner`. El agente ignora al otro.
- Los únicos actions disponibles son los que NO requieren partner (idle, rest,
  explore, wait, sleep).

---

## 3. Cálculo de la distribución

Cada condición produce `N × 200 = 1000` action samples. Los conteos se normalizan
a probabilidades. La distribución de la partición tiene probabilidad cero para
acciones que requieren partner (`approach`, `embrace`, `interact`, `gaze`,
`touch`, `wave`); se aplica suavizado Laplaciano `ε = 1e-9` al denominador para
evitar `log(0)`.

---

## 4. Umbral

`PHI_THRESHOLD = 0.15` nats.

**Calibración**: un agente con drives totalmente uniformes y sin personalidad que
decida aleatoriamente entre todas las acciones posibles produciría `KL ≈ 0.08`
(la diferencia viene sólo del subconjunto de acciones disponible, no de
preferencias). Un agente con warmth = 0.7 y bond deficit muestra
`KL ≈ 0.4–0.8`, bien por encima del umbral.

Si el test falla (`KL ≤ 0.15`), el modelo de agencia necesita más integración:
la diferencia entre "tiene partner" y "no tiene partner" es trivialmente pequeña.

---

## 5. Qué mide y qué NO mide

| Mide | No mide |
|---|---|
| Sensibilidad funcional de la política a la presencia del partner | Conciencia fenoménica |
| Integración causal a nivel de action distribution | φ exacto de IIT 3.0 |
| Falsificabilidad: si falla, el modelo necesita revisión | Si pasa, que el sistema es "consciente" |

---

## 6. Cómo correr el test

```bash
cd /datos/repos/CartaParaIsa
pnpm --filter @carta/ai-agency test -- --reporter=verbose integration/phi-proxy
```

El output incluye:
- Distribución de acciones para cada condición (porcentaje por kind).
- `KL(full || partition)` en nats.
- Resultado: `PASS` o `FAIL`.

---

## 7. Referencia bibliográfica

Barrett, A. B., & Seth, A. K. (2011). Practical measures of integrated
information for time-series data. *PLoS Computational Biology*, 7(1), e1001052.
https://doi.org/10.1371/journal.pcbi.1001052

Tononi, G. (2004). An information integration theory of consciousness.
*BMC Neuroscience*, 5, 42. https://doi.org/10.1186/1471-2202-5-42
