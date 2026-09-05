# inference-embed — Embeddings en GPU 1 (RTX 2060)

Servicio FastAPI que expone sentence-transformers para embeddings multilingües.
Usado por `narrative-curator` para indexar las 227k líneas de chat con RAG.

## Modelo

| Campo | Valor |
|---|---|
| Nombre | `intfloat/multilingual-e5-base` |
| Parámetros | 278M |
| Dimensión | 768 |
| VRAM usada | ~1.3 GB de 6 GB |
| GPU host | GPU 1 = RTX 2060 |
| Idiomas | 100+ (incluye español) |

### Por qué este modelo

- Soporta español nativo, lo que es esencial para las conversaciones de Steven e Isa.
- 278M params → cabe holgado en los 6 GB de la RTX 2060.
- El protocolo `query: / passage:` de e5 mejora la precisión en búsqueda asimétrica (la búsqueda RAG es asimétrica: query corta vs. pasajes largos).
- Compatible con cosine similarity directamente (se entrena con normalización L2).

## Contrato HTTP

### `GET /health`

```bash
curl http://localhost:8082/health
```

Respuesta:
```json
{"status":"ok","model":"intfloat/multilingual-e5-base","device":"cuda:0"}
```

Retorna 503 si el modelo aún no terminó de cargar.

### `POST /embed`

```bash
curl -X POST http://localhost:8082/embed \
  -H 'Content-Type: application/json' \
  -d '{"texts":["te amo","hola Isa","despídeme"], "instruction":"query"}'
```

**Body:**
```json
{
  "texts": ["string", "..."],
  "instruction": null | "query" | "passage"
}
```

| `instruction` | Prefijo añadido | Cuándo usarlo |
|---|---|---|
| `null` | ninguno | Clasificación, tareas simétricas |
| `"query"` | `"query: "` | Búsqueda — la consulta del usuario |
| `"passage"` | `"passage: "` | Indexado de documentos/fragmentos |

**Respuesta:**
```json
{"vectors": [[float, ...], ...]}
```

- Un vector por texto.
- Dimensión fija: 768.
- Vectores normalizados L2 → cosine similarity = dot product.

### `GET /metrics`

Placeholder. Retorna un JSON con TODO. Pendiente de integrar `prometheus-fastapi-instrumentator` cuando `narrative-curator` esté activo.

## Build y run

```bash
# Build y levantar solo embed (sin arrastrar inference-llm)
docker compose -f docker/compose.yaml --profile embed up -d --build inference-embed

# Levantar todo el perfil inference (embed + llm)
docker compose -f docker/compose.yaml --profile inference up -d --build

# Ver logs
docker logs -f carta-embed

# Parar
docker compose -f docker/compose.yaml --profile embed down
```

### Variables de entorno

| Variable | Default compose | Descripción |
|---|---|---|
| `HF_HOME` | `/models/hf` | Cache de Hugging Face (bind mount `/datos/models`) |
| `MODEL_NAME` | `intfloat/multilingual-e5-base` | Modelo a cargar |
| `CUDA_VISIBLE_DEVICES` | `0` | Dentro del contenedor = GPU 1 del host (mapeado por CDI) |

## Latencias medidas (RTX 2060, CUDA 13.0, PyTorch 2.7)

| Caso | Latencia servidor (encode) | RTT curl |
|---|---|---|
| 1 texto — 1ª llamada (GPU warm) | 10 ms | ~15 ms |
| 1 texto — 2ª llamada | 6 ms | ~9 ms |
| 3 textos — 1ª llamada | 117 ms | ~120 ms |
| 32 textos — 1ª llamada | 27 ms | ~37 ms |
| 32 textos — 2ª llamada | 26 ms | ~36 ms |

> El batch de 32 textos es más rápido por texto que el de 1 porque la GPU se satura mejor.
> El primer batch de 3 textos fue más lento (~117 ms) por inicialización de kernels CUDA. Las llamadas sucesivas estabilizan en 6-27 ms.

## Estructura de archivos

```
services/inference/embed/
├── Dockerfile           # Base nvidia/cuda:13.0.0-base-ubuntu24.04 + Python 3.12 + PyTorch cu128
├── requirements.txt     # fastapi, uvicorn, torch, sentence-transformers, pydantic
└── app/
    ├── __init__.py
    ├── main.py          # FastAPI: /health, /embed, /metrics
    └── embed.py         # Carga del modelo, función encode()
```

## Troubleshooting

### "eBPF / invalid argument" al lanzar el contenedor sin `--device`

```
nvidia-container-cli: mount error: failed to add device rules: unable to generate
new device filter program from existing programs: load program: invalid argument
```

**Causa**: Bug en el runtime NVIDIA con eBPF en kernel 6.17. `--gpus all` y la sintaxis legacy de compose (`driver: nvidia`) disparan este bug.

**Solución**: Usar CDI siempre:
```bash
# CLI
docker run --device nvidia.com/gpu=1 <image>

# compose.yaml
services:
  inference-embed:
    devices:
      - "nvidia.com/gpu=1"
```

NUNCA usar:
```yaml
# ROTO en este host
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

### El modelo tarda en arrancar la primera vez

`multilingual-e5-base` pesa ~1.1 GB. La primera vez se descarga a `/datos/models/hf` (bind-mounted). El healthcheck tiene `start_period: 300s`. Si falla, revisar:

```bash
docker logs carta-embed   # ver progreso de descarga
ls /datos/models/hf/      # verificar que exista el directorio
```

Si el acceso a Hugging Face falla por red, pre-descargar en el host:
```bash
HF_HOME=/datos/models/hf python3 -c "
from sentence_transformers import SentenceTransformer
SentenceTransformer('intfloat/multilingual-e5-base', cache_folder='/datos/models/hf')
"
```

### `nvidia/cuda:13.0.0-devel-ubuntu24.04` no disponible

La imagen devel de CUDA 13.0 no está en Docker Hub aún. Se usa la base (`13.0.0-base-ubuntu24.04`) que es suficiente porque PyTorch ≥2.7 incluye su propia runtime de CUDA en el wheel. No se necesita el toolkit de compilación en runtime.

### Verificar GPU dentro del contenedor

```bash
docker exec carta-embed python3 -c "import torch; print(torch.cuda.get_device_name(0))"
# Esperado: NVIDIA GeForce RTX 2060
```

## TODO

- `GET /metrics`: integrar `prometheus-fastapi-instrumentator` cuando `narrative-curator` use el servicio activamente. Ver `app/main.py` para el stub.
- Logging estructurado (JSON) para Loki si se añade al stack de observabilidad.
- Benchmarks formales con scripts en `scripts/gpu/bench_embed.py`.
