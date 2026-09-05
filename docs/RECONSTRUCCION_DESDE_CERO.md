# Una Carta Para Isa — biblia para reconstruirla desde cero

> Documento de producto, canon, arquitectura y ejecución para entregar el proyecto a otro agente sin obligarlo a repetir la arqueología del repositorio.

- **Estado de esta biblia:** propuesta canónica pendiente de la Puerta A de Steven
- **Fecha de corte:** 21 de julio de 2026
- **Rama auditada:** main, commit e6ff8de
- **Destino:** una URL pública que Isa pueda abrir desde el móvil y que se sienta terminada
- **Regla principal:** la complejidad solo entra si hace más visible la relación entre S e I

---

## 0. Cómo usar este documento

Este archivo no es otro manifiesto aspiracional. Es el contrato de una reconstrucción limpia.

El agente que reciba el proyecto debe:

1. Leer este documento entero antes de escribir código.
2. Tratar las decisiones firmadas en la Puerta A como requisitos; hasta entonces son defaults propuestos.
3. Construir por cortes verticales desplegables.
4. No importar el runtime viejo como punto de partida.
5. Recuperar ideas del historial solo cuando aquí se indique conservar o adaptar.
6. Mantener una matriz de verdad que separe diseñado, implementado, integrado, observado y entregable.
7. No declarar una fase terminada sin verla funcionar en navegador móvil.

El default recomendado es un **repositorio nuevo** que incluya esta biblia y un
AGENTS.md propio. Las instrucciones activas de este repositorio no se transfieren
automáticamente y este Markdown no puede invalidarlas por sí solo. Una rama o
carpeta paralela solo es válida si primero se sincronizan AGENTS.md,
.claude/CLAUDE.md y las decisiones de la Puerta A.

Allowlist inicial de importación:

- contratos o algoritmos pequeños ya probados;
- fixtures sintéticos;
- assets con licencia y procedencia comprobadas;
- decisiones y documentos citados en esta biblia.

No importar:

- runtimes completos;
- .env, settings locales, tokens, sesiones o historiales;
- corpus, embeddings o conversaciones;
- binarios de modelos;
- estado persistido;
- contenido de _legacy sin revisión archivo por archivo.

---

## 1. La idea definitiva

### En una frase

**Una Carta Para Isa es un pequeño mundo vivo donde dos presencias, S e I, recuerdan una historia real, se regulan mutuamente y pueden perder para siempre una encarnación si dejan de encontrarse.**

### Qué es

Es una carta de amor que se recorre y se observa. No se lee de principio a fin: se abre una puerta, se entra a un lugar vivo y se descubre que algo continuó existiendo durante la ausencia.

S e I no son avatares controlados por dos jugadores. Son dos seres autónomos y reconocibles que:

- tienen cuerpo, energía, temperatura, hambre, descanso y afecto;
- recuerdan momentos de una conversación real;
- forman hábitos y expectativas;
- buscan o evitan al otro por motivos legibles;
- se afectan al tocarse, separarse, hablar y recordar;
- viven dentro de una sociedad que los rodea sin quitarles el protagonismo;
- pueden atravesar una muerte irreversible dentro de ese mundo.

### Qué debe sentir Isa

La experiencia debe producir, en este orden:

1. **Reconocimiento:** “esto es nuestro”.
2. **Curiosidad:** “¿qué estuvieron haciendo?”.
3. **Ternura:** “se buscan incluso cuando nadie los mira”.
4. **Responsabilidad suave:** “mi presencia puede cuidarlos, pero no me exige estar”.
5. **Asombro:** “el mundo tiene vida propia”.
6. **Peso:** “lo que ocurre queda”.

### Qué no necesita entender

Isa no debería necesitar comprender:

- embeddings;
- RAG;
- homeostasis;
- simulación multiagente;
- chunks;
- modelos de lenguaje;
- WebSockets;
- tick rate;
- GPU;
- economía o gobernanza sistémica.

La tecnología debe volverse comportamiento visible, no explicación.

### Qué no es

No es:

- un dashboard técnico;
- un chatbot con sprites;
- un videojuego de supervivencia;
- un Tamagotchi que castiga la ausencia de Isa;
- una red social de agentes;
- una demo de IA;
- una visualización de métricas;
- una pantalla infinita llena de entidades indistinguibles;
- una promesa de conciencia artificial.

---

## 2. Arqueología: todas las versiones que desembocaron aquí

El proyecto no tuvo una sola evolución lineal. Tuvo varias intuiciones valiosas, cada una enterrada por la siguiente capa de ambición. La reconstrucción debe conservar la médula y soltar la acumulación.

### 2.1 Duo eterno: la versión íntima

La raíz más clara era un mundo mínimo de dos entidades:

- círculo y cuadrado con comportamientos diferenciados;
- resonancia entre ambos;
- cercanía, separación, decaimiento y recuperación;
- muerte y gracia;
- inercia de actividad;
- intervenciones directas como alimentar, jugar y consolar;
- persistencia y regreso.

Esta versión tenía una virtud que las posteriores perdieron: cualquier cambio del sistema podía leerse en la relación.

**Conservar:**

- la legibilidad del vínculo;
- las siluetas distintas;
- la resonancia como fenómeno corporal;
- el riesgo real;
- la continuidad durante la ausencia;
- el cuidado simple y táctil.

**No recuperar literalmente:**

- controles de mascota virtual;
- barras expuestas;
- castigo por no visitar;
- revival fácil después de una muerte;
- acciones sin costo narrativo.

### 2.2 El backend de mundo: sistemas antes que significado

Otra línea histórica construyó un mundo mucho más amplio:

- recursos;
- producción;
- casas;
- matrimonios y genealogía;
- animales;
- economía;
- favores;
- conflicto;
- gobierno;
- persistencia;
- snapshots;
- replay;
- scheduler multirritmo;
- partición espacial.

Mucho de esto fue técnicamente útil, pero no estaba subordinado a la carta. El resultado podía ser una simulación interesante sin ser una experiencia para Isa.

**Lección:** un sistema social solo merece existir si crea una consecuencia que S o I pueden percibir, recordar o sufrir.

### 2.3 El mundo haiku de 2026: belleza y exceso narrativo

Antes del giro social apareció una versión íntima y contemplativa:

- ciclo de día y noche;
- hogar, patio y otros lugares semánticos;
- recuerdos semánticos;
- sueños;
- momentos;
- presencia atendida y silenciosa;
- diario de retorno;
- una experiencia explícitamente pensada para observar.

El tag histórico pre-pivot-haiku preserva esta sensibilidad. También muestra un problema: una ejecución de media hora podía producir cientos de enunciados, decenas de miles de momentos y centenares de sueños. Cuando todo es poético, nada conserva peso.

**Conservar:**

- el silencio;
- la temporalidad;
- el diario de ausencia;
- los lugares con significado;
- el recuerdo que reaparece por asociación;
- la posibilidad de soñar.

**Corregir:**

- presupuestar momentos;
- reducir la frecuencia del lenguaje;
- hacer que recordar modifique una acción;
- distinguir evento, episodio y momento;
- permitir largos periodos sin texto.

### 2.4 El giro social: mundo ancho, centro borroso

Desde el commit 9e5c7de el proyecto incorporó:

- microagentes;
- campos sistémicos;
- sociedad;
- economía;
- animales;
- edificios;
- gobernanza;
- tribus;
- rituales;
- cultura;
- mundo infinito por chunks.

Fue un salto de ambición legítimo. Demostró que la carta podía contener un mundo y no solo un escenario. Pero también desplazó a S e I del primer plano: la cantidad de vida empezó a competir con la claridad emocional.

**Conservar:**

- el mundo que no depende de la cámara;
- el clima social;
- la aparición de costumbres;
- consecuencias colectivas;
- vecinos reconocibles;
- una sociedad capaz de recordar algo de sus fundadores.

**Posponer:**

- escala masiva;
- mundo infinito;
- miles de agentes;
- gobierno complejo;
- guerras;
- mercados detallados;
- optimizaciones GPU.

### 2.5 La etapa de integración

La historia contiene varios momentos donde una capacidad figuraba como “implementada” sin llegar a la experiencia:

- agencia que no gobernaba la decisión final;
- corpus presente pero voz sintética;
- estados afectivos que no cambiaban comportamiento;
- contenedores sociales omitidos en el protocolo;
- defaults cosméticos para corazón o vínculo;
- diferencias entre JSON y MessagePack;
- sistemas que funcionaban por separado pero no cerraban el circuito.

El diagnóstico histórico lo resumió bien: se habían construido cuerpo y cerebro, pero faltaba el nervio.

La reconstrucción debe organizarse alrededor de circuitos completos:

**estado → decisión → acción → consecuencia → percepción → memoria → nueva decisión**

