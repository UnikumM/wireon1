import React, { useState } from 'react';
import { ToggleSetting } from './SettingsPrimitives';
import { isTelemetryEnabled, setTelemetryEnabled } from '../../services/telemetry';

/** Выключатель статистики — в «Диагностике» и на ПК, и на телефоне. */
export const TelemetryToggle: React.FC = () => {
  const [enabled, setEnabled] = useState(isTelemetryEnabled);
  return (
    <ToggleSetting
      id="setting-telemetry"
      label="Отправлять статистику и ошибки"
      description="Версия, платформа, имя и id в Discord, случайный идентификатор установки, id трека и почему он не заиграл — разработчику, чтобы чинить быстрее. IP-адреса, ссылки и пути с именем пользователя вырезаются и не хранятся. Отчёт по кнопке «Отправить отчёт» уходит всегда."
      checked={enabled}
      onChange={(next) => {
        setTelemetryEnabled(next);
        setEnabled(next);
      }}
    />
  );
};
