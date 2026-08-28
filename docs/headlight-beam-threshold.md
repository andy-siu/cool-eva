# Turning the headlight off — the persistent current-threshold route

There is a **second** way to switch the headlight off over the bus, distinct from the `0x2F` io*set force in [headlight-diagnostic-control.md](headlight-diagnostic-control.md), and **it persists across power cycles**. It works by lying to the VCU about the beam's fault window: write the beam's maximum-current threshold \_below* what the beam actually draws, and at the next beam initialisation the VCU declares the circuit faulted and brings the beam up off.

This corrects the "the avenue is closed" verdict in [dash-command-channel.md](dash-command-channel.md): that is true of the _non-diagnostic_ channel, but false once a diagnostic session is on the table — there are two diagnostic routes, not one.

## The mechanism

VCU-Safety (`0xA8`) decides the beam is healthy only while its sensed current sits inside a `[MIN..MAX]` window. Three stored calibration parameters (`emdiag_vcu.py` PARAM table, group `LIGHTS`, bank 1, all uint16, mA):

| idx | param                                | factory |
| --- | ------------------------------------ | ------- |
| 240 | `BEAM_MAX_CURR_TH`                   | 7500 mA |
| 241 | `BEAM_HILO_CURR_TH` (low/high split) | 3750 mA |
| 242 | `BEAM_MIN_CURR_TH`                   | 1500 mA |

Drop `BEAM_MAX` below the real draw (this bike: ~3600 mA) and the beam current is now "over max". The VCU reads that as an over-current fault and refuses to drive the output — storing **`B1012` HIGH BEAM / `B1009` LOW BEAM OPEN CIRCUIT** (the "low circuit amps" complaint a rider sees on the dash). Raising `BEAM_MIN` above the draw is the mirror-image bulb-out route.

Reads are ReadDataByCommonID (`22 <id_hi> <id_lo>`), writes are WriteDataByCommonID (`2E <id_hi> <id_lo> <value_be>`), where `id = (bank << 12) | idx` and bank = 1 — so `BEAM_MAX` is `0x10F0`. Both sit behind the same `0x10`/`0x27` session + SecurityAccess as the io_set route (`calc_key` = swap-adjacent-bits(seed) − `0x3E5F4542`, confirmed again here).

## On-bike results (2026-08-27, this Eva Ribelle) — CONFIRMED WORKING

Run from the Pi with `scripts/beam-threshold.ts`. Bike parked, key on, headlight on, not charging.

1. **Recon.** Thresholds all read factory (7500 / 3750 / 1500); live beam sense (io_get control 18) read **3633 mA** — inside the window, so the beam is on and un-faulted, as expected.
2. **Write `BEAM_MAX_CURR_TH := 1810 mA`** (half the measured draw). Write accepted, read-back confirmed 1810. **But the beam did NOT cut mid-session** — the sense still read 3673 mA with the draw now sitting _above_ the 1810 max. So the over-max threshold is **not** a continuous live cutoff.
3. **Key cycle.** Key off ~5 s, key on. **The beam came up OFF, with a beam-fault warning on the dash** — sense now reads **0 mA**. This is the whole point: the threshold is enforced at **beam initialisation**, not continuously, which is why the original rider report was of the light being off _after_ a restart.
4. **Restore.** Writing all three back to factory read back clean. The beam stayed off for the rest of that power-on (the fault had latched), then a final key cycle **brought the beam back on and the fault self-cleared** — no explicit ClearDiagnosticInformation was needed on this bike.

## How this compares to the io_set route

|  | io_set force (control 17) | threshold write (`BEAM_MAX`) |
| --- | --- | --- |
| Service | `0x2F` InputOutputControl | `0x2E` WriteDataByCommonID |
| Effect | immediate, beam drops at once | takes effect at next beam init (key cycle) |
| Duration | decays in <40 ms — needs a ~5 ms re-assert loop | **persists across power cycles** until written back |
| Side effect | none stored | stores `B1009`/`B1012`, shown on the dash |
| Undo | stop re-asserting / StopSession | `--restore` (factory thresholds); fault self-clears next clean key cycle |

Neither is a _broadcast_ frame and neither is non-diagnostic — both need the VCU-Safety session + SecurityAccess. A true no-diagnostic, works-while-riding "off" still points at hardware (tapping the low-beam switch input), as [dash-command-channel.md](dash-command-channel.md) notes.

## Relation to this repo's `0x2E`/`0x27` ban

cool-eva walls off `0x2E`, `0x27` and `0x2F` on purpose — `param-codec.ts` is read-only _by construction_. `scripts/beam-threshold.ts` deliberately crosses that line, same footing as `scripts/headlight-off.ts` and `probe-charge-stop.ts`. It is a scratch probe, not shipped: it always reads back and re-checks the live draw, and `--restore` is first-class precisely because the write is persistent. This doc records how the beam is controlled; it does not implement it in the app.
