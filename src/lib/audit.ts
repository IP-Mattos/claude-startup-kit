// Boundary validator for AuditFinding[].
//
// Rust returns `level: String`, TypeScript expects a strict union. Without a
// runtime check, an unrecognised level slips through, lands in the renderer
// as a typed `"OK" | "INFO" | "WARN" | "CRIT"`, and the icon/color logic
// silently falls back to the "info" branch — masking new findings shipped by
// a newer audit script. This module quarantines that mismatch.

import type { AuditAction, AuditFinding } from "../types";

const KNOWN_LEVELS = new Set<AuditFinding["level"]>(["OK", "INFO", "WARN", "CRIT"]);

const unknownLevelsLogged = new Set<string>();

// Accepts the raw IPC payload (typed as `unknown`) and returns a clean
// AuditFinding[]. Rows that aren't shaped like findings at all are dropped
// (defensive). Rows with a stringy but non-canonical `level` are mapped to
// "INFO" so they still surface to the user, and the unknown level is logged
// once per session. Returning a fresh array — never the input — so callers
// can mutate freely.
export function parseAuditFindings(raw: unknown): AuditFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: AuditFinding[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const level = r.level;
    const category = r.category;
    const title = r.title;
    const detail = r.detail;
    if (typeof category !== "string") continue;
    if (typeof title !== "string") continue;
    if (typeof detail !== "string") continue;
    out.push({
      level: normalizeLevel(level),
      category,
      title,
      detail,
      // Validate the action shape at the boundary too — a malformed action
      // (wrong kind, missing path/pid) silently becomes "no action" rather
      // than crashing the renderer when we destructure it.
      action: normalizeAction(r.action),
    });
  }
  return out;
}

// Whitelist of valid action discriminators, mirrored from the Rust enum.
const KNOWN_ACTION_KINDS = new Set<AuditAction["kind"]>([
  "navigate_to",
  "open_in_explorer",
  "open_in_vscode",
  "kill_process",
  "delete_file",
  "restore_settings_backup",
  "reinstall_kit",
]);

function normalizeAction(raw: unknown): AuditAction | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const kind = a.kind;
  if (typeof kind !== "string") return null;
  if (!KNOWN_ACTION_KINDS.has(kind as AuditAction["kind"])) return null;
  switch (kind) {
    case "navigate_to":
      return typeof a.tab === "string" ? { kind, tab: a.tab } : null;
    case "open_in_explorer":
    case "open_in_vscode":
    case "delete_file":
      return typeof a.path === "string" ? { kind, path: a.path } : null;
    case "kill_process":
      return typeof a.pid === "number" ? { kind, pid: a.pid } : null;
    case "restore_settings_backup":
    case "reinstall_kit":
      return { kind };
    default:
      return null;
  }
}

function normalizeLevel(raw: unknown): AuditFinding["level"] {
  if (typeof raw !== "string") return "INFO";
  const upper = raw.toUpperCase() as AuditFinding["level"];
  if (KNOWN_LEVELS.has(upper)) return upper;
  // Log each unfamiliar level once so noisy audit scripts don't flood the
  // console.
  if (!unknownLevelsLogged.has(raw)) {
    unknownLevelsLogged.add(raw);
    console.warn(`[audit] unknown finding level "${raw}" — rendering as INFO`);
  }
  return "INFO";
}
