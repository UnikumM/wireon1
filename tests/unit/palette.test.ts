import { describe, it, expect } from 'vitest';
import {
  ACCENT_CSS_VARS,
  ACCENT_PRESETS,
  DEFAULT_ACCENT_HEX,
  DEFAULT_ACCENT_ID,
  DEFAULT_THEME_DEPTH,
  THEME_DEPTHS,
  accentForDepth,
  contrastRatio,
  deriveAccentShades,
  hexToHsl,
  hexToRgba,
  hslToHex,
  isThemeDepth,
  normalizeHex,
  pickTextOnAccent,
  relativeLuminance,
  type AccentShades
} from '../../src/styles/palette';

/**
 * Арифметика акцента.
 *
 * Зачем тест. Акцент выбирает пользователь пипеткой, значит ни один оттенок
 * состояния не лежит в таблице — все семь считаются формулой из одного hex.
 * Ошибка в формуле не падает и не мигает: она отдаёт валидный цвет, просто не
 * тот. Наведение, неотличимое от покоя, или белая подпись на пастельном
 * голубом — это молчаливая поломка, которую видно только глазами и только если
 * догадаться проверить именно тот акцент, на котором формула вырождается.
 *
 * Отдельно проверяются края, где формула меняет знак: у почти белого акцента
 * «светлее» упирается в потолок, и там обе ступени обязаны идти вниз.
 */

/** Пресеты плюс краевые случаи, на которых формулы вырождаются. */
const SAMPLE_HEXES = [
  ...ACCENT_PRESETS.map((preset) => preset.hex),
  '#000000',
  '#ffffff',
  '#808080',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ff0022',
  '#2b1b6f',
  '#f2f7ff',
  '#050505',
  '#010203'
];

/** Каналы из `#rrggbb` — тесту нужны те же числа, что и палитре. */
function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `rgba(r, g, b, a)` ровно в том виде, в котором его примет CSS. */
const RGBA = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (?:0|1|0?\.\d+)\)$/;

describe('palette: normalizeHex', () => {
  it('разворачивает короткую форму в полную', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('#000')).toBe('#000000');
    expect(normalizeHex('#fff')).toBe('#ffffff');
  });

  it('принимает запись без решётки — в поле ввода её печатают не всегда', () => {
    expect(normalizeHex('abc')).toBe('#aabbcc');
    expect(normalizeHex('aabbcc')).toBe('#aabbcc');
  });

  it('приводит регистр и срезает пробелы по краям', () => {
    // Вставка из буфера почти всегда приносит и пробел, и верхний регистр.
    expect(normalizeHex('#AABBCC')).toBe('#aabbcc');
    expect(normalizeHex('  #ABC  ')).toBe('#aabbcc');
    expect(normalizeHex('\t8FC7FF\n')).toBe('#8fc7ff');
  });

  it('возвращает null на всём, что цветом не является', () => {
    // Именно null, а не молча подставленный чёрный: решение, что делать с
    // мусором, принимает вызывающий, иначе опечатка в поле выглядит как выбор.
    const garbage: unknown[] = [
      '',
      '   ',
      '#',
      '#gg0000',
      '#abcd',
      '#abcde',
      '#1234567',
      'red',
      'rgb(0,0,0)',
      '#ab',
      null,
      undefined,
      123,
      {},
      []
    ];

    for (const value of garbage) {
      expect(normalizeHex(value as string), `${JSON.stringify(value)} не цвет`).toBeNull();
    }
  });
});

