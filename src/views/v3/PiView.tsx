import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, HelpCircle, RefreshCw, XCircle } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT, type StringKey } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

// Payload shape of the Rust `pi_stack_status` command (src-tauri/src/lib.rs).
// Fields are snake_case on purpose — the neighbouring GentleAiStatus struct
// carries no `rename_all` either, so camelCase here would be the odd one out.
interface PiCliInfo {
  version: string | null;
  path: string | null;
}

interface PiStackClaudeCodeInfo {
  version: string | null;
}

interface GentlePiInfo {
  installed: boolean;
  version: string | null;
  root: string | null;
}

interface GentleAiBinaryInfo {
  pinned_version: string | null;
  expected_path: string | null;
  present: boolean;
}

interface PiSettingsInfo {
  default_provider: string | null;
  default_model: string | null;
  tui_mode: string | null;
  packages: string[];
}

interface PiStackStatus {
  pi: PiCliInfo;
  claude_code: PiStackClaudeCodeInfo;
  gentle_pi: GentlePiInfo;
  gentle_ai_binary: GentleAiBinaryInfo;
  settings: PiSettingsInfo;
  errors: string[];
}

type RowState = "ok" | "missing" | "unknown";
type TFunc = ReturnType<typeof useT>["t"];

// Em dash placeholder for a null scalar — same convention as WorkspaceCard /
// SettingsView (`value ?? "—"`). It's punctuation, not prose, so it doesn't
// need a translation key.
const dash = (v: string | null): string => v ?? "—";

const STATE_ICON: Record<RowState, typeof CheckCircle2> = {
  ok: CheckCircle2,
  missing: XCircle,
  unknown: HelpCircle,
};

// Reuses ClaudeView's exact pill vocabulary (v3-gai-status-pill[-ok|-missing])
// instead of inventing new CSS. "unknown" falls back to the unmodified base
// pill class, which already renders as a neutral/bordered chip.
const STATE_PILL_CLASS: Record<RowState, string> = {
  ok: "v3-gai-status-pill v3-gai-status-pill-ok",
  missing: "v3-gai-status-pill v3-gai-status-pill-missing",
  unknown: "v3-gai-status-pill",
};

const STATE_LABEL_KEY: Record<RowState, StringKey> = {
  ok: "pi.state_ok",
  missing: "pi.state_missing",
  unknown: "pi.state_unknown",
};

function StatusPill({ state, t }: { state: RowState; t: TFunc }) {
  const Icon = STATE_ICON[state];
  return (
    <span className={STATE_PILL_CLASS[state]}>
      <Icon size={11} strokeWidth={2.4} />
      {t(STATE_LABEL_KEY[state])}
    </span>
  );
}

// One health row — mirrors ClaudeView's `.v3-claude-row` list-item shape
// (name + pill on the title line, a clamped meta line below). `detail` is an
// optional unclamped paragraph (reuses `.v3-gai-component-desc`) for the
// gentle-ai binary fix instructions and the settings package list, neither
// of which should be silently truncated.
function StatusRow({
  title,
  state,
  meta,
  detail,
  t,
}: {
  title: string;
  state: RowState;
  meta: string;
  detail?: string;
  t: TFunc;
}) {
  return (
    <li className="v3-claude-row">
      <div className="v3-claude-row-body">
        <div className="v3-claude-row-title">
          <span className="v3-claude-row-name">{title}</span>
          <StatusPill state={state} t={t} />
        </div>
        <div className="v3-claude-row-meta">{meta}</div>
        {detail && <p className="v3-gai-component-desc">{detail}</p>}
      </div>
    </li>
  );
}

export function PiView() {
  const { t } = useT();
  const [status, setStatus] = useState<PiStackStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<PiStackStatus>("pi_stack_status")
      .then((st) => {
        if (cancelled) return;
        setStatus(st);
        setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(friendlyErrorEn(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const piState: RowState = status?.pi.version ? "ok" : "missing";
  const claudeState: RowState = status?.claude_code.version ? "ok" : "missing";
  const gentlePiState: RowState = status?.gentle_pi.installed ? "ok" : "missing";
  // The pinned version is our only signal for the binary row: without it we
  // genuinely don't know whether the binary is present or absent, so this is
  // "unknown" rather than a false "missing" — distinct from every other row,
  // which the backend always resolves to a definite boolean.
  const binaryState: RowState = !status
    ? "unknown"
    : status.gentle_ai_binary.pinned_version === null
      ? "unknown"
      : status.gentle_ai_binary.present
        ? "ok"
        : "missing";
  // Same ambiguity for settings: an all-empty payload could mean "genuinely
  // unconfigured" or "read/parse failed" — the errors banner below carries
  // the real reason, so this row stays "unknown" rather than guessing.
  const hasSettings =
    !!status &&
    (status.settings.default_provider !== null ||
      status.settings.default_model !== null ||
      status.settings.tui_mode !== null ||
      status.settings.packages.length > 0);
  const settingsState: RowState = !status ? "unknown" : hasSettings ? "ok" : "unknown";

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("pi.title")}</h1>
          <p className="v3-subtitle">{t("pi.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <button
            type="button"
            className="v3-link"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading ? ` ${t("common.refreshing")}` : ` ${t("common.refresh")}`}
          </button>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading ? (
        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("pi.card_title")}</h2>
          </header>
          <div className="v3-empty">{t("common.loading")}</div>
        </article>
      ) : !status ? (
        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("pi.card_title")}</h2>
          </header>
          <div className="v3-empty">{t("pi.unavailable")}</div>
        </article>
      ) : (
        <>
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("pi.card_title")}</h2>
            </header>
            <ul className="v3-list">
              <StatusRow
                title={t("pi.row_pi_title")}
                state={piState}
                meta={t("pi.row_pi_meta", {
                  version: dash(status.pi.version),
                  path: dash(status.pi.path),
                })}
                t={t}
              />
              <StatusRow
                title={t("pi.row_claude_title")}
                state={claudeState}
                meta={t("pi.row_claude_meta", {
                  version: dash(status.claude_code.version),
                })}
                t={t}
              />
              <StatusRow
                title={t("pi.row_gentlepi_title")}
                state={gentlePiState}
                meta={t("pi.row_gentlepi_meta", {
                  version: dash(status.gentle_pi.version),
                  root: dash(status.gentle_pi.root),
                })}
                t={t}
              />
              <StatusRow
                title={t("pi.row_binary_title")}
                state={binaryState}
                meta={t("pi.row_binary_meta", {
                  version: dash(status.gentle_ai_binary.pinned_version),
                  path: dash(status.gentle_ai_binary.expected_path),
                })}
                detail={binaryState === "missing" ? t("pi.row_binary_fix") : undefined}
                t={t}
              />
              <StatusRow
                title={t("pi.row_settings_title")}
                state={settingsState}
                meta={t("pi.row_settings_meta", {
                  provider: dash(status.settings.default_provider),
                  model: dash(status.settings.default_model),
                  tui: dash(status.settings.tui_mode),
                })}
                detail={t("pi.row_settings_packages", {
                  packages:
                    status.settings.packages.length > 0
                      ? status.settings.packages.join(", ")
                      : "—",
                })}
                t={t}
              />
            </ul>
          </article>

          {/* Per-source failures — never let a backend failure look like an
              empty state (repo convention, same as AppV3's fetchErrors). */}
          {status.errors.length > 0 && (
            <div className="v3-error" role="alert" aria-live="assertive">
              <strong>{t("pi.errors_title")}</strong>
              <ul>
                {status.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
