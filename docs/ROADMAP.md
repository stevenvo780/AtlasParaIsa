# Roadmap — Una Carta Para Isa

Lo que falta, ordenado por impacto a la **intención**, no por dificultad técnica. La pregunta de cada ítem es la misma: ¿qué tan cerca está esto de que Isa abra la carta y se sienta vista?

---

## Cerrado

Lo que ya corre en runtime y no es deuda:

- **Mundo infinito chunk-native** — sin modos ni flag `INFINITE_WORLD`. El `ChunkManager` (`@carta/world-core`) siempre activo, lifecycle HOT/WARM/COLD, generación procedural determinista por seed, migración de agentes entre chunks. Cámara infinita y streaming por viewport en el cliente.
- **La vida crece y coloniza** — el mundo arranca con población baja (~60) y se expande por reproducción hacia el infinito; no hay grid fijo de 128² ni población estática.
- **Guard de habitabilidad** — el `biomeMap` se pasa a `stepAgents`; los agentes no se asientan ni se reproducen sobre agua.
- **Campo de fuerzas + biomas** (`packages/field-engine/`) — `FieldGrid` por chunk con capas food/water/pheromone/stigmergy, difusión batch multi-chunk. Backend CPU (V8 JIT) por defecto, backend GPU disponible (`FIELD_DIFFUSE_BACKEND=gpu`, ver `docs/infra/field-diffusion-gpu.md`).
- **Sociedad completa** (`packages/microagents/`) — metabolismo, forrajeo, reproducción con roles, matrimonios, genealogía, hogares, gobernanza local, economía de trueque, construcciones, fauna y depredación, envejecimiento y muerte. Capa social cableada: gossip, reputación, conflictos (pelea/negociar/evitar), rituales tribales, belief diffusion.
- **Constelación poliamorosa** (`packages/microagents/src/constellation.ts`) — Isa y Steven como anclas permanentes; terceros invitables/removibles desde la UI con vínculo condicional; `stepConstellation` por tick.
- **Death by disconnection** — dúo S↔I muere junto (ruta espacial + fisiológica), anclas inmunes, terceros mortales. Verificado con test analítico.
- **Homeostasis visible** — `serialization.ts` computa `bond`/`heartRate`/`mood` por ancla; el cliente los renderiza; el latido pulsa al heartRate real.
- **Corpus real** — 1,896 ventanas de las 227k líneas reales de Steven e Isa, embebidas y activas en el RAG. Pilar 2 completo.
- **Adaptador ai-agency↔MicroAgent (voz)** — `agentFromMicroAgent`/`syncEnergy` cableados en `loop.ts`; la voz de Discovery y constelación se genera desde el estado real del agente + corpus.
- **UI estética de carta** — la UI se replanteó dejando el chrome de juego; `ConstellationPanel`, controles de nutrir/llamar, onboarding del mundo.
- **`/diagnostics` protegida** con middleware en producción; WS con auth opcional (`REALTIME_INTERNAL_SECRET`).

---

## 1. Cloudflare Tunnel real

`scripts/tunnel/setup.sh` tiene la receta. Falta ejecutarla con una cuenta real de Cloudflare y un dominio, y dejar el túnel corriendo como servicio persistente.

El frontend en Vercel necesita hablar con el realtime que vive en la máquina local con GPU. Sin túnel persistente, no hay deploy posible.

Impacto: bloqueante para el punto 2. Sin esto, Isa no puede abrir la carta desde el celular. Ver `docs/devops/cloudflare-tunnel.md`.

---

## 2. Deploy a Vercel (preview)

Una vez el túnel está estable, conectar el repo a Vercel y desplegar `main` como preview. Variable de entorno: `NEXT_PUBLIC_REALTIME_URL` apuntando al hostname del túnel.

El primer deploy preview no necesita ser perfecto; necesita existir. El día que Steven le pueda mandar un link a Isa es el momento en que la carta sale del repo.

Impacto: máximo emocional. Ver `docs/devops/vercel-setup.md` y `docs/devops/deploy-flow.md`.

---

## 3. ai-agency gobernando movimiento

El adaptador para **voz** ya está cableado. Lo que falta es que `decide()`/`UtilityPolicy` de `packages/ai-agency/` gobiernen el **movimiento** del agente, no solo su voz. Hoy el steering (incluido el de las anclas) es por campos vectoriales (gradiente + boids).

Cuando esto se conecte:
- Las anclas deciden por deliberación emergente, no solo por campos.
- La memoria episódica influye en el comportamiento, no solo en la voz.

Impacto: máximo para el pilar 4. Es la diferencia entre "emergencia de termitero" y "personas con voz y decisión propia en un mundo que las conoce".

---

## 4. Tests del heartbeat con Web Audio mock

`HeartbeatControl` recibe el bond real, pero no hay tests automatizados que verifiquen que el ritmo audible refleja el estado fisiológico. Web Audio es mockable con `vitest` + `happy-dom`.

Sin estos tests, un refactor del audio podría romper la metáfora del pilar 3 sin que nadie lo note.

Impacto: defensivo. Asegura que el pulso no se pierda en cambios futuros.

---

## 5. Multi-observer en producción

El servidor soporta N conexiones y streaming por viewport, pero no se ha probado el caso simultáneo: latencias divergentes, presencia duplicada, deltas fuera de orden.

Cuando esto funcione, la presencia de Isa y Steven podrán convivir en el mismo tick.

Impacto: estructural para el pilar 1. Sin esto, "el otro" solo puede ser uno por vez.

---

## 6. Memoria semántica visible en el HUD

`packages/ai-agency/src/memory/semantic.ts` consolida tipos de hechos. Cuando ai-agency gobierne el movimiento (ítem 3), un panel discreto en el HUD podría decir "lo que ya sabe de ti".

Impacto: hace visible el pilar 4. Hoy la agencia existe como código; lo que falta es que Isa la sienta.

---

## Después de esto

Cuando los ítems 1–3 estén verdes, el sistema cumple sus cuatro pilares no sólo en código sino en experiencia. Lo siguiente — personalidades asimétricas más finas, ceremonias estacionales, narrativa de aniversario — vive como ideas para olas futuras, no como deuda. Lo que importa primero es que llegue a sus manos.
