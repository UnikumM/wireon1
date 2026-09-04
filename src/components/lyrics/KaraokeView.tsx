import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Music2,
  RefreshCw,
  X,
  ArrowDownCircle,
  Search,
  AlertTriangle,
  Check,
  Minus,
  Plus,
  RotateCcw
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { useDismissable, useDominantColor } from '../../hooks';
import { useMobileShell } from '../../hooks/useMobileShell';
import {
  fetchLyrics,
  findLyricsCandidates,
  setManualLyrics,
  clearManualLyrics,
  getLyricsOffset,
  setLyricsOffset,
  LyricsResult,
  LyricsLine,
  LyricsCandidate
} from '../../services/lyricsService';
import { getActiveLineIndex } from '../../services/lrcParser';
import { Button } from '../common/Button';
import { Skeleton } from '../common/Skeleton';
import { EmptyState } from '../common/EmptyState';
import { ICON } from '../../styles/icons';

export interface KaraokeViewProps {
  className?: string;
  onClose?: () => void;
}

/** Шаг подстройки тайминга. Полсекунды слышно, меньше — уже нет. */
const OFFSET_STEP_S = 0.5;

/**
 * Текст песни с подсветкой строки по времени.
 *
 * Кроме собственно показа текста здесь решаются две вещи, из-за которых тексты
 * выглядели «криво»: во-первых, видно, насколько уверенно текст сопоставлен с
 * песней, и можно выбрать другой вариант руками; во-вторых, если запись
 * смикширована иначе и строки уезжают, сдвиг подстраивается и запоминается.
 */
