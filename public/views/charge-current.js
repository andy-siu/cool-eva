// @ts-check

import van from "../vendor/van-1.6.1.js";
import { isStale, valueOf } from "../lib/store.js";
import { GOOD, MUTED, WARN, WATCH } from "../lib/colors.js";
import { arm, armDwellElapsed, armed, refuseKeyRepeat } from "../lib/arming.js";

const { button, div, input } = van.tags;

// Command the charge current live, from the charge tab. The one control on the dashboard
// that changes the bike outside the service-mode sheet — so it carries most of the sheet's
// safety model with it: it POSTs through the gated /vcu-write endpoint (SERVICE_WRITE_ENABLED,
// the audit journal), it needs two taps separated by the shared dwell, and it renders NOTHING
// unless the Pi says writing is on AND a charge is live. A phone that has not been told writes
// are enabled sees an ordinary read-only charge screen.
//
// ⚠️ It does NOT use the stationary service gate (moving / energized / in-drive). A charging
// bike is energized and tethered by definition, so that gate misfits a charging operation and
// would flap with the trickle; the appropriate precondition is "a charge is live", which is what
// gates this. The Pi exempts charge-current from that gate for the same reason (write-runner.ts).
//
// ⚠️ Nothing here decides the opcode or the ceiling — the Pi reads charge_manager_state live and
// echoes the dash's own ceiling (docs/can-0x121-charge-command.md). The AC/DC label and the
// ceiling shown here are read off the SAME live signals so the button says what the Pi will
// do, but where they and the server disagree the server wins and its reason is shown.

/** @typedef {import("../../src/http/vcu-write.ts").VcuWriteResponse} VcuWriteResponse */

/**
 * How stale charge_manager_state may be before this treats the session as gone. Matches the
 * Pi's own CHARGE_SESSION_MAX_AGE_MS in src/vcu/write-runner.ts, so the control and the server
 * agree on when there is a live charge to command into.
 */
const CHARGE_SESSION_MAX_AGE_MS = 5000;

/**
 * charge_manager_state (0x610 b7) settled values: 0x02 AC, 0x23 DC. ⚠️ Session presence and the
 * AC/DC label ride on THIS, not charge_type — charge_type flaps 1↔0 within one plug-in as the
 * charger pauses delivery (docs/charge-manager.md), which is exactly what made this tile vanish
 * mid-session. charge_manager_state holds steady for the whole session.
 */
const CHARGE_MANAGER_STATE_AC = 0x02;
const CHARGE_MANAGER_STATE_DC = 0x23;

/** The last /vcu-write status this control fetched — the gate, and whether writing is on at all. */
const writeStatus = van.state(/** @type {VcuWriteResponse | null} */ (null));
/**
 * Whether a charge session is live right now, driven off charge_manager_state by the derive
 * below. ⚠️ A van.state — NOT an isStale() call in the render — so the tile's visibility binding
 * does not subscribe to serverTime; were it to, it would re-run ~20 Hz and recreate the <input>.
 */
const sessionLive = van.state(false);
/** What the owner typed, as text so an empty box is distinct from a zero. */
const amps = van.state("");
const busy = van.state(false);
/** True only while the command's own POST is in flight, so "Sending…" cannot be shown for a status refresh. */
const sending = van.state(false);
const message = van.state("");
/** The last command's outcome, shown against the amps it was for. */
const lastResult = van.state(/** @type {{ amps: number, succeeded: boolean } | null} */ (null));

