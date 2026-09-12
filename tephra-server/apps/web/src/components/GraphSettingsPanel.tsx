import { useEffect, useRef, useState } from 'react';
import { Plus, RotateCcw, X } from 'lucide-react';
import type { ColorGroup, GraphScope, GraphSettings } from '@tephra/graph-renderer/pure';
import { SETTINGS_LIMITS } from '@tephra/graph-renderer/pure';

/** Debounce before the search text reaches the simulation (the note list is unaffected). */
export const GRAPH_SEARCH_DEBOUNCE_MS = 250;

const NEW_GROUP_COLORS = ['#e07856', '#7f6df2', '#4caf50', '#2196f3', '#e0a100'];
const MAX_GROUPS = 20;

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="graph-settings-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}</output>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="graph-settings-row">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />{' '}
        {label}
      </label>
    </div>
  );
}

export function GraphSettingsPanel({
  id,
  scope,
  settings,
  onChange,
  onRestoreDefaults,
  depthVisible = false,
}: {
  /** Element id so the toggle button can use aria-controls. */
  id: string;
  scope: GraphScope;
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onRestoreDefaults: () => void;
  /** Local graph only: show the neighbourhood depth slider. */
  depthVisible?: boolean;
}) {
  const prefix = `graph-settings-${scope}`;
  // The search box is locally controlled and debounced; everything else
  // reports through onChange immediately.
  const [searchInput, setSearchInput] = useState(settings.search);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Adopt externally imposed search text (vault switch, restore defaults).
  useEffect(() => {
    setSearchInput(settings.search);
  }, [settings.search]);

  useEffect(() => {
    if (searchInput === settingsRef.current.search) return;
    const timer = setTimeout(() => {
      onChangeRef.current({ ...settingsRef.current, search: searchInput });
    }, GRAPH_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const update = (patch: Partial<GraphSettings>) => onChange({ ...settings, ...patch });

  const addGroup = () => {
    if (settings.groups.length >= MAX_GROUPS) return;
    const color = NEW_GROUP_COLORS[settings.groups.length % NEW_GROUP_COLORS.length]!;
    update({ groups: [...settings.groups, { query: '', color }] });
  };
  const updateGroup = (index: number, patch: Partial<ColorGroup>) =>
    update({
      groups: settings.groups.map((group, position) =>
        position === index ? { ...group, ...patch } : group,
      ),
    });
  const removeGroup = (index: number) =>
    update({ groups: settings.groups.filter((_, position) => position !== index) });

  return (
    <div className="graph-settings" id={id} role="group" aria-label="Graph settings">
      <details open>
        <summary>Filters</summary>
        <div className="graph-settings-row">
          <label htmlFor={`${prefix}-search`}>Search</label>
          <input
            id={`${prefix}-search`}
            type="search"
            value={searchInput}
            placeholder="e.g. tag:#project path:daily"
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <Toggle
          id={`${prefix}-show-tags`}
          label="Tags"
          checked={settings.showTags}
          onChange={(checked) => update({ showTags: checked })}
        />
        <Toggle
          id={`${prefix}-show-attachments`}
          label="Attachments"
          checked={settings.showAttachments}
          onChange={(checked) => update({ showAttachments: checked })}
        />
        <Toggle
          id={`${prefix}-existing-only`}
          label="Existing files only"
          checked={settings.existingOnly}
          onChange={(checked) => update({ existingOnly: checked })}
        />
        <Toggle
          id={`${prefix}-show-orphans`}
          label="Orphans"
          checked={settings.showOrphans}
          onChange={(checked) => update({ showOrphans: checked })}
        />
        {depthVisible && (
          <Slider
            id={`${prefix}-depth`}
            label="Depth"
            value={settings.depth}
            min={SETTINGS_LIMITS.depth.min}
            max={SETTINGS_LIMITS.depth.max}
            step={1}
            onChange={(depth) => update({ depth: Math.round(depth) })}
          />
        )}
      </details>
      <details open>
        <summary>Groups</summary>
        <p className="graph-settings-hint">The first matching group colors a node.</p>
        {settings.groups.map((group, index) => (
          <div className="graph-settings-row graph-group-row" key={index}>
            <label htmlFor={`${prefix}-group-${index}-query`} className="visually-hidden">
              Group {index + 1} query
            </label>
            <input
              id={`${prefix}-group-${index}-query`}
              type="text"
              value={group.query}
              placeholder="e.g. tag:#project"
              onChange={(event) => updateGroup(index, { query: event.target.value })}
            />
            <label htmlFor={`${prefix}-group-${index}-color`} className="visually-hidden">
              Group {index + 1} color
            </label>
            <input
              id={`${prefix}-group-${index}-color`}
              type="color"
              value={group.color}
              onChange={(event) => updateGroup(index, { color: event.target.value })}
            />
            <button
              type="button"
              onClick={() => removeGroup(index)}
              aria-label={`Remove group ${index + 1}`}
            >
              <X size={14} aria-hidden="true" focusable="false" className="icon" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="icon-button"
          onClick={addGroup}
          disabled={settings.groups.length >= MAX_GROUPS}
        >
          <Plus size={14} aria-hidden="true" focusable="false" className="icon" />
          Add group
        </button>
      </details>
      <details open>
        <summary>Display</summary>
        <Toggle
          id={`${prefix}-show-arrows`}
          label="Arrows"
          checked={settings.showArrows}
          onChange={(checked) => update({ showArrows: checked })}
        />
        <Slider
          id={`${prefix}-text-fade`}
          label="Text fade threshold"
          value={settings.textFadeThreshold}
          min={SETTINGS_LIMITS.textFadeThreshold.min}
          max={SETTINGS_LIMITS.textFadeThreshold.max}
          step={0.05}
          onChange={(textFadeThreshold) => update({ textFadeThreshold })}
        />
        <Slider
          id={`${prefix}-node-size`}
          label="Node size"
          value={settings.nodeSize}
          min={SETTINGS_LIMITS.nodeSize.min}
          max={SETTINGS_LIMITS.nodeSize.max}
          step={0.25}
          onChange={(nodeSize) => update({ nodeSize })}
        />
        <Slider
          id={`${prefix}-link-thickness`}
          label="Link thickness"
          value={settings.linkThickness}
          min={SETTINGS_LIMITS.linkThickness.min}
          max={SETTINGS_LIMITS.linkThickness.max}
          step={0.25}
          onChange={(linkThickness) => update({ linkThickness })}
        />
      </details>
      <details open>
        <summary>Forces</summary>
        <Slider
          id={`${prefix}-center-force`}
          label="Center force"
          value={settings.centerForce}
          min={SETTINGS_LIMITS.centerForce.min}
          max={SETTINGS_LIMITS.centerForce.max}
          step={0.05}
          onChange={(centerForce) => update({ centerForce })}
        />
        <Slider
          id={`${prefix}-repel-force`}
          label="Repel force"
          value={settings.repelForce}
          min={SETTINGS_LIMITS.repelForce.min}
          max={SETTINGS_LIMITS.repelForce.max}
          step={0.1}
          onChange={(repelForce) => update({ repelForce })}
        />
        <Slider
          id={`${prefix}-link-force`}
          label="Link force"
          value={settings.linkForce}
          min={SETTINGS_LIMITS.linkForce.min}
          max={SETTINGS_LIMITS.linkForce.max}
          step={0.05}
          onChange={(linkForce) => update({ linkForce })}
        />
        <Slider
          id={`${prefix}-link-distance`}
          label="Link distance"
          value={settings.linkDistance}
          min={SETTINGS_LIMITS.linkDistance.min}
          max={SETTINGS_LIMITS.linkDistance.max}
          step={5}
          onChange={(linkDistance) => update({ linkDistance })}
        />
      </details>
      <button type="button" className="icon-button" onClick={onRestoreDefaults}>
        <RotateCcw size={14} aria-hidden="true" focusable="false" className="icon" />
        Restore defaults
      </button>
    </div>
  );
}
