import React, { useCallback, useState } from 'react';
import { Check, MoreVertical, Music2 } from 'lucide-react';
import type { UnifiedTrack } from '../../types/music';
import { ICON } from '../../styles/icons';
import { useLongPress } from '../../hooks/useLongPress';

/**
 * Строка трека на телефоне.
 *
 * Что здесь поменялось против настольной строки и почему.
 *
 * **Обложка 56 вместо 40.** В списке музыки узнают обложку, а не читают
 * название: глаз находит нужное по картинке за долю секунды, а по тексту —
 * перебором. Сорок пикселей для этого мало, обложка превращалась в цветное
 * пятно.
 *
 * **Одна кнопка вместо трёх.** В настольной строке справа стояли «сердце», «в
 * очередь» и «…». На 360 px эти три кнопки съедали 96 px, и названию
 * оставалось 156 — оно обрывалось на середине слова у половины треков. Обе
 * снятые кнопки никуда не делись: они первыми пунктами в листе действий,
 * который открывает «…».
 *
 * **Зона нажатия 48.** Сама иконка остаётся 20 px, но нажимаемая область —
 * 48×48, как просит Android. Было 32×32 без класса `tap-target` вовсе.
 */

export interface TrackRowProps {
  track: UnifiedTrack;
  /** Играет ли этот трек прямо сейчас — строка подсвечивается акцентом. */
  isCurrent?: boolean;
  onPlay: () => void;
  onOpenActions: () => void;
  /** Номер в списке вместо обложки — для очереди и плейлистов. */
  index?: number;
  /**
   * Список в режиме выбора: строка не играет, а отмечается.
   *
   * Отдельным признаком, а не «есть обработчик выбора»: в режиме выбора
   * меняется смысл нажатия на всю строку, и это должно быть видно из вызова.
   */
  isSelectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  'data-testid'?: string;
}

export const TrackRow: React.FC<TrackRowProps> = ({
  track,
  isCurrent = false,
  onPlay,
  onOpenActions,
  isSelectable = false,
  isSelected = false,
  onToggleSelect,
  'data-testid': testId
}) => {
  const [artworkFailed, setArtworkFailed] = useState(false);
  // В режиме выбора долгое нажатие не открывает лист: там у нажатия один смысл.
  const { handlers, consumedRef } = useLongPress({
    onLongPress: isSelectable ? () => undefined : onOpenActions
  });

  const handleClick = useCallback(() => {
    if (isSelectable) {
      onToggleSelect?.();
      return;
    }
    // Долгое нажатие уже открыло лист. Отпускание пальца не должно вдобавок
    // запустить трек — человек просил действия, а не музыку.
    if (consumedRef.current) {
      consumedRef.current = false;
      return;
    }
    onPlay();
  }, [consumedRef, isSelectable, onPlay, onToggleSelect]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        minHeight: '72px'
      }}
      data-testid={testId}
    >
      {/*
        * Нажимаемая часть — всё, кроме кнопки действий. Отдельным элементом, а
        * не обработчиком на строке: так у неё есть роль, фокус и клавиатура.
        */}
      <button
        type="button"
        className="press"
        onClick={handleClick}
        aria-pressed={isSelectable ? isSelected : undefined}
        {...handlers}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flex: 1,
          minWidth: 0,
          padding: 'var(--space-2) 0',
          textAlign: 'left',
          cursor: 'pointer'
        }}
        data-testid={testId ? `${testId}-play` : undefined}
      >
        <span
          style={{
            position: 'relative',
            width: '56px',
            height: '56px',
            flexShrink: 0,
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          {artworkFailed || !track.artworkUrl ? (
            <Music2 size={ICON.lg} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
          ) : (
            <img
              src={track.artworkUrl}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={() => setArtworkFailed(true)}
            />
          )}
        </span>

        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' }}>
          <span
            className="text-truncate"
            style={{
              fontSize: 'var(--text-base)',
              lineHeight: 'var(--leading-base)',
              letterSpacing: 'var(--tracking-base)',
              color: isCurrent ? 'var(--accent)' : 'var(--text-primary)'
            }}
            data-testid={testId ? `${testId}-title` : undefined}
          >
            {track.title}
          </span>
          <span
            className="text-truncate"
            style={{
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              letterSpacing: 'var(--tracking-sm)',
              color: 'var(--text-muted)'
            }}
          >
            {track.artist}
          </span>
        </span>
      </button>

      {isSelectable ? (
        /*
          * Отметка справа, на месте кнопки действий.
          *
          * Не отдельный `<input type="checkbox">`: вся строка уже кнопка и уже
          * несёт `aria-pressed`, а второй нажимаемый элемент с тем же смыслом
          * рядом — это два попадания пальцем вместо одного.
          */
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '48px',
            height: '48px',
            flexShrink: 0,
            color: isSelected ? 'var(--text-on-accent)' : 'var(--text-muted)'
          }}
        >
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '24px',
              height: '24px',
              borderRadius: 'var(--radius-full)',
              border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border-strong)'}`,
              background: isSelected ? 'var(--accent)' : 'transparent'
            }}
          >
            {isSelected && <Check size={ICON.sm} aria-hidden="true" />}
          </span>
        </span>
      ) : (
      <button
        type="button"
        className="press focus-ring"
        onClick={onOpenActions}
        aria-label={`Действия с «${track.title}»`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Зона 48×48 при иконке 20: попадать надо в кнопку, а не в значок.
          width: '48px',
          height: '48px',
          flexShrink: 0,
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-muted)',
          cursor: 'pointer'
        }}
        data-testid={testId ? `${testId}-actions` : undefined}
      >
        <MoreVertical size={ICON.lg} aria-hidden="true" />
      </button>
      )}
    </div>
  );
};
