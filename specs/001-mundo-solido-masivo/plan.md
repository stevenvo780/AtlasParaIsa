# Implementation Plan: Mundo sólido y laboratorio masivo

**Branch**: `001-mundo-solido-masivo` | **Date**: 2026-09-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-mundo-solido-masivo/spec.md`

## Summary
Construir primero el instrumento (laboratorio paralelo de mundos sin interfaz con métricas y control de determinismo), usarlo para corregir supervivencia, diversidad y escasez con parámetros nombrados y evidencia, después separar el cliente en modo completo (WebGL2, mapa de calor, pase visual) y modo observador ligero para móvil, y por último partir los dos ficheros gigantes en módulos por fase sin cambiar el comportamiento.

## Technical Context
**Language/Version**: TypeScript 5 estricto sobre Node 22.23 (torre) · **Primary Dependencies**: `ws`, Vite, `tsx`, `node:sqlite`; sin dependencias nuevas de runtime · **Storage**: SQLite (`data/world.sqlite`), temporales por réplica en el laboratorio · **Testing**: `tsx --test tests/*.test.ts` (58 ficheros), Playwright e2e · **Target Platform**: servidor Linux (torre), navegador escritorio (WebGL2) y móvil (observador) · **Project Type**: web-service + cliente Vite en un solo repo · **Performance Goals**: paso del mundo p95 < 50 ms con 32 habitantes; barrido 32×10 días < 15 min; escritorio ≥ 55 fps; observador móvil < 3 s y < 150 MB · **Constraints**: determinismo por semilla; origen único; sin LLM en el bucle · **Scale/Scope**: 16–32 habitantes por mundo, hasta 32 réplicas paralelas.

## Constitution Check
- I (autoritativo/determinista): el laboratorio verifica determinismo en cada fase ✔
- II (evidencia): cada tarea de reglas trae experimento + fila en EVIDENCIA ✔
- III (reglas simples): escasez y muerte se resuelven con parámetros y una función de registro, no con sistemas nuevos ✔
- IV (diversidad/muerte): métricas SC-002..005 fijadas antes de tocar reglas ✔
- V (rendimiento/cómputo): procesos paralelos, benchmarks existentes ✔
- VI (experiencia): modo observador + pase visual; sin tocar la carta ✔
Sin violaciones; Complexity Tracking vacío.

## Project Structure

### Documentation (this feature)
```text
specs/001-mundo-solido-masivo/
├── plan.md
├── research.md
├── spec.md
├── quickstart.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)
```text
src/
├── world/
│   ├── params.ts              # NUEVO: WorldParams tipado, defaults, parseParams
│   ├── muerte.ts              # NUEVO: CausaMuerte + registrarMuerte (única vía)
│   ├── diversidad.ts          # NUEVO: vector de conducta + índice
│   ├── recursos.ts            # NUEVO: densidad por bioma, agotamiento, regeneración, Gini
│   ├── paso/                  # REFACTOR (US5): percepcion, decision, accion, materia, registro
│   └── index.ts               # queda como fachada (< 400 líneas)
├── server/
│   ├── app.ts                 # mensaje `suscripcion` (intervalo) para observador
│   └── store.ts
├── client/
│   ├── modo.ts                # NUEVO: detección de capacidad y conmutador
│   ├── observador/            # NUEVO: carta, crónica, censo, ficha (sin WebGL)
│   ├── paisaje/               # REFACTOR (US5): terreno, agua, vegetacion, habitantes, luz, calor
│   └── game.ts
└── shared/types.ts            # CausaMuerte, Modo, métricas
scripts/lab/
├── replica.ts                 # NUEVO: un mundo sin interfaz → métricas diarias JSON
├── barrido.ts                 # NUEVO: lanza N réplicas (child_process), concurrencia, timeout
├── resumen.ts                 # NUEVO: agrega, compara con control, escribe resumen.{json,md}
└── README.md
tests/
├── params.test.ts, muerte.test.ts, diversidad.test.ts, recursos.test.ts, lab.test.ts, modo.test.ts
docs/EVIDENCIA.md              # sección 2026-09-19
```

**Structure Decision**: un solo repo con `src/{world,server,client,shared}` como hoy; lo nuevo entra como módulos junto a los existentes y el refactor de US5 crea las carpetas `world/paso/` y `client/paisaje/`.

## Fases de ejecución (mapa para tasks.md)
0. **Setup**: `params.ts`, `npm run lab`, README del laboratorio.
1. **Instrumento (US1)**: replica → barrido → resumen; test de determinismo; primer barrido de LÍNEA BASE (guardar en `artifacts/lab/base-<sha>/`).
2. **Reglas (US2 + US3)**: muerte con causa, diversidad medible, escasez por bioma; barridos por parámetro; elegir valores; EVIDENCIA.
3. **Experiencia (US4)**: modo observador, detección de capacidad, mapa de calor y pase visual; capturas antes/después; Lighthouse móvil.
4. **Arquitectura (US5)**: partir ficheros; control de determinismo; suite verde.
5. **Cierre**: barrido de 25 días, `npm run check`, EVIDENCIA, merge a `main`, build y relanzar servidor (ventana 0 del tmux `atlas`).

## Complexity Tracking
(vacío: sin violaciones a la constitución)
