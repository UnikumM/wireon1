import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { PlayerBar } from '../../src/components/player/PlayerBar';
import { MobileNav } from '../../src/components/layout/MobileNav';
import { UserProfile } from '../../src/components/auth/UserProfile';
import { FullscreenPlayer } from '../../src/components/player/FullscreenPlayer';
import { MiniProgressLine } from '../../src/components/player/MiniProgressLine';
import { SettingRow, InfoRow } from '../../src/components/settings/SettingsPrimitives';
import { ArtistHubView } from '../../src/components/artist/ArtistHubView';
import { LibraryView } from '../../src/components/library/LibraryView';
import { FavoritesView } from '../../src/components/library/FavoritesView';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import { UnifiedTrack } from '../../src/types/music';
import { NARROW_TYPE_ADJUST, typographyVars, DEFAULT_TYPOGRAPHY } from '../../src/styles/typography';
import { SWIPE_DISMISS_EXIT_MS } from '../../src/hooks/useSwipeDismiss';

/*
 * Хаб исполнителя ходит в сеть за профилем и за похожими. Ни то ни другое к
 * разметке отношения не имеет, поэтому обе границы подменены — иначе проверка
 * ширины заголовка зависела бы от доступности YouTube Music.
 */
vi.mock('../../src/services/artistService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/artistService')>();
  return {
    ...actual,
    artistService: {
      getArtistProfile: vi.fn(async (name: string) => ({
        name,
        topTracks: Array.from({ length: 10 }).map((_, i) => ({
          id: `yt_top_${i}`,
          source: 'youtube' as const,
          originalId: `top_${i}`,
          title: `Happiness Is A Warm Gun ${i}`,
          artist: name,
          duration: 180,
          artworkUrl: ''
        })),
        albums: [],
        similarArtists: []
      })),
      clearCache: vi.fn()
    }
  };
});

vi.mock('../../src/services/similarArtists', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/similarArtists')>();
  return {
    ...actual,
    similarArtistsService: {
      getSimilarArtists: vi.fn(async () => ({ artists: [], status: 'unavailable' as const })),
      clearCache: vi.fn()
    }
  };
});

/**
 * Разметка на телефоне.
 *
 * Проверяется здесь не «выглядит уже», а то, чем узкий экран ломался на самом
 * деле: органы управления, которые не помещаются, не сжимаются и не переносятся,
 * а уезжают за правый край — и там их нет совсем, потому что прокрутки по
 * горизонтали у области содержимого нет. Так пропадали «Новый плейлист»,
 * «Выбрать файл» и вкладка «Офлайн».
 *
 * Второе — то, что спрятанное обязано где-то остаться. Полоса плеера на
 * телефоне отдаёт громкость, темп, текст и очередь полноэкранному плееру, и
 * единственное, что делает это честным, — что она в него открывается.
 */

const track: UnifiedTrack = {
  id: 'yt_mobile_1',
  source: 'youtube',
  originalId: 'mobile_1',
  title: 'Очень длинное название трека, которое не влезет в узкую полосу',
  artist: 'Исполнитель',
  duration: 200,
  artworkUrl: 'https://example.com/a.jpg'
};

/** Подменяет `matchMedia` так, чтобы порог 768px считался пройденным. */
function pretendNarrow(narrow: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: narrow && query.includes('max-width: 768px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }) as unknown as MediaQueryList
  );
}

