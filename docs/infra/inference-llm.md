# inference-llm — LLM en GPU 0 (RTX 5070 Ti, 16 GB)

Servicio que expone la API OpenAI-compatible para diálogo emergente y planeación
de mediano plazo de las entidades de simulación. Invocado bajo demanda por
`packages/ai-agency/`. API SSE streaming nativa.

---

## Modelo activo: Qwen/Qwen3-14B-GGUF Q5_K_M

### Historial de decisiones de modelo/stack

**Candidato original**: Qwen/Qwen3-14B-AWQ con vLLM v0.9.0.
Los pesos AWQ se descargaron correctamente (~9.3 GB, 2 shards en
`/datos/models/hf/hub/models--Qwen--Qwen3-14B-AWQ/`).

**Por qué se cambio a llama.cpp**:

vLLM v0.9.0 carga los pesos de AWQ sin problema pero falla en `profile_run()` con:
```
RuntimeError: CUDA error: no kernel image is available for execution on the device
```
El error ocurre en `ggml/v1/worker/gpu_model_runner.py:profile_run()` durante la
etapa de probing de VRAM. El problema no es el modelo AWQ sino que el runtime de
PyTorch 2.7 dentro del contenedor vLLM v0.9.0 no tiene kernels compilados para
sm_120 (Blackwell consumer, RTX 5070 Ti GB203). vLLM 0.9.0 incluye kernels
Blackwell pero están compilados para sm_90 (Hopper) y sm_89 (Ada), no sm_120.

La imagen oficial `vllm/vllm-openai:v0.9.0` usa CUDA 12.8 / PyTorch 2.7 y
aunque agrega "soporte Blackwell", este soporte aplica a H100 (sm_90) y
potencialmente GB100 (sm_100), no al GB203 consumer (sm_120) que usa la RTX 5070 Ti.

**Solución: llama.cpp compilado con `CMAKE_CUDA_ARCHITECTURES=120`**

llama.cpp gestiona sus propios kernels CUDA directamente sin depender de
PyTorch. La compilación con CUDA 12.8 y `-arch=sm_120` verificó OK. La imagen
`carta-llm-llamacpp:sm120` (3.4 GB) está construida y lista.

**Por qué se cambio de AWQ a GGUF Q5_K_M**:
llama.cpp no soporta el formato AWQ de safetensors directamente.
Q5_K_M (~10.5 GB) ofrece calidad muy similar a AWQ INT4 (~9.3 GB).
Mismo modelo base (Qwen3-14B), mismo comportamiento en español.

**Plan B documentado si llama.cpp también falla**: usar llama.cpp con
`-ngl 0` (sin GPU, solo CPU), con degradación de velocidad (~3-5 tok/s vs
~70 tok/s medidos). No bloqueante para el proyecto — la agencia
funciona con latencias de 10-20s.

| Campo | Valor |
|---|---|
| Repo HuggingFace | `Qwen/Qwen3-14B-GGUF` |
| Archivo | `Qwen3-14B-Q5_K_M.gguf` |
| Parametros | 14.8B (mismo modelo base que AWQ) |
| Cuantizacion | GGUF Q5_K_M (5 bits, perdida minima) |
| Tamaño en disco | 10,514,569,568 bytes (~10.5 GB) |
| VRAM medida (estado estable) | 14,784 MiB de 16,303 MiB totales |
| Licencia | Apache 2.0 |
| Idiomas | 100+ (español de Colombia nativo) |
| Ventana de contexto | 40,960 tokens nativos |
| ctx-size configurado | 16,384 tokens (conservador) |
| Function calling | Si (format tool use Qwen3) |
| Thinking mode | Si. Desactivar via `chat_template_kwargs: {enable_thinking: false}` (requiere --jinja en servidor, configurado). Fallback: `/no_think` en system prompt produce bloque vacio que hay que stripear. |

---

## Hardware

