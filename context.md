# Phone Use — Architecture & Prize Plan (Cal Hacks 13.0)

> Cloud phones for AI agents. Real phones sit on our hardware rigs, and any agent drives them over a hosted MCP server with an API key. Usage is billed in tokens, and every session becomes training data for our phone VLM. The long-term rig is a physical stylus robot. CP1 sees the screen through mirroring, CP2 through a camera.

**Event:** Cal Hacks 13.0, Oct 23–25 2026, Palace of Fine Arts SF. **Submit by Oct 25, 9:00 AM PST (hard deadline).** The full sponsor and prize plan is in [docs/SPONSORS.md](docs/SPONSORS.md). There is no cap on sponsor tracks. Architecture, contracts and the work split are in [docs/PLAN.md](docs/PLAN.md).

**Current status (be honest in demos):** phone control today goes through iPhone Mirroring, so it is **operator-mediated**. The stylus path is not yet implemented or verified on hardware. See [HARNESS_LIMITATIONS.md](HARNESS_LIMITATIONS.md).

---

## 1. Checkpoints

| | Perception | Actuation | Status |
|---|---|---|---|
| **CP0** | iPhone Mirroring window (ScreenCaptureKit) | Mac input events into Mirroring (`PhoneAction.swift`) | Built; verify live with the real phone |
| **CP1** | Mirroring | Stylus robot (printer harness `stylus.py`) | Waiting on hardware (Vikram + Vela) |
| **CP2** | Camera pointed at the device | Stylus robot | Needs camera → screen calibration |

---

## 2. System Architecture

```
 Any agent (Claude Code / Desktop / Fetch.ai agent / Apify actor)
        │  MCP over HTTPS, Authorization: Bearer pu_…     [PAYMENTS: x402 → Coinbase]
        ▼
 ┌──────────────────────────── Gateway (gateway/, Bun) ─────────────────────────┐
 │ API keys · token metering (/dashboard) · rig leases · live feed (/live)      │
 │ VLM trace recorder (episodes.py format) · human review (/review)             │
 │ Provider slots (env-selected adapters):                                      │
 │   PAYMENTS (x402) · GROUNDING (Gemini / Bitdeer) · VOICE (Cartesia)          │
 │   VLM (phone_do → our model) · STORE (JSON → Convex) · URL (cloudflared)     │
 └───────────────▲──────────────────────────────────────────────────────────────┘
                 │ outbound long-poll (rig never exposes a port)
 ┌───────────────┴──────── Rig agent (rig_agent.py, uv) ────────────────────────┐
 │ screen: PhoneCapture.swift (Mirroring) | camera                              │
 │ actions: sim | mirroring (PhoneAction.swift) | stylus (printer harness)      │
 └──────────────────────────────────────────────────────────────────────────────┘

 TestFlight app (Nikhil) ─► tasks + payouts backend ─► ETH payout ─► episodes for the VLM
```

### Agent loop
1. `phone_connect(task)` reserves a rig and starts a recorded episode.
2. `phone_screenshot` shows the agent the screen. Optionally `phone_find(element)` grounds the target through the grounding provider.
3. `phone_tap` / `phone_scroll` / `phone_type` / `phone_home` (with a `reason`) dispatch to the rig and return the settled screen. Each call is billed in tokens.
4. If the agent hits 2FA or a choice only the user can make, `ask_user` asks them (voice provider, planned).
5. `phone_task_done(outcome)` closes the episode. Humans label the steps at `/review`, then `episodes.py export` produces VLM training data.

---

## 3. Components & Owners

| Component | Notes | Owner |
|---|---|---|
| Stylus robot + calibration | Printer harness `move_to` / `press` / `swipe`, 4-corner phone→printer calibration, `stylus.py dispatch(action)` | Vikram + Vela |
| TestFlight app | SwiftUI + ReplayKit broadcast, task list, wallet | Nikhil |
| Tasks + ETH payouts backend | Task catalog, submission verification, payouts | Nikhil |
| Gateway + hosted MCP | Keys, metering, dashboard, leases, live feed, traces, review | Ryan (+ Claude) |
| Rig agent | `sim` / `mirroring` / `stylus` backends | Ryan (+ Claude) |
| Sponsor adapters | x402, Vultr deploy, Gemini grounding, Fetch.ai wrapper, Cartesia voice… | Ryan (+ Claude) |

**Tooling:** Bun for TypeScript, uv for Python. **Git:** atomic commits, pushed to `main`.

---

## 4. Demo Script

1. **Connect:** add our MCP URL + API key to Claude. Show `/dashboard` (tokens) and `/live` (the phone).
2. **Real task on a real phone:** one mobile-only task chosen to hit demo tracks. Examples: a finance dispute (Hyphenate), a purchase (Visa), messaging family (Meta). The agent pays per call via x402.
3. **Human-in-the-loop moment:** the agent pauses for a 2FA code (`ask_user`, voice if Cartesia lands).
4. **Data flywheel:** open `/review`, label the run, export VLM training rows. Mention the TestFlight app paying humans in ETH for more demonstrations.
5. **Story:** "Instead of grandma asking her grandson, she asks the agent." (Anthropic Public Benefit, People-First Social Impact.)
6. **Hardware:** the stylus rig doing the same task physically, **only if it is verified on hardware by then**.

---

## 5. Prize Map

See [docs/SPONSORS.md](docs/SPONSORS.md) for every 2026 track with fit, angle and owner. Summary:

- **Enter now:** Overall, Most Technically Complex, Most Creative, People-First Social Impact, Hacker's Choice, Anthropic Public Benefit, Coinbase x402 (×2), Fetch.ai, Atlassian Best Agent, Microsoft Real World, MLH Vultr / GoDaddy / Gemini, Commit Fellowship.
- **Via the demo task:** Hyphenate (finance), Visa (shopping), Meta (people closer), Capital One Nessie.
- **If time allows (real integration):** Cartesia, Convex, Tiger Data, Apify, Factory, Spacetime, Bitdeer.
- **Hardware Hack:** only with a verified stylus demo.
- **Ask at booths:** Mana, Moss, CRS.

**Rule:** every sponsor must power something visible in the demo or write-up, and each sits behind a swappable adapter.
