import { exec } from "child_process";
import { promisify } from "util";
import canModule from "socketcan";
import type { RawChannel } from "socketcan";

const execAsync = promisify(exec);

// Bring up can0 and open a raw channel. The app runs as root (systemd), so it can
// configure the interface itself at startup (see INTEGRATION_PLAN.md §bring-up).
//
// ⚠️ listen-only is STICKY on this adapter — `ip link set … type can bitrate …`
// does NOT clear it, so we pass it explicitly every time. ACTIVE mode is required
// to TX OBD-II read requests; it is read-only-safe (standard OBD reads, no writes).

export async function bringUpCan(iface = "can0", active = true): Promise<void> {
  const listenOnly = active ? "listen-only off" : "listen-only on";
  try {
    await execAsync(`ip link set ${iface} down`);
  } catch (err) {
    // Usually just "interface already down" on a cold start, but a persistent
    // failure here is the difference between ACTIVE and a stuck listen-only bus.
    console.log(`can: ${iface} down failed (likely already down):`, err);
  }
  await execAsync(`ip link set ${iface} type can bitrate 500000 restart-ms 100 ${listenOnly}`);
  await execAsync(`ip link set ${iface} up`);
  console.log(`can: ${iface} up @500k — ${active ? "ACTIVE (TX enabled)" : "listen-only"}`);
}

// Re-configure and bring the interface back up after the link has dropped — the
// recovery the dashboard's "CAN bus restart" button reaches. The pair of commands run
// by hand when the bus goes down mid-ride:
//
//   ip link set can0 type can bitrate 500000
//   ip link set can0 up
//
// No `down` first, unlike bringUpCan(): this is pressed precisely because the link is
// already down, and reconfiguring an already-down interface is what works. listen-only
// is left unset on purpose — it is STICKY on this adapter (see bringUpCan), so omitting
// it keeps whatever mode the service brought the bus up in rather than flipping it.
export async function restartCanLink(iface = "can0"): Promise<void> {
  await execAsync(`ip link set ${iface} type can bitrate 500000`);
  await execAsync(`ip link set ${iface} up`);
  console.log(`can: ${iface} restarted @500k`);
}

export function openChannel(iface = "can0"): RawChannel {
  // second arg = receive timestamps
  return canModule.createRawChannel(iface, true);
}
