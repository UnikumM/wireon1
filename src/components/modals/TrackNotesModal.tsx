import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useUIStore } from '../../store/useUIStore';
import { useAllTags, useTrackNote } from '../../hooks/useTrackNote';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_TRACK, addTag, cleanTag, removeTag, setNote, tagKey } from '../../services/trackNotes';
import type { UnifiedTrack } from '../../types/music';
import { ICON } from '../../styles/icons';

/*
 * Окно «Теги и заметка» (идея 13 плана 4.0).
 *
 * Пометки — личные и только на этом устройстве (см. `services/trackNotes.ts`).
 * Окно одно на приложение и открывается стором: его зовут и меню карточки на
 * ПК, и лист действий на телефоне, а лист при закрытии размонтируется вместе
 * со всем, что нарисовал бы внутри себя.
 */

/** Сколько подсказок показывать под полем: больше — уже облако, а не подсказка. */
const SUGGESTION_LIMIT = 8;

/** Заметка пишется в базу не на каждую букву, а когда человек остановился. */
const NOTE_SAVE_DELAY_MS = 400;

export interface TrackNotesEditorProps {
  track: UnifiedTrack;
}

/**
 * Содержимое окна: поле заметки, чипы тегов, ввод нового тега с подсказками.
 * Отдельно от окна, чтобы его можно было проверить и переиспользовать без
 * портала и стора.
 */
