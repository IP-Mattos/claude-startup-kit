// In-app confirm dialog. Replaces `window.confirm()` so we don't get the
// browser's native "tauri.localhost dice…" header — that breaks the visual
// language of the app and looks janky over a dark/themed UI.
//
// Usage: render <ConfirmModal open={...} ... /> conditionally and feed
// onConfirm / onCancel from the host component. ESC and backdrop click
// both resolve as cancel.

import { useEffect } from "react";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Tints the confirm button red to telegraph that the action is destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Close on Escape regardless of where focus is.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="v3-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="v3-modal-title"
      onClick={(e) => {
        // Only close when the click is on the backdrop itself, not bubbled
        // up from the modal body.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="v3-modal">
        <h2 id="v3-modal-title" className="v3-modal-title">
          {title}
        </h2>
        <p className="v3-modal-message">{message}</p>
        <div className="v3-modal-actions">
          <button
            type="button"
            className="v3-modal-cancel"
            onClick={onCancel}
            autoFocus
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={
              "v3-modal-confirm" + (danger ? " v3-modal-confirm-danger" : "")
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
