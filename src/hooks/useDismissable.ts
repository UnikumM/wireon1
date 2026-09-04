import React, { useCallback, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

interface OverlayEntry {
  onEscape: (() => void) | null;
}

/**
 * Every mounted dismissable layer, oldest first. Escape is delivered to the last
 * entry only, so nested overlays close one at a time and a global shortcut
 * handler can tell whether an overlay already owns the key.
 */
const overlayStack: OverlayEntry[] = [];

let scrollLockCount = 0;
let previousBodyOverflow = '';

function handleGlobalEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return;
  // The topmost layer owns the key even when it refuses to close, so Escape
  // never leaks through to whatever is underneath.
  event.preventDefault();
  top.onEscape?.();
}

function pushOverlay(entry: OverlayEntry): void {
  if (overlayStack.length === 0) {
    document.addEventListener('keydown', handleGlobalEscape);
  }
  overlayStack.push(entry);
}

function popOverlay(entry: OverlayEntry): void {
  const index = overlayStack.lastIndexOf(entry);
  if (index !== -1) overlayStack.splice(index, 1);
  if (overlayStack.length === 0) {
    document.removeEventListener('keydown', handleGlobalEscape);
  }
}

/** How many dismissable layers are currently mounted. */
export function getOpenOverlayCount(): number {
  return overlayStack.length;
}

function lockBodyScroll(): void {
  if (scrollLockCount === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount++;
}

function unlockBodyScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = previousBodyOverflow;
  }
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement || el.getClientRects().length > 0
  );
}

export interface UseDismissableOptions {
  isOpen: boolean;
  onDismiss: () => void;
  /** Escape closes the layer. Default true. When false the layer still swallows Escape. */
  closeOnEscape?: boolean;
  /** A click that both started and ended on the backdrop closes the layer. Default true. */
  closeOnOutsideClick?: boolean;
  /** Keep Tab inside the layer. Default true. */
  trapFocus?: boolean;
  /** Return focus to the element that was focused before opening. Default true. */
  restoreFocus?: boolean;
  /** Prevent the page behind from scrolling. Default true. */
  lockScroll?: boolean;
}

export interface DismissableBackdropProps {
  onMouseDown: (event: React.MouseEvent) => void;
  onClick: (event: React.MouseEvent) => void;
}

export interface UseDismissableResult<T extends HTMLElement> {
  /** Attach to the layer itself (the panel, not the backdrop). */
  containerRef: React.RefObject<T>;
  /** Spread onto the backdrop element. */
  backdropProps: DismissableBackdropProps;
}

/**
 * Escape-to-close, click-outside, focus trap, focus restore and body scroll lock
 * for any overlay layer — modals, drawers and the fullscreen player all share
 * this so their dismissal behaviour cannot drift apart.
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onDismiss,
  closeOnEscape = true,
  closeOnOutsideClick = true,
  trapFocus = true,
  restoreFocus = true,
  lockScroll = true
}: UseDismissableOptions): UseDismissableResult<T> {
  const containerRef = useRef<T>(null);
  const dismissRef = useRef(onDismiss);
  const pointerStartedInside = useRef(false);

  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!isOpen) return;

    const entry: OverlayEntry = {
      onEscape: closeOnEscape ? () => dismissRef.current() : null
    };
    pushOverlay(entry);

    return () => {
      popOverlay(entry);
    };
  }, [isOpen, closeOnEscape]);

  useEffect(() => {
    if (!isOpen || !lockScroll) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [isOpen, lockScroll]);

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = containerRef.current;

    if (trapFocus && container) {
      const first = getFocusable(container)[0];
      if (first) {
        first.focus();
      } else {
        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();
      }
    }

    return () => {
      if (restoreFocus && previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [isOpen, trapFocus, restoreFocus]);

  useEffect(() => {
    if (!isOpen || !trapFocus) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, trapFocus]);

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    // A drag that starts on the panel and ends on the backdrop must not dismiss.
    pointerStartedInside.current = event.target !== event.currentTarget;
  }, []);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      if (!closeOnOutsideClick) return;
      if (event.target !== event.currentTarget) return;
      if (pointerStartedInside.current) {
        pointerStartedInside.current = false;
        return;
      }
      dismissRef.current();
    },
    [closeOnOutsideClick]
  );

  return {
    containerRef,
    backdropProps: { onMouseDown, onClick }
  };
}
