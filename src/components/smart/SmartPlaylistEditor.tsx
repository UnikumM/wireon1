import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import {
  SMART_FIELD_LABELS,
  SMART_FIELD_OPS,
  SMART_OP_LABELS,
  SMART_PRESETS,
  SMART_SORT_LABELS,
  SmartField,
  SmartOp,
  SmartPlaylist,
  SmartRule,
  SmartSort,
  defaultRule,
  evaluateSmartPlaylist
} from '../../services/smartPlaylists';
import { useSmartPlaylistStore } from '../../store/useSmartPlaylistStore';
import { useUIStore } from '../../store/useUIStore';
import { useTrackFacts } from '../../hooks/useSmartPlaylistTracks';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

export interface SmartPlaylistEditorProps {
  isOpen: boolean;
  onClose: () => void;
  /** Правим существующий; без него — создаём новый. */
  playlist?: SmartPlaylist | null;
  /** Открыть созданный плейлист сразу после сохранения. */
  openAfterCreate?: boolean;
}

type Draft = Omit<SmartPlaylist, 'id' | 'createdAt' | 'updatedAt'>;

const EMPTY_DRAFT: Draft = {
  title: '',
  match: 'all',
  rules: [defaultRule('favorite')],
  sort: 'plays',
  limit: 50
};

/*
 * Строка правила переносится, а не сжимается: на телефоне три списка в ряд
 * обрезали подписи до «В избра…». Поле занимает свою строку, условие и
 * значение — следующую.
 */
const rowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-2)',
  alignItems: 'center'
};

const FIELD_FLEX: React.CSSProperties = { flex: '1 1 180px', minWidth: 0, width: 'auto' };
const OP_FLEX: React.CSSProperties = { flex: '1 1 120px', minWidth: 0, width: 'auto' };
const VALUE_FLEX: React.CSSProperties = { flex: '1 1 90px', minWidth: 0, width: 'auto' };
const INLINE_LABEL: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2)',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap'
};

const NUMERIC_FIELDS: SmartField[] = ['plays', 'skips', 'lastPlayed', 'added', 'duration'];

