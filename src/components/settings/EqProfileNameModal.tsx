import React, { useEffect, useState } from 'react';
import { Check, Headphones } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ICON } from '../../styles/icons';
import { EQ_PROFILE_NAME_LIMIT } from '../../services/eqProfiles';

export interface EqProfileNameModalProps {
  isOpen: boolean;
  /** Пустое — сохраняем новый профиль; иначе переименовываем существующий. */
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/**
 * Одно окно на сохранение и переименование профиля эквалайзера: в обоих
 * случаях это одно поле с именем, и два окна отличались бы только заголовком.
 */
export const EqProfileNameModal: React.FC<EqProfileNameModalProps> = ({
  isOpen,
  initialName = '',
  onClose,
  onSubmit
}) => {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const isRename = initialName.length > 0;

  // Поле заполняется заново при каждом открытии: окно одно, а профили разные.
  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setError(null);
    }
  }, [isOpen, initialName]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Введите название профиля.');
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
          <Headphones size={ICON.lg} aria-hidden="true" className="text-secondary" />
          {isRename ? 'Переименовать профиль' : 'Сохранить как профиль'}
        </span>
      }
      description={
        isRename
          ? undefined
          : 'Текущие полосы запомнятся под этим именем. Потом профиль можно привязать к наушникам — и он будет включаться сам.'
      }
      maxWidth="420px"
      data-testid="eq-profile-name-modal"
    >
      <form onSubmit={handleSubmit} className="stack gap-4">
        {error && (
          <div
            role="alert"
            className="radius-sm text-danger text-sm py-2 px-3 bg-danger-soft leading-sm"
            data-testid="eq-profile-name-error"
          >
            {error}
          </div>
        )}
        <div>
          <label htmlFor="eq-profile-name" className="block text-sm weight-medium text-secondary mb-2">
            Название
          </label>
          <input
            id="eq-profile-name"
            type="text"
            value={name}
            maxLength={EQ_PROFILE_NAME_LIMIT}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Наушники"
            autoFocus
            className="w-full"
            data-testid="eq-profile-name-input"
          />
        </div>
        <div className="row justify-end gap-3 pt-4 border-t-subtle">
          <Button variant="ghost" type="button" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            type="submit"
            icon={<Check size={ICON.md} aria-hidden="true" />}
            data-testid="eq-profile-name-submit"
          >
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
};
