// Building the rider's charge-current command — the TRANSMIT counterpart to charge-setpoint.ts,
// which only decodes it. CAN 0x121, the dash↔VCU command channel: opcode 0x18 sets the DC limit
// and 0x1A the AC limit, both putting amps in b2. The byte layout, the b1 = 0xFF separator, the
// b3 = 1 "limit in force" flag and the 1 ≤ b2 ≤ b4 ceiling relation are all lifted verbatim from
// the decode gate in charge-setpoint.ts, so a frame this builds is one decodeChargeSetpointFrame
// would accept — which is the round-trip the check below rests on.
//
// NOTHING in the running service transmits this yet. Injection is PROVEN honoured (a Pi-sent
// 0x121 changes the dash's setting), and the field layout is confirmed against the dash's OWN
// frames captured 2026-08-25: b2 = amps 1:1 for AC too (dash sent 1a ff 01/02/03 01 0f … for
// 1/2/3 A). The one correction from that capture: the AC ceiling in b4 is 0x0f = 15, NOT the
// 32 first guessed and NOT ac_supply_limit_a (31) — it is the pilot/cable rating, so it is
// likely charger-specific. A caller should echo the dash's last observed AC b4 rather than
// hardcode one; a wrong b4 makes the VCU reject the value and fall back to a ~10 A default.
// The DC ceiling stays the static 75 (fast_dc_limit_max_a). See docs/can-0x121-charge-command.md.
//
// The stop-charging command is deliberately NOT here. charge-setpoint.ts records that stop is a
// DIFFERENT opcode (b3 = 0 belongs to 0x02/0x1D/0x1E/0x2C, not to 0x18/0x1A), so a "stop" is not
// this frame with a flag cleared and must not be faked as one.

export const CHARGE_COMMAND_CAN_ID = 0x121;

/** b0 opcodes that carry a current in b2. See charge-setpoint.ts for the other seven on this id. */
const DC_CURRENT_LIMIT_OPCODE = 0x18;
const AC_CURRENT_LIMIT_OPCODE = 0x1a;

/** b1 in all 596 captured frames of both ids, opcode regardless — a separator, not data. */
const SEPARATOR_BYTE = 0xff;

/** b3 = 1 means "a limit is in force"; only the two current-limit opcodes ever set it. */
const LIMIT_IN_FORCE = 1;

export type ChargeMode = "ac" | "dc";

/**
 * Packs a charge-current-limit command into the 8-byte 0x121 frame. Pure.
 *
 * `selectedAmps` is what to ask for; `ceilingAmps` is the b4 the dash pairs with it (the
 * configured maximum — 75 for DC). Both are whole amps. Throws rather than emit a frame the
 * VCU's own decode would reject: 1 ≤ selected ≤ ceiling ≤ 255, which is the exact relation
 * charge-setpoint.ts gates on. A zero request is not "off" — that is the stop command, a
 * different opcode this builder does not make.
 */
export function buildChargeCurrentCommand(mode: ChargeMode, selectedAmps: number, ceilingAmps: number): Uint8Array {
  if (!Number.isInteger(selectedAmps) || !Number.isInteger(ceilingAmps)) {
    throw new Error(`charge-command: amps must be whole numbers, got selected=${selectedAmps} ceiling=${ceilingAmps}`);
  }
  if (ceilingAmps < 1 || ceilingAmps > 255) {
    throw new Error(`charge-command: ceiling ${ceilingAmps} A is outside the 1…255 this frame's byte can hold`);
  }
  if (selectedAmps < 1 || selectedAmps > ceilingAmps) {
    // Below 1 or above the ceiling is a frame the VCU decode drops (charge-setpoint.ts §b2/b4),
    // so sending it could only either do nothing or, worse, be read as some other opcode's layout.
    throw new Error(`charge-command: ${selectedAmps} A must be between 1 and the ceiling ${ceilingAmps} A`);
  }
  const frame = new Uint8Array(8);
  frame[0] = mode === "dc" ? DC_CURRENT_LIMIT_OPCODE : AC_CURRENT_LIMIT_OPCODE;
  frame[1] = SEPARATOR_BYTE;
  frame[2] = selectedAmps;
  frame[3] = LIMIT_IN_FORCE;
  frame[4] = ceilingAmps;
  // b5-7 stay zero: a tail in use marks a different opcode's layout (charge-setpoint.ts).
  return frame;
}

export interface DecodedChargeCommand {
  mode: ChargeMode;
  selectedAmps: number;
  ceilingAmps: number;
}

/**
 * Unpacks a 0x121 current-limit command back to its fields, or null if the frame is not one.
 *
 * Exists to check buildChargeCurrentCommand in both directions — a builder checked only against
 * its own output proves nothing — and to read a captured 0x121 command without the bit shuffling.
 * The gate mirrors charge-setpoint.ts exactly so "builds a frame the bike accepts" is a real claim.
 */
export function decodeChargeCurrentCommand(frame: Uint8Array): DecodedChargeCommand | null {
  if (frame.length !== 8 || frame[1] !== SEPARATOR_BYTE || frame[3] !== LIMIT_IN_FORCE) {
    return null;
  }
  if (frame[5] !== 0 || frame[6] !== 0 || frame[7] !== 0) {
    return null;
  }
  let mode: ChargeMode;
  if (frame[0] === DC_CURRENT_LIMIT_OPCODE) {
    mode = "dc";
  } else if (frame[0] === AC_CURRENT_LIMIT_OPCODE) {
    mode = "ac";
  } else {
    return null;
  }
  const selectedAmps = frame[2];
  const ceilingAmps = frame[4];
  if (selectedAmps < 1 || selectedAmps > ceilingAmps) {
    return null;
  }
  return { mode, selectedAmps, ceilingAmps };
}