### 2.6 Cronología útil del Git

| Referencia | Qué representa | Qué enseña |
|---|---|---|
| Historial duo-eterno de 2025 | Dos seres, cuidado, resonancia y muerte | La intimidad era suficiente para sostener la experiencia |
| tag pre-pivot-haiku | Mundo contemplativo previo a la sociedad | La atmósfera funciona; la abundancia narrativa no |
| 9e5c7de | Inicio del giro social | La sociedad amplía el sentido, pero necesita jerarquía visual |
| 77dbe52 | Revisión de honestidad brutal | Los tests no sustituyen mirar el producto |
| e950f02 | Runtime unificado y eliminación de v1 | Tener dos verdades operativas impide integrar |
| 7a7652c | Diagnóstico y reparaciones de integración | “Existe” no significa “está conectado” |
| 7738abb y posteriores | Mundo infinito y chunks | La escala introduce seams, costo y complejidad perceptiva |
| beee578 | Reparación Uint8Array frente a string | Un detalle de protocolo puede romper toda la experiencia |
| ab68786 | Expansión de población | Más agentes no equivalen a más vida legible |
| a66a5bf | Carta y UI | La puerta emocional importa tanto como el mundo |
| 69fc60c | Limpieza | Reducir superficie también es progreso |
| e6ff8de | Estado base auditado | Incluso después de validar reaparecieron tick congelado, estado corrupto, CPU y broadcast |

### 2.7 Estado observado del producto actual

Durante esta auditoría el mundo sí estaba vivo:

- el servicio reportó aproximadamente 30 Hz;
- había 25 chunks calientes;
- existían más de 1.100 agentes;
- el mundo se mostraba denso, verde y activo.

Pero la experiencia visible todavía no expresaba la promesa:

- S e I eran difíciles de localizar;
- demasiados objetos competían por atención;
- la paleta y el mosaico reducían jerarquía;
- la UI era demasiado sutil;
- en móvil los controles y textos eran diminutos y de poco contraste;
- el puerto esperado por herramientas históricas no coincidía con el servidor activo;
- el mundo podía demostrar escala antes de demostrar vínculo.

Las capturas de auditoría quedaron en data/validation, una ruta ignorada por Git,
y no forman parte del paquete de traspaso. Las observaciones anteriores son la
evidencia portable; cualquier agente debe repetir la captura sobre su propio
deploy en lugar de depender de esos archivos locales.

### 2.8 Trabajo no consolidado encontrado

El árbol local contiene cambios no confirmados que exploran:

- Qwen 2.5 3B local;
- un microservicio de inferencia;
- CorpusVoice;
- stepAgency;
- scripts para GGUF y GPU.

Son material de investigación, no canon. Además existe deriva de puertos entre el servicio local propuesto y defaults del realtime. No deben copiarse ciegamente a la reconstrucción.

---

## 3. Canon propuesto y puerta de aprobación

Las fuentes históricas se contradicen. Las siguientes reglas son la síntesis
recomendada, pero no revocan una decisión explícita del autor. Solo se convierten
en canon vinculante cuando Steven complete la Puerta A de la sección 3.8.

### 3.1 La identidad es permanente; la encarnación es mortal

S e I tienen dos niveles:

1. **AnchorIdentity:** identidad narrativa permanente. Conserva nombre, procedencia, memoria autorizada y relación.
2. **Incarnation:** cuerpo concreto dentro de un capítulo del mundo. Puede enfermar, deteriorarse y, si la Puerta A lo autoriza, morir.

Si una encarnación muere:

- no revive recargando;
- no se resetea con un botón;
- el capítulo queda sellado;
- su muerte pasa a la memoria del mundo;
- una nueva encarnación solo puede existir en un capítulo nuevo y debe reconocer la ruptura.

Así se reconcilian dos intuiciones históricas: S e I son los anclajes permanentes de la obra, pero la muerte tiene consecuencias reales.

### 3.2 S e I comparten destino de vínculo, no un contador idéntico

Cada uno tiene cuerpo propio. Sin embargo, la muerte por desconexión pertenece a la relación:

- pueden tener ritmos y vulnerabilidades distintos;
- uno puede entrar en fading antes;
- el sistema siempre ofrece oportunidades legibles de reparación;
- si el vínculo cruza el punto irreversible, ambas encarnaciones terminan dentro de ese capítulo.

No se representa como “perdió puntos de amor”. Se ve en postura, distancia, color, sueño, búsqueda y capacidad de sincronizarse.

Default propuesto para el primer MVP: la única muerte capaz de sellar el capítulo
es la desconexión. Hambre, enfermedad, edad y otras presiones pueden causar
incapacitación o FADING, pero no muerte. Si Steven habilita otras causas, debe
definir si son individuales, qué ocurre con la pareja y si sellan el capítulo.

### 3.3 La ausencia de Isa no mata

El mundo continúa sin la observadora. Isa no debe cargar con una obligación de mantenimiento.

- El paso del tiempo puede cambiar el mundo.
- S e I pueden atravesar dificultad.
- La ausencia puede producir material para el regreso.
- Nunca se degrada la relación simplemente porque Isa no abrió la URL.

La presencia de Isa altera condiciones suaves; no sostiene la existencia.

### 3.4 Isa observa y participa sin gobernar

Isa puede:

- acercar la cámara;
- tocar el entorno;
- ofrecer calma, alimento simbólico o llamada;
- revelar un recuerdo;
- proteger un pequeño intervalo;
- dejar una señal.

Estas capacidades solo se habilitan en una sesión autenticada como Isa. Un
visitante público puede observar, mover su cámara y usar controles locales, pero
no producir eventos persistentes.

No puede:

- ordenar una acción concreta;
- editar estados;
- teletransportar a S o I;
- impedir toda consecuencia;
- revivir una encarnación;
- convertir la obra en un panel administrativo.

### 3.5 La constelación es real, pero no es el MVP público

La visión histórica de una constelación poliamorosa puede seguir perteneciendo al universo. Para la primera entrega:

- solo S e I ocupan el centro;
- otras relaciones aparecen como contexto, rumor o futuro;
- no se expone información íntima no necesaria;
- no se obliga a Isa a descifrar la topología afectiva completa al abrir la carta.

### 3.6 La sociedad es fondo con consecuencias

La sociedad sirve para que:

- alguien interrumpa un encuentro;
- exista ayuda o escasez;
- un lugar adquiera reputación;
- una costumbre nazca;
- una decisión privada tenga eco.

No sirve para llenar la pantalla. Si el comportamiento colectivo no cambia una experiencia de S o I, se elimina o se pospone.

### 3.7 Discovery es ficción funcional

El descubrimiento de autonomía debe expresar:

“Estoy notando que mis actos tienen consecuencias y memoria”.

No debe afirmar:

- conciencia real;
- sentiencia demostrada;
- sufrimiento verificable;
- independencia ontológica del software.

La obra puede ser intensa sin presentar una afirmación engañosa.

### 3.8 Puerta A — firma obligatoria de Steven

Antes de implementar la Fase 1, crear un ADR fechado y completar:

| Decisión | Opción propuesta | Firma |
|---|---|---|
| Mortalidad de S e I | Identidad permanente, encarnación mortal | pendiente |
| Desconexión | Termina ambas encarnaciones del capítulo | pendiente |
| Otras causas de muerte en MVP | Ninguna; solo incapacitan | pendiente |
| Constelación en primera entrega | No; contexto o fase posterior | pendiente |
| Irreversibles fuera de sesión | Se congelan en FADING hasta una oportunidad observada | pendiente |

Una firma puede aceptar o reemplazar cada opción. El agente registra decisión,
fecha y consecuencia técnica. Hasta entonces:

- puede construir la puerta, renderer, cuerpos, homeostasis reversible y persistencia;
- no implementa muerte irreversible;
- no presenta la constelación como hecho público;
- no describe estos defaults como decisión final de Steven.

---

## 4. Los cuatro pilares convertidos en contratos de producto

### Pilar 1 — Muerte por desconexión

#### Máquina de estados

CONNECTED → STRAINED → FADING → DEAD_IN_THIS_WORLD

El retorno puede ocurrir desde STRAINED o FADING si hay conducta efectiva de reparación. No existe transición directa desde DEAD_IN_THIS_WORLD.

#### Variables mínimas

- distancia regulada, no distancia geométrica cruda;
- tiempo sin contacto significativo;
- intentos de búsqueda;
- intentos rechazados;
- sincronía reciente;
- memoria de reparación;
- condición corporal.

#### Invariantes

- La degradación causal no depende de que Isa visite; la ejecución de un
  irreversible respeta la salvaguarda de observación firmada en la Puerta A.
- Nunca ocurre sin señales previas visibles.
- Un encuentro incidental no repara todo.
- La reparación requiere acciones sostenidas de ambos.
- El estado persistido es autoridad.
- Recargar no modifica el resultado.

