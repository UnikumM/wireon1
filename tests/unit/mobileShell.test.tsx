import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { MobileNavBar } from '../../src/components/mobile/MobileNavBar';
import { MobilePlayerBar } from '../../src/components/mobile/MobilePlayerBar';
import { TrackRow } from '../../src/components/mobile/TrackRow';
import { TrackActionsSheet } from '../../src/components/mobile/TrackActionsSheet';
import { Sheet, SheetRow } from '../../src/components/mobile/Sheet';
import { MobileSettingsView } from '../../src/components/mobile/MobileSettingsView';
import { MobileFullscreenPlayer } from '../../src/components/mobile/MobileFullscreenPlayer';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { useUIStore } from '../../src/store/useUIStore';
import { resetPlayerStore, resetLibraryStore, resetUIStore } from '../helpers/testUtils';
import { LONG_PRESS_MS } from '../../src/hooks/useLongPress';
import type { UnifiedTrack } from '../../src/types/music';

/**
 * Телефонная оболочка.
 *
 * Проверяется не «компонент отрисовался», а то, чем этот интерфейс ломался
 * раньше и чем сломается снова, если кто-то будет невнимателен:
 *
 * - действия над треком жили внутри прокручиваемого списка и обрезались им;
 * - до «Для вас» с телефона было не добраться: раздела не было в панели;
 * - у кнопок нижней панели не было имён для чтения с экрана;
 * - единственным входом в действия была кнопка 32x32 в углу строки.
 */

const track: UnifiedTrack = {
  id: 'yt_1',
  source: 'youtube',
  originalId: 'abc',
  title: 'Ghosts of the Late Night Radio Tower',
  artist: 'The Midnight Cassette Orchestra',
  duration: 240,
  artworkUrl: '',
  sourceUrl: 'https://youtube.com/watch?v=abc'
};

