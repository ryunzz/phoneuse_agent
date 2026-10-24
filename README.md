# Prusa command + voice harness

## Admin and controller dashboards

Run the existing server, then open `/controller` for the Claude SDK phone harness or `/admin` for trace review. Both use the same local server and demonstration directory. The root URL still opens the controller. For example, with `python3 harness.py --serve --iphone`, open [the controller](http://127.0.0.1:8765/controller) or [the admin dashboard](http://127.0.0.1:8765/admin).

The admin dashboard shows episode totals, pending and labeled steps, reported successful outcomes, unfinished episodes, and incomplete steps. Select an episode to inspect action payloads and before/after images. Finish the episode before saving a review, enter a reviewer name, and label each step correct, mistake, recovery, or unreviewed. Reviews append to `annotations.jsonl`; the original action trace and recorded outcome are preserved. Use Refresh statistics to see newly recorded episodes. Unreadable episode directories are counted separately rather than silently included in totals.

The controller retains the existing Claude SDK Run/Stop, phone stream, manual recorder, and bounded printer command flows. Claude controls the phone through iPhone Mirroring; it does not operate a physical stylus robot. Starting this server without `--live` leaves printer commands in simulation; phone actions still affect the real phone when Mirroring is connected.

These are local operator dashboards, not a hosted multi-user admin service. Review APIs require the local console token; writes also require the same-origin request check. No contributor accounts, iPhone marketplace project, video uploads, payouts, or automated episode approval are added here. Step labels and operator-reported outcomes remain separate, and the existing dataset exporter retains its success, completeness, image-integrity, and split checks.

## Claude phone tasks by voice

The phone console now uses the official [Claude Agent SDK for Python](https://github.com/anthropics/claude-agent-sdk-python) to launch your installed Claude Code CLI with two in-process MCP tools: `screenshot` and `act`. Claude can observe the Mirroring window and perform recorded taps, scrolling, text entry, Home, and waits. This uses Mac input events through iPhone Mirroring; the physical stylus/serial adapter is still separate.

```sh
claude auth login
.venv-voice/bin/python -m pip install -r requirements-voice.txt
.venv-voice/bin/python harness.py --serve --iphone
```

Build the two Swift helpers using the instructions below if `.build/phone-capture` and `.build/phone-action` do not exist. Open [the local console](http://127.0.0.1:8765/), unlock iPhone Mirroring, and use **Ask Claude to use your phone**:

1. Click **Record phone task**, speak, then click **Stop recording**. Or focus the phone-task field and hold Option+Space while speaking.
2. Review or edit the transcript. Try “Open Settings and find Display & Brightness.”
3. Click **Run Claude on phone**. Watch the screen and Claude's progress.
4. Click **Stop Claude** to interrupt the run and block subsequent tool actions. An input already dispatched may finish; Stop is not an undo.

Speech is transcribed locally with whisper.cpp. Task text and screenshots are sent to Claude using the CLI's configured authentication/provider, and may incur usage. Only the harness phone tools are exposed: built-in tools, filesystem settings, and other MCP servers are disabled. Printer commands retain their separate preview/confirmation flow. Phone actions affect the real phone even when the printer is in simulation.

Each run is limited to 20 actions, 45 turns, 180 seconds, and a $2 SDK budget (not a hard billing guarantee). Each action requires a preceding screenshot, and failed/unknown dispatches stop the run without retrying. The system prompt tells Claude to stop at locked/disconnected screens, authentication, or consequential submissions; these semantic restrictions depend on model behavior. Native action validation and the Stop gate are enforced by code. Manual recorder controls cannot take over an active Claude run.

Runs are stored in `demonstrations/<episode-id>/`, including `agent.jsonl`, numbered observation JPEGs with hashes, and the existing before/after action trace. Steps remain unreviewed, and completed agent runs are marked abandoned/needs human review rather than automatically treated as successful training data. The UI's “completed” means the SDK run ended, not that the phone task succeeded.

Authenticated endpoints: `POST /agent/start` with `{"instruction":"..."}`, `POST /agent/stop` with `{}`. `GET /agent/status` returns run state and recent progress. These use the same loopback and console authentication boundary as the existing harness.

Verified on 2026-10-24: 41 tests pass in `.venv-voice`. A browser recording of synthetic speech went through the actual local Whisper endpoint, populated the phone-task field without starting a run, and then launched Claude through the Run button. Claude used the real screenshot tool, correctly reported the locked Mirroring screen, and took no phone actions. A separate live run verified Stop, duplicate-run rejection, and manual-control exclusion. Your actual microphone and an unlocked-phone action task still need a live try.

The attached photo identifies an Original Prusa i3 MK2 with an MK42 heatbed. It does not identify the controlling computer, connection, firmware revision, or any installed modifications. This harness runs locally with Python 3.10+ and no Python dependencies.

## Try it now

```sh
cd /Users/nikhi/compiled-16
python3 harness.py status
python3 harness.py 'jog x 5'
python3 harness.py --execute 'jog x 5'
python3 harness.py --serve
```

Open [the local console](http://127.0.0.1:8765). The default is **simulation**: it validates commands and records receipts without contacting hardware. Preview and confirm a command to simulate dispatch. The console shows the mode on every response.

**Printer voice:** focus the printer-command field and hold **Option+Space** while speaking, then release. whisper.cpp transcribes locally and fills the prompt. Review or edit the text, then press **Enter** to preview the interpreted printer command. Use **Confirm execution** separately to dispatch it. The Record/Stop button is also available. For Claude phone tasks, use the separate phone-task field above.

## Local voice SDK

The integrated [whisper.cpp](https://github.com/ggml-org/whisper.cpp) backend runs Whisper `base.en` locally with Apple Silicon acceleration. Silero VAD filters recordings with no speech. Browser `getUserMedia` / `MediaRecorder` captures up to 30 seconds; authenticated `POST /transcribe` sends audio only to the local harness. PyAV decodes it into bounded 16 kHz mono PCM. A private temporary WAV and transcript are deleted after each transcription, including failures. No desktop dictation app, cloud transcription, account, or API key is used.

The runtime is isolated in `.venv-voice` using Python 3.12. Setup:

```sh
brew install whisper-cpp
python3.12 -m venv .venv-voice
.venv-voice/bin/python -m pip install -r requirements-voice.txt
.venv-voice/bin/python speech.py
.venv-voice/bin/python harness.py --serve
```

The setup command downloads the base.en and Silero VAD models to `.models/`. Normal transcription uses only local files and never downloads models.
After setup, `python3 harness.py --serve` automatically relaunches in `.venv-voice` when needed, so the audio decoder is available even when the console is started from the system Python.

Open [the console](http://127.0.0.1:8765). Allow microphone access when prompted. Hold **Option+Space**, speak, and release; or click Record, speak, then Stop. If you release the shortcut while the first permission prompt is open, hold it again after granting access. The shortcut works while the console has focus; it is not a system-wide dictation shortcut. Losing focus stops a recording. Review the transcript, then press Enter to preview. The microphone is released when recording stops, errors, or the page closes. Typed prompts still work without the SDK. Recordings are capped at 4 MB / 30 seconds; concurrent transcription is rejected rather than queued. Whisper can mishear axis names, signs, and numbers: review both the transcript and interpreted action. A transcript never authorizes hardware execution.

Verified on 2026-10-24: 32 unit tests passed. A synthesized spoken prompt encoded as browser-style WebM passed through the running `/transcribe` endpoint using whisper.cpp and produced a simulation preview of `jog x 5`. Silent audio was rejected. A browser test with a simulated microphone verified Option+Space release fills the prompt without previewing or executing; Enter creates a preview. The user’s actual microphone and speech still need a live try.

Examples:

| Spoken prompt | Interpreted command |
| --- | --- |
| “Move the x axis by five millimeters.” | `jog x 5` |
| “Jog y minus two point five millimeters.” | `jog y -2.5` |
| “Lower z by one millimeter.” | `jog z -1` |
| “Set the bed temperature to sixty degrees.” | `heat bed 60` |
| “Heat the nozzle to two hundred and ten degrees.” | `heat nozzle 210` |
| “Home all axes.” | `home` |
| “Turn off the heaters.” | `cooldown` |
| “Pause the print.” | `pause` |

The prompt parser is deterministic and constrained. Say the axis and numeric distance; “move right” and “stop” are ambiguous and rejected. Multiple instructions in one prompt are rejected. It accepts common spoken numbers and terminal punctuation but does not guess corrections to axes or values. Typed commands still work in the same field.

CLI and agents can use the same interpreter:

```sh
python3 harness.py --prompt 'Move the x axis by five millimeters.'
```

```json
{"prompt":"Set the bed temperature to sixty degrees."}
```

Send either `prompt` or `command` to the JSON-lines interface, not both. Authenticated `POST /prompt` accepts `{"prompt":"..."}` and returns a preview/confirmation token; `POST /execute` consumes the token once. The `/transcribe` endpoint returns text only and never dispatches a printer command. No speech transcript bypasses the console's confirmation.

## iPhone screen streaming (macOS)

This captures the **iPhone screen/apps through Apple's iPhone Mirroring window**, not the iPhone camera. It uses Apple's ScreenCaptureKit locally; no public tunnel or upload service is needed. Your actual printer setup is Claude sending commands over serial; this screen stream is independent of that connection, and does not change serial-port ownership.

Build and run:

```sh
mkdir -p .build
swiftc -parse-as-library PhoneCapture.swift -o .build/phone-capture
.venv-voice/bin/python harness.py --serve --iphone
```

Open iPhone Mirroring on the Mac, complete its Mac-login authentication, and let it connect to the nearby iPhone. Allow macOS screen-capture permission if requested. The harness captures only the window belonging to `com.apple.ScreenContinuity` titled `iPhone Mirroring`, approximately twice per second. It never substitutes a capture of the whole Mac desktop. Mirroring's own login/connection screens are also part of that window: **a fresh window frame does not by itself prove an unlocked, connected phone**. Check the image.

The console at [127.0.0.1:8765](http://127.0.0.1:8765/) shows the current frame, frame count and age. Frames older than three seconds, or frames from a dead capture process, are rejected rather than presented as live. The **Download current screenshot** link returns the latest fresh frame. Only the latest JPEG and its metadata are retained in `.phone-stream/`; the directory is ignored by Git. The server remains bound to loopback and is not exposed to the LAN/Internet.

Agent/read-only endpoints:

- `GET /iphone/status`: capture-process liveness, frame count, dimensions and age. Source is always the Mirroring window, including login or connection screens.
- `GET /iphone/frame.jpg`: current screenshot, or HTTP 503 when no fresh frame is available.

Verified in this session: the native helper compiled and produced successive 636 × 1402 frames through the live HTTP endpoint. After the user unlocked Mirroring, the actual iPhone home screen was visible in the captured image and the frame counter continued advancing. No phone taps or printer motion were performed.

## Printer commands

| Command | Behavior |
| --- | --- |
| `status`, `temperatures` | Read controller's full printer report |
| `home`, `home x y` | Home all or listed axes |
| `jog x 5`, `jog z -1` | Relative move, up to 10 mm per command at 300 mm/min |
| `heat nozzle 200` | Nozzle target, 0–240 C |
| `heat bed 60` | Bed target, 0–100 C |
| `cooldown` | Set nozzle and bed targets to zero; does not actively cool |
| `pause`, `resume`, `cancel` | Control an existing print job |

These are conservative harness limits, not a verified material/printer profile. No raw G-code, extrusion, file upload, print start, or arbitrary shell execution is exposed to commands. Homing still moves hardware; check the bed and tool clearance first. Cancellation is a controller request, not an emergency stop.

## Connect to the other computer

Use the adapter that matches the actual existing setup. Only one process should own the printer USB connection. Do not open a second serial connection alongside the existing controller.

### If the other computer runs OctoPrint

Set `OCTOPRINT_URL` to its actual base URL, and `OCTOPRINT_API_KEY` through your local secret manager/environment. Do not commit the key. Then:

```sh
python3 harness.py --live status
python3 harness.py --live --serve
```

The adapter uses the documented [printer API](https://docs.octoprint.org/en/main/api/printer.html) and [job API](https://docs.octoprint.org/en/main/api/job.html). OctoPrint enforces its permissions and profile. Motion/heating requires its ready/idle report. A submitted receipt means the controller accepted the request; it does not prove a completed move or reached temperature.

After homing and physically verifying clearance, launch with `--live --motion-ready --serve` to enable small jogs. This is an operator assertion; the harness cannot verify homed coordinates, collisions, or physical position. Restart without that flag after a reset, reconnect, disabled motors, or lost position. Use physical emergency controls when needed; network requests can fail.

### If it uses a custom script / another controller

Set `PRINTER_BRIDGE` to a fixed executable and optional arguments. It takes precedence over OctoPrint. The harness invokes that executable with **one validated JSON object on stdin** and expects one JSON response on stdout:

```json
{"action":"jog","axis":"x","mm":5.0}
```

```json
{"ok":true,"receipt":"controller-specific response"}
```

The bridge must own transport/authentication, state checks, unit conversion, homing/position checks, and enforcement of printer limits. Return nonzero or `{"ok":false}` on rejection. It must not report success until the controller acknowledges. Status responses should include the actual controller state. Do not implement a bridge that simply echoes `ok`: that would falsely imply a hardware submission. The actual bridge to your existing computer still needs its software/address/code details.

## Agent interface

An agent can invoke the CLI or maintain a JSON-lines subprocess:

```sh
python3 harness.py --agent
```

Send one object per line:

```json
{"command":"status"}
{"command":"jog x 5"}
{"command":"jog x 5","execute":true}
```

One JSON receipt is returned per line. `execute: true` explicitly authorizes dispatch when launched with `--live`; the calling agent must obtain operator authorization before setting it. This is a tool harness with a constrained grammar, not a bundled LLM service. Unknown or ambiguous commands are rejected rather than guessed. Browser execution uses a single-use 30-second preview token and requires a click. CLI/agent execution is a trusted local interface.

The local HTTP console binds only to 127.0.0.1, checks Host/Origin and a per-launch token, and serializes transport calls. Keep a single harness process per printer: separate CLI processes do not coordinate. No automatic retries occur after transport failure because an action may already have happened. If either step of cooldown fails, check both heater targets directly.

Receipts and dispatch intents append to `events.jsonl`. A dispatch intent without a terminal receipt means interrupted/unknown, not success. Logs include controller responses; keep them local. Simulation reports no physical state. Do not mistake simulation receipts for printer evidence.

## Verify

```sh
.venv-voice/bin/python -m unittest discover -s tests -v
```

Automated checks cover command/spoken parsing, spoken numbers, ambiguous prompts, bounds, previews, simulation, state gates, API payloads, bridge invocation, and uncertain partial failures. Hardware connection, physical motion, and real microphone speech still require testing with the actual setup.

Verified locally: 15 unit tests passed, and a generated speech sample sent through the real SDK HTTP endpoint returned “Set the bed temperature to 60 degrees.” and previewed `heat bed 60`. Silence and malformed audio were rejected. This was synthetic-audio validation, not a live microphone test. The Codex in-app browser did not resolve its microphone request; the console times this out after 15 seconds and suggests Chrome or Safari. Browser microphone capture remains unverified.

## Phone demonstration recorder

The console now records complete episodes through the existing **iPhone Mirroring** source. This is separate from printer simulation: **phone controls affect the real phone**, even when the printer says SIMULATION.

Build both helpers, then start (or restart) the server:

```sh
swiftc -parse-as-library PhoneCapture.swift -o .build/phone-capture
swiftc -parse-as-library PhoneAction.swift -o .build/phone-action
.venv-voice/bin/python harness.py --serve --iphone
```

Open the [local console](http://127.0.0.1:8765/). Unlock iPhone Mirroring and verify the actual phone is visible. Enter the task instruction, task family, and train/evaluation split, then click **Start demonstration**. Click the displayed image to tap. Use the buttons for scroll, text entry, wait, and Home. Mac Accessibility permission is required for the native action helper; screen recording permission is required for capture. Permission or focus failures are recorded as failed/unknown attempts, with no automatic retry.

Use these controls for every demonstrated action. Direct phone touches, clicks in Mirroring, and interactions from another automation tool are not intercepted. They cannot be silently included as recorded demonstrations. Home uses Mirroring's Command-H shortcut. Scroll records an anchor in normalized image coordinates plus a signed pixel delta. Tap coordinates cover the captured Mirroring window, including its chrome, and retain window bounds and image dimensions for the actual dispatch mapping.

Label each step as **Needs review**, **Correct**, **Mistake**, or **Recovery**. Finish the episode with **Success**, **Failed**, or **Abandoned**, plus an optional note. Success is an operator label; an input-event receipt is not proof the task succeeded. A fresh window can still display a lock or connection screen.

Storage is local, ignored by Git, and contains screenshots and typed text:

```text
demonstrations/<episode-id>/
  episode.json           # instruction, task family, split, start time
  steps.jsonl            # durable intent before dispatch, then terminal result
  00001-before.jpg
  00001-after.jpg
  outcome.jsonl          # operator outcome
  annotations.jsonl      # optional later reviews / bounding boxes
```

The source keeps five numbered frames in `.phone-stream/` in addition to `latest.jpg`. Metadata names the immutable numbered image. Recording copies that specific image so it cannot pair a screenshot with another frame's metadata. The after-image must start capture after action completion plus the settling period (default 0.7 seconds). This is a timing boundary, not automatic visual-stability detection. Frame IDs, capture times, dispatch times, dimensions, source, coordinate mapping, and SHA-256 image hashes are retained. Interrupted intents remain incomplete and are excluded from training. Episodes without an outcome remain unfinished after a restart; start a new episode rather than guessing their outcome.

Later review does not rewrite the original trace:

```sh
python3 episodes.py label demonstrations/EPISODE_ID 1 correct --reviewer human --note 'Verified Settings tap'
python3 episodes.py label demonstrations/EPISODE_ID 2 mistake --reviewer human
python3 episodes.py label demonstrations/EPISODE_ID 3 recovery --reviewer human
```

Optional `--boxes boxes.json` imports an array of labels on the step's **before image**. Coordinates are normalized to the entire saved image, top-left origin:

```json
[{"label":"Display & Brightness","x1":0.1,"y1":0.3,"x2":0.9,"y2":0.4}]
```

A human or external labeler can provide these annotations. Bounding boxes describe visible regions; they do not independently establish action correctness or task success. No specific "jev" service is connected yet.

Export model-neutral examples:

```sh
python3 episodes.py export --output demonstrations/export
```

This writes `train.jsonl` and `eval.jsonl`. Each example contains the instruction, absolute before-image path, up to four previous actions, and the target action. It excludes current-step after-images, review notes, bounding boxes, outcomes, and correctness labels from the model input. Only correct/recovery steps in explicitly successful, complete episodes are exported. Mistakes stay in the trace and can appear as observed action history for a subsequent recovery, but are not imitation targets. Image hashes are checked. A task family appearing in both splits rejects the export; assign related variants to one family and reserve separate families/starting conditions for evaluation. Do not distribute the same underlying task variants across differently named families to bypass this check.

The export is a dataset contract, not a checkpoint-specific trainer. Model choice and its image/chat format remain separate. No fine-tuning or model upload happens automatically.

### Camera source boundary

A camera viewing a physical phone is a different source from iPhone Mirroring. `EpisodeRecorder` accepts a source with `snapshot(after=None, timeout=5) -> (metadata, jpeg_bytes)` and a dispatcher callback, so camera frames can use the same episode format. Metadata must contain source identity, frame ID, dimensions, capture start/completion timestamps; `after` requires a newly acquired frame, not a resent old image. The current default source is Mirroring only.

Before a camera bounding box can drive a phone action, connect the actual camera feed and calibrate the visible screen corners/perspective to phone coordinates. Retain the calibration and source coordinates with each action. Moving the camera or phone invalidates that mapping. The default dispatcher rejects camera-source actions until an appropriate calibrated adapter is supplied. A bounding-box annotation alone is not a calibration. The camera identity and the exact "jev" tool are still needed to implement that adapter.

Automated recorder tests use synthetic frames and a fake dispatcher. Both native helpers compile. Live inspection on 2026-10-24 showed a fresh Mirroring stream displaying **iPhone Mirroring Is Locked**; real phone action execution and the camera path have not been validated for this recorder.
