import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

interface SidebarResizeHandleProps {
  side: 'left' | 'right';
  controls: string;
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
}

/** An inner-edge splitter: dragging left enlarges the right sidebar and vice versa. */
export function SidebarResizeHandle({
  side,
  controls,
  label,
  width,
  minWidth,
  maxWidth,
  onResize,
}: SidebarResizeHandleProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const restoreSelection = useRef<(() => void) | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => () => restoreSelection.current?.(), []);
  const direction = side === 'left' ? 1 : -1;

  function finish(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    restoreSelection.current?.();
    restoreSelection.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = width - direction * (event.shiftKey ? 40 : 10);
        break;
      case 'ArrowRight':
        next = width + direction * (event.shiftKey ? 40 : 10);
        break;
      case 'Home':
        next = minWidth;
        break;
      case 'End':
        next = maxWidth;
        break;
      default:
        return;
    }
    event.preventDefault();
    onResize(next);
  }

  return (
    <div
      className={`sidebar-resize-handle sidebar-resize-${side}${resizing ? ' is-resizing' : ''}`}
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      tabIndex={0}
      onKeyDown={keyDown}
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        const previous = document.documentElement.style.userSelect;
        const previousCursor = document.documentElement.style.cursor;
        document.documentElement.style.userSelect = 'none';
        document.documentElement.style.cursor = 'col-resize';
        restoreSelection.current = () => {
          document.documentElement.style.userSelect = previous;
          document.documentElement.style.cursor = previousCursor;
        };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start?.pointerId !== event.pointerId) return;
        onResize(start.width + direction * (event.clientX - start.x));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}
