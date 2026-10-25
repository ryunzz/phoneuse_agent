# Phone Use

**Cloud phones for AI agents.** Real phones sit on our rigs. Any agent drives them through a hosted MCP server with an API key, usage is billed in tokens, and every session becomes training data for our phone VLM.

> **Current status:** the stylus controller taps and swipes the real phone when run by hand. Claude → gateway → stylus (`--backend stylus`) is implemented but tested only with a dry-run printer. Phone control that has run end to end still goes through **iPhone Mirroring on the Mac, so it's operator-mediated**. See [HARNESS_LIMITATIONS.md](HARNESS_LIMITATIONS.md).

```
Agent (Claude, …) ──MCP──► gateway/ (Bun) ◄──long poll── rig_agent.py (uv) ──► phone
                           keys · tokens · live view       screen: Mirroring / camera
                           traces · review                 actions: sim | mirroring | stylus
```

| Piece | What it is |
| --- | --- |
| [`gateway/`](gateway/README.md) | Hosted MCP (`/mcp`): API keys, token metering (`/dashboard`), rig leases, live feed (`/live`), VLM trace recording and human review (`/review`) |
| `rig_agent.py` | Runs on the rig's Mac. Connects outbound to the gateway, streams the screen, and executes actions through a backend |
| `PhoneCapture.swift`, `PhoneAction.swift`, `phone_stream.py` | Capture of the iPhone Mirroring window, and input into it |
| `episodes.py` | The shared episode format, plus `label` and `export` for VLM training data |
| `phone_agent.py` | Our own Claude agent: a Claude Agent SDK client of the gateway MCP |
| `harness.py` + `console.html` | Local rig console: bounded printer motion for the stylus team (status / home / jog via OctoPrint or `PRINTER_BRIDGE`), voice prompts, the manual demonstration recorder, and the Claude agent controller |

## Quick start (simulated rig)

```sh
cd gateway && bun install
bun run admin create-key me              # prints pu_… once
bun run admin create-rig "rig 1"         # prints rig_… once
REVIEW_TOKEN=$(openssl rand -hex 16) bun run dev
# another terminal, repo root:
RIG_TOKEN=rig_… uv run rig_agent.py --backend sim
claude mcp add --transport http phoneuse http://127.0.0.1:8787/mcp --header "Authorization: Bearer pu_…"
```

## Real phone through iPhone Mirroring

```sh
mkdir -p .build
swiftc -parse-as-library PhoneCapture.swift -o .build/phone-capture
swiftc -parse-as-library PhoneAction.swift -o .build/phone-action
RIG_TOKEN=rig_… uv run rig_agent.py --backend mirroring
```

Open iPhone Mirroring and unlock it, then grant Screen Recording and Accessibility to the terminal. A fresh frame can still show Mirroring's lock or connection screen, so check the image. A dispatched input is an attempted UI action, not proof that it landed.

## Our agent and the rig console

```sh
uv sync --extra voice                    # Claude Agent SDK + local whisper voice
GATEWAY_URL=http://127.0.0.1:8787 PHONEUSE_API_KEY=pu_… uv run --extra voice phone_agent.py "Open Settings"
uv run --extra voice harness.py --serve  # rig console on http://127.0.0.1:8765
```

Voice uses whisper.cpp locally: `brew install whisper-cpp`, then `uv run --extra voice speech.py` downloads the models once. Rig motion defaults to simulation. `--live` uses `OCTOPRINT_URL` + `OCTOPRINT_API_KEY` or `PRINTER_BRIDGE`, and `--motion-ready` is the operator's assertion that homing and clearance were checked. None of this is an emergency stop; use the printer's power switch.

## Stylus controller (`controller/`)

