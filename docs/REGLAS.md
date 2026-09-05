# Reglas del prototipo

Estas reglas describen `src/world/index.ts`. Son unidades de un modelo sencillo; no representan medidas biológicas ni una puntuación del amor. La memoria y las diferencias provisionales de S e I son ejemplos de diseño pendientes de la voz de Steven.

## Tiempo, paisaje y recursos

El mundo tiene **40 × 28 celdas**, catorce vecinos ficticios y S e I. Un paso representa 100 ms; un día del modelo contiene 2400 pasos, cuatro minutos. Amanecer, día, atardecer y noche aportan distinta luz. Cada sesenta segundos simulados se decide el tiempo atmosférico con un generador cuya semilla y estado se guardan.

Humedad, vegetación y alimento están entre 0 y 1 por celda. Cada diez pasos se actualizan los recursos:

- La lluvia y el agua vecina aportan humedad; evaporación y luz la reducen.
- La combinación de luz y humedad favorece vegetación; la sequedad provoca pérdidas.
- Luz, humedad y vegetación permiten regenerar alimento con una capacidad máxima. De noche no hay ese crecimiento.
- Cosechar retira alimento y una pequeña cantidad de vegetación de la celda. El gesto de sembrar introduce explícitamente hasta 0.12 de vegetación y no añade alimento.

No hay regeneración instantánea para fabricar un encuentro. No se modelan química completa, reproducción ni mortalidad; el censo se mantiene y las tensiones son reversibles.

## Cuerpos, elecciones y vínculo

Cada persona percibe hasta siete celdas de distancia. Compara explorar, comer, descansar, acercarse, acompañar, tomar espacio y compartir según sus necesidades y posibilidades locales. Una intención suele durar tres segundos, con revisión anticipada si desaparece el alimento previsto o el hambre es urgente. Cada seis pasos puede avanzar una celda por un camino de tierra; no cruza agua ni se teletransporta.

Hambre, fatiga y energía de actividad usan una escala de 0 a 1. El movimiento consume energía y aumenta fatiga; descansar recupera capacidad de actividad, condicionado por alimento y calidad del refugio. La energía representa disposición para actuar, no una magnitud termodinámica. Una persona sin alimento y con hambre máxima no recupera energía indefinidamente por descansar.

Comer cosecha como máximo 0.0035 de alimento por paso. Puede guardar un cuarto de lo cosechado en una reserva de hasta 0.25; el resto se consume. Consumir una unidad del alimento del modelo reduce hasta 4.8 unidades de hambre y recupera hasta 1.2 de energía, siempre dentro de sus cotas. Compartir consume 0.025 de reserva del donante, reduce hasta 0.12 de hambre del receptor y recupera hasta 0.03 de su energía; el donante paga un pequeño coste de actividad.

S e I pueden buscar cercanía o necesitar espacio. Un encuentro requiere proximidad y acciones compatibles de ambos; alguien que está explorando o comiendo no recibe automáticamente efectos de compañía porque el otro se acerque. Una pausa compartida puede aliviar fatiga y recuperar algo de actividad, sin crear alimento. Compartir tiempo también puede llevar a tomar espacio. Estar lejos no produce por sí solo un castigo afectivo, y cerrar el navegador no entra en estas reglas.

## Memoria y costumbre

Los cinco recuerdos iniciales están marcados como **ejemplos sintéticos**. Se activan por lugar y contexto: por ejemplo, un compañero cansado cerca del claro puede hacer que acompañar resulte más atractivo. Un recuerdo irrelevante no aumenta puntuaciones. Recordar desde la interfaz refuerza temporalmente una posibilidad contextual; no impone acción ni reconciliación.

Una costumbre nace al presenciar **dos acciones útiles de compartir** cerca de un lugar. Cada observador guarda quién actuó, para quién, en qué paso y con cuánto alimento. Luego puede repetir la conducta y volver al lugar si percibe una oportunidad útil. El lugar no adquiere una tradición por un temporizador. Los contadores de uso aumentan cuando ocurre cuidado real.

Cada persona conserva hasta ocho experiencias y tres hábitos. Cada hábito retiene dos evidencias iniciales, aunque los hechos antiguos salgan de la crónica reciente, limitada a 120 eventos. El registro persistente de hechos y entradas del servidor es independiente de esta ventana visible y puede crecer con el uso; no se acredita almacenamiento ilimitado ni una política de retención para biografía real.

El interruptor interno `learningEnabled` permite un experimento: desactivar aprendizaje conserva las mismas acciones de compartir, pero elimina la transmisión por observación. Las pruebas verifican tanto una escena causal controlada como la población autónoma con tres semillas, incluyendo efectos sobre S e I.

## Tres gestos y una única verdad

Sembrar, invitar y recordar tienen tres segundos de separación dentro del mundo. Se validan celda, tipo y contexto. Una invitación dura treinta segundos simulados y solo la perciben personas cercanas; hambre, fatiga y necesidad de espacio pueden hacer que la ignoren. El recordatorio dura sesenta segundos y necesita un recuerdo disponible y su lugar.

El servidor valida sesión, formato y frecuencia, asigna paso y orden, aplica el gesto en una copia del estado y guarda antes de confirmar. Repetir un identificador con el mismo contenido devuelve el resultado guardado; reutilizarlo para otra petición se rechaza. El navegador recibe una proyección explícita y no accede al generador aleatorio ni a los hábitos internos completos.

Con el mismo estado e iguales entradas, la evolución es reproducible. La exploración usa un azar local derivado de semilla, persona y paso; elegir otra acción por memoria o aprendizaje no desplaza el azar futuro de la lluvia. Así se mantienen emparejadas las condiciones atmosféricas en los controles causales.

## Qué comprueban las pruebas

Las quince pruebas del motor ejecutadas durante su implementación contrastan disponibilidad de agua/luz/alimento/refugio, necesidades corporales, contacto mutuamente compatible, memoria pertinente frente a memoria ausente e irrelevante, transmisión frente a aprendizaje desactivado y continuidad exacta tras serializar el azar. También comprueban gestos inválidos, límites de frecuencia, procedencia conservada y seis ciclos de día/noche con cantidades y estructuras acotadas.

Estos resultados acreditan propiedades del modelo. No demuestran conciencia, una teoría general del cuidado ni que la carta tenga ya la identidad de la pareja. La revisión del contenido real y la prueba de experiencia en un teléfono físico siguen formando parte de la entrega pendiente.
