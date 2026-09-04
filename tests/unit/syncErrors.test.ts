import { describe, it, expect } from 'vitest';
import { describeSyncError } from '../../src/services/syncErrors';

/**
 * Пересказ отказа синхронизации.
 *
 * Появился из снимка, который прислал владелец: в меню аккаунта, там где должно
 * стоять состояние медиатеки, дважды подряд было написано «Failed to fetch».
 * Это сообщение браузера, а не наше, и оно одинаково при выключенном сервере,
 * пропавшем интернете и запрете источнику — то есть не говорит ничего.
 */
describe('describeSyncError', () => {
  it('называет недоступный сервер и оставляет исходную строку для отчёта', () => {
    const notice = describeSyncError(
      'WIREON_SYNC_UNREACHABLE: не удалось связаться с сервером Wireon (Failed to fetch)'
    );

    expect(notice?.message).toMatch(/Сервер Wireon не отвечает/);
    expect(notice?.message).not.toMatch(/Failed to fetch/);
    expect(notice?.detail).toMatch(/Failed to fetch/);
  });

  it('ловит слова браузера и там, где кода не оказалось', () => {
    // Отказ может прилететь мимо нашего пересказа — например, с другого слоя.
    expect(describeSyncError('TypeError: Failed to fetch')?.message).toMatch(/не отвечает/);
    expect(describeSyncError('NetworkError when attempting to fetch')?.message).toMatch(/оборвалась/);
  });

  it('про истёкшую сессию говорит, что делать', () => {
    expect(describeSyncError('HTTP_401: сервер ответил 401')?.message).toMatch(/Войдите заново/);
    expect(describeSyncError('unauthorized')?.message).toMatch(/Войдите заново/);
  });

  it('незнакомый код показывает то, что сервер написал после него', () => {
    expect(describeSyncError('WIREON_SYNC_WEIRD: база на замке')?.message).toBe('база на замке');
  });

  it('пустой отказ означает, что отказа не было', () => {
    expect(describeSyncError(null)).toBeNull();
    expect(describeSyncError('   ')).toBeNull();
  });
});