| Campo | Valor |
|---|---|
| GPU | NVIDIA GeForce RTX 5070 Ti (GPU 0) |
| Compute capability | sm_120 (Blackwell GB203) |
| VRAM total | 16,303 MiB |
| VRAM usada (modelo cargado) | 14,784 MiB |
| VRAM libre (overhead operativo) | 1,519 MiB |
| CUDA en host | 13.0 (driver) / 12.8 (toolkit en container) |
| Docker CDI | `nvidia.com/gpu=0` |

---

## Stack

| Componente | Version | Razon |
|---|---|---|
| llama.cpp server | b5540 | Compila con sm_120 directamente, sin depender de PyTorch |
| Imagen Docker | `carta-llm-llamacpp:sm120` (3.4 GB) | Build custom con CMAKE_CUDA_ARCHITECTURES=120 |
| Base builder | `nvidia/cuda:12.8.1-devel-ubuntu22.04` + `ENV NVIDIA_VISIBLE_DEVICES=void` | La imagen devel tiene CUDA pre-instalado. void neutraliza la inyeccion de GPU que dispara el bug eBPF del kernel 6.17 en docker build |
| Base runtime | `nvidia/cuda:12.8.1-runtime-ubuntu22.04` | Runtime minimo (CDI en docker run, no en docker build) |
| GGML_CUDA_NO_VMM | ON | Evita linker error con cuMemAddressReserve en build stage |
| BUILD_SHARED_LIBS | OFF | Compila llama-server estaticamente — no necesita copiar libggml.so/libllama.so |

### Limitaciones conocidas de llama.cpp b5540

- `--served-model-name` no existe en b5540 (agregado en builds posteriores). Sin este flag, `/v1/models` reporta el path del GGUF como model ID: `/models/gguf/Qwen3-14B-Q5_K_M.gguf`. Los clientes deben usar ese ID exacto.
- `--chat-template qwen3` sin `--jinja` falla en b5540. Se omite porque el GGUF de Qwen3 embebe el chat template (chatml/Qwen3) y llama.cpp lo detecta automaticamente.

---

## Descarga del modelo

### Metodo recomendado: hf_hub_download (Python)

```python
# Ejecutar con: python3 scripts/gpu/download-gguf.py
from huggingface_hub import hf_hub_download
import os

local_path = hf_hub_download(
    repo_id="Qwen/Qwen3-14B-GGUF",
    filename="Qwen3-14B-Q5_K_M.gguf",
    local_dir="/datos/models/gguf",
)
print(f"Downloaded: {local_path}, {os.path.getsize(local_path)} bytes")
```

O desde bash (si hf CLI esta disponible y funciona):
```bash
hf download Qwen/Qwen3-14B-GGUF Qwen3-14B-Q5_K_M.gguf --local-dir /datos/models/gguf/
```

`hf_hub_download` usa el protocolo XET/CAS-bridge y escribe a
`/datos/models/gguf/.cache/huggingface/download/<hash>.incomplete` mientras descarga,
luego hace rename atomico a `Qwen3-14B-Q5_K_M.gguf` al completar. El proceso tarda
~45-60 min desde una conexion tipica (~3 MB/s sostenido).

**Advertencia**: NO ejecutar multiples descargas simultaneas al mismo destino — el
archivo `.incomplete` se corrompe. Si un proceso anterior quedo a medias, borrar el
`.lock` y el `.incomplete` del directorio `.cache/huggingface/download/` antes de
reiniciar.

### Metodo alternativo: curl byte-range (si hf falla)