Drives the physical stylus directly over USB serial (no OctoPrint): `printer.py` (serial link, X/Y homing, moves, `set-z`), `camera.py` (OAK-1 W frames from `depthai_ros_driver`; `RAW_TOPIC` undistorts raw frames if the rectify node stalls), `zcal.py` (camera-to-bed distance from the 50 mm grid and parallax), `stylus.py` (`hover`, `tap`, `swipe` in printer mm, plus the camera-to-glass mapping), `phone.py` (phone corners and touch settings, `phone.json`), `tasks.py` (fixed gestures in screen fractions, Home through AssistiveTouch), `rig.py` (Claude's actions, below).

```sh
source /opt/ros/humble/setup.bash
python3 -m controller.phone survey --out map.jpg --ys 30,75,120,165,209   # top-down map of the bed, mm grid
python3 -m controller.phone set 67.55,227.26 141.65,226.56 66.05,68.11   # display corners: top-left, top-right, bottom-left
python3 -m controller.phone where 0.5 0.5                               # printer mm of a screen point
python3 -m controller.tasks list
python3 -m controller.tasks run home --check after.jpg                  # survey afterwards to see the result
```

- **No Z homing.** The PINDA probe is gone, so `Printer.send` refuses `G28`/`G28 Z`; use `home_xy()`. After a power cycle, run `python3 -m controller.printer home-xy`, measure the bed-to-nozzle gap with calipers, and run `python3 -m controller.printer set-z <gap>`. That sets Z = gap − 3.0, from a reading of 83 mm at Z 80 on 2026-10-24. X/Y calibration survives homing; check one tap afterwards, since a whole-mm reading can leave ~0.5 mm of Z error. Opening the port can reset the board and lose position; `Printer` clears HUPCL and refuses moves after a detected reset. `keep_motors_on()` stops idle steppers from being pushed out of place.
- **Camera to printer mm.** The camera is pitched and rolled ~2.8°, so its scale runs from 8.5 px/mm at the top of the frame to 8.2 at the bottom. `PIXEL_TO_MM` is a homography measured at hover height (Z 47.5) by tracking a screen patch over a 5 × 6 grid of head moves; it fits to 0.04 mm. It is only valid at hover height.
- **Where the tip lands.** `TIP_PIXEL` (276, 688) was measured on AssistiveTouch's Create New Gesture canvas, which draws a dot at each touch. Six aimed taps agreed to 0.3 mm. After the correction, check taps landed within 0.5 mm, one at 1.6 mm. The canvas holds a limited number of points, so clear it between runs.
- **Touch height is per placement** and is stored in `phone.json` (`touch`: `z`, `slope`, `origin`, `hover_mm`, `press_mm`, `drag_press_mm`). In the case, the glass is ~15 mm above the bed. Taps register from Z 43.5 mid-screen; probed thresholds were 42.69–42.99 near the bottom and 44.45–44.65 near the top, a rise of 0.0167 mm per mm toward the phone's top that matches the camera's parallax. Fast strokes register about 0.75 mm higher. Hover is Z 47.5. A Weather run (open, scroll down twice, scroll up, home) worked end to end with these settings.
- **Reach.** The printer's Y travel ends at 210, so with the phone's top at Y≈227 the top ~11% of the screen (status bar, top-corner buttons) is out of reach. AssistiveTouch (Settings › Accessibility › Touch) stands in for home, Control Center and Notification Center. The stylus can't start the edge-swipe home gesture close enough to the bezel.
- **The rubber tip grips the glass.** A stationary contact becomes a long-press, so `swipe` touches down and lifts off while moving and drags at 100 mm/s. Marginal contact can turn a stroke into a tap; a spring-loaded mount would help.

Tests: `tests/test_controller.py` uses a fake serial link and synthetic grid images.

### Claude on the stylus (`--backend stylus`)

The Mac runs iPhone Mirroring and `rig_agent.py`; the Linux machine runs the printer. For each action Claude sends through the gateway, `rig_agent` maps the Mirroring screenshot coordinates to fractions of the phone screen. It sends them as one JSON line to a long-lived `controller.rig serve` process on the printer machine, started over SSH:

```sh
# printer machine, once per phone or mount move: home X/Y, check the touch height, measure the corners
python3 -m controller.phone survey && python3 -m controller.phone set …
python3 -m controller.rig serve --dry-run   # optional: type {"gesture": "tap", "x": 0.5, "y": 0.5} and read the G-code
# Mac
STYLUS_COMMAND="ssh -o ServerAliveInterval=15 rig@printer-box 'cd phoneuse_agent && python3 -m controller.rig serve'" \
  RIG_TOKEN=rig_… uv run rig_agent.py --backend stylus
```

- **tap**: the calibrated point.
- **scroll**: a vertical drag of `dy` screenshot pixels, clamped to 0.1–0.6 of the screen height and slid into the printer's reach.
- **home**: the AssistiveTouch menu.
- **wait**: runs on the Mac.
- **type**: refused (no keyboard map yet).

Taps on the Mirroring window chrome, taps out of reach, and camera frames are refused before anything moves. Nothing retries. A timeout stops the controller, because the outcome is unknown. See [HARNESS_LIMITATIONS.md](HARNESS_LIMITATIONS.md) for what is verified on hardware.

## Training data

Gateway sessions are recorded to `gateway/data/demonstrations/`, and the rig console's manual recorder writes to `demonstrations/`. Both use the same format. Steps start unreviewed. Label them at `/review` or with `uv run episodes.py label …`, then run `uv run episodes.py export --root <dir> --output exports/`. The export contains only human-labelled correct/recovery steps from successful, complete episodes.

## Tests

```sh
uv run --extra voice --extra controller python -m unittest discover -s tests
cd gateway && bun test && bun run typecheck
```

More: [docs/PLAN.md](docs/PLAN.md) (architecture, contracts, owners), [docs/SPONSORS.md](docs/SPONSORS.md) (Cal Hacks 13.0 tracks), [docs/COMPARISON.md](docs/COMPARISON.md) (local vs. gateway, human test checklist), [gateway/README.md](gateway/README.md).
