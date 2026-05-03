// Boundary validator for AuditFinding[].
//
// Rust returns `level: String`, TypeScript expects a strict union. Without a
// runtime check, an unrecognised level slips through, lands in the renderer
// as a typed `"OK" | "INFO" | "WARN" | "CRIT"`, and the icon/color logic
// silently falls back to the "info" branch — masking new findings shipped by
// a newer audit script. This module quarantines that mismatch.

import type { AuditFinding } from "../types";

const KNOWN_LEVELS = new Set<AuditFinding["level"]>(["OK", "INFO", "WARN", "CRIT"]);

let unknownLevelsLogged = new Set<string>();

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
    });
  }
  return out;
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
