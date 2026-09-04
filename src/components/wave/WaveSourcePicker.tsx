import React from 'react';
import { Library, Compass, User, History, Disc3 } from 'lucide-react';
import { WaveSeedKind } from '../../types/store';
import { UnifiedTrack } from '../../types/music';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { normalizeArtist } from '../../services/recommendationEngine';
import { ICON } from '../../styles/icons';

export interface WaveSourcePickerProps {
  className?: string;
  /** Перезапускать ли Поток сразу после смены источника. */
  restartOnChange?: boolean;
}

interface SourceItem {
  id: WaveSeedKind;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const SOURCES: SourceItem[] = [
  {
    id: 'track',
    label: 'От этой песни',
    hint: 'Тот же жанр, что играет сейчас',
    icon: <Disc3 size={ICON.md} />
  },
  {
    id: 'library',
    label: 'Из библиотеки',
    hint: 'Опираемся на то, что вы уже слушали',
    icon: <Library size={ICON.md} />
  },
  {
    id: 'discovery',
    label: 'Незнакомое',
    hint: 'Только имена, которых у вас не было',
    icon: <Compass size={ICON.md} />
  },
  {
    id: 'artist',
    label: 'По артисту',
    hint: 'Отталкиваемся от одного исполнителя',
    icon: <User size={ICON.md} />
  },
  {
    id: 'forgotten',
    label: 'Забытое',
    hint: 'То, что не включали больше месяца',
    icon: <History size={ICON.md} />
  }
];

/**
 * Кого предложить в качестве отправной точки. Считается по избранному и
 * истории: чем чаще исполнитель встречается, тем выше он в списке.
 */
export function suggestSeedArtists(tracks: UnifiedTrack[], limit = 6): string[] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const track of tracks) {
    const key = normalizeArtist(track?.artist || '');
    if (!key) continue;
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { display: track.artist, count: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((entry) => entry.display);
}

/**
 * Источник Потока. До этого «откуда брать музыку» и «насколько знакомую» жили в
 * одном списке настроений, поэтому выбор «Незнакомое» молча отменял всё
 * остальное. Теперь это отдельный вопрос с отдельным ответом.
 */
export const WaveSourcePicker: React.FC<WaveSourcePickerProps> = ({
  className = '',
  restartOnChange = true
}) => {
  const seedKind = usePlayerStore((s) => s.waveSeedKind);
  const seedArtist = usePlayerStore((s) => s.waveSeedArtist);
  const queueMode = usePlayerStore((s) => s.queueMode);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const setWaveSeed = usePlayerStore((s) => s.setWaveSeed);
  const startMyWave = usePlayerStore((s) => s.startMyWave);

  const favorites = useLibraryStore((s) => s.favorites);
  const history = useLibraryStore((s) => s.history);

  // Текущий трек идёт первым: чаще всего Поток хотят продолжить именно от него.
  const artistOptions = React.useMemo(() => {
    const suggested = suggestSeedArtists([...favorites, ...history]);
    const withCurrent = currentTrack?.artist ? [currentTrack.artist, ...suggested] : suggested;
    const seen = new Set<string>();
    return withCurrent.filter((name) => {
      const key = normalizeArtist(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [favorites, history, currentTrack?.artist]);

  const canPickArtist = artistOptions.length > 0 || Boolean(seedArtist);

  const applySeed = (kind: WaveSeedKind, artist?: string | null) => {
    setWaveSeed(kind, artist);
    if (restartOnChange && queueMode === 'my_wave') {
      void startMyWave();
    }
  };

  const handleSourceClick = (kind: WaveSeedKind) => {
    // Без играющей песни отталкиваться не от чего — плитка и так погашена.
    if (kind === 'track' && !currentTrack) return;
    if (kind !== 'artist') {
      applySeed(kind);
      return;
    }
    // Источник «по артисту» бессмысленен без имени: если выбирать некого,
    // кнопка не должна делать вид, что что-то произошло.
    const nextArtist = seedArtist || artistOptions[0];
    if (!nextArtist) return;
    applySeed('artist', nextArtist);
  };

  return (
    <div
      className={`wave-source-picker ${className}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', width: '100%' }}
      data-testid="wave-source-picker"
    >
      <div className="section-label">Откуда берём музыку</div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 'var(--space-2)'
        }}
      >
        {SOURCES.map((source) => {
          const isActive = seedKind === source.id;
          // «От этой песни» без песни — такое же ничто, как «по артисту» без имени.
          const isDisabled =
            (source.id === 'artist' && !canPickArtist) || (source.id === 'track' && !currentTrack);
          const hint =
            source.id === 'artist'
              ? isDisabled
                ? 'Пока некого выбрать — послушайте что-нибудь'
                : seedArtist || source.hint
              : source.id === 'track'
                ? isDisabled
                  ? 'Включите песню, от которой начать'
                  : currentTrack?.title || source.hint
                : source.hint;

          return (
            <button
              key={source.id}
              type="button"
              onClick={() => handleSourceClick(source.id)}
              disabled={isDisabled}
              className="press-surface focus-ring hover-sheen"
              aria-pressed={isActive}
              title={hint}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: '2px',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                // Цвета покоя и выбора — в `.press-surface` (global.css §14).
                // Инлайном их держать нельзя: инлайновое объявление старше
                // любого правила таблицы стилей, и `:hover` до плитки не
                // доходил — четыре плитки источника не отвечали на наведение
                // вовсе, хотя переход для фона объявляли.
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.5 : 1,
                textAlign: 'left'
              }}
              data-testid={`wave-source-chip-${source.id}`}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  fontSize: 'var(--text-sm)',
                  fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-medium)'
                }}
              >
                <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {source.icon}
                </span>
                {source.label}
              </span>
              <span
                className="text-truncate"
                style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', maxWidth: '100%' }}
              >
                {hint}
              </span>
            </button>
          );
        })}
      </div>

      {seedKind === 'artist' && artistOptions.length > 0 && (
        <div
          className="animate-slide-up"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }}
          data-testid="wave-seed-artist-list"
        >
          {artistOptions.map((artist, i) => {
            const isActive = normalizeArtist(artist) === normalizeArtist(seedArtist || '');
            return (
              <button
                key={`${artist}-${i}`}
                type="button"
                onClick={() => applySeed('artist', artist)}
                className="chip"
                aria-pressed={isActive}
                style={{
                  // Ни цвета, ни рамки: всё в `.chip` и `.chip[aria-pressed]`.
                  // Раньше здесь стоял инлайновый фон, а он старше правила
                  // таблицы — и `.chip:hover` не срабатывал ни на одном чипе.
                  fontSize: 'var(--text-xs)',
                  fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-normal)'
                }}
                data-testid={`wave-seed-artist-${i}`}
              >
                {artist}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
