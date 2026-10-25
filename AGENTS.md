# Instructions for coding agents

Before changing or describing phone-control behavior, read [HARNESS_LIMITATIONS.md](HARNESS_LIMITATIONS.md).

Two phone-control paths exist:

- **Mirroring** (`--backend mirroring`) sends Mac input events to the operator-connected iPhone Mirroring window.
- **Stylus** (`--backend stylus`) sends Claude's actions to the printer-driven stylus through `controller/rig.py`. It is tested only with a dry-run printer until HARNESS_LIMITATIONS.md says otherwise.

Keep claims, tests and demos within what that file lists as verified on hardware. Treat a dispatched input or a stylus receipt as an attempted UI action, not proof that the phone registered it or that the task succeeded.
