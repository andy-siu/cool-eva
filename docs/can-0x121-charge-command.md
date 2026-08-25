# CAN 0x121 — the dash↔VCU charge-current command

`0x121` is the command channel from the dashboard to the VCU. It is **event-based**: the dash emits a frame when the rider moves the charge-current dial, then repeats it. Decode-only handling lives in `src/can/charge-setpoint.ts`; the transmit mirror is `src/can/charge-command.ts`.

## Current-limit frames

Two opcodes carry a current limit, both with the current in **b2 as whole amps (1:1)**:

| b0 opcode | meaning  | b1   | b2       | b3  | b4         | b5–7 |
| --------- | -------- | ---- | -------- | --- | ---------- | ---- |
| `0x18`    | DC limit | `ff` | amps 1:1 | 1   | ceiling 75 | 0    |
| `0x1A`    | AC limit | `ff` | amps 1:1 | 1   | ceiling 15 | 0    |

- `b1 = 0xFF` is a separator in all captured frames, opcode regardless.
- `b3 = 1` means "a limit is in force"; only these two opcodes set it.
- `b5–7` stay zero; a non-zero tail marks a different opcode's layout.

### DC ceiling (b4 = 75)

The DC ceiling is the static `fast_dc_limit_max_a` (0x625 b2 = 75), broadcast on a merely-awake bike. DC `b2` was verified 1:1 in the captured corpus.

### AC ceiling (b4 = 15) — captured 2026-08-25

AC (`0x1A`) was originally the never-decoded half; `b4` for it was a guess (32). A `--listen` capture of the **dash's own** frames while dialling the AC current settled it:

```
1a ff 02 01 0f 00 00 00   → 2 A, ceiling 15
1a ff 03 01 0f 00 00 00   → 3 A, ceiling 15
1a ff 02 01 0f 00 00 00   → 2 A
1a ff 01 01 0f 00 00 00   → 1 A
```

So AC `b2` **is** amps 1:1 (1↔1, 2↔2, 3↔3), and the AC ceiling is `b4 = 0x0f = 15`. This 15 is **not** `ac_supply_limit_a` (0x620 b1, which read 31 in the same session) — it is the pilot/cable rating the dash tracks, and is therefore **likely charger-specific**. A command should echo the dash's last observed AC `b4` rather than hardcode 15.

## Injection is honoured — with the right b4

A Pi-injected `0x121` **is** obeyed by the VCU (the dash's charge-current SET display changes on transmit — proven 2026-08-24 on an AC session). The earlier mystery, where injecting `--amps 1` and `--amps 3` both drove the dash to a fixed **10 A**, is explained by the wrong ceiling: those frames carried `b4 = 32`, which the VCU rejected, falling back to a ~10 A default. With the correct `b4 = 15`, `b2` should be read as sent. (Pending confirmation: an injected AC command with a non-full battery to watch the delivered current follow, not just the dash SET display.)

## Not a current-limit frame

`16 ff 01 00 00 00 00 00` (opcode `0x16`, `b3 = 0`) appeared once at the end of a listen capture. It is a different `0x121` action (menu/apply/toggle), unrelated to setting the current — noted here so it is not mistaken for one. Stop-charging is likewise a different opcode (`b3 = 0` on `0x02/0x1D/0x1E/0x2C`, per `charge-setpoint.ts`), not a current-limit frame with a flag cleared.
