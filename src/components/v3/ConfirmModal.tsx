// In-app confirm dialog. Replaces `window.confirm()` so we don't get the
// browser's native "tauri.localhost dice…" header — that breaks the visual
// language of the app and looks janky over a dark/themed UI.
//
// Usage: render <ConfirmModal open={...} ... /> conditionally and feed
// onConfirm / onCancel from the host component. ESC and backdrop click
// both resolve as cancel.
//
// A11y: keeps focus inside the modal while it's open. Tab cycles between
// Cancel and Confirm; Shift-Tab reverses. Restores the previously-focused
// element on close so keyboard users return to where they were.

import { useEffect, useRef } from "react";

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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);

  // Close on Escape regardless of where focus is.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  // Focus management: remember whoever had focus when we opened, focus the
  // Cancel button (safer default for destructive flows), and restore on
  // close so keyboard users land back where they started.
  useEffect(() => {
    if (!open) return;
    previousActiveRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Defer one frame so the rendered button exists in the DOM.
    const id = requestAnimationFrame(() => {
      cancelRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      previousActiveRef.current?.focus?.();
    };
  }, [open]);

  // Focus trap: while the modal is open, intercept Tab / Shift-Tab and
  // keep focus inside the dialog. Without this, Tab leaves the modal scope
  // and hits background controls — `aria-modal="true"` would be lying to
  // screen readers and keyboard-only users get stranded outside.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const cancel = cancelRef.current;
      const confirm = confirmRef.current;
      if (!cancel || !confirm) return;
      const active = document.activeElement;
      if (e.shiftKey) {
        // Shift+Tab from Cancel cycles to Confirm.
        if (active === cancel) {
          e.preventDefault();
          confirm.focus();
        }
      } else {
        // Tab from Confirm cycles to Cancel.
        if (active === confirm) {
          e.preventDefault();
          cancel.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

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
            ref={cancelRef}
            type="button"
            className="v3-modal-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
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
