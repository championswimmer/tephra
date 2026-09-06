import { useTheme } from '../theme/ThemeContext';
import type { ThemeBase } from '../theme/themes';

const OPTIONS: Array<{ value: ThemeBase; label: string; hint: string }> = [
  { value: 'light', label: 'Light', hint: 'Default light appearance' },
  { value: 'dark', label: 'Dark', hint: 'Default dark appearance' },
  { value: 'system', label: 'System', hint: 'Follow your device setting' },
];

/**
 * Base color-scheme selector. Obsidian ships a single "Default" theme with
 * light/dark schemes, so the selector mirrors Obsidian's own Appearance
 * setting ("Base color scheme").
 */
export function ThemeSelector({ compact = false }: { compact?: boolean }) {
  const { base, setBase } = useTheme();
  return (
    <div className={compact ? 'theme-options compact' : 'theme-options'} role="radiogroup" aria-label="Base color scheme">
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className={base === option.value ? 'theme-option selected' : 'theme-option'}
        >
          <input
            type="radio"
            name="tephra-base-scheme"
            value={option.value}
            checked={base === option.value}
            onChange={() => setBase(option.value)}
          />
          <span
            className={`theme-swatch theme-swatch-${option.value}`}
            aria-hidden="true"
          />
          <span className="theme-option-text">
            <strong>{option.label}</strong>
            {!compact && <small>{option.hint}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}
