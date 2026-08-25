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
// Stopping a charge is a DIFFERENT command, cracked 2026-08-25 by a whole-bus capture of the
// rider's two-press Mode stop: it is a PAIR of frames sent once each — 0x120 `96 ff 01 …` AND
// 0x121 `16 ff 01 …` (note 0x96 = 0x16 | 0x80, the 0x120 request-twin carrying the same opcode
// with the high bit set). Injecting the pair is PROVEN to end the charge on-bike; injecting only
// the 0x121 half armed the "interruption in progress" prompt but never completed. So stop is not
// a current-limit frame with a flag cleared — it is opcode 0x16, and it takes both ids. See
// buildChargeStopCommand below and docs/can-0x121-charge-command.md § "CRACKED".

export const CHARGE_COMMAND_CAN_ID = 0x121;

/** The request-twin id of 0x121. The captured two-press stop put a frame on BOTH at once. */
export const CHARGE_REQUEST_CAN_ID = 0x120;

/** b0 opcodes that carry a current in b2. See charge-setpoint.ts for the other seven on this id. */
const DC_CURRENT_LIMIT_OPCODE = 0x18;
const AC_CURRENT_LIMIT_OPCODE = 0x1a;

/** b1 in all 596 captured frames of both ids, opcode regardless — a separator, not data. */
const SEPARATOR_BYTE = 0xff;

/** b3 = 1 means "a limit is in force"; only the two current-limit opcodes ever set it. */
const LIMIT_IN_FORCE = 1;

/**
 * The stop-charging opcode (b0). On 0x121 it is `0x16`; the 0x120 request-twin carries the same
 * opcode ORed with 0x80 (`0x96`). b2 = 1, b1 = 0xFF, b3 = 0 (NOT a limit-in-force frame), tail zero.
 */
const STOP_OPCODE = 0x16;
const STOP_REQUEST_TWIN_BIT = 0x80;
const STOP_ARG_BYTE = 1;

export type ChargeMode = "ac" | "dc";

/** One frame of a multi-frame command: the id it rides on and its 8 payload bytes. */
export interface ChargeFrame {
  id: number;
  data: Uint8Array;
}

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

/**
 * Builds the two frames that stop an active charge, in the order the dash puts them on the bus.
 * Pure. Source-agnostic — the SAME pair ends both AC and DC sessions (it emulates the Mode
 * button, which does not care how the bike is charging).
 *
 * The pair is `0x120: 96 ff 01 …` then `0x121: 16 ff 01 …`, exactly as captured 2026-08-25 and
 * proven to complete the stop on-bike. Injecting only the 0x121 half arms the "interruption in
 * progress" prompt but never finishes; the 0x120 companion is the missing commit, so both must go.
 */
export function buildChargeStopCommand(): ChargeFrame[] {
  const request = new Uint8Array(8);
  request[0] = STOP_OPCODE | STOP_REQUEST_TWIN_BIT;
  request[1] = SEPARATOR_BYTE;
  request[2] = STOP_ARG_BYTE;
  const command = new Uint8Array(8);
  command[0] = STOP_OPCODE;
  command[1] = SEPARATOR_BYTE;
  command[2] = STOP_ARG_BYTE;
  return [
    { id: CHARGE_REQUEST_CAN_ID, data: request },
    { id: CHARGE_COMMAND_CAN_ID, data: command },
  ];
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
