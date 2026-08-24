import type { IncomingMessage, ServerResponse } from "http";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// POST /update — `git pull` the checkout on the Pi.
//
// The menu's "Update" button. Pulls the deploy directory and returns git's own output
// so the rider sees exactly what moved — or why nothing did. It does NOT restart the
// service: the service IS this process, so it cannot restart itself from inside the
// request without killing the reply. New code takes effect on the next
// `systemctl restart cool-eva`.
//
// Run with -c safe.directory so a root service (systemd) is not refused by git's
// dubious-ownership check over a pi-owned checkout. ⚠️ Files git rewrites then become
// root-owned; a later by-hand pull as `pi` may want its own safe.directory or a chown.
// Deploying only through this button keeps ownership consistent.

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
    });
    const output = `${stdout}${stderr}`.trim();
    console.log(`update: git pull in ${directory}:\n${output}`);
    respond(res, 200, { ok: true, message: output || "Already up to date." });
  } catch (err) {
    // A non-zero git exit (merge conflict, no network, detached head) lands here with
    // its output carried on the error; surface that rather than a bare "failed".
    const detail = gitErrorText(err);
    console.warn(`update: git pull in ${directory} failed:\n${detail}`);
    respond(res, 500, { ok: false, message: detail });
  }
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
