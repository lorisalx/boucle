# Self-hosting Boucle

Boucle runs as one Node process and serves the built web application. SQLite stores operational data. A Markdown directory stores the brain.

## Prerequisites

- Node.js 23.6 or later (24 LTS recommended)
- pnpm
- Git
- About 1 vCPU for a small instance
- A provider API key for chat
- Vibe, Codex, or Claude CLI for loops, smart capture, routing, and enrichment

The bundled demo uses Mistral for provider calls and Vibe. A custom brain can use either supported provider for chat, embeddings, and transcription, and any supported agent runner. Vibe remains the default.

## Install

Clone the repository:

```sh
git clone https://github.com/lorisalx/boucle.git
cd boucle
cp .env.example .env
chmod 600 .env
```

For the bundled demo, edit `.env` and set:

```dotenv
MISTRAL_API_KEY=replace_with_your_key
```

Install dependencies and build the web application:

```sh
pnpm install
pnpm --dir web install
pnpm --dir web build
```

Start the server:

```sh
node src/server.ts
```

Boucle reads `.env` from the repository root. It listens on `http://localhost:4419` by default.

## Environment file

Boucle loads a `.env` file from the repository root at startup. The file is not required; all variables can also be passed through the process environment.

### Creating your `.env`

`.env.example` documents every supported variable with safe placeholder values. Copy it and fill in the keys you need:

```sh
cp .env.example .env
chmod 600 .env   # keep secrets off the filesystem for other users
```

`.env` is listed in `.gitignore`. Never commit it. If you fork the repository, confirm the ignore entry is still present before pushing.

### Rotating secrets

Edit `.env`, replace the value, then restart the server. For systemd:

```sh
sudo systemctl restart boucle
```

The server reloads `.env` on startup, not at runtime. Running processes keep their original values until restarted.

### Setting an auth token

When Boucle is accessible beyond localhost, protect it with `BOUCLE_AUTH_TOKEN`:

```dotenv
BOUCLE_AUTH_TOKEN=replace_with_a_long_random_token
```

Generate one with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The web application shows a token prompt when the browser has no valid session cookie. Subsequent requests use an httpOnly cookie that lasts 30 days. API clients must present the token as `Authorization: Bearer <token>`.

