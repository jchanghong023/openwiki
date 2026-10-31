import path from "node:path";
import { OpenWikiIgnore } from "../agent/openwiki-ignore.js";
import {
  createRunContext,
  getRepositoryChangedPaths,
  getRepositorySourcePaths,
} from "../agent/utils.js";
import { ClaimsStore } from "../claims/brains/code/store.js";
import { readRepositoryPageManifest } from "./page-manifest.js";

/** A read-only view of repository inputs, not a prediction of generated pages. */
export interface RepositoryFilesPreview {
  mode: "init" | "update";
  /**
   * Git-relative entries in the source fingerprint boundary. This includes
   * missing tracked paths, Git links and .openwikiignore even when it ignores
   * itself; it is not a guarantee that each entry is a readable regular file
   * or that the model will inspect it. Git-ignored untracked paths are not in
   * the fingerprint, although the agent backend may allow direct reads of them.
   */
  sourcePaths: string[];
  /** Existing factual pages, as virtual /openwiki/ paths, not planned outputs. */
  existingWikiPages: string[];
  update?: {
    /** Last completed run's recorded Git head, if any. */
    baselineGitHead?: string;
    /**
     * Planner-style changed paths relative to baselineGitHead and the current
     * working tree. Omitted when the baseline or Git history cannot be read.
     * Individual pages may have different baselines; see pageBaselines.
     */
    changedPaths?: string[];
    /**
     * Persisted per-page coverage. An absent head means no known baseline;
     * changedPaths is omitted if that baseline cannot be compared.
     * A run may migrate or advance coverage before planning.
     */
    pageBaselines: { page: string; gitHead?: string; changedPaths?: string[] }[];
  };
}

/**
 * Preview the repository fingerprint's source entries and existing wiki state
 * without starting a run, writing files or invoking a model. Git queries disable
 * optional locks. Paths are a point-in-time estimate and may change afterwards.
 *
 * @param root - Repository root, absolute or relative to the current process.
 * @param mode - Repository generation mode.
 */
export async function previewRepositoryFiles(
  root: string,
  mode: "init" | "update",
): Promise<RepositoryFilesPreview> {
  const absoluteRoot = path.resolve(root);
  const ignore = await OpenWikiIgnore.load(absoluteRoot);
  const [{ visiblePaths }, existingWikiPages] = await Promise.all([
    getRepositorySourcePaths(absoluteRoot, ignore),
    new ClaimsStore(absoluteRoot).discoverPages(),
  ]);
  const preview: RepositoryFilesPreview = {
    mode,
    sourcePaths: visiblePaths,
    existingWikiPages,
  };
  if (mode === "init") return preview;

  const [context, manifest] = await Promise.all([
    createRunContext(absoluteRoot, "repository"),
    readRepositoryPageManifest(absoluteRoot),
  ]);
  const baselineGitHead =
    context.lastUpdate?.status === "complete"
      ? context.lastUpdate.gitHead
      : undefined;
  const changesByBaseline = new Map<string, Promise<string[] | undefined>>();
  const changesSince = (gitHead: string): Promise<string[] | undefined> => {
    let result = changesByBaseline.get(gitHead);
    if (!result) {
      // Metadata is persisted input, not an option to Git. Only accept full
      // object IDs, and never turn a failed query into an empty change list.
      result = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(gitHead)
        ? getRepositoryChangedPaths(absoluteRoot, ignore, gitHead, true).catch(
            () => undefined,
          )
        : Promise.resolve(undefined);
      changesByBaseline.set(gitHead, result);
    }
    return result;
  };
  const [changedPaths, pageBaselines] = await Promise.all([
    baselineGitHead ? changesSince(baselineGitHead) : undefined,
    Promise.all(
      existingWikiPages.map(async (page) => {
        const gitHead = manifest.pages[page]?.gitHead;
        const pageChanges = gitHead ? await changesSince(gitHead) : undefined;
        return {
          page,
          ...(gitHead ? { gitHead } : {}),
          ...(pageChanges ? { changedPaths: pageChanges } : {}),
        };
      }),
    ),
  ]);
  preview.update = {
    ...(baselineGitHead ? { baselineGitHead } : {}),
    ...(changedPaths ? { changedPaths } : {}),
    pageBaselines,
  };
  return preview;
}