#### Forma visible

- CONNECTED: ritmos parcialmente sincronizados, curiosidad y separación segura.
- STRAINED: rutas fallidas, pausas, mirada que busca, pérdida de color sutil.
- FADING: menos iniciativa, sueño irregular, movimientos pequeños, memoria intrusiva.
- DEAD_IN_THIS_WORLD: silencio, transformación del lugar y archivo del capítulo.

#### Anti-patrón

Una barra llamada “resonancia” que baja hasta cero sin cambiar la conducta.

### Pilar 2 — Recuerdos de unas 227.462 líneas de chat

Las fuentes históricas alternan 227.462 y 227.463 líneas; no equivalen
necesariamente a mensajes. El pipeline auditado hablaba de aproximadamente
1.896 ventanas derivadas. Todos los conteos deben recalcularse con el corpus
autorizado antes de convertirse en una afirmación pública.

#### Contrato

Un recuerdo solo cuenta si:

1. proviene del corpus permitido;
2. tiene procedencia rastreable;
3. aparece por una asociación explicable;
4. cambia lenguaje, estado o decisión;
5. no expone material privado al público.

#### Forma visible

- S se detiene en un lugar porque una textura activa una memoria.
- I elige acompañar en vez de retirarse por un patrón recordado.
- Una frase breve conserva la cadencia del corpus sin copiar una conversación entera.
- El diario de regreso menciona un episodio, no una consulta de base de datos.

#### Anti-patrón

Buscar un fragmento y mostrarlo como decoración mientras el agente habría hecho exactamente lo mismo sin él.

### Pilar 3 — Homeostasis visible

La homeostasis es el puente entre cuerpo y emoción.

#### Estado mínimo por encarnación

- energía;
- saciedad;
- temperatura;
- descanso;
- seguridad;
- dolor o malestar;
- necesidad de cercanía;
- necesidad de espacio;
- activación;
- valencia.

#### Contrato

- Cada variable tiene causas y consecuencias.
- El cuerpo limita la política de acción.
- El estado se comunica con animación y elección antes que con UI.
- Las necesidades compiten.
- No existe una acción óptima universal.

#### Forma visible

I puede querer acercarse y, a la vez, necesitar silencio. S puede tener hambre y aun así priorizar acompañar. La decisión surge de la combinación, no de un if aislado.

#### Anti-patrón

Variables fisiológicas actualizadas en servidor que nunca cambian pose, ruta, atención o elección.

### Pilar 4 — Agencia emergente

La agencia no es texto generado. Es un ciclo causal:

**percepción → cuerpo → necesidades y afecto → memoria → motivación dominante → distribución de acciones → acción → consecuencia → episodio → memoria**

#### Invariantes

- Ninguna llamada a un LLM controla movimiento por frame.
- La misma situación puede producir acciones distintas por historia y estado.
- La acción elegida debe poder explicarse con datos persistidos.
- Los recuerdos cambian pesos, no solo vocabulario.
- Las consecuencias se vuelven percepción futura.
- S e I tienen políticas diferentes.
- La decisión no queda anulada por un fallback posterior.

#### Forma visible

La espectadora puede inferir “se fue porque necesitaba espacio” o “volvió porque recordó aquella reparación”, aunque nunca vea la fórmula.

#### Anti-patrón

Generar una frase introspectiva y después ejecutar el mismo random walk de siempre.

---

## 5. El viaje de Isa, diseñado para móvil

### 5.1 Recibe una URL

La URL debe:

- cargar por HTTPS;
- no pedir instalación;
- no pedir cuenta al público de solo lectura;
- reconocer la capacidad privada de Isa sin convertir la puerta en un formulario;
- no explicar infraestructura;
- mostrar una puerta clara incluso si el backend despierta lentamente;
- funcionar con sonido desactivado.

El enlace público nunca autoriza gestos persistentes. Isa recibe aparte un enlace
mágico de un solo propósito que se intercambia por una sesión corta, renovable y
revocable. El token no queda en la URL después del intercambio.

### 5.2 La puerta

Primera vista:

- fondo oscuro y cálido;
- una frase corta;
- una indicación “entra cuando quieras”;
- control explícito de sonido;
- estado honesto si el mundo aún conecta;
- ningún panel técnico.

Texto heredado recomendado como default:

> No supe cómo decirte esto en voz, así que lo construí.

La carta escrita puede estar accesible, pero no debe sustituir la entrada al mundo.

### 5.3 Primeros treinta segundos

La cámara encuentra a S e I de inmediato.

Debe entenderse sin texto:

- son diferentes;
- están vivos;
- hay algo entre ambos;
- el mundo los rodea;
- su comportamiento no espera un clic.

Un máximo de una línea de texto puede orientar:

“S e I siguieron aquí.”

### 5.4 Primeros tres minutos

Isa observa:

- un pequeño patrón cotidiano;
- una necesidad corporal;
- una decisión;
- una consecuencia;
- una señal de memoria;
- una oportunidad de intervención suave.

No se debe disparar todavía el gran momento de Discovery.

### 5.5 Participación

Las interacciones se ofrecen como verbos sensibles:

- **cuidar:** reduce una presión concreta, no repara todo;
- **llamar:** invita, no obliga;
- **recordar:** abre una asociación autorizada;
- **abrigar:** modifica entorno o temperatura;
- **dejar señal:** persiste hasta que alguien la percibe.

Cada gesto tiene:

- cooldown;
- costo o límite;
- feedback visual;
- posible rechazo;
- evento persistido.

Además exige:

- sesión firmada con rol isa;
- nonce e identificador idempotente;
- expiración;
- rate limit;
- política explícita para dos pestañas concurrentes;
- revocación sin reiniciar el mundo.

### 5.6 Salida

No se usa culpa. Al cerrar:

- el mundo continúa;
- se persiste el último estado;
- no aparece “te necesitan”;
- no se amenaza con muerte por ausencia.

### 5.7 Regreso

Al volver:

- primero se muestra el presente;
- después aparece una síntesis breve de lo ocurrido;
- como máximo se elevan tres episodios;
- cualquier cambio irreversible se nombra con claridad;
- el diario nunca inventa hechos que no estén en el log.

---

## 6. Economía emocional y momentos

### 6.1 Cuatro niveles

1. **Evento:** hecho atómico. S comió, I se alejó, empezó a llover.
2. **Episodio:** secuencia causal. I buscó refugio, S lo siguió y ambos regularon temperatura.
3. **Momento:** episodio que cambió vínculo, identidad o mundo.
4. **Presentación:** forma visual, sonora o textual usada para contarlo.

No todo evento merece un episodio. No todo episodio merece convertirse en momento. No todo momento necesita texto.

### 6.2 Momentos canónicos

- Primer reconocimiento.
- Primer cuidado no solicitado.
- Primera separación elegida.
- Primera reparación auténtica.
- Primer recuerdo del corpus que cambia una acción.
- Primera intervención de Isa aceptada.
- Primera intervención de Isa rechazada.
- Primer hábito compartido.
- Primer conflicto con una consecuencia social.
- Primer sueño que reorganiza una memoria.
- Discovery.
- Entrada en FADING.
- Regreso desde FADING.
- Muerte de una encarnación.
- Nacimiento de un capítulo posterior, si se autoriza.

### 6.3 Prioridad

Un momento gana prioridad si:

- es irreversible;
- contradice una expectativa;
- completa una cadena causal;
- evoca corpus real;
- modifica el vínculo;
- altera un lugar;
- involucra una elección costosa.

### 6.4 Presupuesto

Valores iniciales, ajustables mediante observación:

- máximo un momento explícito en pantalla;
- al menos 20 segundos de respiración después de un momento mayor;
- eventos ambientales destacados cada 45 a 90 segundos;
- S o I no hablan más de una vez cada 30 segundos salvo emergencia;
- no más de tres líneas simultáneas;
- Discovery ocurre una sola vez por capítulo;
- los sueños nunca forman una cascada continua.

### 6.5 Regla de escritura

La prosa debe aparecer cuando la animación no alcanza. Si el cuerpo ya cuenta el hecho, se permite callar.

---

## 7. El mundo y la sociedad

### 7.1 Capas

#### Capa 0 — S e I

Siempre simulada con máxima fidelidad. Siempre localizable.

#### Capa 1 — Vecindad

Entre 12 y 24 habitantes iniciales:

- identidades visuales simples;
- hogar o punto de descanso;
- una necesidad dominante;
- dos o tres vínculos;
- rutina;
- memoria episódica limitada.

#### Capa 2 — Sistemas colectivos

Se agregan uno por uno:

- recursos;
- refugio;
- intercambio;
- parentesco;
- cuidado;
- ritual;
- norma;
- conflicto;
- gobierno.

