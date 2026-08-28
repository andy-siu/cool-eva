import { canIdsFor, identifierForIndex, parseResponseFrame, toHex } from "../src/vcu/param-codec.ts";

// Reads — and, with a write flag, changes — the VCU-Safety headlight current-threshold parameters
// that decide when the beam output is cut. See docs/headlight-diagnostic-control.md and the
// threshold-write route it documents. This is a SEPARATE mechanism from scripts/headlight-off.ts:
// that one forces the beam OUTPUT (io_set 0x2F control 17), an override that decays in <40 ms and
// needs a 5 ms re-assert to hold. This one writes a STORED CALIBRATION (WriteDataByCommonID 0x2E) —
// it persists across power cycles until written back. That is why --restore exists and why every
// write reads back and re-checks the live draw.
//
//   sudo systemctl stop cool-eva      # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/beam-threshold.ts                 # READ-ONLY recon
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --off [--value <mA>] [--via-min]
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --restore       # factory defaults back
//   sudo node --experimental-strip-types scripts/beam-threshold.ts --write max 1000 # raw single-threshold write
//
// The theory (from the on-bike report of "turned the headlight off, complained about low circuit
// amps"): the VCU decides the beam is faulted when the sensed current leaves its [MIN..MAX] window.
// Default --off writes BEAM_MAX_CURR_TH BELOW the measured draw, so sensed current sits ABOVE the
// max threshold — the VCU reads over-current and cuts the output. The beam then draws ~0, which is
// what stores the LOW/HIGH BEAM OPEN CIRCUIT DTC (B1009/B1012 — the "low circuit amps" complaint).
// --via-min instead writes BEAM_MIN_CURR_TH ABOVE the draw (immediate bulb-out). Either persists.
//
// ⚠️ Deliberately crosses this repo's standing ban on transmitting 0x2E/0x27 — every shipped path
// refuses those (param-codec.ts is read-only by construction). SCRATCH probe, same footing as
// scripts/headlight-off.ts. It reuses param-codec's PROVEN framing helpers but builds the write
// frame itself, because the shipped codec cannot.
//
// ⚠️ A write here is PERSISTENT. It stores a DTC the VCU keeps until cleared (EMSuite / the
// em-diagnostics DTC page). --restore puts the factory thresholds back but does NOT clear the DTC.
//
// PRECONDITIONS for a write: bike on its stand, key ON, headlight on, clear of moving parts, not ridden.

const NODE = "A8"; // VCU-Safety — the micro that owns the LIGHTS parameter group (ecu 168 / 0xA8)
const TARGET_ADDRESS = 0xa8;

const SERVICE_START_SESSION = 0x10;
const STANDARD_SESSION = 0x81;
const SERVICE_STOP_SESSION = 0x20;
const SERVICE_SECURITY = 0x27;
const SERVICE_READ_PARAM = 0x22; // ReadDataByCommonID
const SERVICE_WRITE_PARAM = 0x2e; // WriteDataByCommonID
const SERVICE_IO_CONTROL = 0x2f; // only sub 0x01 (io_get_reading) is used here — a read of the live sense
const NEGATIVE_RESPONSE = 0x7f;

const SECURITY_REQUEST_SEED = 0x01;
const SECURITY_SEND_KEY = 0x02;
const IO_GET_READING = 0x01;
const NRC_SECURITY_ACCESS_DENIED = 0x33;

// The VCU family's SecurityAccess key: swap adjacent bits of the 32-bit seed, then subtract
// 0x3E5F4542 (fixed per module). Confirmed on this bike — see docs/headlight-diagnostic-control.md.
const KEY_SUBTRAHEND = 0x3e5f4542;

