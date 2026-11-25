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

## 7. Reparto del cómputo entre la torre y el portátil (24-nov)
- La torre (32 hilos, GPU) estaba al triple de su capacidad mientras el portátil (`ssh fedora`: 20 hilos, sin GPU, ≈ 9 GB de memoria libres) estaba parado. Desde ahora, lo que es solo CPU y dura más de unos minutos va al portátil: los paneles de las puertas, la suite completa de cada puerta (allí no sufre los fallos de tiempos que provoca la carga de la torre) y los barridos de calibración de Q, W y B. En la torre quedan los agentes, lo que usa GPU y lo corto.
- Herramienta: `archivo/v23-orquesta/portatil.sh` (sube el HEAD de un worktree, lanza en tmux, trae resultados, limpia). Límite: 8 corridas del panel a la vez (cada una llega a ≈ 1 GB). Todo vive en `~/atlas-computo` del portátil y se borra al cerrar cada ola.
- Mientras el motor base siga siendo determinista con una semilla, las réplicas de una misma semilla son idénticas: los paneles usan semillas distintas con una réplica cada una (12 × 1), no 4 × 3. Las réplicas vuelven a tener sentido con el motor libre de la ola 1.
- No se lanza nada solo por ocupar el equipo: cada corrida responde a una puerta o a una decisión.

## 8. Resultados antes que agilidad (Steven, 24-nov tarde)
Ante el tamaño del cambio (≈ 28.000 líneas nuevas y ≈ 27.000 borradas; se sustituye cerca del 40 % del motor y del mundo), Steven decidió: «aplica lo que nos dé mejores resultados, no más agilidad». En consecuencia:
- **No se recorta nada del plan** para ir más rápido: todo hecho de átomos, dueños por zona, cinta de vida entera y pantalla para cada función. El kernel de materia en GPU (carril G) sigue dependiendo del perfil, porque escribirlo sin necesidad no mejora el resultado.
- **Las puertas no se relajan**: nada de una ola se integra en `sprint/v23l-core` antes de que la anterior cierre su puerta (contratos firmados, suite, panel). Los carriles que solo dependen de los contratos ya firmados y escriben ficheros nuevos (química, arena, cinética, leyes de uso, cinta) pueden empezar a escribir en su worktree mientras la puerta se cierra; los que tocan el motor o el mundo esperan a la puerta.
- **Cada carril va al modelo más capaz para ese tipo de trabajo**, no al más rápido ni al más barato, y lo revisa otro modelo fuerte de otro proveedor. Los modelos ligeros (Haiku, Luna, Grok) quedan para trabajo mecánico con revisión.
- **Cuotas** (medidas el 24-nov a las 15:55): a Gemini le queda un 18 % semanal hasta el 30-nov y cada carril de Neon gasta 4–5 puntos, así que Neon se reserva para un carril extremo por ola.

Reparto de la ola 1 (sustituye las columnas «Implementa» y «Revisa» de la tabla del plan):

| Carril | Implementa | Revisa |
|---|---|---|
| M1 Núcleo | GPT-6.2 Sol ultra | Opus |
| M2a Fauna SoA | GPT-6.2 Sol ultra (cuenta 2) | Opus |
| M2b `choose` troceado | Opus | GPT-6.2 Sol ultra |
| M3 GPU de decisión | GPT-6.2 Sol ultra | Opus |
| M8 Pruebas y banco | Sonnet | GPT-6.2 Sol |
| Q Química | Gemini 4 Neon XHigh | Fable (solo la matemática) y Opus (código) |
| A Arena y libro | GPT-6.2 Sol ultra (cuenta 2) | Opus |
| P Cinética y transporte | Opus | GPT-6.2 Sol |
| L Leyes de uso | Opus | GPT-6.2 Sol |
| S Comunidades | Sonnet | GPT-6.2 Sol |
| E Escucha | Sonnet | Opus |
| C1a Cinta: escritor | GPT-6.2 Sol ultra | Opus |
| C1b Cinta: lector | Sonnet | GPT-6.2 Sol |
| V1 Pantalla | Opus | Muse wonder-full (experiencia de uso) |
| I1 Integración | Sonnet | Opus, y revisión final del orquestador |

## 9. La puerta 0 se parte en dos y las puertas son de integración (24-nov, noche)
Lo que frena no es escribir código sino los paneles: cada mundo vivo de 500 habitantes tarda horas en llegar al día 45. Para no parar el camino crítico por eso, sin relajar nada:
- **Puerta 0a (base técnica):** contratos firmados, partición verificada, poda y suite completa en verde y revisada. Al cerrarse, pueden empezar a ESCRIBIR todos los carriles de la ola 1, también los del motor (M1, M2a, M2b, M3, M8): ninguno toca `mundo/crear.ts` ni depende de las cifras del control.
- **Puerta 0b (demografía):** fundadores validado con 12 semillas y panel de control medido. Hace falta antes de INTEGRAR la ola 1 (la equivalencia de I1 se mide contra ese control), no antes de escribirla.
- **Regla general:** las puertas gobiernan lo que se integra en `sprint/v23l-core`. Un carril puede escribirse por adelantado en su worktree cuando sus entradas están congeladas (contratos y librerías ya revisadas). El mundo material (W) se adelanta así en cuanto la química esté revisada, porque está en el camino crítico; cuerpos, natalidad, fauna y técnica (B, N, F, T1, T2) esperan a que W esté integrado, porque dependen de su calibración.

