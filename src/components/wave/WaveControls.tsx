import React from 'react';
import { Play, Pause, Heart, ThumbsDown, CopyPlus, SlidersHorizontal, Loader2, RefreshCw } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { recommendationEngine } from '../../services/recommendationEngine';
import { Button } from '../common/Button';
import { ICON } from '../../styles/icons';

export interface WaveControlsProps {
  onTuneToggle?: () => void;
  isTuneOpen?: boolean;
  className?: string;
}

export const WaveControls: React.FC<WaveControlsProps> = ({
  onTuneToggle,
  isTuneOpen = false,
  className = ''
}) => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const isReplenishingQueue = usePlayerStore((s) => s.isReplenishingQueue);
  const queueMode = usePlayerStore((s) => s.queueMode);

  const startMyWave = usePlayerStore((s) => s.startMyWave);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const dislikeAndSkipCurrentTrack = usePlayerStore((s) => s.dislikeAndSkipCurrentTrack);
  const replenishAutoplayQueue = usePlayerStore((s) => s.replenishAutoplayQueue);

  const isFavorite = useLibraryStore((s) => (currentTrack ? s.isFavorite(currentTrack.id) : false));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const showToast = useUIStore((s) => s.showToast);

  const isWaveActive = queueMode === 'my_wave';
  const isWavePlaying = isWaveActive && isPlaying;
  const isBusy = isLoading || isReplenishingQueue;
  // У главной кнопки занятость своя, более узкая.
  //
  // Поток добирает треки сам, в фоне, каждый раз когда в очереди остаётся два
  // (`commitTrack` → `replenishAutoplayQueue`). Под общим флагом кнопка посреди
  // спокойного воспроизведения подменяла «Остановить» на крутилку и
  // «Загрузка...»: музыка играет, а интерфейс сообщает, что чего-то ждёт. Но
  // совсем выбрасывать дозаполнение нельзя — холодный старт Потока как раз с него
  // и начинается, и секунды ожидания рекомендаций иначе остались бы без всякого
  // отклика. Отсюда условие: сбор очереди считается занятостью, только пока
  // музыка не играет.
  const isPrimaryBusy = isLoading || (isReplenishingQueue && !isWavePlaying);

  const handleToggleWave = async () => {
    if (isWaveActive && currentTrack) {
      await togglePlayPause();
    } else {
      // Без аргументов: настройки Потока живут в сторе, и повторять их здесь
      // значило бы рисковать разъездом между кнопкой и панелью настройки.
      await startMyWave();
    }
  };

  const handleRestart = async () => {
    try {
      await startMyWave();
      showToast('Поток пересобран по текущим настройкам', 'success');
    } catch {
      showToast('Не удалось пересобрать Поток', 'error');
    }
  };

  const handleLike = async () => {
    if (!currentTrack) return;
    const wasFav = isFavorite;
    const ok = await toggleFavorite(currentTrack);
    // `toggleFavorite` не бросает — про отказ он сообщает через `false`. Без этой
    // ветки неудачная запись в базу выглядела как мёртвая кнопка: сердце не
    // закрашивается, тоста нет, и человек жмёт снова.
    if (!ok) {
      if (refusedForAccount()) return;
      showToast(useLibraryStore.getState().error || 'Не удалось обновить избранное', 'error');
      return;
    }
    if (!wasFav) {
      void recommendationEngine.recordFeedback(currentTrack, 'like');
      showToast(`Добавлено в любимое: "${currentTrack.title}"`, 'success');
    } else {
      showToast(`Удалено из любимого: "${currentTrack.title}"`, 'info');
    }
  };

  const handleMoreLikeThis = async () => {
    if (!currentTrack) return;
    try {
      await recommendationEngine.recordFeedback(currentTrack, 'more_like_this');
      void replenishAutoplayQueue();
      showToast('Больше похожих треков в Потоке', 'success');
    } catch {
      showToast('Не удалось обновить предпочтения', 'error');
    }
  };

  const handleDislike = async () => {
    if (!currentTrack) return;
    const trackTitle = currentTrack.title;
    try {
      await dislikeAndSkipCurrentTrack();
      showToast(`"${trackTitle}" больше не будет рекомендоваться`, 'info');
    } catch {
      showToast('Ошибка при пропуске трека', 'error');
    }
  };

  /** Одинаковый вид у всех второстепенных кнопок ряда. */
  const secondaryStyle = { color: 'var(--text-secondary)' } as const;

  return (
    <div
      className={`wave-controls-container ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--surface-2)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-md)'
        // backdrop-filter убран: `--surface-2` непрозрачен, размывать под ним
        // нечего, а слой и блюр на кадр браузер считал честно.
      }}
      data-testid="wave-controls"
    >
      {/*
        Два ряда, а не один.

        Раньше шесть кнопок с подписями стояли в строку: их суммарная ширина
        (~700 px) не влезала в столбец экрана, и крайние — «Не нравится» и
        «Настроить» — оказывались нарисованы за краем подложки. Теперь главное
        действие занимает свой ряд, оценки и настройка живут под ним и при
        нехватке ширины переносятся, а не выходят за границу.
      */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <Button
          variant="primary"
          size="lg"
          onClick={handleToggleWave}
          disabled={isPrimaryBusy && !currentTrack}
          icon={
            isPrimaryBusy ? (
              <Loader2 size={ICON.lg} className="animate-spin" />
            ) : isWavePlaying ? (
              <Pause size={ICON.lg} />
            ) : (
              <Play size={ICON.lg} style={{ marginLeft: '2px' }} />
            )
          }
          style={{
            minWidth: '220px',
            padding: 'var(--space-3) var(--space-6)',
            borderRadius: 'var(--radius-full)',
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-base)',
            // Тень нейтральная, а не сиреневая.
            //
            // Цветная тень под кнопкой рисует под ней второй, размытый силуэт
            // акцента: на подложке Потока это читается как свечение самой кнопки,
            // и она начинает конкурировать за внимание с шаром выше. Токен даёт
            // ту же приподнятость без второго цветного пятна.
            boxShadow: 'var(--shadow-md)'
          }}
          data-testid="wave-btn-toggle-play"
        >
          <span>
            {isPrimaryBusy
              ? 'Загрузка...'
              : isWavePlaying
              ? 'Остановить'
              : isWaveActive && currentTrack
              ? 'Продолжить'
              : 'Запустить Поток'}
          </span>
        </Button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-1)'
        }}
      >
        {/* Dislike / Не рекомендовать */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDislike}
          disabled={!currentTrack}
          icon={<ThumbsDown size={ICON.md} />}
          title="Не рекомендовать (пропустить и больше не ставить)"
          aria-label="Не рекомендовать"
          className="press"
          style={secondaryStyle}
          data-testid="wave-btn-dislike"
        >
          <span className="hide-on-mobile">Не нравится</span>
        </Button>

        {/* Like / Нравится */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLike}
          disabled={!currentTrack}
          icon={
            <Heart
              size={ICON.md}
              fill={isFavorite ? 'currentColor' : 'none'}
              style={{ color: isFavorite ? 'var(--danger)' : 'inherit' }}
            />
          }
          title={isFavorite ? 'Удалить из любимых' : 'Нравится'}
          aria-label="Нравится"
          className="press"
          style={{ color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)' }}
          data-testid="wave-btn-like"
        >
          <span className="hide-on-mobile">Нравится</span>
        </Button>

        {/*
          * Больше такого. Значок — «ещё такого же», а не звёздочки: рядом стоят
          * «Нравится» и «Не то», и три значка подряд должны отличаться смыслом,
          * а не настроением.
          */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleMoreLikeThis}
          disabled={!currentTrack}
          icon={<CopyPlus size={ICON.md} />}
          title="Больше похожего (увеличить вес исполнителя и стиля)"
          aria-label="Больше такого"
          className="press"
          style={secondaryStyle}
          data-testid="wave-btn-more"
        >
          <span className="hide-on-mobile">Больше такого</span>
        </Button>

        {/* Пересобрать Поток по текущим настройкам */}
        {isWaveActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRestart}
            disabled={isBusy}
            icon={<RefreshCw size={ICON.md} />}
            title="Пересобрать Поток по текущим настройкам"
            aria-label="Пересобрать Поток"
            className="press"
            style={secondaryStyle}
            data-testid="wave-btn-restart"
          >
            <span className="hide-on-mobile">Пересобрать</span>
          </Button>
        )}

        {/* Tune settings toggle */}
        {onTuneToggle && (
          <Button
            variant="ghost"
            size="sm"
            isActive={isTuneOpen}
            onClick={onTuneToggle}
            icon={<SlidersHorizontal size={ICON.md} />}
            title="Настройки Потока"
            aria-label="Настройки Потока"
            className="press"
            style={isTuneOpen ? undefined : secondaryStyle}
            data-testid="wave-btn-tune"
          >
            <span className="hide-on-mobile">Настроить</span>
          </Button>
        )}
      </div>
    </div>
  );
};
