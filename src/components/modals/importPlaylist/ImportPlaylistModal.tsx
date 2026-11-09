import React from 'react';
import { AlertCircle, Import } from 'lucide-react';
import { Modal } from '../../common/Modal';
import { ICON } from '../../../styles/icons';
import type { ImportPlaylistModalProps } from './types';
import { useImportFlow } from './useImportFlow';
import { SpotifyLibraryBlock } from './SpotifyLibraryBlock';
import { ImportSourceStep } from './ImportSourceStep';
import { ImportPreviewStep } from './ImportPreviewStep';
import { ImportResolvingStep } from './ImportResolvingStep';
import { ImportCompleteStep } from './ImportCompleteStep';

export type { ImportPlaylistModalProps } from './types';

/**
 * Окно переноса плейлиста: четыре шага под одним заголовком.
 *
 * Здесь только выбор шага и общий баннер отказа; всё состояние и обработчики —
 * в `useImportFlow`, сами шаги — чистая разметка рядом.
 */
export const ImportPlaylistModal: React.FC<ImportPlaylistModalProps> = (props) => {
  const { isOpen, onClose } = props;
  const flow = useImportFlow(props);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="row gap-2">
          {/* Значок переноса, а не звёздочки: окно ровно про перенос. */}
          <Import size={ICON.lg} className="text-secondary" aria-hidden="true" />
          <span>Перенести плейлист</span>
        </div>
      }
      maxWidth="560px"
      data-testid="import-playlist-modal"
    >
      <div className="stack gap-4">
        {flow.error && (
          <div
            role="alert"
            // Отказ появляется в ответ на нажатие — и обязан быть замечен.
            className="animate-drop-in radius-md text-danger text-sm row-start gap-2 py-3 px-4 bg-danger-soft"
            style={{ border: '1px solid var(--danger)' }}
            data-testid="import-error-banner"
          >
            <AlertCircle size={ICON.md} className="shrink-0 mt-px" />
            <div className="flex-1">{flow.error}</div>
          </div>
        )}

        {flow.step === 'input' && (
          <ImportSourceStep
            url={flow.url}
            detectedPlatform={flow.detectedPlatform}
            isLoading={flow.isLoading}
            onUrlChange={flow.handleUrlChange}
            onSubmit={flow.handleFetchMetadata}
            onFileChosen={flow.handleFileChosen}
            onClose={onClose}
          />
        )}

        {flow.step === 'input' && <SpotifyLibraryBlock onPicked={flow.handleSpotifyPicked} />}

        {flow.step === 'preview' && flow.preview && (
          <ImportPreviewStep
            preview={flow.preview}
            previewCount={flow.previewCount}
            onBack={flow.handleBackToInput}
            onStart={flow.handleStartResolution}
            onClose={onClose}
          />
        )}

        {flow.step === 'resolving' && (
          <ImportResolvingStep progress={flow.progress} percentComplete={flow.percentComplete} />
        )}

        {flow.step === 'complete' && flow.preview && (
          <ImportCompleteStep
            preview={flow.preview}
            resolvedTracks={flow.resolvedTracks}
            matches={flow.matches}
            unmatched={flow.unmatched}
            remembered={flow.remembered}
            manual={flow.manual}
            forgotten={flow.forgotten}
            onManualSearch={flow.handleManualSearch}
            onPickCandidate={flow.handlePickCandidate}
            onForget={flow.handleForgetLink}
            onOpenPlaylist={flow.handleOpenCreatedPlaylist}
            onClose={onClose}
          />
        )}
      </div>
    </Modal>
  );
};

export default ImportPlaylistModal;
