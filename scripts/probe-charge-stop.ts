import { decodeFrame } from "../src/can/decode.ts";
import { CHARGE_COMMAND_CAN_ID } from "../src/can/charge-command.ts";

// GARAGE EXPERIMENT to find a "stop charging" command by transmit-and-observe. A whole-bus
// capture proved the rider's Mode-hold stop puts NOTHING on the bus — it is a direct VCU input,
// not a CAN message (docs/can-0x121-charge-command.md § "Stopping a charge is NOT a dash
// command"). So there is no frame to replay; the only route left is to inject a CANDIDATE 0x121
// and watch whether the charge stops. Injecting 0x121 current limits is already proven honoured.
//
//   sudo systemctl stop cool-eva     # the service owns can0; one raw socket at a time
//   sudo node --experimental-strip-types scripts/probe-charge-stop.ts --candidate mode16 [--send]
//     --candidate NAME  one of the named guesses below (see CANDIDATES)
//     --bytes "16 ff …" eight space-separated hex bytes, to try an arbitrary frame
//     --send            actually TRANSMIT. Without it this is a dry run that prints the frame only.
//     --repeat N        send the frame N times, 500 ms apart (default 1) — 0x121 is event-based
//     --hold S          STREAM the frame at ~10 Hz for S seconds, emulating a held Mode button
//     --increment B     during --hold, increment byte B (0–7) by 1 each frame, wrapping at 256 —
//                       tests whether the hold carries a climbing counter, not a static payload
//     --taps N          send N DISCRETE presses: a short burst, then a silent release gap, N times.
//                       The real stop is two Mode presses (unlock, then interrupt) — a press is an
//                       edge (frames start→stop→start), which a continuous --hold stream never is.
//     --pair            replay the EXACT captured stop: 0x120 `96 ff 01…` then 0x121 `16 ff 01…`,
//                       once each. This is what the dash actually put on the bus (see 2026-08-25).
//     --request-only    send ONLY the 0x120 half `96 ff 01…`, no 0x121 — the mirror of the earlier
//                       0x121-only test. Tells us whether the request-twin alone commits the stop.
//     --watch S         seconds to watch before and after the send (default 20)
//
// 2026-08-25 CRACKED by whole-bus capture of the two-press stop: the dash emits a PAIR of frames,
// once each, at the moment of the stop — `0x120: 96 ff 01 00 00 00 00 00` AND `0x121: 16 ff 01 00
// 00 00 00 00` (note 0x96 = 0x16 | 0x80). Our earlier injection of ONLY the 0x121 half armed the
// "interruption in progress" prompt but never completed; the missing piece was the 0x120 companion.
// `--pair` replays both exactly. (The earlier "hold puts nothing on the bus" capture was of a HOLD;
// a hold genuinely sends nothing — only the two-press gesture emits this pair.)
//
// ⚠️ This TRANSMITS an UNVALIDATED opcode on the bike's bus, so it is less understood than the
// current-limit probe. It is still bounded: the frame is a single 0x121 event, the setting is
// transient (unplugging resets it), and the rider overrides on the bike's own screen. Stopping a
// charge is the benign direction — worst case the charge halts, which is the goal. Try it on a
// charge you are willing to interrupt, watching the bike, and re-plug if a candidate does nothing.
//
// VERDICT: the stop we are hunting shows as ac_supply_limit_a → 0 (0x620), charger_enabled → 0
// (0x300), charge_limit_a → 0 (0x10a) and mains_v collapsing (0x306) within a few seconds. If the
// AFTER snapshot shows those, this candidate IS a stop command — record its bytes in the doc and
// build a transmitter. If nothing moves, the VCU ignored it; try the next candidate.

const WATCHED_KEYS = [
  "ac_supply_limit_a",
  "charger_enabled",
  "charge_limit_a",
  "charge_state",
  "mains_v",
  "mains_a",
  "dc_a",
  "ac_charging",
  "dc_charging",
  "charge_manager_status",
  "charge_type",
];

// The keys whose fall to zero (or collapse) is the signature of a stopped charge — checked for
// the AFTER verdict. mains_v is judged by a large drop, the rest by reaching zero.
const STOP_INDICATOR_KEYS = ["ac_supply_limit_a", "charger_enabled", "charge_limit_a"];

// Cadence for --hold: fast enough to read as a continuously-held button rather than discrete
// events, since opcode 0x16 sent once leaves the dash's "charge interruption in progress" hanging.
const HOLD_INTERVAL_MS = 100;

