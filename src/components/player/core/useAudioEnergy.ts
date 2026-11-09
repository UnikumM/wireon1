import { useEffect, useState } from 'react';
import { audioEngine } from '../../../services/audioEngine';

/**
 * Громкость момента, 0…1, сглаженная — для реактивного фона сцены.
 *
 * Читает тот же анализатор, что и визуализатор, но отдаёт одно число вместо
 * спектра: фону нужно дышать в такт, а не рисовать полосы. Сглаживание в обе
 * стороны разное: вверх быстро (удар слышен сразу), вниз медленно (свет гаснет,
 * а не моргает). Без анализатора — на телефоне, где звук идёт мимо Web Audio,
 * и в тестах — остаётся ноль, и фон просто не дышит.
 *
 * Состояние обновляется не чаще ~15 раз в секунду и только при заметной
 * разнице: перерисовывать сцену 60 раз в секунду ради тысячной доли незачем.
 */
export function useAudioEnergy(enabled: boolean): number {
  const [energy, setEnergy] = useState(0);

  useEffect(() => {
    if (!enabled || typeof requestAnimationFrame !== 'function') {
      setEnergy(0);
      return;
    }
    let frame = 0;
    let smoothed = 0;
    let lastPublished = -1;
    let lastPublishAt = 0;
    let buffer: Uint8Array<ArrayBuffer> | null = null;

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const analyser = audioEngine.getAnalyser();
      if (!analyser) return;
      if (!buffer || buffer.length !== analyser.frequencyBinCount) {
        buffer = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(buffer);
      // Низ и середина спектра: там бочка и голос, то есть то, что слышно как «громко».
      const upto = Math.max(8, Math.floor(buffer.length * 0.4));
      let sum = 0;
      for (let i = 0; i < upto; i++) sum += buffer[i];
      const level = sum / (upto * 255);
      smoothed += (level - smoothed) * (level > smoothed ? 0.35 : 0.08);
      if (now - lastPublishAt < 66) return;
      const rounded = Math.round(smoothed * 50) / 50;
      if (rounded !== lastPublished) {
        lastPublished = rounded;
        lastPublishAt = now;
        setEnergy(rounded);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);

  return energy;
}
