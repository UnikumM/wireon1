import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    /*
     * Адрес сервера в прогоне пуст, и это защита, а не удобство.
     *
     * Vitest подхватывает `.env` так же, как сборка, — а в нём лежат настоящие
     * адрес и токен рабочего сервера. С ними синхронизация в тестах начинала
     * ходить в живой контейнер: прогон становился зависимым от сети, чужие
     * записи попадали в настоящее хранилище, а падало всё это в стороне от
     * причины. Тесту, которому сервер нужен, он задаётся через `vi.stubEnv`.
     */
    env: {
      VITE_WIREON_SERVER_URL: '',
      VITE_WIREON_SERVER_TOKEN: '',
      /*
       * Адрес брокера здесь по той же причине, только нашлась она дороже: он
       * оставался настоящим, и проверки, доходившие до звонка «медиатека
       * изменилась», открывали живое соединение к рабочему серверу. Прогон от
       * этого зависел от сети и плавал по времени — проверка, написанная на
       * «брокера нет», в одиночку видела одно, а в общем прогоне другое.
       */
      VITE_WIREON_MQTT_URL: ''
    },
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Measure the application, not its build output or its tooling. Left to the
      // default the report also counts dist-electron/ (a compiled copy of
      // electron/), scripts/ (icon generation, the dev launcher) and the
      // type-only modules — all permanently at 0%, which buries the number that
      // actually says something about how well the app is tested.
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: [
        'src/main.tsx', // ReactDOM bootstrap: three lines, nothing to assert
        'src/types/**', // interfaces and unions, no runtime code
        '**/index.ts', // re-export barrels
        '**/*.d.ts'
      ],
      // Set a couple of points under what the suite currently reaches
      // (82.0 / 80.3 / 75.6 / 82.0), so the gate is a floor that ratchets rather
      // than a number nobody can pass. Deleting tests to make a build green now
      // fails the build instead.
      //
      // Deliberately global and not per-file: the modules that sit low —
      // services/hls.ts, hooks/useMediaKeys.ts, hooks/useDominantColor.ts — are
      // thin wrappers over browser APIs jsdom does not implement (Media Source
      // Extensions, Electron global shortcuts, canvas pixel readback). Faking
      // those APIs would only test the fake, so they are covered by the manual
      // smoke pass instead of by a number.
      thresholds: {
        statements: 80,
        branches: 78,
        functions: 73,
        lines: 80
      }
    }
  }
});
