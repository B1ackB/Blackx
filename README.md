# Blackx

[English](README.md) · [简体中文](README.zh-CN.md)

Blackx is a local Agent workspace for **packaging presales and order follow-up**. It combines a self-built, industry-neutral Agent Core with a workflow layer that manages sourced facts, versioned requirement briefs, approvals, and recovery.

The project is an engineering prototype you can run and inspect locally. It is not a production SaaS or a packaged desktop application. The current product focuses on packaging; the `print` domain identifier is retained for compatibility.

## What you can do

- Create and delete conversations; receive streamed replies; stop and retry a turn.
- Switch the interface between Chinese and English. Existing messages and source documents retain their original language.
- Attach documents and images. Read PDF, DOCX, and XLSX text through a sandboxed local parser on macOS.
- Browse local directories and preview files in the right panel. Ask the Agent to create, edit, or delete text files, with approval for each write or deletion.
- Inspect the configured model, request outcomes, latency, token usage, and reported cache usage in the same panel.
- Build a packaging requirement brief from source material, review facts, create versions, and approve or export a delivery.
- Inspect persisted workflow events, background jobs, and bounded schedules through the implementation and local workspace.

## Requirements

| Requirement | Supported baseline |
| --- | --- |
| Node.js | **24.14.0**, recorded in `.nvmrc`; package engines target Node 24 |
| Package manager | npm; use the committed `package-lock.json` with `npm ci` |
| Full local workflow | macOS with Apple Command Line Tools (`xcode-select --install`) |
| Browser | A modern browser connecting to `127.0.0.1` |
| Real model access | An authorized Anthropic Messages-compatible endpoint, model ID, and API key |

The native document reader uses Swift and macOS Seatbelt. Other platforms do not silently fall back to an unsandboxed parser. Cross-platform support for the complete product has not been validated. Node 24 is required by the project baseline, including its use of built-in SQLite.

## Install

```bash
git clone https://github.com/B1ackB/Blackx.git
cd Blackx
# If you use nvm:
nvm install
nvm use
npm ci
```

If you already have a checkout, run the commands from its root. `nvm` is optional: an existing Node 24.14.0 installation is sufficient. Repository access may require your GitHub credentials.

Choose one of the following startup paths.

### 1. Explore without an API key

```bash
npm run dev:fixture
```

Wait for the startup result, then open **http://127.0.0.1:5178**. This command compiles the native reader, prepares temporary example documents, and starts the workspace against a local provider with **fixed responses**. No external model is called; the replies demonstrate integration behavior rather than general model reasoning. The initial checks can take a little time.

Use `Ctrl+C` to stop it. The fixture's temporary workspace is removed on normal shutdown; do not use it to store work you want to keep. Local file writes and deletions still require approval.

For a persistent workspace without a model, `npm run dev` defaults to `fake` mode at **http://127.0.0.1:5173**. You can manage conversations, but sending chat messages is intentionally disabled in this mode.

### 2. Connect a real model

```bash
cp .env.example .env
```

Edit `.env` locally:

```dotenv
BLACKX_RUNTIME_MODE=anthropic
BLACKX_PORT=5173
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=your-provider-supported-model-id
ANTHROPIC_API_KEY=your-private-api-key
```

Replace the example values with your provider's configuration, then run:

```bash
npm run dev
```

Open **http://127.0.0.1:5173**. This single command builds the native reader and runs the API host with the Vite UI. A separate frontend terminal is not needed.

`npm run dev` automatically reads `.env`; existing shell environment variables take precedence. `.env` is ignored by Git. Keep keys server-side and never put them in messages, committed files, or `VITE_` variables. This startup script injects `.env` into the server process; online evaluation scripts expect exported provider variables.

The provider adapter uses Anthropic Messages, including streaming and tools; the full runtime also uses token counting. `ANTHROPIC_BASE_URL` is the service root: Blackx appends `/v1/messages` and `/v1/messages/count_tokens`. An OpenAI Chat Completions endpoint is not interchangeable. A “configured” status does not prove the endpoint supports every required capability. See the [configuration guide](docs/api-configuration.md) and [compatibility notes](docs/anthropic-compatibility.md) (currently Chinese).

Real requests can incur provider charges. Selected document contents and model inputs may be sent to the configured provider; local parsing does not make real-model operation fully offline.

## First useful workflow

1. Create a conversation and describe a packaging request. Attach a text PDF, DOCX, or XLSX if useful.
2. Ask the Agent to read the document and identify missing requirements. Use the right panel to inspect files and model requests.
3. Create a requirement brief, review the source-backed facts, and explicitly confirm the values you know. Model suggestions remain unverified until confirmed.
4. Review the resulting version and its validation status. Approve and export when the workflow allows it; changing upstream facts makes affected outputs stale.
5. To save a text file locally, ask for a specific location. Review the proposed absolute path and content in the approval request, then approve or reject it.

The no-key fixture has a scripted response sequence; use a real provider for arbitrary conversations. No approved requirement brief should be treated as a production-ready print file.

## How the code fits together

```text
Browser workspace
    → Local API host
        → AgentRuntimePort → Agent Core → Model Provider / controlled tools
        → Workflow engine → Facts / Artifact versions / Approvals / Events
                                              ↑
                                Packaging domain rules and evaluators
```

The Agent chooses actions within a stage. The Host owns permissions, workflow transitions, validation, and completion. A model finishing its reply does not itself complete a business workflow.