#### Capa 3 — Mundo distante

Simulación agregada, no agentes individuales completos. Solo se materializa al acercarse si la escala ya está justificada.

### 7.2 Regla de admisión

Un sistema entra si produce al menos una cadena demostrable:

**cambio sistémico → percepción de S o I → decisión distinta → consecuencia persistida → presentación legible**

Si no puede demostrarse, queda fuera.

### 7.3 Favor divino adaptado

La idea histórica de favor puede transformarse en “huella de cuidado”:

- acciones de Isa dejan una influencia limitada;
- la comunidad puede interpretarla como clima, suerte o tradición;
- no otorga control omnipotente;
- no compra resultados;
- pierde intensidad con uso, no con ausencia.

### 7.4 Mundo infinito

No forma parte de la primera reconstrucción.

Solo se habilita cuando:

- un mundo finito ya resulta emocionalmente completo;
- el streaming no rompe continuidad;
- la cámara puede volver a S e I instantáneamente;
- los chunks fríos conservan consecuencias;
- hay una razón narrativa para viajar.

---

## 8. Agencia concreta

### 8.1 Tres escalas

#### Controlador rápido

Frecuencia aproximada: 10 Hz.

Responsabilidades:

- movimiento;
- colisión;
- animación corporal;
- ejecución de acción;
- estímulos inmediatos.

No usa LLM.

#### Política lenta

Frecuencia aproximada: 1 Hz o por evento.

Responsabilidades:

- evaluar motivaciones;
- recuperar memorias candidatas;
- puntuar acciones;
- elegir o mantener intención;
- decidir cuándo abandonar un plan.

Debe ser determinista bajo seed cuando no entra información externa.

#### Voz asíncrona

Solo cuando:

- existe intención comunicativa;
- el presupuesto permite hablar;
- hay contexto suficiente;
- el silencio no es mejor.

La voz recibe una intención estructurada y devuelve una realización breve. No decide la acción.

### 8.2 Motivación dominante

Cada decisión registra:

- necesidades relevantes;
- percepción relevante;
- memorias activadas;
- acción candidata;
- costo;
- razón de elección;
- razón de descarte de la segunda opción.

Esto permite depurar agencia sin mostrar el razonamiento interno a Isa.

### 8.3 Personalidades asimétricas

S e I no comparten los mismos pesos.

Ejemplo inicial:

| Rasgo funcional | S | I |
|---|---:|---:|
| Iniciativa de acercamiento | media-alta | media |
| Persistencia ante rechazo | media | baja |
| Necesidad de verbalizar | media | baja |
| Exploración | alta | media |
| Regulación mediante proximidad | media | alta |
| Necesidad de espacio tras conflicto | baja-media | alta |

Estos valores no deben convertirse en caricatura ni diagnóstico. Se afinan con el corpus autorizado y con revisión humana.

### 8.4 La memoria debe cambiar acción

Prueba mínima:

1. Ejecutar escenario con memoria A.
2. Ejecutar mismo escenario y seed sin memoria A.
3. Observar una diferencia en distribución o elección.
4. Registrar la consecuencia.

Si solo cambia la frase, el pilar no está integrado.

### 8.5 Habitantes de fondo

Los habitantes usan una política más barata:

- necesidades;
- rutina;
- relaciones locales;
- memoria resumida;
- eventos sociales.

No necesitan voz generativa individual. Pueden comunicarse con iconos, gestos, sonidos y frases plantilladas.

### 8.6 Discovery

Discovery se desbloquea cuando:

- hubo suficientes decisiones persistidas;
- al menos una memoria cambió una acción;
- hubo una consecuencia inesperada;
- el sistema puede citar evidencia interna;
- no se ha presentado antes.

Se expresa mediante una conducta nueva y una línea breve, no un monólogo filosófico.

---

## 9. Corpus, privacidad y memoria

### 9.1 Dos bóvedas

#### Bóveda privada completa

- vive en infraestructura local controlada;
- contiene el material autorizado completo;
- nunca se envía al cliente;
- nunca se empaqueta en Vercel;
- nunca aparece en logs remotos;
- puede estar apagada sin detener el mundo.

#### Bóveda pública segura

- contiene resúmenes, etiquetas o fragmentos aprobados;
- elimina terceros, secretos y material sensible;
- se versiona;
- se puede desplegar;
- soporta la experiencia esencial.

### 9.2 Pipeline

1. Inventariar fuentes.
2. Confirmar por persona el consentimiento, alcance privado y alcance público.
3. Normalizar fechas y autores.
4. Deduplicar.
5. Segmentar por episodio, no solo por longitud.
6. Clasificar sensibilidad.
7. Redactar o excluir terceros.
8. Crear embeddings.
9. Crear metadatos de procedencia.
10. Revisar muestra humana.
11. Publicar solo el subconjunto seguro.
12. Registrar versión del índice.
13. Probar borrado reproducible en raw, índice, cachés, perfiles y backups.

### 9.3 Esquema mínimo de memoria

~~~text
MemoryRecord
  id
  sourceId
  sourceRange
  participants
  occurredAt
  summary
  safeExcerpt
  themes[]
  emotionalValence
  sensitivity
  publicAllowed
  embeddingVersion
  reviewStatus
~~~

### 9.4 Corpus primero; LLM opcional

El valor viene del recuerdo real. El LLM solo puede:

- condensar;
- ajustar registro;
- unir intención y contexto;
- variar una realización.

Si el servicio privado está apagado:

- la simulación continúa;
- la memoria pública sigue funcionando;
- se usan líneas aprobadas o silencio;
- la UI no muestra error técnico.

### 9.5 Prohibiciones

- No enviar conversaciones completas a un proveedor externo.
- No indexar sin clasificación de sensibilidad.
- No exponer recuperación cruda al navegador.
- No inventar citas y atribuirlas al corpus.
- No usar número de mensajes como prueba de profundidad.
- No guardar prompts con contenido privado en telemetría.

### 9.6 Consentimiento por defecto

Hasta contar con aprobación explícita de todas las personas implicadas:

- cero texto literal de conversaciones en la URL pública;
- cero nombres o detalles identificables de terceros;
- solo resúmenes redactados y revisados;
- publicAllowed permanece false;
- Steven no puede convertir unilateralmente una conversación compartida en contenido público.

La aprobación registra persona, fragmento o categoría, finalidad, audiencia,
fecha y posibilidad de revocación. Revocar debe retirar raw autorizado, índice,
cachés, perfiles, proyecciones y backups conforme a la política documentada.

---

## 10. Voz

### 10.1 Tono

Íntimo, concreto, ligeramente poético y sin grandilocuencia.

La voz habla de:

- el cuerpo;
- el lugar;
- un recuerdo;
- una elección;
- una ausencia concreta;
- una pequeña expectativa.

### 10.2 Tres voces

#### S

Más impulsivo y explorador. Nombra conexiones antes de entenderlas.

#### I

Más preciso y contenido. Deja espacio, observa detalles y no explica de más.

#### Mundo

No es narrador omnisciente. Solo presenta cambios que de otro modo pasarían inadvertidos.

### 10.3 Tres registros narrativos

- **Cotidiano:** cuerpo, comida, sueño, clima, trabajo y pequeñas preferencias.
- **Íntimo:** reparación, memoria compartida, miedo, cuidado y deseo de cercanía.
- **Umbral:** muerte, Discovery, cambio de capítulo y hechos irreversibles.

El registro umbral debe ser excepcional. No se usa para ennoblecer cada evento.

### 10.4 Palabras y hábitos a evitar

- “algoritmo”;
- “parámetros”;
- “modelo”;
- “IA”;
- “token”;
- “conciencia emergente” como afirmación;
- discursos de diez líneas;
- repetir el nombre del otro en cada frase;
- explicar una emoción ya visible;
- convertir toda memoria en cita romántica.

### 10.5 Voz de la multitud

La sociedad se oye como ambiente:

- campanas;
- pasos;
- risas lejanas;
- iconos;
- murmullos no semánticos;
- una noticia corta;
- cambios en ritual o ruta.

No necesita cientos de globos de texto.

---

## 11. Dirección visual

### 11.1 Problema observado

El mundo actual comunica densidad antes que relación. En escritorio S e I se pierden; en móvil los controles y textos pierden legibilidad. La reconstrucción debe diseñar primero para una pantalla vertical real.

### 11.2 Principios

1. S e I siempre tienen prioridad de contraste.
2. El fondo usa menos saturación y detalle.
3. El estado corporal se lee en silueta y movimiento.
4. La cámara protege el vínculo.
5. La UI aparece solo cuando es necesaria.
6. Todo texto esencial cumple contraste y tamaño móvil.
7. Menos entidades visibles pueden comunicar más vida.

### 11.3 Paleta