```bash
# Obtener URL de descarga (expira en 1 hora)
GGUF_URL=$(curl -sI \
  "https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q5_K_M.gguf" \
  | grep -i "^location:" | tr -d '\r' | awk '{print $2}')

mkdir -p /datos/models/gguf

# Descarga en paralelo (4 chunks) — obtener la URL y lanzar de inmediato
# para no agotar el TTL de 1 hora antes de que los chunks terminen.
TOTAL=10514569568
CHUNK=$((TOTAL / 4))
for i in 0 1 2 3; do
  START=$((i * CHUNK))
  END=$(( (i + 1) * CHUNK - 1 ))
  if [ $i -eq 3 ]; then END=$TOTAL; fi
  curl -r "$START-$END" -L --retry 0 --silent \
    --output /datos/models/gguf/Qwen3-14B-Q5_K_M.part$i \
    "$GGUF_URL" &
done
wait

# Concatenar partes
cat /datos/models/gguf/Qwen3-14B-Q5_K_M.part{0,1,2,3} \
  > /datos/models/gguf/Qwen3-14B-Q5_K_M.gguf
rm /datos/models/gguf/Qwen3-14B-Q5_K_M.part{0,1,2,3}
```

Si la URL CAS expira a mitad de descarga (TTL 3600s), re-ejecutar desde
la obtencion de GGUF_URL con los offsets correspondientes via `-C -`.

Verificar completitud:
```bash
# Debe ser exactamente 10514569568 bytes
ls -la /datos/models/gguf/Qwen3-14B-Q5_K_M.gguf
```

Ubicacion final en host: `/datos/models/gguf/Qwen3-14B-Q5_K_M.gguf`
Montado en el contenedor como: `/models/gguf/Qwen3-14B-Q5_K_M.gguf`
(el volumen `models` en compose.yaml mapea `/datos/models` → `/models`)

---

## Build de la imagen Docker

```bash
# Construir desde el repo
docker compose -f /datos/repos/CartaParaIsa/docker/compose.yaml \
  --profile inference build inference-llm

# O directo:
docker build --build-arg CUDA_ARCH=120 -t carta-llm-llamacpp:sm120 \
  services/inference/llm/

# Verificar imagen
docker images | grep carta-llm-llamacpp
# carta-llm-llamacpp:sm120   <id>   ~3-4 GB
```

Tiempo de build: ~5-8 min (usa imagen `nvidia/cuda:12.8.1-devel-ubuntu22.04` preexistente con CUDA toolkit, solo compila llama.cpp con CUDA support para sm_120).

**Nota sobre el eBPF bug y la solucion**:

Las imagenes `nvidia/cuda:*-devel-ubuntu22.04` definen `NVIDIA_VISIBLE_DEVICES=all`, lo que
activa el hook nvidia-container-runtime en TODOS los contenedores del proceso de build.
En el kernel 6.17 de este host, ese hook falla con el error eBPF.

La solucion es agregar `ENV NVIDIA_VISIBLE_DEVICES=void` inmediatamente despues del `FROM`
en el builder stage. nvidia-container-runtime respeta este valor y NO inyecta GPU para los
contenedores del build. La imagen nvidia/cuda devel tiene CUDA pre-instalado, por lo que
el compilador y las libs estan disponibles sin necesitar GPU en tiempo de compilacion.

El stage de runtime (`nvidia/cuda:12.8.1-runtime-ubuntu22.04`) NO necesita este fix porque
solo se usa en `docker run --device nvidia.com/gpu=0` (CDI), que es el mecanismo correcto.

---

## Levantar el servicio

### Prerequisito: verificar que el GGUF está completo

```bash
ls -la /datos/models/gguf/Qwen3-14B-Q5_K_M.gguf
# Debe mostrar exactamente 10514569568 bytes
```

### Comando

```bash
docker compose -f /datos/repos/CartaParaIsa/docker/compose.yaml \
  --profile inference up -d inference-llm

# Seguir logs (carga inicial del modelo: ~2-3 min)
docker compose -f /datos/repos/CartaParaIsa/docker/compose.yaml \
  logs -f inference-llm
```

### Tiempo de arranque

- Primera vez: ~2-3 minutos (carga del GGUF en VRAM, ~10.5 GB)
- Arranques subsiguientes: ~60-90 segundos

### Puerto del host

