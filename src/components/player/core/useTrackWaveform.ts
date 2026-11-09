import { useEffect, useState } from 'react';
import type { UnifiedTrack } from '../../../types/music';
import { getWaveform, peekWaveform } from '../../../services/waveform';

/**
 * Волна текущего трека для таймлайна: null, пока её нет или источник не отдаёт.
 *
 * Загрузка привязана к id трека. Когда трек сменился до ответа, старый ответ
 * отбрасывается — иначе форма предыдущей песни легла бы под новую. То, что уже
 * лежит в памяти или в localStorage, подставляется сразу, без пустого кадра.
 */
export function useTrackWaveform(track: UnifiedTrack | null | undefined): number[] | null {
  const trackId = track?.id ?? null;
  const [state, setState] = useState<{ id: string | null; bars: number[] | null }>(() => ({
    id: trackId,
    bars: peekWaveform(track)
  }));

  useEffect(() => {
    if (!track) {
      setState({ id: null, bars: null });
      return;
    }

    let cancelled = false;
    const ready = peekWaveform(track);
    setState({ id: track.id, bars: ready });
    if (ready) return;

    void getWaveform(track).then((bars) => {
      if (!cancelled) setState({ id: track.id, bars });
    });

    return () => {
      cancelled = true;
    };
    // Трек — объект, который стор может пересоздать без смены песни; слушаем id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId]);

  // Форма от другого трека не показывается даже один кадр до срабатывания эффекта.
  return state.id === trackId ? state.bars : null;
}
