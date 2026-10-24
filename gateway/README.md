# Phone Use gateway (hosted MCP)

Claude connects here over remote MCP with an API key. The gateway routes tool calls to our hardware rigs, meters usage per key, and hands out live-feed links. See [../docs/PLAN.md](../docs/PLAN.md) for the architecture and the contracts.

## Run locally with the simulated rig

```sh
cd gateway && bun install
bun run admin create-key "my laptop"     # prints pu_... once
bun run admin create-rig "rig 1"         # prints rig_... once
bun run dev                                  # http://127.0.0.1:8787
# in another terminal, from the repo root:
RIG_TOKEN=rig_... uv run rig_agent.py --backend sim
```

Real phone through iPhone Mirroring: build the Swift helpers (see the root README), then `uv run rig_agent.py --backend mirroring`. Use `--backend stylus` once `stylus.py` exists.

## iPhone task app (contributors)

The same process serves the [Phone Tasks app](../ios/README.md): `GET /c/v1/tasks` (catalog in `tasks.json`) and idempotent video submissions under `/c/v1/submissions`, with contributor keys (`ct_…`) that cannot use MCP or rig routes. Review on the Mac at `http://127.0.0.1:8787/review/submissions`; that page and `/admin/v1/*` only answer on loopback.

```sh
bun run phone                                  # LAN + USB, announced over Bonjour, phones sign up
bun run admin create-contributor "Your name"   # fallback pairing string for the app
```

## Connect Claude

```sh
claude mcp add --transport http phoneuse http://127.0.0.1:8787/mcp --header "Authorization: Bearer pu_..."
```

Tools: `rigs_list`, `phone_connect`, `phone_screenshot`, `phone_tap`, `phone_scroll`, `phone_type`, `phone_home`, `ask_user`, `phone_do`, `phone_live_feed`, `phone_task_done`, `phone_disconnect`, `usage_get`.

**Safety rails (server-side):**
- An agent may act only right after seeing the screen (a screenshot, or the frame returned by its previous action).
- Each task has a budget of 50 actions.
- After a failed or unknown action, the agent must take a new screenshot before acting again.
- The person can **stop** the agent from the live page, or with `POST /v1/stop`.

**Human in the loop:** `ask_user` (for example, "enter the 6-digit code") shows the question on the agent's live page. The person answers there, or with `POST /v1/asks/<id>`, and the agent's call returns the answer. Answers are never written to traces.

**VLA:** `phone_do(instruction)` runs our model in a loop of look → act → look, through the same guarded, recorded path. Set `VLA_PROVIDER=http`, `VLA_URL` and (optionally) `VLA_API_KEY`. The request/response contract is documented at the top of `src/vla.ts`.

**Usage:** `/dashboard` shows tokens in (from the agent), tokens out (to the agent, including images), tokens billed, calls and rig time.

## Training traces (VLM)

Every MCP session is recorded as an episode in the same format the local demo recorder (`episodes.py`) writes, under `DATA_DIR/demonstrations/` (set `TRACE_DIR`, or `TRACES=off` to disable).

- `phone_connect(task, task_family)` starts an episode, and `phone_task_done(outcome, note)` ends it. Acting without connecting auto-starts an episode with the instruction `(not provided)`.
- Each action writes the frame the agent last saw (`before`), the action, the agent's optional `reason`, and the settled frame after (`after`). Frames carry SHA-256 hashes.
- Steps start as `unreviewed`. The agent's `success` is only a claim. `episodes.py export` takes only steps a human marked `correct` or `recovery`, in successful episodes where every step completed.
- Review at `/review` (set `REVIEW_TOKEN`), or use the CLI:

```sh
uv run episodes.py label gateway/data/demonstrations/<episode_id> 1 correct --reviewer ryan
uv run episodes.py export --root gateway/data/demonstrations --output exports/
```

Traces include screenshots and typed text. The MCP instructions tell agents that sessions are recorded and not to type secrets. Keep `DATA_DIR` private.

## Deploying

The gateway keeps rig queues, leases and frames in memory, so run it as **one long-lived Bun process** (Fly.io, Railway, a VM). It does not fit per-request serverless. Set `HOST=0.0.0.0`, `PORT`, `PUBLIC_URL=https://…` (used in live-feed links) and `DATA_DIR` (a persistent volume for `store.json` and `usage.jsonl`). Terminate TLS in front of it. The rig agent refuses plain `http` to non-local gateways.

No server? Run the gateway on the rig Mac and expose it with `cloudflared tunnel --url http://localhost:8787`, then set `PUBLIC_URL` to the tunnel URL.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address |
| `PUBLIC_URL` | `http://HOST:PORT` | Base for live-feed links |
| `DATA_DIR` | `./data` | API keys/rigs/contributors (hashed), usage ledger, traces, `submissions/` |
| `TASKS_FILE` | `./tasks.json` | Contributor task catalog |
| `ENROLLMENT` | closed | `open` lets phones get a contributor key from `POST /c/v1/enroll` |
| `TRACE_DIR` / `TRACES` | `DATA_DIR/demonstrations` / on | Episode recording (`TRACES=off` disables) |
| `REVIEW_TOKEN` | unset | Enables `/review` and `/v1/episodes` (24+ chars) |
| `VLA_PROVIDER` / `VLA_URL` / `VLA_API_KEY` | `none` | Custom VLA model behind `phone_do` |

## Test

```sh
bun test        # hub unit tests + end-to-end: gateway + sim rig_agent.py (via uv) + MCP client
bun run typecheck
```
