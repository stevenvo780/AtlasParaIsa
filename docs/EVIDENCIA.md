# Evidencia del mundo vivo V3

Fecha: 5 de septiembre de 2026. V3 activa en revisión privada con contenido sintético. La carta personal definitiva y el recorrido en un teléfono físico siguen pendientes.

## Resultado observable

El backend conserva un único mundo compartido. Ejecuta ecología, cuerpos, decisiones, aprendizaje, sociedad y guardado. Cada navegador recibe el mismo paso, mueve su cámara y dibuja su vista. Dos conexiones autenticadas se probaron simultáneamente: cámaras distintas no avanzan el mundo; las órdenes de ambos clientes se aplican al mismo paso y quedan en una transacción con orden explícito. No se crea una simulación por conexión.

El mundo ocupa la pantalla y permite seleccionar, seguir y dirigir cualquier habitante. A las órdenes anteriores se añaden beber, cazar y cooperar. Los biomas tienen elementos procedurales, fauna finita por celda, reservas visibles de agua dulce, cultivos y huellas. Extraer recursos modifica el paisaje; la escasez puede cambiar destino y actividad. Las profesiones describen práctica adquirida, sin repartir oficios al nacer.

La cooperación transfiere materiales, intercambia existencias, aporta trabajo o enseña una técnica practicada. Confianza y normas adquiridas afectan las relaciones; las comunidades requieren contactos locales y prácticas compatibles. La pertenencia puede cambiar. Una fuente escasa puede provocar tensión o un acuerdo de turnos con espera real. Siete pares de parámetros hereditarios permiten descendientes de vecinos ficticios bajo condiciones locales y con costes; habilidades y episodios no se copian a los genes.

La interfaz muestra series recientes, necesidades, recursos, fauna, genealogía, cultura, vínculos, experiencias causales y tiempos medidos. Diferencia acumulados históricos y existencias de regiones activas; no presenta esos recuentos como todo el territorio posible.

## Comprobaciones finales

| Comprobación | Resultado | Artefacto local |
|---|---|---|
| Typecheck | Aprobado | `npm run typecheck` |
| Pruebas Node | **112/112**, cero fallos, cero skips | [tests-v3.txt](../artifacts/tests-v3.txt) |
| Vite y servidor compilado | Aprobados | [build-v3.txt](../artifacts/build-v3.txt) |
| Chromium, escritorio y móvil emulado | **8/8**, 43,6 s | [e2e-v3.txt](../artifacts/e2e-v3.txt) |
| Entry point compilado | Autenticación, avance, SIGKILL, recuperación, sesión conservada, revocación y SIGTERM aprobados en mundo temporal | [smoke.json](../artifacts/smoke.json) |
| Ejecución prolongada | **7200 pasos**, copia transaccional y commit por paso; reinicio y backup idénticos, cero fallos | [soak-v3.json](../artifacts/soak-v3.json) |
| Servicio privado V3 | Acceso existente, lectura anónima rechazada, pantalla completa, avance y cero errores JavaScript | [live-preview-v3.json](../artifacts/live-preview-v3.json) |

Entorno: Node.js 22.22.3, TypeScript 7.0.2, Vite 8.2.2, Playwright 1.63.0 y Chromium 153. Escritorio 1440 × 900; móvil emulado 390 × 844. Los artefactos V3 permanecen en el workspace; la regla local añadida a `.gitignore` excluye nuevos archivos de `artifacts/` y se conservó sin modificar. Los resultados principales quedan registrados aquí y los scripts permiten repetirlos.

Capturas: [mundo privado migrado](../artifacts/live-preview-v3.png), [rendimiento privado](../artifacts/live-performance-v3.png), [estadísticas](../artifacts/desktop-stats-v3.png), [genealogía](../artifacts/genealogy-v3.png), [comunidades](../artifacts/communities-v3.png), [móvil](../artifacts/mobile-stats-v3.png) y [terreno distante](../artifacts/distant-terrain-v3.png).

## Qué ocurrió sin intervenciones

La ejecución acelerada de tres días del modelo terminó en **370,68 s** de pared. Produjo 202 descubrimientos, 149 refugios, 20 cazas, 71 cultivos y 165 cooperaciones: 148 enseñanzas, dos intercambios y 14 ayudas de trabajo, además de otra cooperación registrada. Se consumieron 16,818 unidades de agua del modelo y aparecieron dos comunidades. Hubo 66 hechos de cuidado y 19 de aprendizaje social en la crónica.

