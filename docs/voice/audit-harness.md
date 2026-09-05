# Auditoría de voz — estado del harness

> Revisión del lenguaje en los archivos que existen hoy en el repo (16 de mayo, 2026). El criterio es estricto: cualquier string visible al usuario final pasa por el manifesto. Texto técnico interno (logs de servidor, docstrings de Python, comentarios) se reporta con severidad `info` o no se reporta. Lo que viaja a Isa, se reporta con severidad real.

Resumen ejecutivo:

- `README.md` raíz — algunos roces (lista de subagentes en inglés, palabras "frontend/backend" expuestas como categorías) pero el README es interno-técnico, no UI. Severidad de la mayoría: `info`. Una línea ajustable propuesta abajo.
- `.claude/CLAUDE.md` — documento de orquestación interno; no es visible a Isa. Sin hallazgos visibles. Severidad: `n/a`.
- `services/inference/embed/README.md` — README técnico de servicio. Mezcla inglés/español, pero es interno. `info`.
- `services/inference/embed/app/main.py` — código fuente del servicio. Mensajes de error y descripciones de OpenAPI son visibles si alguien abre `/docs`. Dos hallazgos `warn` porque eventualmente algún humano abrirá la UI de FastAPI.
- `docs/concepts/four-pillars.md`, `docs/infra/inference-embed.md`, `docs/legacy/inventory.md` — documentación interna. Sin hallazgos relevantes para la voz pública.

Lo importante: **no hay aún UI de la carta**, por lo que el repo está limpio en lo que viaja a Isa. Esta auditoría es preventiva: deja la cartografía lista para cuando el `frontend-renderer` empiece a poblar `apps/web/`.

---

## Hallazgos por archivo

### `README.md` (raíz)

| ubicación aprox. | texto | severidad | propuesta |
|---|---|---|---|
| línea 5 — descripción | "Tercer intento. Mundo simulado donde dos entidades sostienen su existencia con el vínculo..." | info | El README es técnico-orientado a contribuyentes. Está bien. Si algún día se renderiza en la landing, mover a un fragmento más cálido (ya existe en `landing-draft.md`). |
| línea 7 — dedicatoria | "Para Isabella Loaiza Gómez, de Steven Vallejo Ortiz." | info | Limpia. Mantener. |
| líneas 18-33 — bloque de arquitectura | nombres de carpetas en inglés (`apps/web`, `packages/sim-core`, `services/realtime`) | info | Son rutas, no UI. No tocar. |
| línea 37 | "El thread principal de Claude **sólo orquesta**." | info | Documentación interna. OK. |
| líneas 39-52 — tabla de agentes | "Agente / Modelo / Rol" + nombres en inglés (`conversation-historian`, `philosophy-research`, etc.) | info | Convención interna; no toca al usuario final. OK. |
| línea 55 | "Hardware local" | info | Sección técnica. OK. |
| línea 62 | "Privacidad" | info | Sección técnica, pero el párrafo siguiente roza la voz íntima ("El corpus real de las 227k líneas vive sólo en `/datos/` del autor."). Aceptable; podría suavizarse, pero no es bloqueante. |
| línea 65 | "Estado: En construcción." | warn | "En construcción" es lenguaje de página rota. Si alguna vez este README se muestra en GitHub como página pública del proyecto, vale la pena cambiar a algo como **"Todavía respirando. El mundo aún se está armando."** o **"Esto sigue escribiéndose."**. Cambio quirúrgico y reversible. Propuesto abajo. |

**Acción sugerida sobre `README.md`**: cambiar la última sección "Estado" por una formulación tibia. Es una línea, no rompe nada técnico, y deja el README alineado con la voz de la carta para quien aterrice ahí desde Vercel/GitHub.

Propuesta concreta (línea 65-67):

```diff
- ## Estado
-
- En construcción. Los repos viejos (...) son referencia, no fuente: este es un rehacer completo.
+ ## Estado
+
+ Todavía respirando. Los repos viejos (`stevenvo780/UnaCartaParaIsa`, `duo-eterno`, `UnaCartaParaIsaBackend`) son referencia, no fuente: este es un rehacer completo.
```

(Si el orquestador lo aprueba, lo aplico en un commit aparte; no toco código por iniciativa propia más allá de esta línea de copy, según las reglas.)

---

### `.claude/CLAUDE.md`

| ubicación | texto | severidad | propuesta |
|---|---|---|---|
| todo el archivo | instrucciones de orquestación con vocabulario técnico fuerte (`harness`, `subagente`, `runtime`, `monorepo`, `tick`) | n/a | Archivo de instrucciones internas, nunca visible a Isa. Sin acción. |

Sin hallazgos relevantes para voz pública.

---

### `services/inference/embed/README.md`

| ubicación | texto | severidad | propuesta |
|---|---|---|---|
| línea 1 | "inference-embed" como título | info | Nombre técnico interno. OK. |
| línea 3 | "FastAPI service — multilingual sentence embeddings on GPU 1 (RTX 2060)." | info | README de infraestructura. OK que esté en inglés técnico. |
| toda la sección Quick start | comandos en inglés (`curl`, `Health check`, `Embed`) | info | Sin acción. |