describe('palette: hexToHsl и hslToHex', () => {
  it('круговой обход hex → hsl → hex возвращает цвет с точностью до канала', () => {
    // Допуск честный: HSL считается во float, обратно каналы уходят через
    // Math.round, и расхождение в единицу здесь в принципе допустимо. На этом
    // наборе оно фактически нулевое — но фиксировать в тесте именно ноль
    // означало бы обещать больше, чем даёт арифметика.
    for (const hex of SAMPLE_HEXES) {
      const back = hslToHex(hexToHsl(hex));
      const before = channels(hex);
      const after = channels(back);

      for (let i = 0; i < 3; i += 1) {
        expect(
          Math.abs(before[i] - after[i]),
          `${hex} → hsl → ${back}: канал ${i} уехал больше чем на 1`
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('пресеты обходят круг вообще без потерь', () => {
    // Для готовой палитры расхождения нет ни в одном канале, и это важнее
    // общего допуска: accent в CSS обязан совпадать с тем, что выбрано.
    for (const { id, hex } of ACCENT_PRESETS) {
      expect(hslToHex(hexToHsl(hex)), `пресет ${id} не вернулся после обхода`).toBe(hex);
    }
  });

  it('ахроматические цвета получают нулевую насыщенность', () => {
    // Ветка delta === 0: тона у серого нет, и считать его нечем — деление на
    // ноль дало бы NaN, который дальше расползётся по всем оттенкам.
    for (const [hex, lightness] of [
      ['#000000', 0],
      ['#ffffff', 100],
      ['#808080', 50.19607843137255],
      ['#050505', 1.9607843137254901]
    ] as Array<[string, number]>) {
      const hsl = hexToHsl(hex);
      expect(hsl.s, `${hex} должен быть без насыщенности`).toBe(0);
      expect(hsl.h, `${hex}: тона у серого нет`).toBe(0);
      expect(hsl.l).toBeCloseTo(lightness, 10);
    }
  });

  it('тон считается от того, какой канал взял максимум', () => {
    // Три ветки формулы тона — по одному цвету на каждую, плюс пастель, чтобы
    // ветка выбиралась не только на чистом цвете.
    expect(hexToHsl('#ff0000').h).toBeCloseTo(0, 6);
    expect(hexToHsl('#f7a68f').h).toBeCloseTo(13.269230769230772, 6);

    expect(hexToHsl('#00ff00').h).toBeCloseTo(120, 6);
    expect(hexToHsl('#b4d78f').h).toBeCloseTo(89.16666666666666, 6);

    expect(hexToHsl('#0000ff').h).toBeCloseTo(240, 6);
    expect(hexToHsl('#2b1b6f').h).toBeCloseTo(251.42857142857144, 6);
  });

  it('отрицательный тон у красного с примесью синего доворачивается на +360', () => {
    // Красный максимум и синего больше зелёного — формула даёт −8°, а тон
    // обязан лежать на круге. Без доворота отсюда уехали бы все оттенки
    // состояний: hslToHex получил бы отрицательный h.
    const hsl = hexToHsl('#ff0022');
    expect(hsl.h).toBeCloseTo(352, 6);
    expect(hsl.h).toBeGreaterThan(0);
    expect(hslToHex(hsl)).toBe('#ff0022');
  });

  it('перекрывает все шесть секторов тона', () => {
    // По значению внутри сектора и по обеим его границам: перепутанный знак
    // сравнения в цепочке if сдвинул бы ровно один сектор, и заметно это
    // только на цвете, который в него попал.
    const sectors: Array<[hue: number, hex: string]> = [
      [0, '#ff0000'],
      [30, '#ff8000'],
      [59, '#fffb00'],
      [60, '#ffff00'],
      [90, '#80ff00'],
      [119, '#04ff00'],
      [120, '#00ff00'],
      [150, '#00ff80'],
      [179, '#00fffb'],
      [180, '#00ffff'],
      [210, '#0080ff'],
      [239, '#0004ff'],
      [240, '#0000ff'],
      [270, '#8000ff'],
      [299, '#fb00ff'],
      [300, '#ff00ff'],
      [330, '#ff0080'],
      [359, '#ff0004']
    ];

    for (const [h, expected] of sectors) {
      expect(hslToHex({ h, s: 100, l: 50 }), `тон ${h}°`).toBe(expected);
    }
  });

  it('тон за границами круга приводится к 0..359', () => {
    // Ступени состояний тон не трогают, но в поле настроек значение может
    // прийти любым, а остаток от деления в JS для отрицательных отрицательный.
    expect(hslToHex({ h: 360, s: 100, l: 50 })).toBe('#ff0000');
    expect(hslToHex({ h: 720, s: 100, l: 50 })).toBe('#ff0000');
    expect(hslToHex({ h: -30, s: 100, l: 50 })).toBe('#ff0080');
    expect(hslToHex({ h: -360, s: 100, l: 50 })).toBe('#ff0000');
  });

  it('насыщенность и светлота зажимаются в 0..100', () => {
    // Ступени считаются арифметикой (l ± 7, s × 0.97), поэтому за границы они
    // выходят сами — зажим здесь не защита от кривого ввода, а часть формулы.
    expect(hslToHex({ h: 210, s: 500, l: 50 })).toBe(hslToHex({ h: 210, s: 100, l: 50 }));
    expect(hslToHex({ h: 210, s: -50, l: 50 })).toBe('#808080');
    expect(hslToHex({ h: 210, s: 100, l: 500 })).toBe('#ffffff');
    expect(hslToHex({ h: 210, s: 100, l: -50 })).toBe('#000000');
  });
});

describe('palette: relativeLuminance', () => {
  it('чёрный даёт 0, белый — 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('тёмные каналы идут по линейной ветке, светлые — по гамме', () => {
    // Порог 0.03928 приходится на канал 10: до него разгамировка линейная
    // (делением на 12.92), после — степенная. Обе ветки проверяются на паре
    // соседних значений, иначе одну из них не пройдёт ни один тест.
    expect(relativeLuminance('#050505')).toBeCloseTo(5 / 255 / 12.92, 12);
    expect(relativeLuminance('#0a0a0a')).toBeCloseTo(10 / 255 / 12.92, 12);
    expect(relativeLuminance('#0b0b0b')).toBeCloseTo(((11 / 255 + 0.055) / 1.055) ** 2.4, 12);
    expect(relativeLuminance('#808080')).toBeCloseTo(0.21586050011389923, 12);
  });

  it('серая рампа даёт строго возрастающую яркость', () => {
    const ramp = ['#000000', '#050505', '#0a0a0a', '#0b0b0b', '#404040', '#808080', '#c0c0c0', '#ffffff'];
    const values = ramp.map(relativeLuminance);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i], `${ramp[i]} должен быть ярче ${ramp[i - 1]}`).toBeGreaterThan(values[i - 1]);
    }
  });

  it('зелёный весит больше синего при равной записи', () => {
    // Веса каналов в формуле не равны — на этом и держится выбор подписи:
    // мятный и индиго с одной светлотой в HSL читаются по-разному.
    expect(relativeLuminance('#00ff00')).toBeGreaterThan(relativeLuminance('#0000ff'));
    expect(relativeLuminance('#00ff00')).toBeGreaterThan(relativeLuminance('#ff0000'));
  });
});

describe('palette: contrastRatio', () => {
  it('чёрный к белому даёт 21 — верх шкалы WCAG', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
  });

  it('цвет к себе даёт ровно 1', () => {
    for (const hex of SAMPLE_HEXES) {
      expect(contrastRatio(hex, hex), `${hex} сам с собой`).toBe(1);
    }
  });

  it('не зависит от порядка аргументов', () => {
    // Симметричность не косметика: pickTextOnAccent сравнивает два вызова, и
    // перепутанный светлый со тёмным выбрал бы подпись наоборот.
    for (const hex of SAMPLE_HEXES) {
      expect(contrastRatio(hex, '#ffffff')).toBe(contrastRatio('#ffffff', hex));
      expect(contrastRatio(hex, '#0b0f16')).toBe(contrastRatio('#0b0f16', hex));
    }
  });

  it('держится в пределах шкалы 1..21', () => {
    for (const a of SAMPLE_HEXES) {
      for (const b of SAMPLE_HEXES) {
        const ratio = contrastRatio(a, b);
        expect(ratio, `${a} к ${b}`).toBeGreaterThanOrEqual(1);
        expect(ratio, `${a} к ${b}`).toBeLessThanOrEqual(21);
      }
    }
  });
});