// The status fetch is lazy: nothing polls /vcu-write for a phone that is not charging, so the
// read-only screen stays a pure WebSocket consumer. This derive tracks the live session off
// charge_manager_state, fetches the gate once when a charge begins, and clears when it ends.
//
// ⚠️ This derive DELIBERATELY subscribes to serverTime (via liveChargeType → isStale), because
// the cable coming out is a staleness event with no value change and nothing else would notice
// it. It is the one place allowed to: it feeds the sessionLive STATE, and the tile's render reads
// that state — so the render never subscribes to serverTime and the <input> is never recreated
// under it. Cheap per tick (an equality check); the fetch fires only on the session edge.
let lastLive = false;
van.derive(() => {
  const live = liveChargeType() !== null;
  sessionLive.val = live;
  if (live === lastLive) {
    return;
  }
  lastLive = live;
  if (live) {
    void fetchChargeWriteStatus();
  } else {
    // A charge that ended tells us nothing about the next one's gate, and a stale "enabled"
    // left on screen would render the control against a session that is over.
    writeStatus.val = null;
    forgetCommand();
  }
});

export const ARMED_KEY = "charge-current";

/**
 * The control, or an empty node when it must not be offered.
 *
 * ⚠️ Hidden — not merely disabled — for a phone that never enabled writes: `enabled === true`
 * gates that, and an undefined status is not enabled. Once shown for a live charge it STAYS shown
 * across a current pause, rather than vanishing (which a phone reads as "it broke"). Visibility is
 * `sessionLive && enabled`, both plain states, no serverTime. ⚠️ The stationary service gate is
 * deliberately NOT a condition here — see the file header and write-runner.ts.
 */
export function ChargeCurrentControl() {
  return div(() => {
    if (!sessionLive.val || writeStatus.val?.status?.enabled !== true) {
      return div();
    }
    return div(
      { class: "tile span2" },
      div({ class: "label" }, "Set charge current"),
      Situation(),
      InputRow(),
      SetButton(),
      Outcome()
    );
  });
}

/**
 * What can be commanded right now: the source, the ceiling, or why neither is available.
 *
 * The two "not yet" states are the Pi's own refusals said BEFORE the button is pressed, so
 * the remedy (plug in; nudge the dial) is read where it is actionable rather than after a
 * 409. AC's ceiling is an event the dash only broadcasts when the dial moves, so its absence
 * is normal and gets a remedy, not an error.
 */
function Situation() {
  return div({ class: "action-note" }, () => {
    const type = liveChargeType();
    if (type === null) {
      // charge_manager_state briefly out of a settled AC/DC value (a pause or handshake step) —
      // the tile stays; the button waits for it. A real unplug clears sessionLive and hides this.
      return div({ style: `color:${MUTED}` }, "Charge state changing — hold on.");
    }
    const ceiling = liveCeiling(type);
    if (ceiling === null) {
      return div(
        { style: `color:${WARN}` },
        type === "ac"
          ? "⚠️ AC ceiling not seen yet — nudge the charge-current dial once on the bike's own screen so the dash broadcasts it, then it will appear here."
          : "⚠️ DC ceiling (fast_dc_limit_max_a) has not arrived — this means CAN is not being received."
      );
    }
    return div(
      { style: `color:${MUTED}` },
      `Live ${type.toUpperCase()} charge · ceiling ${ceiling} A. Whole amps, 1…${ceiling}. `,
      "The Pi picks AC/DC and the ceiling from the live bus — this echoes them."
    );
  });
}

function InputRow() {
  // ⚠️ The <input> is created ONCE, not inside a binding. A binding that re-ran on a live
  // signal would replace the element mid-keystroke and take the cursor with it — so only the
  // placeholder and disabled ATTRIBUTES are reactive (thunks), which VanJS updates in place.
  return div(
    { class: "probe-field" },
    input({
      class: "probe-input",
      type: "text",
      inputmode: "numeric",
      placeholder: () => {
        const type = liveChargeType();
        const ceiling = type === null ? null : liveCeiling(type);
        return ceiling === null ? "amps" : `1…${ceiling}`;
      },
      disabled: () => !commandable(),
      value: amps,
      oninput: (/** @type {Event} */ event) => {
        amps.val = /** @type {HTMLInputElement} */ (event.target).value;
        // Retyping disarms: the second tap must send the number now on screen, not the one
        // the first tap agreed to.
        armed.val = "";
      },
    })
  );
}