// VCU-Safety LIGHTS parameters (emdiag_vcu.py PARAM table): index, byte width, factory default in mA.
// All bank 1, all uint16. The beam's fault window is [MIN..MAX]; HILO is the low/high split.
const BEAM_PARAMS = {
  max: { index: 240, name: "BEAM_MAX_CURR_TH", bytes: 2, factory: 7500 },
  hilo: { index: 241, name: "BEAM_HILO_CURR_TH", bytes: 2, factory: 3750 },
  min: { index: 242, name: "BEAM_MIN_CURR_TH", bytes: 2, factory: 1500 },
} as const;
type BeamParamKey = keyof typeof BEAM_PARAMS;

// The beam's current sense, read via io_get (0x2F sub 0x01) so we can size the write and observe the
// effect. Same control the LOW_BEAM guided test reads (tests_data.py control 18 on ecu 168).
const BEAM_SENSE_CONTROL = 18;

const NRC_NAMES: Record<number, string> = {
  0x12: "subFunctionNotSupported",
  0x22: "conditionsNotCorrect",
  0x31: "requestOutOfRange",
  0x33: "securityAccessDenied",
  0x78: "responsePending",
};

interface Reply {
  ok: boolean;
  service: number | null;
  negativeCode: number | null;
  payload: Uint8Array; // excludes the address and PCI byte; includes the service byte
}

const options = parseArguments(process.argv.slice(2));
const { request: REQUEST_CAN_ID, response: RESPONSE_CAN_ID } = canIdsFor(NODE);

console.log(
  `beam-threshold probe — target VCU-Safety (0x${TARGET_ADDRESS.toString(16)}) on ${hexId(REQUEST_CAN_ID)}/${hexId(RESPONSE_CAN_ID)}`
);
describeMode();

// Dynamic import so arg parsing works on macOS/CI where socketcan is not built.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

console.log("\nbringing can0 up ACTIVE (TX enabled)…");
await bringUpCan("can0", true);
const channel = openChannel("can0");

let pending: ((reply: Reply) => void) | null = null;
channel.addListener("onMessage", message => {
  if (message.id !== RESPONSE_CAN_ID || pending === null) {
    return;
  }
  const frame = parseResponseFrame(Uint8Array.from(message.data));
  if (frame.kind !== "payload") {
    return; // multi-frame (none expected here) or another tester's traffic
  }
  const reply = interpret(frame.payload);
  if (reply.negativeCode === 0x78) {
    console.log("    … responsePending (0x78), waiting");
    return;
  }
  const resolve = pending;
  pending = null;
  resolve(reply);
});
channel.start();

await runSequence();
process.exit(0);

// ── the sequence ───────────────────────────────────────────────────────────────

async function runSequence(): Promise<void> {
  console.log("\n→ StartDiagnosticSession (10 81)");
  const session = await transact([SERVICE_START_SESSION, STANDARD_SESSION]);
  if (!session.ok) {
    console.log(`  ✗ VCU-Safety refused the session: ${describe(session)}`);
    console.log("    Without a session nothing here can proceed. Is the key ON and the bike awake?");
    return;
  }
  console.log("  ✓ session open");

  if (!(await unlock())) {
    return;
  }

  const before = await readAll("before");

  if (options.mode === "read") {
    console.log("\nrecon complete — nothing was written. Recommendation:");
    recommend(before.senseMilliamps);
    await stopSession();
    return;
  }

  const writes = plannedWrites(before.senseMilliamps);
  if (writes === null) {
    await stopSession();
    return;
  }
  for (const write of writes) {
    if (!(await writeParam(write.key, write.value))) {
      console.log("  aborting — a write failed; earlier writes (if any) already persisted. Consider --restore.");
      await stopSession();
      return;
    }
  }

  await readAll("after");
  console.log(
    "\nnote: the threshold change is a STORED calibration and persists across power cycles. " +
      "Run with --restore to put the factory values back. A beam OPEN CIRCUIT DTC (B1009/B1012) " +
      "will have been stored and must be cleared separately."
  );
  await stopSession();
}

