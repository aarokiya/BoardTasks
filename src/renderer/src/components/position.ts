export type Placement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top' | 'right' | 'left';

export interface Rect { top: number; left: number; width: number; height: number }

export interface PositionResult { top: number; left: number; placement: Placement }

const MARGIN = 8;

/** Places a `size` box against `anchor`, flipping and clamping to the viewport. */
export function position(anchor: Rect, size: { width: number; height: number }, placement: Placement, viewport = { width: window.innerWidth, height: window.innerHeight }): PositionResult {
  let place = placement;
  const below = viewport.height - (anchor.top + anchor.height);
  if (place.startsWith('bottom') && below < size.height + MARGIN && anchor.top > size.height + MARGIN) {
    place = place.replace('bottom', 'top') as Placement;
  } else if (place.startsWith('top') && anchor.top < size.height + MARGIN && below > size.height + MARGIN) {
    place = place.replace('top', 'bottom') as Placement;
  }

  let top: number;
  let left: number;
  if (place.startsWith('bottom')) top = anchor.top + anchor.height + 4;
  else if (place.startsWith('top')) top = anchor.top - size.height - 4;
  else top = anchor.top;

  if (place === 'right') left = anchor.left + anchor.width + 4;
  else if (place === 'left') left = anchor.left - size.width - 4;
  else if (place.endsWith('-end')) left = anchor.left + anchor.width - size.width;
  else if (place === 'bottom' || place === 'top') left = anchor.left + anchor.width / 2 - size.width / 2;
  else left = anchor.left;

  left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - size.width - MARGIN));
  top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - size.height - MARGIN));
  return { top, left, placement: place };
}