describe('palette: pickTextOnAccent', () => {
  const INK = '#0b0f16';
  const PAPER = '#ffffff';

  it('на пастельном светлом акценте выбирает тёмную подпись', () => {
    expect(pickTextOnAccent('#8fc7ff')).toBe(INK);
    expect(pickTextOnAccent('#ffffff')).toBe(INK);
    expect(pickTextOnAccent('#e8c48f')).toBe(INK);
  });

  it('на тёмном насыщённом акценте выбирает белую подпись', () => {
    expect(pickTextOnAccent('#2b1b6f')).toBe(PAPER);
    expect(pickTextOnAccent('#000000')).toBe(PAPER);
    expect(pickTextOnAccent('#0000ff')).toBe(PAPER);
  });

  it('всегда берёт вариант с большим контрастом', () => {
    // Смысл функции не в пороге, а в выборе лучшего из двух: даже если оба
    // ниже AA, читаемее всё равно тот, у кого контраст выше.
    for (const hex of SAMPLE_HEXES) {
      const chosen = pickTextOnAccent(hex);
      const rejected = chosen === INK ? PAPER : INK;
      expect(
        contrastRatio(hex, chosen),
        `${hex}: выбрана подпись ${chosen}, хотя ${rejected} читается лучше`
      ).toBeGreaterThanOrEqual(contrastRatio(hex, rejected));
    }
  });
});

