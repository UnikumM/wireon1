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
/** Прозрачный GIF 1×1: постер, который WebView нечем заменить на свою заглушку. */
const TRANSPARENT_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

  const [started, setStarted] = useState(false);

  if (phase === 'gone') return null;

  return (
    <div
      className={`intro-splash${phase === 'leaving' ? ' is-leaving' : ''}`}
      onClick={finish}
      aria-hidden="true"
      data-testid="intro-splash"
    >
      {/*
        * До первого кадра Android WebView рисует на месте `<video>` без постера
        * свою заглушку — серый круг с треугольником «play». На телефоне она
        * мелькала перед роликом. Поэтому постер прозрачный, а сам ролик скрыт,
        * пока не пошёл: до этого виден только ровный фон.
        */}
      <video
        src={`${import.meta.env.BASE_URL}intro.mp4`}
        poster={TRANSPARENT_POSTER}
        autoPlay
        muted
        playsInline
        preload="auto"
        className={started ? 'is-started' : undefined}
        onPlaying={() => setStarted(true)}
        onEnded={finish}
        onError={finish}
      />
    </div>
  );
}
