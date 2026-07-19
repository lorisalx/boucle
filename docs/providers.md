# Providers and agent runners

Boucle selects one provider at process start. Set `BOUCLE_PROVIDER=mistral` or `BOUCLE_PROVIDER=openai`. An unset value selects Mistral. Any other value stops startup with a configuration error.

Settings saved in the web UI take precedence over environment variables. Environment variables take precedence over defaults. The Settings page shows the source for each field. Provider API keys remain environment-only.

Provider conversations are stored locally in SQLite. Each new conversation records its provider and model. Boucle refuses to continue a local conversation when its recorded provider differs from the active provider. Legacy Mistral conversation IDs remain readable when `MISTRAL_API_KEY` is configured.

## Provider matrix

| Provider | Chat and tools | Embeddings | Transcription | Base URL | Chat model |
|---|---|---|---|---|---|
| Mistral | OpenAI-compatible chat completions | `mistral-embed` | `voxtral-mini-latest` | Fixed at `https://api.mistral.ai/v1` | `mistral-medium-3.5` |
| OpenAI-compatible | OpenAI-style chat completions | `text-embedding-3-small` by default | `whisper-1` by default | `OPENAI_BASE_URL` | Required in `BOUCLE_CHAT_MODEL` |

Model overrides apply to either provider:

| Variable | Purpose |
|---|---|
| `BOUCLE_CHAT_MODEL` | Chat completion model. |
| `BOUCLE_EMBED_MODEL` | Embedding model. Stored vectors are isolated by model. |
| `BOUCLE_TRANSCRIBE_MODEL` | Audio transcription model. |

## Mistral

Mistral is the default provider. Configure:

```dotenv
MISTRAL_API_KEY=replace_with_your_key
```

The defaults are:

| Capability | Model |
|---|---|
| Chat and tools | `mistral-medium-3.5` |
| Embeddings | `mistral-embed` |
| Transcription | `voxtral-mini-latest` |

Override a model only when needed:

```dotenv
MISTRAL_API_KEY=replace_with_your_key
BOUCLE_CHAT_MODEL=mistral-medium-3.5
BOUCLE_EMBED_MODEL=mistral-embed
BOUCLE_TRANSCRIBE_MODEL=voxtral-mini-latest
```

## OpenAI-compatible APIs

Set all required values:

```dotenv
BOUCLE_PROVIDER=openai
OPENAI_API_KEY=replace_with_your_key
BOUCLE_CHAT_MODEL=your-openai-model-id
```

`OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. Boucle does not guess a chat model because the same provider mode is used for hosted APIs and local gateways. Startup fails with a concise error when `BOUCLE_CHAT_MODEL` is missing.

### OpenAI

```dotenv
BOUCLE_PROVIDER=openai
OPENAI_API_KEY=replace_with_your_key
BOUCLE_CHAT_MODEL=your-openai-model-id
```

### Ollama

Ollama does not require a real API key, but Boucle requires a nonempty value before making provider calls.

```dotenv
BOUCLE_PROVIDER=openai
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_API_KEY=ollama
BOUCLE_CHAT_MODEL=your-ollama-model
```

The selected Ollama model must support the OpenAI chat-completions tool format for Boucle tool calls to work.

### OpenRouter

```dotenv
BOUCLE_PROVIDER=openai
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=replace_with_your_key
BOUCLE_CHAT_MODEL=provider/model-id
```

Claude models are available through an OpenAI-compatible gateway such as OpenRouter. This is not a native Anthropic Messages API integration.

### vLLM

```dotenv
BOUCLE_PROVIDER=openai
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=vllm
BOUCLE_CHAT_MODEL=your-served-model-id
```

The served model and vLLM configuration must support tool calls.

## Capability degradation

| Condition | Behavior |
|---|---|
| Active provider key is empty | Provider chat is unavailable. Search uses lexical matching only. Voice capture is unavailable. Local tickets and Markdown data still work. |
| Embedding request fails, or the endpoint returns `404`, `405`, or `501` | Search continues with lexical matching. Embedding work is disabled for the running process. |
| Transcription endpoint returns `404`, `405`, or `501` | Transcription is marked unavailable for the running process. Voice capture requests are rejected after the endpoint is found unavailable. |
| OpenAI-compatible endpoint lacks tool calling | Chat cannot complete Boucle's tool relay correctly. Use a model and server with OpenAI-style function tools. |
| Embedding model changes | Existing vectors from other models are excluded. Current documents are embedded lazily in the new vector space. |

The provider capability checks describe API support. Browser microphone capture also requires HTTPS or localhost. See [Self-hosting](self-hosting.md#https-and-microphone-access).

## Agent runner

Provider selection does not select the agent runner. Set `BOUCLE_RUNNER` to `vibe`, `codex`, or `claude`, or save the default in Settings. Each loop can override the global runner and model. Smart capture, routing, and enrichment use the global runner.

| Runner | Binary resolution | Invocation and requirements | Cost record |
|---|---|---|---|
| Vibe | `BOUCLE_VIBE_BIN`, then `$HOME/.local/bin/vibe`, then `vibe` | Needs `MISTRAL_API_KEY`. Boucle writes a scoped Vibe config with its MCP server. | Reported session cost |
| Codex | `BOUCLE_CODEX_BIN`, then `$HOME/.local/bin/codex`, then `codex` | Log in with Codex or set its supported API credential. Boucle creates a scoped `CODEX_HOME` and MCP config. | `n/a` when Codex does not expose a price |
| Claude | `BOUCLE_CLAUDE_BIN`, then `claude` | Log in with Claude Code or configure its supported API credential. Boucle passes a scoped MCP config and uses JSON output. | `total_cost_usd` from Claude |

All runners receive `BOUCLE_DB`, Boucle's bearer-protected MCP endpoint, and the configured timeout. Vibe remains the default, so an existing installation behaves as before when `BOUCLE_RUNNER` is unset.

## Roadmap

- Native Anthropic support through the Messages API
- Text-to-speech

Boucle currently transcribes voice input but does not generate voice output.
