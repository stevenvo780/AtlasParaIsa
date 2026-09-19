# Una Carta Para Isa — guía para Claude Code

- Lee `GOAL.md`, `PLAN.md`, `docs/REGLAS.md`, `docs/EVIDENCIA.md` antes de tocar reglas. La constitución del proyecto está en `.specify/memory/constitution.md` y manda.
- Flujo SDD (Spec Kit): la feature activa es `specs/001-mundo-solido-masivo/` (spec, plan, research, tasks). **Para ejecutar: `/speckit-implement`.** Reparte las tareas `[P]` entre subagentes en paralelo (ficheros disjuntos) y cierra cada fase con `npm run typecheck && npm test` y un barrido de control del laboratorio.
- Comandos: `npm run typecheck`, `npm test`, `npm run build`, `npm run lab -- --replicas N --dias D` (laboratorio, tras T010–T012).
- Hardware disponible en esta torre: 32 hilos, 125 GiB, RTX 5070 Ti + RTX 2060. Usa procesos paralelos para experimentos; la GPU solo para render/benchmark.
- NO toques `data/` del servidor público ni `~/.local/bin/atlas-servidor*`; el laboratorio usa `CARTA_DATA_DIR` temporal. El servidor público sirve `main` compilado en `https://atlas.humanizar.tech`.
- La carta (S e I, recuerdos) solo la cambia Steven.
