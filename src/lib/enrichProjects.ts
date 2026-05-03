import { invoke } from "@tauri-apps/api/core";
import type { GitInfo, Project, ProjectEnrichment } from "../types";
import { isCommandNotFound } from "./format";

// Module-level cache: once we know the batched command is missing, don't try again.
let batchedSupported: boolean | null = null;

type BatchedResult = Record<string, ProjectEnrichment>;

export async function enrichProjects(
  projects: Project[],
  known: string[]
): Promise<BatchedResult> {
  if (batchedSupported !== false) {
    try {
      const res = await invoke<BatchedResult>("enrich_projects", {
        paths: projects.map((p) => p.path),
        known,
      });
      batchedSupported = true;
      return res;
    } catch (e) {
      if (isCommandNotFound(e)) {
        batchedSupported = false;
      } else if (batchedSupported === null) {
        // Unknown error on first try — fall through to per-project, but don't lock out future tries.
      } else {
        throw e;
      }
    }
  }

  // Fallback: per-project parallel calls.
  const entries = await Promise.all(
    projects.map(async (p) => {
      const [git, goal] = await Promise.all([
        invoke<GitInfo | null>("git_last_commit", { path: p.path }).catch(() => null),
        invoke<string | null>("engram_project_goal", { path: p.path, known }).catch(() => null),
      ]);
      return [p.path, { git, goal } as ProjectEnrichment] as const;
    })
  );
  return Object.fromEntries(entries);
}
