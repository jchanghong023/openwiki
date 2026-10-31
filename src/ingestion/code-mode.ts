import { readFile } from "node:fs/promises";
import path from "node:path";
import { createConnectorRegistry } from "../connectors/registry.js";
import { UPDATE_METADATA_PATH } from "../config/constants.js";
import type { OpenWikiRunEvent } from "../agent/types.js";
import { createConnectorSynthesisGuidance } from "./ingestion.js";

export { ensureCodeModeRepoSetup } from "./code-mode-setup.js";
export type { CodeModeRepoSetupOptions } from "./code-mode-setup.js";

/**
 * Runs every configured code-mode connector for a code-mode agent run and appends
 * their guidance to the agent's message. Returns the base message unchanged when
 * nothing contributes, so an unconfigured repo still noop-skips. Fail-open: a
 * connector that throws is skipped, never allowed to break the update.
 */
export async function runCodeModeConnectors(
  repoRoot: string,
  baseMessage: string | undefined,
  onEvent?: (event: OpenWikiRunEvent) => void,
): Promise<string | undefined> {
  // The natural window: what has happened since we last documented this repo.
  const windowHours = windowHoursSince(await readLastUpdatedAt(repoRoot));
  const blocks: string[] = [];

  for (const connector of Object.values(createConnectorRegistry())) {
    if (connector.mode !== "code") {
      continue;
    }
    // Surface the pull so the otherwise-silent gap before the agent reads as
    // progress ("Ingesting from LangSmith…") instead of a hang.
    emitText(onEvent, `Ingesting from ${connector.displayName}…\n`);
    let pull;
    try {
      // Code connectors read their committed repo config from repoRoot; a repo
      // that has not configured the connector skips, so nothing is appended.
      pull = await connector.ingest({ repoRoot, windowHours });
    } catch {
      // The connector documents software; it must never break the run it feeds.
      emitText(onEvent, `${connector.displayName} ingestion skipped.\n`);
      continue;
    }
    emitText(onEvent, `${pull.message}\n`);
    if (pull.status !== "success" || pull.rawFiles.length === 0) {
      continue;
    }
    const guidance = createConnectorSynthesisGuidance(connector);
    if (guidance) {
      blocks.push(guidance);
    }
  }

  if (blocks.length === 0) {
    return baseMessage;
  }

  const base = baseMessage?.trim();
  const joined = blocks.join("\n\n");
  return base ? `${base}\n\n${joined}` : joined;
}

/** Emits a plain progress line to the run log. */
function emitText(
  onEvent: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  onEvent?.({ text, type: "text" });
}

/** Hours elapsed since the last-update timestamp, if available. */
function windowHoursSince(since: string | undefined): number | undefined {
  const sinceMs = since !== undefined ? Date.parse(since) : Number.NaN;
  return Number.isNaN(sinceMs)
    ? undefined
    : Math.max(0, (Date.now() - sinceMs) / (60 * 60 * 1000));
}

/** Read the last-update timestamp, if available. */
async function readLastUpdatedAt(
  repoRoot: string,
): Promise<string | undefined> {
  try {
    const text = await readFile(
      path.join(repoRoot, UPDATE_METADATA_PATH),
      "utf8",
    );
    const parsed = JSON.parse(text) as { updatedAt?: unknown };
    return typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined;
  } catch {
    return undefined;
  }
}
