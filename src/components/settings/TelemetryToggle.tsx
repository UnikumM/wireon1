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
      description="Версия, платформа, имя в Discord и почему не заиграл трек — разработчику, чтобы чинить быстрее. IP-адреса и ссылки не отправляются и не хранятся."
      checked={enabled}
      onChange={(next) => {
        setTelemetryEnabled(next);
        setEnabled(next);
      }}
    />
  );
};
