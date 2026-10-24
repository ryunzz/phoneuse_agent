# Current phone-control limitation

**The harness does not currently operate the phone through the physical stylus on the 3D-printer rig.** Its phone-control path depends on the operator opening, unlocking, and connecting Apple iPhone Mirroring on the Mac. Claude then receives screenshots from that mirrored window and sends Mac input events to it. If the mirroring app or connected phone is unavailable, the phone-control path cannot proceed.

This Mirroring workflow is a temporary computer-UI path. It does not meet the intended hands-off phone-use workflow on the real 3D-printer rig. The harness has no implemented and verified bridge from Claude's phone actions to the rig's physical stylus, and a successful request to the Mirroring window is not evidence that the robot moved or that an action landed on the phone.

Until that bridge is implemented and verified on hardware, describe phone control as **Mirroring-dependent and operator-mediated**. Do not claim that Claude can independently use the phone through the 3D-printer rig. A real-rig implementation needs an explicit hardware action path, calibrated screen-to-robot coordinates, and an observed physical outcome in the run trace.
