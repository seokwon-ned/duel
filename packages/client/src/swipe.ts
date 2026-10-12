import { Direction } from '@turf-duel/engine';

export const SWIPE_THRESHOLD_PX = 20;
export const BOTTOM_EDGE_GUARD_PX = 24;

export function isSwipeZone(clientY: number, viewportHeight: number): boolean {
  return clientY >= viewportHeight / 2 && clientY < viewportHeight - BOTTOM_EDGE_GUARD_PX;
}

export function directionFromSwipe(
  dx: number,
  dy: number,
  threshold = SWIPE_THRESHOLD_PX
): Direction | null {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) {
    return null;
  }

  return Math.abs(dx) >= Math.abs(dy)
    ? dx > 0
      ? Direction.RIGHT
      : Direction.LEFT
    : dy > 0
      ? Direction.DOWN
      : Direction.UP;
}

export function attachSwipeControls(onDirection: (direction: Direction) => void): () => void {
  let origin: { x: number; y: number } | null = null;

  const start = (x: number, y: number) => {
    if (!isSwipeZone(y, window.innerHeight)) {
      origin = null;
      return;
    }
    origin = { x, y };
  };

  const move = (x: number, y: number, event?: Event) => {
    if (!origin) {
      return;
    }

    const direction = directionFromSwipe(x - origin.x, y - origin.y);
    if (!direction) {
      return;
    }

    event?.preventDefault();
    origin = { x, y };
    onDirection(direction);
  };

  const end = () => {
    origin = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    start(event.clientX, event.clientY);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!origin) {
      return;
    }
    move(event.clientX, event.clientY, event);
  };

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) {
      start(touch.clientX, touch.clientY);
    }
  };

  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (touch) {
      move(touch.clientX, touch.clientY, event);
    }
  };

  const usePointer = typeof window.PointerEvent !== 'undefined';

  if (usePointer) {
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  } else {
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  }

  return () => {
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', end);
  };
}
