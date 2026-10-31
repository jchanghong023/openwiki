import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restrictDirToCurrentUser } from "../platform/windows-acl.js";

export const OPENWIKI_CONFIG_DIR_ENV_KEY = "OPENWIKI_CONFIG_DIR";

export function resolveOpenWikiHomeDir(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configuredDir = environment[OPENWIKI_CONFIG_DIR_ENV_KEY]?.trim();

  if (!configuredDir) {
    return path.join(os.homedir(), ".openwiki");
  }

  // `path.resolve` does not expand a leading `~`, and several environments
  // that set env vars (PowerShell, docker-compose, a hand-edited `.env`) leave
  // it literal. Mirror the tilde handling used by `normalizeLocalPath`.
  if (configuredDir === "~") {
    return path.join(os.homedir());
  }

  if (configuredDir.startsWith("~/") || configuredDir.startsWith("~\\")) {
    return path.resolve(os.homedir(), configuredDir.slice(2));
  }

  return path.resolve(configuredDir);
}

export function getOpenWikiHomeDisplayPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment[OPENWIKI_CONFIG_DIR_ENV_KEY]?.trim()
    ? resolveOpenWikiHomeDir(environment)
    : "~/.openwiki";
}

export let openWikiHomeDir = resolveOpenWikiHomeDir();
export let openWikiHomeDisplayPath = getOpenWikiHomeDisplayPath();
export let openWikiConnectorsDir = path.join(openWikiHomeDir, "connectors");
export let openWikiConversationHistoryDir = path.join(openWikiHomeDir, "conversation_history");
export let openWikiLocalWikiDir = path.join(openWikiHomeDir, "wiki");
export let openWikiSkillsDir = path.join(openWikiHomeDir, "skills");
export let openWikiEnvDir = openWikiHomeDir;
export let openWikiEnvPath = path.join(openWikiHomeDir, ".env");
export let openWikiConnectorsDisplayPath = `${openWikiHomeDisplayPath}/connectors`;
export let openWikiLocalWikiDisplayPath = `${openWikiHomeDisplayPath}/wiki`;
export let openWikiSkillsDisplayPath = `${openWikiHomeDisplayPath}/skills`;
export let openWikiEnvDisplayPath = `${openWikiHomeDisplayPath}/.env`;

let embeddedHomeDir: string | undefined;

/** Resolve the active registry home without changing standalone environment rules. */
export function getActiveOpenWikiHomeDir(): string {
  return embeddedHomeDir ?? resolveOpenWikiHomeDir();
}

/** Select a host-managed home without modifying the standalone environment. */
export function setEmbeddedOpenWikiHomeDir(directory: string): void {
  embeddedHomeDir = path.resolve(directory);
  openWikiHomeDir = embeddedHomeDir;
  openWikiHomeDisplayPath = embeddedHomeDir;
  openWikiConnectorsDir = path.join(embeddedHomeDir, "connectors");
  openWikiConversationHistoryDir = path.join(embeddedHomeDir, "conversation_history");
  openWikiLocalWikiDir = path.join(embeddedHomeDir, "wiki");
  openWikiSkillsDir = path.join(embeddedHomeDir, "skills");
  openWikiEnvDir = embeddedHomeDir;
  openWikiEnvPath = path.join(embeddedHomeDir, ".env");
  openWikiConnectorsDisplayPath = `${openWikiHomeDisplayPath}/connectors`;
  openWikiLocalWikiDisplayPath = `${openWikiHomeDisplayPath}/wiki`;
  openWikiSkillsDisplayPath = `${openWikiHomeDisplayPath}/skills`;
  openWikiEnvDisplayPath = `${openWikiHomeDisplayPath}/.env`;
}

export function getConnectorDir(connectorId: string): string {
  return path.join(openWikiConnectorsDir, connectorId);
}

export function getConnectorConfigPath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "config.json");
}

export function getConnectorStatePath(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "state.json");
}

export function getConnectorRawDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "raw");
}

export function getConnectorLogsDir(connectorId: string): string {
  return path.join(getConnectorDir(connectorId), "logs");
}

export async function ensureOpenWikiHome(): Promise<void> {
  await mkdir(openWikiHomeDir, { recursive: true, mode: 0o700 });
  await chmodIfExists(openWikiHomeDir, 0o700);
  await restrictDirToCurrentUser(openWikiHomeDir);
  await mkdir(openWikiConnectorsDir, { recursive: true, mode: 0o700 });
  await mkdir(openWikiConversationHistoryDir, { recursive: true, mode: 0o700 });
  await mkdir(openWikiLocalWikiDir, { recursive: true, mode: 0o700 });
  await mkdir(openWikiSkillsDir, { recursive: true, mode: 0o700 });
}

export async function ensureConnectorHome(connectorId: string): Promise<void> {
  assertSafeConnectorId(connectorId);
  await ensureOpenWikiHome();
  await mkdir(getConnectorDir(connectorId), { recursive: true, mode: 0o700 });
  await mkdir(getConnectorRawDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(getConnectorLogsDir(connectorId), {
    recursive: true,
    mode: 0o700,
  });
}

export function assertSafeConnectorId(connectorId: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(connectorId)) {
    throw new Error(`Invalid connector ID: ${connectorId}`);
  }
}

export function resolveConnectorRawPath(
  connectorId: string,
  relativePath: string,
): string {
  assertSafeConnectorId(connectorId);
  const rawDir = getConnectorRawDir(connectorId);
  const resolved = path.resolve(rawDir, relativePath);

  if (resolved !== rawDir && !resolved.startsWith(`${rawDir}${path.sep}`)) {
    throw new Error(
      "Raw item path must stay inside the connector raw directory.",
    );
  }

  return resolved;
}

async function chmodIfExists(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
