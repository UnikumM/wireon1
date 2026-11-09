import React, { useEffect, useState } from 'react';
import { RotateCcw, Headphones, Plus, Pencil, Link2, Link2Off, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection, SettingRow, SliderSetting, ToggleSetting } from './SettingsPrimitives';
import { EqProfileNameModal } from './EqProfileNameModal';
import { usePlayerStore } from '../../store/usePlayerStore';
import { formatDuration } from '../../utils/time';
import { EQ_PRESETS, matchEqPreset } from '../../utils/eqPresets';
import { ICON } from '../../styles/icons';
import { detectPlatform } from '../../services/nativeBridge';

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
  const softResume = usePlayerStore((s) => s.softResume);
  const audioBalance = usePlayerStore((s) => s.audioBalance);
  const audioMono = usePlayerStore((s) => s.audioMono);
  const setAudioBalance = usePlayerStore((s) => s.setAudioBalance);
  const setAudioMono = usePlayerStore((s) => s.setAudioMono);
  const autoplayRadio = usePlayerStore((s) => s.autoplayRadio);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const setSleepAtTrackEnd = usePlayerStore((s) => s.setSleepAtTrackEnd);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const setEq = usePlayerStore((s) => s.setEq);
  const eqProfiles = usePlayerStore((s) => s.eqProfiles);
  const activeEqProfileId = usePlayerStore((s) => s.activeEqProfileId);
  const eqOutputDevice = usePlayerStore((s) => s.eqOutputDevice);
  const eqDeviceSupport = usePlayerStore((s) => s.eqDeviceSupport);
  const saveEqProfile = usePlayerStore((s) => s.saveEqProfile);
  const applyEqProfile = usePlayerStore((s) => s.applyEqProfile);
  const deleteEqProfile = usePlayerStore((s) => s.deleteEqProfile);
  const renameEqProfile = usePlayerStore((s) => s.renameEqProfile);
  const bindEqProfileToDevice = usePlayerStore((s) => s.bindEqProfileToDevice);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeDuration = usePlayerStore((s) => s.setCrossfadeDuration);
  const setLoudnessNormalization = usePlayerStore((s) => s.setLoudnessNormalization);
  const setSoftResume = usePlayerStore((s) => s.setSoftResume);
  const setAutoplayRadio = usePlayerStore((s) => s.setAutoplayRadio);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);

  const remainingSeconds = useSleepRemaining(sleepTimerEndsAt);
  const isEqFlat = eq.bass === 0 && eq.mid === 0 && eq.treble === 0;
  const activePreset = matchEqPreset(eq);
  const activeProfile = eqProfiles.find((p) => p.id === activeEqProfileId) ?? null;

  // Окно имени одно на сохранение и переименование: `rename` — какой профиль.
  const [nameModal, setNameModal] = useState<{ mode: 'save' } | { mode: 'rename'; id: string } | null>(null);
  const canBindDevice = eqDeviceSupport === 'available' && eqOutputDevice !== null;
  const devicesHidden = eqDeviceSupport === 'hidden' || eqDeviceSupport === 'unsupported';
  const currentDeviceLabel = eqOutputDevice?.label || 'текущее устройство';
  const activeBoundHere = Boolean(activeProfile && eqOutputDevice && activeProfile.deviceId === eqOutputDevice.deviceId);

  /** Подпись под рядом чипов: что именно сейчас стоит. */
  const eqStateText = (() => {
    if (activePreset) return activePreset.description;
    if (activeProfile) {
      if (!activeProfile.deviceId) return `Профиль «${activeProfile.name}» — без привязки к устройству.`;
      return activeBoundHere
        ? `Профиль «${activeProfile.name}» — включается с «${currentDeviceLabel}».`
        : `Профиль «${activeProfile.name}» — включается с другим устройством.`;
    }
    return 'Полосы настроены вручную.';
  })();

  // The store only keeps the deadline, so the picker remembers which option
  // produced it and clears itself once the timer fires or is cancelled.
  const mobileAudioFx = usePlayerStore((s) => s.mobileAudioFx);
  const setMobileAudioFx = usePlayerStore((s) => s.setMobileAudioFx);
  const isMobile = detectPlatform() === 'mobile';
  const [selectedSleepOption, setSelectedSleepOption] = useState('');

  useEffect(() => {
    if (sleepAtTrackEnd) setSelectedSleepOption('end');
    else if (sleepTimerEndsAt === null) setSelectedSleepOption('');
  }, [sleepTimerEndsAt, sleepAtTrackEnd]);

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

      <ToggleSetting
        id="setting-soft-resume"
        label="Мягкое возвращение"
        description="После долгой паузы трек начинается на три секунды раньше и входит с тихого."
        checked={softResume}
        onChange={setSoftResume}
      />

      <div className="divider" role="presentation" />

      <SliderSetting
        id="setting-audio-balance"
        label="Баланс"
        description="Сдвинуть звук к левому или правому уху — если один наушник тише или одно ухо слышит хуже."
        min={-100}
        max={100}
        step={1}
        value={Math.round(audioBalance * 100)}
        onChange={(next) => setAudioBalance(next / 100)}
        format={(next) => (next === 0 ? 'центр' : next < 0 ? `Л ${-next}` : `П ${next}`)}
      />

      <ToggleSetting
        id="setting-audio-mono"
        label="Моно"
        description="Оба уха слышат одно и то же: удобно с одним наушником, ничего из сведения не теряется."
        checked={audioMono}
        onChange={setAudioMono}
      />

      <div className="divider" role="presentation" />

      {isMobile && (
        <ToggleSetting
          id="setting-mobile-audio-fx"
          label="Обработка звука на телефоне"
          description="Без неё эквалайзер и спектр на телефоне не действуют: звук идёт по ссылке, которую система не пускает в обработку. С ней трек сначала забирается целиком, поэтому начинается на несколько секунд позже, зато полосы работают. Выключение убирает обработку, а играть из файла приложение продолжит до перезапуска."
          checked={mobileAudioFx}
          onChange={setMobileAudioFx}
        />
      )}

      <div className="row-stretch items-baseline justify-between gap-4">
        <div>
          <h3
            className="m-0 text-sm weight-semibold text-primary leading-sm"
          >
            Эквалайзер
          </h3>
          <p
            className="text-xs text-muted leading-xs" style={{ margin: '2px 0 0 0' }}
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
        className="row-stretch wrap gap-2"
      >
        {EQ_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="chip text-xs"
            aria-pressed={activePreset?.id === preset.id}
            title={preset.description}
            onClick={() => setEq(preset.gains)}
            data-testid={`settings-eq-preset-${preset.id}`}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="stack gap-2" data-testid="settings-eq-profiles">
        <p className="m-0 text-xs text-muted leading-xs">Мои</p>
        <div role="group" aria-label="Мои профили эквалайзера" className="row-stretch wrap gap-2">
          {eqProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              className="chip text-xs"
              aria-pressed={activeProfile?.id === profile.id}
              title={profile.deviceId ? 'Включается сам с привязанным устройством' : undefined}
              onClick={() => applyEqProfile(profile.id)}
              data-testid={`settings-eq-profile-${profile.id}`}
            >
              {profile.deviceId && <Headphones size={ICON.xs} aria-hidden="true" />}
              {profile.name}
            </button>
          ))}
          <Button
            variant="ghost"
            size="xs"
            icon={<Plus size={ICON.sm} />}
            onClick={() => setNameModal({ mode: 'save' })}
            data-testid="settings-eq-profile-save"
          >
            Сохранить как профиль…
          </Button>
        </div>

        {activeProfile && (
          <div className="row-stretch wrap gap-2" data-testid="settings-eq-profile-actions">
            <Button
              variant="ghost"
              size="xs"
              icon={<Pencil size={ICON.sm} />}
              onClick={() => setNameModal({ mode: 'rename', id: activeProfile.id })}
              data-testid="settings-eq-profile-rename"
            >
              Переименовать
            </Button>
            {activeProfile.deviceId ? (
              <Button
                variant="ghost"
                size="xs"
                icon={<Link2Off size={ICON.sm} />}
                onClick={() => bindEqProfileToDevice(activeProfile.id, null)}
                data-testid="settings-eq-profile-unbind"
              >
                Отвязать
              </Button>
            ) : (
              canBindDevice &&
              eqOutputDevice && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon={<Link2 size={ICON.sm} />}
                  title={eqOutputDevice.label || undefined}
                  onClick={() => bindEqProfileToDevice(activeProfile.id, eqOutputDevice.deviceId)}
                  data-testid="settings-eq-profile-bind"
                >
                  Привязать к текущему устройству
                </Button>
              )
            )}
            <Button
              variant="ghost"
              size="xs"
              icon={<Trash2 size={ICON.sm} />}
              onClick={() => deleteEqProfile(activeProfile.id)}
              data-testid="settings-eq-profile-delete"
            >
              Удалить
            </Button>
          </div>
        )}

        {devicesHidden && (
          <p className="m-0 text-xs text-muted leading-xs" data-testid="settings-eq-device-note">
            Устройства вывода здесь не видны, поэтому привязать профиль к наушникам нельзя.
          </p>
        )}
      </div>

      <p
        className="m-0 text-xs text-muted leading-xs"
        data-testid="settings-eq-preset-state"
      >
        {eqStateText}
      </p>

      <EqProfileNameModal
        isOpen={nameModal !== null}
        initialName={nameModal?.mode === 'rename' ? eqProfiles.find((p) => p.id === nameModal.id)?.name ?? '' : ''}
        onClose={() => setNameModal(null)}
        onSubmit={(name) => {
          if (!nameModal) return;
          if (nameModal.mode === 'save') saveEqProfile(name);
          else renameEqProfile(nameModal.id, name);
        }}
      />

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
          sleepAtTrackEnd
            ? 'Музыка встанет на паузу, когда доиграет текущий трек.'
            : remainingSeconds !== null
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
            if (raw === 'end') setSleepAtTrackEnd(true);
            else setSleepTimer(raw === '' ? null : Number(raw));
          }}
          data-testid="settings-sleep-timer"
        >
          {SLEEP_OPTIONS.map((option) => (
            <option key={option.label} value={option.minutes === null ? '' : String(option.minutes)}>
              {option.label}
            </option>
          ))}
          <option value="end">До конца трека</option>
        </select>
      </SettingRow>
    </SettingsSection>
  );
};
