import React from 'react';
import { Play } from 'lucide-react';
import { Button } from '../common/Button';
import { PlaylistCover } from '../library/PlaylistCover';
import { usePlayerStore } from '../../store/usePlayerStore';
import { DailyMix } from '../../services/dailyMixes';
import { formatListeningTime } from '../../services/listeningStats';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface DailyMixCardProps {
  mix: DailyMix;
  index: number;
}

/**
 * Карточка микса. Весь список известен заранее, поэтому нажатие сразу ставит
 * его в очередь целиком — ничего доигрывать и досчитывать не нужно.
 */
export const DailyMixCard: React.FC<DailyMixCardProps> = ({ mix, index }) => {
  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const totalSeconds = mix.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const isPlayingFromMix = Boolean(currentTrack && mix.tracks.some((track) => track.id === currentTrack.id));

  const start = () => {
    const first = mix.tracks[0];
    if (first) void playTrack(first, mix.tracks, 0);
  };

  return (
    /*
     * `animate-settle` вместо подъёма: миксы стоят сеткой в два-три столбца, и
     * волна, идущая наискось, замечается раньше самих подборок. Номер по порядку
     * тут же в сетке — миксы приходят одним куском, порциями не догружаются.
     * `hover-sheen` — карточка целиком отвечает за подборку и должна выглядеть
     * весомее строки списка.
     */
    <div
      className="card animate-settle hover-sheen"
      style={
        {
          padding: 'var(--space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          '--stagger': index
        } as React.CSSProperties
      }
      data-testid={`daily-mix-${index}`}
    >
      <PlaylistCover tracks={mix.tracks} size={132} />

      <div style={{ minWidth: 0 }}>
        <h3
          style={{
            margin: 0,
            fontSize: 'var(--text-base)',
            lineHeight: 'var(--leading-base)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={mix.title}
        >
          {mix.title}
        </h3>
        <p
          style={{
            margin: '2px 0 0 0',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={mix.subtitle}
        >
          {mix.subtitle}
        </p>
        <p
          style={{
            margin: '2px 0 0 0',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-muted)'
          }}
          data-numeric
          data-testid={`daily-mix-${index}-totals`}
        >
          {pluralize(mix.tracks.length, 'трек', 'трека', 'треков')} · {formatListeningTime(totalSeconds)}
        </p>
      </div>

      <Button
        variant={isPlayingFromMix ? 'secondary' : 'primary'}
        size="sm"
        icon={<Play size={ICON.sm} aria-hidden="true" />}
        onClick={start}
        aria-label={`Включить «${mix.title}»`}
        data-testid={`daily-mix-${index}-play`}
      >
        {isPlayingFromMix ? 'Играет' : 'Включить'}
      </Button>
    </div>
  );
};

export default DailyMixCard;