describe('palette: hexToRgba', () => {
  it('собирает строку в том виде, который принимает CSS', () => {
    expect(hexToRgba('#8fc7ff', 0.14)).toBe('rgba(143, 199, 255, 0.14)');
    expect(hexToRgba('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('раскладывает каналы по порядку r, g, b', () => {
    // Перепутанный сдвиг дал бы подложку другого цвета, но всё ещё валидную —
    // проверяем именно порядок, на цвете, где все три канала разные.
    expect(hexToRgba('#010203', 0.5)).toBe('rgba(1, 2, 3, 0.5)');
    expect(hexToRgba('#ff0022', 0.45)).toBe('rgba(255, 0, 34, 0.45)');
  });

  it('прозрачность уходит как есть и строка проходит формат', () => {
    for (const alpha of [0, 0.14, 0.45, 0.7, 1]) {
      expect(hexToRgba('#8fc7ff', alpha)).toMatch(RGBA);
    }
  });
});

describe('palette: deriveAccentShades', () => {
  it('для каждого пресета заполняет все семь полей', () => {
    for (const { id, hex } of ACCENT_PRESETS) {
      const shades = deriveAccentShades(hex);

      expect(Object.keys(shades).sort(), `пресет ${id}`).toEqual(Object.keys(ACCENT_CSS_VARS).sort());
      expect(shades.accent, `пресет ${id}: accent обязан совпадать с выбором`).toBe(hex);

      for (const key of ['accentHover', 'accentActive'] as const) {
        expect(shades[key], `пресет ${id}: ${key}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      for (const key of ['accentSoft', 'borderAccent', 'ringColor'] as const) {
        expect(shades[key], `пресет ${id}: ${key}`).toMatch(RGBA);
      }
      expect(['#0b0f16', '#ffffff'], `пресет ${id}: textOnAccent`).toContain(shades.textOnAccent);
    }
  });

  it('прозрачность подложки, рамки и обводки различается по возрастанию', () => {
    // Одинаковая альфа у трёх ролей означает, что рамка не видна на подложке —
    // порядок здесь и есть весь смысл трёх разных переменных.
    const shades = deriveAccentShades('#8fc7ff');
    expect(shades.accentSoft).toBe('rgba(143, 199, 255, 0.14)');
    expect(shades.borderAccent).toBe('rgba(143, 199, 255, 0.45)');
    expect(shades.ringColor).toBe('rgba(143, 199, 255, 0.7)');
  });

  it('принимает ненормализованный ввод и нормализует его', () => {
    expect(deriveAccentShades('8FC7FF')).toEqual(deriveAccentShades('#8fc7ff'));
    expect(deriveAccentShades('#ABC')).toEqual(deriveAccentShades('#aabbcc'));
  });

  it('на мусорном вводе откатывается к акценту по умолчанию, а не падает', () => {
    // Значение приходит из настроек на диске: битый JSON или ручная правка не
    // должны оставить приложение без палитры.
    for (const garbage of ['', 'nope', '#gg0000', null, undefined, 42]) {
      const shades = deriveAccentShades(garbage as string);
      expect(shades, `${JSON.stringify(garbage)} должен дать акцент по умолчанию`).toEqual(
        deriveAccentShades(DEFAULT_ACCENT_HEX)
      );
      expect(shades.accent).toBe(DEFAULT_ACCENT_HEX);
    }
  });

  it('у обычного акцента наведение светлее покоя, а нажатие темнее', () => {
    for (const { id, hex } of ACCENT_PRESETS) {
      const shades = deriveAccentShades(hex);
      const rest = hexToHsl(hex).l;
      const hover = hexToHsl(shades.accentHover).l;
      const active = hexToHsl(shades.accentActive).l;

      // Обычная ветка — та, где на шаг хватает места в обе стороны.
      expect(rest + 7, `пресет ${id} должен идти по обычной ветке`).toBeLessThanOrEqual(100);
      expect(rest - 8, `пресет ${id} должен идти по обычной ветке`).toBeGreaterThanOrEqual(0);
      expect(hover, `пресет ${id}: наведение не светлее покоя`).toBeGreaterThan(rest);
      expect(active, `пресет ${id}: нажатие не темнее покоя`).toBeLessThan(rest);
      expect(active, `пресет ${id}: нажатие не темнее наведения`).toBeLessThan(hover);
    }
  });

  it('у почти белого акцента обе ступени идут вниз, а не упираются в потолок', () => {
    // Край, из-за которого в формуле вообще есть ветка: при светлоте 97%
    // «светлее на 7» упёрлось бы в 100, и наведение перестало бы отличаться от
    // покоя — кнопка выглядела бы мёртвой именно на светлой теме.
    const light = '#f2f7ff';
    const shades = deriveAccentShades(light);
    const rest = hexToHsl(light).l;
    const hover = hexToHsl(shades.accentHover).l;
    const active = hexToHsl(shades.accentActive).l;

    expect(rest + 7, 'проверять верхний край смысл имеет только без места на шаг').toBeGreaterThan(100);
    expect(hover, 'наведение обязано уйти вниз, а не в потолок').toBeLessThan(rest);
    expect(active, 'нажатие обязано остаться темнее наведения').toBeLessThan(hover);
    expect(shades.accentHover, 'наведение не должно совпасть с покоем').not.toBe(shades.accent);
    expect(shades.accentActive).not.toBe(shades.accentHover);
  });

  it('у почти чёрного акцента обе ступени идут вверх, а не упираются в пол', () => {
    /*
     * Зеркальный край, и он не теоретический: пипетка принимает `#000000`.
     * Пока страховка была односторонней, затемнение упиралось в ноль и цвет
     * нажатия совпадал с цветом покоя пиксель в пиксель — кнопка не отвечала
     * на нажатие вообще, ровно та поломка, от которой защищает верхняя ветка.
     */
    for (const dark of ['#000000', '#050505']) {
      const shades = deriveAccentShades(dark);
      const rest = hexToHsl(dark).l;
      const hover = hexToHsl(shades.accentHover).l;
      const active = hexToHsl(shades.accentActive).l;

      expect(rest - 8, `${dark}: проверять нижний край смысл имеет только без места на шаг`).toBeLessThan(0);
      expect(hover, `${dark}: наведение обязано уйти вверх, а не в пол`).toBeGreaterThan(rest);
      expect(active, `${dark}: нажатие обязано отличаться от наведения`).toBeGreaterThan(hover);
      expect(shades.accentActive, `${dark}: нажатие слилось с покоем`).not.toBe(shades.accent);
    }
  });

  it('ступени различимы у всех ветвей, включая чистый чёрный и белый', () => {
    for (const hex of ['#8fc7ff', '#2b1b6f', '#f2f7ff', '#ffffff', '#000000']) {
      const shades = deriveAccentShades(hex);
      const steps = new Set([shades.accent, shades.accentHover, shades.accentActive]);
      expect(steps.size, `${hex}: три состояния должны дать три разных цвета`).toBe(3);
    }
  });

  it('шаг светлоты равен заявленным 7 и 8 пунктам', () => {
    // Числа зафиксированы, потому что на них настроено ощущение отклика: шаг в
    // 2 пункта незаметен, шаг в 20 читается как другой цвет.
    //
    // Допуск 0.3 пункта — это цена обратного пути через hex: канал квантуется
    // до 1/255, то есть светлота возвращается ступенями по ~0.196 пункта, и
    // требовать точного совпадения означало бы проверять не формулу, а
    // округление.
    const hex = '#8fc7ff';
    const rest = hexToHsl(hex).l;
    const shades = deriveAccentShades(hex);

    expect(hexToHsl(shades.accentHover).l).toBeGreaterThan(rest + 7 - 0.3);
    expect(hexToHsl(shades.accentHover).l).toBeLessThan(rest + 7 + 0.3);
    expect(hexToHsl(shades.accentActive).l).toBeGreaterThan(rest - 8 - 0.3);
    expect(hexToHsl(shades.accentActive).l).toBeLessThan(rest - 8 + 0.3);
  });

  it('оттенок нажатия сохраняет тон акцента', () => {
    // Осветление и затемнение меняют светлоту, а не тон: уехавший тон означал
    // бы, что при нажатии кнопка меняет цвет, а не яркость.
    //
    // Допуск в 1.5° опять же от квантования hex: у мятного (#8fe0c8) тон после
    // обхода расходится на 0.53°, и это округление, а не сдвиг оттенка —
    // настоящая ошибка в формуле уводила бы тон на десятки градусов.
    for (const { id, hex } of ACCENT_PRESETS) {
      const shades = deriveAccentShades(hex);
      const hue = hexToHsl(hex).h;
      for (const key of ['accentHover', 'accentActive'] as const) {
        expect(
          Math.abs(hexToHsl(shades[key]).h - hue),
          `пресет ${id}: тон ${key} уехал от акцента`
        ).toBeLessThan(1.5);
      }
    }
  });
});

describe('palette: ACCENT_PRESETS', () => {
  it('идентификаторы уникальны', () => {
    // По id акцент сохраняется в настройках; дубль означает, что выбор одного
    // пресета молча восстановится другим.
    const ids = ACCENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size, `дубли среди ${ids.join(', ')}`).toBe(ids.length);
  });

  it('каждый hex уже нормализован', () => {
    // Пресет попадает в CSS напрямую, минуя поле ввода: запись вида `#ABC` не
    // сломает вывод, но accent в переменной разъедется с accent в настройках.
    for (const { id, hex } of ACCENT_PRESETS) {
      expect(normalizeHex(hex), `пресет ${id}: ${hex} записан не в форме #rrggbb`).toBe(hex);
    }
  });

  it('у каждого пресета есть непустая подпись', () => {
    for (const { id, label } of ACCENT_PRESETS) {
      expect(label.trim(), `пресет ${id} без подписи`).not.toBe('');
    }
  });

  it('пресет по умолчанию существует и совпадает с DEFAULT_ACCENT_HEX', () => {
    // DEFAULT_ACCENT_HEX выводится из списка через find с запасным значением:
    // переименуй id — и запасной цвет подставится молча, а настройки начнут
    // ссылаться на пресет, которого в списке нет.
    const preset = ACCENT_PRESETS.find((item) => item.id === DEFAULT_ACCENT_ID);
    expect(preset, `в списке нет пресета ${DEFAULT_ACCENT_ID}`).toBeDefined();
    expect(DEFAULT_ACCENT_HEX).toBe(preset!.hex);
    expect(normalizeHex(DEFAULT_ACCENT_HEX)).toBe(DEFAULT_ACCENT_HEX);
  });
});

describe('palette: THEME_DEPTHS и isThemeDepth', () => {
  it('в списке ровно четыре глубины с уникальными id', () => {
    const ids = THEME_DEPTHS.map((depth) => depth.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size, `дубли среди ${ids.join(', ')}`).toBe(ids.length);
  });

  it('у каждой глубины есть подпись и пояснение', () => {
    for (const depth of THEME_DEPTHS) {
      expect(depth.label.trim(), `${depth.id} без подписи`).not.toBe('');
      expect(depth.description.trim(), `${depth.id} без пояснения`).not.toBe('');
    }
  });

  it('глубина по умолчанию есть в списке', () => {
    expect(THEME_DEPTHS.map((depth) => depth.id)).toContain(DEFAULT_THEME_DEPTH);
  });

  it('isThemeDepth пропускает каждый id из списка', () => {
    // Проверка нужна ровно для того, чтобы значение с диска не разошлось со
    // списком: добавленная глубина без записи в THEME_DEPTHS не пройдёт.
    for (const { id } of THEME_DEPTHS) {
      expect(isThemeDepth(id), `${id} должен опознаваться как глубина`).toBe(true);
    }
  });

  it('isThemeDepth отбивает всё остальное', () => {
    for (const value of ['nope', '', 'Night', ' dusk', null, undefined, 0, 1, {}, [], true]) {
      expect(isThemeDepth(value), `${JSON.stringify(value)} не глубина`).toBe(false);
    }
  });
});

describe('palette: accentForDepth', () => {
  const WHITE = '#ffffff';

  it('в тёмных глубинах отдаёт цвет как есть', () => {
    for (const depth of ['night', 'dusk', 'steel'] as const) {
      expect(accentForDepth('#8fc7ff', depth)).toBe('#8fc7ff');
    }
  });

  it('в светлой теме доводит пастель до контраста AA на белом', () => {
    // Смысл всей функции: акцентом покрашены не только заливки, но и семь
    // десятков надписей и глифов, а пастель на белом даёт около 1.6:1.
    expect(contrastRatio('#8fc7ff', WHITE)).toBeLessThan(4.5);

    const adapted = accentForDepth('#8fc7ff', 'light');

    expect(contrastRatio(adapted, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it('сохраняет тон, а не подменяет цвет', () => {
    const source = hexToHsl('#8fc7ff');
    const adapted = hexToHsl(accentForDepth('#8fc7ff', 'light'));

    expect(Math.abs(adapted.h - source.h)).toBeLessThanOrEqual(1);
    expect(adapted.l).toBeLessThan(source.l);
  });

  it('каждый пресет в светлой теме становится читаемым', () => {
    for (const preset of ACCENT_PRESETS) {
      const adapted = accentForDepth(preset.hex, 'light');
      expect(
        contrastRatio(adapted, WHITE),
        `пресет ${preset.id} остался нечитаемым на белом`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('не зацикливается на белом и на чёрном', () => {
    // Пипетка принимает края шкалы: у белого светлоту надо опускать до самого
    // низа, у чёрного опускать уже некуда.
    expect(contrastRatio(accentForDepth(WHITE, 'light'), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(accentForDepth('#000000', 'light')).toBe('#000000');
  });

  it('мусор заменяет акцентом по умолчанию', () => {
    expect(accentForDepth('не цвет', 'dusk')).toBe(DEFAULT_ACCENT_HEX);
  });
});

describe('palette: ACCENT_CSS_VARS', () => {
  it('перечисляет ровно те же поля, что возвращает deriveAccentShades', () => {
    // Главная проверка файла: добавленный оттенок без имени переменной никуда
    // не уедет, а лишнее имя останется висеть в CSS без значения. Ни то, ни
    // другое не падает — просто элемент красится старым цветом.
    const shades: AccentShades = deriveAccentShades(DEFAULT_ACCENT_HEX);
    expect(Object.keys(ACCENT_CSS_VARS).sort()).toEqual(Object.keys(shades).sort());
  });

  it('все имена начинаются с -- и уникальны', () => {
    const names = Object.values(ACCENT_CSS_VARS);
    for (const [key, name] of Object.entries(ACCENT_CSS_VARS)) {
      expect(name.startsWith('--'), `${key}: ${name} не выглядит как CSS-переменная`).toBe(true);
    }
    expect(new Set(names).size, `две роли пишут в одну переменную: ${names.join(', ')}`).toBe(names.length);
  });
});
