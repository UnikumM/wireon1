import { describe, it, expect, afterEach, vi } from 'vitest';
import '../setup';

import { FakeBroker } from '../helpers/fakeBroker';
import { encodePublish } from '../../src/services/mqttClient';
import {
  isLibrarySignalOnline,
  notifyLibraryChanged,
  startLibrarySignal,
  librarySignalStatus,
  stopLibrarySignal,
  topicForUser
} from '../../src/services/librarySignal';

/**
 * Звонок «медиатека изменилась».
 *
 * Жалоба владельца 2026-09-01: «в спотике всё мгновенно, а у нас даже песни в
 * плейлистах не сходятся». Сверка по расписанию к тому моменту уже работала, но
 * минута ожидания читается как «не работает» — и справедливо.
 *
 * Проверяется здесь не «сообщение отправилось», а то, чем такой звонок ломается:
 * своим же эхом (устройство сверялось бы от собственной правки), расхождением
 * тем между устройствами (звонок молча не доходит никогда) и утечкой — у
 * брокера нет разграничения по темам, а токен приложения лежит внутри APK.
 */

const BROKER = 'ws://брокер.тест/mqtt';

/** Сокет «другого устройства»: сокет открывается через микрозадачу. */
async function connected(broker: FakeBroker) {
  const socket = broker.connect(BROKER);
  await Promise.resolve();
  return socket;
}

afterEach(() => {
  stopLibrarySignal();
  vi.restoreAllMocks();
});

describe('librarySignal: тема', () => {
  it('одна и та же для одной личности и разная для разных', async () => {
    const mine = await topicForUser('discord_111');
    const same = await topicForUser('discord_111');
    const other = await topicForUser('discord_222');

    expect(mine).toBe(same);
    expect(mine).not.toBe(other);
  });

  it('не содержит идентификатора в открытом виде', async () => {
    // Список тем на брокере — это список тех, кто сейчас в сети. По нему не
    // должно читаться, кто именно.
    const topic = await topicForUser('discord_111');
    expect(topic).not.toContain('discord_111');
    expect(topic).toMatch(/^wireon\/lib\/[0-9a-f]+$/);
  });
});

describe('librarySignal: звонок между устройствами', () => {
  it('правка на одном устройстве будит другое', async () => {
    const broker = new FakeBroker();
    const woken = vi.fn();

    // Два устройства одного человека на одном брокере.
    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: woken,
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });
    expect(isLibrarySignalOnline()).toBe(true);

    // Второе устройство — это отдельный сокет с чужим номером устройства:
    // модуль в одном процессе живёт один, поэтому чужую сторону изображаем
    // прямой отправкой в ту же тему.
    const topic = (await topicForUser('discord_777')) as string;
    const other = await connected(broker);
    other.send(encodePublish(topic, JSON.stringify({ device: 'другое_устройство', at: Date.now() })));

    expect(woken).toHaveBeenCalledTimes(1);
  });

  it('своё эхо не будит: мы и так только что отправили', async () => {
    // Брокер возвращает опубликованное и отправителю. Без отсечки по номеру
    // устройства каждая своя правка запускала бы лишнюю сверку — а на пачке
    // правок и вовсе круг «отправил → проснулся → отправил».
    const broker = new FakeBroker();
    const woken = vi.fn();

    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: woken,
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });

    notifyLibraryChanged();

    expect(woken).not.toHaveBeenCalled();
  });

  it('в теме не оказывается ничего, кроме отметки и номера устройства', async () => {
    const broker = new FakeBroker();

    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: vi.fn(),
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });
    notifyLibraryChanged();

    expect(broker.publishes).toHaveLength(1);
    const payload = JSON.parse(broker.publishes[0].payload) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['at', 'device']);
  });

  it('без настроенного брокера молчит, а не падает', async () => {
    // Свой брокер обязателен: тема выводится из личности, и на публичном она
    // была бы видна кому угодно. Нет своего — остаётся сверка по расписанию.
    const started = await startLibrarySignal({ userId: 'discord_777', onNudge: vi.fn(), endpoints: [] });

    expect(started).toBe(false);
    expect(() => notifyLibraryChanged()).not.toThrow();
  });

  it('чужая тема мимо ушей', async () => {
    const broker = new FakeBroker();
    const woken = vi.fn();

    await startLibrarySignal({
      userId: 'discord_777',
      onNudge: woken,
      endpoints: [BROKER],
      socketFactory: (url) => broker.connect(url)
    });

    const stranger = await connected(broker);
    const strangerTopic = (await topicForUser('discord_000')) as string;
    stranger.send(encodePublish(strangerTopic, JSON.stringify({ device: 'чужое', at: Date.now() })));

    expect(woken).not.toHaveBeenCalled();
  });
});

describe('librarySignal: два подключения подряд', () => {
  it('второй запуск не оставляет за собой живой сокет от первого', async () => {
    /*
     * Вход и восстановление сессии зовут подключение один за другим, а между
     * «остановить прежнее» и «подключить новое» есть ожидание — счёт темы. Без
     * номера попытки первый вызов дописывал бы себя поверх второго и оставлял
     * висеть сокет, на который уже никто не смотрит.
     */
    const broker = new FakeBroker();
    const woken = vi.fn();
    const start = () =>
      startLibrarySignal({
        userId: 'discord_777',
        onNudge: woken,
        endpoints: [BROKER],
        socketFactory: (url) => broker.connect(url)
      });

    await Promise.all([start(), start()]);

    const alive = broker.sockets.filter((socket) => socket.readyState === 1);
    expect(alive).toHaveLength(1);

    // И тот, что остался, продолжает слышать чужие правки.
    const topic = (await topicForUser('discord_777')) as string;
    const other = await connected(broker);
    other.send(encodePublish(topic, JSON.stringify({ device: 'другое', at: Date.now() })));
    expect(woken).toHaveBeenCalledTimes(1);
  });
});

describe('librarySignal: почему звонка нет', () => {
  it('незащищённый брокер со страницы по https даже не пробуется', async () => {
    /*
     * Так это и выглядело у владельца: на компьютере «подключено», на телефоне
     * «нет связи». На телефоне страница живёт на `https://localhost`
     * (`androidScheme: 'https'`), а брокер у нас `ws://` — Chromium отказывает
     * **при создании объекта**, до всякой сети. Замерено на устройстве
     * 2026-09-02. Пытаться там незачем, а вот сказать об этом честно — нужно:
     * «нет связи» человек идёт чинить, а чинить тут нечего.
     */
    const broker = new FakeBroker();

    const started = await startLibrarySignal({
      userId: 'discord_777',
      onNudge: vi.fn(),
      endpoints: ['ws://брокер.тест/mqtt'],
      pageProtocol: 'https:',
      socketFactory: (url) => broker.connect(url)
    });

    expect(started).toBe(false);
    expect(librarySignalStatus()).toBe('unsupported');
    // Соединение не открывалось вовсе — ни одного сокета.
    expect(broker.sockets).toHaveLength(0);
  });

  it('защищённый брокер с той же страницы пробуется как обычно', async () => {
    const broker = new FakeBroker();

    const started = await startLibrarySignal({
      userId: 'discord_777',
      onNudge: vi.fn(),
      endpoints: ['wss://брокер.тест/mqtt'],
      pageProtocol: 'https:',
      socketFactory: (url) => broker.connect(url)
    });

    expect(started).toBe(true);
    expect(librarySignalStatus()).toBe('online');
  });

  it('без входа состояние — «ещё не пробовали», а не «нет связи»', () => {
    expect(librarySignalStatus()).toBe('idle');
  });
});
