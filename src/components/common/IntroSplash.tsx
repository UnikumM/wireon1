import React, { useCallback, useEffect, useState } from 'react';

/**
 * Вступительная заставка при запуске: ролик со знаком Wireon (`public/intro.mp4`, 3 с).
 *
 * Приложение под ней грузится как обычно — заставка ничего не задерживает, а
 * только накрывает первые секунды. Убирается сама в конце ролика, по нажатию
 * или клавише. Не показывается, если система просит меньше движения, и не
 * держит экран, если ролик не пошёл (нет декодера, файл не нашёлся): тогда
 * уходит по ошибке или по сторожу.
 *
 * Мини-окно её не видит: оно рендерится отдельной веткой в `main.tsx`.
 */

/** Ролик длится 3 с; дольше этого заставка экран не держит ни при каких условиях. */
export const INTRO_MAX_MS = 6000;
/** Совпадает с `transition` у `.intro-splash` в global.css. */
export const INTRO_FADE_MS = 450;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function IntroSplash(): React.ReactElement | null {
  const [phase, setPhase] = useState<'playing' | 'leaving' | 'gone'>(() =>
    prefersReducedMotion() ? 'gone' : 'playing'
  );

  const finish = useCallback(() => {
    setPhase((current) => (current === 'playing' ? 'leaving' : current));
  }, []);

  useEffect(() => {
    if (phase === 'playing') {
      const guard = setTimeout(finish, INTRO_MAX_MS);
      window.addEventListener('keydown', finish);
      return () => {
        clearTimeout(guard);
        window.removeEventListener('keydown', finish);
      };
    }
    if (phase === 'leaving') {
      const done = setTimeout(() => setPhase('gone'), INTRO_FADE_MS);
      return () => clearTimeout(done);
    }
    return undefined;
  }, [phase, finish]);

  if (phase === 'gone') return null;

  return (
    <div
      className={`intro-splash${phase === 'leaving' ? ' is-leaving' : ''}`}
      onClick={finish}
      aria-hidden="true"
      data-testid="intro-splash"
    >
      <video
        src={`${import.meta.env.BASE_URL}intro.mp4`}
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
      />
    </div>
  );
}
