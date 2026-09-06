import { useEffect } from 'react';
import { ThemeSelector } from './ThemeSelector';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Site-wide settings dialog. Currently hosts the Appearance section
 * (Obsidian default theme selector); account management stays on the
 * Settings page. Preference persists in localStorage.
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="presentation"
      aria-hidden={false}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="settings-modal-title">Settings</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>
        <section className="modal-section">
          <h3>Appearance</h3>
          <p className="muted">
            Tephra uses Obsidian&apos;s default theme. Pick the base color scheme;
            your choice is saved on this device.
          </p>
          <ThemeSelector />
        </section>
      </div>
    </div>
  );
}