// A discrete Mode press for --taps: hold the frame briefly (a real press spans a few dash frames),
// then go silent long enough that the VCU registers a release before the next press. The stop is
// two presses, so the default TAPS below is 2; these shape each press's edge.
const TAP_PRESS_MS = 250;
const TAP_GAP_MS = 700;

// The request-twin id of 0x121. The captured two-press stop put a frame on BOTH at once.
const CHARGE_REQUEST_CAN_ID = 0x120;

// The exact stop the dash emitted (whole-bus capture, 2026-08-25), replayed by --pair in bus order.
const STOP_PAIR: { id: number; bytes: number[] }[] = [
  { id: CHARGE_REQUEST_CAN_ID, bytes: [0x96, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00] },
  { id: CHARGE_COMMAND_CAN_ID, bytes: [0x16, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00] },
];

interface Candidate {
  bytes: number[];
  why: string;
}

// Ordered by plausibility. mode16 is the one non-current-limit 0x121 opcode ever seen (once, at
// the end of a listen capture — a "menu/apply/toggle" per the doc). The zero-current guesses test
// whether the VCU reads "AC limit 0" as off, which its own decode gate (1 ≤ b2) would reject — so
// if one of those stops the charge, it is doing so as a distinct action, not as a limit of zero.
const CANDIDATES: Record<string, Candidate> = {
  mode16: {
    bytes: [0x16, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00],
    why: "opcode 0x16, the once-seen menu/apply/toggle action",
  },
  "ac-zero-limit": {
    bytes: [0x1a, 0xff, 0x00, 0x01, 0x0f, 0x00, 0x00, 0x00],
    why: "AC opcode, b2=0 amps with b3=1 limit-in-force",
  },
  "ac-zero-flag": {
    bytes: [0x1a, 0xff, 0x00, 0x00, 0x0f, 0x00, 0x00, 0x00],
    why: "AC opcode, b2=0 amps with b3=0 limit-not-in-force",
  },
  "dc-zero-flag": {
    bytes: [0x18, 0xff, 0x00, 0x00, 0x4b, 0x00, 0x00, 0x00],
    why: "DC opcode, b2=0 amps with b3=0 limit-not-in-force",
  },
};

const options = parseArguments(process.argv.slice(2));
const frame = Uint8Array.from(options.bytes);

if (options.pair) {
  console.log("\nreplaying the captured stop PAIR (exactly what the dash emitted):");
  for (const item of STOP_PAIR) {
    console.log(`  0x${item.id.toString(16)}  ${hex(Uint8Array.from(item.bytes))}`);
  }
} else if (options.requestOnly) {
  console.log(
    `\nsending ONLY the 0x120 request-twin: ${hex(Uint8Array.from(STOP_PAIR[0].bytes))}  — no 0x121 companion`
  );
} else {
  console.log(`\ncrafted 0x121 stop candidate: ${hex(frame)}  — ${options.why}`);
}

if (!options.send) {
  console.log("\n(dry run) nothing was transmitted. Add --send to actually inject it during a charge.");
  process.exit(0);
}

// Imported here, not at the top, so a dry run and the arg parsing still work on macOS/CI where
// socketcan (a Linux-only optionalDependency) is not built. Only the transmit path needs it.
const { bringUpCan, openChannel } = await import("../src/can/socket.ts");

const latest = new Map<string, number>();
console.log("\nbringing can0 up ACTIVE (TX enabled) and watching the bus…");
await bringUpCan("can0", true);
const channel = openChannel("can0");
channel.addListener("onMessage", message => {
  for (const { key, value } of decodeFrame(message.id, message.data)) {
    if (WATCHED_KEYS.includes(key)) {
      latest.set(key, value);
    }
  }
});
channel.start();

await watchWindow("BEFORE", options.watchSeconds);
const before = new Map(latest);

