# Phone Use: product flow, contracts, and work split

## Product flows

### A. Hosted MCP ("phone use as a service")

1. A developer gets an API key from us (`pu_…`). For now an admin CLI creates the key. A signup page comes later.
2. They add our **remote MCP server** to Claude (Claude Code, Claude Desktop, or the MCP directory) by passing the URL `https://<gateway>/mcp` and the header `Authorization: Bearer pu_…`. There's nothing to install locally.
3. The gateway sends their tool calls to one of **our hardware rigs**. A rig is a Mac with a phone, iPhone Mirroring and the stylus robot (the Prusa printer harness).
4. Tools: `rigs_list`, `phone_connect`, `phone_screenshot`, `phone_tap`, `phone_scroll`, `phone_type`, `phone_home`, `phone_live_feed`, `phone_disconnect`, `usage_get`.
5. `phone_live_feed` returns a short-lived URL. Opening it shows a live MJPEG view of the phone in any browser.
6. Every tool call is metered per API key: calls, images returned and rig-seconds held. That's how we track usage and bill. We can't see the client's own Claude tokens. We *can* estimate the image tokens we send back.
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
| `stylus` | `PhoneCapture.swift` or camera | Printer harness: XY move + Z press | hardware team |

## Work split

The workstreams are independent once the contracts above are fixed.

| # | Workstream | Deliverable | Depends on |
| --- | --- | --- | --- |
| 1 | **Gateway + hosted MCP** | `gateway/`: API keys, usage, rig routing, MCP tools, live feed, deploy | contracts only |
| 2 | **Rig agent** | `rig_agent.py`: connects the harness + capture to the gateway | contracts only |
| 3 | **Stylus robot** | Printer harness gains `move_to` and `press`/`swipe`, plus phone→printer calibration (4 corner taps → affine map). Implements the `stylus` backend. | action contract |
| 4 | **Perception** (optional quality boost) | Grounding model (Baseten) and fast verify (Groq) behind a `phone_find(element)` tool | gateway tool shape |
| 5 | **TestFlight app** | SwiftUI app + Broadcast Upload Extension, task list, wallet address entry | submission API (#6) |
| 6 | **Tasks + payouts backend** | Task catalog, submission upload, verification, ETH payout (viem, Base Sepolia) | none |
| 7 | **Web console + voice** | Non-MCP browser UI on the gateway; voice reuses `speech.py` | gateway |

Suggested owners: Nikhil (#3, live test of #2), Ryan + Bella (#4, camera calibration), floater (#5/#6), Claude (#1, #2, then #6).