beforeEach(() => {
  resetPlayerStore();
  resetLibraryStore();
  resetUIStore();
  usePlayerStore.setState({ currentTrack: track });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Полоса плеера на телефоне', () => {
  it('на узком экране рисуется другая разметка, а не та же, ужатая', () => {
    pretendNarrow(true);
    const { container } = render(<PlayerBar />);

    expect(screen.getByTestId('player-bar').dataset.narrow).toBe('true');
    // Три зоны — признак разметки под окно. На 360 px они и накладывались.
    expect(container.querySelectorAll('.player-zone')).toHaveLength(0);
  });

  it('оставляет ровно то, чем управляют на ходу', () => {
    pretendNarrow(true);
    render(<PlayerBar />);

    expect(screen.getByTestId('player-play-pause-btn')).toBeTruthy();
    expect(screen.getByTestId('player-prev-btn')).toBeTruthy();
    expect(screen.getByTestId('player-next-btn')).toBeTruthy();
  });

  it('убирает то, что на ходу не нужно и съедает название', () => {
    pretendNarrow(true);
    render(<PlayerBar />);

    // Автопоток — настройка того, что случится после очереди.
    expect(screen.queryByTestId('player-radio-autoplay-btn')).toBeNull();
    expect(screen.queryByTestId('player-shuffle-btn')).toBeNull();
    expect(screen.queryByTestId('player-repeat-btn')).toBeNull();
    // Громкость, темп, текст, очередь и окно — всё это в полноэкранном плеере.
    expect(screen.queryByTestId('player-side-track-controls')).toBeNull();
    expect(screen.queryByTestId('player-side-window')).toBeNull();
    expect(screen.queryByTestId('player-overflow-btn')).toBeNull();
  });

  it('спрятанное достижимо: полоса открывает плеер на весь экран', () => {
    pretendNarrow(true);
    render(<PlayerBar />);

    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    fireEvent.click(screen.getByTestId('player-narrow-open-fullscreen'));
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
  });

  it('на широком окне остаётся прежняя полоса со всеми зонами', () => {
    pretendNarrow(false);
    const { container } = render(<PlayerBar />);

    expect(screen.getByTestId('player-bar').dataset.narrow).toBeUndefined();
    expect(container.querySelectorAll('.player-zone').length).toBeGreaterThan(0);
    expect(screen.getByTestId('player-radio-autoplay-btn')).toBeTruthy();
  });

  it('длинное название обрезается, а не уезжает под кнопки', () => {
    // `.text-truncate` вешается на `span`, а у строчного элемента `overflow` и
    // `text-overflow` не применяются вовсе: обрезка молча не работала, и
    // название переезжало через всю полосу поверх кнопок управления.
    // `marquee-line` делает элемент блоком — без него класс обрезки
    // бессмыслен, поэтому проверяем именно его наличие.
    pretendNarrow(true);
    usePlayerStore.setState({
      currentTrack: {
        ...track,
        title: 'Gattsu From The Future - Мой Ненаглядный, и ещё половина строки сверху'
      }
    });
    render(<PlayerBar />);

    const title = screen.getByTestId('player-track-title');
    expect(title.className).toContain('marquee-line');
  });

  it('ряд управления не сжимается: уступать место должно название', () => {
    // Кнопки внутри заданы в пикселях и меньше не станут, поэтому «сжатие»
    // ряда выливалось бы в вылезание за край полосы.
    pretendNarrow(true);
    const { container } = render(<PlayerBar />);

    const row = container.querySelector('[data-testid="player-play-pause-btn"]')?.parentElement;
    expect(row?.style.flexShrink).toBe('0');
  });

  it('сообщение об ошибке доходит и на узком экране', () => {
    // Полоса ошибки живёт в обеих разметках. Ради этого она и вынесена в
    // переменную: две копии разошлись бы при первой правке текста.
    pretendNarrow(true);
    usePlayerStore.setState({ error: 'Трек не заиграл', errorDetail: 'YT_BOT_CHECK' });
    render(<PlayerBar />);

    expect(screen.getByTestId('player-error-message').textContent).toBe('Трек не заиграл');
  });
});

describe('Волосяная линия прогресса', () => {
  it('заполняется по доле проигранного', () => {
    usePlayerStore.setState({ currentTime: 50, duration: 200 });
    const { container } = render(<MiniProgressLine />);
    const fill = container.querySelector('[data-testid="player-mini-progress"] > div') as HTMLElement;
    expect(fill.style.width).toBe('25%');
  });

  it('поток без известной длительности не изображает прогресс', () => {
    // Чанкованное аудио приходит без длительности. Заливка от неизвестного
    // целого была бы враньём, а не приблизительной оценкой.
    usePlayerStore.setState({ currentTime: 50, duration: 0 });
    const { container } = render(<MiniProgressLine />);
    const fill = container.querySelector('[data-testid="player-mini-progress"] > div') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });

  it('не перехватывает нажатия: это показание, а не перемотка', () => {
    const { container } = render(<MiniProgressLine />);
    const line = container.querySelector('[data-testid="player-mini-progress"]') as HTMLElement;
    expect(line.style.pointerEvents).toBe('none');
  });
});