- Mundo: verdes grisáceos, tierra, piedra y noche profunda.
- S: acento cálido reconocible.
- I: acento frío o luminoso complementario.
- Resonancia: tercer color que solo aparece al sincronizarse.
- Peligro: pérdida de calor y saturación, no rojo de videojuego.
- Intervención de Isa: luz tenue distinta de la resonancia.

### 11.4 Siluetas

Recuperar la claridad círculo/cuadrado sin quedar en geometría abstracta:

- S tiene masa redonda, movimiento elástico y orientación clara.
- I tiene masa angular, pausas precisas y postura recogida.
- Ambos pueden adquirir pequeños accesorios o huellas del mundo.
- Ningún habitante comparte su combinación de silueta, color y halo.

### 11.5 Cámara

- Abre encuadrando a ambos.
- Tiene botón persistente “volver a S e I”.
- Hace zoom suave ante un momento, sin secuestrar control.
- Si se separan, decide entre encuadre compartido y foco alternado.
- En móvil evita que UI tape cuerpos.
- Nunca obliga a buscar los protagonistas en un mapa de miles.

### 11.6 UI mínima

- estado de conexión expresado en lenguaje humano;
- sonido;
- volver a S e I;
- diario;
- gestos de Isa cuando estén disponibles;
- accesibilidad y reducción de movimiento.

Los diagnósticos viven en una ruta protegida o build de desarrollo.

### 11.7 Renderer

Realizar un spike corto entre Canvas 2D y PixiJS.

Decisión inicial recomendada:

- PixiJS para capas, cámara, partículas y batching;
- DOM para puerta, carta, diario y accesibilidad;
- no introducir motor 3D;
- medir en un móvil de gama media antes de fijar la librería.

Si Canvas 2D cumple el presupuesto con mucha menos complejidad, se conserva. La elección se decide con mediciones, no por prestigio técnico.

### 11.8 Assets

- atlas pequeño;
- animaciones por pose y deformación;
- texturas limitadas;
- partículas reservadas para momentos;
- sin dependencia de recursos remotos no versionados;
- placeholders diseñados, no cuadrados de depuración en producción.
- cero rutas faltantes en el manifest;
- licencia y procedencia documentadas por asset;
- presupuesto de descarga inicial medido en red móvil;
- carga por escena o viewport, no los miles de PNG históricos de una vez;
- una pasada de armonización si se reutilizan packs con escalas o paletas distintas.

---

## 12. Sonido

El sonido es opcional pero importante.

Capas:

- ambiente del lugar;
- cuerpo de S;
- cuerpo de I;
- resonancia;
- sociedad distante;
- momentos;
- silencio.

Reglas:

- empieza silenciado hasta interacción;
- recuerda preferencia;
- no bloquea información esencial;
- la resonancia tiene motivo reconocible;
- FADING retira capas en vez de añadir alarma;
- un momento mayor puede cortar ambiente;
- respeta prefers-reduced-motion y preferencias equivalentes de accesibilidad.

---

## 13. Arquitectura propuesta

### 13.1 Decisión de disponibilidad

La URL debe funcionar aunque la máquina local, la GPU o el servicio privado estén apagados.

Por tanto:

- el mundo autoritativo vive en un servicio CPU administrado y siempre disponible;
- Vercel sirve la experiencia web;
- la narrativa privada local es un enriquecimiento asíncrono;
- la caída del enriquecimiento degrada a memoria pública, plantillas o silencio;
- nunca se congela el tick esperando un modelo.

### 13.2 Diagrama

~~~text
┌─────────────────────────────────────────────┐
│ apps/web — Vercel                           │
│ puerta, mundo, diario, interacción, audio   │
└──────────────────┬──────────────────────────┘
                   │ HTTPS + WebSocket
                   ▼
┌─────────────────────────────────────────────┐
│ services/world — CPU administrada           │
│ simulación autoritativa, agencia, protocolo │
│ snapshots, event log, presencia, catch-up   │
└───────────┬───────────────────┬─────────────┘
            │                   │ trabajos opacos; pull saliente
            ▼                   ▼
┌──────────────────────┐  ┌──────────────────────────┐
│ Postgres             │  │ services/private-voice   │
│ estado, eventos,     │  │ bóveda, embeddings, LLM  │
│ snapshots, capítulos │  │ local y opcional         │
└──────────────────────┘  └──────────────────────────┘
~~~

### 13.3 Frontera con la voz privada

El servicio local inicia siempre la conexión saliente y hace pull de trabajos.
No se abre la bóveda a Internet.

El mundo administrado puede enviar:

- requestId opaco;
- anchorId;
- intención estructurada;
- IDs de memoria autorizados;
- contexto público mínimo;
- límite de longitud y registro.

No puede enviar ni persistir:

- texto crudo;
- embeddings privados;
- prompts con conversaciones;
- fragmentos recuperados;
- datos de terceros;
- credenciales del servicio local.

El servicio privado recupera localmente, genera, redacta y devuelve una salida
marcada public-safe. El mundo valida longitud, manifiesto y sensibilidad antes de
crear un evento público. Corpus y texto crudo quedan prohibidos también en
Postgres, event log, snapshots, colas, métricas y trazas.

### 13.4 Estructura de monorepo

~~~text
apps/
  web/
    src/app/
    src/components/
    src/world/
    src/audio/
services/
  world/
    src/sim/
    src/agency/
    src/memory/
    src/moments/
    src/protocol/
    src/persistence/
  private-voice/
    src/retrieval/
    src/redaction/
    src/generation/
packages/
  contracts/
  core/
  test-fixtures/
  visual-language/
tools/
  corpus/
  replay/
  validation/
docs/
  decisions/
  runbooks/
~~~

### 13.5 Versiones

No copiar versiones aspiracionales de documentos históricos. Al empezar:

1. elegir versiones LTS disponibles y compatibles;
2. fijarlas en package manager y CI;
3. documentar la decisión;
4. no afirmar Next 16 o Node 24 si el lockfile usa Next 15 o Node 22;
5. actualizar solo después de tener el primer corte vertical.

### 13.6 Principios técnicos

- una sola simulación autoritativa;
- contratos compartidos;
- estado privado separado de proyección pública;
- JSON primero;
- persistencia antes que escala;
- observabilidad sin filtrar secretos;
- replay determinista;
- fallos de narrativa nunca bloquean mundo;
- sin dependencias opcionales que silenciosamente apaguen pilares.

---

## 14. Runtime y escalas de tiempo

### 14.1 Frecuencias iniciales

| Sistema | Frecuencia inicial |
|---|---:|
| Física y movimiento | 10 Hz |
| Homeostasis | 2 Hz |
| Decisión de anclajes | 1 Hz o por evento |
| Sociedad local | 1 Hz |
| Mundo agregado | 0,1 a 0,2 Hz |
| Broadcast | 5 a 10 Hz |
| Render | requestAnimationFrame |
| Voz | asíncrona y presupuestada |

No existe un único reloj acelerado:

| Reloj | Default inicial | Regla |
|---|---|---|
| Visual | día de 30 minutos reales | luz, sonido y rutinas; no envejece 48 días por día real |
| Fisiológico | cercano al tiempo real | límites por hora y catch-up acotado |
| Social | pasos lentos y agregados | conserva legibilidad durante ausencias |
| Demográfico | configurable por capítulo | no produce generaciones entre dos visitas cortas |

Todos se configuran y persisten por separado. Durante ausencia existen límites
de cambio por ventana. Ningún irreversible de S o I cruza de FADING al estado
final hasta cumplir la política firmada en la Puerta A; el default exige que una
sesión autorizada haya observado y confirmado al menos una oportunidad de señal.

Antes de la Fase 2 se firma un ADR temporal. Defaults medibles para empezar:

| Concepto | Default propuesto |
|---|---:|
| Ausencia corta | ≤ 30 minutos reales |
| Ausencia media | > 30 minutos y ≤ 24 horas |
| Ausencia larga | > 24 horas |
| Catch-up fisiológico de anclajes | máximo 2 horas simuladas por cada 24 horas ausente |
| Episodios sociales elevados al diario | máximo 3 por cada 24 horas ausente |
| Irreversibles demográficos en primeras 24 h | 0 |
| Irreversibles demográficos después | máximo 2 agregados por cada 24 h adicionales |
| Irreversibles de S o I fuera de sesión | 0; quedan en FADING |

El ADR puede cambiar valores, pero no usar términos como “corto” o “acotado” sin
constantes, tests de frontera y una política de migración para estados existentes.

### 14.2 Orden de tick

