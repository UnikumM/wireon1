import React, { useMemo, useState } from 'react';
import { BookmarkPlus, Check, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { useThemeStore, resolveAccentHex } from '../../store/useThemeStore';
import { designVars } from '../../styles/presets';
import {
  describeSnapshot,
  MAX_DESIGN_NAME,
  MAX_SAVED_DESIGNS,
  normalizeDesignName,
  snapshotOf,
  snapshotsEqual
} from '../../styles/customDesigns';
import { ICON } from '../../styles/icons';

/**
 * «Свои оформления» — снимки собранного вида под именем.
 *
 * Стоит сразу за встроенными пресетами, а не в конце раздела, потому что делает
 * то же самое: применяет вид целиком. Разница только в том, откуда вид взялся, и
 * прятать свои пять оформлений под восемь ручек означало бы, что найти их можно
 * только прокруткой.
 *
 * Карточка показывает миниатюру в переменных своего снимка — в тех же, что
 * миниатюра пресета. Иначе «Обсидиан ночью» и «Обсидиан на светлом» в списке
 * выглядели бы одной и той же карточкой с разными именами.
 */

const HEADING_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-sm)',
  lineHeight: 'var(--leading-sm)',
  fontWeight: 'var(--weight-semibold)',
  color: 'var(--text-primary)'
};

const HINT_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--text-xs)',
  lineHeight: 'var(--leading-xs)',
  color: 'var(--text-muted)',
  maxWidth: '62ch'
};

/* --- Миниатюра снимка -----------------------------------------------------
 * Размеры числами — как у миниатюры пресета в DesignSettings: это диаграмма
 * постоянного масштаба, и плотность снимка обязана менять в ней вид панели, а не
 * габарит картинки, иначе карточки в сетке разъедутся по высоте.
 */

const PREVIEW_FRAME_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  alignSelf: 'stretch',
  gap: '4px',
  height: '30px',
  padding: '4px',
  overflow: 'hidden',
  background: 'var(--bg-base)',
  borderRadius: 'var(--radius-sm)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)'
};

const PREVIEW_RAIL_STYLE: React.CSSProperties = {
  width: '6px',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-xs)'
};

const PREVIEW_PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  flex: 1,
  minWidth: 0,
  padding: '0 6px',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-xs)',
  boxShadow: 'var(--shadow-sm)'
};

const PREVIEW_DOT_STYLE: React.CSSProperties = {
  flexShrink: 0,
  width: '8px',
  height: '8px',
  background: 'var(--accent)',
  borderRadius: 'var(--radius-full)'
};

const PREVIEW_BAR_STYLE: React.CSSProperties = {
  height: '3px',
  background: 'var(--text-secondary)',
  borderRadius: 'var(--radius-pill)'
};

/** Ряд действий в карточке набран мелко, и кнопка-иконка равняется по нему. */
const COMPACT_ICON_STYLE: React.CSSProperties = {
  width: 'var(--control-sm)',
  height: 'var(--control-sm)'
};

