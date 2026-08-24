import { exec } from "child_process";
import { promisify } from "util";
import { record } from "./signals.ts";

const execAsync = promisify(exec);

// Publishes the kernel's view of the CAN interface as the `can_link` signal
// (1 = UP, 0 = anything else, the interface not existing included). This is NOT a bus
// signal — nothing on can0 reports it — so it can't ride in on a frame the way the rest
// of src/can does; it is `ip link` state, read on a timer.
//
// The dashboard's "live" dot already covers the WebSocket to the phone; this covers the
// layer under it, so a bus that has gone down (adapter unplugged, a scratch script's
// `ip link set can0 down`, a restart re-initialising can0 mid-ride) is visible without
// reading journalctl.

export interface CanLinkMonitor {
  stop: () => void;
}

// e.g. "can0: <NOARP,ECHO> mtu 16 qdisc noop state DOWN mode DEFAULT group default qlen 10"
const STATE_PATTERN = /\bstate (\S+)/;

export function startCanLinkMonitor(iface = "can0", intervalMs = 15_000): CanLinkMonitor {
  let lastState: string | null = null;

  const poll = async (): Promise<void> => {
    let state: string;
    let detail = "";
    try {
      const { stdout } = await execAsync(`ip -details link show ${iface}`);
      const match = stdout.match(STATE_PATTERN);
      state = match ? match[1] : "UNKNOWN";
    } catch (err) {
      // A non-zero exit is the interface not existing (coolant-only bike, adapter
      // unplugged) as much as a real fault; treat it as down rather than throwing, and
      // let the change-logging below keep a persistent failure from repeating every 15 s.
      state = "DOWN";
      detail = ` (${err instanceof Error ? err.message : String(err)})`;
    }
    record("can_link", state === "UP" ? 1 : 0);
    if (state !== lastState) {
      console.log(`can-link: ${iface} state is ${state}${detail}`);
      lastState = state;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  return { stop: () => clearInterval(timer) };
}