See [HTTPS and microphone access](#https-and-microphone-access) for serving Boucle over a secure connection, which is required for voice capture when accessed from a non-localhost address.

## Environment variables

### Core

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_PORT` | `4419` | HTTP port for the API, web application, and MCP endpoint. |
| `BOUCLE_HOST` | `127.0.0.1` | Address the HTTP server binds to. Leave as loopback for local use; set to a specific interface only when a reverse proxy or Tailscale Serve forwards traffic. |
| `BOUCLE_DB` | `$XDG_DATA_HOME/boucle/boucle.db`, or `$HOME/.local/share/boucle/boucle.db` | SQLite database path. Parent directories are created. |
| `BOUCLE_BRAIN_DIR` | Repository `fake-brain` directory | Root containing the `projects` and `meetings` directories. The default enables demo mode. |
| `BOUCLE_AUTH_TOKEN` | Empty (open) | Operator bearer token. When set, every `/api/*` request must present it as `Authorization: Bearer <token>` or as an httpOnly session cookie issued by `POST /auth`. Unset means no authentication — suitable only for localhost use. |
| `BOUCLE_MCP_TOKEN` | Generated once and stored in SQLite | Bearer token required by `/mcp`. |
| `XDG_DATA_HOME` | Empty | Base directory used for the default database path. |
| `HOME` | Process home directory | Fallback data directory and path redaction in MCP information. This normally stays inherited. |

### Identity

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_APP_NAME` | `Boucle` | Name shown in the web application. |
| `BOUCLE_OWNER_NAME` | Demo owner in demo mode, otherwise empty | Owner name used in the UI and agent prompts. |
| `BOUCLE_ORG_NAME` | Demo organization in demo mode, otherwise empty | Organization name used in the UI and agent prompts. |

Demo mode is derived from `BOUCLE_BRAIN_DIR`. It is active only when that path resolves to the bundled `fake-brain` directory.

Identity, provider, runner, model, and t3code fields can also be saved in Settings. Values saved there use `boucle_meta` and override environment variables. Environment variables override defaults. Provider API keys stay environment-only. The t3code orchestration token is the documented exception and can be saved in Settings.

### Provider

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_PROVIDER` | `mistral` | Provider selector. Accepted values are `mistral` and `openai`. |
| `MISTRAL_API_KEY` | Empty | Credential for Mistral provider calls, legacy Mistral chats, and Vibe. |
| `OPENAI_API_KEY` | Empty | Credential passed to the OpenAI-compatible provider. A nonempty value is required, including for local gateways. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL used when `BOUCLE_PROVIDER=openai`. |
| `BOUCLE_CHAT_MODEL` | `mistral-medium-3.5` for Mistral | Chat model override. It is required for the `openai` provider. |
| `BOUCLE_EMBED_MODEL` | `mistral-embed` or `text-embedding-3-small` | Embedding model override for the selected provider. |
| `BOUCLE_TRANSCRIBE_MODEL` | `voxtral-mini-latest` or `whisper-1` | Transcription model override for the selected provider. |

See [Providers](providers.md) for provider examples and degradation behavior.

### Agent runners, t3code, and budgets

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_RUNNER` | `vibe` | Default agent runner. Accepted values are `vibe`, `codex`, and `claude`. |
| `BOUCLE_VIBE_BIN` | `$HOME/.local/bin/vibe`, then `vibe` on `PATH` | Vibe executable override. |
| `BOUCLE_CODEX_BIN` | `$HOME/.local/bin/codex`, then `codex` on `PATH` | Codex executable override. |
| `BOUCLE_CLAUDE_BIN` | `claude` on `PATH` | Claude executable override. |
| `BOUCLE_LOOP_TIMEOUT_MIN` | `12` | Minutes before an agent invocation is terminated. |
| `BOUCLE_VIBE_MAX_PRICE` | `0.25` | Per-invocation Vibe price ceiling in US dollars. |
| `BOUCLE_AGENT_BUDGET_WARN` | `10` | Cumulative recorded agent spend that emits a warning. |
| `BOUCLE_AGENT_BUDGET_STOP` | `30` | Cumulative recorded agent spend that blocks new agent invocations. |
| `BOUCLE_T3CODE_URL` | Empty | t3code base URL. URL, token, and project enable the ticket action. |
| `BOUCLE_T3CODE_TOKEN` | Empty | t3code orchestration bearer token. This can also be stored in Settings. |
| `BOUCLE_T3CODE_PROJECT` | Empty | Folder or project slug where t3code ticket chats open. There is no hardcoded fallback. |

## Agent runners

The global runner applies to scheduled loops and one-shot agent work. A loop's runner field can override it. Boucle creates isolated MCP configuration under `var/vibe`, `var/codex`, or `var/claude` for each scope.

### Vibe

Install Vibe, set `MISTRAL_API_KEY`, and leave `BOUCLE_RUNNER` unset for the existing demo behavior. Vibe enforces `BOUCLE_VIBE_MAX_PRICE` per invocation and reports session cost.

### Codex

Install and authenticate the Codex CLI, then select `codex` globally or on one loop. Boucle runs `codex exec` with a scoped `CODEX_HOME`, danger-full-access sandbox mode, the loop work directory, and a generated Streamable HTTP MCP entry. Resume is used when the installed CLI advertises `codex exec resume`. Codex cost is stored as null when its session data does not expose a price, and the UI displays `n/a`.

Boucle carries only `~/.codex/auth.json` into the scoped `CODEX_HOME`. It does not carry a customized `~/.codex/config.toml`, including alternate provider or base URL settings. Loop runs use Codex's stock provider configuration plus Boucle's generated MCP entry.

### Claude

Install and authenticate Claude Code, then select `claude` globally or on one loop. Boucle uses print mode with JSON output and a generated `--mcp-config`. It uses `--dangerously-skip-permissions` only when the installed CLI advertises the flag, otherwise it allows Boucle MCP tools explicitly. Claude's result envelope supplies the session ID, final text, and reported cost.

## t3code ticket chats

Set the URL, token, and project in Settings or the environment:

```dotenv
BOUCLE_T3CODE_URL=https://t3code.example
BOUCLE_T3CODE_TOKEN=replace_with_your_token
BOUCLE_T3CODE_PROJECT=boucle
```

When URL, token, and project are configured, tickets show an `Open in t3code` secondary action. Boucle creates the thread in the configured project and stores its deep link independently from the browser chat. Browser chats remain the primary chat action.

The spawned t3code chat can use Boucle tools only when Boucle's MCP server is also present in the t3code or Claude configuration. Read the current URL and token from `/api/mcp-info`, then add an HTTP server entry like this:

```json
{
  "mcpServers": {
    "boucle": {
      "type": "http",
      "url": "http://127.0.0.1:4419/mcp",
      "headers": { "Authorization": "Bearer <token from /api/mcp-info>" }
    }
  }
}
```

## Run with systemd

This example assumes the repository is at `/opt/boucle`, the service account is `boucle`, Node is at `/usr/bin/node`, and `.env` is at `/opt/boucle/.env`. Check the Node path with `command -v node` and adjust `ExecStart` if needed.

Create `/etc/systemd/system/boucle.service`:

```ini
[Unit]
Description=Boucle
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=boucle
WorkingDirectory=/opt/boucle
EnvironmentFile=/opt/boucle/.env
ExecStart=/usr/bin/node src/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Load and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now boucle
sudo systemctl status boucle
```

Read logs with:

```sh
sudo journalctl -u boucle -f
```

Rebuild the web application after pulling UI changes:

```sh
cd /opt/boucle
pnpm install
pnpm --dir web install
pnpm --dir web build
sudo systemctl restart boucle
```

## HTTPS and microphone access

Browser microphone access requires a secure context. `http://localhost:4419` is treated as secure for local use. Any other plain `http://` address is not: the microphone button will be disabled when the app is opened over a remote HTTP URL.

Serving over HTTPS also enables `BOUCLE_AUTH_TOKEN` to protect the API and the web application from unauthenticated access. Set the token and use one of the options below.

### Private access with Tailscale Serve

Keep Boucle bound to its default port and publish it inside the tailnet:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4419
```

Open the HTTPS URL reported by Tailscale. The tailnet certificate gives the browser the secure context required for microphone capture.

### Public access with Caddy

Point a DNS name at the server and use this minimal Caddyfile:

```caddyfile
boucle.example.com {
    reverse_proxy 127.0.0.1:4419
}
```

Reload Caddy after saving the file:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains and renews the HTTPS certificate when public DNS and ports 80 and 443 are configured. Set `BOUCLE_AUTH_TOKEN` so the public endpoint requires a token before serving any data, including `/api/mcp-info`. A network restriction (firewall rule or VPN) provides an additional layer of defence.

## Use your own Markdown brain

Set `BOUCLE_BRAIN_DIR` to an absolute path outside the bundled `fake-brain` directory. This also disables demo mode.

```dotenv
BOUCLE_BRAIN_DIR=/srv/boucle-brain
BOUCLE_OWNER_NAME=Alex
BOUCLE_ORG_NAME=Example Org
```

The parser expects this layout:

```text
/srv/boucle-brain/
├── projects/
│   ├── project-slug.md
│   └── another-project.md
└── meetings/
    ├── 2026-07-18-weekly-review.md
    └── 2026-07-19-customer-call.md
```

The `projects` directory is required. The `meetings` directory may be absent or empty. Only `.md` files are read. A file named `README.md` is ignored in either directory.

### Project pages

The filename without `.md` is the project ID. Use a slug containing letters, numbers, dots, underscores, or hyphens. Project frontmatter is a flat `key: value` format. Lists are accepted for `owners` only as comma-separated text or an inline bracket list.

```markdown
---
status: in_progress
owners: [Alex, Sam]
url: https://example.com/projects/customer-import
---

# Customer Import

> Move customer records into the new account format.

## State

- **Stage:** Pilot
- **Next milestone:** Validate the first ten imports
- **Blocked by:** Approval of the rollback plan

## Timeline

- **2026-07-18** | Completed the dry run.
- **2026-07-19** | Started the pilot.
```

Boucle reads these project fields and sections:

| Input | How it is used |
|---|---|
| `status` | Normalized to `scoping`, `in_progress`, `backlog`, `on_hold`, `done`, or `archived`. Common aliases such as `active`, `blocked`, and `proposed` are accepted. |
| `owners` | Comma-separated owner names shown on the project. |
| `repo`, `url`, `source_doc`, `launch_deck_doc`, `deployment_playbook_doc` | Links shown on the project. |
| First `#` heading | Project title. |
| First blockquote | Project summary. |
| `## State` | Reads labeled bullets for stage, next milestone, and blocker. |
| `## Timeline` | Reads bullets in the form `- **YYYY-MM-DD** \| text`. Continuation lines are attached to the previous bullet. |

Boucle can write `status` and append timeline entries. Keep the frontmatter opening delimiter at the first byte of the file so status updates remain structured.

### Meeting notes

Meeting filenames are stable IDs. A leading ISO date keeps fallback sorting predictable. Meeting frontmatter accepts scalar values, inline lists, and indented block lists.

```markdown
---
date: 2026-07-19T10:00:00Z
title: Customer import review
processed: true
source: recorder
attendees: [people/alex, people/sam]
tags: [customer, migration]
related_projects: [customer-import]
call_link: https://meet.example.com/recording
---

# Customer import review

> The pilot can proceed after the rollback check.

## Action items

- **Alex:** approve the rollback plan.
- **Sam:** run the first import.

## Connections

- [[projects/customer-import]]
- [[people/alex]]
```

Boucle reads these meeting fields and sections:

| Input | How it is used |
|---|---|
| `date` | Primary sort value. The value is kept verbatim. |
| `title` | Display title. Falls back to the first `#` heading, then a humanized filename with `.md` and a leading `YYYY-MM-DD` removed and hyphens changed to spaces. |
| `processed` | Only the case-insensitive value `false` marks a raw, unprocessed note. Missing values count as processed. |
| `source` | Source label. |
| `attendees`, `attendees_raw` | Combined attendee list. |
| `tags` | Meeting tags. |
| `related_projects` | Project IDs used to connect meetings to projects. |
| `call_link` | Call or recording link. |
| First blockquote | Meeting summary. |
| `## Action items` | Bullet list collected until the next heading. Heading matching is case-insensitive. |
| `[[projects/project-slug]]` in the body | Also connects the meeting to that project. |

Other Markdown remains available as the meeting body and can be searched. The parser does not implement full YAML. Avoid nested objects, multiline scalars, comments after values, and quoted values containing commas in inline lists.

## Connect an agent CLI to MCP

Boucle exposes a bearer-protected Streamable HTTP MCP endpoint at `/mcp`. Settings shows the local configuration. The local API returns that configuration and its token:

```sh
curl --fail --silent http://127.0.0.1:4419/api/mcp-info
```

Set `BOUCLE_MCP_TOKEN` in the agent CLI environment to the returned token. A Vibe-compatible configuration uses this shape:

```toml
mcp_servers = [{ name = "boucle", transport = "streamable-http", url = "http://127.0.0.1:4419/mcp", auth = { type = "static", api_key_env = "BOUCLE_MCP_TOKEN", api_key_header = "Authorization", api_key_format = "Bearer {token}" } }]
```

Use the HTTPS `/mcp` URL when the agent runs on another machine. MCP clients must send `Authorization: Bearer <token>`. Boucle also supports a stdio MCP transport through `node src/cli.ts mcp` when the client runs from the repository root.

## Budget guardrails

Vibe receives a per-invocation price ceiling from `BOUCLE_VIBE_MAX_PRICE` and a fixed limit of 30 turns. Boucle records costs reported by Vibe in SQLite. It warns at `BOUCLE_AGENT_BUDGET_WARN` and refuses new agent invocations at `BOUCLE_AGENT_BUDGET_STOP`.

The cumulative guard applies to scheduled loops, manual loop runs, smart capture, voice capture, routing, enrichment, and resumed Vibe threads. Provider chat, embedding, and transcription costs are not added to this total. Set the warning and stop values for your own account limits before enabling scheduled loops.

## Backups

Back up both sources of persistent state:

- The SQLite file selected by `BOUCLE_DB` or its default path
- The entire directory selected by `BOUCLE_BRAIN_DIR`

Stop writes while taking a file-level SQLite copy. This example matches the systemd paths above and an own brain at `/opt/boucle/brain`:

```sh
sudo systemctl stop boucle
sudo install -d -m 700 /var/backups/boucle
sudo tar -C / -czf /var/backups/boucle/boucle-$(date +%F).tar.gz home/boucle/.local/share/boucle/boucle.db opt/boucle/brain
sudo systemctl start boucle
```

Test restores on a separate host. Restore the database and brain together when their contents need to remain synchronized.
