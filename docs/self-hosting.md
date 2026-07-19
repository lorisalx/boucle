# Self-hosting Boucle

Boucle runs as one Node process and serves the built web application. SQLite stores operational data. A Markdown directory stores the brain.

## Prerequisites

- Node.js 24 or later
- pnpm
- Git
- About 1 vCPU for a small instance
- A provider API key for chat
- Vibe CLI for loops, smart capture, routing, and enrichment

The bundled demo uses Mistral for provider calls and Vibe. A custom brain can use either supported provider for chat, embeddings, and transcription. Agent work still uses Vibe.

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

## Environment variables

### Core

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_PORT` | `4419` | HTTP port for the API, web application, and MCP endpoint. |
| `BOUCLE_DB` | `$XDG_DATA_HOME/boucle/boucle.db`, or `$HOME/.local/share/boucle/boucle.db` | SQLite database path. Parent directories are created. |
| `BOUCLE_BRAIN_DIR` | Repository `fake-brain` directory | Root containing the `projects` and `meetings` directories. The default enables demo mode. |
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

### Vibe and budgets

| Variable | Default | Purpose |
|---|---|---|
| `BOUCLE_RUNNER` | `vibe` | Agent runner selector. `vibe` is the only accepted value. |
| `BOUCLE_VIBE_BIN` | `$HOME/.local/bin/vibe`, then `vibe` on `PATH` | Vibe executable override. |
| `BOUCLE_LOOP_TIMEOUT_MIN` | `12` | Minutes before an agent invocation is terminated. |
| `BOUCLE_VIBE_MAX_PRICE` | `0.25` | Per-invocation Vibe price ceiling in US dollars. |
| `BOUCLE_AGENT_BUDGET_WARN` | `10` | Cumulative recorded Vibe spend that emits a warning. |
| `BOUCLE_AGENT_BUDGET_STOP` | `30` | Cumulative recorded Vibe spend that blocks new agent invocations. |

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

Browser microphone access requires a secure context. `http://localhost:4419` is treated as secure for local use. Plain `http://<server-ip>:4419` is not. The microphone capture control will fail when the application is opened over a plain remote HTTP address.

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

Caddy obtains and renews the HTTPS certificate when public DNS and ports 80 and 443 are configured. Boucle does not provide user authentication. A public reverse proxy exposes the UI and API, including `/api/mcp-info`. Add an authentication layer or network restriction before using this setup with private data.

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
