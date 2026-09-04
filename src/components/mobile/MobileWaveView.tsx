import React, { useCallback, useState } from 'react';
import {
  ChevronRight,
  Compass,
  CopyPlus,
  Disc3,
  ListMusic,
  Loader2,
  Play,
  RefreshCw,
  SlidersHorizontal,
  ThumbsDown,
  Timer,
  User
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { recommendationEngine } from '../../services/recommendationEngine';
import { WaveVisualizerOrb } from '../wave/WaveVisualizerOrb';
import { WaveTuner, describeWaveAxes } from '../wave/WaveTuner';
import { ICON } from '../../styles/icons';
import type { WaveSeedKind } from '../../types/store';
import { Button } from '../common/Button';
import { Sheet, SheetRow } from './Sheet';
import { TrackRow } from './TrackRow';

/**
 * Поток на телефоне.
 *
 * Что было не так с прежним экраном — по жалобе владельца, «поток слишком
 * маленький, клавиши между собой плохо соединены»:
 *
 * - подпись в три строки, шар на пол-экрана и карточка «Настройте параметры
 *   ниже» с пустой левой половиной занимали верх, не сообщая почти ничего;
 * - под главной кнопкой стояли **четыре безымянных значка** 24 px. Подписи у
 *   них есть, но обёрнуты в `hide-on-mobile`, поэтому на телефоне оставались
 *   голые иконки — вдобавок погашенные, пока ничего не играет. Ряд значков без
 *   имён, ни с чем не связанный, — это и есть «плохо соединены»;
 * - выбор источника жил плитками, из которых «От этой песни» молча ничего не
 *   делала, если ничего не играет.
 *
 * Здесь: одно главное действие крупной кнопкой, источник и настройка — двумя
 * читаемыми строками со значением справа (как в настройках телефона), а
 * оценка трека появляется **только когда есть что оценивать** и всегда с
 * подписью.
 */

interface SourceItem {
  id: WaveSeedKind;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const SOURCES: SourceItem[] = [
  { id: 'library', label: 'Из библиотеки', hint: 'Опираемся на то, что вы слушали', icon: <ListMusic size={ICON.lg} /> },
  { id: 'track', label: 'От этой песни', hint: 'Радио по тому, что играет сейчас', icon: <Disc3 size={ICON.lg} /> },
  { id: 'discovery', label: 'Незнакомое', hint: 'Только имена, которых у вас не было', icon: <Compass size={ICON.lg} /> },
  { id: 'artist', label: 'По артисту', hint: 'Отталкиваемся от одного исполнителя', icon: <User size={ICON.lg} /> },
  { id: 'forgotten', label: 'Забытое', hint: 'То, что давно не включали', icon: <Timer size={ICON.lg} /> }
];

/** Сколько треков Потока показывать списком. */
const UPCOMING_LIMIT = 6;

export const MobileWaveView: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queueMode = usePlayerStore((s) => s.queueMode);
  const sourceQueue = usePlayerStore((s) => s.sourceQueue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isReplenishing = usePlayerStore((s) => s.isReplenishingQueue);
  const novelty = usePlayerStore((s) => s.waveNovelty);
  const energy = usePlayerStore((s) => s.waveEnergy);
  const seedKind = usePlayerStore((s) => s.waveSeedKind);
  const seedArtist = usePlayerStore((s) => s.waveSeedArtist);
  const setWaveSeed = usePlayerStore((s) => s.setWaveSeed);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const showToast = useUIStore((s) => s.showToast);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const [isSourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [isTunerSheetOpen, setTunerSheetOpen] = useState(false);

  const isWaveActive = queueMode === 'my_wave';
  const activeSource = SOURCES.find((s) => s.id === seedKind) ?? SOURCES[0];
  const upcoming = sourceQueue.slice(currentIndex + 1, currentIndex + 1 + UPCOMING_LIMIT);

  const handleStart = useCallback(() => {
    void usePlayerStore.getState().startMyWave();
  }, []);

  const handleFeedback = useCallback(
    async (kind: 'like' | 'dislike' | 'more') => {
      if (!currentTrack) return;
      try {
        if (kind === 'dislike') {
          await recommendationEngine.recordFeedback(currentTrack, 'dislike');
          showToast(`«${currentTrack.title}» убран из Потока`, 'info');
          await usePlayerStore.getState().nextTrack();
          return;
        }
        await recommendationEngine.recordFeedback(currentTrack, kind === 'like' ? 'like' : 'more_like_this');
        showToast(kind === 'like' ? 'Учтём, что нравится' : 'Будет больше такого', 'success');
      } catch {
        showToast('Оценка не сохранилась', 'error');
      }
    },
    [currentTrack, showToast]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }} data-testid="mobile-wave-view">
      <h1
        style={{
          margin: 0,
          fontSize: 'var(--text-2xl)',
          lineHeight: 'var(--leading-2xl)',
          letterSpacing: 'var(--tracking-2xl)',
          fontWeight: 'var(--weight-bold)',
          color: 'var(--text-primary)'
        }}
      >
        Поток
      </h1>

      {/*
        * Шар и кнопка — одной карточкой. Раньше между ними стояла ещё одна
        * панель с подсказкой «Настройте параметры ниже», хотя настраивать было
        * нечего: параметры лежали за безымянным значком.
        */}
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-4)',
          padding: 'var(--space-5) var(--space-4)',
          borderRadius: 'var(--radius-xl)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)'
        }}
      >
        {/*
          * `chill`, а не `activeWaveMood`.
          *
          * Настроение сдвигает тон шара: значение по умолчанию `favorite`
          * поворачивает его на +78° — в сирень. На экране при этом голубой
          * акцент, и получались два разных акцента разом, о чём владелец и
          * сказал. На телефоне настроение нигде не выбирается, то есть шар
          * показывал не выбор человека, а забытое значение по умолчанию;
          * `chill` — это hue 0, то есть сам акцент приложения.
          */}
        <WaveVisualizerOrb mood="chill" isPlaying={isPlaying} width={140} height={140} />

        <p
          style={{
            margin: 0,
            textAlign: 'center',
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            letterSpacing: 'var(--tracking-sm)',
            color: 'var(--text-secondary)',
            overflowWrap: 'anywhere'
          }}
          data-testid="mobile-wave-summary"
        >
          {activeSource.label}
          {seedKind === 'artist' && seedArtist ? ` — ${seedArtist}` : ''}: {describeWaveAxes(novelty, energy)}
        </p>

        {/*
          * Общая кнопка приложения, а не своя: её цвета живут в
          * `.wireon-btn[data-variant]`, тогда как инлайновый фон был бы старше
          * правила и заглушил бы ответ на нажатие.
          */}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleStart}
          isLoading={isReplenishing}
          icon={
            isReplenishing ? (
              <Loader2 size={ICON.lg} aria-hidden="true" />
            ) : isWaveActive ? (
              <RefreshCw size={ICON.lg} aria-hidden="true" />
            ) : (
              <Play size={ICON.lg} fill="currentColor" aria-hidden="true" />
            )
          }
          // 52 — кнопка, в которую попадают, не целясь. Это единственное
          // действие экрана, и оно обязано читаться как таковое.
          style={{ minHeight: '52px', borderRadius: 'var(--radius-pill)' }}
          data-testid="mobile-wave-start"
        >
          {isReplenishing ? 'Собираем…' : isWaveActive ? 'Пересобрать Поток' : 'Запустить Поток'}
        </Button>
      </section>

      {/*
        * Источник и настройка — строками со значением справа, как в настройках
        * телефона. Прежде источник выбирался плитками, а настройка пряталась за
        * значком без подписи.
        */}
      <section
        style={{
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
      >
        <SheetRow
          icon={activeSource.icon}
          label="Источник"
          hint={activeSource.label}
          chevron={<ChevronRight size={ICON.md} aria-hidden="true" />}
          onClick={() => setSourceSheetOpen(true)}
          data-testid="mobile-wave-source-row"
        />
        <SheetRow
          icon={<SlidersHorizontal size={ICON.lg} aria-hidden="true" />}
          label="Настройка"
          hint={describeWaveAxes(novelty, energy)}
          chevron={<ChevronRight size={ICON.md} aria-hidden="true" />}
          onClick={() => setTunerSheetOpen(true)}
          data-testid="mobile-wave-tune-row"
        />
      </section>

      {/*
        * Оценка появляется, только когда есть что оценивать. Прежде эти кнопки
        * стояли всегда — погашенные, безымянные и ни с чем не связанные.
        */}
      {currentTrack && isWaveActive && (
        <section style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <FeedbackButton
            icon={<ThumbsDown size={ICON.md} aria-hidden="true" />}
            label="Не это"
            onClick={() => void handleFeedback('dislike')}
            testId="mobile-wave-dislike"
          />
          <FeedbackButton
            icon={<CopyPlus size={ICON.md} aria-hidden="true" />}
            label="Больше такого"
            onClick={() => void handleFeedback('more')}
            testId="mobile-wave-more"
          />
        </section>
      )}

      {isWaveActive && upcoming.length > 0 && (
        <section>
          <h2
            style={{
              margin: '0 0 var(--space-2)',
              fontSize: 'var(--text-lg)',
              lineHeight: 'var(--leading-lg)',
              letterSpacing: 'var(--tracking-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            Далее в Потоке
          </h2>
          {upcoming.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              onPlay={() => void playTrack(track, sourceQueue, sourceQueue.indexOf(track))}
              onOpenActions={() => openTrackActions(track)}
              data-testid={`mobile-wave-next-${track.id}`}
            />
          ))}
        </section>
      )}

      <Sheet
        isOpen={isSourceSheetOpen}
        onClose={() => setSourceSheetOpen(false)}
        title="Откуда собирать Поток"
        data-testid="mobile-wave-source-sheet"
      >
        {SOURCES.map((source) => (
          <SheetRow
            key={source.id}
            icon={source.icon}
            label={source.label}
            /*
             * «От этой песни» без играющей песни раньше молча ничего не делала
             * — плитка гасла, нажатие не давало ответа. Теперь строка честно
             * говорит, чего не хватает, и остаётся выбираемой: как только
             * что-то заиграет, выбор сработает.
             */
            hint={
              source.id === 'track' && !currentTrack
                ? 'Пока ничего не играет — включите трек'
                : source.hint
            }
            onClick={() => {
              setWaveSeed(source.id);
              setSourceSheetOpen(false);
            }}
            data-testid={`mobile-wave-source-${source.id}`}
          />
        ))}
      </Sheet>

      <Sheet
        isOpen={isTunerSheetOpen}
        onClose={() => setTunerSheetOpen(false)}
        title="Настройка Потока"
        data-testid="mobile-wave-tuner-sheet"
      >
        <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
          <WaveTuner restartOnChange={isWaveActive} />
        </div>
      </Sheet>
    </div>
  );
};

interface FeedbackButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  testId: string;
}

/** Оценка трека: значок и подпись рядом, а не голый значок. */
const FeedbackButton: React.FC<FeedbackButtonProps> = ({ icon, label, onClick, testId }) => (
  <button
    type="button"
    className="press"
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 'var(--space-2)',
      flex: 1,
      minHeight: '44px',
      borderRadius: 'var(--radius-pill)',
      border: '1px solid var(--border)',
      color: 'var(--text-secondary)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--leading-sm)',
      letterSpacing: 'var(--tracking-sm)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {icon}
    {label}
  </button>
);
