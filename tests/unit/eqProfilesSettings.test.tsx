/**
 * Блок «Мои» профили эквалайзера в настройках воспроизведения.
 *
 * Суть проверяемого: профиль сохраняется через окно с именем, чип включает его,
 * у активного есть привязка к текущему устройству и удаление, а где устройств
 * не видно — об этом сказано одной строкой и кнопки привязки нет.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../setup';
import { PlaybackSettings } from '../../src/components/settings/PlaybackSettings';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { resetPlayerStore } from '../helpers/testUtils';

const player = () => usePlayerStore.getState();

describe('Настройки: профили эквалайзера', () => {
  beforeEach(() => {
    resetPlayerStore();
    usePlayerStore.setState({
      eqProfiles: [],
      activeEqProfileId: null,
      eqOutputDevice: null,
      eqDeviceSupport: 'unknown'
    });
  });

  it('сохраняет профиль из текущих полос через окно с именем', () => {
    render(<PlaybackSettings />);
    fireEvent.change(screen.getByTestId('setting-eq-bass'), { target: { value: '5' } });

    fireEvent.click(screen.getByTestId('settings-eq-profile-save'));
    fireEvent.change(screen.getByTestId('eq-profile-name-input'), { target: { value: 'Наушники' } });
    fireEvent.click(screen.getByTestId('eq-profile-name-submit'));

    const [profile] = player().eqProfiles;
    expect(profile).toMatchObject({ name: 'Наушники', eq: { bass: 5, mid: 0, treble: 0 } });
    expect(screen.getByTestId(`settings-eq-profile-${profile.id}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('settings-eq-preset-state')).toHaveTextContent('Профиль «Наушники» — без привязки');
  });

  it('пустое имя не сохраняется, окно показывает ошибку', () => {
    render(<PlaybackSettings />);
    fireEvent.click(screen.getByTestId('settings-eq-profile-save'));
    fireEvent.click(screen.getByTestId('eq-profile-name-submit'));

    expect(screen.getByTestId('eq-profile-name-error')).toBeInTheDocument();
    expect(player().eqProfiles).toEqual([]);
  });

  it('чип включает профиль, кнопки у активного: привязать и удалить', () => {
    usePlayerStore.setState({
      eqProfiles: [{ id: 'hp', name: 'Наушники', eq: { bass: 4, mid: 0, treble: 2 }, deviceId: null }],
      eqOutputDevice: { deviceId: 'dev-1', label: 'USB-наушники' },
      eqDeviceSupport: 'available'
    });
    render(<PlaybackSettings />);
    expect(screen.queryByTestId('settings-eq-profile-actions')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-eq-profile-hp'));
    expect(player().eq).toEqual({ bass: 4, mid: 0, treble: 2 });
    expect(player().activeEqProfileId).toBe('hp');

    const actions = within(screen.getByTestId('settings-eq-profile-actions'));
    fireEvent.click(actions.getByTestId('settings-eq-profile-bind'));
    expect(player().eqProfiles[0].deviceId).toBe('dev-1');
    expect(screen.getByTestId('settings-eq-preset-state')).toHaveTextContent('включается с «USB-наушники»');

    // Привязанный — предлагает отвязать, а не привязать ещё раз.
    expect(screen.queryByTestId('settings-eq-profile-bind')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-eq-profile-unbind'));
    expect(player().eqProfiles[0].deviceId).toBeNull();

    fireEvent.click(screen.getByTestId('settings-eq-profile-delete'));
    expect(player().eqProfiles).toEqual([]);
    expect(screen.queryByTestId('settings-eq-profile-hp')).toBeNull();
    // Звук при этом не меняется — удалили запись, а не полосы.
    expect(player().eq).toEqual({ bass: 4, mid: 0, treble: 2 });
  });

  it('переименование через то же окно', () => {
    usePlayerStore.setState({
      eqProfiles: [{ id: 'hp', name: 'Старое', eq: { bass: 0, mid: 0, treble: 0 }, deviceId: null }],
      activeEqProfileId: 'hp'
    });
    render(<PlaybackSettings />);

    fireEvent.click(screen.getByTestId('settings-eq-profile-rename'));
    expect(screen.getByTestId('eq-profile-name-input')).toHaveValue('Старое');
    fireEvent.change(screen.getByTestId('eq-profile-name-input'), { target: { value: 'Новое' } });
    fireEvent.click(screen.getByTestId('eq-profile-name-submit'));

    expect(player().eqProfiles[0].name).toBe('Новое');
    expect(screen.getByTestId('settings-eq-profile-hp')).toHaveTextContent('Новое');
  });

  it('где устройств не видно — строка об этом и нет кнопки привязки', () => {
    usePlayerStore.setState({
      eqProfiles: [{ id: 'hp', name: 'Наушники', eq: { bass: 0, mid: 0, treble: 0 }, deviceId: null }],
      activeEqProfileId: 'hp',
      eqDeviceSupport: 'hidden'
    });
    render(<PlaybackSettings />);

    expect(screen.getByTestId('settings-eq-device-note')).toHaveTextContent('Устройства вывода здесь не видны');
    expect(screen.queryByTestId('settings-eq-profile-bind')).toBeNull();
    expect(screen.getByTestId('settings-eq-profile-delete')).toBeInTheDocument();
  });
});
