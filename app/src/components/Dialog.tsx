/**
 * Accessible modal dialog built on the native <dialog> element.
 *
 * Native <dialog> + showModal() gives focus trapping, Escape to close and an
 * inert background for free, which hand-rolled modals usually get wrong.
 *
 * @param open      whether the dialog is shown
 * @param title     heading text, also the dialog's accessible name
 * @param onClose   called on Escape, backdrop click, or a Cancel button
 * @param children  body and actions
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Dialog.module.css";

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Dialog({ open, title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Sync the `open` prop with the imperative showModal()/close() API.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal?.();
    if (!open && el.open) el.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault(); // let React state drive closing
        onClose();
      }}
      onClick={(e) => {
        // A click on the <dialog> itself (not its content) is a backdrop click.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.body}>
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
        {open && children}
      </div>
    </dialog>
  );
}
