# Instructions for coding agents

Before changing or describing phone-control behavior, read [HARNESS_LIMITATIONS.md](HARNESS_LIMITATIONS.md).

The current Claude phone harness depends on the operator opening and connecting iPhone Mirroring on the Mac. It sends input events to that mirrored window; it does not currently control the phone through the physical stylus on the 3D-printer rig. Keep claims, tests, and demos within that boundary. Treat a dispatched Mirroring input as an attempted UI action, not proof of physical robot movement or task success. Do not represent the real-rig control path as implemented until it has been exercised and its physical outcome verified on the rig.
