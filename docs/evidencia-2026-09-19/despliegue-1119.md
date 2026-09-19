# Despliegue público · 2026-09-19 11:19 · build `835f3d5` · mundo nuevo

Salida cruda de las comprobaciones del orquestador contra `https://atlas.humanizar.tech` (curl + driver Playwright con Chrome), 20–60 s después de relanzar en `tmux atlas:0` (pid 1159424):

```
login HTTP 200 en 0.394081s
/api/world en 0.891874s | 363 KiB | tick 257 día 1 dawn | hab 17 | versión 7 | tickHz 9.91 | p95 39.6 ms | diversidad 0.60 | food>0.3 772/1120
"vista":"escritorio" "conexion":"En vivo" "habitantes":18 "erroresPagina":[] (1 aviso 404 de un recurso estático)
"vista":"movil"      "conexion":"En vivo" "habitantes":18 "erroresPagina":[]
servidor público (pid 1159424): etime 00:58 · %CPU 27.2 · RSS 231 MB      (a las 11:21, 02:34 de vida, 18–30 hab.: %CPU 37.0)
```

Referencia «antes» (mismo día): servidor viejo pid 330501 con 2 h 35 min de vida: **%CPU 95,0** sostenido (147 min de CPU), RSS 417 MB, `data/world.sqlite` 599 MB + WAL 493 MB; en el build viejo local tras 1,5 h, `GET /api/world` tardó **85,4 s** (839 KB) y el cliente abortaba a los 10 s (medición del agente SC-006, `scratchpad/evidencia/movil-antes/`).

Mundo anterior conservado en `data/world-20260919-1117-viejo.sqlite` (+ copias `~/.local/state/atlas-para-isa/backups/world-20260919-{1033,1108}-*.sqlite.gz`). Capturas: `scratchpad/publico-{escritorio,movil}-3-mundo.png`.
