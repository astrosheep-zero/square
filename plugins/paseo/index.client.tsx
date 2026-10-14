import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SquareMessage } from "./client/square-message";
import { transformSquareMessage } from "./client/transform";
import { squareMessageSchema } from "./shared/message";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "square-message",
    query: { itemType: "tool_call" },
    transform: transformSquareMessage,
  });
  client.addTimelineRenderer({
    kind: "square-message",
    version: 1,
    schema: squareMessageSchema,
    Component: SquareMessage,
  });
  return () => {};
}
