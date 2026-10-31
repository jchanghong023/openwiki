import { isConnectorId } from "../connectors/ids.js";
import type { ConnectorId } from "../connectors/types.js";

export type IngestionTarget = ConnectorId | "all" | SourceInstanceTarget;

export type SourceInstanceTarget = {
  kind: "source-instance";
  id: string;
};

export function parseIngestionTarget(value: string): IngestionTarget | null {
  if (value === "all") {
    return "all";
  }

  if (isConnectorId(value)) {
    return value;
  }

  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(value)
    ? { kind: "source-instance", id: value }
    : null;
}
