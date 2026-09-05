# Narrative corpus — input format specification

This document defines the expected format and layout for corpus files consumed by `@carta/narrative`. Steven brings the real corpus; this spec ensures the pipeline can process it without modification.

## Directory layout

```
data/
  raw/
    whatsapp/
      <any-name>.txt     # One or more WhatsApp export files
    telegram/
      result.json        # Single Telegram export (not yet implemented)
```

All paths are relative to the repository root. The `data/` tree is gitignored; nothing under it is ever committed.

## WhatsApp format

WhatsApp export files are produced via:
_Chat → (kebab menu) → More → Export chat → Without media_

### Line format

```
[DD/MM/YY, HH:MM:SS] Speaker Name: message text
```

- Date separator: `/`
- Year: 2-digit (e.g. `23` for 2023) or 4-digit (`2023`)
- Time: 24-hour `HH:MM:SS`, though AM/PM variants are also accepted
- Square brackets around the date-time block are mandatory
- Speaker name: any string that does not contain a colon
- Message: everything after the first `: ` following the speaker name
- Multi-line messages: continuation lines have no `[timestamp]` prefix and are appended to the previous turn with a newline

### System messages

The following are silently dropped by the parser:

- `<Media omitted>` (images, videos, audio)
- `Messages and calls are end-to-end encrypted.`
- Lines where the "message" part is empty after trimming

### File naming convention

Name files descriptively so they are easy to audit:

```
whatsapp-steven-isa-2019.txt
whatsapp-steven-isa-2020-2021.txt
whatsapp-steven-isa-2022-2023.txt
```

Multiple files are processed in filesystem order; if chronological order matters, prefix with a date: `01-whatsapp-2019.txt`, `02-whatsapp-2020.txt`.

### Character encoding

UTF-8. WhatsApp exports on both Android and iOS produce UTF-8 by default. Do not convert.

### Example

```
[14/02/19, 20:30:01] Steven: Hola mi amor, ¿cómo estás?
[14/02/19, 20:30:45] Isa: Bien, ¿y tú?
[14/02/19, 20:31:00] Steven: Bien también
Este mensaje tiene
tres líneas
[14/02/19, 20:32:00] Isa: <Media omitted>
[14/02/19, 20:33:00] Isa: ¿Viste la foto?
```

Produces 4 turns (the `<Media omitted>` line is dropped, the 3-line message is joined).

## Telegram format (not yet implemented)

The `parseTelegram` function in `src/ingest/telegram.ts` is a placeholder. When implemented, it will consume the JSON produced by:
_Telegram Desktop → Settings → Advanced → Export Telegram Data → JSON format_

Expected structure:

```json
{
  "name": "Chat name",
  "type": "personal_chat",
  "messages": [
    {
      "id": 1,
      "type": "message",
      "date": "2020-01-01T12:00:00",
      "from": "Speaker Name",
      "text": "message text or array of text entities"
    }
  ]
}
```

The parser must handle:
- `text` as a plain string or an array of `{ type, text }` entity objects
- `type: "service"` messages (skipped)
- Missing `text` field (skipped)

## Privacy checklist before placing corpus

- [ ] Files are placed in `data/raw/` only (never in `src/`, `tests/`, `packages/`)
- [ ] `.gitignore` is in effect for `data/` (verify with `git status`)
- [ ] Embedding service is running locally at `http://localhost:8082` (RTX 2060)
- [ ] No cloud storage sync (Dropbox, Google Drive, etc.) is active on the `data/` directory
- [ ] Backups are encrypted at rest

## Output artefacts (also gitignored)

| Path | Description |
|---|---|
| `data/embeddings/*.json` | Cached embedding vectors (sha256-keyed) |
| `data/index.db` | sqlite-vec index (TODO: implement) |
| `data/profiles/*.json` | Serialised PersonalityProfile objects |
