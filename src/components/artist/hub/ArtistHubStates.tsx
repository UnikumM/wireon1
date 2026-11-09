import React from 'react';
import { Info, RefreshCw } from 'lucide-react';
import { ArtistProfile } from '../../../services/artistService';
import { Button } from '../../common/Button';
import { Skeleton } from '../../common/Skeleton';
import { EmptyState } from '../../common/EmptyState';
import { ICON } from '../../../styles/icons';

interface ArtistHubLoadingProps {
  className: string;
}

/** Скелет страницы: кнопка «Назад», шапка и пять строк треков. */
export const ArtistHubLoading: React.FC<ArtistHubLoadingProps> = ({ className }) => (
  <div
    className={`scrollbar-thin ${className} flex-1 h-full stack gap-6 p-6`}
    style={{ overflowY: 'auto' }}
    data-testid="artist-hub-loading"
  >
    <div style={{
          display: 'flex',
          alignItems: 'center',
          // Три подписанные кнопки в строку не влезают уже на 375 px, а
          // область содержимого режет по горизонтали — «В офлайн» просто
          // переставала существовать. На широком окне перенос ничего не
          // меняет: там они и так помещаются.
          flexWrap: 'wrap',
          gap: 'var(--space-3)'
        }}>
      <Skeleton width="100px" height="36px" radius="var(--radius-sm)" />
    </div>
    <Skeleton width="100%" height="280px" radius="var(--radius-lg)" />
    <div className="stack gap-3">
      <Skeleton width="200px" height="28px" radius="var(--radius-xs)" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} width="100%" height="56px" radius="var(--radius-sm)" />
      ))}
    </div>
  </div>
);

interface ArtistHubErrorProps {
  className: string;
  artistName: string;
  error: string | null;
  profile: ArtistProfile | null;
  onRetry: () => void;
}

/**
 * Ошибка загрузки или пустой профиль.
 *
 * `isSparse` означает, что все источники вернули пустоту — есть имя и ничего
 * больше. Кнопка повтора полезнее страницы из пустых секций.
 */
export const ArtistHubError: React.FC<ArtistHubErrorProps> = ({
  className,
  artistName,
  error,
  profile,
  onRetry
}) => {
  const description = error
    ? error
    : profile?.isSparse
      ? `Про «${artistName}» ничего не нашлось. Возможно, имя написано иначе — или сервис сейчас недоступен.`
      : `Метаданные для «${artistName}» получить не получилось.`;

  return (
    <div
      className={`scrollbar-thin ${className} flex-1 h-full stack-center justify-center gap-4 p-6`}
      style={{ overflowY: 'auto' }}
      data-testid="artist-hub-error"
    >
      <EmptyState
        icon={<Info size={ICON.display} />}
        title={profile?.isSparse && !error ? 'Исполнитель не найден' : 'Не удалось открыть профиль'}
        description={description}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={ICON.sm} />}
            onClick={onRetry}
            data-testid="artist-hub-retry-btn"
          >
            Повторить
          </Button>
        }
      />
    </div>
  );
};
