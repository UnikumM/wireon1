import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { ICON } from '../../styles/icons';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Marks the confirm action as destructive and adds a warning glyph. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The app-wide replacement for `window.confirm`: a real focus-trapped dialog
 * whose Cancel path is the default (Escape and the backdrop both cancel, never
 * confirm).
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
  onConfirm,
  onCancel
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      maxWidth="420px"
      data-testid="confirm-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-testid="confirm-dialog-cancel">
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        {danger && (
          <AlertTriangle
            size={ICON.lg}
            aria-hidden="true"
            style={{ color: 'var(--danger)', flexShrink: 0, marginTop: '2px' }}
          />
        )}
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-base)',
            lineHeight: 'var(--leading-base)',
            color: 'var(--text-secondary)'
          }}
          data-testid="confirm-dialog-description"
        >
          {description ?? 'Это действие нельзя отменить.'}
        </p>
      </div>
    </Modal>
  );
};
