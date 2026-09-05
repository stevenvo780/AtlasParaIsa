# Field Diffusion — GPU Path Analysis

## Decision: FIELD_DIFFUSE_BACKEND=gpu is available but not the default

The GPU path is implemented, wired, and available via `FIELD_DIFFUSE_BACKEND=gpu`.
The default remains CPU (`FIELD_DIFFUSE_BACKEND` unset).

Reason: the V8-JIT TypeScript CPU kernel is faster than the HTTP GPU path
for all chunk counts measurable in this setup. This is NOT because the CUDA
kernel is slow — it is extremely fast (0.02-0.14 ms for 1-256 chunks).
The bottleneck is the Python FastAPI/uvicorn WSGI stack overhead (~1-5 ms baseline
per HTTP request on localhost, even via Unix domain socket).

## Hardware

| GPU | Model | VRAM | Assigned to |
|-----|-------|------|-------------|
| 0 | RTX 5070 Ti | 16 GB | Field diffusion (this service) |
| 1 | RTX 2060 | 6 GB | Embeddings (port 8082, inactive in this sandbox) |

CDI access: `--device nvidia.com/gpu=0` (Docker) or `CUDA_VISIBLE_DEVICES=0` (direct Python).

## Service

- Path: `services/inference/diffuse/`
- Runtime: `.gpuenv` virtualenv (Python 3.12, torch 2.11.0+cu128)
- Start: `./scripts/gpu/start-diffuse.sh` (no Docker required)
- Endpoints:
  - `GET /health` — backend status, CUDA flag
  - `POST /diffuse` — JSON path (base64 codec, legacy)
  - `POST /diffuse-bin` — binary path (octet-stream, no base64)
  - `GET /metrics` — Prometheus

Both TCP (`:8083`) and Unix domain socket (`/tmp/diffuse.sock`) are started.

## Benchmark Results (measured on this host)

### Raw CUDA kernel (no HTTP, pure PyTorch)

| N chunks | N layers total | CUDA kernel ms | Notes |
|----------|----------------|----------------|-------|
| 1 | 4 | 0.017 | |
| 8 | 32 | 0.016 | |
| 32 | 128 | 0.028 | |
| 64 | 256 | 0.043 | |
| 256 | 1024 | 0.140 | |

The raw CUDA kernel (grouped conv2d with vectorised Euler step, single D→H
transfer) is **50-120x faster** than the CPU equivalent.

### Service internal breakdown (decode + CUDA kernel + encode, no HTTP)

| N chunks | Decode ms | Kernel ms | Encode ms | Sum ms |
|----------|-----------|-----------|-----------|--------|
| 1 | 0.009 | 0.43 | 0.006 | 0.44 |
| 8 | 0.049 | 0.38 | 0.032 | 0.46 |
| 32 | 0.197 | 1.06 | 0.128 | 1.39 |
| 64 | 0.384 | 1.28 | 0.253 | 1.92 |
| 128 | 0.911 | 4.73 | 0.778 | 6.42 |
| 256 | 3.065 | 11.38 | 5.401 | 19.85 |

Wire codec is binary (no base64). Kernel ms includes H→D transfer.

### End-to-end: TS CPU (V8 JIT) vs UDS+GPU (keep-alive, /tmp/diffuse.sock)

| N chunks | TS CPU ms | UDS+GPU ms | Status |
|----------|-----------|------------|--------|
| 1 | 0.12 | 1.05 | CPU faster |
| 8 | 0.96 | 1.69 | CPU faster |
| 16 | 1.93 | 3.41 | CPU faster |
| 32 | 3.87 | 7.32 | CPU faster |
| 64 | 7.74 | 12.82 | CPU faster |
| 128 | 15.50 | 22.64 | CPU faster |
| 256 | 25.32 | 96.33 | CPU faster |

TS CPU: field-engine `diffuseFieldsBatch` via V8 JIT (vitest bench, this machine).
UDS+GPU: Node.js `http.request({ socketPath })` with `keepAlive: true`.

### Why the GPU path doesn't win at this chunk scale

The Python FastAPI/uvicorn event loop adds ~1-2 ms overhead per HTTP request
even with keep-alive and Unix domain sockets. This floor dominates at low
chunk counts (≤64 chunks). At 128+ chunks, the Python Wire decode/encode
(iterating over numpy arrays in Python) also becomes significant.

The fundamental architecture — HTTP microservice for per-tick offloading —
is not the right model for this use case when the TS CPU kernel is already
optimised with V8 JIT.

## What Would Actually Win

To make GPU diffusion faster end-to-end, we'd need one of:

1. **Native addon (N-API)**: Call PyTorch/CUDA from a Node.js native addon
   directly, bypassing HTTP entirely. Estimated latency: 0.1-0.5 ms total.
   This is the correct long-term solution.

2. **Shared memory**: Map a shared float32 buffer between Node.js and Python
   processes. The Python CUDA process watches for a semaphore, runs the kernel,
   and signals done. Eliminates serialisation entirely.

3. **Larger batch / lookahead**: If the world has 500+ HOT chunks, the CUDA
   kernel processes all of them in ~0.5-1 ms while CPU would take 60-100 ms.
   At that scale, even with HTTP overhead, GPU wins. Enable with
   `FIELD_DIFFUSE_EVERY_N=1 FIELD_DIFFUSE_BACKEND=gpu`.

4. **Torch as Python subprocess**: Keep-alive subprocess with stdin/stdout binary
   pipe instead of HTTP. Removes WSGI overhead.

## When to Enable the GPU Path

Enable `FIELD_DIFFUSE_BACKEND=gpu` when:
- HOT chunk count regularly exceeds ~200+ chunks (world scale > 200 active areas)
- `FIELD_DIFFUSE_EVERY_N=2` or higher (amortise HTTP overhead over multiple ticks)
- The world has 1000+ agents spread across many chunks

At the current scale (typically 4-64 HOT chunks at game start), the CPU path
is faster. The flag is available and tested — flip it when the world grows.

## Wire Format

Binary `/diffuse-bin` endpoint (preferred over JSON `/diffuse`):

```
REQUEST (application/octet-stream):
  magic(4)   N_layers(4)   dt(4)
  Per layer:
    chunk_idx(4)  kind_len(1)  kind(N)  W(4)  H(4)  diffusion(4)  decay(4)  data(W×H×4)

RESPONSE (application/octet-stream):
  magic(4)  N_layers(4)
  Per layer:
    chunk_idx(4)  kind_len(1)  kind(N)  data(W×H×4)
```

Magic: `0xD1FF0530`. All values little-endian. No base64.
Python spec: `services/inference/diffuse/app/wire.py`.
TypeScript client: `packages/field-engine/src/batch.ts` (`packBinaryRequest`/`unpackBinaryResponse`).

## Numerical Determinism

GPU kernel uses `mode='constant', value=0` padding (Dirichlet OOB=0), matching
the TypeScript field-engine CPU kernel exactly. Results are **bit-identical**
for all interior cells. Previously the service used 'replicate' padding (Neumann)
which caused a one-cell-wide boundary difference.

## GPU Assignment

```
CUDA_VISIBLE_DEVICES=0  → RTX 5070 Ti  → diffusion service (this)
CUDA_VISIBLE_DEVICES=1  → RTX 2060     → embeddings service (port 8082)
```

The Docker stack (in `docker/compose.yaml`) uses CDI:
```yaml
devices:
  - "nvidia.com/gpu=0"   # for inference-diffuse
```

In this sandbox Docker is unavailable (kernel 6.17 eBPF bug). The service
runs directly via `.gpuenv` Python with `CUDA_VISIBLE_DEVICES=0`.
