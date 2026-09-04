import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Wrench, ArrowUpRight, X } from 'lucide-react';
import { Button } from './Button';
import { useDismissable } from '../../hooks';
import {
  ChangelogEntry,
  ChangelogKind,
  entriesSince,
  formatEntryDate
} from '../../data/changelog';
import { APP_VERSION } from '../../utils/appInfo';
import { STORAGE_KEY_INTRO_SEEN } from '../auth/WelcomeGate';
import { ICON } from '../../styles/icons';

/** Версия, список изменений которой человек уже прочитал. */
export const STORAGE_KEY_LAST_SEEN_VERSION = 'wireon_last_seen_version';

/**
 * Версия из хранилища или `null`, если её там нет и не будет.
 *
 * `undefined` и `null` здесь разные вещи: `null` — хранилище недоступно (тогда
 * помнить нечем и экран не показываем вовсе), `undefined` — хранилище работает,
 * но записи нет. Второе бывает у тех, кто обновился со сборки, где этой памяти
 * ещё не существовало.
 */
export function readLastSeenVersion(): string | null | undefined {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return localStorage.getItem(STORAGE_KEY_LAST_SEEN_VERSION) ?? undefined;
  } catch {
    return null;
  }
}

export function markVersionSeen(version: string = APP_VERSION): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(STORAGE_KEY_LAST_SEEN_VERSION, version);
  } catch {
    // Не критично: в худшем случае список покажется ещё раз.
  }
}

/** Запускалось ли приложение на этом устройстве раньше. */
function hasRunBefore(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return localStorage.getItem(STORAGE_KEY_INTRO_SEEN) !== null;
  } catch {
    return false;
  }
}

/**
 * Что показать при этом запуске.
 *
 * Развилка одна, но неочевидная: записи о прошлой версии нет и у того, кто
 * поставил Wireon Sounds впервые, и у того, кто обновился со сборки без этой памяти.
 * Первому список изменений не нужен — он ещё ничего не видел, и поверх него уже
 * стоит приветствие. Второй как раз тот, для кого экран и делался. Отличаем их
 * по следу первого запуска: приветствие своё решение записывает.
 */
export function decideWhatsNew(input: {
  lastSeen: string | null | undefined;
  currentVersion: string;
  ranBefore: boolean;
}): { entries: ChangelogEntry[]; shouldRecord: boolean } {
  const { lastSeen, currentVersion, ranBefore } = input;

  // Хранилище недоступно: помнить показ нечем, а экран, встающий каждый запуск,
  // хуже, чем ненайденный список изменений.
  if (lastSeen === null) return { entries: [], shouldRecord: false };

  if (lastSeen === undefined) {
    // Свежая установка — молча запоминаем версию, чтобы следующее обновление
    // человек уже увидел.
    if (!ranBefore) return { entries: [], shouldRecord: true };
    // Обновление со сборки без этой памяти: показываем всё, что знаем про
    // текущую версию и ниже.
    return { entries: entriesSince('0.0.0', currentVersion), shouldRecord: true };
  }

  return { entries: entriesSince(lastSeen, currentVersion), shouldRecord: true };
}

const KIND_LABELS: Record<ChangelogKind, string> = {
  feature: 'Новое',
  change: 'Изменилось',
  fix: 'Исправлено'
};

function kindIcon(kind: ChangelogKind): React.ReactNode {
  switch (kind) {
    case 'feature':
      // Плюс, а не звёздочки: рядом стоят «Изменилось» и «Исправлено», и все три
      // значка должны различаться смыслом. «Новое» — это добавленное.
      return <Plus size={ICON.sm} aria-hidden="true" />;
    case 'fix':
      return <Wrench size={ICON.sm} aria-hidden="true" />;
    case 'change':
    default:
      return <ArrowUpRight size={ICON.sm} aria-hidden="true" />;
  }
}

export interface WhatsNewSheetProps {
  entries: ChangelogEntry[];
  onClose: () => void;
}

/**
 * Сам лист «Что нового» — половина экрана снизу.
 *
 * Не модалка по центру: обновление не требует решения, и накрывать всё окно ради
 * списка из пяти строк было бы грубее, чем нужно. Лист снизу оставляет
 * приложение на виду, закрывается одним нажатием и не спрашивает ничего.
 */
