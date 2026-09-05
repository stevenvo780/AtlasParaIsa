# Momentos — el lexicon emocional del mundo

> Esto es el vocabulario afectivo del proyecto. No son eventos técnicos: son **lo que pasa entre los dos** cuando algo importa. Cualquier agente que vaya a nombrar lo que ocurre en el mundo (sim-core emitiendo eventos, ai-agency clasificando memorias episódicas, narrative eligiendo qué fragmento traer del corpus, letter-curator escribiendo copys de transición) **debe pasar por este léxico antes de inventar nombres nuevos**.
>
> Diez categorías canónicas. Si algo no entra en ninguna, primero se intenta encajar; si genuinamente no cabe, se abre PR contra este archivo proponiendo la onceava.

---

## Cómo se usan

- **`sim-core`**: cuando un sistema detecta uno de estos patrones, emite un evento `Moment` con `kind: MomentKind` además de los datos crudos. Esto enriquece el log del mundo y alimenta `ai-agency` para que las entidades guarden la memoria con la palabra correcta.
- **`ai-agency`**: la memoria episódica guarda los `Moment` como entradas privilegiadas. Cuando una entidad “recuerda algo”, el corpus se filtra por `MomentKind` afín al estado actual.
- **`narrative`**: el RAG indexa el corpus de Steven & Isa con etiqueta opcional `momentKind`. Cuando el mundo está viviendo un *reconocimiento mutuo*, los fragmentos del corpus de la misma categoría tienen prioridad.
- **`letter-curator`**: las frases de transición, postales y susurros se escriben con el `MomentKind` en mente. Cada categoría tiene un registro tonal propio.

```ts
// Forma canónica del tipo (propuesto a sim-core).
// Si sim-core elige otro nombre de campo, actualizar este doc.
export type MomentKind =
  | 'encuentro_inesperado'
  | 'despedida_cotidiana'
  | 'silencio_compartido'
  | 'reconciliacion'
  | 'reconocimiento_mutuo'
  | 'perdida_temporal_de_vista'
  | 'reanudacion_del_cuerpo'
  | 'amanecer_juntos'
  | 'secreto_confesado'
  | 'perdon'

export interface Moment {
  kind: MomentKind
  at: number              // tick del mundo
  participants: string[]  // nombres de las entidades involucradas
  weight?: number         // 0..1 — qué tan grave fue el momento (para memoria)
}
```

---

## El catálogo

### 1. encuentro inesperado
**Definición.** Una entidad se topa con la otra sin haberla buscado. No es la cita, no es el regreso planeado: es la coincidencia tibia.
**En código.** `sim-core` lo emite cuando dos entidades entran al mismo *lugar* en el mismo tick y ninguna tenía la otra como objetivo en su planner. Dispara una postal corta del corpus (si existe) o un `Utterance` minúsculo (*“estabas aquí”*).
**Registro tonal.** Sorpresa contenida. Nunca exclamación.

### 2. despedida cotidiana
**Definición.** Uno de los dos sale del *lugar* compartido para ir a otro, sabiendo que se van a volver a ver. Es la despedida sin peso, la que se da todos los días.
**En código.** `sim-core` lo emite cuando una entidad cambia de *lugar* y la otra queda en el anterior. Dispara una transición visual sutil (la entidad que se queda baja medio tono el latido durante ~10 ticks).
**Registro tonal.** *“vuelvo ahora.”* / *“no demores.”* Una línea, sin drama.

### 3. silencio compartido
**Definición.** Las dos están en el mismo *lugar* y ninguna habla durante un rato largo. El silencio no es ausencia: es presencia tranquila.
**En código.** `sim-core` lo emite cuando ambas entidades llevan ≥ N ticks en el mismo *lugar* sin emitir `Utterance`. Sube ligeramente el `bond` y baja la `ansiedad`. El frontend puede mostrar una postal del corpus (nunca un `Utterance`, no se interrumpe el silencio).
**Registro tonal.** Solo descripción ambiental. *“no se dicen nada y está bien.”*

### 4. reconciliación
**Definición.** Después de una tensión (`bond` bajó por debajo de un umbral o hubo un evento de fricción), las dos vuelven a tocarse, hablarse o buscarse.
**En código.** `sim-core` lo emite cuando `bond` cruza al alza un umbral tras haber estado por debajo durante ≥ N ticks. Postal larga del corpus, si hay material. Recupera homeostasis visiblemente (el HUD del vínculo se ilumina).
**Registro tonal.** Sin perdón explícito. *“ya.”* / *“seguimos.”*