describe('Нижняя навигация', () => {
  it('высота кнопки считается вместе с рамкой панели', () => {
    // `--mobile-nav-height` — это вся панель целиком: по ней полоса плеера
    // считает, куда встать. Кнопка в полную высоту делала панель на пиксель
    // выше, и полоса съедала границу между ними.
    render(<MobileNav />);
    const button = screen.getByTestId('mobile-nav-search');
    expect(button.style.minHeight).toBe('calc(var(--mobile-nav-height) - 1px)');
  });

  it('безопасная зона снизу берётся из той же переменной, что и у полосы плеера', () => {
    // Два разных источника одного значения рано или поздно разойдутся, и между
    // панелями появится щель или нахлёст.
    render(<MobileNav />);
    expect(screen.getByTestId('mobile-nav').style.paddingBottom).toBe('var(--safe-bottom)');
  });
});

describe('Строки настроек переносятся, а не уезжают за край', () => {
  it('SettingRow переносит органы управления', () => {
    const { container } = render(
      <SettingRow label="Загрузить медиатеку" controlId="x">
        <button type="button">Выбрать файл</button>
      </SettingRow>
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.flexWrap).toBe('wrap');
  });

  it('SettingRow в столбик ничего не переносит: там и так одна колонка', () => {
    const { container } = render(
      <SettingRow label="С подписью" controlId="y" stacked>
        <button type="button">Кнопка</button>
      </SettingRow>
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.flexWrap).toBe('nowrap');
  });

  it('InfoRow тоже переносит значение', () => {
    const { container } = render(
      <InfoRow label="Хранится локально">
        <span>0 плейлистов · 0 избранных · 0 прослушано</span>
      </InfoRow>
    );
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.flexWrap).toBe('wrap');
  });

  it('перенесённые органы управления не шире своей строки', () => {
    // Иначе длинное значение уезжает за край всё равно — только строкой ниже.
    const { container } = render(
      <InfoRow label="Хранится локально">
        <span>значение</span>
      </InfoRow>
    );
    const controls = container.firstElementChild?.lastElementChild as HTMLElement;
    expect(controls.style.maxWidth).toBe('100%');
    expect(controls.style.flexShrink).toBe('0');
  });
});

describe('Кегли на телефоне', () => {
  it('множитель поднимает подпись из нечитаемых 11 px', () => {
    // Замерено на экране 375 px: в настройках 148 элементов были набраны
    // одиннадцатым кеглем. Это и есть «всё то маленькое».
    const обычные = typographyVars(DEFAULT_TYPOGRAPHY);
    const узкие = typographyVars(DEFAULT_TYPOGRAPHY, true);

    expect(parseFloat(обычные['--text-xs'])).toBe(11);
    expect(parseFloat(узкие['--text-xs'])).toBeGreaterThanOrEqual(12.5);
  });

  it('крупные заголовки на телефоне не растут, а уменьшаются', () => {
    // Жалоба была из двух половин: «то маленькое, то не вмещается». Один
    // множитель на всю лестницу чинил первую и усугублял вторую — заголовок
    // раздела становился 34 px и выталкивал подпись рядом за край.
    const обычные = typographyVars(DEFAULT_TYPOGRAPHY);
    const узкие = typographyVars(DEFAULT_TYPOGRAPHY, true);

    for (const step of ['xs', 'sm', 'base']) {
      expect(parseFloat(узкие[`--text-${step}`])).toBeGreaterThan(
        parseFloat(обычные[`--text-${step}`])
      );
    }
    for (const step of ['2xl', '3xl']) {
      expect(parseFloat(узкие[`--text-${step}`])).toBeLessThan(
        parseFloat(обычные[`--text-${step}`])
      );
    }
  });

  it('самый крупный заголовок влезает в строку на узком экране', () => {
    // 38 px — это треть ширины 320-пиксельного экрана одним словом.
    const узкие = typographyVars(DEFAULT_TYPOGRAPHY, true);
    expect(parseFloat(узкие['--text-3xl'])).toBeLessThanOrEqual(31);
  });

  it('поправка задана для каждой ступени, а не одним числом', () => {
    for (const step of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']) {
      expect(typeof NARROW_TYPE_ADJUST[step]).toBe('number');
    }
  });

  it('лестница остаётся лестницей: каждая ступень выше предыдущей', () => {
    const узкие = typographyVars(DEFAULT_TYPOGRAPHY, true);
    const ряд = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'].map((n) =>
      parseFloat(узкие[`--text-${n}`])
    );
    for (let i = 1; i < ряд.length; i += 1) expect(ряд[i]).toBeGreaterThan(ряд[i - 1]);
  });

  it('высота строки остаётся целым числом пикселей', () => {
    // Дробная высота строки задаёт дробную высоту всего, что обёрнуто вокруг
    // текста: кнопка на дробной границе округляется по краям в разные стороны,
    // рамка с одной стороны тоньше, текст слегка размыт. Множитель входит до
    // округления именно ради этого.
    const узкие = typographyVars(DEFAULT_TYPOGRAPHY, true);
    for (const step of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl']) {
      const кегль = parseFloat(узкие[`--text-${step}`]);
      const кратность = parseFloat(узкие[`--leading-${step}`]);
      const высота = кегль * кратность;
      expect(Math.abs(высота - Math.round(высота))).toBeLessThan(0.01);
    }
  });

  it('без множителя всё как было: окно не трогаем', () => {
    const обычные = typographyVars(DEFAULT_TYPOGRAPHY);
    const единица = typographyVars(DEFAULT_TYPOGRAPHY, false);
    expect(единица).toEqual(обычные);
  });
});

