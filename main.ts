// main.ts — entrypoint of the forge.
//
// This process does one job besides serving: the handshake with the trial
// environment (the "env"). The env starts next to us and its origin is in
// MAKEFUN_ENV_URL. The handshake is:
//   1. listen on an ephemeral port (the kernel picks one; never 8080,
//      which is the env's own port),
//   2. POST that port to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. stop the server and exit 0.
// Everything the suite actually drives — git smart HTTP, REST, GraphQL,
// MCP — lives in app.ts; this file only runs the lifecycle around it.

import { createApp } from "./app.ts";

// How long one env request may take before it counts as failed.
const REQUEST_TIMEOUT_MS = 5_000;

// Register: start at 250 ms, double each attempt, never wait more than 5 s
// between tries, and stop after 48 tries (about three minutes of retries).
const REGISTER_BASE_MS = 250;
const REGISTER_CAP_MS = 5_000;
const REGISTER_MAX_ATTEMPTS = 48;

// Poll /done: start at 200 ms, double, cap at 2 s. No attempt limit —
// the process must not exit before the suite says it is done.
const DONE_BASE_MS = 200;
const DONE_CAP_MS = 2_000;

// After /done, give lingering connections this long to drain, then leave.
const SHUTDOWN_GRACE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff for attempt n (0-based), capped so the wait never
// grows past capMs.
function delayFor(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The env origin without a trailing slash, so `${origin}/register` and
// `${origin}/done` are always well formed.
function envOrigin(): string | undefined {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

// POST {"port": port} to the env's /register and return the HTTP status.
// Throws on network failure or timeout; the caller retries those.
async function registerPort(origin: string, port: number): Promise<number> {
  const res = await fetch(`${origin}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.status;
}

// GET the env's /done. True only when the body is {"done": true}; any
// transport problem or unexpected answer means "not done yet".
async function isDone(origin: string): Promise<boolean> {
  const res = await fetch(`${origin}/done`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { done?: unknown };
  return body.done === true;
}

async function main(): Promise<number> {
  const origin = envOrigin();
  if (!origin) {
    console.error("MAKEFUN_ENV_URL is not set; cannot find the suite to register with.");
    return 1;
  }

  const server = createApp();

  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(0, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        if (addr && typeof addr !== "string") resolve(addr.port);
        else reject(new Error("the server did not bind a TCP port"));
      });
    });
  } catch (err) {
    console.error(`could not bind the forge: ${errorText(err)}`);
    return 1;
  }

  // Register the port. 200 means registered; 409 means another entry got
  // there first, and we still wait for the suite like everyone else.
  // Anything else (or a failed request) is retried with backoff.
  let registered = false;
  for (let attempt = 0; attempt < REGISTER_MAX_ATTEMPTS; attempt += 1) {
    let status = 0;
    try {
      status = await registerPort(origin, port);
    } catch (err) {
      console.error(`register attempt ${attempt + 1} failed: ${errorText(err)}`);
    }
    if (status === 200 || status === 409) {
      registered = true;
      break;
    }
    if (status !== 0) {
      console.error(`register attempt ${attempt + 1} answered HTTP ${status}; retrying`);
    }
    await sleep(delayFor(attempt, REGISTER_BASE_MS, REGISTER_CAP_MS));
  }
  if (!registered) {
    console.error(`could not register port ${port} with the suite; giving up.`);
    server.close();
    return 1;
  }

  // Wait for the suite to finish. It answers {"done": false} while it
  // works; a failed poll is just another "not yet".
  let attempt = 0;
  for (;;) {
    let done = false;
    try {
      done = await isDone(origin);
    } catch (err) {
      console.error(`polling /done failed: ${errorText(err)}; retrying`);
    }
    if (done) break;
    await sleep(delayFor(attempt, DONE_BASE_MS, DONE_CAP_MS));
    attempt += 1;
  }

  // The suite has written its export. Stop serving and leave with 0.
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
  });
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`fatal error in the entrypoint: ${errorText(err)}`);
  process.exitCode = 1;
}
