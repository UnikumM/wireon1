import React, { useEffect } from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { Button } from './Button';
import { useUpdateStore } from '../../store/useUpdateStore';
import { ICON } from '../../styles/icons';

/**
 * Плашка обновления: сначала «качаем», потом «перезапустите».
 *
 * Раньше загрузка шла совсем молча, и обновление выглядело так, будто ничего не
 * происходит: человек видел одну строку в самом конце и не понимал, откуда она
 * взялась и почему пакет уже на диске. Поэтому этапов теперь два. Пока качается —
 * тонкая строка с процентом и без кнопок действия: делать всё равно нечего, а
 * знать полезно. Когда скачалось — та же плашка становится акцентной и просит
 * перезапустить.
 *
 * `checking` намеренно молчит: это фоновая проверка раз в шесть часов, и
 * сообщать в ней не о чем. «Позже» на этапе загрузки не глушит финальное
 * «перезапустите» — за это отвечает `apply()` в сторе.
 *
 * Здесь же живёт подписка на состояние обновлений: оболочка приложения
 * монтируется один раз, а значит и подписка ровно одна.
 */
export const UpdateBanner: React.FC = () => {
  const status = useUpdateStore((s) => s.status);
  const newVersion = useUpdateStore((s) => s.newVersion);
  const percent = useUpdateStore((s) => s.percent);
  const dismissed = useUpdateStore((s) => s.dismissed);
  const init = useUpdateStore((s) => s.init);
  const install = useUpdateStore((s) => s.install);
  const dismiss = useUpdateStore((s) => s.dismiss);

  useEffect(() => init(), [init]);

  const isReady = status === 'ready';
  const isFetching = status === 'available' || status === 'downloading';

  if ((!isReady && !isFetching) || dismissed) return null;

  const version = newVersion ? `Wireon Sounds ${newVersion}` : 'Обновление';
  // На `available` загрузка ещё не рапортовала ни одного процента, и «качаем 0%»
  // читается как «застряло».
  const shown = Math.max(0, Math.min(100, Math.round(percent)));
  const progressLabel = status === 'downloading' && shown > 0 ? `качаем, ${shown}%` : 'начинаем загрузку';

  return (
    <div
      role="status"
      // Плашка приходит сама, посреди работы, и до этого просто возникала в
      // раскладке готовой строкой — читалось как подмена кадра. Выпадение
      // сверху здесь буквально по месту: она и стоит под самым верхним краем
      // окна, поэтому точка роста по умолчанию (`top center`) верна.
      className="animate-drop-in"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-2) var(--space-6)',
        backgroundColor: isReady ? 'var(--accent-soft)' : 'var(--surface-2)',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: 'var(--text-sm)',
        lineHeight: 'var(--leading-sm)',
        color: isReady ? 'var(--text-primary)' : 'var(--text-secondary)'
      }}
      data-testid="update-banner"
      data-phase={isReady ? 'ready' : 'downloading'}
    >
      <ArrowDownToLine
        size={ICON.md}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          color: isReady ? 'var(--accent)' : 'var(--text-muted)'
        }}
      />

      <span style={{ flex: 1, minWidth: 0 }}>
        {isReady ? (
          <>
            {newVersion ? `${version} уже скачан` : 'Обновление уже скачано'} — перезапустите приложение,
            чтобы обновиться.
          </>
        ) : (
          <>
            {newVersion ? `Вышла версия ${newVersion}` : 'Вышло обновление'} — {progressLabel}. Можно
            продолжать слушать.
          </>
        )}
      </span>

      {isReady && (
        <Button variant="primary" size="sm" onClick={() => void install()} data-testid="update-restart">
          Перезапустить
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={dismiss} data-testid="update-dismiss">
        {isReady ? 'Позже' : 'Скрыть'}
      </Button>

      {isFetching && (
        // Полоса прижата к нижней границе плашки, чтобы не занимать высоту:
        // строка обновления не должна дёргать раскладку под собой.
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          aria-label="Загрузка обновления"
          data-testid="update-banner-progress"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: -1,
            height: '2px',
            backgroundColor: 'transparent',
            overflow: 'hidden'
          }}
        >
          <span
            style={{
              display: 'block',
              height: '100%',
              width: `${shown}%`,
              backgroundColor: 'var(--accent)',
              transition: 'width var(--dur-slow) var(--ease-out)'
            }}
          />
        </span>
      )}
    </div>
  );
};

export default UpdateBanner;