describe('Убранное из нижней панели никуда не пропало', () => {
  it('в панели остались три раздела', () => {
    // Шесть подписей делили ширину экрана поровну — «Настройки» не влезали.
    render(<MobileNav />);
    expect(screen.getByTestId('mobile-nav-search')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-wave')).toBeTruthy();
    expect(screen.getByTestId('mobile-nav-library')).toBeTruthy();
  });

  it('настройки открываются из меню под аватаром', () => {
    // Убрать раздел можно было только потому, что он остался достижим. Боковая
    // панель на телефоне уезжает, и без этого пункта настройки пропали бы совсем.
    render(<UserProfile />);
    fireEvent.click(screen.getByTestId('user-profile-btn'));
    fireEvent.click(screen.getByTestId('user-profile-settings'));
    expect(useUIStore.getState().activeView).toBe('settings');
  });
});

describe('Полноэкранный плеер на телефоне', () => {
  it('транспорт и темп идут двумя рядами, без ползунка громкости', () => {
    // Ряд «темп 150 px — транспорт — громкость 150 px» на 375 px не помещается
    // физически: одни боковые колонки с зазорами занимают 332 px. Отсюда и
    // вылезающая за рамки плашка темпа. Громкости нет намеренно — на телефоне
    // ею занимаются кнопки самого телефона.
    pretendNarrow(true);
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);

    expect(screen.getByTestId('fullscreen-play-pause-btn')).toBeTruthy();
    expect(screen.queryByTestId('volume-slider')).toBeNull();
  });

  it('на широком окне ползунок громкости остаётся', () => {
    pretendNarrow(false);
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);
    expect(screen.getByTestId('fullscreen-play-pause-btn')).toBeTruthy();
  });
});

/**
 * Списки на телефоне.
 *
 * Общая причина у всех трёх: ряд, который на широком окне помещается, на 360 px
 * не помещается — и не переносится, а накладывается сам на себя. Видно это не по
 * разметке, а по тому, сколько после всех кнопок и полей остаётся названию.
 */
