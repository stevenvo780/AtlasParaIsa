# Operator Guide — Corpus Ingestion

This guide is for Steven. It walks through how to export your WhatsApp chat history with Isa, validate the file, and run the full ingestion pipeline that feeds the world.

Everything stays on your machine. Nothing leaves. The embeddings run on your RTX 2060. The `data/` directory is gitignored so the corpus can never be accidentally committed.

---

## Step 0 — Prerequisites

Make sure the inference service is running:

```
docker compose up inference-embed
```

You can verify it is alive:

```
curl http://localhost:8082/health
```

Expected response: `{"status":"ok"}` (or similar). If it fails, check `docker/compose.yaml`.

---

## Step 1 — Export WhatsApp chat

### Android

1. Open the chat with Isa.
2. Tap the three dots (top right) → **More** → **Export chat**.
3. Select **Without media** (the file will be much smaller).
4. Share the `.txt` file to yourself (e.g. via email, Drive, or cable transfer).

### iOS

1. Open the chat with Isa.
2. Tap the name at the top → **Export Chat**.
3. Select **Without Media**.
4. AirDrop the `.txt` file to your Mac, then scp/rsync to your Linux machine.

### File naming

Name the file something clear before placing it:

```
whatsapp-steven-isa.txt
```

If you have multiple exports (one per year, etc.), prefix with a number so they process in order:

```
01-whatsapp-2019-2020.txt
02-whatsapp-2021-2022.txt
03-whatsapp-2023-2024.txt
```

---

## Step 2 — Place the file

Copy the file(s) into:

```
data/raw/whatsapp/
```

From the repository root:

```
mkdir -p data/raw/whatsapp
cp ~/Downloads/whatsapp-steven-isa.txt data/raw/whatsapp/
```

Verify it is gitignored (it must NOT appear in git status):

```
git status
```

If `data/` appears in the output, do NOT stage or commit it. Check that `.gitignore` contains `data/`.

---

## Step 3 — Validate (run this first)

```
tsx scripts/narrative/validate.ts data/raw/whatsapp/whatsapp-steven-isa.txt
```

This reads the file and reports:

- Detected encoding (must be UTF-8)
- Format confidence (must be `whatsapp`, ideally >= 90%)
- Number of turns and speakers
- Any malformed lines (with line numbers)
- Estimated embedding time

**Example output:**

```
Corpus Validator — Una Carta Para Isa
────────────────────────────────────────────────────────────
File     : /datos/repos/CartaParaIsa/data/raw/whatsapp/whatsapp-steven-isa.txt
Size     : 12.40 MB (13,004,800 bytes)
Lines    : 227,463

Encoding:
  OK    UTF-8 (no invalid byte sequences detected)

Format detection:
  OK    Format: whatsapp (confidence: 97%)
         Sample match: [14/02/19, 20:30:01] Steven: Hola mi amor, ¿cómo estás?

Content validation:
  OK    22,746 conversational turns detected
  OK    2 speakers: Steven, Isa
  OK    No malformed lines found

Embedding cost projection:
         Estimated conversation windows : ~2,274
         Embed batches (32/batch)        : ~72
         Estimated embed time            : ~1s (~0.0 min)
         (CPU parse + segment time: typically < 30s for 227k lines)
```

If validate reports malformed lines, note the line numbers. The parser will silently skip them — they are typically system messages or export artifacts and are harmless unless there are thousands.

---

## Step 4 — Dry run

Before writing anything, do a dry run to confirm the stats look right:

```
tsx scripts/narrative/ingest.ts data/raw/whatsapp/whatsapp-steven-isa.txt --dry-run
```

This parses the entire file, segments it into conversation windows, scans for PII, and prints a full report — but writes nothing to disk and makes no HTTP calls.

Check:
- Turn count matches what validate reported
- Both speakers are detected (Steven and Isa, not phone numbers or "You")
- No unexpected PII warnings, or you understand what was flagged
- The estimated embedding time is acceptable (typically 1–5 minutes for 227k lines)