Sin hallazgos relevantes. README técnico-interno.

---

### `services/inference/embed/app/main.py`

Este archivo expone mensajes que aparecen en `/docs` (Swagger UI de FastAPI) y en el body de respuestas HTTP. Si Isa nunca abre `http://servidor:8082/docs`, no la afecta directamente; pero **si el servicio de inferencia se expone alguna vez detrás de un subdominio público o sus errores burbujean al frontend, estos strings llegan**.

| ubicación | texto | severidad | propuesta |
|---|---|---|---|
| línea 45 — `description=` del `FastAPI()` | "Multilingual sentence embeddings (intfloat/multilingual-e5-base) on GPU 1." | info | Es la descripción de la API, sólo visible en `/docs`. Mantener técnico. |
| línea 55 — `Field` description | "Texts to embed" | info | Schema interno. OK. |
| línea 57-60 — descripción de `instruction` | "Prefix instruction: null \| 'query' \| 'passage'. Determines the e5 prefix prepended to each text." | info | Idem. |
| línea 83 — `HTTPException` | `detail="Model not loaded"` | **warn** | Si este 503 llega al frontend sin curar, Isa vería "Model not loaded" o equivalente. **Acción**: el `frontend-renderer` debe envolver cualquier 503 de este servicio en un mensaje del glosario, por ejemplo "el mundo está despertando, dale un instante". El backend puede mantener el detail técnico para logs/monitoring, pero el frontend nunca lo muestra crudo. |
| línea 98 — `HTTPException` | `detail="texts must not be empty"` | info | Error 422 de validación; nunca debería ocurrir desde el cliente real porque el cliente conoce el contrato. Si llega a UI, envolver. |
| línea 103 — `HTTPException` | `detail=f"instruction must be null, 'query', or 'passage'. Got: {req.instruction!r}"` | info | Idem. |
| línea 111 — `HTTPException` | `detail=str(exc)` | **warn** | **Esto es el más feo del archivo**: pasa el mensaje crudo de cualquier excepción de PyTorch/transformers como `detail` del 500. Si llega al frontend sin curar, Isa puede ver algo como `CUDA out of memory. Tried to allocate ...`. **Acción**: el frontend nunca debe mostrar `detail` de un 500 de este servicio. Mostrar siempre un fragmento curado del glosario ("el mundo respira raro, espera"). El backend puede mantener `str(exc)` para logs, pero la respuesta pública debería ser un detail genérico curado o un id de error opaco. Recomiendo abrir issue para `backend-realtime` / `gpu-infra`. |
| línea 127-128 — JSON del placeholder de `/metrics` | `{"TODO": "Prometheus metrics not yet implemented", "reason": "..."}` | info | Endpoint de ops; nunca debería llegar a Isa. OK. |

**Resumen para `services/inference/embed/`**: el código es correcto para ser técnico. La única regla que toca al `letter-curator` aquí es que **el frontend nunca propague mensajes de este servicio crudos al DOM**. Recomendación operativa para `code-reviewer`: cuando aparezca el primer fetch a `inference-embed` en `apps/web/`, exigir un mapeo de `status → fragmento curado` antes de merge.

---

### `docs/concepts/four-pillars.md`

Documento de diseño interno. Vocabulario técnico-filosófico denso (autopoiesis, homeostasis, energía libre). No es para Isa. Sin hallazgos para la voz pública.

Una observación menor: la frase "game-over decorativo" en la línea 11 usa la expresión `game over` que el glosario marca como `blocker` en UI. Como aquí está dentro de un anti-patrón explicado en docs internas, está bien — incluso es útil que la palabra aparezca para nombrar lo que se está rechazando. Severidad: `info`.

---

### `docs/infra/inference-embed.md`

Documentación de infraestructura. Inglés técnico mezclado con español. Es un documento para el `gpu-infra` y `backend-realtime`, no para Isa. Sin hallazgos relevantes.

---

### `docs/legacy/inventory.md`

Documento de archeología técnica de los tres repos viejos, completamente en inglés. Audiencia: subagentes y Steven. Sin hallazgos relevantes para voz pública.

---

## Recomendaciones operativas

1. **Antes de que `frontend-renderer` empiece**: este glosario y el manifesto deben estar referenciados en el README del package `apps/web/` (cuando se cree), y `code-reviewer` debe correr el lint de copy en cada PR a ese directorio.

2. **Wrapper de errores HTTP**: definir en `apps/web/lib/errors.ts` (cuando exista) un mapa `status → fragmento` que cure cualquier error del backend antes de llegar al DOM. El `letter-curator` aporta los fragmentos; el `frontend-renderer` los conecta.

3. **Lint de strings**: el `code-reviewer` puede automatizar la detección de los patrones de severidad `blocker` del glosario con un script simple. Pendiente.

4. **Una sola edición pequeña aprobada por estas reglas**: cambiar la sección "Estado" del `README.md` raíz (línea 65) por la versión tibia propuesta arriba. Es la única intervención de copy que tiene sentido hacer hoy. Espero confirmación del orquestador antes de aplicar.