export const TrackNotesEditor: React.FC<TrackNotesEditorProps> = ({ track }) => {
  const record = useTrackNote(track.id);
  const tags = useMemo(() => record?.tags ?? [], [record]);
  const allTags = useAllTags();

  const [draft, setDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState(record?.note ?? '');
  const saveTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * Заметка из базы приходит позже первого кадра (кэш может ещё читаться),
   * поэтому черновик догоняет запись, пока человек ничего не печатал.
   * `dirty` — печатал: с этого момента запись черновик не перебивает.
   */
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setNoteDraft(record?.note ?? '');
  }, [record]);

  const flushNote = (value: string) => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    void setNote(track.id, value);
  };

  const handleNoteChange = (value: string) => {
    dirty.current = true;
    setNoteDraft(value);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void setNote(track.id, value);
    }, NOTE_SAVE_DELAY_MS);
  };

  // Закрыли окно, не дождавшись таймера, — заметка всё равно сохранится.
  const latestNote = useRef(noteDraft);
  latestNote.current = noteDraft;
  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        void setNote(track.id, latestNote.current);
      }
    },
    [track.id]
  );

  const present = useMemo(() => new Set(tags.map(tagKey)), [tags]);
  const draftKey = tagKey(draft);
  const suggestions = useMemo(
    () =>
      allTags
        .filter(({ tag }) => {
          const key = tagKey(tag);
          if (present.has(key)) return false;
          return draftKey ? key.includes(draftKey) : true;
        })
        .slice(0, SUGGESTION_LIMIT),
    [allTags, present, draftKey]
  );

  const full = tags.length >= MAX_TAGS_PER_TRACK;

  const commitTag = (raw: string) => {
    const clean = cleanTag(raw);
    if (!clean || full) return;
    void addTag(track.id, clean);
    setDraft('');
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTag(draft);
      return;
    }
    // Backspace по пустому полю снимает последний тег — как в почтовых адресатах.
    if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      e.preventDefault();
      void removeTag(track.id, tags[tags.length - 1]);
    }
  };

  const handleInputChange = (value: string) => {
    // Запятая внутри вставленного текста — тоже разделитель.
    if (value.includes(',')) {
      const parts = value.split(',');
      const rest = parts.pop() ?? '';
      parts.forEach((part) => commitTag(part));
      setDraft(rest);
      return;
    }
    setDraft(value);
  };

  return (
    <div className="stack gap-5" data-testid="track-notes-editor">
      <div className="stack gap-2">
        <label htmlFor="track-notes-tags" className="text-sm text-secondary weight-medium">
          Теги
        </label>
        {tags.length > 0 && (
          <ul className="row wrap gap-2 m-0 p-0" data-testid="track-notes-tags" aria-label="Теги трека">
            {tags.map((tag) => (
              <li key={tagKey(tag)} className="chip tag-chip" data-testid={`track-notes-tag-${tagKey(tag)}`}>
                <span className="text-truncate">{tag}</span>
                <button
                  type="button"
                  className="tag-chip-remove press focus-ring pointer"
                  onClick={() => void removeTag(track.id, tag)}
                  aria-label={`Убрать тег «${tag}»`}
                  title="Убрать тег"
                  data-testid={`track-notes-tag-remove-${tagKey(tag)}`}
                >
                  <X size={ICON.xs} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="row gap-2">
          <input
            ref={inputRef}
            id="track-notes-tags"
            type="text"
            value={draft}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={() => {
              if (draft.trim()) commitTag(draft);
            }}
            placeholder={full ? 'Больше тегов не поместится' : 'Для бега, показать Диме…'}
            maxLength={MAX_TAG_LENGTH}
            disabled={full}
            autoComplete="off"
            className="grow"
            aria-describedby="track-notes-tags-hint"
            data-testid="track-notes-tag-input"
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus size={ICON.sm} aria-hidden="true" />}
            onClick={() => commitTag(draft)}
            disabled={full || !cleanTag(draft)}
            aria-label="Добавить тег"
            data-testid="track-notes-tag-add"
          >
            Добавить
          </Button>
        </div>
        <p id="track-notes-tags-hint" className="m-0 text-xs text-muted">
          Enter или запятая добавляют тег. По тегам можно искать и фильтровать медиатеку.
        </p>
        {suggestions.length > 0 && (
          <div className="row wrap gap-1" role="group" aria-label="Уже есть теги" data-testid="track-notes-suggestions">
            {suggestions.map(({ tag, count }) => (
              <button
                key={tagKey(tag)}
                type="button"
                className="chip tag-suggestion"
                onClick={() => commitTag(tag)}
                title={`Треков с тегом: ${count}`}
                data-testid={`track-notes-suggest-${tagKey(tag)}`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="stack gap-2">
        <label htmlFor="track-notes-note" className="text-sm text-secondary weight-medium">
          Заметка
        </label>
        <textarea
          id="track-notes-note"
          value={noteDraft}
          onChange={(e) => handleNoteChange(e.target.value)}
          onBlur={() => {
            if (dirty.current) flushNote(noteDraft);
          }}
          placeholder="Припев в 1:12, поставить на вечеринке…"
          rows={4}
          className="w-full text-sm track-notes-textarea"
          data-testid="track-notes-note-input"
        />
        <p className="m-0 text-xs text-muted">
          Пометки хранятся только на этом устройстве и на сервер не уходят.
        </p>
      </div>
    </div>
  );
};

export interface TrackNotesModalProps {
  track: UnifiedTrack | null;
  onClose: () => void;
}

/** Окно вокруг редактора. Открыто, пока есть трек. */
export const TrackNotesModal: React.FC<TrackNotesModalProps> = ({ track, onClose }) => {
  /*
   * Пока окно доигрывает кадры ухода, трека в сторе уже нет — показываем
   * последний, иначе содержимое пропадало бы раньше самого окна.
   */
  const lastTrack = useRef<UnifiedTrack | null>(track);
  if (track) lastTrack.current = track;
  const shown = track ?? lastTrack.current;

  return (
    <Modal
      isOpen={track !== null}
      onClose={onClose}
      title="Теги и заметка"
      description={shown ? `${shown.title} — ${shown.artist}` : undefined}
      maxWidth="480px"
      data-testid="track-notes-modal"
    >
      {shown && <TrackNotesEditor key={shown.id} track={shown} />}
    </Modal>
  );
};

/** Окно, привязанное к стору: монтируется один раз в оболочке. */
export const TrackNotesModalHost: React.FC = () => {
  const track = useUIStore((s) => s.notesTrack);
  const close = useUIStore((s) => s.closeTrackNotes);
  return <TrackNotesModal track={track} onClose={close} />;
};