export const KaraokeView: React.FC<KaraokeViewProps> = ({ className = '', onClose }) => {
  const isLyricsOpen = useUIStore((s) => s.isLyricsOpen);
  const setLyricsOpen = useUIStore((s) => s.setLyricsOpen);
  const showToast = useUIStore((s) => s.showToast);

  /*
   * Телефон здесь — не «узкий ПК».
   *
   * Экран текста прибит к окну целиком (`fixed; inset: 0`), и на 360 px
   * настольная шапка складывалась в кашу: обложка, название, значок «без
   * синхронизации», кнопка «Другой текст», перезагрузка и крестик — всё это в
   * один ряд, поверх часов и значка сети, потому что про безопасную зону сверху
   * шапка не знала вовсе. Ниже она собирается в два ряда, с отступом под
   * системную строку, а второстепенные действия остаются одними значками.
   */
  const isMobile = useMobileShell();

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seekTo = usePlayerStore((s) => s.seekTo);

  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUserScrolled, setIsUserScrolled] = useState<boolean>(false);

  const [offsetSeconds, setOffsetSeconds] = useState<number>(0);
  const [isPickerOpen, setIsPickerOpen] = useState<boolean>(false);
  const [pickerQuery, setPickerQuery] = useState<string>('');
  const [candidates, setCandidates] = useState<LyricsCandidate[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [hasSearched, setHasSearched] = useState<boolean>(false);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  const ambientColor = useDominantColor(currentTrack?.artworkUrl);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      setLyricsOpen(false);
    }
  }, [onClose, setLyricsOpen]);

  const { containerRef } = useDismissable<HTMLDivElement>({
    isOpen: isLyricsOpen,
    onDismiss: handleClose,
    closeOnOutsideClick: false
  });

  const loadLyrics = useCallback(async () => {
    if (!currentTrack) {
      setLyrics(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setIsUserScrolled(false);

    try {
      const result = await fetchLyrics(currentTrack);
      setLyrics(result);
    } catch (err) {
      console.error('[KaraokeView] Не удалось загрузить текст:', err);
      setLyrics(null);
    } finally {
      setIsLoading(false);
    }

    // Сдвиг читается отдельно: если его не удалось достать, текст всё равно
    // нужно показать — без подстройки, но показать.
    try {
      setOffsetSeconds(await getLyricsOffset(currentTrack.id));
    } catch {
      setOffsetSeconds(0);
    }
  }, [currentTrack]);

  useEffect(() => {
    if (isLyricsOpen && currentTrack) {
      void loadLyrics();
    }
  }, [isLyricsOpen, currentTrack?.id, loadLyrics]);

  // Смена трека закрывает подбор: варианты относились к прошлой песне.
  useEffect(() => {
    setIsPickerOpen(false);
    setCandidates([]);
    setHasSearched(false);
    setPickerQuery('');
  }, [currentTrack?.id]);

  /**
   * Подсветка считается по сдвинутому времени.
   *
   * Сдвиг не вписывается в сами строки: так его можно вернуть в ноль, не
   * перезагружая текст, и не потерять исходные тайминги.
   */
  const effectiveTime = currentTime - offsetSeconds;
  const activeLineIndex =
    lyrics && lyrics.synced && lyrics.lines.length > 0
      ? getActiveLineIndex(lyrics.lines, effectiveTime)
      : -1;

  /**
   * Прокрутка внутри контейнера, а не через `scrollIntoView`.
   *
   * Оверлей растянут на весь экран, и `scrollIntoView` умеет заодно двигать
   * родителей — тогда уезжает всё окно, а не список строк.
   */
  const scrollToActiveLine = useCallback((index: number, smooth = true) => {
    const container = scrollContainerRef.current;
    const activeEl = lineRefs.current[index];
    if (index < 0 || !container || !activeEl) return;

    const target = activeEl.offsetTop - container.clientHeight / 2 + activeEl.clientHeight / 2;
    try {
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' });
      } else if (typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
      }
    } catch {
      container.scrollTop = Math.max(0, target);
    }
  }, []);

  useEffect(() => {
    if (!isUserScrolled && activeLineIndex >= 0) {
      scrollToActiveLine(activeLineIndex, true);
    }
  }, [activeLineIndex, isUserScrolled, scrollToActiveLine]);

  const handleScroll = () => {
    if (!scrollContainerRef.current || activeLineIndex < 0) return;

    const container = scrollContainerRef.current;
    const activeEl = lineRefs.current[activeLineIndex];
    if (!activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();

    const containerCenter = containerRect.top + containerRect.height / 2;
    const activeCenter = activeRect.top + activeRect.height / 2;

    // Уехали от центра больше чем на 180 px — значит, листает человек.
    if (Math.abs(containerCenter - activeCenter) > 180) {
      setIsUserScrolled(true);
    }
  };

  const handleResumeAutoScroll = () => {
    setIsUserScrolled(false);
    if (activeLineIndex >= 0) {
      scrollToActiveLine(activeLineIndex, true);
    }
  };

  const handleLineClick = (line: LyricsLine) => {
    if (line && typeof line.time === 'number') {
      // Сдвиг применяется и здесь, иначе клик уводил бы мимо строки.
      seekTo(Math.max(0, line.time + offsetSeconds));
      setIsUserScrolled(false);
    }
  };

  const applyOffset = useCallback(
    (next: number) => {
      const clamped = Math.max(-30, Math.min(30, Math.round(next * 10) / 10));
      setOffsetSeconds(clamped);
      void setLyricsOffset(currentTrack?.id, clamped);
    },
    [currentTrack?.id]
  );

  const runCandidateSearch = useCallback(
    async (queryText?: string) => {
      if (!currentTrack) return;
      setIsSearching(true);
      setHasSearched(true);
      try {
        setCandidates(await findLyricsCandidates(currentTrack, queryText));
      } catch {
        setCandidates([]);
      } finally {
        setIsSearching(false);
      }
    },
    [currentTrack]
  );

  const openPicker = useCallback(() => {
    setIsPickerOpen(true);
    if (!hasSearched) void runCandidateSearch();
  }, [hasSearched, runCandidateSearch]);

  const chooseCandidate = useCallback(
    async (candidate: LyricsCandidate) => {
      if (!currentTrack) return;
      await setManualLyrics(currentTrack, candidate.result);
      setLyrics({ ...candidate.result, manual: true });
      setIsPickerOpen(false);
      setIsUserScrolled(false);
      showToast('Текст выбран и запомнен для этого трека', 'success');
    },
    [currentTrack, showToast]
  );

  const resetToAutomatic = useCallback(async () => {
    if (!currentTrack) return;
    await clearManualLyrics(currentTrack);
    setIsPickerOpen(false);
    await loadLyrics();
    showToast('Вернулись к автоматическому подбору', 'info');
  }, [currentTrack, loadLyrics, showToast]);

  if (!isLyricsOpen) return null;

  const hasLines = Boolean(lyrics && !lyrics.instrumental && lyrics.lines.length > 0);
  const isDoubtful = hasLines && lyrics?.confidence === 'low' && !lyrics?.manual;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="Текст песни"
      className={`animate-fade-in ${className}`}
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 'var(--z-overlay)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          backgroundColor: 'var(--bg-base)',
          '--ring-offset-color': 'var(--bg-base)'
        } as React.CSSProperties
      }
      data-testid="karaoke-view"
    >
      {/* Подложка в цвет обложки */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: 0.18,
          backgroundImage: `radial-gradient(130% 80% at 50% 0%, ${ambientColor} 0%, transparent 68%)`
        }}
      />

      <header
        style={{
          position: 'relative',
          display: 'flex',
          // На телефоне ряд один не помещается: шесть органов управления рядом с
          // названием на 360 px налезают друг на друга.
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          justifyContent: 'space-between',
          gap: isMobile ? 'var(--space-2)' : 'var(--space-4)',
          // Отступ сверху — под часы и значок сети. Без него шапка уезжала прямо
          // под системную строку: экран прибит к окну, а не к области контента.
          padding: isMobile
            ? 'calc(var(--safe-top) + var(--space-3)) var(--space-4) var(--space-3)'
            : 'var(--space-4) var(--space-6)',
          borderBottom: '1px solid var(--border-subtle)',
          backgroundColor: 'var(--surface-1)',
          zIndex: 2
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
          <div
            style={{
              width: '44px',
              height: '44px',
              flexShrink: 0,
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              border: '1px solid var(--border-subtle)',
              backgroundColor: 'var(--surface-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {currentTrack?.artworkUrl ? (
              <img
                src={currentTrack.artworkUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <Music2 size={ICON.lg} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
            )}
          </div>

          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div
              className="text-truncate"
              style={{
                fontSize: 'var(--text-base)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
              title={currentTrack?.title || 'Ничего не играет'}
              data-testid="karaoke-track-title"
            >
              {currentTrack?.title || 'Ничего не играет'}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                // Значки уводятся на свою строку, а не наезжают на имя
                // исполнителя: на 360 px «Без синхронизации» шире, чем всё
                // оставшееся место.
                flexWrap: isMobile ? 'wrap' : 'nowrap',
                gap: 'var(--space-2)'
              }}
            >
              <span
                className="text-truncate"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
                data-testid="karaoke-track-artist"
              >
                {currentTrack?.artist || 'Исполнитель неизвестен'}
              </span>

              {lyrics?.synced ? (
                <span
                  className="badge"
                  style={{
                    color: 'var(--accent)',
                    backgroundColor: 'var(--accent-soft)',
                    borderColor: 'var(--border-accent)'
                  }}
                  data-testid="karaoke-synced-badge"
                >
                  <Mic size={ICON.xs} aria-hidden="true" />
                  По времени
                </span>
              ) : hasLines ? (
                <span
                  className="badge"
                  style={{
                    color: 'var(--text-muted)',
                    backgroundColor: 'var(--surface-sunken)',
                    borderColor: 'var(--border-subtle)'
                  }}
                  data-testid="karaoke-plain-badge"
                >
                  Без синхронизации
                </span>
              ) : null}

              {lyrics?.manual && (
                <span
                  className="badge"
                  style={{
                    color: 'var(--text-secondary)',
                    backgroundColor: 'var(--surface-sunken)',
                    borderColor: 'var(--border-subtle)'
                  }}
                  data-testid="karaoke-manual-badge"
                >
                  <Check size={ICON.xs} aria-hidden="true" />
                  Выбран вручную
                </span>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            // На телефоне ряд действий уходит под название и прижимается вправо,
            // чтобы до него доставал большой палец.
            justifyContent: isMobile ? 'flex-end' : undefined,
            flexWrap: isMobile ? 'wrap' : 'nowrap',
            gap: 'var(--space-2)'
          }}
        >
          {/* Подстройка тайминга — только когда её есть к чему применить */}
          {lyrics?.synced && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                padding: '2px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)'
              }}
              data-testid="karaoke-offset-controls"
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => applyOffset(offsetSeconds - OFFSET_STEP_S)}
                title="Текст показывать раньше"
                aria-label="Сдвинуть текст раньше на полсекунды"
                style={{ width: '30px', height: '30px' }}
                data-testid="karaoke-offset-earlier"
              >
                <Minus size={ICON.sm} />
              </Button>
              <span
                data-numeric
                data-testid="karaoke-offset-value"
                title="Сдвиг текста относительно звука"
                style={{
                  minWidth: '54px',
                  textAlign: 'center',
                  fontSize: 'var(--text-xs)',
                  color: offsetSeconds === 0 ? 'var(--text-muted)' : 'var(--accent)'
                }}
              >
                {offsetSeconds > 0 ? '+' : ''}
                {offsetSeconds.toFixed(1)} с
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => applyOffset(offsetSeconds + OFFSET_STEP_S)}
                title="Текст показывать позже"
                aria-label="Сдвинуть текст позже на полсекунды"
                style={{ width: '30px', height: '30px' }}
                data-testid="karaoke-offset-later"
              >
                <Plus size={ICON.sm} />
              </Button>
              {offsetSeconds !== 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => applyOffset(0)}
                  title="Сбросить сдвиг"
                  aria-label="Сбросить сдвиг текста"
                  style={{ width: '30px', height: '30px' }}
                  data-testid="karaoke-offset-reset"
                >
                  <RotateCcw size={ICON.xs} />
                </Button>
              )}
            </div>
          )}

          {/*
            * На телефоне — один значок. Со словами кнопка занимает треть
            * ширины экрана и выталкивает крестик за край.
            */}
          <Button
            variant="ghost"
            size={isMobile ? 'icon' : 'sm'}
            icon={isMobile ? undefined : <Search size={ICON.md} />}
            onClick={openPicker}
            title="Найти другой текст"
            aria-label={isMobile ? 'Найти другой текст' : undefined}
            style={isMobile ? { width: '40px', height: '40px' } : undefined}
            data-testid="karaoke-pick-other-btn"
          >
            {isMobile ? <Search size={ICON.md} /> : 'Другой текст'}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => void loadLyrics()}
            title="Загрузить заново"
            aria-label="Загрузить текст заново"
            style={{ width: isMobile ? '40px' : '36px', height: isMobile ? '40px' : '36px' }}
            data-testid="karaoke-reload-btn"
          >
            <RefreshCw size={ICON.md} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            onClick={handleClose}
            title="Закрыть (Esc)"
            aria-label="Закрыть текст песни"
            style={{ width: isMobile ? '40px' : '36px', height: isMobile ? '40px' : '36px' }}
            data-testid="karaoke-close-btn"
          >
            <X size={ICON.lg} />
          </Button>
        </div>
      </header>

      {/* Честное предупреждение вместо тихой подмены текста */}
      {isDoubtful && (
        <div
          role="status"
          data-testid="karaoke-low-confidence"
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-6)',
            backgroundColor: 'var(--warning-soft)',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-xs)',
            color: 'var(--text-secondary)'
          }}
        >
          <AlertTriangle size={ICON.sm} aria-hidden="true" style={{ color: 'var(--warning)', flexShrink: 0 }} />
          <span>
            Текст подобран приблизительно
            {lyrics?.trackName ? ` — «${lyrics.trackName}»` : ''}
            {lyrics?.artistName ? `, ${lyrics.artistName}` : ''}. Если это не та песня, выберите другой вариант.
          </span>
          <Button variant="ghost" size="xs" onClick={openPicker} data-testid="karaoke-low-confidence-fix">
            Выбрать
          </Button>
        </div>
      )}

      {/* Подбор текста вручную */}
      {isPickerOpen && (
        <section
          aria-label="Выбор текста песни"
          data-testid="karaoke-picker"
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            padding: 'var(--space-4) var(--space-6)',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--surface-1)',
            maxHeight: '46vh',
            overflowY: 'auto'
          }}
          className="scrollbar-thin"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runCandidateSearch(pickerQuery);
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <input
              type="search"
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Исполнитель и название — если автопоиск промахнулся"
              aria-label="Запрос для поиска текста"
              data-testid="karaoke-picker-input"
              style={{ flex: 1, minWidth: 0 }}
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              isLoading={isSearching}
              data-testid="karaoke-picker-search-btn"
            >
              Искать
            </Button>
            {lyrics?.manual && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void resetToAutomatic()}
                data-testid="karaoke-picker-reset-btn"
              >
                Вернуть автоподбор
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsPickerOpen(false)}
              title="Закрыть выбор"
              aria-label="Закрыть выбор текста"
              style={{ width: '32px', height: '32px' }}
              data-testid="karaoke-picker-close"
            >
              <X size={ICON.md} />
            </Button>
          </form>

          {isSearching && <Skeleton count={3} height={44} radius="var(--radius-sm)" />}

          {!isSearching && candidates.length === 0 && hasSearched && (
            <p
              style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}
              data-testid="karaoke-picker-empty"
            >
              Ничего не нашлось. Попробуйте написать название иначе — например, латиницей.
            </p>
          )}

          {!isSearching &&
            candidates.map((candidate, index) => (
              <button
                key={`${candidate.result.id}-${index}`}
                type="button"
                onClick={() => void chooseCandidate(candidate)}
                data-testid={`karaoke-candidate-${index}`}
                className="press-surface focus-ring"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-3)',
                  width: '100%',
                  textAlign: 'left',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-sm)',
                  // Фон и рамка — в `.press-surface`: инлайновый `--surface-2`
                  // был старше `.press:hover`, и список вариантов текста никак
                  // не показывал, на какой строке курсор.
                  cursor: 'pointer',
                  color: 'var(--text-primary)'
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    className="text-truncate"
                    style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)' }}
                  >
                    {candidate.result.trackName || 'Без названия'}
                    {candidate.result.artistName ? ` — ${candidate.result.artistName}` : ''}
                  </span>
                  <span
                    style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
                  >
                    {candidate.result.synced ? 'по времени' : 'обычный текст'}
                    {candidate.notes.length > 0 ? ` · ${candidate.notes.join(', ')}` : ''}
                  </span>
                </span>
                <span
                  className="badge"
                  data-testid={`karaoke-candidate-confidence-${index}`}
                  style={{
                    flexShrink: 0,
                    color: candidate.confidence === 'high' ? 'var(--accent)' : 'var(--text-muted)',
                    backgroundColor:
                      candidate.confidence === 'high' ? 'var(--accent-soft)' : 'var(--surface-sunken)',
                    borderColor:
                      candidate.confidence === 'high' ? 'var(--border-accent)' : 'var(--border-subtle)'
                  }}
                >
                  {candidate.confidence === 'high'
                    ? 'похоже'
                    : candidate.confidence === 'medium'
                      ? 'возможно'
                      : 'вряд ли'}
                </span>
              </button>
            ))}
        </section>
      )}

      {/* Сам текст */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="scrollbar-thin"
        style={{
          position: 'relative',
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: isMobile
            ? 'var(--space-4) var(--space-2) calc(var(--safe-bottom) + var(--space-6))'
            : 'var(--space-8) var(--space-6) var(--space-8)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          userSelect: 'none'
        }}
        data-testid="karaoke-scroll-container"
      >
        {isLoading && (
          <div
            style={{
              width: '100%',
              maxWidth: '680px',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
              padding: 'var(--space-6) 0'
            }}
            data-testid="karaoke-loading"
          >
            <Skeleton style={{ height: '36px', width: '70%', borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ height: '36px', width: '90%', borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ height: '36px', width: '60%', borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ height: '36px', width: '80%', borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ height: '36px', width: '75%', borderRadius: 'var(--radius-sm)' }} />
            <Skeleton style={{ height: '36px', width: '85%', borderRadius: 'var(--radius-sm)' }} />
          </div>
        )}

        {!isLoading && !currentTrack && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--space-6)'
            }}
          >
            <EmptyState
              icon={<Music2 size={ICON.display} />}
              title="Ничего не играет"
              description="Включите песню — текст появится здесь и будет подсвечиваться по ходу."
              data-testid="karaoke-empty"
            />
          </div>
        )}

        {!isLoading && currentTrack && lyrics?.instrumental && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--space-6)'
            }}
          >
            <EmptyState
              icon={<Music2 size={ICON.display} />}
              title="Инструментал"
              description="В этой записи нет вокала — текста тоже нет."
              data-testid="karaoke-instrumental"
            />
          </div>
        )}

        {!isLoading && currentTrack && !lyrics?.instrumental && !hasLines && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 'var(--space-6)'
            }}
          >
            <EmptyState
              icon={<MicOff size={ICON.display} />}
              title="Текст не найден"
              description={`Для «${currentTrack.title}» текста в базе нет. Иногда помогает поиск по другому написанию названия.`}
              action={
                <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
                  <Button variant="secondary" size="sm" onClick={openPicker} data-testid="karaoke-search-manually">
                    Поискать вручную
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void loadLyrics()}>
                    Попробовать снова
                  </Button>
                </div>
              }
              data-testid="karaoke-not-found"
            />
          </div>
        )}

        {!isLoading && hasLines && lyrics && (
          <div
            style={{
              width: '100%',
              maxWidth: '740px',
              display: 'flex',
              flexDirection: 'column',
              gap: lyrics.synced ? 'var(--space-4)' : 'var(--space-3)',
              padding: 'var(--space-6) var(--space-4)',
              textAlign: 'center'
            }}
            data-testid="karaoke-lyrics-list"
          >
            {lyrics.lines.map((line, index) => {
              const isActive = lyrics.synced && index === activeLineIndex;
              const isPast = lyrics.synced && activeLineIndex >= 0 && index < activeLineIndex;
              const distance = lyrics.synced && activeLineIndex >= 0 ? Math.abs(index - activeLineIndex) : 0;

              let opacity = 0.85;
              if (lyrics.synced) {
                if (isActive) {
                  opacity = 1;
                } else if (isPast) {
                  opacity = Math.max(0.32, 0.65 - distance * 0.08);
                } else {
                  opacity = Math.max(0.28, 0.7 - distance * 0.08);
                }
              }

              return (
                <div
                  key={`line-${index}-${line.time}`}
                  ref={(el) => {
                    lineRefs.current[index] = el;
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleLineClick(line)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleLineClick(line);
                    }
                  }}
                  aria-current={isActive ? 'true' : undefined}
                  data-active={isActive}
                  data-testid={`karaoke-line-${index}`}
                  className="karaoke-line focus-ring"
                  style={{
                    cursor: 'pointer',
                    padding: 'var(--space-3) var(--space-4)',
                    borderRadius: 'var(--radius-md)',
                    transition:
                      'color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), transform var(--dur-normal) var(--ease-out), opacity var(--dur-normal) var(--ease-out)',
                    opacity,
                    transform: isActive ? 'scale(1.04)' : 'scale(1)',
                    // Цвет, заливка, рамка и тень — в `.karaoke-line`
                    // (global.css §13): инлайном они глушили `.press:hover`, и
                    // строка, по нажатию на которую песня перематывается, ничем
                    // не показывала, что на ней курсор.
                    // На телефоне на ступень мельче: строка в `--text-2xl` на
                    // 360 px переносится на три-четыре части, и «подсвеченная
                    // строка» превращается в абзац — по нему уже не видно, где
                    // сейчас поют.
                    fontSize: isActive
                      ? isMobile
                        ? 'var(--text-xl)'
                        : 'var(--text-2xl)'
                      : isMobile
                        ? 'var(--text-base)'
                        : 'var(--text-lg)',
                    fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-normal)',
                    lineHeight: '1.45',
                    letterSpacing: isActive ? 'var(--tracking-2xl)' : 'var(--tracking-lg)',
                    textAlign: 'center'
                  }}
                >
                  <span>{line.text || '•••'}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isUserScrolled && lyrics?.synced && (
        <div
          style={{
            position: 'absolute',
            bottom: 'var(--space-6)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10
          }}
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleResumeAutoScroll}
            icon={<ArrowDownCircle size={ICON.md} />}
            style={{
              boxShadow: 'var(--shadow-lg)',
              borderRadius: 'var(--radius-full)',
              padding: 'var(--space-2) var(--space-4)'
            }}
            data-testid="karaoke-resume-scroll-btn"
          >
            К текущей строке
          </Button>
        </div>
      )}
    </div>
  );
};