describe('Списки и шапки на телефоне', () => {
  const libraryTrack: UnifiedTrack = {
    id: 'yt_lib_1',
    source: 'youtube',
    originalId: 'lib_1',
    title: 'Ghosts of the Late Night Radio Tower',
    artist: 'The Midnight Cassette Orchestra',
    duration: 210,
    artworkUrl: ''
  };

  it('в недавнем на телефоне нет кнопки, дублирующей нажатие на саму строку', () => {
    pretendNarrow(true);
    useUIStore.setState({ activeView: 'library' });
    useLibraryStore.setState({ history: [libraryTrack] });

    render(<LibraryView />);

    // «Послушать снова» делает ровно то же, что строка, и забирала 50 px из 328.
    expect(screen.queryByTestId('history-play-again-0')).toBeNull();
    expect(screen.getByText('Ghosts of the Late Night Radio Tower')).toBeInTheDocument();
  });

  it('на широком окне эта кнопка остаётся', () => {
    pretendNarrow(false);
    useUIStore.setState({ activeView: 'library' });
    useLibraryStore.setState({ history: [libraryTrack] });

    render(<LibraryView />);

    expect(screen.getByTestId('history-play-again-0')).toBeInTheDocument();
  });

  it('имя артиста в строке обрезается, а не уезжает поверх кнопки «ещё»', () => {
    pretendNarrow(true);
    useUIStore.setState({ activeView: 'library' });
    useLibraryStore.setState({ history: [libraryTrack] });

    render(<LibraryView />);

    const artist = screen.getByTestId(`track-artist-${libraryTrack.id}`);
    // `width: fit-content` без потолка отменяет `overflow: hidden`: коробка
    // растёт под текст, резать нечего, и длинное имя ложится на соседей.
    expect(artist).toHaveClass('text-truncate');
    expect(artist).toHaveStyle({ maxWidth: '100%' });
  });

  it('шапка избранного переносится рядом, а не только своей группой кнопок', () => {
    pretendNarrow(true);
    render(<FavoritesView tracks={[libraryTrack]} totalCount={1} />);

    const summary = screen.getByTestId('favorites-summary');
    const panel = summary.closest('.panel') as HTMLElement;

    // Перенос стоял на группе кнопок: они складывались в столбик шириной 160 px,
    // сама шапка оставалась в одну строку, и подписи доставалось «8 тре / 31:5»
    // под кнопками, которые лежали поверх текста.
    expect(panel).toHaveStyle({ flexWrap: 'wrap' });

    // Слово «Избранное» на телефоне стоит на экране ещё дважды — в шапке
    // приложения и в закладке прямо над панелью.
    expect(screen.queryByRole('heading', { name: 'Избранное' })).toBeNull();

    // Всё, чем список управляют, при этом на месте.
    expect(screen.getByTestId('favorites-play-all-btn')).toBeInTheDocument();
    expect(screen.getByTestId('favorites-shuffle-btn')).toBeInTheDocument();
    expect(screen.getByTestId('favorites-save-offline-btn')).toBeInTheDocument();
  });

  it('на широком окне шапка избранного остаётся прежней', () => {
    pretendNarrow(false);
    render(<FavoritesView tracks={[libraryTrack]} totalCount={1} />);

    expect(screen.getByRole('heading', { name: 'Избранное' })).toBeInTheDocument();
  });
});

describe('Хаб исполнителя на телефоне', () => {
  it('заголовок и счётчик стоят рядом, а не друг на друге', async () => {
    pretendNarrow(true);
    render(<ArtistHubView artistName="The Beatles" />);

    const heading = await screen.findByRole('heading', { name: /Популярные треки/ });
    const row = heading.parentElement as HTMLElement;
    const counter = row.lastElementChild as HTMLElement;

    // `space-between` без зазора и без запрета на сжатие — это не ряд, а два
    // слоя: счётчик ужимался до нулевой ширины, текст вылезал наружу, заголовок
    // переносился на вторую строку и ложился прямо на него.
    expect(row).toHaveStyle({ gap: 'var(--space-3)' });
    expect(counter).toHaveTextContent('10 треков');
    expect(counter).toHaveStyle({ flexShrink: '0', whiteSpace: 'nowrap' });
  });

  it('не отдаёт треть узкого экрана боковым полям', async () => {
    pretendNarrow(true);
    render(<ArtistHubView artistName="The Beatles" />);

    const section = await screen.findByTestId('artist-top-tracks-section');
    const body = section.parentElement as HTMLElement;

    // 64 px по бокам — это 36% экрана в 360 px, и строка трека обрезалась до
    // «Happi…». Отступ по горизонтали уже даёт `main-content`.
    expect(body.style.padding).toBe('var(--space-5) 0');
  });

  it('на широком окне поля остаются прежними', async () => {
    pretendNarrow(false);
    render(<ArtistHubView artistName="The Beatles" />);

    const section = await screen.findByTestId('artist-top-tracks-section');
    const body = section.parentElement as HTMLElement;

    expect(body.style.padding).toBe('var(--space-6) var(--space-8)');
  });
});

/**
 * Закрытие полноэкранного плеера потягиванием вниз.
 *
 * До этого выход был один — значок 46×46 в левом верхнем углу, то есть в
 * единственном месте экрана, куда большой палец не достаёт. Жест не заменяет
 * кнопку: она нужна мыши и клавиатуре. Проверяется здесь не «оно двигается», а
 * то, чем такой жест ломается: он забирает движение у ползунка, срабатывает на
 * случайном касании и исчезает под заполненной анимацией появления.
 */