| Location | Responsibility |
| --- | --- |
| `src/App.tsx`, `src/components/`, `src/i18n.ts` | React workspace, multifunction panel, bilingual UI |
| `src/agent/` | Industry-neutral loop, context, tools, hooks, sessions, and compaction |
| `src/enterprise/`, `server/enterprise/` | Workflow contracts, events, persistence, and recovery |
| `src/manufacturing/`, `server/manufacturing/` | Packaging requirement workflow and delivery |
| `src/print/` | Existing print domain capabilities and regression assets |
| `server/index.ts`, `server/runtime/` | Local API, runtime adapters, file policy, approvals, and telemetry |
| `server/anthropic/` | Anthropic protocol client and stream parsing |
| `native/` | Swift document/asset readers executed under macOS isolation |
| `eval/`, `server/testing/` | Repeatable evaluations, local fixtures, and failure cases |
| `docs/` | Architecture decisions, evidence, configuration, and roadmap |

Start with [architecture principles](docs/architecture/principles.md), then follow a feature from the UI through the local API and runtime. Read [AGENTS.md](AGENTS.md) before changing architecture or implementation. Most deeper design documents are currently Chinese; both READMEs cover the complete onboarding path.

## Verification commands

| Command | Purpose | External model needed? |
| --- | --- | --- |
| `npm run check` | Unit/integration suite, TypeScript checks, frontend build | No |
| `npm run eval:offline` | Fixed offline Harness evaluation | No |
| `npm run eval:m1` | M1 workflow evaluation | No |
| `npm run eval:m2` | Packaging requirement-brief evaluation | No |
| `npm run build:native` | Compile the macOS reader | No |
| `npm run test:native` | Real macOS sandbox and document tests | No |
| `npm run eval:product` | Local provider/API/workflow smoke test; cleans up afterward | No |
| `npm run check:local` | All the above checks in sequence; full macOS baseline | No |
| `npm run eval:anthropic-contract` | Validate a configured provider contract | Yes; may incur charges |

For online evaluation, inject provider variables into the terminal environment as described in the [configuration guide](docs/api-configuration.md). It is not required for installation or the no-key fixture.

`npm run dev:web` starts only Vite and does not provide the API host. `npm run build` produces the frontend build and type-checks the project; it does not package a standalone server or desktop installer. Serving `dist/` alone is not a complete deployment.

## Data, permissions, and current limits

- **Local storage:** normal runs persist state under `.blackx-data/` by default. It contains conversations, events, attachments, artifacts, backups, and model request records. Keep this directory private; it is excluded from Git. Generated native tools live in `.blackx-tools/`.
- **File access:** safe local paths can be read under Host policy. `BLACKX_WORKSPACE_ROOT` sets the default workspace location; it is not a blanket authorization or a guarantee that all reads are confined there. Hidden/system/internal paths and symlinks are restricted. Every new text file, modification, and deletion needs a specific approval. Hash/version checks reject stale operations. Text writes are limited to 128 KiB; Office/PDF write-back is not implemented.
- **Deletion:** deleting a conversation removes access through the workspace and stops its associated work. Historical data remains for audit; this is not secure erasure. Local file deletion removes the original file after approval and retains a managed backup.
- **Documents:** PDF text extraction has no OCR. DOCX supports paragraphs and tables; XLSX supports sheet/cell values and does not recalculate formulas. Legacy `.doc`/`.xls` and encrypted documents are unsupported. Parsing is bounded: files up to 10 MiB, PDF up to 100 pages / 8,000 Swift characters, DOCX/XLSX up to 24,000 characters, XLSX up to 20 sheets / 500 rows per sheet. Truncated output is marked.
- **Observability:** token/cache statistics reflect fields actually returned by the provider, with retention and coverage limits. Missing data is not invented. Fixture numbers are not performance or billing evidence.
- **Deployment:** the host binds to loopback and uses local session/Host/Origin checks. This is not a multi-user login system or proof of production tenant isolation. Native resource controls and broader deployment hardening remain unfinished.
- **Evidence:** offline, native, and local product checks are separate from real-provider and real-user validation. See the [2026-09-07 feature evidence](docs/evidence/streaming-bilingual-documents-2026-09-07.md), [streaming/document ADR](docs/adr/0014-streaming-and-document-sources.md), and [roadmap](docs/roadmap.md) for scope and remaining work.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Unsupported Node / SQLite or env-file errors | Check `node --version`; switch to Node 24.14.0, then run `npm ci` again |
| `xcrun` / Swift compilation fails | Install Apple Command Line Tools, then run `npm run build:native` |
| Chat sending is disabled | `fake` mode intentionally rejects sends; use `dev:fixture` or configure a real provider |
| Configuration changes have no effect | Restart the host; check whether existing shell variables override `.env` |
| Port already in use | Stop the process you own, or set another `BLACKX_PORT` for `npm run dev`; fixture mode uses 5178 |
| API returns 403 | Open the local UI and refresh after a host restart; bare API requests lack the local session token |
| Provider fails after appearing configured | Check base URL, model ID, credentials, and Messages/streaming/tool/token-count compatibility |
| A scanned PDF has no text | Provide a text PDF or extract the text separately; OCR is not included |

## License

[MIT](LICENSE). Third-party dependencies and their review are documented in [docs/dependencies.md](docs/dependencies.md). Reference repositories are not production source dependencies.