**Puerto 8091** (no 8081 — VS Code Insiders ocupa 8081 en este host). Puerto interno del contenedor: 8000.

---

## VRAM en estado estable

| Componente | VRAM | Fecha medicion |
|---|---|---|
| Pesos del modelo Q5_K_M (offloading completo, -ngl 999) | ~10.5 GB | 2026-05-16 |
| KV cache (ctx-size=16384, 1 slot) | ~2.8 GB | 2026-05-16 |
| Overhead CUDA / kernels / graphs | ~1.5 GB | 2026-05-16 |
| **Total medido (2026-05-16)** | **14,784 MiB de 16,303 MiB (90.7%)** | |
| **Total medido (2026-05-24, con --jinja)** | **15,137 MiB de 16,303 MiB (92.8%)** | |

Nota 2026-05-24: el flag `--jinja` activa el motor Jinja completo para el chat template,
lo que incrementa el overhead de ~350 MiB respecto a la medicion anterior. El margen libre
es 701 MiB — suficiente para el slot unico con contextos de hasta 4096 tokens de entrada,
pero ajustado si se aumenta `--ctx-size` a 32768. No aumentar ctx-size hasta confirmar
que la VRAM libre es estable bajo carga sostenida.

---

## Latencias medidas (RTX 5070 Ti, Q5_K_M, batch=1)

| Metrica | Valor | Condiciones | Fecha |
|---|---|---|---|
| TTFT (primer token, ~60 tokens de prompt) | ~23 ms | Flash Attention, cold start | 2026-05-16 |
| Tokens/s generacion (estable) | ~71-74 tok/s | runs de 22-177 tokens | 2026-05-16 |
| Prefill speed (tokens prompt/s) | ~950-1,424 tok/s | cache hit vs cold | 2026-05-16 |
| Latencia total 22 tokens | ~313 ms | HTTP end-to-end | 2026-05-16 |
| Latencia total 177 tokens | ~2.5 s | generacion sustancial | 2026-05-16 |
| **TTFT utterance 6 tok, no-think (voz)** | **~14 ms** | `enable_thinking: false`, 32 tok prompt | **2026-05-24** |
| **Latencia total 6 tokens (voz)** | **~167 ms** | end-to-end HTTP, no-think | **2026-05-24** |
| **Tokens/s generacion (2026-05-24)** | **~58-67 tok/s** | `--jinja` overhead | **2026-05-24** |
| Latencia total 50 tokens (voz larga) | ~911 ms | end-to-end HTTP | 2026-05-24 |

---

## Contrato HTTP

El servicio es 100% OpenAI-compatible. Puerto host: **8091**. Puerto interno: 8000.

**Importante**: sin `--served-model-name` (no soportado en b5540), el model ID
reportado por `/v1/models` es el path del GGUF: `/models/gguf/Qwen3-14B-Q5_K_M.gguf`.
Los clientes deben usar ese string exacto en el campo `"model"`.

### `GET /health`

```bash
curl http://localhost:8091/health
# Retorna 200 {"status":"ok"} cuando el modelo termino de cargar
```

### `GET /v1/models`

```bash
curl http://localhost:8091/v1/models | python3 -m json.tool
# "id": "/models/gguf/Qwen3-14B-Q5_K_M.gguf"
```

### `GET /metrics`

```bash
# llama.cpp no expone metricas Prometheus nativas (a diferencia de vLLM).
# Para Prometheus, se necesita un exporter externo o el endpoint /metrics de
# llama-server (beta, no en formato Prometheus).
# TODO: agregar prometheus-exporter para llama.cpp si se activa el stack observe.
```

### `POST /v1/chat/completions` — modo streaming (dialogo / voz de constelacion)

