import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/**
 * Subscribes to a media query. Uses `addEventListener('change')`, not the
 * long-deprecated `addListener`.
 */
export function useMediaQuery(query: string): boolean {
  const [isMatch, setIsMatch] = useState<boolean>(() => matches(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    const list = window.matchMedia(query);
    setIsMatch(list.matches);

    const onChange = (event: MediaQueryListEvent) => setIsMatch(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return isMatch;
}

/** True when the user asked the OS to reduce motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