## 10. Método: experimento antes que lectura (Steven, 24-nov noche)
Steven preguntó si hacen falta tantas revisiones y si no es mejor «hacer, ejecutar y mirar como todo experimento científico». El balance del día le da la razón en lo principal: los defectos graves salieron sobre todo de experimentos independientes (cajas cerradas de materia, digestos, mutaciones de pruebas, bancos de coste), y las rondas de lectura y cierre costaron tanto como escribir. Desde ahora:
- **Cada carril nace con su experimento de aceptación** escrito en el encargo: qué se predice, cómo se mide y con qué umbral. El carril está hecho cuando lo pasa.
- **Una sola verificación independiente, de otro modelo, que ejecuta**: repite el experimento de aceptación con su propio guion, rompe a propósito cada garantía para comprobar que alguna prueba falla y mide el coste. No hay segunda ronda salvo que el experimento falle.
- **Si el cambio debe conservar la conducta, la aceptación es la identidad exacta** del mundo de un hilo (digestos), no un panel ni una estadística.
- **La lectura adversarial del código se reserva** para los tres núcleos donde un error silencioso lo envenena todo y un experimento corriente no lo ve: conservación de átomos y energía en la materia, concurrencia del motor y durabilidad de la cinta.
- **Integrar pronto y mirar el mundo**: lo escrito se junta cuanto antes en una rama de mundo que corre con los invariantes encendidos y graba; lo que se vea ahí se arregla ahí. Las puertas siguen gobernando lo que entra en `sprint/v23l-core`.

## 11. Paneles: no simular dos veces lo mismo (24-nov, noche)
- Panel fijo de 8 semillas (7, 51926, 19101 a 19106), **una réplica por semilla** (con un hilo las réplicas son idénticas), 30 días y `--tope-mortales 300`: el crecimiento sin freno ya es un hallazgo conocido y simularlo durante horas no enseña nada.
- Un panel solo cuando el carril cambia una ley del mundo. Para diagnosticar, corridas cortas instrumentadas (minutos), no paneles.
- El «antes» de un mismo commit base se simula una vez y se comparte (caché del panel, carril `panel`).
- No se lanzan más corridas que núcleos libres: en una máquina saturada cada corrida tarda varias veces más. El portátil lo comparten otros trabajos; `portatil.sh` encola por memoria.

## 12. Medir más rápido: decisiones de Steven (24-nov, noche)
Medido ese día con el panel: un día simulado cuesta 53 s con menos de 50 habitantes y unos 8 minutos con 250–300 (≈ 200 ms por tick); las dos tarjetas van al 1–10 % mientras la CPU de la torre pasa de carga 110.
- **Solo hardware local.** Nada de cómputo en la nube.
- **Optimizar primero.** Antes de paneles largos se perfila el tick y se arregla lo que más pese sin cambiar la conducta (identidad de digesto con un hilo).
- **Paneles a la medida de la pregunta.** «¿Se extingue esta banda?» se responde con tope 100 y pocos días; las tasas demográficas, con poblaciones grandes y horizonte corto; el horizonte largo queda para el panel final.
- **Poblaciones grandes y tarjetas.** Miles de vidas a la vez dan en 5 días simulados lo que una banda de 14 no da en 45: tasas por habitante con error pequeño y su dependencia de la densidad (si el crecimiento no baja al subir la densidad, no hay equilibrio; si es negativo con pocos, las bandas pequeñas se extinguen). Se arranca de mundos ya crecidos (puntos guardados del panel) o sembrados (`scripts/lab/poblacion.mts`), con la decisión repartida en hilos y tarjeta. Lo que el perfil señale como grueso y paralelizable se lleva a la tarjeta; la química de lotes del mundo material nace pensada para ella.

## 13. Modo de trabajo con cuota escasa (Steven, 24-nov noche)
Muse y Gemini están agotados; quedan Claude y GPT. Medido en los transcritos del 24-nov: los subagentes escribieron 16 M de tokens y releyeron 2.200 M de contexto; el 60 % del gasto fueron subagentes Opus y el 20 % el orquestador (Fable, 430 mil tokens de contexto medio en 676 respuestas). Más de la mitad de todo es cada agente releyendo su propio contexto en cada paso: el coste crece con pasos × contexto.
- **Solo camino crítico** y como mucho 4 agentes a la vez en la torre: saturada, cada agente da más pasos (esperas, reintentos, pruebas de tiempos que fallan).
- **Modelo por defecto Sonnet**; Opus con esfuerzo alto (no extra) solo en los tres núcleos de §10; Fable solo para matemática extrema. GPT-6.2 Sol por CLI para los carriles grandes de código mientras tenga saldo.
- **Agentes cortos y de contexto pequeño:** el encargo da punteros exactos (nunca «lee entero»), las salidas de pruebas se resumen, las esperas son una sola orden que bloquea (nunca sondeos) y un trabajo largo se parte en agentes sucesivos con un fichero de relevo.
- **Un autor y una verificación pequeña que ejecuta** (§10); sin rondas de cierre.
- **El orquestador** procesa las entregas por tandas, con una sola orden por entrega, y pasa a una sesión nueva cuando su contexto supera los 150 mil tokens.
- El gasto se mide con `archivo/v23-orquesta/consumo.py` (por workflow, por modelo y del hilo principal).