```bash
# enable_thinking: false requiere --jinja en el servidor (configurado en compose)
# El campo "model" acepta cualquier string — llama-server lo ignora en b5540.
curl http://localhost:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/models/gguf/Qwen3-14B-Q5_K_M.gguf",
    "messages": [
      {
        "role": "system",
        "content": "Eres una entidad pequeña que vive en un mundo simulado. No eres un asistente. Hablas en español de Colombia, en minúscula, máximo dos líneas."
      },
      {"role": "user", "content": "¿cómo te sientes hoy?"}
    ],
    "max_tokens": 40,
    "temperature": 0.85,
    "top_p": 0.9,
    "repeat_penalty": 1.1,
    "stop": ["<|im_end|>", "\n\n"],
    "stream": true,
    "chat_template_kwargs": {"enable_thinking": false}
  }'
```

### `POST /v1/chat/completions` — modo batch (procesos offline)

```bash
curl -s -X POST http://localhost:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "/models/gguf/Qwen3-14B-Q5_K_M.gguf",
    "messages": [{"role": "user", "content": "Planea las proximas 3 horas de la entidad..."}],
    "max_tokens": 512,
    "temperature": 0.3,
    "stream": false
  }' | python3 -m json.tool
```

### Respuesta real de validacion (2026-05-24, enable_thinking=false)

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Te echo de menos."
    },
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 45, "completion_tokens": 6, "total_tokens": 51},
  "timings": {
    "prompt_per_second": 853.0,
    "predicted_per_second": 61.6,
    "predicted_ms": 97.4
  }
}
```

Latencia total HTTP end-to-end: 167 ms. Sin `<think>` — el contenido empieza directamente.
Con `chat_template_kwargs: {enable_thinking: false}` y `--jinja` activo, no se necesita stripear nada.

---

## Thinking mode de Qwen3 — metodo verificado (2026-05-24)

Qwen3 tiene modo de razonamiento (thinking mode) que genera bloques `<think>...</think>`.
Para voz de constelacion se necesita supresion completa del CoT. Hay dos mecanismos:

### Metodo correcto: `chat_template_kwargs` (verificado, SIN prefijo `<think>`)

Requiere `--jinja` en el servidor (ya configurado en compose desde 2026-05-24).
El cliente incluye en el body del request:

```json
{
  "chat_template_kwargs": {"enable_thinking": false}
}
```

Resultado: el template Jinja de Qwen3 omite el bloque `<think>` completamente.
La respuesta empieza directamente con el contenido. Verificado 2026-05-24.

### Metodo fallback: `/no_think` en system prompt (produce prefijo vacio)

```
"Eres una entidad... /no_think"
```

Produce `<think>\n\n</think>` vacio (2-3 tokens de overhead) seguido del contenido.
Los clientes deben stripear ese prefijo: `content.replace(/^<think>[\s\S]*?<\/think>\n\n/, "")`.
Util si por alguna razon `--jinja` esta desactivado.

### Planeacion offline (CoT habilitado)

Omitir `chat_template_kwargs` por completo — el modelo razonara antes de responder.
El thinking mode completo genera ~100-500 tokens de razonamiento, aumenta latencia
pero mejora coherencia para tareas complejas.

---

## Contrato para voz de constelacion (LLMPolicy — realtime/ai-agency)

Endpoint: `POST http://inference-llm:8000/v1/chat/completions` (red interna carta)
         `POST http://localhost:8091/v1/chat/completions` (desde host)

Timeout recomendado: **3000 ms** para utterances de voz (max_tokens <= 60).
Si el LLM no responde en 3s, el caller debe degradar a silencio (no bloquear el sim loop).

Parametros recomendados para voz intima (frases cortas):

