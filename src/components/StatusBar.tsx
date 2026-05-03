import { memo, useEffect, useState } from "react";
import type { Tab } from "../types";
import { hexId } from "../lib/format";

// Computed once at module load — stable across re-renders, no useMemo needed.
const SESSION_ID =
  hexId(String(Date.now())) +
  hexId(typeof navigator !== "undefined" ? navigator.userAgent : "");

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return (
    <span className="sb-mono sb-clock">
      {hh}:{mm}:{ss}
    </span>
  );
}

export const StatusBar = memo(function StatusBar({
  tab,
  itemCount,
  windowDays,
}: {
  tab: Tab;
  itemCount: number;
  windowDays: number;
}) {
  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="sb-cell sb-brand">
        <span className="sb-glyph">⟁</span> CSK <span className="sb-dim">v0.1.0</span>
      </span>
      <span className="sb-sep">│</span>
      <span className="sb-cell">
        <span className="sb-dim">Pestaña </span>
        <span className="sb-mono">{tab}</span>
      </span>
      <span className="sb-sep">│</span>
      <span className="sb-cell">
        <span className="sb-mono">{itemCount}</span>
        <span className="sb-dim"> nodos</span>
      </span>
      <span className="sb-sep">│</span>
      <span className="sb-cell">
        <span className="sb-dim">Ventana </span>
        <span className="sb-mono">{windowDays}d</span>
      </span>
      <span className="sb-sep">│</span>
      <span className="sb-cell sb-spacer">
        <span className="sb-dim">Sesión </span>
        <span className="sb-mono">0x{SESSION_ID}</span>
      </span>
      <span className="sb-sep">│</span>
      <span className="sb-cell">
        <Clock />
      </span>
    </footer>
  );
});
