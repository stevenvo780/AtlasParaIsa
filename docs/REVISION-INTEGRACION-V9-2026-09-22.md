# Integración de planificación familiar V9

La integración `96e89b1` incorpora la provisión familiar de V8 y la detección local
de una cosecha ya adelantada de V9 sobre `b83b976`, conservando las correcciones de
persistencia. Reglas9, protocolo9, SQLite4. No modifica costes físicos, reservas
reproductivas, órdenes humanas ni la carta. La migración valida primero y conserva
estado histórico y parámetros; cambia sólo la etiqueta de ley para V6/V7/V8.

**981/981 pruebas Node, cero fallos y cero omisiones**, typecheck, build/smoke del
commit exacto y **18/18 pruebas Chromium** pasaron. La suite Node tardó250,481s y
la de navegador59,9s en host compartido.
[Gates](evidencia-2026-09-22/integration-v9-gates.json),
[build/smoke exacto](evidencia-2026-09-22/integration-v9-exact-gate.json).

Seis trayectorias independientes comparan la integración con `cf04ac4`: semillas
1/51926/20260905, defaults y opciones reservadas,1200ticks cada una, Store cada20,
recargas en600/1200 y clones descartados cada120. Coinciden el World completo,
orden de propiedades/arrays, undefined, bits numéricos, referencias compartidas y
las diez tablas durables distintas de snapshots. Los digestos completos difieren
porque la integración añade parámetros tipados; el comparador físico no borra leyes
ni reordena arrays. Las únicas ocho diferencias de módulos están enumeradas y
verificadas antes/después. [Paridad](evidencia-2026-09-22/integration-v9-parity.json).

La revisión conservó los cambios técnicos de la migración V1 al resolver el merge.
Los conflictos fueron documentales: se reunieron el diagnóstico causal V8 y sus
resultados finales, sin perder ninguno. El benchmark añadido después de este gate
no altera `src/` ni `package.json`; mantiene rojo el rendimiento de T103.

[V8](REVISION-FAMILIA-V8-2026-09-22.md) permite planificar cosechas pequeñas útiles
para una familia viable. [V9](REVISION-CONTENCION-V9-2026-09-22.md) evita elegir una
fuente finita que un trabajador visible y suficientemente adelantado puede agotar
antes. Los empates, decisiones futuras, fuentes con sobrante y órdenes explícitas
tienen controles negativos. Las ablaciones recuperan los comportamientos previos.

El contraste V8→V9 de trece días continúa en copias congeladas; los resultados V8
anteriores son mixtos. Integrar estas correcciones causales no declara superioridad
demográfica ni cierre de GOAL.md. T100/A0 y el rendimiento T103 siguen abiertos.
El build público permanece en `3dd615e`; este gate no reinicia ni publica el mundo.
