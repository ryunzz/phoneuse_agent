# Local Python stack vs. gateway: comparison and merge

Run 2026-10-24 against the **same recorded episodes**: two real gateway sessions from the sim rig (one labelled), plus three planted edge cases:
- an interrupted episode (intent without result, no outcome);
- a corrupt `episode.json`;
- a symlinked episode folder.

**Local stack:** `harness.py --serve` on :8765. It provides `/admin` (`review.py` + `admin.html`), the console phone view and `phone_agent.py`.

**Gateway:** `/review`, `/live` and the MCP tools.

## What we found

| Area | Local Python stack | Gateway (before merge) | Winner → action |
| --- | --- | --- | --- |
| Review: reads the gateway's episodes | ✅ Yes, same `episodes.py` format | ✅ Yes | Tie; the two stacks interoperate |
| Review UX | Long scrolling page. The action is shown as raw JSON with no overlay. Labelling is click only. | Editor layout, with the tap or scroll drawn on the before frame. C/M/R keys, ←/→, outcome buttons. | **Gateway** |
| Reviewer accountability | Requires a reviewer name | Hard-coded `web-review` | Local → **merged** |
| Stats | Header with totals, awaiting review, labelled, successes, incomplete | Only a count of exportable episodes | Local → **merged** |
| Corrupt or missing `episode.json` | Listed as unreadable | **Silently skipped** | Local → **merged** (listed with a reason) |
| Symlinked episode folder | Rejected (`Episode not found`) | **Followed and served (HTTP 200)** | Local → **merged** (rejected for folders and images) |
| Interrupted / failed steps | Counted | Status per step only | Local → **merged** (count plus a reason on the episode) |
| Deployability | Loopback only, token injected into the page | Hosted, `REVIEW_TOKEN` bearer, CSP | **Gateway** |
| Live phone view | Console panel. Only on the Mac. Needs Mirroring. | `/live` MJPEG, a shareable expiring link | **Gateway** for viewing. The console still drives the manual recorder. |
| Agent loop | `phone_agent.py`: Claude Agent SDK driving Mirroring directly. Fresh-screenshot rule, 20-action cap, stop, halt on unknown, $2 / 45 turns / 180 s limits. | Any MCP client. No guards (before the parallel guard work). | **Merge**: guards move server-side in the gateway. `phone_agent.py` becomes a gateway MCP client that keeps the stop/turn/budget/time limits. |
| Data integrity | Append-only reviews, SHA-256 checks at export | Same rows, hashes at record time | Tie |

**Scores** (1–5):

| | Safety | Review UX | Data integrity | Deployability | Demo value |
| --- | --- | --- | --- | --- | --- |
| Local stack | 4 | 2 | 5 | 1 | 2 |
| Gateway, before merge | 2 | 4 | 3 (symlink/corrupt gaps) | 5 | 5 |
| **Gateway, after merge** | **4** (5 with server-side guards) | **5** | **5** | **5** | **5** |

## What changed

- **Merged into gateway `/review`:**
  - required reviewer name, written to `annotations.jsonl` and `outcome.jsonl`;
  - stats header;
  - incomplete, corrupt and symlinked episodes listed with a reason;
  - symlinked folders and images rejected.
- **`phone_agent.py`** is now a gateway MCP client (`GATEWAY_URL`, `PHONEUSE_API_KEY`) with the same stop and limit handling. Run it with `uv run --extra voice phone_agent.py "task"` or from the rig console.
- **Removed:**
  - `review.py`, `admin.html`, `tests/test_review.py`, and the `/admin` routes, all superseded by `/review`;
  - printer heat, cooldown, pause, resume, cancel and temperatures commands, plus their voice phrasings (a stylus gantry doesn't need them);
  - 6 unused screenshots.
- **Kept:**
  - rig motion (`status`, `home`, `jog`) with OctoPrint and `PRINTER_BRIDGE` transports;
  - whisper voice (a future `VOICE_PROVIDER`);
  - the manual demonstration recorder in the rig console (the only human-driven recording path until TestFlight lands).

## Human test checklist

Run these by hand before demoing. Expected results are in *italics*.

**Setup**
1. `cd gateway && bun install && REVIEW_TOKEN=$(openssl rand -hex 16) bun run dev`, then in a second terminal `bun run admin create-key me` and `bun run admin create-rig "rig 1"`. *The gateway prints its MCP URL; the key and rig token print once.*
2. From the repo root: `RIG_TOKEN=rig_… uv run rig_agent.py --backend sim` (or `--backend mirroring` with iPhone Mirroring unlocked). *The log shows "rig online".*

**Agent → recording**

3. Add `http://127.0.0.1:8787/mcp` with header `Authorization: Bearer pu_…` to Claude Code. Ask: "Use phoneuse to open Settings, then call phone_task_done." *Claude connects, taps, gets screenshots back, and reports success.*
4. Alternatively, with `GATEWAY_URL` and `PHONEUSE_API_KEY` set: `uv run --extra voice phone_agent.py "Open Settings"`. *JSON events stream to the terminal; Ctrl-C stops the run without sending further actions.*
5. Open `/dashboard` and paste the key. *Token totals rise with each call.*

**Review**

6. Open `/review`, paste the review token, and try pressing C before entering a name. *A red prompt appears and the name field is focused; nothing is saved.*
7. Enter your name and label steps with C/M/R. *The stats header updates. The label row in `gateway/data/demonstrations/<id>/annotations.jsonl` carries your name.*
8. Create `mkdir gateway/data/demonstrations/$(printf 'f%.0s' {1..32})` with a broken `episode.json`, then reload. *It appears in red as "unreadable episode.json or logs" and can't be opened.*
9. Kill the rig agent mid-action, then reload. *That episode shows "1 step interrupted or failed" and isn't exportable.*
10. `uv run episodes.py export --root gateway/data/demonstrations --output exports/`. *Only steps labelled correct or recovery, from successful complete episodes, appear in `exports/train.jsonl`.*

**Rig console (hardware team)**

11. `uv run --extra voice harness.py --serve`, then open http://127.0.0.1:8765. *The Rig console loads, `/admin` returns 404, and "heat bed 60" is rejected while "jog x 5" previews.*
