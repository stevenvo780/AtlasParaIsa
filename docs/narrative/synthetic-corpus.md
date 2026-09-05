# Synthetic Corpus — Una Carta Para Isa

Corpus sintético rico para validar el pipeline RAG end-to-end **sin tocar el corpus real**. Generado de forma determinista y emocionalmente plausible; NO contiene contenido íntimo real de Steven ni de Isabella.

> Estado: el corpus **real** (1,896 ventanas de las 227k líneas) ya está ingestado y activo en el RAG (ver README, pilar 2). Este corpus sintético sigue siendo útil como fixture de pruebas y para correr el pipeline en entornos donde el corpus real no debe cargarse.

---

## Estadísticas del corpus generado

| Campo | Valor |
|---|---|
| Turns generados | 10.000 |
| Hablantes | Steven, Isabella |
| Rango temporal | 2018-06-02 → 2019-03-22 (294 días) |
| Formato | WhatsApp (`[DD/MM/YY, HH:MM:SS] Hablante: mensaje`) |
| Tamaño del archivo raw | ~764 KB |
| Ventanas de conversación | 910 |
| Promedio turns/ventana | 11,0 |
| Vectores generados | 910 (768 dim, multilingual-e5-base) |
| Tamaño del índice JSON | ~19,5 MB |
| Tiempo total del pipeline | 11,6 s (RTX 2060) |

### Distribución por tipo de conversación

| Tipo | Turns | % |
|---|---|---|
| cotidiano | 2.877 | 28,8% |
| ternura | 2.012 | 20,1% |
| íntimo | 1.906 | 19,1% |
| planes | 1.186 | 11,9% |
| recuerdo | 1.043 | 10,4% |
| miedo | 529 | 5,3% |
| conflicto | 447 | 4,5% |

### Perfiles de personalidad extraídos

**Steven** — léxico característico top-5: `vida`, `hoy`, `quiero`, `amorcito`, `nenita`. Mensajes más largos (~60+ chars). Reflective register.

**Isabella** — léxico característico top-5: `también`, `jaja`, `lindo`, `noooo`, `tranquilo`. Mensajes más cortos (~38 chars avg). Registro concreto y colombiano.

---

## Cómo invocar cada script

### 1. Generar el corpus sintético

```bash
tsx scripts/narrative/generate-rich-corpus.ts \
  --turns 10000 \
  --seed 2718 \
  --out data/raw/rich-synthetic.txt
```

Argumentos:

| Flag | Default | Descripción |
|---|---|---|
| `--turns <n>` | `10000` | Número de turnos a generar |
| `--seed <n>` | `2718` | Semilla para reproducibilidad (mulberry32) |
| `--out <path>` | `data/raw/rich-synthetic.txt` | Archivo de salida |

### 2. Ingestar y embeber el corpus

```bash
tsx scripts/narrative/ingest.ts data/raw/rich-synthetic.txt
```

Opciones relevantes:

| Flag | Default | Descripción |
|---|---|---|
| `--dry-run` | off | Solo parsea y reporta stats, sin embeddings |
| `--batch-size <n>` | `32` | Textos por request al servicio de embeddings |
| `--embed-url <url>` | `http://localhost:8082` | URL del servicio GPU |
| `--output <dir>` | `data/processed/` | Directorio de salida |

Output generado:

- `data/processed/embeddings/index.json` — 910 entradas con vectores reales (768 dim)
- `data/processed/profiles/Steven.json` — perfil TF-IDF + ritmo + topics
- `data/processed/profiles/Isabella.json` — ídem
- `data/processed/ingest-report.json` — metadatos del run

### 3. Consultar el corpus por similitud semántica

```bash
tsx scripts/narrative/query-corpus.ts "te extraño"
tsx scripts/narrative/query-corpus.ts "tengo miedo de perder" --k 3
tsx scripts/narrative/query-corpus.ts "ese día en Medellín" --k 5
```

Opciones:

| Flag | Default | Descripción |
|---|---|---|
| `--k <n>` | `5` | Top-k resultados |
| `--index <path>` | `data/processed/embeddings/index.json` | Ruta al índice |
| `--embed-url <url>` | `http://localhost:8082` | URL del servicio de embeddings |

---

## Resultados de validación RAG (run real, 2026-05-17)

### Query: "te extraño"

```
[1] Score: 0.8384 | 2018-11-03 | Speakers: Steven, Isabella
  Steven: Tu voz es lo que más extraño cuando no estás.
  Isabella: Ojalá nada cambie. Así, nosotros.
  Steven: Eres la persona con quien más quiero hablar cuando pasa algo bueno o malo.
  Isabella: Yo también te extraño, mucho.
  Steven: Te extraño muchísimo hoy, amorcito. Más de lo normal.

[2] Score: 0.8352 | 2018-10-17 | Speakers: Isabella, Steven
  Isabella: Aquí también se siente raro sin ti.
  Steven: Te extraño muchísimo hoy, amorcito. Más de lo normal.
  ...
```

