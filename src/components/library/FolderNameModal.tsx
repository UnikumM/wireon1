import React, { useEffect, useState } from 'react';
import { FolderPlus, Check } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ICON } from '../../styles/icons';

export interface FolderNameModalProps {
  isOpen: boolean;
  /** Пустое — создаём новую папку; иначе переименовываем. */
  initialTitle?: string;
  onClose: () => void;
  onSubmit: (title: string) => void;
}

/**
 * Одно окно на создание и переименование папки: в обоих случаях это одно поле с
 * именем, и два разных окна отличались бы только заголовком.
 */
export const FolderNameModal: React.FC<FolderNameModalProps> = ({ isOpen, initialTitle = '', onClose, onSubmit }) => {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const isRename = initialTitle.length > 0;

  // Поле заполняется заново при каждом открытии: окно одно, а папки разные.
  useEffect(() => {
    if (isOpen) {
      setTitle(initialTitle);
      setError(null);
    }
  }, [isOpen, initialTitle]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Введите название папки.');
      return;
    }
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span className="inline-row gap-2">
          <FolderPlus size={ICON.lg} aria-hidden="true" className="text-secondary" />
          {isRename ? 'Переименовать папку' : 'Новая папка'}
        </span>
      }
      maxWidth="420px"
      data-testid="folder-name-modal"
    >
      <form onSubmit={handleSubmit} className="stack gap-4">
        {error && (
          <div role="alert" className="radius-sm text-danger text-sm py-2 px-3 bg-danger-soft leading-sm" data-testid="folder-name-error">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="folder-title" className="block text-sm weight-medium text-secondary mb-2">
            Название
          </label>
          <input
            id="folder-title"
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Для дороги"
            autoFocus
            className="w-full"
            data-testid="folder-name-input"
          />
        </div>
        <div className="row justify-end gap-3 pt-4 border-t-subtle">
          <Button variant="ghost" type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            type="submit"
            icon={isRename ? <Check size={ICON.md} aria-hidden="true" /> : <FolderPlus size={ICON.md} aria-hidden="true" />}
            data-testid="folder-name-submit"
          >
            {isRename ? 'Сохранить' : 'Создать'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};