```json
{
  "model": "/models/gguf/Qwen3-14B-Q5_K_M.gguf",
  "messages": [
    {"role": "system", "content": "<persona_y_contexto_RAG>"},
    {"role": "user",   "content": "<trigger_emocional>"}
  ],
  "max_tokens": 40,
  "temperature": 0.85,
  "top_p": 0.9,
  "repeat_penalty": 1.1,
  "stop": ["<|im_end|>", "\n\n"],
  "stream": true,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

- `max_tokens: 40` — cap duro para utterances breves (frases de 5-15 palabras).
  Para dialogos mas largos, subir a 80-100. Para planeacion offline, 512+.
- `temperature: 0.85` — expresividad emocional sin perder coherencia.
  Bajar a 0.6-0.7 para respuestas mas predecibles (tareas de decision).
- `repeat_penalty: 1.1` — evita loops en frases cortas.
- `stop: ["<|im_end|>", "\n\n"]` — corta al final del turno o parrafo.
- `stream: true` — SSE para dialogo en tiempo real (el frontend puede mostrar
  cada token a medida que llega). Usar `stream: false` para batch/planeacion.
- `chat_template_kwargs.enable_thinking: false` — OBLIGATORIO para voz. Sin esto,
  Qwen3 genera `<think>...</think>` que introduce 100-500 tokens de latencia extra.

Patron de degradacion para realtime:

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 3000);
try {
  const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  // procesar SSE stream...
} catch (e) {
  // timeout o LLM saturado: entidad guarda silencio este tick
  emitSilence(entityId);
} finally {
  clearTimeout(timeout);
}
```

---

## Stub TypeScript para `packages/ai-agency/`