/** Plan the writes for --off / --restore / --write. Null means refuse (with a printed reason). */
function plannedWrites(senseMilliamps: number | null): { key: BeamParamKey; value: number }[] | null {
  if (options.mode === "restore") {
    return (Object.keys(BEAM_PARAMS) as BeamParamKey[]).map(key => ({ key, value: BEAM_PARAMS[key].factory }));
  }
  if (options.mode === "write") {
    return [{ key: options.writeKey, value: options.writeValue }];
  }
  // --off: derive a value from the live draw unless one was given.
  const key: BeamParamKey = options.viaMin ? "min" : "max";
  if (options.value !== null) {
    return [{ key, value: options.value }];
  }
  if (senseMilliamps === null || senseMilliamps < 600) {
    console.log(
      `  ✗ --off could not read a plausible beam draw (got ${senseMilliamps ?? "no reply"} mA). ` +
        "Turn the headlight on, or pass --value <mA> explicitly."
    );
    return null;
  }
  // MAX route: set the ceiling clearly BELOW the draw so sensed current reads over-max → cut.
  // MIN route: set the floor clearly ABOVE the draw so sensed current reads under-min → bulb-out.
  const value = options.viaMin ? Math.round(senseMilliamps * 1.5) : Math.round(senseMilliamps * 0.5);
  console.log(`  --off: measured draw ${senseMilliamps} mA → writing ${BEAM_PARAMS[key].name} = ${value} mA`);
  return [{ key, value }];
}

// ── UDS operations ───────────────────────────────────────────────────────────

async function unlock(): Promise<boolean> {
  console.log("\n→ SecurityAccess: request seed (27 01)");
  const seedReply = await transact([SERVICE_SECURITY, SECURITY_REQUEST_SEED]);
  if (!seedReply.ok || seedReply.payload.length < 6) {
    console.log(`  ✗ seed refused: ${describe(seedReply)}`);
    return false;
  }
  const seed = readUint32(seedReply.payload, 2);
  if (seed === 0) {
    console.log("  ✓ already unlocked (seed = 0)");
    return true;
  }
  const key = calcKey(seed);
  console.log(`  seed 0x${seed.toString(16).padStart(8, "0")} → key 0x${key.toString(16).padStart(8, "0")}`);
  const keyReply = await transact([SERVICE_SECURITY, SECURITY_SEND_KEY, ...uint32Bytes(key)]);
  if (!keyReply.ok) {
    console.log(`  ✗ key rejected: ${describe(keyReply)}`);
    return false;
  }
  console.log("  ✓ unlocked");
  return true;
}

/** Read all three beam thresholds plus the live beam draw, and print them lined up. */
async function readAll(label: string): Promise<{ senseMilliamps: number | null }> {
  console.log(`\n[${label}]`);
  for (const key of Object.keys(BEAM_PARAMS) as BeamParamKey[]) {
    const parameter = BEAM_PARAMS[key];
    const value = await readParam(key);
    const text = value === null ? "unreadable" : `${value} mA`;
    console.log(`  ${parameter.name.padEnd(18)} (idx ${parameter.index}) = ${text}   [factory ${parameter.factory}]`);
  }
  const senseMilliamps = await readSense();
  console.log(
    `  beam sense (io_get ${BEAM_SENSE_CONTROL})     = ${senseMilliamps === null ? "no reply" : `${senseMilliamps} mA`}`
  );
  return { senseMilliamps };
}

/** ReadDataByCommonID for one beam parameter. Returns its value in mA, or null if unreadable. */
async function readParam(key: BeamParamKey): Promise<number | null> {
  const parameter = BEAM_PARAMS[key];
  const identifier = identifierForIndex(parameter.index);
  const reply = await transact([SERVICE_READ_PARAM, (identifier >> 8) & 0xff, identifier & 0xff]);
  if (!reply.ok || reply.payload.length < 3 + parameter.bytes) {
    return null;
  }
  // Positive 0x62 reply echoes the 2-byte identifier, then the value bytes (big-endian).
  const value = reply.payload.subarray(reply.payload.length - parameter.bytes);
  return value.reduce((accumulated, byte) => accumulated * 256 + byte, 0);
}