**No hubo nacimientos ni conflictos en esta ejecución autónoma de la semilla 51926.** La población permaneció en 16 fundadores. Nacimiento, recombinación, mutación, cambio de comunidad, disputa y acuerdo de turnos se demostraron en escenarios con condiciones suficientes y controles negativos. Esto acredita mecanismos disponibles; no demuestra que aparezcan con frecuencia ni una evolución abierta de complejidad ilimitada.

La fauna final contada en regiones activas fue de 398 venados, 478 jabalíes y 345 liebres. Los recuentos pueden cambiar al activar o archivar regiones; no son un censo global. Los peces existen en el modelo, pero la orden humana de caza actualmente se dirige a presas en tierra transitable: no se implementó pesca desde la orilla.

La latencia de copia, paso y commit tuvo p50 **41,51 ms**, p95 **98,18 ms** y máximo **683,66 ms**. RSS máximo: **457,74 MiB**. Se alcanzaron 63 regiones y 16 128 celdas activas; el archivo conservó 312 regiones y 565 revisiones. Base final: 60 911 616 bytes; snapshot máximo: 3 159 802 bytes; vista inicial máxima: 451 125 bytes. El archivo en disco puede crecer aunque la simulación activa y las vistas estén acotadas.

## Rendimiento de CPU y GPU

El benchmark de persistencia compara exactamente los mismos estados de 16 y 32 habitantes, con SQLite temporal WAL/FULL, alternando el orden de los codecs. Con 32 habitantes y 28 672 celdas, el tamaño mediano bajó de **9,60 a 4,81 MiB** y codificar más guardar pasó de p50 **117,07 a 71,10 ms** y p95 **138,69 a 86,77 ms**. La clonación pasó de p50 **35,36 a 4,35 ms**. Se comprobaron 96 decodificaciones exactas, 48 comparaciones entre clones, 96 comprobaciones de aislamiento y ambos checkpoints.

La lectura del formato compacto consume más CPU: media **27,31 → 52,86 ms** en el escenario de 32 habitantes. No pertenece al guardado de cada paso, pero afecta recuperación y carga. El formato usa tuplas JSON sin cuantización, rechaza opcionales nulos o no finitos y admite snapshots antiguos. El esquema SQLite sigue en versión 2. [Informe CPU y reproducción](../artifacts/cpu-v3-report.md), [muestras y hashes](../artifacts/cpu-v3-comparison.json).

El renderer ahora reutiliza regiones rasterizadas, mantiene cachés acotadas y puede componer terreno mediante WebGL2, con respaldo Canvas2D y recuperación de pérdida de contexto. En un escenario sintético de 88 × 56 celdas y 20 habitantes moviéndose, Chromium predeterminado pasó de **15,58 a 59,75 FPS**. Con RTX 5070 Ti reconocida mediante Vulkan, V3 obtuvo **59,84 FPS**. Desactivar WebGL mantuvo **59,90 FPS** gracias a las cachés. Son 100 cuadros medidos tras calentamiento; no garantizan 60 FPS en la aplicación completa. Una captura del E2E real con paneles abiertos registró 28,7 FPS. [Informe gráfico y comandos](../artifacts/render-v3-report.md).

Se detectaron **RTX 5070 Ti y RTX 2060**. La GPU utilizada para dibujar pertenece al navegador; las GPU del servidor no calculan todavía la ecología. El motor continúa en CPU con un único escritor persistente. La GPU física no se deduce de tener WebGL: Chromium predeterminado detectó SwiftShader y usó el respaldo. No se atribuye al juego la utilización de GPU de otros procesos.

El servicio privado, con 16 384 celdas activas, registró en la sonda p95 reciente **116,29 ms**, guardado **68,17 ms** y RSS **279,59 MiB**. No se acredita un plazo constante de 100 ms ni que abrir doce clientes mantenga esa latencia. El máximo admitido actualmente es de 12 conexiones y 32 habitantes.

## Causalidad, recuperación y revisión

Las pruebas mantienen los controles anteriores de cuerpo, alimento, techo, recuerdo pertinente frente a ausente e irrelevante, imitación, navegación física, archivo y seguridad. V3 añade controles de:

