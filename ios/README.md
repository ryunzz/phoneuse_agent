# Phone Tasks (iPhone app)

Contributors pick a task, screen-record themselves doing it, and upload the recording to the
gateway on our Mac over Wi-Fi. We review it at `http://127.0.0.1:8787/review/submissions`, and the decision
shows up in the app. Local only: installed from Xcode, never published. Spec:
[../docs/IPHONE_APP_PLAN.md](../docs/IPHONE_APP_PLAN.md).

## 1. Start the gateway on the Mac

```sh
cd gateway && bun install
HOST=0.0.0.0 bun run dev
```

`HOST=0.0.0.0` lets the phone reach it. If macOS asks whether `bun` may accept incoming
connections, click **Allow**. Use trusted Wi-Fi only.

## 2. Make a pairing string

```sh
cd gateway && bun run admin create-contributor "Your name"
```

It prints `http://<mac-wifi-ip>:8787#ct_…`. Send that line to the phone (AirDrop, Notes,
or Universal Clipboard). The key is shown once.

The Mac's Wi-Fi IP can change when it reconnects. If the app says it can't reach the Mac,
check the current IP with `ipconfig getifaddr en0`, then re-pair in the app (Settings →
Pair with a different Mac) using that IP and the same `ct_…` key.

## 3. Install on the iPhone

1. Open `ios/PhoneTasks.xcodeproj` in Xcode.
2. If Xcode says "iOS 26.x is not installed", install it under Xcode → Settings → Components.
3. Target PhoneTasks → Signing & Capabilities: choose your Team (a free Apple ID works). If
   the bundle ID `com.phoneuse.tasks` is taken, change it to something unique.
4. Plug in the iPhone, tap **Trust**, and turn on Developer Mode (Settings → Privacy &
   Security → Developer Mode) when asked.
5. Pick the iPhone as the run destination and press Run.
6. If iOS blocks the app, trust your developer profile in Settings → General → VPN & Device
   Management.
7. Allow **Local Network** access when the app asks.

Free-team installs expire after 7 days; press Run again to renew.

## 4. Try it

1. Paste the pairing string and tap Connect.
2. Open a task, tap **Start task**, and turn on the consent switch.
3. Start iOS screen recording (Control Center → Screen Recording), do the task, and stop the
   recording.
4. Back in the app: **Choose screen recording**, check the preview, tap **Submit recording**.
5. On the Mac, open http://127.0.0.1:8787/review/submissions, play it, and approve or reject (rejecting
   needs a reason).
6. In the app, **My submissions** shows the decision and feedback.

Submissions are stored in `gateway/data/submissions/<id>/` (`meta.json` + video).

## Simulator

The Simulator reaches the Mac at `127.0.0.1`, so pair with the second line `create-contributor`
prints. Add a test video with `xcrun simctl addmedia booted video.mp4`. Debug builds also accept
`SIMCTL_CHILD_PHONETASKS_PAIRING='<pairing string>' xcrun simctl launch booted com.phoneuse.tasks`.

## Notes

- `Info.plist` sets `NSAllowsArbitraryLoads` because the app talks plain HTTP to a Wi-Fi IP.
  `NSAllowsLocalNetworking` alone did not allow this in testing. Fine for a never-published app.
- The app records nothing itself. It uploads the video you pick, plus the task ID and version,
  your consent time, your reported outcome and note, device model, iOS version, locale, and
  the duration.
- Retrying an upload reuses the same attempt ID, so it never creates a duplicate.
