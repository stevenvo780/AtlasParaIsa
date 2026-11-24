# Ajustes del orquestador a PLAN-V23 y a las arquitecturas

Mandan sobre `PLAN-V23.md`, `ARQ-motor.md`, `ARQ-materia.md` y las demás piezas cuando se contradigan. Fecha: 2026-11-24.

## 1. Determinismo: mundo irrepetible, pruebas estables
Steven decidió un mundo no determinista y dejó al orquestador retroceder lo que viera mal. Queda así:
- El mundo público es irrepetible: paralelo libre, sin paridad entre hilos ni entre CPU y GPU, sin digestos dorados con valores fijos, sembrado con entropía real al crearse.
- Se **conserva** la reproducibilidad en el modo de un solo dueño (`T=1`), sin GPU y con semilla explícita: las leyes no leen el reloj de pared ni usan azar sin sembrar. Es gratis con la arquitectura elegida y es lo que permite que las pruebas sean estables y que cada agente verifique su entrega.
- Consecuencia para la poda: se borran las pruebas de paridad entre hilos/GPU y los digestos con valor fijo (olas 0 y 2 del plan), pero queda una prueba «misma semilla, `T=1`, dos corridas → mismo digesto» y `world/digesto.ts` sigue como utilería de pruebas. Las pruebas unitarias de leyes corren en `T=1` con semilla.
- La constitución enmendada debe decirlo así (no «se elimina todo determinismo»).

## 2. Lo que midió Codex en la torre (`spike-motor-INFORME.md`)
- El canal con la GPU va por memoria compartida (`/dev/shm`), no por tuberías: con tubería, 1 M de agentes cuesta 1,3 s aunque el kernel tarde 6 ms.
- La RTX 2060 es unas 16 veces más lenta que la 5070 Ti: el reparto es por rendimiento medido, nunca a medias.
- Relojes locales por región: descartados (no ganaron nada). Tick global.
- Personas es solo la mitad del paso; fauna y ecología pesan igual: se reparte todo por regiones.
- Con la torre compartida, 28 hilos rindieron como 6–11. Las puertas de Hz son **relativas y medidas** (con la carga anotada): la puerta 2 pasa de «≥ 300 Hz con 270 personas» a «≥ 5× la referencia de la ola 0 en el banco del motor». Ningún Hz absoluto bloquea.

## 3. Fundadores (hallazgo del panel de leyes, `validacion-leyes.md`)
En 8 semillas × 60 días, los mortales se extinguen en al menos la mitad de las semillas **también en V22**: cohorte única de 14 fundadores de la misma edad, ventana fértil corta y emparejamiento a 3 celdas o menos. No es culpa de las leyes v23.
- Carril nuevo en la ola 0, **0H Fundadores** (después de M0; dueño de `mundo/crear.ts` en esta ola): cohorte fundadora con edades repartidas y condiciones de arranque que no dependan de una sola generación. Nada de nacimientos forzados ni rescates.
- El control de la ola 0 (0G) se mide **después** de 0H. Hasta entonces el umbral M1 («0 extinciones de 12») no aplica como puerta; el panel informa.

## 4. Harnesses
- Los carriles de GPT corren con `codex exec` en esfuerzo `ultra`, en tmux (`tmux -L atlas attach -t <carril>`), con acceso completo dentro de su worktree, y **commitean ellos mismos**. No hace falta trocear en tiquetes de 30 minutos.
- Muse (`muse-wonder-full-1.0` en `max`) y Grok 4.7 corren igual, por su CLI.
- Los carriles de Claude (Opus, Sonnet, Haiku) y todas las revisiones cruzadas van por workflows.
- Reparto de la ola 0: M0 → GPT-6.1 Sol ultra; 0B contratos → Opus; 0C red de seguridad → GPT-6.1 Sol ultra; 0D operación → Muse wonder-full; 0E poda segura → Haiku; 0F enmienda → Grok 4.7; 0H fundadores → Opus; integración → Sonnet con revisión de Opus y revisión final del orquestador.
- El enganche del `Muestreador` de 0C en `server/app.ts` lo hace el integrador, no 0D.

## 5. Código limpio
Cada carril borra lo que sustituye. Cada entrega pasa una revisión de un modelo distinto y una pasada de simplificación antes de integrarse. Al cerrar cada ola se retiran worktrees, ramas fusionadas y temporales.

## 6. Modelos disponibles desde la tarde del 24-nov
- **GPT-6.2 Sol** sustituye a GPT-6.1 Sol en todos los carriles de Codex (el lanzador ya lo usa por defecto; probado en las dos cuentas con esfuerzo hasta `ultra`). También existe GPT-6.1 Terra, que sustituye a Terra 5.6 en los carriles medios.
- **Gemini 4 Neon (XHigh)** vuelve a estar disponible por `agy -p --model gemini-4-neon-xhigh`. Steven lo considera el más capaz después de Fable. Su cuota semanal está al 27 %, así que se reserva para lo extremo: 0H fundadores, una pasada adversarial sobre los contratos congelados, y en las olas siguientes uno de cada par de carriles extremos (M2b o Q; M4a o W; B o T1), con Opus en el otro y revisión cruzada entre ambos.
