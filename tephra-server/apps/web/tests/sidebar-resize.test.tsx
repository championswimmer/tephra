import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarResizeHandle } from '../src/components/SidebarResizeHandle';
import { useSidebarWidths } from '../src/hooks/useSidebarWidths';

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
  document.documentElement.style.userSelect = '';
  document.documentElement.style.cursor = '';
});

describe('sidebar width preferences', () => {
  it('persists independently, restores widths, and bounds widths as the viewport changes', () => {
    const first = renderHook(useSidebarWidths);
    expect(first.result.current.left.width).toBe(240);
    expect(first.result.current.right.width).toBe(220);
    act(() => first.result.current.left.resize(350));
    act(() => first.result.current.right.resize(300));
    first.unmount();
    const restored = renderHook(useSidebarWidths);
    expect(restored.result.current.left.width).toBe(350);
    expect(restored.result.current.right.width).toBe(300);
    act(() => {
      window.innerWidth = 700;
      window.dispatchEvent(new Event('resize'));
    });
    expect(restored.result.current.maxWidth).toBe(280);
    expect(restored.result.current.left.width).toBe(280);
    expect(restored.result.current.right.width).toBe(280);
    act(() => restored.result.current.left.resize(100));
    expect(restored.result.current.left.width).toBe(160);
    expect(window.localStorage.getItem('tephra:sidebar-left-width')).toBe('160');
    act(() => restored.result.current.right.resize(1000));
    expect(window.localStorage.getItem('tephra:sidebar-right-width')).toBe('280');
  });

  it('ignores malformed preferences and survives blocked storage', () => {
    window.localStorage.setItem('tephra:sidebar-left-width', 'Infinity');
    window.localStorage.setItem('tephra:sidebar-right-width', '');
    const defaults = renderHook(useSidebarWidths);
    expect(defaults.result.current.left.width).toBe(240);
    expect(defaults.result.current.right.width).toBe(220);
    defaults.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Blocked');
    });
    const blocked = renderHook(useSidebarWidths);
    act(() => blocked.result.current.left.resize(320));
    expect(blocked.result.current.left.width).toBe(320);
    expect(blocked.result.current.right.width).toBe(220);
  });
});

function Splitters() {
  const widths = useSidebarWidths();
  return (
    <>
      {(['left', 'right'] as const).map((side) => (
        <SidebarResizeHandle
          key={side}
          side={side}
          label={side}
          controls={`${side}-pane`}
          width={widths[side].width}
          minWidth={widths.minWidth}
          maxWidth={widths.maxWidth}
          onResize={widths[side].resize}
        />
      ))}
    </>
  );
}

function pointer(target: HTMLElement, type: string, x: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  fireEvent(target, event);
}

function capture(target: HTMLElement) {
  target.setPointerCapture = vi.fn();
  target.hasPointerCapture = vi.fn(() => true);
  target.releasePointerCapture = vi.fn();
}

describe('sidebar resize separator', () => {
  it('supports directional keyboard resizing, larger steps, and accessible bounds', () => {
    render(<Splitters />);
    const left = screen.getByRole('separator', { name: 'left' });
    const right = screen.getByRole('separator', { name: 'right' });
    expect(left).toHaveAttribute('aria-orientation', 'vertical');
    expect(left).toHaveAttribute('aria-controls', 'left-pane');
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(left).toHaveAttribute('aria-valuenow', '250');
    fireEvent.keyDown(right, { key: 'ArrowLeft', shiftKey: true });
    expect(right).toHaveAttribute('aria-valuenow', '260');
    fireEvent.keyDown(left, { key: 'End' });
    expect(left).toHaveAttribute('aria-valuenow', '480');
    fireEvent.keyDown(left, { key: 'ArrowRight' });
    expect(left).toHaveAttribute('aria-valuenow', '480');
    fireEvent.keyDown(right, { key: 'Home' });
    fireEvent.keyDown(right, { key: 'ArrowRight' });
    expect(right).toHaveAttribute('aria-valuenow', '160');
  });

  it('captures drag input, ignores other pointers, and cleans up after cancellation and unmount', () => {
    document.documentElement.style.userSelect = 'text';
    const view = render(<Splitters />);
    const left = screen.getByRole('separator', { name: 'left' });
    capture(left);
    pointer(left, 'pointerdown', 240);
    expect(left.setPointerCapture).toHaveBeenCalledWith(1);
    expect(document.documentElement.style.userSelect).toBe('none');
    pointer(left, 'pointermove', 400, 2);
    expect(left).toHaveAttribute('aria-valuenow', '240');
    pointer(left, 'pointermove', 340);
    expect(left).toHaveAttribute('aria-valuenow', '340');
    pointer(left, 'pointercancel', 340);
    expect(left.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(document.documentElement.style.userSelect).toBe('text');
    pointer(left, 'pointermove', 450);
    expect(left).toHaveAttribute('aria-valuenow', '340');
    const right = screen.getByRole('separator', { name: 'right' });
    capture(right);
    pointer(right, 'pointerdown', 980);
    pointer(right, 'pointermove', 900);
    expect(right).toHaveAttribute('aria-valuenow', '300');
    view.unmount();
    expect(document.documentElement.style.userSelect).toBe('text');
    expect(document.documentElement.style.cursor).toBe('');
  });
});