- Agua debitada, sed reducida y desplazamiento físico a otra fuente tras agotar la anterior.
- Caza con trabajo previo, animal retirado y comida finita; una celda vacía no produce alimento.
- Transferencia, intercambio, enseñanza y asistencia con efectos reales y cooperación desactivada como contraste.
- Fauna migrante con débito y crédito, reproducción animal con coste, plantas y capa celular independientes del orden de evaluación.
- Comunidad sin confianza que no se forma; cambio de pertenencia condicionado a prácticas, vínculos y alternativas cercanas.
- Misma fuente, misma acción, urgencia y escasez necesarias para disputar; abundancia, necesidad satisfecha o recursos distintos no disparan el mismo conflicto.
- Confianza o apertura que permiten un turno; la espera de 12/30 pasos resiste la reevaluación por necesidad urgente.
- Herencia determinista de ambos progenitores, mutaciones acotadas, costes del nacimiento y aprendizaje propio del descendiente.
- Plasticidad que cambia la preferencia adquirida conservando los mismos costes materiales.
- Rechazo de genealogías imposibles, historial incompleto y comunidad incoherente; snapshots corruptos no reinician el mundo.
- Continuación idéntica al reiniciar cuando un encuentro actualiza el lugar y sus metadatos regionales.

La revisión independiente reprodujo y cerró tres defectos: cesión cancelada prematuramente por urgencia, ayuda contabilizada con cero trabajo y opcionales inválidos convertidos en ausencia por el codec. Verificó 56 valores inválidos contra ambos checkpoints intactos, cuatro recargas y 120 estados idénticos frente al JSON anterior. La prueba de charcas detectó depósitos existentes que no se dibujaban sobre suelo seco; el dibujo y el control de píxeles quedaron corregidos.

La migración se comprobó sobre una copia real del mundo V2 en el paso **70179**, conservando todos los campos previos de habitantes y celdas, el azar, el tiempo y los acumulados. La lectura de prueba no alteró esa copia.

## Activación y conservación

V3 está activa en **https://172.26.0.4:3443**, con la contraseña existente. El último paso V2 antes del cambio fue **72747**, con 16 habitantes, 1016 descubrimientos y 845 refugios. El navegador comprobó posteriormente el paso **73783**, 1039 descubrimientos y 860 refugios. La historia continuó; no se reemplazó el mundo por una semilla nueva.

Se conservaron una copia previa, otra después del cierre ordenado y el build anterior en el directorio privado `~/.local/state/atlas-para-isa-preview`. El mundo vive en su subdirectorio `world`; servidor y TLS permanecen en `carta-isa-world` y `carta-isa-https`. HTTPS usa el certificado local existente. Cerrar esta terminal no cierra esas sesiones; no se ha acreditado arranque automático tras reiniciar el contenedor.

Se recuperaron los frentes tras el cierre de la instancia de trabajo. La inspección de procesos identificó la TUI y el servicio de esta conversación conectados; no se cerró el backend activo ni procesos de otros proyectos. Los checkpoints de trabajo son `67e7e71` y `61201bb`, seguidos del commit de este registro.

## Trabajo paralelo y límites científicos

Gemini 3.8 Flash High aportó una propuesta sustantiva de ecosistema; Opus aportó revisión sustantiva de interfaz. Ambos resultados se adaptaron y comprobaron localmente. Codex y sus subagentes realizaron integración, fisiología, herencia, sociedad, persistencia, CPU/GPU, pruebas y revisión independiente.

La solicitud final a `claude/fable`, esfuerzo alto y acceso solo a texto, terminó con «claude superó el timeout de 180 s (proceso terminado)», sin salida utilizable. No cuenta como revisión completada. No se enviaron secretos ni recuerdos reales; el mundo no necesita un LLM para avanzar.

No se probaron teléfono físico, Safari/iOS, lector de pantalla, ruta de red desde la torre, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco, cálculo ecológico en GPU ni escalado distribuido. Tampoco se demuestra conciencia, autopoiesis biológica, efecto Baldwin o evolución indefinida. Los mecanismos implementados y sus fuentes están en [REGLAS.md](REGLAS.md) y [CIENCIA.md](CIENCIA.md). Las mediciones V2 permanecen en el historial y en sus artefactos identificados.
