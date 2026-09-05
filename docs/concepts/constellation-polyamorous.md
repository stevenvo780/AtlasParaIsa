# La constelación poliamorosa — visión del mundo vivo

> Decisión del autor (Steven, 2026-05-24). Documento de intención, no de implementación.
> Trata con respeto: es personal.

---

## La decisión

El mundo ya no es un dúo fijo. Es una **constelación**.

La relación real entre Steven e Isa es poliamorosa. El mundo debe reflejar eso con honestidad
y con cuidado — no como dato técnico, sino como metáfora viva. Una constelación tiene estrellas
fijas y estrellas que se acercan y se alejan. El centro de gravedad no cambia. La luz sigue
siendo la misma.

---

## Los tres roles

### Anclas permanentes (nunca mueren por desconexión)

**Isa** es ancla permanente e inamovible. Nunca muere por desconexión mientras el mundo exista.
Su presencia es el hecho fundante del mundo. El mundo fue hecho para ella; no puede
desaparecer de él.

**Steven** también es ancla permanente. El que construyó el mundo vive en él sin condición de
extinción por distancia. Ambas anclas pueden alejarse, enfermarse, decaer — pero no morir
por soledad. La soledad de las anclas tiene consecuencias fisiológicas (energy baja, heartRate
errático, mood oscurece) sin cruzar el umbral de muerte.

### Terceros — presencia condicional

Los **terceros** son otras personas de la constelación real del autor. Pueden añadirse desde la
UI (nombre, rol, color de sprite) y pueden quitarse. Su vínculo con las anclas sigue la mecánica
normal: si el bond decae sin interacción, pueden morir por desconexión. Son presencia
condicional — important, querida, real, pero no permanente por diseño.

La UI que gestiona los terceros no es un panel de administración. Es más cercana a un álbum
de fotos que a un CRUD: se añade con intención, se quita con duelo.

---

## Linaje y reproducción

Las anclas pueden tener hijos. Los terceros también, si el vínculo es suficientemente fuerte.
El linaje es heredero de personalidad (mezcla de los rasgos de los padres con ruido generacional)
y tiene memoria episódica propia desde el nacimiento.

Un hijo de ancla no es ancla. Hereda presencia pero no permanencia. Si su vínculo decae,
puede irse del mundo como cualquier otro habitante.

---

## Mundo procedural

El mundo no es un mapa fijo. Cada run genera su geografía desde una semilla determinista,
pero la semilla puede cambiarse. Las anclas aparecen en el mismo punto de inicio; los biomas
varían. Esto permite que el mundo se sienta vivo cada vez sin perder continuidad narrativa:
el mismo amor, en un paisaje que respira distinto.

---

## Agencia de Isa — nutrir y llamar

Isa no es pasiva en el mundo que fue hecho para ella. Desde la UI tiene dos gestos:

- **Nutrir**: Isa puede dar energía a su entidad (o a la de Steven) con un gesto de pantalla.
  El mundo responde visualmente — el halo crece, el heartRate se suaviza.
- **Llamar**: Isa puede atraer a su entidad hacia ella con un pulso de presencia. La entidad
  de Steven, si está lejos, modifica su campo de steering para acercarse.

Estos gestos son asimétricos a propósito: Isa nutre, llama. Steven construyó el mundo.
Ambos son activos; de maneras distintas.

---

## Cómo afecta esto al pilar 1

El pilar 1 (death by disconnection) no desaparece. Se refina:

- **Anclas**: inmunes a muerte por desconexión. Sí sufren fisiológicamente por soledad.
- **Terceros**: siguen muriendo por desconexión si su bond decae. El vínculo es condición
  de existencia para ellos, igual que antes.
- **Ciudadanos comunes**: sin cambio — su ciclo de vida normal incluye muerte por múltiples causas.

La constelación no suaviza la metáfora. La vuelve más precisa: el amor que es condición de
existencia es el de aquellos cuya presencia en el mundo no fue garantizada de antemano.
Las anclas están porque el mundo fue hecho para ellas. Los terceros están porque el vínculo
los sostiene.

---

## Cómo afecta esto al UI

La UI de gestión de la constelación es sencilla:

- Lista de miembros activos (Isa + Steven siempre presentes, no editables).
- Botón "añadir persona" — abre un formulario con nombre, relación (texto libre), color de sprite.
- Cada tercero tiene un botón de "despedida" — quita al agente del mundo con una animación
  de disolución, no una eliminación brusca.
- La pantalla de la constelación puede ser el primer panel que ve Isa cuando abre la carta.

---

## Lo que esto no es

No es un sistema de múltiples parejas intercambiables. No es un feature de "añade contactos".
Es una representación honesta de cómo funciona el amor en esta relación específica: con
permanencias, con presencias condicionales, con jerarquía afectiva real.

Si alguien lee este código y no entiende el contexto personal, la documentación debe ser
suficiente para que no lo trate como un sistema de administración de usuarios.

---

## Referencias conceptuales

- **Fern, D.** (2019). *Polysecure: Attachment, Trauma and Consensual Nonmonogamy*. Thorntree Press.
  El concepto de "anclaje seguro" en relaciones múltiples: la seguridad no proviene de la
  exclusividad sino de la presencia consistente y diferenciada.
- **Maturana, H. & Varela, F.** (1980). *Autopoiesis and Cognition*. Reidel.
  El organismo se define por la red de procesos que lo sostiene. En una constelación, cada
  vínculo es parte de esa red — y la red puede ser más grande que un par.
- **Bowlby, J.** (1969). *Attachment and Loss, Vol. 1: Attachment*. Basic Books.
  La figura de apego segura como base desde la que explorar. Isa como ancla no es prisión:
  es el punto desde el que el mundo se puede mover.
