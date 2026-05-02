import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

export function Titlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    win
      .onResized(() => {
        win.isMaximized().then((m) => {
          if (!cancelled) setMaximized(m);
        });
      })
      .then((u) => {
        if (cancelled) {
          u();
        } else {
          unlisten = u;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="emblem" aria-hidden="true">
          <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" fill="none" />
            <circle cx="8" cy="8" r="2.5" fill="currentColor" />
            <path
              d="M8 0.5 L9 3 L8 2.5 L7 3 Z M8 15.5 L9 13 L8 13.5 L7 13 Z M0.5 8 L3 9 L2.5 8 L3 7 Z M15.5 8 L13 9 L13.5 8 L13 7 Z"
              fill="currentColor"
              opacity="0.9"
            />
          </svg>
        </span>
        <span className="titlebar-title">Claude Startup Kit</span>
      </div>
      <div className="titlebar-drag" data-tauri-drag-region />
      <div className="window-controls">
        <button className="wc" onClick={() => win.minimize()} title="Minimizar">
          <Minus size={12} strokeWidth={2.5} />
        </button>
        <button
          className="wc"
          onClick={() => win.toggleMaximize()}
          title={maximized ? "Restaurar" : "Maximizar"}
        >
          <Square size={11} strokeWidth={2} />
        </button>
        <button className="wc wc-close" onClick={() => win.close()} title="Cerrar">
          <X size={13} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