---

## Step 5 — Full pipeline

When the dry run looks good, run without `--dry-run`:

```
tsx scripts/narrative/ingest.ts data/raw/whatsapp/whatsapp-steven-isa.txt
```

### What happens

1. **Parse** — 227k lines → individual turns (Steven/Isa/timestamp/text)
2. **PII scan** — detects phone numbers and emails; prompts you whether to redact them before embedding
3. **Segment** — groups turns into 4–20-turn conversation windows (30-min gap = new window)
4. **Embed** — sends window texts in batches of 32 to `http://localhost:8082/embed` (RTX 2060). Progress is shown every batch.
5. **Index** — stores vectors + metadata in `data/processed/embeddings/index.json`
6. **Profiles** — builds personality profiles (lexicon, rhythm, topics) and writes `data/processed/profiles/Steven.json` and `data/processed/profiles/Isa.json`
7. **Report** — writes `data/processed/ingest-report.json` with run metadata

### Expected timing

| Phase | Time estimate |
|---|---|
| Read file | < 1s |
| Parse (227k lines) | 5–15s |
| Segment | < 5s |
| Embed (~22k windows, RTX 2060) | 1–5 min |
| Profile extraction | < 30s |
| **Total** | **~5–8 min** |

The bottleneck is embedding. If the service is slow, try reducing `--batch-size` to 16.

### Output files

| Path | Description |
|---|---|
| `data/processed/embeddings/index.json` | All window vectors with metadata |
| `data/processed/profiles/Steven.json` | Steven's personality profile |
| `data/processed/profiles/Isa.json` | Isa's personality profile |
| `data/processed/ingest-report.json` | Run summary and stats |

All paths are gitignored.

---

## Options reference

```
--dry-run              Parse + segment + stats only. No embeddings written.
--format whatsapp|telegram|auto   Force format (default: auto)
--output <dir>         Output directory (default: data/processed/)
--anonymize            Redact phones/emails without prompting
--batch-size <n>       Texts per embed request (default: 32)
--embed-url <url>      Override embedding service URL
--no-cache             Disable embedding cache
```

---

## If something goes wrong

### "Format could not be detected automatically"

Your export might use a different timestamp format. Run validate first. If validate also fails, check:
- Is the file actually WhatsApp format, not a screenshot or PDF?
- Did you export "Without Media" as text?
- Try `--format whatsapp` explicitly

### "Embedding service failed"

The inference container is not running or crashed. Check:

```
docker compose ps
docker compose logs inference-embed
```

If it restarted, wait 30 seconds and try again. The service needs time to load the model into VRAM.

### "No turns were parsed"

The parser found headers but all messages were system messages (encrypted notice, media placeholders). Check that the export is from a personal chat, not a group, and that it has actual messages.

### How to reset everything

If a run went wrong and you want to start over:

```
rm -rf data/processed/
```

The corpus in `data/raw/` is untouched. Re-run from Step 4.

---

## Privacy reminders

- The corpus never leaves your machine. No cloud API is called during embedding.
- The `data/` directory is in `.gitignore`. Run `git status` before any commit to verify nothing leaked.
- The embedding service (`localhost:8082`) runs on your RTX 2060 inside Docker with no outbound network access needed.
- If you want to share debugging output with someone, use `--dry-run` — it never reads vectors or raw text into logs.
- To permanently delete the corpus from the processed data: `rm -rf data/processed/ data/raw/`

---

## Multiple export files

If you have exports split by year, pass each one separately and the pipeline appends to the same index:

```
tsx scripts/narrative/ingest.ts data/raw/whatsapp/01-2019.txt --dry-run
tsx scripts/narrative/ingest.ts data/raw/whatsapp/02-2020.txt --dry-run
# When happy:
tsx scripts/narrative/ingest.ts data/raw/whatsapp/01-2019.txt
tsx scripts/narrative/ingest.ts data/raw/whatsapp/02-2020.txt
```

(The current version rewrites the index on each run — merge support is a planned improvement.)
