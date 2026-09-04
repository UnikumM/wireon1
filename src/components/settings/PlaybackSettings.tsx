import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection, SettingRow, SliderSetting, ToggleSetting } from './SettingsPrimitives';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../utils/time';
import { EQ_PRESETS, matchEqPreset } from '../../utils/eqPresets';
import { ICON } from '../../styles/icons';

const SLEEP_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: 'Выключен', minutes: null },
  { label: '15 минут', minutes: 15 },
  { label: '30 минут', minutes: 30 },
  { label: '60 минут', minutes: 60 },
  { label: '90 минут', minutes: 90 }
];

const EQ_BANDS: { key: 'bass' | 'mid' | 'treble'; label: string; description: string }[] = [
  { key: 'bass', label: 'Низкие', description: 'Полка снизу, примерно 120 Гц.' },
  { key: 'mid', label: 'Средние', description: 'Пик примерно на 1 кГц.' },
  { key: 'treble', label: 'Высокие', description: 'Полка сверху, примерно 6 кГц.' }
];

function formatDecibels(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded} дБ`;
}

/** Counts down while a sleep timer is armed; returns null when there is none. */
function useSleepRemaining(endsAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endsAt]);

  if (endsAt === null) return null;
  return Math.max(0, Math.round((endsAt - now) / 1000));
}

export const PlaybackSettings: React.FC = () => {
  const volume = usePlayerStore((s) => s.volume);
  const eq = usePlayerStore((s) => s.eq);
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeDuration = usePlayerStore((s) => s.crossfadeDuration);
  const loudnessNormalization = usePlayerStore((s) => s.loudnessNormalization);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setEq = usePlayerStore((s) => s.setEq);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeDuration = usePlayerStore((s) => s.setCrossfadeDuration);
  const setLoudnessNormalization = usePlayerStore((s) => s.setLoudnessNormalization);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);

  const remainingSeconds = useSleepRemaining(sleepTimerEndsAt);
  const isEqFlat = eq.bass === 0 && eq.mid === 0 && eq.treble === 0;
  const activePreset = matchEqPreset(eq);

  // The store only keeps the deadline, so the picker remembers which option
  // produced it and clears itself once the timer fires or is cancelled.
  const [selectedSleepOption, setSelectedSleepOption] = useState('');

  useEffect(() => {
    if (sleepTimerEndsAt === null) setSelectedSleepOption('');
  }, [sleepTimerEndsAt]);

  return (
    <SettingsSection
      id="playback"
      title="Воспроизведение"
      description="Громкость, тембр, переходы между треками и то, чем заканчивается очередь."
    >
      <SliderSetting
        id="setting-volume"
        label="Громкость"
        min={0}
        max={100}
        value={Math.round(volume * 100)}
        onChange={(next) => setVolume(next / 100)}
        format={(next) => `${next}%`}
      />

      <div className="divider" role="presentation" />

      <ToggleSetting
        id="setting-crossfade-enabled"
        label="Плавный переход между треками"
        description="Один трек затихает, пока следующий набирает громкость — без паузы между ними."
        checked={crossfadeEnabled}
        onChange={setCrossfadeEnabled}
      />

      <SliderSetting
        id="setting-crossfade-duration"
        label="Длительность перехода"
        description="Сколько секунд треки звучат вместе (от 0 до 12). Для коротких треков время само уменьшается."
        min={0}
        max={12}
        step={1}
        value={crossfadeDuration}
        disabled={!crossfadeEnabled}
        onChange={setCrossfadeDuration}
        format={(next) => `${next} с`}
      />

      <div className="divider" role="presentation" />

      <ToggleSetting
        id="setting-loudness-normalization"
        label="Выравнивание громкости"
        description="Сглаживает разницу в громкости между записями с разных сервисов, чтобы не тянуться к регулятору на каждом треке."
        checked={loudnessNormalization}
        onChange={setLoudnessNormalization}
      />

      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-4)' }}>
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            Эквалайзер
          </h3>
          <p
            style={{
              margin: '2px 0 0 0',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-xs)',
              color: 'var(--text-muted)'
            }}
          >
            Три полосы, от −12 до +12 дБ. Слышно сразу, на текущем треке —
            или возьмите готовый пресет.
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          icon={<RotateCcw size={ICON.sm} />}
          disabled={isEqFlat}
          onClick={() => setEq({ bass: 0, mid: 0, treble: 0 })}
          data-testid="settings-eq-reset"
        >
          Сбросить
        </Button>
      </div>

      {EQ_BANDS.map((band) => (
        <SliderSetting
          key={band.key}
          id={`setting-eq-${band.key}`}
          label={band.label}
          description={band.description}
          min={-12}
          max={12}
          value={eq[band.key]}
          onChange={(next) => setEq({ [band.key]: next })}
          format={formatDecibels}
        />
      ))}

      <div
        role="group"
        aria-label="Пресеты эквалайзера"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}
      >
        {EQ_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="chip"
            aria-pressed={activePreset?.id === preset.id}
            title={preset.description}
            onClick={() => setEq(preset.gains)}
            data-testid={`settings-eq-preset-${preset.id}`}
            style={{ fontSize: 'var(--text-xs)' }}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 'var(--text-xs)',
          lineHeight: 'var(--leading-xs)',
          color: 'var(--text-muted)'
        }}
        data-testid="settings-eq-preset-state"
      >
        {activePreset ? activePreset.description : 'Полосы настроены вручную.'}
      </p>

      <div className="divider" role="presentation" />

      <ToggleSetting
        id="setting-autoplay-radio"
        label="Продолжать, когда очередь закончилась"
        description="Wireon Sounds ищет на YouTube и SoundCloud треки, близкие к последнему, и дописывает их в очередь. Это подбор по ключевым словам, а не полноценные рекомендации: иногда попадает мимо, а если похожего не нашлось — просто останавливается."
        checked={autoplayRadio}
        onChange={setAutoplayRadio}
      />

      <SettingRow
        label="Таймер сна"
        controlId="setting-sleep-timer"
        description={
          remainingSeconds !== null
            ? `Музыка встанет на паузу через ${formatDuration(remainingSeconds)}.`
            : 'Поставить музыку на паузу через заданное время.'
        }
      >
        <select
          id="setting-sleep-timer"
          value={selectedSleepOption}
          aria-describedby="setting-sleep-timer-description"
          onChange={(e) => {
            const raw = e.target.value;
            setSelectedSleepOption(raw);
            setSleepTimer(raw === '' ? null : Number(raw));
          }}
          data-testid="settings-sleep-timer"
        >
          {SLEEP_OPTIONS.map((option) => (
            <option key={option.label} value={option.minutes === null ? '' : String(option.minutes)}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsSection>
  );
};
