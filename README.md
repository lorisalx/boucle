# Boucle

Boucle is a self-hosted chief-of-staff loop. It turns captures into tickets, runs recurring agent work, and keeps project and meeting context in a local Markdown brain.

The workflow is capture → tickets → loops → brain. SQLite stores tickets, conversations, schedules, and cost records. Markdown files remain the source of truth for project and meeting context.

> [Screenshot placeholder](docs/screenshot.png). Replace it when the neutral product tour is ready.

## Architecture

| Capability | Implementation | Local state |
|---|---|---|
| Chat and tools | Selected OpenAI-compatible HTTP provider with a local tool relay | Conversations and messages in SQLite |
| Embeddings | Selected provider embedding endpoint with lexical fallback | Model-scoped vectors in SQLite |
| Transcription | Selected provider audio transcription endpoint | Audio is sent for transcription, then the text enters capture |
| Agent loops | Vibe CLI with Boucle's MCP tools | Schedules, transcripts, and reported costs |
| Brain | Markdown project and meeting notes with hybrid search | Files under `BOUCLE_BRAIN_DIR` |

## Providers

| `BOUCLE_PROVIDER` | Services | Chat and tools | Embeddings | Transcription |
|---|---|---|---|---|
| `mistral` or unset | Mistral | Yes | Yes | Yes |
| `openai` | OpenAI, Ollama, OpenRouter, vLLM, and compatible gateways | Yes | When the endpoint exists | When the endpoint exists |

Mistral is the default. Agent loops use Vibe CLI in both provider modes.

## Quickstart

Use Node 24 or later and pnpm. The bundled demo needs one Mistral API key.

```sh
git clone https://github.com/lorisalx/boucle.git
cd boucle
cp .env.example .env
chmod 600 .env
```

Set the key in `.env`:

```dotenv
MISTRAL_API_KEY=replace_with_your_key
```

Install, build, and start Boucle:

```sh
pnpm install
pnpm --dir web install
pnpm --dir web build
node src/server.ts
```

Open `http://localhost:4419`.

## Documentation

- [Self-hosting](docs/self-hosting.md)
- [Providers](docs/providers.md)
- [Apache 2.0 license](LICENSE)