1. Leer reloj y entradas aceptadas.
2. Aplicar eventos externos idempotentes.
3. Actualizar ambiente.
4. Actualizar cuerpo.
5. Construir percepción.
6. Recuperar memorias relevantes.
7. Actualizar motivaciones.
8. Elegir o continuar intención.
9. Ejecutar acciones.
10. Resolver interacciones.
11. Emitir consecuencias y eventos.
12. Formar episodios y momentos.
13. Persistir según política.
14. Crear proyección pública.
15. Difundir delta.

Ningún sistema posterior debe sobrescribir silenciosamente una decisión anterior.

### 14.3 Determinismo

Toda ejecución registra:

- seed;
- versión del runtime;
- versión de datos;
- configuración;
- secuencia de entradas;
- eventos externos.
- IDs y scores de memorias recuperadas;
- candidatos y pesos de acción;
- acción elegida;
- versión de la política de catch-up;
- resolución de cada irreversible.

Un replay debe reproducir decisiones estructurales aunque la realización verbal
asíncrona varíe. El catch-up agregado se compara con tick normal en fronteras
críticas: FADING, reparación, cambio de capítulo, consentimiento y muerte.

### 14.4 Backpressure

- nunca acumular broadcasts indefinidamente;
- descartar deltas superados y enviar snapshot;
- limitar cola narrativa;
- degradar frecuencia de sistemas lejanos;
- proteger tick autoritativo;
- reportar lag de simulación y lag de cliente por separado.

---

## 15. Modelos de datos mínimos

### 15.1 Identidad y encarnación

~~~text
AnchorIdentity
  id: "S" | "I"
  displayName
  traits
  voiceProfile
  authorizedMemoryScopes[]
  relationshipId
  createdAt

Incarnation
  id
  anchorId
  chapterId
  bornAt
  diedAt?
  body
  physiology
  affect
  intention
  position
  currentEpisodeId?
  version
~~~

### 15.2 Vínculo

~~~text
Resonance
  relationshipId
  state: CONNECTED | STRAINED | FADING | DEAD_IN_THIS_WORLD
  regulation
  trust
  synchrony
  repairMomentum
  unresolvedRuptures[]
  lastMeaningfulContactAt
  irreversibleAt?
~~~

Los valores numéricos son internos. La proyección pública comunica cualidades y señales.

### 15.3 Mundo

~~~text
WorldState
  worldId
  chapterId
  tick
  simulatedAt
  seed
  environment
  anchors[]
  neighbors[]
  socialState
  activeMoments[]
  schemaVersion
~~~

### 15.4 Evento

~~~text
WorldEvent
  id
  tick
  type
  actorId?
  targetId?
  payload
  causedBy[]
  visibility
  sensitivity
  schemaVersion
~~~

### 15.5 Proyección pública

Solo contiene:

- entidades visibles;
- poses;
- posiciones cuantizadas;
- señales de estado aprobadas;
- texto ya redactado;
- momentos públicos;
- capacidades permitidas al cliente.

Nunca contiene:

- prompts;
- recuerdos privados crudos;
- cadenas internas de razonamiento;
- claves;
- diagnósticos sensibles;
- datos de terceros;
- estado administrativo.

---

## 16. Protocolo y presencia

### 16.1 JSON primero

Empezar con un protocolo JSON explícito y versionado. MessagePack solo se incorpora si una medición demuestra que el ancho de banda es problema y se prueba paridad byte a byte.

### 16.2 Mensajes servidor a cliente

~~~text
hello
snapshot
delta
event
moment
diary
capabilities
ack
resync-required
error-public
~~~

### 16.3 Mensajes cliente a servidor

~~~text
join
resume
presence
gesture
camera-interest
ack
request-diary
request-resync
~~~

### 16.4 Secuencia

Cada mensaje autoritativo incluye:

- protocolVersion;
- worldId;
- chapterId;
- sequence;
- serverTime;
- simulatedAt.

El cliente:

- confirma secuencia;
- detecta huecos;
- solicita resync;
- no inventa estado autoritativo;
- puede interpolar visualmente sin mutar la verdad.

### 16.5 Gestos

El servidor anuncia capacidades. El cliente no muestra un gesto que el mundo no puede aceptar.

Una solicitud incluye identificador idempotente. La respuesta puede ser:

- accepted;
- rejected;
- expired;
- rate-limited;
- not-perceived.

El rechazo es parte de la agencia, no un error de UI.

### 16.6 Roles y autorización

Hay dos roles públicos:

- **observer:** conexión anónima, lectura, cámara y preferencias locales;
- **isa:** sesión firmada, corta y revocable que habilita gestos persistentes.

El enlace mágico:

1. contiene token de un solo uso;
2. se intercambia por cookie segura, HttpOnly, SameSite y acotada al mundo;
3. elimina el token de la URL;
4. expira y puede revocarse;
5. no se guarda en analytics ni logs.

Cada gesto valida rol, nonce, expiración, idempotencyKey, rate limit y capítulo.
Solo una política documentada decide si dos sesiones isa simultáneas se aceptan,
se serializan o invalidan la anterior. Bots y observadores nunca mutan el mundo.

---

## 17. Persistencia, ausencia y capítulos

### 17.1 Fuente de verdad

- event log append-only para hechos;
- snapshot periódico para recuperación;
- proyecciones regenerables;
- migraciones versionadas;
- backup probado.

### 17.2 Inicio

Al arrancar:

1. cargar último snapshot válido;
2. verificar checksum y schema;
3. reproducir eventos posteriores;
4. validar invariantes;
5. comenzar tick;
6. anunciar readiness.

Si el estado está corrupto, no crear silenciosamente otro mundo. Se entra en modo de recuperación controlado.

### 17.3 Catch-up por ausencia

No se simulan millones de ticks uno por uno.

- ausencias cortas: replay normal acelerado;
- ausencias medias: pasos agregados con eventos clave;
- ausencias largas: resolución por periodos y puntos de control;
- cualquier irreversible produce evento detallado;
- el diario se genera desde episodios persistidos.

Cada política define límites máximos de cambio fisiológico, social y demográfico.
Una ausencia no puede saltar señales obligatorias. Si el cálculo alcanzaría un
irreversible de S o I sin la oportunidad observada exigida por la Puerta A, el
estado queda en FADING y el mundo conserva la tensión sin ejecutar la muerte.
La versión y resultados intermedios del catch-up quedan en el event log.

### 17.4 Capítulos

Un capítulo:

- tiene seed y configuración;
- empieza con encarnaciones identificadas;
- conserva su log;
- puede quedar sellado;
- nunca se sobreescribe para ocultar una muerte.

Un capítulo nuevo requiere una decisión explícita del autor. No es “new game” automático.

---

## 18. Seguridad y despliegue

### 18.1 Fronteras

- Web público en Vercel.
- Observadores públicos en modo read-only.
- Gestos de Isa detrás de capacidad firmada y revocable.
- Servicio de mundo en infraestructura administrada.
- Base de datos privada con acceso mínimo.
- Servicio de voz privada que inicia pull saliente autenticado; sin puerto de bóveda público.
- Diagnósticos protegidos.

### 18.2 Secretos

- solo en gestores de secretos;
- nunca en repositorio;
- nunca en bundle del cliente;
- nunca en prompts delegados;
- nunca en capturas o logs;
- rotación documentada.

### 18.3 Privacidad

- inventario de datos;
- clasificación de sensibilidad;
- política de retención;
- borrado verificable;
- logs sin contenido del corpus;
- eventos, snapshots y colas sin contenido del corpus;
- exportación pública revisada;
- consentimiento explícito para cualquier fuente íntima.

### 18.4 Disponibilidad

- health de proceso no equivale a mundo avanzando;
- readiness comprueba tick reciente y persistencia;
- watchdog detecta tick congelado;
- backup y restore se prueban;
- la caída del servicio privado no tumba la URL;
- el frontend tiene estados de reconnect y espera honestos.

### 18.5 Observabilidad

Métricas mínimas:

- tick actual y drift;
- tiempo de paso;
- cola de persistencia;
- edad del último snapshot;
- clientes conectados;
- lag de broadcast;
- resyncs;
- gestos aceptados y rechazados;
- cola narrativa;
- tasa de momentos;
- errores por versión.

Los dashboards no son parte de la experiencia pública.

---

## 19. Plan de reconstrucción por puertas

Cada fase termina en una URL desplegada. No se avanza por cantidad de módulos.

### Pre-fase — Registro de Puerta A y repositorio limpio

- Se crea el ADR de Puerta A con mortalidad, desconexión, causas y constelación.
- Si Steven aún no firma, sus cuatro decisiones quedan explícitamente pendientes.
- Se crea repositorio nuevo con AGENTS.md propio.
- Se importa esta biblia y solo la allowlist de la sección 0.
- Se define observer frente a isa antes de cualquier gesto.

**Puerta de salida:** no quedan decisiones de autor disfrazadas de defaults
técnicos. La Fase 0 puede avanzar con pendientes; la Fase 1 exige la firma.

