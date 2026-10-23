import { spawnProcess, type AgentDeliveryObservation } from "@getpaseo/plugin/server";

/** Forward native facts only. Square matches its pre-persisted message ID; no text parsing. */
export async function recordDeliveryStatus(
  cwd: string,
  observation: AgentDeliveryObservation,
  signal: AbortSignal,
): Promise<void> {
  const child = spawnProcess("square", ["claude-mod"], {
    cwd, env: process.env, stdio: "pipe", signal, timeout: 5_000,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
    // Output contains no user-facing content. Drain both pipes; the bridge exit is authoritative.
    child.stdout.resume();
    child.stderr.resume();
    child.once("close", (code, killedBy) => {
      if (code === 0) resolve();
      else reject(new Error(`Square native status recorder failed (${killedBy ?? code}).`));
    });
    const { provider, sessionId, messageId, eventId, state, reason, observedAt } = observation;
    child.stdin.end(JSON.stringify({ operation: "status", cwd, sessionId, status: {
      provider, sessionId, messageId, eventId, state, observedAt,
      ...(reason === null ? {} : { reason }),
    } }));
  });
}
