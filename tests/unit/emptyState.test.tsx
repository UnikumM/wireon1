import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';
import { EmptyState } from '../../src/components/common/EmptyState';
import { EmptyArt, hasEmptyArt, type EmptyArtName } from '../../src/components/common/emptyArt';

/**
 * Пустые состояния с характером (идея 37).
 *
 * Каждый пустой экран говорит, что здесь будет, и даёт одно действие; рисунок —
 * одной линией, цветом из темы. Проверяется контракт компонента и то, что
 * рисунки не тянут за собой литералы цвета и заливки: на светлых пресетах
 * именно такие вещи становились единственными кричащими пятнами.
 */

const SRC = path.resolve(__dirname, '../../src');
const ART_SOURCE = readFileSync(path.join(SRC, 'components/common/emptyArt.tsx'), 'utf8');
const GLOBAL_CSS = readFileSync(path.join(SRC, 'styles/global.css'), 'utf8');

const ART_NAMES: EmptyArtName[] = [
  'library',
  'search',
  'queue',
  'offline',
  'favorites',
  'history',
  'playlists',
  'lyrics',
  'wave',
  'network'
];

describe('EmptyState', () => {
  it('показывает заголовок и подсказку', () => {
    render(<EmptyState title="Здесь будут ваши любимые" description="Нажмите сердце у трека" />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Здесь будут ваши любимые');
    expect(screen.getByText('Нажмите сердце у трека')).toBeInTheDocument();
  });

  it('действие из { label, onClick } становится кнопкой и срабатывает', () => {
    const onClick = vi.fn();
    render(<EmptyState title="Очередь пуста" action={{ label: 'Включить Поток', onClick, 'data-testid': 'go' }} />);
    const button = screen.getByRole('button', { name: 'Включить Поток' });
    expect(button).toHaveAttribute('data-testid', 'go');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('готовый элемент в action рисуется как есть', () => {
    render(<EmptyState title="Пусто" action={<a href="#x" data-testid="custom-action">Ссылка</a>} />);
    expect(screen.getByTestId('custom-action')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('иллюстрация по имени рендерится и помечена именем', () => {
    render(<EmptyState title="Пусто" art="favorites" data-testid="es" />);
    const art = screen.getByTestId('empty-art');
    expect(art.tagName.toLowerCase()).toBe('svg');
    expect(art).toHaveAttribute('data-art', 'favorites');
    expect(art).toHaveAttribute('aria-hidden', 'true');
    expect(art.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(screen.getByTestId('es')).toHaveAttribute('data-art', 'favorites');
  });

  it('при заданном art старая иконка не показывается', () => {
    render(<EmptyState title="Пусто" art="search" icon={<span data-testid="old-icon" />} />);
    expect(screen.queryByTestId('old-icon')).toBeNull();
    expect(screen.getByTestId('empty-art')).toBeInTheDocument();
  });

  it('без art иконка парит, как раньше', () => {
    render(<EmptyState title="Пусто" icon={<span data-testid="old-icon" />} />);
    expect(screen.getByTestId('old-icon').parentElement?.className).toContain('animate-float');
  });

  it('неизвестное имя иллюстрации не роняет экран', () => {
    render(<EmptyState title="Всё ещё здесь" art={'nothing-like-this' as EmptyArtName} />);
    expect(screen.getByText('Всё ещё здесь')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-art')).toBeNull();
    expect(hasEmptyArt('nothing-like-this')).toBe(false);
  });

  it('раскладка — классом, а не инлайновым стилем', () => {
    render(<EmptyState title="Пусто" data-testid="es" />);
    const root = screen.getByTestId('es');
    expect(root.className).toContain('empty-state');
    expect(root.className).toContain('panel-inset');
    expect(root.getAttribute('style')).toBeNull();
  });
});

describe('Иллюстрации одной линией', () => {
  it.each(ART_NAMES)('«%s» есть и состоит из путей', (name) => {
    expect(hasEmptyArt(name)).toBe(true);
    const { container } = render(<EmptyArt name={name} />);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.getAttribute('d')).toMatch(/^M/);
  });

  it('у каждой есть акцентная линия — то, ради чего экран существует', () => {
    for (const name of ART_NAMES) {
      const { container, unmount } = render(<EmptyArt name={name} />);
      expect(container.querySelector('.empty-art-accent'), name).not.toBeNull();
      unmount();
    }
  });

  it('контур: без заливок, currentColor, полтора пикселя', () => {
    const { container } = render(<EmptyArt name="library" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('1.5');
    expect(svg.getAttribute('viewBox')).toBe('0 0 120 80');
  });

  it('в исходнике рисунков нет литералов цвета и заливок', () => {
    expect(ART_SOURCE).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(ART_SOURCE).not.toMatch(/rgba?\(/);
    expect(ART_SOURCE).not.toMatch(/fill=["'](?!none)/);
  });

  it('длительность дорисовки — из токенов motion.ts, не своя', () => {
    expect(ART_SOURCE).toContain("readDuration('slow')");
    expect(ART_SOURCE).toContain('EASE.out');
    expect(ART_SOURCE).toContain('STAGGER_MS');
    // Свои секунды в transition — то, от чего предохраняет designDrift.
    expect(ART_SOURCE).not.toMatch(/duration:\s*\d/);
  });

  it('цвет рисунка задан токенами в global.css для обоих слоёв', () => {
    expect(GLOBAL_CSS).toMatch(/\.empty-art\s*\{[^}]*color:\s*var\(--text-muted\)/);
    expect(GLOBAL_CSS).toMatch(/\.empty-art-accent\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(GLOBAL_CSS).toMatch(/\.empty-state\s*\{[^}]*display:\s*flex/);
  });
});
