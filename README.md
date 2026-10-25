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

Drives the physical stylus directly over USB serial (no OctoPrint): `printer.py` (serial link, X/Y homing, moves), `camera.py` (OAK-1 W frames from `depthai_ros_driver`; `RAW_TOPIC` undistorts raw frames if the rectify node stalls), `zcal.py` (camera-to-bed distance from the 50 mm grid and parallax), `stylus.py` (`hover`, `tap`, `swipe` in printer mm), `phone.py` (phone corners in printer mm, `phone.json`), `tasks.py` (fixed gestures in screen fractions, Home through AssistiveTouch), `rig.py` (Claude's actions, below).

```sh
source /opt/ros/humble/setup.bash
python3 -m controller.stylus swipe 100 87 100 135   # +Y drags toward the phone's top, so the page scrolls down
python3 -m controller.stylus tap 100 100
```

- **No Z homing.** The PINDA probe is gone, so `Printer.send` refuses `G28`/`G28 Z`; use `home_xy()`. Opening the port can reset the board and lose position; `Printer` clears HUPCL and refuses moves after a detected reset. `keep_motors_on()` stops idle steppers from being pushed out of place.
- **Touch height is per mount.** With the current mount the tip is about 85 mm below the camera: no contact at Z 39.8, fast strokes scroll at 39.3. The tip lands at pixel (315, 710) of the rectified frame (`TIP_PIXEL`). Re-measure after any re-mount or phone move.
- **The rubber tip grips the glass.** A stationary contact becomes a long-press, so `swipe` touches down and lifts off while moving and drags at 100 mm/s. Contact is still intermittent; a spring-loaded mount would help.

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