### Fase 0 — La puerta

**Objetivo:** Isa puede abrir una URL móvil bonita y fiable.

Incluye:

- landing;
- carta breve;
- entrada;
- control de sonido;
- escena estática diseñada;
- CI y preview;
- observación en móvil real.

**Puerta de salida:** se entiende que es una carta y no una demo técnica.

### Fase 1 — Dos cuerpos vivos

**Objetivo:** S e I son reconocibles y legibles durante diez minutos sin texto.

Incluye:

- mundo finito;
- cámara;
- movimiento;
- homeostasis mínima;
- dos políticas diferenciadas;
- interacción corporal;
- protocolo;
- persistencia básica.

**Puerta de salida:** una persona puede describir por qué cada uno actuó.

### Fase 2 — Tiempo, hogar y ausencia

**Objetivo:** cerrar y volver tiene significado.

Incluye:

- día y noche;
- lugares semánticos;
- snapshots y eventos;
- catch-up;
- diario de retorno;
- estados de conexión honestos.

**Puerta de salida:** reiniciar servicios y volver no rompe continuidad.

### Fase 3 — Un mundo alrededor

**Objetivo:** S e I viven en una vecindad, no en un vacío.

Incluye:

- 12 a 24 habitantes;
- refugio y recursos;
- rutinas;
- eventos sociales;
- proyección visual jerárquica.

**Puerta de salida:** al menos un cambio colectivo altera una decisión de S o I.

### Fase 4 — Memoria y voz reales

**Objetivo:** el pasado real modifica el presente con privacidad.

Incluye:

- pipeline;
- bóveda pública;
- procedencia;
- recuperación;
- test con y sin memoria;
- voz plantillada;
- enriquecimiento privado opcional.

**Puerta de salida:** una memoria autorizada cambia acción y puede auditarse.

### Fase 5 — Agencia, momentos y riesgo

**Objetivo:** cerrar el ciclo emocional completo.

Incluye:

- motivación dominante;
- episodios;
- economía de momentos;
- estados de desconexión;
- reparación;
- Discovery;
- muerte irreversible del capítulo.

**Puerta de salida:** replay demuestra causa, señal, oportunidad y consecuencia.

### Fase 6 — Sociedad profunda, un sistema cada vez

Orden sugerido:

1. cuidado;
2. intercambio;
3. parentesco;
4. ritual;
5. norma;
6. conflicto;
7. gobierno.

Cada sistema debe superar la regla de admisión.

### Fase 7 — Escala

Solo después:

- regiones;
- chunks;
- LOD sistémico;
- mundo distante agregado;
- población grande;
- aceleración especializada si las métricas lo justifican.

GPU no es objetivo de producto.

---

## 20. Matriz de verdad

Toda capacidad mantiene uno de estos estados:

| Estado | Significado |
|---|---|
| Designed | Existe contrato y criterio de aceptación |
| Implemented | Hay código aislado y tests |
| Integrated | Está en el runtime autoritativo y protocolo |
| Observed | Se vio funcionar en una ejecución real |
| Shippable | Funciona en deploy, móvil, persistencia y fallo |

Ejemplo:

| Capacidad | Designed | Implemented | Integrated | Observed | Shippable |
|---|---:|---:|---:|---:|---:|
| Homeostasis cambia la pose | ✓ | ✓ | ✓ | ✓ | pendiente |
| Recuerdo cambia decisión | ✓ | ✓ | pendiente | pendiente | pendiente |
| Muerte persiste tras reload | ✓ | pendiente | pendiente | pendiente | pendiente |

No usar “completado” como sexto estado ambiguo.

---

## 21. Puertas de validación

### 21.1 Código

- typecheck;
- lint;
- tests unitarios;
- tests de integración;
- build de producción;
- migraciones arriba y abajo cuando sea seguro;
- diff sin secretos ni binarios accidentales.

### 21.2 Simulación

- determinismo con seed;
- invariantes de homeostasis;
- pruebas de desconexión y reparación;
- muerte irreversible;
- restart y replay;
- catch-up;
- carga sostenida;
- tick no congelado.

### 21.3 Protocolo

- snapshot inicial;
- deltas ordenados;
- hueco de secuencia;
- resync;
- reconnect;
- cliente lento;
- compatibilidad de versión;
- payload público sin campos privados.
- observer no puede emitir gestos;
- token mágico de un uso, expiración y revocación;
- dos pestañas isa según política;
- bot y replay de nonce rechazados.

### 21.4 Corpus

- conteos reproducibles;
- procedencia;
- muestra revisada;
- exclusión de terceros;
- no filtración al cliente;
- recuperación relevante;
- test con y sin memoria;
- fallback sin servicio privado.

### 21.5 Visual

- escritorio;
- 360×800, 390×844 y 430×932;
- portrait y landscape;
- Safari móvil real además de emulación;
- orientación vertical;
- zoom de texto;
- contraste;
- safe areas;
- objetivos táctiles de al menos 44×44 px;
- ninguna acción esencial dependiente de hover, wheel o teclado;
- pan con un dedo y pinch zoom si la cámara los admite;
- reduced motion;
- S e I localizables;
- lectura sin sonido;
- captura y revisión con ojos humanos.

### 21.6 Emocional

Sesión ciega con alguien que no conoce la arquitectura. Preguntar:

- ¿Quiénes son las dos figuras importantes?
- ¿Qué quería cada una?
- ¿Qué cambió?
- ¿Sentiste que elegían?
- ¿Algo pareció falso o demasiado explicado?
- ¿Te dio curiosidad volver?

Si la respuesta exige explicar el backend, la experiencia no está lista.

### 21.7 Producción

- URL limpia;
- HTTPS;
- cold start aceptable;
- mundo avanza;
- persistencia;
- backup;
- monitor;
- recuperación;
- costo conocido;
- runbook;
- servicio local apagado sin caída total.

Presupuestos iniciales que deben confirmarse en la Fase 0:

| Métrica | Objetivo inicial |
|---|---:|
| LCP móvil p75 en 4G | ≤ 2,5 s |
| Escena interactiva tras entrar, warm | ≤ 3 s |
| FPS móvil p95 durante escena normal | ≥ 50 |
| Latencia gesto aceptado p95 | ≤ 250 ms |
| Reconnect con snapshot p95 | ≤ 3 s |
| Drift del tick sostenido | < 5 % |
| Disponibilidad mensual del mundo | ≥ 99,5 % |
| Error de protocolo sin recuperación | 0 |

El costo mensual máximo no se inventa: Steven lo firma en la Puerta A o en un
ADR de infraestructura antes de elegir proveedor. Si una arquitectura excede
ese techo, se reduce escala antes de sacrificar disponibilidad.

---

## 22. Errores históricos que no se repiten

1. Construir cinco sistemas antes de ver uno completo.
2. Confundir tests verdes con experiencia viva.
3. Declarar integración porque un archivo importa otro.
4. Permitir defaults cosméticos que simulan un pilar.
5. Ocultar dependencias faltantes con fallbacks silenciosos.
6. Hacer que el LLM decida movimiento o tick.
7. Generar texto a una frecuencia que destruye el silencio.
8. Usar corpus sintético mientras se anuncia corpus real.
9. Enviar estructuras distintas por JSON y binario.
10. Optimizar GPU antes de medir el cuello de botella extremo a extremo.
11. Aumentar población para resolver falta de vida.
12. Añadir chunks antes de resolver cámara y foco.
13. Mezclar diagnósticos con UI pública.
14. Hacer de Isa la responsable de mantenerlos vivos.
15. Revivir con reload.
16. Perder estado corrupto creando un mundo nuevo sin avisar.
17. Mantener dos runtimes como dos fuentes de verdad.
18. Describir versiones de framework distintas de las instaladas.
19. Colocar documentos aspiracionales por encima de observación.
20. Introducir secretos o conversaciones en logs.
21. Hacer que toda emoción sea una barra.
22. Tratar más eventos como más narrativa.
23. Dejar que la sociedad quite a S e I el centro de la carta.
24. Llamar “emergencia” a una respuesta aleatoria decorada.

---

## 23. Catálogo de ideas: conservar, adaptar, aparcar o eliminar

