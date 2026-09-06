import { describe, expect, it } from 'vitest';
import {
  isSupportedPluginVersion,
  MINIMUM_PLUGIN_VERSION,
  PLUGIN_VERSION_HEADER,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  syncCommitResponseSchema,
  syncPlanResponseSchema,
} from '../src/index.js';

describe('protocol versioning', () => {
  it('exposes the current protocol version and minimum plugin version', () => {
    expect(PROTOCOL_VERSION).toBe('1');
    expect(MINIMUM_PLUGIN_VERSION).toBe('0.1.0');
    expect(PROTOCOL_VERSION_HEADER).toBe('X-Tephra-Protocol-Version');
    expect(PLUGIN_VERSION_HEADER).toBe('X-Tephra-Plugin-Version');
  });

  it('accepts sync responses with and without the additive version fields', () => {
    expect(
      syncPlanResponseSchema.safeParse({
        status: 'up-to-date',
        latestRevision: 3,
        missingBlobs: [],
      }).success,
    ).toBe(true);
    expect(
      syncPlanResponseSchema.safeParse({
        status: 'upload-required',
        latestRevision: 3,
        missingBlobs: [],
        protocolVersion: '1',
        minimumPluginVersion: '0.1.0',
      }).success,
    ).toBe(true);
    expect(syncCommitResponseSchema.safeParse({ status: 'committed', revision: 1 }).success).toBe(
      true,
    );
    expect(
      syncCommitResponseSchema.safeParse({
        status: 'up-to-date',
        revision: 1,
        protocolVersion: '1',
        minimumPluginVersion: '0.1.0',
      }).success,
    ).toBe(true);
  });

  it('evaluates plugin versions against the minimum supported release', () => {
    expect(isSupportedPluginVersion(null)).toBe(true);
    expect(isSupportedPluginVersion(undefined)).toBe(true);
    expect(isSupportedPluginVersion('')).toBe(true);
    expect(isSupportedPluginVersion('0.1.0')).toBe(true);
    expect(isSupportedPluginVersion('0.2.0')).toBe(true);
    expect(isSupportedPluginVersion('1.0.0')).toBe(true);
    expect(isSupportedPluginVersion('0.0.9')).toBe(false);
    expect(isSupportedPluginVersion('not-a-version')).toBe(false);
  });
});
