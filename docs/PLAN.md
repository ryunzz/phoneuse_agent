# Phone Use: product flow, contracts, and work split

We are building a **VLA (vision-language-action) model for phones** and selling access to **cloud phones**: real phones on our hardware rigs that any agent can drive over MCP. Usage is billed in tokens. Every run also produces training traces for the VLA.

## Product flows

### A. Hosted MCP ("phone use as a service")

1. A developer gets an API key from us (`pu_…`). For now there's one key, issued with `bun run admin create-key`. Self-serve signup isn't planned yet.
2. They add our **remote MCP server** to Claude (Claude Code, Claude Desktop, or the MCP directory) by passing the URL `https://<gateway>/mcp` and the header `Authorization: Bearer pu_…`. There's nothing to install locally.
3. The gateway sends their tool calls to one of **our hardware rigs**. A rig is a Mac with a phone and iPhone Mirroring, plus the stylus robot: a Prusa printer driven by a Linux machine (`controller/`).
4. Tools: `rigs_list`, `phone_connect(task)`, `phone_screenshot`, `phone_tap`, `phone_scroll`, `phone_type`, `phone_home`, `phone_live_feed`, `phone_task_done(outcome)`, `phone_disconnect`, `usage_get`.
   Every session is recorded as a VLA training episode (before frame, action, reason, after frame) in the `episodes.py` format. Humans label steps at `/review` before anything is exported.
5. `phone_live_feed` returns a short-lived URL. Opening it shows a live MJPEG view of the phone in any browser.
6. Every tool call is metered in **tokens** per API key: a base price per tool plus the estimated image tokens of the screenshots we return. Failed calls are free. `/dashboard` shows tokens billed, image tokens, calls, rig time, and a per-minute chart. Each tool result also says what it cost.
7. Users who aren't on MCP get the same rig through a web console (later: voice mode via the existing whisper.cpp stack).

### B. TestFlight data-collection app (paid in ETH)

1. A person installs the TestFlight app and connects an Ethereum wallet address.
2. The app shows a task prompt ("Turn on Dark Mode in Settings").
3. They start a **ReplayKit broadcast**. That's iOS system screen recording, so it covers all apps, not just ours. Then they do the task on their real phone.
4. A Broadcast Upload Extension sends sampled frames and timestamps to our backend. iOS does **not** expose touches made in other apps. Actions get inferred from frame diffs or a VLM later. Verification checks the final frames against the task's success condition (VLM judge plus human spot checks).
5. A verified run triggers an ETH payout (testnet first) to their wallet. The trace goes into the same episode/export format that `episodes.py` already defines, so it feeds flow A.

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
| `stylus` | `PhoneCapture.swift` (camera frames refused until calibrated) | `controller/rig.py`: screen fractions over `STYLUS_COMMAND` to `controller.rig serve` on the printer machine | built; dry-run tested, needs a live test |
| `none` | camera | View-only (streams frames for the VLA; actions refused) | — |

## Work split

The workstreams are independent once the contracts above are fixed.

| # | Workstream | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | **Gateway + hosted MCP** | `gateway/`: API key, token metering + dashboard, rig routing, MCP tools, live feed, deploy | contracts only |
| 2 | **Rig agent** | `rig_agent.py`: connects the harness + capture to the gateway | contracts only |
| 3 | **Stylus robot** | `controller/`: serial printer, tap/swipe, phone→printer calibration (`phone.json`), AssistiveTouch Home. Done by hand on hardware; `controller/rig.py` connects it to `rig_agent`. Next: live test, typing, a landing check. | action contract |
| 4 | **Perception** (optional quality boost) | `phone_find(element)` grounding and a fast "did the tap land?" check, behind a `GROUNDING_PROVIDER` adapter (Gemini first, for the MLH track) | gateway tool shape |
| 5 | **TestFlight app** | SwiftUI app + Broadcast Upload Extension, task list, wallet address entry | submission API (#6) |
| 6 | **Tasks + payouts backend** | Task catalog, submission upload, verification, ETH payout (viem, Base Sepolia) | none |
| 7 | **Web console + voice** | Non-MCP browser UI on the gateway; voice reuses `speech.py` | gateway |

### Owners

| Owner | Streams |
| --- | --- |
| **Nikhil** | #5 TestFlight app, #6 tasks + ETH payouts |
| **Vikram + Vela** | #3 stylus robot and calibration (the hardware rig) |
| **Ryan** (with Claude) | everything else: #1 gateway + MCP, #2 rig agent, #4 perception, #7 web console + voice, VLA traces and training |

The hardware team says when the rig is ready. Then we run rigorous live tests: `--backend stylus` through the gateway with real taps, latency and accuracy measurements.

## Token pricing (gateway/src/usage.ts)

| Tool | Base tokens |
| --- | --- |
| `phone_screenshot` | 50 |
| `phone_tap`, `phone_scroll`, `phone_type`, `phone_home` | 100 |
| `phone_live_feed` | 200 |
| `phone_connect`, `phone_disconnect`, `rigs_list`, `usage_get` | 0 |

Billed tokens = base + estimated image tokens (width × height / 750 after downscaling to 1568 px). A 636×1402 Mirroring frame is about 1,189 image tokens.

## Provider adapters

Every external service sits behind one interface, and env picks the vendor: `<CAPABILITY>_PROVIDER=<vendor>` plus that vendor's key. Vendor SDKs are imported only inside their adapter file, so switching providers (or chasing another sponsor track) means one new file and an env change.

| Capability | Default | Sponsor adapters planned |
| --- | --- | --- |
| Payments | `none` | `x402` (Coinbase) |
| Grounding / vision | `none` | `gemini` (MLH), `bitdeer` |
| Voice | `none` | `cartesia` |
| Usage / trace store | JSON files | `convex`, `tigerdata` |
| VLA (`phone_do`) | `none` | `http` = our custom VLA endpoint (contract in `gateway/src/vla.ts`) |
| Public URL | local | `cloudflared` tunnel from the rig Mac (optional domain) |

Sponsor fit and priorities are in [SPONSORS.md](SPONSORS.md).

## Tooling

Bun for the gateway (`bun install`, `bun test`, `bun run dev`). uv for Python (`uv sync --extra voice`, `uv run …`).