| Idea histórica | Decisión | Forma nueva |
|---|---|---|
| S e I como centro | Conservar | Prioridad absoluta de cámara, agencia y momentos |
| Círculo y cuadrado | Adaptar | Siluetas corporales diferenciadas |
| Resonancia | Conservar | Estado relacional visible, sin barra pública |
| Muerte | Conservar | Muerte de encarnación y capítulo sellado |
| Revival | Eliminar | Solo capítulo nuevo explícito |
| Grace period | Adaptar | Señales y oportunidad de reparación |
| Activity inertia | Conservar | Intenciones persistentes, no cambio aleatorio por tick |
| Feed, Play, Comfort | Adaptar | Gestos limitados de cuidar, llamar, abrigar y recordar |
| Hogar y patio | Conservar | Lugares semánticos que activan hábitos y recuerdos |
| Día y noche | Conservar | Ritmo de 30 minutos configurable |
| Sueños | Adaptar | Raros, causales y con presupuesto |
| Estaciones y clima | Adaptar | Cambian rutina y cuerpo; ritmo separado del demográfico |
| Momentos | Conservar | Solo episodios de alto valor |
| Diario de regreso | Conservar | Derivado del event log |
| RAG del corpus | Conservar | Dos bóvedas, procedencia y privacidad |
| Metabolismo semántico | Adaptar | Consolidar y olvidar por relevancia; nunca borrar procedencia |
| Scar de voz | Adaptar | Una consecuencia rara y persistente del historial, no un filtro cosmético |
| Voz generativa | Adaptar | Asíncrona, opcional y subordinada a intención |
| Constellation | Aparcar | Universo futuro, no MVP público |
| Microagentes | Adaptar | 12 a 24 vecinos baratos y legibles |
| Campos sistémicos | Adaptar | Solo si producen consecuencias perceptibles |
| Economía | Aparcar | Introducir después de cuidado e intercambio simple |
| Genealogía | Aparcar | Solo si un capítulo largo la necesita |
| Animales | Aparcar | Ambiente después del vínculo y vecindad |
| Gobernanza | Aparcar | Fase social tardía |
| Rituales | Conservar después | Primer sistema cultural candidato |
| Conocimiento y recetas compartidas | Aparcar | Entra cuando una transmisión cambie una acción de S o I |
| Favor divino | Adaptar | Huella limitada de cuidado de Isa |
| Mundo infinito | Aparcar | Fase de escala |
| GPU | Aparcar | Solo tras profiling extremo a extremo |
| Event log | Conservar | Fuente de hechos |
| Snapshots | Conservar | Recuperación y continuidad |
| Replay determinista | Conservar | Prueba de causalidad |
| MessagePack | Aparcar | Solo por medición y con test de paridad |
| Dashboard público | Eliminar | Diagnóstico protegido |
| Discovery | Conservar | Conducta y línea breve, sin afirmar conciencia |
| Proto-autopoiesis | Conservar como marco | Nombre honesto para circuitos que regeneran memoria/homeostasis |
| φ-proxy | Adaptar | Test de ablación causal; nunca medida de conciencia |
| Landing/carta | Conservar | Puerta emocional móvil |
| “Mientras miras, viven” | Corregir | Viven siempre; mirar transforma suavemente |

---

## 24. Decisiones reservadas al autor

El agente puede avanzar con decisiones reversibles de Fase 0. Las decisiones de
la Puerta A no se asumen: pertenecen a Steven y necesitan firma explícita.

1. Qué material exacto del corpus está autorizado.
2. Qué nombres públicos usan S e I.
3. Si las encarnaciones de S e I son mortales o inmunes.
4. Si la desconexión mata a ambas, a una o a ninguna.
5. Qué otras causas de muerte están permitidas.
6. Si la constelación aparece en la primera entrega.
7. Si la muerte puede ocurrir antes de que Isa haya visto las señales.
8. Si se permitirá crear un segundo capítulo.
9. Qué frase abre la puerta.
10. Qué recuerdos son demasiado íntimos incluso redactados.
11. Qué grado de semejanza visual o biográfica se busca.
12. Si Isa puede dejar texto libre o solo gestos.
13. Quién puede acceder a diagnósticos y bóveda privada.
14. Cuál es el techo mensual de infraestructura.

Default seguro:

- privacidad máxima;
- público anónimo de solo lectura;
- cero citas literales sin consentimiento por persona;
- gestos estructurados;
- muerte solo después de señales observables acumuladas;
- un capítulo;
- sin constelación explícita;
- nombres S e I.

---

## 25. Prompt maestro para el agente que reconstruya

Copiar desde aquí:

~~~text
Vas a reconstruir “Una Carta Para Isa” desde cero.

Tu fuente propuesta de producto, narrativa y arquitectura es:
docs/RECONSTRUCCION_DESDE_CERO.md

La Puerta A firmada y sus ADR son la autoridad para mortalidad, desconexión,
constelación y causas de muerte. Si no están firmados, no asumas esos puntos.

Objetivo final:
Steven puede enviar una URL pública a Isa. En móvil, ella entra a un mundo vivo,
reconoce a S e I, observa decisiones autónomas, descubre recuerdos autorizados
de su historia y entiende que el vínculo tiene consecuencias persistentes.

Reglas:
1. Lee la biblia completa antes de editar.
2. Crea un repositorio limpio con AGENTS.md propio; no copies el runtime viejo.
3. Completa o solicita la Puerta A antes de la Fase 1.
4. Trabaja por fases verticales desplegables.
5. S e I siempre son el centro perceptivo.
6. La ausencia de Isa no causa degradación.
7. Aplica la mortalidad firmada; una muerte autorizada no revive al recargar.
8. El público es read-only; solo una sesión isa firmada produce gestos persistentes.
9. El mundo autoritativo debe funcionar sin GPU ni servicio LLM local.
10. El corpus privado nunca llega al navegador, eventos, snapshots ni logs remotos.
11. El LLM realiza voz; no controla el tick ni el movimiento.
12. JSON primero. Escala e infinito después.
13. Toda capacidad pasa por Designed, Implemented, Integrated, Observed y Shippable.
14. No declares listo sin typecheck, tests, build, persistencia, navegador y móvil.

Empieza por:
- confirmar el alcance de la Fase 0;
- verificar la Puerta A y las instrucciones del repositorio nuevo;
- proponer el árbol mínimo;
- registrar decisiones técnicas;
- desplegar una puerta funcional;
- presentar evidencia real y la matriz de verdad.

Antes de agregar un sistema, demuestra:
cambio sistémico → percepción de S o I → decisión distinta →
consecuencia persistida → presentación legible.

Si encuentras una contradicción con documentos históricos, esta biblia prevalece.
Si la contradicción afecta privacidad, muerte, corpus o identidad, detente y pide
decisión del autor.
~~~

Fin del prompt.

---

## 26. Fuentes de la arqueología

### Fuentes vigentes consultadas

- .claude/CLAUDE.md
- README.md
- PENDIENTE.md
- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/concepts/four-pillars.md
- docs/concepts/social-simulation-pivot.md
- docs/concepts/constellation-polyamorous.md
- docs/concepts/autopoiesis-implemented.md
- docs/concepts/phi-proxy-measure.md
- docs/CARTA_MOMENTOS_18_MAYO.md
- manifiestos y documentos de voice, landing, moments y society
- inventarios de legacy
- runtime, protocolo, renderer, scripts y configuración actuales

### Fuentes históricas recuperadas mediante Git

- tag pre-pivot-haiku
- tag backup-with-workflows
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/00-RESUMEN-MAESTRO.md
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/REPORTE-FINAL.md
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/CRITICA-OJOS-PROPIOS.md
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/05-agencia-conceptual.md
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/06-legacy-vs-actual.md
- 7a7652c:docs/reviews/DIAGNOSTICO_24_MAYO/18-movil-a11y.md
- 152e679:docs/CANVAS_REDESIGN_18_MAYO.md
- commits representativos indicados en la cronología

### Criterio de síntesis

Cuando dos documentos discreparon se priorizó:

1. la intención emocional central;
2. una consecuencia observable;
3. privacidad y seguridad;
4. continuidad real;
5. la evidencia de ejecuciones y revisiones;
6. menor complejidad compatible con los cuatro pilares.

---

## 27. Definición final de terminado

El proyecto está terminado para su primera entrega cuando:

- existe una URL pública estable;
- abre bien en un móvil real;
- la puerta se siente como una carta;
- S e I se reconocen en menos de treinta segundos;
- ambos tienen cuerpo, necesidades y políticas distintas;
- una memoria autorizada modifica al menos una decisión;
- el vínculo puede tensarse, repararse y cumplir la consecuencia irreversible firmada en la Puerta A;
- recargar no cambia la verdad;
- cerrar y volver produce continuidad y diario;
- Isa puede intervenir sin controlar;
- la sociedad crea al menos una consecuencia legible;
- el mundo sigue vivo sin LLM local;
- el corpus privado no sale de su frontera;
- los fallos se degradan con honestidad;
- tests, build, replay, persistencia, móvil y deploy están verificados;
- no hay paneles técnicos en la experiencia pública;
- una persona externa entiende el vínculo sin explicación arquitectónica.

La prueba final no es el número de agentes, mensajes, módulos, chunks o tests.

La prueba final es esta:

**Steven puede enviar el enlace sin añadir “todavía le falta”.**
