# Current phone-control limitations

Status on 2026-10-24. Update this file whenever one of these changes on hardware.

## What has run on the real rig

- **iPhone Mirroring capture and Mac input events** (`--backend mirroring`): the capture produced live frames of the real phone. This path sends Mac input events to the mirrored window, not physical touches. It needs the operator to open, unlock and connect iPhone Mirroring.
- **The stylus controller run by hand** (`controller/`, on the Linux machine wired to the printer): according to the hardware team's notes, scroll down, previous page, opening Settings and Home through AssistiveTouch worked on the real phone. Scroll up is not verified. The normal Home swipe does not trigger, because the stylus cannot start close enough to the bottom edge.

## Implemented but not yet exercised on hardware

**Claude's actions driving the stylus** (`--backend stylus`). The chain is Claude → gateway → `rig_agent.py` on the Mac → `STYLUS_COMMAND` (SSH) → `controller.rig serve` → printer. It is tested with a dry-run printer and a real subprocess, but has not moved the real printer yet. Until it has, and the outcome on the phone has been observed, do not claim that Claude independently uses the phone through the 3D-printer rig.

## Known gaps on the stylus path

- **Mirroring may not survive physical touches.** As far as we know, the iPhone stays locked while it is mirrored, and using it directly ends the session. Nobody has tested whether stylus touches count as using it. If they do, the stylus backend needs another screen source (USB capture, AirPlay, or a calibrated camera).
- **Mirroring needs the phone on the Mac's Apple Account.** A friend's phone signed in to another account will not connect.
- **No typing.** There is no keyboard map. `phone_type` is refused, and the agent must tap keys one at a time.
- **Part of the screen is out of reach.** About the top 13% is past the printer's Y travel with the current phone placement. Taps there are refused, and scrolls slide down into reach. Home, Notification Center and Control Center go through the AssistiveTouch menu, which must be enabled and left where `controller/tasks.py` expects it.
- **Calibration is static.**
  - `controller/phone.json` (phone corners in printer mm) and the touch height in `controller/stylus.py` must be re-measured whenever the phone, the mount or the stylus moves.
  - The Mirroring screen rectangle in `controller/rig.py` was measured on 636 × 1402 captures of this iPhone.
- **Camera frames are not calibrated to the phone**, so the stylus backend refuses actions on them.
- **No landing check.** A receipt means the printer finished its moves, not that the phone registered the touch. The rubber tip's contact is still intermittent. Compare the next screenshot before assuming success.
- **Scroll distance is approximate.** Fast physical swipes fling, so a given `dy` does not scroll an exact number of pixels.
