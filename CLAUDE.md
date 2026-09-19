# Una Carta Para Isa — guía para Claude Code

- Lee `GOAL.md`, `PLAN.md`, `docs/REGLAS.md`, `docs/EVIDENCIA.md` antes de tocar reglas. La constitución del proyecto está en `.specify/memory/constitution.md` y manda.
- Revisión 2026-09-19: `docs/REVISION-2026-09-19.md` (12 hallazgos confirmados; leerlo antes de tocar reglas).
- Flujo SDD (Spec Kit): la feature activa es `specs/001-mundo-solido-masivo/` (spec, plan, research, tasks). **Para ejecutar: `/speckit-implement`.** Reparte las tareas `[P]` entre subagentes en paralelo (ficheros disjuntos) y cierra cada fase con `npm run typecheck && npm test` y un barrido de control del laboratorio. Cada tarea de `tasks.md` lleva su modelo y esfuerzo asignado; delegar vía `delegar_a_cloud` con `access=write` y `cwd` del worktree correspondiente.
- Comandos: `npm run typecheck`, `npm test` (tarda ~2-3 min; `world.test.ts` solo 115 s; nunca lo ejecutes sin `--test-timeout`), `npm run build`. `npm run lab -- --replicas N --dias D` (laboratorio) **no existe todavía**: se crea en T016–T018.
- Hardware disponible en esta torre: 32 hilos, 125 GiB, RTX 5070 Ti + RTX 2060. Usa procesos paralelos para experimentos; la GPU solo para render/benchmark.
- NO toques `data/` del servidor público ni `~/.local/bin/atlas-servidor*`; el laboratorio usa `CARTA_DATA_DIR` temporal. El servidor público sirve `main` compilado en `https://atlas.humanizar.tech`.
- **El servidor público corre con `cwd` en ESTE árbol y sirve `dist/client` en caliente** (crítico 2026-09-19). **Nunca `npm run build` ni `npm run check` en el árbol principal** salvo al publicar (T043) con el servidor parado; construye en worktrees (`dist/` es local). Respaldo del mundo: `npm run respaldo` (T022) antes de cualquier publicación.
- La carta (S e I, recuerdos) solo la cambia Steven.
