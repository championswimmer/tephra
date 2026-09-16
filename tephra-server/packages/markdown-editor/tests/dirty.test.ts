import { describe, expect, it } from 'vitest';

import { isDirty, shouldSave } from '../src/dirty';

describe('isDirty', () => {
  it('is false for identical text', () => {
    expect(isDirty('hello', 'hello')).toBe(false);
  });

  it('is true for any difference, including whitespace-only', () => {
    expect(isDirty('hello', 'hello ')).toBe(true);
    expect(isDirty('hello\n', 'hello\r\n')).toBe(true);
  });

  it('is a strict string compare, not a normalized one', () => {
    expect(isDirty('', '')).toBe(false);
    expect(isDirty('', '\n')).toBe(true);
  });
});

describe('shouldSave', () => {
  it('allows saving dirty, non-saving state', () => {
    expect(shouldSave({ baseText: 'a', currentText: 'b', saving: false })).toBe(true);
  });

  it('blocks saving unchanged text (client half of byte fidelity)', () => {
    expect(shouldSave({ baseText: 'a', currentText: 'a', saving: false })).toBe(false);
  });

  it('blocks concurrent saves while one is in flight', () => {
    expect(shouldSave({ baseText: 'a', currentText: 'b', saving: true })).toBe(false);
    expect(shouldSave({ baseText: 'a', currentText: 'a', saving: true })).toBe(false);
  });
});
