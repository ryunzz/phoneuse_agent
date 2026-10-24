# iPhone task collection app — local MVP

## Goal

An iPhone app that contributors use to pick everyday phone tasks and submit screen
recordings of themselves completing them.

The tasks represent problems older adults face when using their phones. Contributors
demonstrate the solution on their own test phone. An older adult does not need to be
present for the MVP.

Approved demonstrations support later VLM post-training and evaluation. Payouts and RL
are later experiments.

**Local only.** The app is installed from Xcode onto our own iPhones. It is not published:
no TestFlight, no App Store, no hosted backend. The phone talks to the gateway running on
a Mac on the same Wi-Fi.

**First acceptance gate:** complete one real task on an iPhone, upload its screen recording
to the Mac, review it on the review page, and see the review status in the app.

## Why there is a server at all

The recording is made on the phone, but review happens on the Mac, and the review result has
to come back to the phone. Something on the Mac has to accept the upload and serve the status.
That is a handful of routes on the existing Bun gateway (`gateway/`), reached at
`http://<mac-lan-ip>:8787`. There is no cloud service.

## Pieces

| Piece | Where | Job |
| --- | --- | --- |
| iPhone app | `ios/` (SwiftUI) | Browse tasks, import a recording, submit, see review status |
| Mac receiver | `gateway/src/submissions.ts` | Task catalog, idempotent uploads, review state |
| Review page | `GET /review/submissions` on the gateway, Mac only | Play videos, approve/reject, stats |
| Controller | existing harness and MCP | Unchanged; contributor keys cannot reach it |

The contributor app and the Claude harness produce different kinds of evidence. Keep their
source visible in exports (`recordingSource: "screen_recording_import"`).

## iPhone app screens

### 1. Tasks

- Title, short description, estimated duration, target app.
- A reward is shown only when one is configured; none are in the seed catalog.
- Operator-created listings only (`gateway/tasks.json`).

### 2. Task details

- Goal, starting conditions, steps, and what the recording must show.
- Reminder to use test content and not expose personal data.
- How to record before leaving the app, a Start button, and Abandon on an open attempt.

Example listing:

> **Change the translation language**
>
> In Apple Translate, choose Mandarin Chinese as the target language and translate
> “Where is the train station?” Start on the app's translation screen. Record the language
> selection and the final translated result.
>
> App labels differ by iOS version and region. Report an unavailable option as *blocked*
> instead of pretending the task succeeded.

### 3. Record and submit

- Explicit consent for upload and training use before upload; the recording may contain
  other apps' content.
- Pick the screen recording from Photos, preview it, replace or discard it.
- Outcome: succeeded, failed, or blocked, with an optional note.
- Upload with task ID and version, attempt ID, device model, iOS version, locale, recording
  source, and duration.
- Progress and a retry state. Retrying uses the same attempt ID, so it never creates a
  duplicate.
- Show "Submitted" only after the Mac confirms the stored file's checksum.

### 4. My submissions

- Pending review, approved, or rejected, with reviewer feedback.
- The contributor's reported outcome is shown separately from the review decision.
- “Payments are not enabled in this beta.” No wallet, no balance.

### 5. Settings

- Pair with the Mac by pasting the pairing string printed by
  `bun run admin create-contributor <name>`: `http://<mac-ip>:8787#ct_…`.
- Connection check against `/c/v1/tasks`.

## Recording

### Working version: import an iOS screen recording

The contributor starts iOS screen recording from Control Center, does the task in the
target app, stops recording, returns to our app, and picks the video with the system
Photos picker. No photo-library permission is needed for the picker.

### Stretch: ReplayKit broadcast extension

Only after the import flow works on a device. Verify capture, return-to-app, finalization,
and interrupted sessions on a real phone first.

### Training data boundary

A video is a demonstration, not an action trace. The app does not claim tap coordinates,
swipe paths, or typed text. Action annotations come later, with provenance (human or
model-proposed). Failed and blocked attempts are kept but are not imitation targets.

## Mac receiver (gateway routes)

Contributor routes need `Authorization: Bearer ct_…`. A `ct_` key is rejected by `/mcp`,
`/rig/v1/*`, and the admin routes, because each route checks its own key prefix
(`bearerToken` in `gateway/src/auth.ts`).