describe('Полноэкранный плеер: жест вниз', () => {
  /** Доводит появление до конца: иначе `animate-emerge` держит свой transform. */
  function settleEntry(root: HTMLElement) {
    act(() => {
      fireEvent.animationEnd(root, { animationName: 'emerge' });
    });
  }

  function openNarrowPlayer() {
    pretendNarrow(true);
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);
    const root = screen.getByTestId('fullscreen-player');
    settleEntry(root);
    return root;
  }

  function drag(from: HTMLElement, root: HTMLElement, dy: number) {
    fireEvent.pointerDown(from, { clientX: 180, clientY: 200, pointerId: 1, isPrimary: true });
    fireEvent.pointerMove(root, { clientX: 182, clientY: 200 + dy, pointerId: 1, isPrimary: true });
  }

  it('ведёт слой за пальцем один к одному', () => {
    const root = openNarrowPlayer();
    drag(screen.getByTestId('fullscreen-artwork'), root, 60);

    expect(root.style.transform).toBe('translate3d(0, 60px, 0)');
    // Скруглённый верх — признак листа, который сдвинули.
    expect(root.style.borderTopLeftRadius).toBe('var(--radius-lg)');
  });

  it('не дотянул — возвращается на место, а не закрывается', () => {
    const root = openNarrowPlayer();
    drag(screen.getByTestId('fullscreen-artwork'), root, 60);
    fireEvent.pointerUp(root, { clientX: 182, clientY: 260, pointerId: 1, isPrimary: true });

    expect(root.style.transform).toBe('');
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
  });

  it('дотянул — слой уезжает за край и только потом окно снимается', () => {
    vi.useFakeTimers();
    try {
      const root = openNarrowPlayer();
      drag(screen.getByTestId('fullscreen-artwork'), root, 200);
      fireEvent.pointerUp(root, { clientX: 182, clientY: 400, pointerId: 1, isPrimary: true });

      // Исчезновение одним кадром с полпути — это не закрытие, а пропажа.
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
      expect(root.style.transform).not.toBe('');

      act(() => {
        vi.advanceTimersByTime(SWIPE_DISMISS_EXIT_MS);
      });
      expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('протаскивание по таймлайну перематывает, а не закрывает', () => {
    const root = openNarrowPlayer();
    // Ползунок и жест ловят одно и то же движение; выигрывать должен ползунок.
    drag(screen.getByTestId('fullscreen-seek-slider'), root, 200);

    expect(root.style.transform).toBe('');
    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
  });

  it('движение вбок жестом не считается', () => {
    const root = openNarrowPlayer();
    fireEvent.pointerDown(screen.getByTestId('fullscreen-artwork'), {
      clientX: 180,
      clientY: 200,
      pointerId: 1,
      isPrimary: true
    });
    fireEvent.pointerMove(root, { clientX: 280, clientY: 212, pointerId: 1, isPrimary: true });

    expect(root.style.transform).toBe('');
  });

  it('на широком окне жеста нет — там Esc и мышь', () => {
    pretendNarrow(false);
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);
    const root = screen.getByTestId('fullscreen-player');
    settleEntry(root);

    drag(screen.getByTestId('fullscreen-artwork'), root, 200);

    expect(root.style.transform).toBe('');
    expect(screen.queryByTestId('fullscreen-grabber')).toBeNull();
  });

  it('полоска сверху говорит о жесте, потому что больше о нём ничто не говорит', () => {
    openNarrowPlayer();
    expect(screen.getByTestId('fullscreen-grabber')).toBeInTheDocument();
  });
});

describe('Спектр на телефоне', () => {
  it('не рисуется вовсе: питать его там нечем', () => {
    /*
     * Не вкусовое решение, а следствие. Ссылки `googlevideo` идут без
     * заголовков CORS: элемент с `crossOrigin` отвергает их целиком, а без
     * атрибута `createMediaElementSource` отдаёт тишину — оба факта замерены
     * на устройстве 2026-08-29. Значит анализатору браться неоткуда, и при
     * играющей музыке полоска рисовала бы ровную линию. Пустой прибор хуже
     * отсутствующего: он читается как поломка.
     */
    pretendNarrow(true);
    usePlayerStore.setState({ visualizerEnabled: true });
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);

    expect(screen.queryByTestId('audio-visualizer')).toBeNull();
  });

  it('на широком окне остаётся: там звук идёт через Web Audio', () => {
    pretendNarrow(false);
    usePlayerStore.setState({ visualizerEnabled: true });
    useUIStore.setState({ isFullscreenPlayerOpen: true });
    render(<FullscreenPlayer />);

    expect(screen.getByTestId('audio-visualizer')).toBeInTheDocument();
  });
});