```typescript
// LLMPolicy — consume el endpoint OpenAI-compatible de inference-llm
// Puerto host: 8091 (desde host). Dentro de red Docker "carta": http://inference-llm:8000
// Model ID: el path del GGUF (sin --served-model-name en b5540).
const LLM_URL = process.env.LLM_URL ?? "http://localhost:8091";
const LLM_MODEL = "/models/gguf/Qwen3-14B-Q5_K_M.gguf";

// Timeout recomendado para voz (utterances cortas): 3000 ms.
// Timeout para planeacion offline (batch): 30000 ms.
const VOICE_TIMEOUT_MS = 3000;
const BATCH_TIMEOUT_MS = 30000;

export async function generateVoice(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<ReadableStream | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VOICE_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 40,
        temperature: opts.temperature ?? 0.85,
        top_p: 0.9,
        repeat_penalty: 1.1,
        stop: ["<|im_end|>", "\n\n"],
        stream: true,
        chat_template_kwargs: { enable_thinking: false },  // OBLIGATORIO para voz
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;  // degradar a silencio
    return res.body!;
  } catch {
    return null;  // timeout o LLM saturado — entidad guarda silencio
  } finally {
    clearTimeout(timer);
  }
}

export async function generateBatch(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BATCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.3,
        stream: false,
        // CoT habilitado para planeacion: omitir chat_template_kwargs
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices[0].message.content as string;
    // Si se uso /no_think en lugar de chat_template_kwargs, stripear bloque vacio:
    return content.replace(/^<think>[\s\S]*?<\/think>\n\n/, "");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

---

## Estado actual (2026-05-24)

| Item | Estado |
|---|---|
| Pesos AWQ (`/datos/models/hf/hub/models--Qwen--Qwen3-14B-AWQ/`) | Completo (9.3 GB, en reserva) |
| GGUF Q5_K_M (`/datos/models/gguf/Qwen3-14B-Q5_K_M.gguf`) | Completo (10,514,569,568 bytes) |
| Imagen Docker (`carta-llm-llamacpp:sm120`, 3.45 GB) | Construida: sha256:8dc1304eeaaf |
| Contenedor `carta-llm` | En ejecucion, HEALTHY (puerto 8091) |
| VRAM (2026-05-24, con --jinja) | 15,137 MiB / 16,303 MiB (92.8%), libre: 701 MiB |
| Thinking mode | Deshabilitado con `chat_template_kwargs.enable_thinking=false` + `--jinja` |
| Velocidad de generacion (2026-05-24) | 58-67 tok/s (--jinja overhead vs 71-74 anterior) |
| Latencia voz (6 tokens, no-think) | ~167 ms end-to-end |
| Validacion voz intima | "Te echo de menos." / "No te extraño." — directo, sin CoT |
| Contrato voz documentado | Ver seccion "Contrato para voz de constelacion" arriba |
| Embed (:8082) | HEALTHY — vectors: 1x768, multilingual-e5-base en GPU 1 |

### Solucion definitiva al bug eBPF en docker build (2026-05-16)

El bug afecta a `nvidia-container-cli` cuando el kernel 6.17 intenta cargar programas
eBPF para device filtering. La solucion es:

```dockerfile
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04 AS builder
ENV NVIDIA_VISIBLE_DEVICES=void  # <- esta linea
```

`NVIDIA_VISIBLE_DEVICES=void` indica al nvidia-container-runtime que NO inyecte GPU
en este contenedor. Se puede usar la imagen devel completa (con todos los headers y
libs de CUDA pre-instalados) sin el overhead de descargar el toolkit desde apt.
Verificado: `docker build` y `docker run --device nvidia.com/gpu=0` ambos funcionan
correctamente con esta configuracion.

---

## Troubleshooting

### vLLM falla con "no kernel image is available"

Error documentado en este host. El RTX 5070 Ti (sm_120) no es soportado
por vLLM v0.9.0 en runtime aunque los kernels Blackwell estén "incluidos".
El soporte "Blackwell" de vLLM 0.9.0 aplica a GPUs de datacenter (sm_90,
sm_100), no al GB203 consumer (sm_120).

Solucion: llama.cpp compilado con `CMAKE_CUDA_ARCHITECTURES=120`. Ver
`services/inference/llm/Dockerfile`.

### OOM al cargar el GGUF

Si llama.cpp sale con OOM durante la carga:
1. Reducir `-ngl` a un numero menor que 999 (capas en GPU). Con `-ngl 40`
   las ultimas capas quedan en CPU — reduce VRAM pero aumenta latencia.
2. Reducir `--ctx-size` a 8192.
3. Cambiar a Q4_K_M (9.0 GB) en lugar de Q5_K_M (10.5 GB).

### CDI: `nvidia.com/gpu=0` no funciona

Verificar CDI:
```bash
docker run --rm --device nvidia.com/gpu=0 nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi
```

NO usar `--gpus all` (bug eBPF en kernel 6.17).

### GGUF download incompleto

Si el archivo `.gguf` tiene menos de 10514569568 bytes, el servidor no
arrancara correctamente. Verificar:
```bash
ls -la /datos/models/gguf/Qwen3-14B-Q5_K_M.gguf | awk '{print $5}'
# Debe ser: 10514569568
```

Si la descarga se interrumpio (URL CAS expirada despues de 1 hora), re-ejecutar
el bloque de descarga completo desde el principio (incluyendo GGUF_URL).

### llama.cpp no encuentra el chat template "qwen3"

En b5540, `--chat-template qwen3` requiere `--jinja` y falla sin el. Pero
el GGUF de Qwen3-14B-Q5_K_M.gguf incluye el chat template embebido (chatml).
llama.cpp lo detecta automaticamente — no se necesita `--chat-template`.

---

## TODOs

- [ ] Evaluar si agregar Prometheus exporter para llama.cpp (o usar el endpoint
      `/metrics` beta de llama-server).
- [ ] Decidir si mantener los pesos AWQ en `/datos/models/hf/hub/` para cuando
      vLLM agrega soporte real de sm_120 en una version futura.
- [ ] Aumentar `--ctx-size` a 32768 una vez validado sin OOM (VRAM libre: 1,519 MiB).
- [ ] Actualizar a llama.cpp b-latest cuando soporte `--served-model-name` — simplifica
      el model ID para los clientes (no necesitaran hardcodear el path del GGUF).
- [ ] Benchmark con `--parallel 4` para evaluar si la VRAM libre (1.5 GB) soporta
      multiples slots sin OOM.
