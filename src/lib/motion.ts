import { motionScale } from '../state/settings';

export const EASE_IN = 'cubic-bezier(0.2, 0, 0, 1)';
export const EASE_OUT = 'cubic-bezier(0.3, 0, 1, 1)';
export const DUR = { press: 90, nav: 140, menu: 180, pane: 220 } as const;

/** transform/opacity-only WAAPI animation honoring the animation-speed setting. Interruptible. */
export function animate(el: Element | undefined | null, frames: Keyframe[], kind: keyof typeof DUR, exit = false): Animation | null {
  const k = motionScale();
  if (!el || k === 0) return null;
  el.getAnimations().forEach((a) => a.cancel());
  return el.animate(frames, { duration: DUR[kind] * k * (exit ? 0.6 : 1), easing: exit ? EASE_OUT : EASE_IN });
}

export const popIn = (el: Element | undefined, origin?: string) => {
  if (el && origin) (el as HTMLElement).style.transformOrigin = origin;
  return animate(el, [{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'scale(1)' }], 'menu');
};