beforeEach(() => {
  resetPlayerStore();
  resetLibraryStore();
  resetUIStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Нижняя панель', () => {
  it('ведёт на Главную, Поиск и Медиатеку', () => {
    render(<MobileNavBar />);
    expect(screen.getByTestId('mobile-nav-home')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-nav-search')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-nav-library')).toBeInTheDocument();
  });

  it('у каждой кнопки есть имя для чтения с экрана', () => {
    // В прежней панели подпись была нарисована текстом, но `aria-label` не было
    // ни у одной кнопки: в дереве доступности они выглядели просто «кнопка».
    render(<MobileNavBar />);
    for (const label of ['Главная', 'Поиск', 'Медиатека']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('Поток считается Главной: карточка запуска живёт там', () => {
    useUIStore.setState({ activeView: 'wave' });
    render(<MobileNavBar />);
    expect(screen.getByTestId('mobile-nav-home')).toHaveAttribute('aria-current', 'page');
  });

  it('вкладки медиатеки не гасят выбранный раздел', () => {
    // Избранное, плейлисты и офлайн — это маршруты внутри Медиатеки. Пока они
    // выводились из `activeView` напрямую, вкладка гасла на каждом из них.
    for (const view of ['favorites', 'playlists', 'offline', 'playlist'] as const) {
      useUIStore.setState({ activeView: view });
      const { unmount } = render(<MobileNavBar />);
      expect(screen.getByTestId('mobile-nav-library')).toHaveAttribute('aria-current', 'page');
      unmount();
    }
  });
});

describe('Полоса плеера', () => {
  it('пустая полоса не рисуется вовсе', () => {
    // Прежняя показывала «Ничего не играет» с переносом на две строки и
    // мёртвыми кнопками — занимала место, отвечая на незаданный вопрос.
    const { container } = render(<MobilePlayerBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('нажатие на плашку открывает плеер, а не играет заново', () => {
    usePlayerStore.setState({ currentTrack: track });
    render(<MobilePlayerBar />);

    fireEvent.click(screen.getByTestId('mobile-player-open-fullscreen'));

    expect(useUIStore.getState().isFullscreenPlayerOpen).toBe(true);
  });

  it('в узком окне ПК возвращаются перемотка, соседние треки и громкость', () => {
    /*
     * Телефонный вид включается и в узком окне на ПК — так и задумано. Но там у
     * человека мышь, и пропажа громкости с перемоткой была потерей, а не
     * упрощением. Решает не устройство, а место: полоса смотрит на собственную
     * ширину.
     *
     * Замер идёт синхронно при появлении, а не только по `ResizeObserver`: тот
     * сообщает об изменении, и первое сообщение приходит не всегда — в фоновой
     * вкладке его доставка привязана к отрисовке. Здесь это и проверяется:
     * наблюдателя в jsdom нет вовсе.
     */
    usePlayerStore.setState({ currentTrack: track });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 684,
      height: 86,
      top: 0,
      left: 0,
      right: 684,
      bottom: 86,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    render(<MobilePlayerBar />);

    expect(screen.getByTestId('mobile-player-prev')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-player-next')).toBeInTheDocument();
    expect(screen.getByLabelText('Предыдущий трек')).toBeInTheDocument();
  });

  it('в полосе одна кнопка воспроизведения, без соседей', () => {
    // Были «предыдущий», «играть» и «следующий» разного веса: на 360 px они
    // забирали 130 px у названия трека.
    usePlayerStore.setState({ currentTrack: track });
    // Ширина телефона: здесь соседи и правда лишние.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 344,
      height: 58,
      top: 0,
      left: 0,
      right: 344,
      bottom: 58,
      x: 0,
      y: 0,
      toJSON: () => ({})
    } as DOMRect);

    render(<MobilePlayerBar />);

    expect(screen.getByTestId('mobile-player-play-pause')).toBeInTheDocument();
    expect(screen.queryByLabelText('Следующий трек')).toBeNull();
    expect(screen.queryByLabelText('Предыдущий трек')).toBeNull();
  });
});

describe('Строка трека', () => {
  it('нажатие играет, а кнопка «ещё» открывает действия', () => {
    const onPlay = vi.fn();
    const onOpenActions = vi.fn();
    render(<TrackRow track={track} onPlay={onPlay} onOpenActions={onOpenActions} data-testid="row" />);

    fireEvent.click(screen.getByTestId('row-play'));
    expect(onPlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('row-actions'));
    expect(onOpenActions).toHaveBeenCalledTimes(1);
  });

  it('долгое нажатие открывает действия и не запускает трек', () => {
    /*
     * Мишень. Прежде единственным входом в действия была кнопка 32x32 в правом
     * углу строки — худшая точка экрана для большого пальца. Долгое нажатие
     * делает мишенью строку целиком, и отпускание после него не должно вдобавок
     * включить музыку: человек просил действия, а не воспроизведение.
     */
    vi.useFakeTimers();
    const onPlay = vi.fn();
    const onOpenActions = vi.fn();
    render(<TrackRow track={track} onPlay={onPlay} onOpenActions={onOpenActions} data-testid="row" />);

    const hit = screen.getByTestId('row-play');
    fireEvent.pointerDown(hit, { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    fireEvent.click(hit);

    expect(onOpenActions).toHaveBeenCalledTimes(1);
    expect(onPlay).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('мышь долгим нажатием меню не открывает', () => {
    // На ПК это была бы просто задержка перед кликом, и меню, всплывающее само,
    // читалось бы как сбой.
    vi.useFakeTimers();
    const onOpenActions = vi.fn();
    render(<TrackRow track={track} onPlay={vi.fn()} onOpenActions={onOpenActions} data-testid="row" />);

    fireEvent.pointerDown(screen.getByTestId('row-play'), {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    });

    expect(onOpenActions).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('прокрутка отменяет долгое нажатие', () => {
    // Палец, уехавший на полсотни пикселей, листает список, а не удерживает
    // строку. Без отмены меню выскакивало бы посреди прокрутки.
    vi.useFakeTimers();
    const onOpenActions = vi.fn();
    render(<TrackRow track={track} onPlay={vi.fn()} onOpenActions={onOpenActions} data-testid="row" />);

    const hit = screen.getByTestId('row-play');
    fireEvent.pointerDown(hit, { pointerId: 1, isPrimary: true, pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 10, clientY: 90 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });

    expect(onOpenActions).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('Лист снизу', () => {
  it('закрытого листа в разметке нет', () => {
    const { container } = render(
      <Sheet isOpen={false} onClose={vi.fn()} title="Заголовок" data-testid="s">
        <SheetRow icon={null} label="Пункт" onClick={vi.fn()} />
      </Sheet>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('высота считается от --app-height, а не от 100vh', () => {
    /*
     * На телефоне адресная строка то появляется, то исчезает, и `100vh` больше
     * настоящего экрана — низ листа оказался бы под краем. Проект специально
     * завёл `--app-height` (`100dvh`) ради этого случая.
     */
    render(
      <Sheet isOpen onClose={vi.fn()} title="Заголовок" data-testid="s">
        <SheetRow icon={null} label="Пункт" onClick={vi.fn()} />
      </Sheet>
    );
    expect(screen.getByTestId('s').style.maxHeight).toContain('var(--app-height)');
  });

  it('нижний отступ учитывает безопасную зону', () => {
    render(
      <Sheet isOpen onClose={vi.fn()} title="Заголовок" data-testid="s">
        <SheetRow icon={null} label="Пункт" onClick={vi.fn()} />
      </Sheet>
    );
    const scroller = screen.getByTestId('s').querySelector('.scrollbar-thin') as HTMLElement;
    expect(scroller.style.paddingBottom).toContain('var(--safe-bottom)');
  });
});

describe('Действия над треком', () => {
  it('без трека лист не рисуется', () => {
    const { container } = render(<TrackActionsSheet track={null} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('радио по треку доступно прямо из списка', () => {
    // «Бесконечный поток похожих песен», о котором спрашивал владелец: раньше
    // пункт назывался «Запустить радио по треку» и жил в обрезаемом меню.
    render(<TrackActionsSheet track={track} onClose={vi.fn()} />);
    expect(screen.getByTestId('track-actions-radio')).toBeInTheDocument();
  });

  it('плейлисты уходят во второй лист, а не в первый', () => {
    /*
     * В прежнем меню весь список плейлистов сыпался внутрь того же блока:
     * высота зависела от того, сколько их у человека, и при десятке внутри
     * обрезанного меню появлялась ещё и своя прокрутка.
     */
    render(<TrackActionsSheet track={track} onClose={vi.fn()} />);

    expect(screen.queryByTestId('track-playlists-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('track-actions-playlists'));
    expect(screen.getByTestId('track-playlists-sheet')).toBeInTheDocument();
    // Первый лист при этом уходит: два листа разом — это два слоя поверх экрана.
    expect(screen.queryByTestId('track-actions-sheet')).toBeNull();
  });

  it('пункт источника появляется только когда есть ссылка', () => {
    const { unmount } = render(<TrackActionsSheet track={track} onClose={vi.fn()} />);
    expect(screen.getByTestId('track-actions-source')).toBeInTheDocument();
    unmount();

    render(<TrackActionsSheet track={{ ...track, sourceUrl: undefined }} onClose={vi.fn()} />);
    expect(screen.queryByTestId('track-actions-source')).toBeNull();
  });

  it('скачивание доступно из листа', () => {
    /*
     * Сохранить трек на устройство приложение умело с самого начала, но позвать
     * это было неоткуда: `downloadTrack` вызывал только фоновый режим, который
     * кэширует прослушанное сам. То есть «скачать эту песню перед дорогой»
     * сделать было нельзя ни одним нажатием.
     */
    render(<TrackActionsSheet track={track} onClose={vi.fn()} />);
    expect(screen.getByTestId('track-actions-download')).toBeInTheDocument();
  });

  it('«Играть следующим» ставит трек в очередь и закрывает лист', () => {
    const onClose = vi.fn();
    render(<TrackActionsSheet track={track} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('track-actions-play-next'));

    expect(usePlayerStore.getState().userQueue.map((t) => t.id)).toContain('yt_1');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Настройки', () => {
  it('разделы идут списком, а не полосой плашек', () => {
    /*
     * Девять плашек-пилюль не помещались в 328 px и переносились в четыре ряда,
     * занимая половину экрана до первой настройки. Плюс они не переключали
     * разделы, а прокручивали к ним: все девять лежали одной лентой.
     */
    render(<MobileSettingsView />);
    for (const id of ['playback', 'player', 'appearance', 'design', 'library', 'offline', 'account']) {
      expect(screen.getByTestId(`mobile-settings-row-${id}`)).toBeInTheDocument();
    }
  });

  it('разделы, которым нужен настольный мост, на телефоне не предлагаются', () => {
    // Плашка была, а панель за ней пустовала: оба раздела ничего не рисуют без
    // `window.electronAPI`.
    render(<MobileSettingsView />);
    expect(screen.queryByTestId('mobile-settings-row-desktop')).toBeNull();
    expect(screen.queryByTestId('mobile-settings-row-diagnostics')).toBeNull();
  });

  it('раздел открывается своей страницей с возвратом', () => {
    render(<MobileSettingsView />);

    fireEvent.click(screen.getByTestId('mobile-settings-row-playback'));

    expect(screen.getByTestId('mobile-settings-section')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-settings-row-playback')).toBeNull();

    fireEvent.click(screen.getByTestId('mobile-settings-back'));
    expect(screen.getByTestId('mobile-settings-row-playback')).toBeInTheDocument();
  });
});

/**
 * Регулятор темпа на телефоне.
 *
 * Две беды, обе видны на скриншоте владельца от 2026-09-01. Первая: настольная
 * панель прибита к своей кнопке и растёт вбок от неё — кнопка стоит посреди
 * нижнего ряда, и панель шириной 344 на экране в 360 уезжала за правый край,
 * унося половину пресетов и весь переключатель тональности. Вторая: подпись
 * «Темп» была отдельным `<span>` рядом с кнопкой, то есть по слову нажимать
 * было некуда — открывался только значок, и это выглядело как «не работает».
 */
describe('Темп на телефоне', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      currentTrack: track,
      duration: 240,
      isPlaying: true,
      playbackState: 'playing'
    });
    useUIStore.setState({ isFullscreenPlayerOpen: true });
  });

  it('подпись «Темп» лежит внутри кнопки, а не рядом с ней', () => {
    render(<MobileFullscreenPlayer />);

    const button = screen.getByTestId('mobile-fullscreen-tempo');
    expect(button.tagName).toBe('BUTTON');
    expect(button.textContent).toContain('Темп');
  });

  it('открывается листом снизу, а не панелью у кнопки', () => {
    render(<MobileFullscreenPlayer />);

    expect(screen.queryByTestId('mobile-tempo-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('mobile-fullscreen-tempo'));

    // Лист прибит к окну и растёт вверх от нижнего края: за край экрана ему
    // уехать нечем.
    expect(screen.getByTestId('mobile-tempo-sheet')).toBeInTheDocument();
    // Все шесть пресетов на месте — раньше правый столбец был за кадром.
    for (const rate of [0.65, 0.8, 0.9, 1, 1.25, 1.4]) {
      expect(screen.getByTestId(`tempo-preset-${rate}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('tempo-preserve-pitch')).toBeInTheDocument();
  });

  it('изменённая скорость видна прямо на кнопке', () => {
    // Забытые 0.65× иначе остаются загадкой: песня звучит не так, а почему —
    // на экране не сказано нигде.
    usePlayerStore.setState({ playbackRate: 0.65 });
    render(<MobileFullscreenPlayer />);

    expect(screen.getByTestId('mobile-fullscreen-tempo').textContent).toContain('0.65×');
  });
});
