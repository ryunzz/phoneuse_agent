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

## Connect Claude

```sh
claude mcp add --transport http phoneuse http://127.0.0.1:8787/mcp --header "Authorization: Bearer pu_..."
```

Tools: `rigs_list`, `phone_connect`, `phone_screenshot`, `phone_tap`, `phone_scroll`, `phone_type`, `phone_home`, `phone_live_feed`, `phone_task_done`, `phone_disconnect`, `usage_get`.

## Training traces (VLA)

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

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address |
| `PUBLIC_URL` | `http://HOST:PORT` | Base for live-feed links |
| `DATA_DIR` | `./data` | API keys/rigs (hashed), usage ledger, traces |
| `TRACE_DIR` / `TRACES` | `DATA_DIR/demonstrations` / on | Episode recording (`TRACES=off` disables) |
| `REVIEW_TOKEN` | unset | Enables `/review` and `/v1/episodes` (24+ chars) |

## Test

```sh
bun test        # hub unit tests + end-to-end: gateway + sim rig_agent.py (via uv) + MCP client
bun run typecheck
```
