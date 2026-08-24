import type { IncomingMessage, ServerResponse } from "http";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// POST /update — `git pull` the checkout on the Pi, then restart the service so the new
// code takes effect.
//
// The menu's "Update" button. Pulls the deploy directory and returns git's own output
// so the rider sees exactly what moved — or why nothing did. On a successful pull it then
// restarts cool-eva; the service IS this process, so the restart can only fire AFTER the
// reply has flushed (the request's response "finish" event) — otherwise the button hangs
// on a killed connection. See scheduleServiceRestart for why it must be detached.
//
// Run with -c safe.directory so a root service (systemd) is not refused by git's
// dubious-ownership check over a pi-owned checkout. ⚠️ Files git rewrites then become
// root-owned; a later by-hand pull as `pi` may want its own safe.directory or a chown.
// Deploying only through this button keeps ownership consistent.
//
// origin is an SSH remote, but root has no deploy key — the key lives in pi's ~/.ssh, so
// pulling as root gives "Permission denied (publickey)". Point HOME at pi's home for the
// git call so ssh finds pi's key, config and known_hosts (the last also matters: root's
// known_hosts is empty, which would fail host-key verification for github.com).
const PULL_HOME = "/home/pi";

/**
 * What the endpoint says, for the caller that acts on it. A named type imported through
 * JSDoc in public/views/sheet.js — the dashboard has no build step, so this is what
 * stops the two ends drifting, the same as DashboardMessage in CLAUDE.md.
 */
export interface UpdateReply {
  ok: boolean;
  message: string;
}

/** git pull can hang on bad garage wifi; don't leave the button spinning forever. */
const PULL_TIMEOUT_MS = 60_000;

export async function handleUpdateEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  directory: string
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Allow": "POST" });
    res.end("POST to pull the latest code\n");
    return;
  }
  try {
    const { stdout, stderr } = await execAsync(`git -C ${directory} -c safe.directory=${directory} pull`, {
      timeout: PULL_TIMEOUT_MS,
      env: { ...process.env, HOME: PULL_HOME },
    });
    const output = `${stdout}${stderr}`.trim();
    console.log(`update: git pull in ${directory}:\n${output}`);
    const summary = output || "Already up to date.";
    respond(res, 200, { ok: true, message: `${summary}\n\nRestarting cool-eva…` });
    // The restart kills this process, so wait for the reply to leave the socket first.
    res.once("finish", scheduleServiceRestart);
  } catch (err) {
    // A non-zero git exit (merge conflict, no network, detached head) lands here with
    // its output carried on the error; surface that rather than a bare "failed".
    const detail = gitErrorText(err);
    console.warn(`update: git pull in ${directory} failed:\n${detail}`);
    respond(res, 500, { ok: false, message: detail });
  }
}

// Restart the service the moment the reply has flushed. `--no-block` hands the job to
// systemd (PID 1) and returns, so it is queued before systemd tears down our cgroup mid-
// restart; detached + unref + ignored stdio means this child does not keep the dying
// process pinned open waiting on it. sudo because the button may be reached as a non-root
// user, and it is a no-op passthrough when the service already runs as root.
function scheduleServiceRestart(): void {
  const restart = spawn("sudo", ["systemctl", "restart", "--no-block", "cool-eva"], {
    detached: true,
    stdio: "ignore",
  });
  restart.on("error", err => {
    console.warn("update: could not spawn service restart:", err);
  });
  restart.unref();
}

/** exec's rejection carries the command's stdout/stderr; prefer them over the terse message. */
function gitErrorText(err: unknown): string {
  if (err instanceof Error) {
    const withStreams = err as Error & { stdout?: string; stderr?: string };
    const streams = `${withStreams.stdout ?? ""}${withStreams.stderr ?? ""}`.trim();
    return streams || err.message;
  }
  return String(err);
}

function respond(res: ServerResponse, statusCode: number, reply: UpdateReply): void {
  const body = Buffer.from(JSON.stringify(reply), "utf-8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