/** WriteDataByCommonID for one beam parameter, then read it back and confirm. Retries once on 0x33. */
async function writeParam(key: BeamParamKey, value: number): Promise<boolean> {
  const parameter = BEAM_PARAMS[key];
  const identifier = identifierForIndex(parameter.index);
  const valueBytes = uintBytes(value, parameter.bytes);
  const send = () => transact([SERVICE_WRITE_PARAM, (identifier >> 8) & 0xff, identifier & 0xff, ...valueBytes]);

  console.log(
    `\n→ WriteDataByCommonID: ${parameter.name} (idx ${parameter.index}) := ${value} mA  [${toHex(Uint8Array.from(valueBytes))}]`
  );
  let written = await send();
  if (written.negativeCode === NRC_SECURITY_ACCESS_DENIED) {
    console.log("    unlock lapsed (securityAccessDenied) — re-unlocking and retrying once");
    if (!(await unlock())) {
      return false;
    }
    written = await send();
  }
  if (!written.ok) {
    console.log(`  ✗ write refused: ${describe(written)}`);
    return false;
  }
  const readBack = await readParam(key);
  if (readBack !== value) {
    console.log(`  ✗ read-back mismatch: wrote ${value}, reads ${readBack ?? "unreadable"}`);
    return false;
  }
  console.log(`  ✓ write accepted and confirmed (reads ${readBack} mA)`);
  return true;
}

