import React, { useState } from 'react';
import { Plus, ListMusic } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { Playlist } from '../../types/music';
import { ICON } from '../../styles/icons';

export interface CreatePlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (playlist: Playlist) => void;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  letterSpacing: 'var(--tracking-sm)',
  fontWeight: 'var(--weight-medium)',
  color: 'var(--text-secondary)',
  marginBottom: 'var(--space-2)'
};

/**
 * `createPlaylist` resolves with `null` when the write failed — the store holds
 * the reason. The dialog stays open in that case so the user keeps their typing.
 */
export const CreatePlaylistModal: React.FC<CreatePlaylistModalProps> = ({
  isOpen,
  onClose,
  onCreated
}) => {
  const createPlaylist = useLibraryStore((s) => s.createPlaylist);
  const showToast = useUIStore((s) => s.showToast);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSaving) return;

    if (!trimmedTitle) {
      setError('Введите название плейлиста.');
      return;
    }

    setIsSaving(true);
    setError(null);

    const created = await createPlaylist(trimmedTitle, description.trim() || undefined);

    setIsSaving(false);

    if (!created) {
      // Отказ из-за отсутствия аккаунта — не поломка, и говорить о нём второй
      // раз незачем: приглашение войти уже стоит поверх окна. Без этой ветки
      // человек видел сразу и «Войдите, чтобы создавать плейлисты», и красное
      // «Не удалось создать плейлист» — два разных ответа на одно нажатие.
      if (useUIStore.getState().accountPrompt) {
        onClose();
        return;
      }
      const reason = useLibraryStore.getState().error ?? 'Не удалось создать плейлист.';
      setError(reason);
      showToast(reason, 'error');
      return;
    }

    showToast(`Плейлист «${created.title}» создан`, 'success');
    setTitle('');
    setDescription('');
    onClose();
    onCreated?.(created);
  };

  const handleClose = () => {
    if (isSaving) return;
    setError(null);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <ListMusic size={ICON.lg} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
          Новый плейлист
        </span>
      }
      maxWidth="460px"
      data-testid="create-playlist-modal"
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error && (
          <div
            role="alert"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              backgroundColor: 'var(--danger-soft)',
              border: '1px solid var(--danger-soft)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--danger)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)'
            }}
            data-testid="create-playlist-error"
          >
            {error}
          </div>
        )}

        <div>
          <label htmlFor="playlist-title" style={labelStyle}>
            Название
          </label>
          <input
            id="playlist-title"
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Ночная дорога"
            autoFocus
            style={{ width: '100%' }}
            data-testid="create-playlist-title-input"
          />
        </div>

        <div>
          <label htmlFor="playlist-desc" style={labelStyle}>
            Описание <span style={{ color: 'var(--text-faint)' }}>(необязательно)</span>
          </label>
          <textarea
            id="playlist-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="О чём этот плейлист?"
            rows={3}
            style={{ width: '100%', fontSize: 'var(--text-sm)' }}
            data-testid="create-playlist-desc-input"
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 'var(--space-3)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--border-subtle)'
          }}
        >
          <Button variant="ghost" type="button" onClick={handleClose} disabled={isSaving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            type="submit"
            isLoading={isSaving}
            icon={<Plus size={ICON.md} aria-hidden="true" />}
            data-testid="create-playlist-submit-btn"
          >
            Создать
          </Button>
        </div>
      </form>
    </Modal>
  );
};