function SetButton() {
  return div(
    button(
      {
        // The reversible/amber tier, the same one the parameter write sits in: it changes
        // the bike and can be taken straight back (transient, the rider overrides on the
        // bike's screen), so it is on-screen and amber, not behind the red fold.
        class: "action writes",
        // One held Enter must not arm and then fire. See ../lib/arming.js.
        onkeydown: refuseKeyRepeat,
        disabled: () => busy.val || !commandable() || parsedAmps() === null,
        onclick: () => {
          if (armed.val !== ARMED_KEY) {
            void armChargeCurrent();
            return;
          }
          // The same dwell as every other second tap on the dashboard — the whole of what
          // stops a double-tap commanding a current nobody meant. Ignored inside the dwell,
          // not disarmed. See ../lib/arming.js.
          if (!armDwellElapsed()) {
            return;
          }
          armed.val = "";
          void performChargeCurrent();
        },
      },
      () => {
        if (sending.val) {
          return "⏳  Sending…";
        }
        if (busy.val) {
          return "⏳  Checking the bike is still safe to command…";
        }
        const value = parsedAmps();
        if (value === null) {
          const type = liveChargeType();
          const ceiling = type === null ? null : liveCeiling(type);
          return ceiling === null ? "✏️  Waiting for a live charge" : `✏️  Type the current to set (1…${ceiling})`;
        }
        const type = liveChargeType();
        const label = type === null ? "" : ` ${type.toUpperCase()} ${value} A`;
        return armed.val === ARMED_KEY ? `⚠️  Tap again to command${label}` : `✏️  Set${label}`;
      }
    ),
    div({ class: "action-note", style: `color:${MUTED}` }, () =>
      commandable()
        ? "Event frame with no reply — watch the dash's set value and the AC setpoint below to see it take. A full battery caps what actually flows."
        : ""
    )
  );
}

/**
 * The last command's outcome, and — once one has landed — where to look to confirm it.
 *
 * The hint is deliberately shown only afterwards: standing at the bike the moment the frame
 * has gone out is the moment "watch charge_limit_a" becomes useful, and before then it is
 * one more line competing with the input.
 */
function Outcome() {
  return div({ class: "action-note" }, () => {
    const result = lastResult.val;
    return div(
      message.val ? div({ style: `color:${result?.succeeded ? GOOD : WARN}` }, message.val) : div(),
      result?.succeeded
        ? div(
            { style: `color:${WATCH}` },
            `🔍  Commanded ${result.amps} A — the AC setpoint (charge_limit_a) should follow if the current allows.`
          )
        : div()
    );
  });
}

/**
 * Whether a command could be sent at all — a live charge with a known ceiling. The Pi
 * enforces every part of this again; this is the page declining to offer a button whose
 * request it knows would be refused.
 */
function commandable() {
  // Writes on for this Pi, plus a live session with a known ceiling. ⚠️ NOT gate.safe — the
  // stationary service gate does not apply to a charging operation (see the file header).
  if (writeStatus.val?.status?.enabled !== true) {
    return false;
  }
  const type = liveChargeType();
  return type !== null && liveCeiling(type) !== null;
}

/**
 * The charge source right now, or null when there is no settled session to command into.
 *
 * ⚠️ Reads charge_manager_state (0x610 b7: 0x02 AC, 0x23 DC), NOT charge_type — charge_type flaps
 * 1↔0 mid-session as current pauses (docs/charge-manager.md). charge_manager_state is the cleanest
 * AC/DC discriminator and holds steady across the pauses. Staleness-checked the same way the Pi
 * does, so a page open during a charge that has since ended will not command into a gone session.
 * @returns {"ac" | "dc" | null}
 */
function liveChargeType() {
  if (isStale("charge_manager_state", CHARGE_SESSION_MAX_AGE_MS)) {
    return null;
  }
  const state = valueOf("charge_manager_state");
  return state === CHARGE_MANAGER_STATE_AC ? "ac" : state === CHARGE_MANAGER_STATE_DC ? "dc" : null;
}

