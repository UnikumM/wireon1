import React from 'react';
import { CloudCog, ListMusic, ShieldCheck } from 'lucide-react';
import { Button } from '../common/Button';
import { DiscordIcon, DiscordLoginButton } from './DiscordLoginButton';
import { useUIStore } from '../../store/useUIStore';
import { isDiscordConfigured } from '../../services/discordAuth';
import { ICON } from '../../styles/icons';

/**
 * Просьба войти в ответ на попытку что-то сохранить без аккаунта.
 *
 * Не то же самое, что `WelcomeGate`. То — вопрос при первом запуске, заданный
 * до всякого действия и с честным «можно и не входить». Это — ответ на
 * конкретное нажатие: человек добавлял трек в избранное или заводил плейлист, и
 * ему говорится, почему без аккаунта это не сработает. Отсюда и причина в
 * заголовке: без неё окно читается как случайная просьба зарегистрироваться, а
 * такие закрывают не читая.
 *
 * Рисуется у самого верха дерева — как лист действий на телефоне. Иначе окно
 * рождалось бы потомком той строки, по которой нажали, и исчезало бы вместе с
 * ней (список виртуализирован, строки уезжают за край).
 */
export const AccountPrompt: React.FC = () => {
  const accountPrompt = useUIStore((s) => s.accountPrompt);
  const closeAccountPrompt = useUIStore((s) => s.closeAccountPrompt);
  const showToast = useUIStore((s) => s.showToast);
  const configured = isDiscordConfigured();

  if (!accountPrompt) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-prompt-title"
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal)',
        display: 'flex',
        justifyContent: 'center',
        overflowY: 'auto',
        padding:
          'calc(var(--safe-top) + var(--space-4)) calc(var(--safe-right) + var(--space-4))' +
          ' calc(var(--safe-bottom) + var(--space-4)) calc(var(--safe-left) + var(--space-4))',
        backgroundColor: 'var(--scrim-strong)'
      } as React.CSSProperties}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeAccountPrompt();
      }}
      data-testid="account-prompt"
    >
      <div
        className="panel-raised animate-slide-up"
        style={{
          width: '100%',
          maxWidth: '460px',
          margin: 'auto',
          flexShrink: 0,
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <h2
            id="account-prompt-title"
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              lineHeight: 'var(--leading-xl)',
              letterSpacing: 'var(--tracking-xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            Войдите, чтобы {accountPrompt}
          </h2>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-secondary)'
            }}
            data-testid="account-prompt-detail"
          >
            Медиатека привязана к аккаунту Discord: по нему сервер и узнаёт, чья она.
            Без входа сохранять было бы некуда — собранное здесь не появилось бы ни
            на телефоне, ни на другом компьютере.
          </p>
        </div>

        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)'
          }}
        >
          <li style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, display: 'inline-flex', paddingTop: '2px', color: 'var(--text-muted)' }}>
              <CloudCog size={ICON.md} aria-hidden="true" />
            </span>
            <span style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)', color: 'var(--text-secondary)' }}>
              Плейлисты и избранное сами держатся в одном виде на телефоне и на компьютере.
            </span>
          </li>
          <li style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
            <span style={{ flexShrink: 0, display: 'inline-flex', paddingTop: '2px', color: 'var(--text-muted)' }}>
              <ListMusic size={ICON.md} aria-hidden="true" />
            </span>
            <span style={{ fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-sm)', color: 'var(--text-secondary)' }}>
              Уже собранное на этом устройстве не пропадёт — оно уедет в аккаунт при входе.
            </span>
          </li>
        </ul>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <DiscordLoginButton
            size="lg"
            fullWidth
            text="Войти через Discord"
            onSuccess={(user) => {
              closeAccountPrompt();
              showToast(`Вы вошли как ${user.username}.`, 'success');
            }}
            data-testid="account-prompt-login"
          />

          <Button variant="ghost" size="md" fullWidth onClick={closeAccountPrompt} data-testid="account-prompt-dismiss">
            Не сейчас
          </Button>
        </div>

        <p
          style={{
            margin: 0,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)',
            color: 'var(--text-muted)'
          }}
        >
          {configured ? <ShieldCheck size={ICON.xs} aria-hidden="true" /> : <DiscordIcon size={ICON.xs} />}
          {configured
            ? 'Discord сообщает только имя, аватар и e-mail. Токен хранится на этом устройстве.'
            : 'В этой сборке вход через Discord не настроен — сохранять пока некуда.'}
        </p>
      </div>
    </div>
  );
};

export default AccountPrompt;