export const CustomDesignsSection: React.FC = () => {
  const savedDesigns = useThemeStore((s) => s.savedDesigns);
  const saveDesign = useThemeStore((s) => s.saveDesign);
  const applySavedDesign = useThemeStore((s) => s.applySavedDesign);
  const updateSavedDesign = useThemeStore((s) => s.updateSavedDesign);
  const deleteSavedDesign = useThemeStore((s) => s.deleteSavedDesign);

  const presetId = useThemeStore((s) => s.presetId);
  const depth = useThemeStore((s) => s.depth);
  const accentId = useThemeStore((s) => s.accentId);
  const customAccentHex = useThemeStore((s) => s.customAccentHex);
  const fontId = useThemeStore((s) => s.fontId);
  const typeScaleId = useThemeStore((s) => s.typeScaleId);
  const fontWeightId = useThemeStore((s) => s.fontWeightId);
  const letterSpacingId = useThemeStore((s) => s.letterSpacingId);
  const overrides = useThemeStore((s) => s.overrides);

  const [name, setName] = useState('');

  // Снимок текущего вида собирается из полей поимённо, а не подпиской на всё
  // хранилище: подписка на объект целиком перерисовывала бы раздел на каждый
  // клик по любой настройке приложения, включая громкость.
  const current = useMemo(
    () =>
      snapshotOf({
        presetId,
        depth,
        accentId,
        customAccentHex,
        fontId,
        typeScaleId,
        fontWeightId,
        letterSpacingId,
        overrides
      }),
    [presetId, depth, accentId, customAccentHex, fontId, typeScaleId, fontWeightId, letterSpacingId, overrides]
  );

  const isFull = savedDesigns.length >= MAX_SAVED_DESIGNS;
  const canSave = normalizeDesignName(name) !== null && !isFull;

  const handleSave = () => {
    if (!canSave) return;
    saveDesign(name);
    // Поле очищается только после сохранения: если имя не приняли, человек
    // видит его на месте и правит, а не набирает заново.
    setName('');
  };

  return (
    <>
      <div className="divider" role="presentation" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <h3 style={HEADING_STYLE}>Свои оформления</h3>
        <p style={HINT_STYLE}>
          Запоминает весь вид сразу: пресет, светлоту, цвет, шрифт и все ручки. Подобранное
          сочетание можно вернуть одним нажатием — по встроенным пресетам после этого не страшно
          ходить. Хранится {MAX_SAVED_DESIGNS} штук.
        </p>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <input
          type="text"
          value={name}
          aria-label="Название оформления"
          maxLength={MAX_DESIGN_NAME}
          placeholder={isFull ? 'Список полон — удалите ненужное' : 'Название: «Мой тёмный», «Для вечера»…'}
          disabled={isFull}
          onChange={(e) => setName(e.target.value)}
          // Enter в поле имени сохраняет: поле и кнопка стоят рядом, и тянуться
          // мышью к кнопке после набора имени — лишнее движение.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSave();
            }
          }}
          style={{ flex: 1, minWidth: '200px' }}
          data-testid="settings-design-save-name"
        />
        <Button
          variant="secondary"
          size="sm"
          icon={<BookmarkPlus size={ICON.sm} />}
          onClick={handleSave}
          disabled={!canSave}
          data-testid="settings-design-save"
        >
          Сохранить вид
        </Button>
      </div>

      {savedDesigns.length === 0 ? (
        <p style={HINT_STYLE} data-testid="settings-design-saved-empty">
          Пока ничего не сохранено. Соберите вид ручками ниже и дайте ему имя.
        </p>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(232px, 1fr))',
            gap: 'var(--space-2)'
          }}
          data-testid="settings-design-saved-list"
        >
          {savedDesigns.map((design, index) => {
            const isCurrent = snapshotsEqual(design.snapshot, current);

            return (
              <div
                key={design.id}
                className="panel-raised animate-settle"
                data-active={isCurrent ? 'true' : 'false'}
                style={
                  {
                    '--stagger': index,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-3)',
                    borderRadius: 'var(--radius-md)',
                    // Рамка акцентом вместо галочки в углу: применённое оформление
                    // должно быть видно одним взглядом по всей сетке, а не поиском
                    // значка на каждой карточке.
                    border: `1px solid ${isCurrent ? 'var(--border-accent)' : 'var(--border-subtle)'}`
                  } as React.CSSProperties
                }
                data-testid={`settings-design-saved-${index}`}
              >
                {/*
                  Миниатюра считается из снимка, а не из текущего вида: карточка
                  обязана показывать то, что применит, иначе все свои оформления в
                  списке выглядели бы одинаково — как то, что уже на экране.
                */}
                <span
                  aria-hidden="true"
                  style={
                    {
                      ...PREVIEW_FRAME_STYLE,
                      ...designVars({
                        presetId: design.snapshot.presetId,
                        depth: design.snapshot.depth,
                        // Цвет берётся из снимка, а не из текущего вида: снимок
                        // хранит и пресет цвета, и свой hex, и `resolveAccentHex`
                        // разбирает ровно эту пару — иначе все миниатюры в списке
                        // светились бы одним цветом, тем, что сейчас на экране.
                        accentHex: resolveAccentHex(design.snapshot),
                        overrides: design.snapshot.overrides
                      })
                    } as React.CSSProperties
                  }
                  data-testid={`settings-design-saved-preview-${index}`}
                >
                  <span style={PREVIEW_RAIL_STYLE} />
                  <span style={PREVIEW_PANEL_STYLE}>
                    <span style={PREVIEW_DOT_STYLE} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: 0 }}>
                      <span style={{ ...PREVIEW_BAR_STYLE, width: '62%' }} />
                      <span style={{ ...PREVIEW_BAR_STYLE, width: '34%', background: 'var(--text-faint)' }} />
                    </span>
                  </span>
                </span>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  <span
                    className="text-truncate"
                    style={{
                      fontSize: 'var(--text-sm)',
                      lineHeight: 'var(--leading-sm)',
                      fontWeight: 'var(--weight-semibold)',
                      color: isCurrent ? 'var(--accent)' : 'var(--text-primary)'
                    }}
                    title={design.name}
                  >
                    {design.name}
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--text-xs)',
                      lineHeight: 'var(--leading-xs)',
                      color: 'var(--text-muted)'
                    }}
                  >
                    {describeSnapshot(design.snapshot)}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', marginTop: 'auto' }}>
                  <Button
                    variant={isCurrent ? 'ghost' : 'subtle'}
                    size="xs"
                    icon={isCurrent ? <Check size={ICON.sm} /> : undefined}
                    onClick={() => applySavedDesign(design.id)}
                    // Применённое оформление применяется повторно без запрета: это
                    // и есть способ вернуться к нему, если ручки успели уехать.
                    data-testid={`settings-design-saved-apply-${index}`}
                  >
                    {isCurrent ? 'Применено' : 'Применить'}
                  </Button>
                  <span style={{ flex: 1 }} />
                  <Button
                    variant="ghost"
                    size="icon"
                    icon={<RefreshCw size={ICON.sm} />}
                    onClick={() => updateSavedDesign(design.id)}
                    disabled={isCurrent}
                    title="Переписать текущим видом"
                    aria-label={`Переписать «${design.name}» текущим видом`}
                    // Кнопка ужата до --control-sm: рядом стоит подпись размера
                    // xs, и обычные 32 пикселя делали ряд выше самой карточки.
                    style={COMPACT_ICON_STYLE}
                    data-testid={`settings-design-saved-update-${index}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    icon={<Trash2 size={ICON.sm} />}
                    onClick={() => deleteSavedDesign(design.id)}
                    title="Удалить"
                    aria-label={`Удалить «${design.name}»`}
                    style={COMPACT_ICON_STYLE}
                    data-testid={`settings-design-saved-delete-${index}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
};