| Endpoint | Purpose |
| --- | --- |
| `GET /c/v1/tasks` | Task catalog |
| `POST /c/v1/submissions` | Create an attempt; the client's `attemptId` is the idempotency key |
| `PUT /c/v1/submissions/{id}/media` | Stream the video (mp4/mov, size-limited) to disk with SHA-256 |
| `POST /c/v1/submissions/{id}/complete` | Check the checksum, then enter pending review |
| `GET /c/v1/submissions` | This contributor's submissions and review history |

Admin routes answer only on loopback (the Mac itself), require a `localhost`/`127.0.0.1`
Host header, and reject cross-site writes:

| Endpoint | Purpose |
| --- | --- |
| `GET /review/submissions` | Review page (`/review` is the separate episode review) |
| `GET /admin/v1/submissions` | Completed submissions and stats |
| `GET /admin/v1/submissions/{id}/media` | Video with Range support |
| `POST /admin/v1/submissions/{id}/review` | Approve, or reject with a reason; history is kept |

Storage: `DATA_DIR/submissions/<id>/meta.json` plus `media.mp4|mov`. Each record keeps the
task version, contributor, consent version and time, outcome, checksum, duration, device,
and review history. Unfinished uploads never reach the review queue.

**Networking:** run `HOST=0.0.0.0 bun run dev` on trusted Wi-Fi only. That also exposes `/mcp`
and `/rig` on the LAN; they still require their own tokens. The app's Info.plist sets
`NSAllowsArbitraryLoads` (plain HTTP to the Mac's Wi-Fi IP; `NSAllowsLocalNetworking` alone was
refused for an IP address in testing) and `NSLocalNetworkUsageDescription` (iOS asks for
local-network access on first use). The Mac's Wi-Fi IP can change; re-pair with the new IP.

### Review page

- Video player, task requirements, device info, contributor outcome and note.
- Approve, or reject with a reason; earlier decisions stay in the history.
- Totals: submissions, pending, approved, rejected, review rate. Failed/blocked outcomes are
  counted separately from rejections.

## Order

1. Gateway: contributor keys, task catalog, submissions, review routes, tests.
2. SwiftUI app: pairing, tasks, details, import + preview, upload with retry, history.
3. Run in Simulator against the local gateway.
4. Install on a physical iPhone from Xcode and run the acceptance test.
5. ReplayKit only after that works.

If time is tight, keep the real submit/review loop and defer ReplayKit, payments, task
editing, and training.

## Installing on the iPhone

Step-by-step instructions: [../ios/README.md](../ios/README.md).

- Open `ios/PhoneTasks.xcodeproj`. Install the matching iOS platform under Xcode → Settings →
  Components if Xcode asks. Under Signing & Capabilities pick your team (a free
  Apple ID works) and change the bundle identifier if Xcode says it is taken.
- Connect the iPhone, trust the Mac, enable Developer Mode (Settings → Privacy & Security),
  select the phone as the run destination, and Run.
- On first launch, trust the developer profile in Settings → General → VPN & Device
  Management if iOS asks.
- Free-team builds expire after 7 days; run from Xcode again.

## Acceptance test

- [ ] Install and launch the app on a physical iPhone.
- [ ] Pair with the Mac over Wi-Fi; the connection check passes.
- [ ] The app shows a clear error when the Mac is unreachable.
- [ ] Open the translation task's full requirements.
- [ ] Start an attempt and read the recording/training consent.
- [ ] Record the task in Apple Translate, outside the app.
- [ ] Return, pick the video, and preview it.
- [ ] Submit with outcome and note; see pending review after the upload is confirmed.
- [ ] Interrupt an upload and retry without creating a duplicate submission.
- [ ] Relaunch the app; the submission is still listed.
- [ ] On the Mac's review page, play the same recording with matching metadata.
- [ ] Approve it and see the decision in the app.
- [ ] Reject a separate submission and see the reason in the app.
- [ ] A request without a key cannot list submissions or fetch recordings.
- [ ] One contributor cannot read or change another's submissions.
- [ ] A contributor key cannot call `/mcp` or `/rig/v1/*`.
- [ ] The app makes no claim that a payment or model training happened.

## Deferred

Payouts and wallets, TestFlight/App Store distribution, a hosted backend, fraud detection,
recruitment, video-to-action labeling, training, physical-device calibration, and RL.
