import React, { useCallback, useRef, useState } from 'react';
import { Download, Upload, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { SettingsSection, SettingRow, InfoRow } from './SettingsPrimitives';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { exportLibrary, importLibrary, BackupError } from '../../services/backup';
import { downloadTextFile } from '../../utils/download';
import { ICON } from '../../styles/icons';

type ImportMode = 'merge' | 'replace';

function backupFilename(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `wireon-library-${stamp}.json`;
}

/** Export / import the local library and clear the listening history. */
export const LibrarySettings: React.FC = () => {
  const favorites = useLibraryStore((s) => s.favorites);
  const playlists = useLibraryStore((s) => s.playlists);
  const history = useLibraryStore((s) => s.history);
  const clearHistory = useLibraryStore((s) => s.clearHistory);
  const loadInitialData = useLibraryStore((s) => s.loadInitialData);
  const showToast = useUIStore((s) => s.showToast);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setIsExporting(true);
    try {
      const backup = await exportLibrary();
      downloadTextFile(backupFilename(), 'application/json', JSON.stringify(backup, null, 2));
      showToast(
        `Выгружено: ${backup.playlists.length} плейлистов и ${backup.favorites.length} избранных`,
        'success'
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      showToast(`Экспорт не удался: ${detail}`, 'error');
    } finally {
      setIsExporting(false);
    }
  }, [showToast]);

  /** Shared by the direct merge path and the confirmed replace path. */
  const runImport = useCallback(
    async (json: string, mode: ImportMode) => {
      setIsImporting(true);
      try {
        const summary = await importLibrary(json, mode);
        await loadInitialData();
        showToast(
          `Загружено: ${summary.playlists} плейлистов, ${summary.favorites} избранных, ${summary.history} записей истории`,
          'success'
        );
      } catch (err) {
        const message =
          err instanceof BackupError ? err.message : `Импорт не удался: ${err instanceof Error ? err.message : String(err)}`;
        showToast(message, 'error');
      } finally {
        setIsImporting(false);
      }
    },
    [loadInitialData, showToast]
  );

  const handleFileChosen = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared immediately so re-picking the same file fires `change` again.
      event.target.value = '';
      if (!file) return;

      let json: string;
      try {
        json = await file.text();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        showToast(`Не удалось прочитать файл: ${detail}`, 'error');
        return;
      }

      if (importMode === 'replace') {
        setConfirmReplace(json);
        return;
      }
      await runImport(json, 'merge');
    },
    [importMode, runImport, showToast]
  );

  const handleClearHistory = useCallback(async () => {
    setConfirmClearOpen(false);
    const ok = await clearHistory();
    showToast(ok ? 'История прослушиваний очищена' : 'Не удалось очистить историю', ok ? 'success' : 'error');
  }, [clearHistory, showToast]);

  return (
    <SettingsSection
      id="library"
      title="Медиатека и резервные копии"
      description="Всё хранится на этом устройстве. Резервная копия — один JSON-файл, который можно перенести куда угодно."
    >
      <InfoRow label="Хранится локально" description="Данные из локальной базы IndexedDB этой установки.">
        <span data-numeric style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {playlists.length} плейлистов · {favorites.length} избранных · {history.length} прослушано
        </span>
      </InfoRow>

      <div className="divider" />

      <SettingRow
        label="Выгрузить медиатеку"
        controlId="library-export"
        description="Сохраняет плейлисты, избранное, историю и настройки одним JSON-файлом."
      >
        <Button
          id="library-export"
          variant="secondary"
          size="sm"
          icon={<Download size={ICON.sm} />}
          isLoading={isExporting}
          onClick={handleExport}
          data-testid="library-export"
        >
          Выгрузить
        </Button>
      </SettingRow>

      <SettingRow
        label="Загрузить медиатеку"
        controlId="library-import-mode"
        description="«Объединить» оставляет всё имеющееся и добавляет недостающее. «Заменить» сначала стирает локальную медиатеку."
      >
        <select
          id="library-import-mode"
          value={importMode}
          onChange={(e) => setImportMode(e.target.value as ImportMode)}
          data-testid="library-import-mode"
          style={{ minWidth: '104px' }}
        >
          <option value="merge">Объединить</option>
          <option value="replace">Заменить</option>
        </select>
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={ICON.sm} />}
          isLoading={isImporting}
          onClick={() => fileInputRef.current?.click()}
          data-testid="library-import"
        >
          Выбрать файл
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileChosen}
          style={{ display: 'none' }}
          data-testid="library-import-file"
        />
      </SettingRow>

      <div className="divider" />

      <SettingRow
        label="Очистить историю прослушиваний"
        controlId="library-clear-history"
        description="Удаляет все записи о прослушанных треках. Плейлисты и избранное не тронуты."
      >
        <Button
          id="library-clear-history"
          variant="danger"
          size="sm"
          icon={<Trash2 size={ICON.sm} />}
          disabled={history.length === 0}
          onClick={() => setConfirmClearOpen(true)}
          data-testid="library-clear-history"
        >
          Очистить
        </Button>
      </SettingRow>

      <ConfirmDialog
        isOpen={confirmClearOpen}
        title="Очистить историю прослушиваний?"
        description={`С устройства будет удалено ${history.length} записей. Отменить это нельзя.`}
        confirmLabel="Очистить историю"
        danger
        onConfirm={handleClearHistory}
        onCancel={() => setConfirmClearOpen(false)}
      />

      <ConfirmDialog
        isOpen={confirmReplace !== null}
        title="Заменить локальную медиатеку?"
        description="Текущие плейлисты, избранное и история будут удалены и восстановлены из файла копии. Отменить это нельзя."
        confirmLabel="Заменить медиатеку"
        danger
        onConfirm={() => {
          const json = confirmReplace;
          setConfirmReplace(null);
          if (json !== null) void runImport(json, 'replace');
        }}
        onCancel={() => setConfirmReplace(null)}
      />
    </SettingsSection>
  );
};

export default LibrarySettings;
