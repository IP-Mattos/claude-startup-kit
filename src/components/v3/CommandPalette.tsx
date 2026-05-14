import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import {
  KEYBOARD_TAB_ORDER,
  SIDEBAR_NAV,
  TOPBAR_NAV,
} from "../../constants/v3Nav";
import type { V3Tab } from "../../v3/v3types";
import { IS_TAURI } from "../../lib/env";

// Cmd-K command palette — Linear / Raycast / VS Code style. Opens with
// Cmd/Ctrl+K, closes with Esc, navigates with arrow keys, fires with
// Enter. Universal keyboard-first shortcut.
//
// Source of items:
//   - All sidebar tabs (Overview, Projects, PRs, Audit, Cleanup)
//   - All topbar tabs (Claude, Sync, Companions, Settings)
//   - Action callbacks the host wires in (run audit, refresh, cycle
//     theme, etc.)
//
// Fuzzy match is intentionally simple: case-insensitive substring of
// name OR shortcut. No fuse.js dependency; the catalog is small.

export type CommandItem = {
  /** Stable id, used for React keys and to dedupe. */
  id: string;
  /** Visible label. Fully translated string from caller. */
  label: string;
  /** Optional secondary line (eg "Ctrl+,"). */
  hint?: string;
  /** Section grouping — Navegación, Acciones, etc. */
  section: string;
  /** Fired when the user picks this item. Closes the palette. */
  run: () => void;
};

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Tab navigation handler — wires nav items to AppV3's setTab. */
  onTab: (t: V3Tab) => void;
  /** Run-audit callback. */
  onRunAudit: () => void;
  /** Cycle theme callback. */
  onCycleTheme: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onTab,
  onRunAudit,
  onCycleTheme,
}: CommandPaletteProps) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build the full catalog from props + nav constants. Memoized so we
  // don't rebuild on every keystroke (the only thing that changes is
  // the filter result downstream).
  const items = useMemo<CommandItem[]>(() => {
    const navSection = t("palette.section_nav");
    const actionSection = t("palette.section_actions");
    const all: CommandItem[] = [];
    SIDEBAR_NAV.forEach(({ id, navKey }) => {
      const idx = KEYBOARD_TAB_ORDER.indexOf(id);
      all.push({
        id: `nav-${id}`,
        label: t(navKey),
        hint: idx >= 0 ? `Ctrl+${idx + 1}` : undefined,
        section: navSection,
        run: () => onTab(id),
      });
    });
    TOPBAR_NAV.forEach(({ id, navKey }) => {
      const hint =
        id === "settings" ? "Ctrl+," : undefined;
      all.push({
        id: `nav-${id}`,
        label: t(navKey),
        hint,
        section: navSection,
        run: () => onTab(id),
      });
    });
    all.push({
      id: "action-run-audit",
      label: t("status.run_audit"),
      hint: "Ctrl+R",
      section: actionSection,
      run: onRunAudit,
    });
    all.push({
      id: "action-cycle-theme",
      label: t("palette.cycle_theme"),
      hint: "Ctrl+T",
      section: actionSection,
      run: onCycleTheme,
    });
    return all;
  }, [t, onTab, onRunAudit, onCycleTheme]);

  // Fuzzy-ish match. Substring of label, case-insensitive. Hits early
  // (label.startsWith) rank above mid-string hits.
  //
  // Engram-search fall-through: when the user types >2 chars, we always
  // append a "Search engram for '<query>'" item at the bottom (in its own
  // Search section) so the palette becomes a discovery surface, not just a
  // command launcher. Click → IPC writes results to a file and opens VS Code.
  const filtered = useMemo(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    let matched: CommandItem[];
    if (!q) {
      matched = items;
    } else {
      const scored = items
        .map((it) => {
          const lbl = it.label.toLowerCase();
          const idx = lbl.indexOf(q);
          if (idx < 0) {
            if (it.hint && it.hint.toLowerCase().includes(q)) {
              return { item: it, score: 1000 };
            }
            return null;
          }
          return { item: it, score: idx };
        })
        .filter((x): x is { item: CommandItem; score: number } => x !== null)
        .sort((a, b) => a.score - b.score);
      matched = scored.map((s) => s.item);
    }
    if (raw.length > 2) {
      matched = [
        ...matched,
        {
          id: "search-engram",
          label: t("palette.search_engram", { query: raw }),
          section: t("palette.section_search"),
          run: () => {
            if (!IS_TAURI) return;
            // Fire-and-forget — the IPC opens VS Code on success. We
            // intentionally don't surface errors here: the palette is
            // already closing. Worst case the user sees nothing happen
            // and re-runs the search.
            void invoke<string>("engram_search_to_file", { query: raw }).catch(
              (e) => {
                // eslint-disable-next-line no-console
                console.warn("engram_search_to_file failed:", e);
              }
            );
          },
        },
      ];
    }
    return matched;
  }, [query, items, t]);

  // Group by section for rendering.
  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    filtered.forEach((it) => {
      const list = map.get(it.section) ?? [];
      list.push(it);
      map.set(it.section, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  // Reset state on open. Focus the input. Bound to `open` so reopening
  // gives a clean slate even after a previous Esc cancellation.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Tiny delay so the input exists in the DOM before we focus.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp activeIdx whenever the filtered list shrinks beneath it
  // (typing narrows the list; we don't want a stale highlight).
  useEffect(() => {
    if (activeIdx >= filtered.length) {
      setActiveIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, activeIdx]);

  // Keyboard nav inside the palette.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filtered[activeIdx];
      if (target) {
        target.run();
        onClose();
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="v3-palette-backdrop"
      onMouseDown={(e) => {
        // Click outside closes — but only if the click started on the
        // backdrop itself, not on a child the user is dragging through.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="v3-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title")}
      >
        <div className="v3-palette-input-row">
          <span className="v3-palette-prompt" aria-hidden="true">›</span>
          <input
            ref={inputRef}
            type="text"
            className="v3-palette-input"
            placeholder={t("palette.placeholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="v3-palette-kbd">esc</kbd>
        </div>
        <div className="v3-palette-list">
          {grouped.length === 0 ? (
            <div className="v3-palette-empty">{t("palette.empty")}</div>
          ) : (
            grouped.map(([section, sectionItems]) => (
              <div key={section} className="v3-palette-section">
                <div className="v3-palette-section-title">{section}</div>
                {sectionItems.map((it) => {
                  const globalIdx = filtered.indexOf(it);
                  const isActive = globalIdx === activeIdx;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={
                        "v3-palette-item" + (isActive ? " active" : "")
                      }
                      onMouseEnter={() => setActiveIdx(globalIdx)}
                      onClick={() => {
                        it.run();
                        onClose();
                      }}
                    >
                      <span className="v3-palette-item-arr">›</span>
                      <span className="v3-palette-item-label">{it.label}</span>
                      {it.hint && (
                        <span className="v3-palette-item-hint">{it.hint}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="v3-palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t("palette.foot_navigate")}
          </span>
          <span>
            <kbd>↵</kbd> {t("palette.foot_select")}
          </span>
          <span>
            <kbd>esc</kbd> {t("palette.foot_close")}
          </span>
        </div>
      </div>
    </div>
  );
}
