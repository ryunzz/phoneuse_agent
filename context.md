# Phone Use — Architecture & Prize Plan (Cal Hacks)

> Claude controls a real phone with a physical stylus robot. It sees the screen through mirroring (CP1) or a camera (CP2). It works on any touchscreen: phone, iPad, Kindle, a TestFlight app. It ships as an MCP server on npm.

⚠️ The prize page says Cal Hacks 12.0 - Oct 24-26, 2025. Confirm the sponsor list in Slack/Devpost before building around any one sponsor, and check whether Devpost caps how many sponsor tracks we can submit to.

---

## 1. Checkpoints

| | Perception | Actuation | Why |
|---|---|---|---|
| **CP1** | Phone → Mac screen mirroring, streamed to the harness | Serial commands → stylus robot | Easiest path. Gives a clean, pixel-perfect screen. |
| **CP2** | Live camera pointed at the device | Same robot | Works on any device with a screen and no software link. Needs camera-to-screen calibration. |

---

## 2. System Architecture

```
┌──────────┐   tap/swipe    ┌───────────────────────┐
│  Phone   │ ◄───────────── │ Stylus robot (serial) │  ← Hardware / Robotics
└────┬─────┘                └───────────▲───────────┘
     │                                  │ serial cmds
     ├─ CP1: Mac screen mirror ─┐       │
     └─ CP2: camera ────────────┤       │
                                ▼       │
                ┌──────────────────────────────────┐
                │ LiveKit video track (frames)     │  ← LiveKit
                └───────────────┬──────────────────┘
                                ▼
   ┌────────────────────────────────────────────────────────┐
   │ PERCEPTION                                             │
   │  • UI grounding: open VLM on Baseten → (x, y)          │  ← Baseten
   │  • Camera-view understanding (CP2): Reka               │  ← Reka
   │  • Fast verify loop ("did the tap land?"): Groq        │  ← Groq
   └───────────────────────────┬────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │ PLANNER: Claude via our MCP server (npm package)       │  ← Claude, MCP Automation
   │  Tools: screenshot(), tap(x,y), swipe(), type(),       │
   │         home(), ask_user(prompt)                       │
   │  All LLM calls routed through Lava gateway             │  ← Lava
   └───────────────────────────┬────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │ MEMORY & TRACES                                        │
   │  • Letta: stateful memory (per-app UI, user prefs)     │  ← Letta
   │  • Chroma: stored successful trajectories → retrieval  │  ← Chroma
   └───────────────────────────┬────────────────────────────┘
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │ HUMAN-IN-THE-LOOP                                      │
   │  ask_user(): voice call / TTS asks for the 2FA code    │  ← Vapi / Fish Audio
   └────────────────────────────────────────────────────────┘
```

### Agent loop
1. `screenshot()` grabs the latest frame from the mirror or camera.
2. Claude plans the next action toward the goal, pulling similar past traces from Chroma and app memory from Letta.
3. The grounding model maps the intended element to pixel coordinates, then to robot coordinates (in CP2 this goes through the calibration homography).
4. The robot executes the action over serial.
5. Groq quickly checks that the screen changed as expected. If not, retry or re-plan.
6. If the agent hits 2FA or a choice only the user can make, `ask_user()` reaches them by voice or notification and waits for the reply.
7. Each run's trace is logged (frames, actions, outcome) and stored in Chroma.

---

## 3. Components & Owners

| Component | Notes | Owner |
|---|---|---|
| Robot + serial driver | Stylus mount (tape it on), tap/swipe/home commands, coordinate mapping | Nikhil + team |
| CP1 mirroring stream | Mac screen mirroring → frames into harness | Nikhil + team |
| MCP server → npm | Tool definitions above; publish early, demo the install | Nikhil + team |
| Lava / Groq / Claude wiring | Swap the OpenRouter key for Lava | Nikhil + team |
| CP2 camera + LiveKit | Camera → LiveKit track; screen-corner detection → homography calibration | Ryan + Bella |
| Grounding (Baseten / Reka) | Open UI-grounding VLM on Baseten; Reka for camera view | Ryan + Bella |
| 2FA voice step | Vapi call or Fish Audio TTS | Floater |
| Letta + Chroma traces | Memory + trajectory retrieval | Floater |
| Fetch.ai wrapper | Agentverse registration + Chat Protocol | Floater (if time) |

**Git hygiene:** commit by feature via PRs (CodeRabbit reviews them), not one massive commit.

---

## 4. Demo Script

1. **Install:** `npx <our-mcp>` → connect it to Claude.
2. **Real client workflow:** for an F&B client's double-chargeback dispute with his distributor, the agent uploads the files through his portal on the phone.
3. **2FA moment:** the agent pauses, calls or notifies the user ("what's the code?"), types it in, and finishes the task.
4. **Generality:** the same agent on a different device (iPad / Kindle / TestFlight app) using CP2 camera mode.
5. **Story:** "Instead of grandma asking her grandson in person, she just asks the agent." We collect traces and every run makes the next one better.
6. *(Optional)* A gov or benefits portal run for the Promise Public Impact angle.

---

## 5. Prize Map

### Tier 1: Core
- **Best Use of Claude:** Claude Code built it and Claude runs it.
- **Best MCP Automation** (Interaction Company): the npm MCP that controls physical devices.
- **Best Hardware Hack** + **Best Robotics Hack** (BitRobot): the stylus robot.
- **Most Creative / Social Impact / Most Wacky** (Wordware).
- **Build an Iconic YC Company:** "computer use for any screen, no API needed" + trace-data moat.

### Tier 2: One integration each
- **LiveKit** (complex / creative / startup): video transport (+ voice).
- **Baseten:** open grounding model powering a core feature.
- **Reka:** CP2 camera-view understanding.
- **Groq:** fast verify loop.
- **Lava Gateway:** all model routing.
- **Vapi / Fish Audio:** 2FA voice step (Fish pays per person).
- **Letta:** stateful memory.
- **Chroma:** trace retrieval.
- **CodeRabbit:** PR reviews.

### Tier 3: Via the demo
- **Conversion – Best Workflow App:** the chargeback workflow.
- **Creao – Productivity Tool / Smartest Agent:** check whether it requires their platform.
- **Promise – Public Impact:** gov-app demo.
- **Composio Toolrouter:** use an API when one exists, fall back to the physical phone when not.
- **Fetch.ai:** Agentverse + Chat Protocol wrapper.
- **Postman:** API collection for the harness endpoints.
- **Visa:** only if `#spons-visa` covers chargebacks/disputes.

### Skip
AppLovin, Sui, XRP, Ethereum, Regeneron, Rox, Crater, Janitor AI, Bright Data, Elastic. Snap Spectacles only if we can get a pair to use as the camera.

**Rule:** every sponsor must power something visible in the demo. Target Tier 1 + ~5 of Tier 2.