const RuleValue: React.FC<{ rule: SmartRule; onChange: (value: SmartRule['value']) => void; index: number }> = ({
  rule,
  onChange,
  index
}) => {
  if (rule.op === 'never') return <span style={VALUE_FLEX} />;
  if (rule.field === 'favorite') {
    return (
      <select
        value={rule.value ? 'yes' : 'no'}
        onChange={(e) => onChange(e.target.value === 'yes')}
        aria-label="Значение"
        style={VALUE_FLEX}
        data-testid={`smart-rule-value-${index}`}
      >
        <option value="yes">да</option>
        <option value="no">нет</option>
      </select>
    );
  }
  if (rule.field === 'source') {
    return (
      <select
        value={String(rule.value)}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Источник"
        style={VALUE_FLEX}
        data-testid={`smart-rule-value-${index}`}
      >
        <option value="youtube">YouTube</option>
        <option value="soundcloud">SoundCloud</option>
      </select>
    );
  }
  if (NUMERIC_FIELDS.includes(rule.field)) {
    return (
      <input
        type="number"
        min={0}
        step={rule.field === 'duration' ? 0.5 : 1}
        value={Number(rule.value) || 0}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
        aria-label="Число"
        style={VALUE_FLEX}
        data-testid={`smart-rule-value-${index}`}
      />
    );
  }
  return (
    <input
      type="text"
      value={String(rule.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder="текст"
      aria-label="Текст"
      style={VALUE_FLEX}
      data-testid={`smart-rule-value-${index}`}
    />
  );
};

/**
 * Редактор умного плейлиста: название, «все/любое из» правил, сами правила,
 * порядок и предел. Внизу живой счётчик — сколько треков сейчас подходит.
 */
export const SmartPlaylistEditor: React.FC<SmartPlaylistEditorProps> = ({
  isOpen,
  onClose,
  playlist,
  openAfterCreate = true
}) => {
  const create = useSmartPlaylistStore((s) => s.create);
  const update = useSmartPlaylistStore((s) => s.update);
  const showToast = useUIStore((s) => s.showToast);
  const facts = useTrackFacts();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(
      playlist
        ? { title: playlist.title, match: playlist.match, rules: playlist.rules, sort: playlist.sort, limit: playlist.limit }
        : EMPTY_DRAFT
    );
  }, [isOpen, playlist]);

  const preview = useMemo(() => {
    if (!facts) return null;
    return evaluateSmartPlaylist({ ...draft, id: playlist?.id ?? 'draft', createdAt: 0, updatedAt: 0 }, facts, Date.now());
  }, [draft, facts, playlist?.id]);

  const setRule = (index: number, patch: Partial<SmartRule>) => {
    setDraft((d) => ({ ...d, rules: d.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  };

  const changeField = (index: number, field: SmartField) => {
    setDraft((d) => ({ ...d, rules: d.rules.map((r, i) => (i === index ? defaultRule(field) : r)) }));
  };

  const changeOp = (index: number, op: SmartOp) => {
    const rule = draft.rules[index];
    // «Это/не это» у исполнителя — текст, у счётчиков — число: значение
    // сохраняем, кроме перехода в «никогда», где его нет.
    setRule(index, { op, value: op === 'never' ? 0 : rule.value });
  };

  const save = () => {
    const title = draft.title.trim() || 'Умный плейлист';
    if (playlist) {
      update(playlist.id, { ...draft, title });
      showToast('Правила обновлены', 'success');
    } else {
      const created = create({ ...draft, title });
      showToast(`Умный плейлист «${created.title}» создан`, 'success');
      if (openAfterCreate) useUIStore.getState().openSmartPlaylist(created.id);
    }
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={playlist ? 'Правила умного плейлиста' : 'Новый умный плейлист'}
      description="Список пересобирается сам, когда меняется медиатека и история прослушиваний."
      maxWidth="640px"
      data-testid="smart-editor"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {!playlist && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }} aria-label="Заготовки">
            {SMART_PRESETS.map((preset, i) => (
              <button
                key={preset.title}
                type="button"
                className="chip"
                onClick={() => setDraft({ ...preset, rules: preset.rules.map((r) => ({ ...r })) })}
                data-testid={`smart-preset-${i}`}
              >
                {preset.title}
              </button>
            ))}
          </div>
        )}

        <input
          type="text"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          placeholder="Название"
          aria-label="Название умного плейлиста"
          data-testid="smart-title-input"
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          Подходят треки, где выполнены
          <select
            value={draft.match}
            onChange={(e) => setDraft((d) => ({ ...d, match: e.target.value === 'any' ? 'any' : 'all' }))}
            aria-label="Как сочетать правила"
            style={{ width: 'auto' }}
            data-testid="smart-match-select"
          >
            <option value="all">все правила</option>
            <option value="any">любое из правил</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }} data-testid="smart-rules">
          {draft.rules.map((rule, index) => (
            <div key={index} style={rowStyle} data-testid={`smart-rule-${index}`}>
              <select
                value={rule.field}
                onChange={(e) => changeField(index, e.target.value as SmartField)}
                aria-label="Поле"
                style={FIELD_FLEX}
                data-testid={`smart-rule-field-${index}`}
              >
                {(Object.keys(SMART_FIELD_LABELS) as SmartField[]).map((field) => (
                  <option key={field} value={field}>
                    {SMART_FIELD_LABELS[field]}
                  </option>
                ))}
              </select>
              <select
                value={rule.op}
                onChange={(e) => changeOp(index, e.target.value as SmartOp)}
                aria-label="Условие"
                style={OP_FLEX}
                data-testid={`smart-rule-op-${index}`}
              >
                {SMART_FIELD_OPS[rule.field].map((op) => (
                  <option key={op} value={op}>
                    {SMART_OP_LABELS[op]}
                  </option>
                ))}
              </select>
              <RuleValue rule={rule} index={index} onChange={(value) => setRule(index, { value })} />
              <Button
                variant="ghost"
                size="icon"
                aria-label="Убрать правило"
                title="Убрать правило"
                onClick={() => setDraft((d) => ({ ...d, rules: d.rules.filter((_, i) => i !== index) }))}
                data-testid={`smart-rule-remove-${index}`}
              >
                <Trash2 size={ICON.sm} />
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={ICON.sm} />}
              onClick={() => setDraft((d) => ({ ...d, rules: [...d.rules, defaultRule('artist')] }))}
              data-testid="smart-add-rule"
            >
              Добавить правило
            </Button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={INLINE_LABEL}>
            Порядок
            <select
              style={{ width: 'auto' }}
              value={draft.sort}
              onChange={(e) => setDraft((d) => ({ ...d, sort: e.target.value as SmartSort }))}
              data-testid="smart-sort-select"
            >
              {(Object.keys(SMART_SORT_LABELS) as SmartSort[]).map((sort) => (
                <option key={sort} value={sort}>
                  {SMART_SORT_LABELS[sort]}
                </option>
              ))}
            </select>
          </label>
          <label style={INLINE_LABEL}>
            Не больше
            <select
              style={{ width: 'auto' }}
              value={String(draft.limit)}
              onChange={(e) => setDraft((d) => ({ ...d, limit: Number(e.target.value) }))}
              data-testid="smart-limit-select"
            >
              {[25, 50, 100, 250, 0].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'без предела' : `${n} треков`}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }} data-testid="smart-preview-count">
            {preview === null ? 'Считаем…' : `Сейчас подходит: ${pluralize(preview.length, 'трек', 'трека', 'треков')}`}
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={save} data-testid="smart-save">
              {playlist ? 'Сохранить' : 'Создать'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