if (options.pair) {
  // Replay the exact stop the dash put on the bus: 0x120 then 0x121, once each, in capture order.
  // --repeat re-sends the whole pair a few times in case a single shot needs a nudge to commit.
  console.log(`\n→ replaying the stop PAIR ${options.repeat}×…`);
  for (let sent = 0; sent < options.repeat; sent += 1) {
    for (const item of STOP_PAIR) {
      sendFrame(item.id, Uint8Array.from(item.bytes));
      await sleep(20);
    }
    console.log(`  pair ${sent + 1}/${options.repeat} sent  ${snapshot()}`);
    await sleep(500);
  }
} else if (options.requestOnly) {
  // Send ONLY the 0x120 request-twin, no 0x121 — the mirror of the earlier 0x121-only test that
  // armed the prompt but never completed. If this alone stops the charge, 0x120 carries the commit.
  const request = STOP_PAIR[0];
  console.log(`\n→ sending the 0x120 request-twin ONLY ${options.repeat}×…`);
  for (let sent = 0; sent < options.repeat; sent += 1) {
    sendFrame(request.id, Uint8Array.from(request.bytes));
    console.log(`  send ${sent + 1}/${options.repeat}  ${snapshot()}`);
    await sleep(500);
  }
} else if (options.taps > 0) {
  // Emulate N discrete Mode presses: burst the frame for TAP_PRESS_MS, then fall silent for
  // TAP_GAP_MS so the VCU sees a release edge before the next press. The stop is unlock-then-
  // interrupt, so --taps 2 is the shape to try first.
  console.log(`\n→ sending ${options.taps} DISCRETE taps (${TAP_PRESS_MS}ms press / ${TAP_GAP_MS}ms release)…`);
  for (let tap = 0; tap < options.taps; tap += 1) {
    const burstFrames = Math.ceil(TAP_PRESS_MS / HOLD_INTERVAL_MS);
    for (let sent = 0; sent < burstFrames; sent += 1) {
      sendFrame(CHARGE_COMMAND_CAN_ID, frame);
      await sleep(HOLD_INTERVAL_MS);
    }
    console.log(`  tap ${tap + 1}/${options.taps} sent  ${snapshot()}`);
    await sleep(TAP_GAP_MS);
  }
} else if (options.holdSeconds > 0) {
  // Emulate HOLDING the Mode button: the dash repeats the frame for the whole hold, and the VCU
  // only commits the stop once it has been sustained — a single shot leaves "interruption in
  // progress" hanging. Stream at HOLD_INTERVAL_MS and print a snapshot each second so the moment
  // it completes is visible live.
  const sends = Math.ceil((options.holdSeconds * 1000) / HOLD_INTERVAL_MS);
  const incrementNote = options.incrementByte === null ? "static" : `incrementing b${options.incrementByte}`;
  console.log(
    `\n→ HOLDING the candidate for ${options.holdSeconds}s (${sends}× at ${HOLD_INTERVAL_MS}ms, ${incrementNote})…`
  );
  // A fresh buffer per hold so --increment can climb byte B from its base value each frame, testing
  // whether the held Mode button emits an auto-repeat counter rather than a static repeated frame.
  const held = Uint8Array.from(options.bytes);
  const incrementBase = options.incrementByte === null ? 0 : options.bytes[options.incrementByte];
  for (let sent = 0; sent < sends; sent += 1) {
    if (options.incrementByte !== null) {
      held[options.incrementByte] = (incrementBase + sent) & 0xff;
    }
    sendFrame(CHARGE_COMMAND_CAN_ID, held);
    if ((sent * HOLD_INTERVAL_MS) % 1000 === 0) {
      console.log(`  t=${((sent * HOLD_INTERVAL_MS) / 1000).toFixed(0)}s  sent ${hex(held)}  ${snapshot()}`);
    }
    await sleep(HOLD_INTERVAL_MS);
  }
} else {
  console.log(`\n→ transmitting the candidate ${options.repeat}×…`);
  for (let sent = 0; sent < options.repeat; sent += 1) {
    sendFrame(CHARGE_COMMAND_CAN_ID, frame);
    await sleep(500);
  }
}

await watchWindow("AFTER", options.watchSeconds);
printVerdict(before, latest, sentDescription(options));
process.exit(0);

// ── helpers ──────────────────────────────────────────────────────────────────

function sendFrame(id: number, bytes: Uint8Array): void {
  try {
    channel.send({ id, ext: false, rtr: false, data: Buffer.from(bytes) });
  } catch (error) {
    console.error("send failed — is the cool-eva service still holding can0? Stop it and retry.", error);
    process.exit(1);
  }
}

async function watchWindow(label: string, seconds: number): Promise<void> {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    await sleep(1000);
  }
  console.log(`\n[${label}]  ${snapshot()}`);
}

function snapshot(): string {
  return WATCHED_KEYS.map(key => (latest.has(key) ? `${key}=${latest.get(key)}` : `${key}=—`)).join("  ");
}

