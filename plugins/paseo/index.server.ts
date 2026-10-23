import type { PluginServerContext } from "@getpaseo/plugin/server";
import { recordDeliveryStatus } from "./server/record-delivery.ts";

export default function contribute(server: Pick<PluginServerContext, "on">) {
  return server.on("agent.delivery_status", async ({ agent, observation }, { signal }) => {
    // Agent providers can wrap Claude (for example yescode); the observation identifies the native producer.
    if (observation.provider !== "claude" || observation.lane !== "socket" || !observation.eventId) return;
    await recordDeliveryStatus(agent.cwd, observation, signal);
  });
}