/** Live beam current via io_get (0x2F sub 0x01). Signed 16-bit trailing, per EMSuite's decode. */
async function readSense(): Promise<number | null> {
  const reply = await transact([
    SERVICE_IO_CONTROL,
    (BEAM_SENSE_CONTROL >> 8) & 0xff,
    BEAM_SENSE_CONTROL & 0xff,
    IO_GET_READING,
  ]);
  if (!reply.ok) {
    return null;
  }
  const afterService = reply.payload.subarray(1);
  if (afterService.length < 2) {
    return null;
  }
  const raw = (afterService[afterService.length - 2] << 8) | afterService[afterService.length - 1];
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

async function stopSession(): Promise<void> {
  console.log("\n→ StopDiagnosticSession (20)");
  await transact([SERVICE_STOP_SESSION], { timeoutMs: 300, quietTimeout: true });
  console.log("done.");
}

function recommend(senseMilliamps: number | null): void {
  if (senseMilliamps === null || senseMilliamps < 600) {
    console.log("  (beam draw not readable — turn the headlight on to see the recommendation)");
    return;
  }
  const maxTarget = Math.round(senseMilliamps * 0.5);
  const minTarget = Math.round(senseMilliamps * 1.5);
  console.log(`  beam draws ${senseMilliamps} mA. To force it off persistently:`);
  console.log(`    --off            → BEAM_MAX_CURR_TH ≈ ${maxTarget} mA (draw sits over max → over-current cut)`);
  console.log(`    --off --via-min  → BEAM_MIN_CURR_TH ≈ ${minTarget} mA (draw sits under min → bulb-out)`);
  console.log("  Then --restore to undo. Both store a beam OPEN CIRCUIT DTC.");
}

// ── transport ────────────────────────────────────────────────────────────────

/** One request/response exchange. Extended-addressed single frame to VCU-Safety; reply to the tester. */
function transact(payload: number[], config: { timeoutMs?: number; quietTimeout?: boolean } = {}): Promise<Reply> {
  const timeoutMs = config.timeoutMs ?? 600;
  if (payload.length > 6) {
    throw new Error(`beam-threshold: payload of ${payload.length} bytes does not fit one extended-addressed frame`);
  }
  const frame = Buffer.alloc(8);
  frame[0] = TARGET_ADDRESS;
  frame[1] = payload.length;
  for (let index = 0; index < payload.length; index += 1) {
    frame[2 + index] = payload[index];
  }
  return new Promise<Reply>(resolve => {
    const timer = setTimeout(() => {
      if (pending !== null) {
        pending = null;
        if (!config.quietTimeout) {
          console.log("    … no reply (timeout)");
        }
        resolve({ ok: false, service: null, negativeCode: null, payload: new Uint8Array() });
      }
    }, timeoutMs);
    pending = reply => {
      clearTimeout(timer);
      resolve(reply);
    };
    channel.send({ id: REQUEST_CAN_ID, ext: false, rtr: false, data: frame });
  });
}

function interpret(payload: Uint8Array): Reply {
  if (payload.length >= 3 && payload[0] === NEGATIVE_RESPONSE) {
    return { ok: false, service: null, negativeCode: payload[2], payload };
  }
  return { ok: true, service: payload[0], negativeCode: null, payload };
}

function describe(reply: Reply): string {
  if (reply.negativeCode !== null) {
    return `NEGATIVE NRC 0x${reply.negativeCode.toString(16)} (${NRC_NAMES[reply.negativeCode] ?? "?"})`;
  }
  if (reply.service === null) {
    return "no reply";
  }
  return `positive, data ${toHex(reply.payload)}`;
}

function describeMode(): void {
  if (options.mode === "read") {
    console.log("mode: READ-ONLY recon — reading beam thresholds and live draw. Nothing is written.");
    return;
  }
  if (options.mode === "restore") {
    console.log("mode: RESTORE — writing the three beam thresholds back to their factory defaults.");
  } else if (options.mode === "write") {
    console.log(
      `mode: WRITE — ${BEAM_PARAMS[options.writeKey].name} := ${options.writeValue} mA (raw single-threshold write).`
    );
  } else {
    console.log(
      `mode: OFF — writing ${options.viaMin ? "BEAM_MIN above" : "BEAM_MAX below"} the beam draw to cut it (PERSISTENT).`
    );
  }
  console.log(
    "⚠️  Bike on its stand, key ON, headlight on, clear of moving parts. The write persists across power cycles; --restore undoes it."
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function calcKey(seed: number): number {
  const swapped = (((seed >>> 1) & 0x55555555) | ((seed << 1) & 0xaaaaaaaa)) >>> 0;
  return (swapped - KEY_SUBTRAHEND) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function uint32Bytes(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Big-endian byte array of a non-negative integer in `width` bytes. */
function uintBytes(value: number, width: number): number[] {
  const bytes = new Array<number>(width);
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}

function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

type Mode = "read" | "off" | "restore" | "write";

interface Options {
  mode: Mode;
  value: number | null; // --value <mA> for --off (null = derive from live draw)
  viaMin: boolean; // --via-min: raise BEAM_MIN above the draw instead of lowering BEAM_MAX below it
  writeKey: BeamParamKey; // --write <key> <mA>
  writeValue: number;
}

function parseArguments(argv: string[]): Options {
  let mode: Mode = "read";
  let value: number | null = null;
  let viaMin = false;
  let writeKey: BeamParamKey = "max";
  let writeValue = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--off") {
      mode = "off";
    } else if (flag === "--restore") {
      mode = "restore";
    } else if (flag === "--via-min") {
      viaMin = true;
    } else if (flag === "--value") {
      value = Number(argv[++index]);
    } else if (flag === "--write") {
      mode = "write";
      const key = argv[++index];
      if (key !== "max" && key !== "min" && key !== "hilo") {
        throw new Error(`--write key must be max|min|hilo, got ${key}`);
      }
      writeKey = key;
      writeValue = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }

  if (mode === "off" && viaMin === false && value !== null && !Number.isFinite(value)) {
    throw new Error(`--value must be a number of milliamps, got ${value}`);
  }
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 0xffff)) {
    throw new Error(`--value must be a 16-bit milliamp value, got ${value}`);
  }
  if (mode === "write" && (!Number.isInteger(writeValue) || writeValue < 0 || writeValue > 0xffff)) {
    throw new Error(`--write value must be a 16-bit milliamp value, got ${writeValue}`);
  }
  return { mode, value, viaMin, writeKey, writeValue };
}