/**
 * The ceiling the command's b4 will carry, from the same live signal the Pi echoes: the
 * dash's own last AC ceiling, or the always-broadcast DC maximum.
 * @param {"ac" | "dc"} type
 * @returns {number | null}
 */
function liveCeiling(type) {
  const ceiling = valueOf(type === "ac" ? "ac_charge_ceiling_a" : "fast_dc_limit_max_a");
  return ceiling == null ? null : ceiling;
}

/** The typed amps as a whole number in range, or null. The Pi validates again against the live ceiling. */
function parsedAmps() {
  const text = amps.val.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  const type = liveChargeType();
  const ceiling = type === null ? null : liveCeiling(type);
  if (ceiling === null || value < 1 || value > ceiling) {
    return null;
  }
  return value;
}

/** Clears what the form holds. Called when a charge ends — a new session starts blank. */
function forgetCommand() {
  amps.val = "";
  armed.val = "";
  message.val = "";
  lastResult.val = null;
}

/**
 * Refreshes the status, THEN arms — so whether writes are still enabled and the session still
 * live is the Pi's answer now, not its answer when the charge started. Does not arm if writes
 * went off, or the charge or its ceiling went away across the refresh.
 */
async function armChargeCurrent() {
  busy.val = true;
  try {
    await fetchChargeWriteStatus();
  } finally {
    busy.val = false;
  }
  if (commandable() && parsedAmps() !== null) {
    arm(ARMED_KEY);
  }
}

async function performChargeCurrent() {
  const value = parsedAmps();
  if (value === null) {
    return;
  }
  const query = new URLSearchParams({
    action: "charge-current",
    amps: String(value),
    // The confirm carries the amps, so a page showing one value cannot POST another. Built
    // from the same number the button is committing to.
    confirm: `charge-current-${value}`,
  });
  message.val = "";
  sending.val = true;
  busy.val = true;
  let payload = /** @type {VcuWriteResponse | null} */ (null);
  try {
    const response = await fetch(`/vcu-write?${query}`, {
      method: "POST",
      cache: "no-store",
      // The write endpoint's header, deliberately NOT the read path's `service-mode`. See
      // src/http/vcu-write.ts.
      headers: { "X-Cool-Eva": "service-write" },
    });
    payload = /** @type {VcuWriteResponse} */ (await response.json());
    writeStatus.val = payload;
    message.val = payload.result?.message ?? payload.message ?? "";
  } catch (error) {
    // ⚠️ A request that did not come back may still have reached the bike — the frame goes
    // out before the response — so this is NOT "nothing happened". Lowering the current is
    // benign and overridable on the bike, but the message says the honest thing anyway.
    message.val =
      `Could not reach the Pi — ${error instanceof Error ? error.message : String(error)}. ` +
      "This does NOT guarantee nothing was sent — check the dash.";
    console.warn("charge-current: request failed", error);
  } finally {
    sending.val = false;
    busy.val = false;
  }
  armed.val = "";
  if (!payload || !payload.result) {
    // Transport failure, or a 400/409 refused before the bus (busy bus, no live session, bad
    // amps). `message` carries the reason; the typed value is kept so a retry needs no
    // re-typing.
    lastResult.val = null;
    return;
  }
  lastResult.val = { amps: value, succeeded: payload.result.succeeded };
}

/** GETs the enabled flag (and the rest of the status). Read-only; touches nothing on the bike. */
async function fetchChargeWriteStatus() {
  try {
    const response = await fetch("/vcu-write", { cache: "no-store" });
    const payload = /** @type {VcuWriteResponse} */ (await response.json());
    // Disarmed before the new status lands: writes switched off across the refresh must not
    // leave a primed button behind.
    armed.val = "";
    writeStatus.val = payload;
  } catch (error) {
    // Loud, but not fatal to the read-only screen: a failed status fetch simply leaves the
    // control hidden (its render requires enabled === true), which is the safe direction.
    console.warn("charge-current: status fetch failed", error);
  }
}