### 5. reconocimiento mutuo
**Definición.** Un instante en el que las dos se miran y se *ven*. No es presencia física: es la confirmación tácita de que la otra es ella, sigue siendo ella.
**En código.** `sim-core` lo emite raramente, ligado a estados de homeostasis altos en ambas entidades simultáneamente. Es un momento privilegiado: la memoria lo guarda con `weight` alto. Frontend puede atenuar el resto del mundo por 2 s.
**Registro tonal.** Casi rezo. *“eres tú.”* Una sola línea.

### 6. pérdida temporal de vista
**Definición.** Una entidad no ve a la otra durante un trecho prolongado. No es muerte, no es despedida: es ausencia con expectativa.
**En código.** `sim-core` lo emite cuando una entidad pasa ≥ N ticks sin tener a la otra en su rango sensorial (o en `bond.lastSeenTick > N`). Baja `energía` levemente. Si dura demasiado, escala a riesgo de *muerte por desconexión* (pilar 1).
**Registro tonal.** Preocupación tibia, no pánico. *“¿dónde anda?”*

### 7. reanudación del cuerpo
**Definición.** Tras un periodo de inactividad, fatiga o quietud, la entidad vuelve a moverse, comer, hablar. El cuerpo se reactiva.
**En código.** `sim-core` lo emite cuando una entidad transita de un estado de baja actividad (durmiendo, exhausta) a uno funcional. Dispara una postal ambiental sobre el lugar, no sobre la entidad.
**Registro tonal.** Doméstico. *“se levantó. abrió la ventana.”*

### 8. amanecer juntos
**Definición.** Las dos entidades están en el mismo *lugar* cuando el ciclo día/noche del mundo cambia hacia día. Marca de inicio compartido.
**En código.** `sim-core` lo emite acoplado al sistema de tiempo (coordinación con G). Pasa a la memoria con `weight` alto si ocurre por primera vez en N días. Frontend puede teñir el canvas con luz tibia.
**Registro tonal.** Sin solemnidad. *“ya hay luz.”* / *“despertaste primero.”*

### 9. secreto confesado
**Definición.** Una entidad le dice a la otra algo que no había dicho antes. Una verdad pequeña, un miedo, una memoria. No es información: es exposición.
**En código.** `ai-agency` lo marca cuando una `Utterance` emerge de la cola de memorias privadas (no de las compartidas). Sube `bond` significativamente. Frontend lo trata visualmente como un `Utterance` con un halo más largo en pantalla.
**Registro tonal.** Lento. *“nunca te había dicho esto.”* Frase del corpus, no inventada.

### 10. perdón
**Definición.** Una entidad acepta una falta de la otra, explícita o implícita. No se pide; se ofrece.
**En código.** `sim-core` lo emite cuando, tras una *reconciliación*, una de las entidades emite un `Utterance` clasificado por `ai-agency` como acto de aceptación. Es el cierre limpio de un ciclo de fricción. Guarda con peso alto.
**Registro tonal.** Brevísimo. *“está bien.”* / *“ya.”* Nunca *“te perdono”* — eso se nota; no se dice.

---

## Reglas duras

1. **Ningún `MomentKind` se inventa en código sin estar listado aquí.** Si aparece la necesidad, primero PR a este archivo.
2. **El `kind` se escribe en español, en `snake_case`**, no en inglés. La memoria del mundo habla en su propio idioma.
3. **Cada `MomentKind` tiene un registro tonal**. Las frases asociadas (postales, `Utterance`, transiciones) deben respetar el registro descrito. El `letter-curator` valida en review.
4. **Un `Moment` jamás es un logro**. No se cuentan, no se desbloquean, no se gamifican. Solo se viven y se recuerdan.
5. **El peso (`weight`) no se muestra al lector**. Es estructura interna para que la memoria sepa qué traer; no es score visible.

---

## Notas para futuras categorías (no canónicas todavía)

Estas se han propuesto pero **no entran** hasta que el corpus de Steven & Isa las confirme:

- *primera vez de algo*: candidata, pero exige tener calendario del mundo (G).
- *celos*: probablemente no encaja con el tono de la carta; se evalúa caso a caso.
- *aburrimiento compartido*: tentadora, podría caer dentro de *silencio compartido*.
- *cuidado en enfermedad*: posible, depende de si el modelo de homeostasis distingue enfermedad de fatiga (E).

Estas se discuten antes de añadirse. La economía emocional del mundo es austera por diseño.