### Query: "tengo miedo de"

```
[1] Score: 0.8330 | 2018-09-03 | Speakers: Steven, Isabella
  Steven: ¿Tú crees que siempre vamos a estar así? ¿Bien?
  Isabella: No, no te vayas tú tampoco. Yo tampoco quiero.
  Steven: Tengo miedo de decepcionate algún día.
  Isabella: A mí también me da miedo a veces. Pero te tengo a ti.
  Steven: A veces me da miedo que el tiempo pase tan rápido...
```

### Query: "ese día en Medellín"

```
[1] Score: 0.8390 | 2018-10-31 | Speakers: Isabella, Steven
  Isabella: Uy sí, nerviosísimos. Qué tiempos.
  Steven: Acabo de pasar por el café donde tomamos chocolate en Bogotá. Me acordé de ti.
  Isabella: Nos pasamos pero estuvo rico. Qué chévere fue ese día.
  Steven: ¿Te acuerdas ese fin de semana que fuimos a Medellín? Qué chévere fue eso.
  Isabella: Ay sí, Medellín fue una nota. Tenemos que volver.
```

**Conclusión**: los fragmentos top-5 en cada query son temáticamente coherentes y no aleatorios. Los scores de similitud coseno rondan 0.83–0.84, lo que indica que el modelo multilingual-e5-base discrimina correctamente entre tipos de conversación en español colombiano. El RAG funciona end-to-end.

---

## Cómo reemplazar con el corpus real

Cuando Steven aporte las 227.463 líneas reales:

1. **Depositar el archivo en `data/raw/`** — por ejemplo `data/raw/chats-reales.txt`. El directorio `data/` está en `.gitignore`; nada se commitea.

2. **Validar el formato** antes de ingestar:
   ```bash
   tsx scripts/narrative/validate.ts data/raw/chats-reales.txt
   ```
   Confirmar que es formato WhatsApp o Telegram. Si es exportación de WhatsApp, el formato es `[DD/MM/YY, HH:MM:SS] Nombre: mensaje`. Si es Telegram, es JSON.

3. **Eliminar el corpus sintético** (no es obligatorio pero evita mezcla):
   ```bash
   rm data/raw/rich-synthetic.txt
   rm data/processed/embeddings/index.json
   rm data/processed/profiles/*.json
   rm data/processed/ingest-report.json
   ```

4. **Correr el ingest completo**:
   ```bash
   tsx scripts/narrative/ingest.ts data/raw/chats-reales.txt --anonymize
   ```
   Para 227k turns se estima ~200-500 ventanas y < 60 segundos en la RTX 2060 con batch_size=32.

5. **Verificar el resultado**:
   ```bash
   tsx scripts/narrative/query-corpus.ts "te extraño"
   tsx scripts/narrative/query-corpus.ts "ese día en Medellín"
   ```
   Los scores deben mantenerse en el rango 0.75–0.90 con fragmentos temáticamente coherentes.

6. **Notificar a `ai-agency-architect`**: el índice en `data/processed/embeddings/index.json` y los perfiles en `data/processed/profiles/` ya están disponibles para que el agente los consuma vía `retrieve(query, k)`.

---

## Nota de privacidad

- Todo el procesamiento es local. Los textos se envían únicamente a `http://localhost:8082` (RTX 2060, LAN interna).
- Ningún dato sale a OpenAI, Cohere ni ningún servicio externo.
- El directorio `data/` está en `.gitignore`. Verificar antes de cada commit: `git status`.
- Los embeddings en `index.json` son vectores numéricos: no contienen texto en claro (el texto sí está en el campo `meta.text` del mismo archivo, por eso `data/` nunca se commitea).

---

## Contrato para `ai-agency-architect`

El agente D-B puede importar directamente:

```typescript
import { retrieve } from "@carta/narrative";

// Carga el índice desde disk (data/processed/embeddings/index.json)
// y retorna top-k fragmentos para la query
const fragments = await retrieve("te siento lejos", store, { k: 5 });
// fragments[i].meta.text  → texto del fragmento
// fragments[i].score      → similitud coseno (0-1)
// fragments[i].meta.speakers → ["Steven", "Isabella"]
// fragments[i].meta.startTs  → ISO timestamp del inicio de la ventana
```

El índice se carga en `InMemoryVectorStore` al inicio del proceso. Para el corpus sintético (910 vectores) la carga es instantánea. Para el corpus real (~200-500 ventanas) igualmente.
