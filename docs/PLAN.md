# Phone Use: product flow, contracts, and work split

We are building a **VLM (vision-language model) for phones** and selling access to **cloud phones**: real phones on our hardware rigs that any agent can drive over MCP. Usage is billed in tokens. Every run also produces training traces for the VLM.

## Product flows

### A. Hosted MCP ("phone use as a service")

1. A developer gets an API key from us (`pu_…`). For now there's one key, issued with `bun run admin create-key`. Self-serve signup isn't planned yet.
2. They add our **remote MCP server** to Claude (Claude Code, Claude Desktop, or the MCP directory) by passing the URL `https://<gateway>/mcp` and the header `Authorization: Bearer pu_…`. There's nothing to install locally.
3. The gateway sends their tool calls to one of **our hardware rigs**. A rig is a Mac with a phone, iPhone Mirroring and the stylus robot (the Prusa printer harness).
4. Tools: `rigs_list`, `phone_connect(task)`, `phone_screenshot`, `phone_tap`, `phone_scroll`, `phone_type`, `phone_home`, `phone_live_feed`, `phone_task_done(outcome)`, `phone_disconnect`, `usage_get`.
   Every session is recorded as a VLM training episode (before frame, action, reason, after frame) in the `episodes.py` format. Humans label steps at `/review` before anything is exported.
5. `phone_live_feed` returns a short-lived URL. Opening it shows a live MJPEG view of the phone in any browser.
6. Every tool call is metered in **tokens** per API key: a base price per tool plus the estimated image tokens of the screenshots we return. Failed calls are free. `/dashboard` shows tokens billed, image tokens, calls, rig time, and a per-minute chart. Each tool result also says what it cost.
7. Users who aren't on MCP get the same rig through a web console (later: voice mode via the existing whisper.cpp stack).

### B. iPhone task collection app (local, Xcode install)

1. A contributor installs the app from Xcode on their own iPhone. It is not published to TestFlight or the App Store.
2. The app shows a task ("Change the translation language in Apple Translate").
3. They record the screen with iOS screen recording while doing the task, then pick the recording in the app.
4. The app uploads it over Wi-Fi to the gateway on our Mac. We review it on `/review/submissions`, and the decision shows up in the app. iOS does **not** expose touches made in other apps, so a submission is a demonstration video, not an action trace.
5. Payouts (ETH or otherwise) and the ReplayKit broadcast extension are deferred.

Full spec: [IPHONE_APP_PLAN.md](IPHONE_APP_PLAN.md).

## Contracts (what lets everyone work in parallel)

### Phone actions (shared by MCP, rig and recorder)

Coordinates are normalized (0–1) over the captured phone image. This is the same shape `episodes.action_payload` validates:

```json
{"type":"tap","x":0.5,"y":0.3}
{"type":"scroll","x":0.5,"y":0.6,"dy":-400}
{"type":"type","text":"hello"}
{"type":"home"}
{"type":"wait","seconds":1}
```

### Rig ⇄ gateway (HTTP, outbound from the rig, so no ports to open on the rig)

Auth: `Authorization: Bearer rig_…`.

| Call | Purpose |
| --- | --- |
| `GET /rig/v1/commands?wait=25` | Long poll. `200 {"id","action"}` or `204` when there's nothing to do. Polling doubles as the heartbeat. |
| `POST /rig/v1/results` | `{"id","ok":true,"receipt":{…}}` or `{"id","ok":false,"error":"…"}` |
| `POST /rig/v1/frames` | `Content-Type: image/jpeg`. Latest screen frame, about 2 fps. |

A rig counts as online if it polled within the last 40 s. One API key holds a rig lease at a time, and leases expire after 10 minutes of inactivity.

### Actuation backends on the rig (`rig_agent.py --backend …`)

| Backend | Screen source | Actuation | Owner |
| --- | --- | --- | --- |
| `sim` | Bundled screenshots | None (fake) | anyone, for testing |
| `mirroring` | `PhoneCapture.swift` | `PhoneAction.swift` (Mac input events) | done; needs a live test |
| `stylus` | `PhoneCapture.swift` or camera | Printer harness: XY move + Z press | hardware team |

## Work split

The workstreams are independent once the contracts above are fixed.

| # | Workstream | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | **Gateway + hosted MCP** | `gateway/`: API key, token metering + dashboard, rig routing, MCP tools, live feed, deploy | contracts only |
| 2 | **Rig agent** | `rig_agent.py`: connects the harness + capture to the gateway | contracts only |
| 3 | **Stylus robot** | Printer harness gains `move_to` and `press`/`swipe`, plus phone→printer calibration (4 corner taps → affine map). Implements the `stylus` backend. | action contract |
| 4 | **Perception** (optional quality boost) | Grounding model (Baseten) and fast verify (Groq) behind a `phone_find(element)` tool | gateway tool shape |
| 5 | **iPhone task app** | SwiftUI app in `ios/`: tasks, screen-recording import, upload, review status | submission API (#6) |
| 6 | **Tasks + submissions** | Task catalog, idempotent upload, review queue on the gateway (payouts deferred) | none |
| 7 | **Web console + voice** | Non-MCP browser UI on the gateway; voice reuses `speech.py` | gateway |

### Owners

| Owner | Streams |
| --- | --- |
| **Nikhil** | #5 iPhone task app, #6 tasks + submission review |
| **Vikram + Vela** | #3 stylus robot and calibration (the hardware rig) |
| **Ryan** (with Claude) | everything else: #1 gateway + MCP, #2 rig agent, #4 perception, #7 web console + voice, VLM traces and training |

The hardware team says when the rig is ready. Then we run rigorous live tests: `--backend stylus` through the gateway with real taps, latency and accuracy measurements.

## Token pricing (gateway/src/usage.ts)

| Tool | Base tokens |
| --- | --- |
| `phone_screenshot` | 50 |
| `phone_tap`, `phone_scroll`, `phone_type`, `phone_home` | 100 |
| `phone_live_feed` | 200 |
| `phone_connect`, `phone_disconnect`, `rigs_list`, `usage_get` | 0 |

Billed tokens = base + estimated image tokens (width × height / 750 after downscaling to 1568 px). A 636×1402 Mirroring frame is about 1,189 image tokens.

## Tooling

Bun for the gateway (`bun install`, `bun test`, `bun run dev`). uv for Python (`uv sync --extra voice`, `uv run …`).