// What was actually put on the bus, for the verdict line — the single 0x121 candidate, the
// captured pair, or (for --request-only) just the 0x120 request-twin.
function sentDescription(options: Options): string {
  if (options.pair) {
    return STOP_PAIR.map(item => `0x${item.id.toString(16)} ${hex(Uint8Array.from(item.bytes))}`).join(" then ");
  }
  if (options.requestOnly) {
    return `0x120 ${hex(Uint8Array.from(STOP_PAIR[0].bytes))} (request-twin only)`;
  }
  return `0x121 ${hex(frame)}`;
}

function printVerdict(before: Map<string, number>, after: Map<string, number>, sent: string): void {
  const stopped = STOP_INDICATOR_KEYS.some(key => (before.get(key) ?? 0) > 0 && (after.get(key) ?? 0) === 0);
  const mainsBefore = before.get("mains_v") ?? 0;
  const mainsAfter = after.get("mains_v") ?? 0;
  const mainsCollapsed = mainsBefore > 50 && mainsAfter < mainsBefore / 2;

  console.log("\n" + "=".repeat(60));
  if (stopped || mainsCollapsed) {
    console.log("VERDICT: the charge STOPPED after the send — this candidate is a stop command.");
    console.log(`  ${sent}   record it in docs/can-0x121-charge-command.md and build the button.`);
  } else {
    console.log("VERDICT: nothing stopped — the VCU ignored this candidate, or the charge was");
    console.log("  already idle. Confirm the bike was charging BEFORE, then try the next candidate.");
  }
  console.log("=".repeat(60) + "\n");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join(" ");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface Options {
  bytes: number[];
  why: string;
  send: boolean;
  repeat: number;
  holdSeconds: number;
  incrementByte: number | null;
  taps: number;
  pair: boolean;
  requestOnly: boolean;
  watchSeconds: number;
}

function parseArguments(argv: string[]): Options {
  let bytes: number[] | null = null;
  let why = "";
  let send = false;
  let repeat = 1;
  let holdSeconds = 0;
  let incrementByte: number | null = null;
  let taps = 0;
  let pair = false;
  let requestOnly = false;
  let watchSeconds = 20;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--candidate") {
      const name = argv[++index];
      const candidate = CANDIDATES[name];
      if (!candidate) {
        throw new Error(`unknown --candidate ${name}. Known: ${Object.keys(CANDIDATES).join(", ")}`);
      }
      bytes = candidate.bytes;
      why = candidate.why;
    } else if (flag === "--bytes") {
      bytes = parseBytes(argv[++index]);
      why = "custom bytes";
    } else if (flag === "--send") {
      send = true;
    } else if (flag === "--repeat") {
      repeat = Number(argv[++index]);
    } else if (flag === "--hold") {
      holdSeconds = Number(argv[++index]);
    } else if (flag === "--increment") {
      incrementByte = Number(argv[++index]);
      if (!Number.isInteger(incrementByte) || incrementByte < 0 || incrementByte > 7) {
        throw new Error(`--increment must be a byte index 0–7, got ${argv[index]}`);
      }
    } else if (flag === "--taps") {
      taps = Number(argv[++index]);
      if (!Number.isInteger(taps) || taps < 1) {
        throw new Error(`--taps must be a positive integer, got ${argv[index]}`);
      }
    } else if (flag === "--pair") {
      pair = true;
    } else if (flag === "--request-only") {
      requestOnly = true;
    } else if (flag === "--watch") {
      watchSeconds = Number(argv[++index]);
    } else {
      throw new Error(`unknown argument ${flag}. See the header for options.`);
    }
  }

  // --pair and --request-only carry their own frames (STOP_PAIR), so a candidate/bytes is not
  // required with either.
  if (bytes === null && !pair && !requestOnly) {
    throw new Error(
      `required: --candidate NAME (one of ${Object.keys(CANDIDATES).join(", ")}), --bytes "…", --pair, or --request-only.`
    );
  }
  return { bytes: bytes ?? [], why, send, repeat, holdSeconds, incrementByte, taps, pair, requestOnly, watchSeconds };
}

function parseBytes(text: string | undefined): number[] {
  if (!text) {
    throw new Error('--bytes needs eight space-separated hex bytes, e.g. --bytes "16 ff 01 00 00 00 00 00"');
  }
  const bytes = text
    .trim()
    .split(/\s+/)
    .map(token => parseInt(token, 16));
  if (bytes.length !== 8 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`--bytes must be exactly 8 hex values 00…ff, got ${JSON.stringify(text)}`);
  }
  return bytes;
}
