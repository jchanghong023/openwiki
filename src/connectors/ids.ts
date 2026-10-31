import type { ConnectorId } from "./types.js";

/** Connector identifiers, independent of the connector implementations. */
export const CONNECTOR_IDS = [
  "custom-mcp",
  "git-repo",
  "notion",
  "x",
  "google",
  "web-search",
  "hackernews",
  "langsmith",
  "slack",
] as const satisfies readonly ConnectorId[];

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}