export const WhatsNewSheet: React.FC<WhatsNewSheetProps> = ({ entries, onClose }) => {
  const latest = entries[0];

  // Общая механика оверлеев: Escape, клик по фону, ловушка фокуса, возврат
  // фокуса и блокировка прокрутки за листом. Своя реализация здесь неизбежно
  // разъехалась бы с модалками и ящиком очереди.
  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen: true,
    onDismiss: onClose
  });

  return (
    <div
      className="animate-fade-in"
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 'var(--z-modal)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          backgroundColor: 'var(--scrim)'
        } as React.CSSProperties
      }
      {...backdropProps}
      data-testid="whats-new-overlay"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="animate-slide-up"
        style={{
          // Ровно половина экрана, как и просили: список читается целиком, а
          // приложение под ним остаётся узнаваемым.
          height: '50vh',
          minHeight: '320px',
          width: '100%',
          maxWidth: '760px',
          margin: '0 auto',
          background: 'var(--surface-3)',
          borderTop: '1px solid var(--border)',
          borderLeft: '1px solid var(--border)',
          borderRight: '1px solid var(--border)',
          borderTopLeftRadius: 'var(--radius-xl)',
          borderTopRightRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg), var(--highlight-top)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
        data-testid="whats-new-sheet"
      >
        {/* Шапка держится на месте, пока список едет под ней. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-5) var(--space-5) var(--space-4)',
            borderBottom: '1px solid var(--border-subtle)',
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0, flex: 1 }}>
            {/*
              * Подпись остаётся: она объясняет, почему экран вообще открылся.
              * А вот звёздочки заменены галочкой — «установлено» это факт, и
              * иконка должна говорить о нём, а не просто радоваться.
              */}
            <span
              className="section-label"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                color: 'var(--accent)'
              }}
            >
              <CheckCircle2 size={ICON.sm} aria-hidden="true" />
              Обновление установлено
            </span>
            <h2
              id="whats-new-title"
              style={{
                margin: 0,
                fontSize: 'var(--text-2xl)',
                lineHeight: 'var(--leading-2xl)',
                letterSpacing: 'var(--tracking-2xl)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
            >
              Wireon Sounds {latest ? latest.version : APP_VERSION}
            </h2>
            {latest && (
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)',
                  lineHeight: 'var(--leading-sm)',
                  color: 'var(--text-secondary)'
                }}
                data-testid="whats-new-headline"
              >
                {latest.headline}
              </p>
            )}
          </div>

          <Button
            variant="icon"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть «Что нового»"
            data-testid="whats-new-close"
          >
            <X size={ICON.md} aria-hidden="true" />
          </Button>
        </div>

        <div
          className="scrollbar-thin"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 'var(--space-4) var(--space-5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)'
          }}
        >
          {entries.map((entry, index) => (
            /*
             * Записи устаиваются по очереди — так же, как содержимое
             * полноэкранного плеера внутри своего слоя. Масштаб без вертикали
             * взят нарочно: сам лист в это время едет снизу вверх, и второе
             * вертикальное движение внутри него сложилось бы с первым.
             */
            <section
              key={entry.version}
              className="animate-settle"
              style={{ '--stagger': index } as React.CSSProperties}
              data-testid={`whats-new-entry-${entry.version}`}
            >
              {/* Заголовок версии нужен только когда их несколько: при одном
                  выпуске он повторял бы то, что уже написано в шапке. */}
              {(index > 0 || entries.length > 1) && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 'var(--space-2)',
                    marginBottom: 'var(--space-3)'
                  }}
                >
                  <span
                    data-numeric
                    style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}
                  >
                    {entry.version}
                  </span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
                    {formatEntryDate(entry.date)}
                  </span>
                </div>
              )}

              <ul
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)'
                }}
              >
                {entry.items.map((item) => (
                  <li key={item.title} style={{ display: 'flex', gap: 'var(--space-3)' }}>
                    <span
                      title={KIND_LABELS[item.kind]}
                      aria-label={KIND_LABELS[item.kind]}
                      style={{
                        flexShrink: 0,
                        width: 'var(--control-md)',
                        height: 'var(--control-md)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-subtle)',
                        background: item.kind === 'feature' ? 'var(--accent-soft)' : 'var(--surface-2)',
                        color: item.kind === 'feature' ? 'var(--accent)' : 'var(--text-secondary)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                      data-kind={item.kind}
                    >
                      {kindIcon(item.kind)}
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 'var(--text-sm)',
                          lineHeight: 'var(--leading-sm)',
                          fontWeight: 'var(--weight-medium)',
                          color: 'var(--text-primary)'
                        }}
                      >
                        {item.title}
                      </span>
                      {item.detail && (
                        <span
                          style={{
                            fontSize: 'var(--text-xs)',
                            lineHeight: 'var(--leading-xs)',
                            color: 'var(--text-muted)'
                          }}
                        >
                          {item.detail}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div
          style={{
            padding: 'var(--space-4) var(--space-5)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            flexShrink: 0
          }}
        >
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
            Список всегда есть в настройках, в разделе «О программе».
          </span>
          <Button variant="primary" size="md" onClick={onClose} data-testid="whats-new-continue">
            Слушать дальше
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * Решает сам, показываться ли: сравнивает версию сборки с той, список которой
 * человек уже читал.
 *
 * Отдельно от плашки автообновления и намеренно не связан с ней: обновление
 * могло встать при закрытии приложения, из установщика или на другом
 * устройстве — важен не факт скачивания, а первый запуск новой версии.
 */
export const WhatsNewGate: React.FC = () => {
  const decision = useMemo(
    () =>
      decideWhatsNew({
        lastSeen: readLastSeenVersion(),
        currentVersion: APP_VERSION,
        ranBefore: hasRunBefore()
      }),
    []
  );

  // Решение принимается один раз при монтировании: список не должен появляться
  // посреди сессии и не должен исчезать, пока его читают.
  const [isVisible, setIsVisible] = useState(() => decision.entries.length > 0);

  // Версия запоминается сразу, даже если показывать нечего: иначе свежая
  // установка получила бы задним числом весь список при первом обновлении.
  // Запись в эффекте, а не в теле — рендер не должен ничего менять снаружи.
  useEffect(() => {
    if (decision.shouldRecord) markVersionSeen();
  }, [decision.shouldRecord]);

  const close = useCallback(() => {
    markVersionSeen();
    setIsVisible(false);
  }, []);

  if (!isVisible) return null;

  return <WhatsNewSheet entries={decision.entries} onClose={close} />;
};

export default WhatsNewGate;
