import { describe, it, expect } from 'vitest';
import '../setup';

import {
  ARTIST_MISMATCH_PENALTY,
  pickBestMatch,
  rankCandidates,
  scoreCandidate
} from '../../src/services/trackMatching';
import { UnifiedTrack } from '../../src/types/music';

/**
 * Выбор «той самой записи» при импорте плейлиста.
 *
 * Жалоба 2026-09-01: «у некоторых песен одинаковые названия, и оно мне
 * позакидывало не те песни в плейлист — попробуй учесть автора». Автор
 * учитывался и раньше, но несовпадение **ничего не стоило**: оно лишь не
 * прибавляло очков, и кандидат с верным названием и посторонним исполнителем
 * набирал 60 за название плюс 30 за длительность — с запасом выше порога.
 *
 * Проверяется здесь и обратная опасность. Постоянный штраф ломает законное:
 * в чужих выгрузках исполнитель написан латиницей, а на YouTube кириллицей, и
 * общих слов у них ноль.
 */

function track(fields: Partial<UnifiedTrack>): UnifiedTrack {
  return {
    id: fields.id ?? 'x',
    source: fields.source ?? 'youtube',
    originalId: fields.originalId ?? 'x',
    title: fields.title ?? '',
    artist: fields.artist ?? '',
    duration: fields.duration ?? 0,
    artworkUrl: ''
  } as UnifiedTrack;
}

describe('Импорт: выбор записи по исполнителю', () => {
  const target = { title: 'Diamonds Are Forever', artist: 'bbno$', duration: 156 };

  const wrongArtist = track({
    id: 'yt_shirley',
    title: 'Diamonds Are Forever',
    artist: 'Shirley Bassey',
    duration: 156
  });
  const rightArtist = track({
    id: 'sc_bbno',
    source: 'soundcloud',
    title: 'diamonds are forever',
    artist: 'bbno$',
    duration: 156
  });

  it('при одинаковых названиях побеждает тот, у кого сошёлся исполнитель', () => {
    const ranked = rankCandidates(target, [wrongArtist, rightArtist]);
    expect(ranked[0].candidate.id).toBe('sc_bbno');
  });

  it('чужой исполнитель отодвигается, а не просто не прибавляет', () => {
    const alone = scoreCandidate(target, wrongArtist).score;
    const ranked = rankCandidates(target, [wrongArtist, rightArtist]);
    const penalised = ranked.find((entry) => entry.candidate.id === 'yt_shirley')!;

    expect(penalised.score).toBe(alone - ARTIST_MISMATCH_PENALTY);
    expect(penalised.notes).toContain('исполнитель не совпадает');
  });

  it('чужой исполнитель не проходит порог импорта, когда своего нашли', () => {
    // Порог импорта — 62. Молчаливая подмена хуже строки «не нашли уверенного
    // совпадения»: там показывают варианты и дают выбрать руками.
    const best = pickBestMatch(target, [wrongArtist, rightArtist], 62);
    expect(best?.candidate.id).toBe('sc_bbno');

    const onlyWrong = pickBestMatch(target, [wrongArtist], 62);
    expect(onlyWrong?.candidate.id).toBe('yt_shirley');
  });

  it('когда своего исполнителя нет ни у кого, поведение прежнее', () => {
    /*
     * Это защита от собственной починки. «Kino» в выгрузке и «Кино» на YouTube
     * — один и тот же исполнитель, но общих слов у них ноль. Постоянный штраф
     * выбросил бы правильную запись в «не нашли»; относительный молчит, потому
     * что сверить имя не удалось ни с кем.
     */
    const cyrillic = track({
      id: 'yt_kino',
      title: 'Звезда по имени Солнце',
      artist: 'Кино',
      duration: 230
    });
    const best = pickBestMatch(
      { title: 'Звезда по имени Солнце', artist: 'Kino', duration: 230 },
      [cyrillic],
      62
    );

    expect(best?.candidate.id).toBe('yt_kino');
  });

  it('«Various Artists» не считается исполнителем и никого не штрафует', () => {
    // Так подписаны сборники в чужих выгрузках. Совпасть с настоящим именем
    // такая подпись не может никогда, и штраф выбросил бы весь сборник целиком.
    const anyone = track({ id: 'yt_a', title: 'Song One', artist: 'Some Band', duration: 200 });
    const other = track({ id: 'yt_b', title: 'Song One', artist: 'Other Band', duration: 200 });

    const ranked = rankCandidates(
      { title: 'Song One', artist: 'Various Artists', duration: 200 },
      [anyone, other]
    );

    for (const entry of ranked) {
      expect(entry.notes).not.toContain('исполнитель не совпадает');
    }
    expect(pickBestMatch({ title: 'Song One', artist: 'Various Artists', duration: 200 }, [anyone], 62))
      .not.toBeNull();
  });

  it('строка без исполнителя проходит как раньше', () => {
    const anyone = track({ id: 'yt_a', title: 'Song One', artist: 'Some Band', duration: 200 });
    const best = pickBestMatch({ title: 'Song One', duration: 200 }, [anyone], 62);
    expect(best?.candidate.id).toBe('yt_a');
  });
});
