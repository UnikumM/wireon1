import React, { useCallback, useEffect, useState } from 'react';
import { CloudCog, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { Button } from '../common/Button';
import { DiscordIcon, DiscordLoginButton } from './DiscordLoginButton';
import { useDiscordLogin } from './useDiscordLogin';
import { useAuthStore } from '../../store/useAuthStore';
import { useUIStore } from '../../store/useUIStore';
import { isDiscordConfigured } from '../../services/discordAuth';
import { ICON } from '../../styles/icons';

/** Отметка о том, что выбор «войти или как гость» уже сделан. */
export const STORAGE_KEY_INTRO_SEEN = 'wireon_auth_intro_seen';

/** True, если приглашение уже показывали и решение принято. */
export function hasSeenAuthIntro(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    return localStorage.getItem(STORAGE_KEY_INTRO_SEEN) === '1';
  } catch {
    // Приватный режим без localStorage: не мешаем — считаем, что видел.
    return true;
  }
}

export function markAuthIntroSeen(): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    localStorage.setItem(STORAGE_KEY_INTRO_SEEN, '1');
  } catch {
    // Не критично: в худшем случае приглашение покажется ещё раз.
  }
}

/** Что аккаунт даёт на самом деле — без обещаний, которых приложение не держит. */
const PERKS: Array<{ icon: React.ReactNode; title: string; detail: string }> = [
  {
    icon: <Users size={ICON.md} aria-hidden="true" />,
    title: 'Имя и аватар в совместном прослушивании',
    detail: 'В комнате видно, кто пришёл и кто что поставил, — а не «Участник 2».'
  },
  {
    // Не Sparkles: речь о том, что вход запомнился, а звёздочки означали бы
    // «что-то приятное вообще» — то есть ничего.
    icon: <UserCheck size={ICON.md} aria-hidden="true" />,
    title: 'Приложение узнаёт вас после перезапуска',
    detail: 'Сессия живёт неделю: заходить каждый день не нужно.'
  },
  {
    // Раньше здесь стояло «Медиатека остаётся на этом устройстве»: сервера у
    // Wireon Sounds тогда действительно не было. Теперь есть, медиатека
    // привязана к аккаунту, и обещание превратилось бы в обман — плейлисты
    // гостя и правда никуда не поедут, только не по нашей доброте, а потому что
    // ехать им некуда.
    icon: <CloudCog size={ICON.md} aria-hidden="true" />,
    title: 'Плейлисты и избранное на всех устройствах',
    detail: 'Собранное на компьютере само оказывается на телефоне. Без аккаунта сохранять некуда.'
  }
];

/**
 * Приглашение при первом запуске: войти через Discord или остаться гостем.
 *
 * Регистрации в привычном смысле у Wireon Sounds нет и не нужно — учётную запись даёт
 * Discord, приложение просит только `identify` и `email`. Поэтому это экран
 * выбора, а не форма: он показывается один раз, запоминает решение и больше не
 * встаёт на пути. Пропустить можно всегда — без аккаунта работает всё, кроме
 * подписанного имени в комнате.
 */
export const WelcomeGate: React.FC = () => {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authStatus = useAuthStore((s) => s.authStatus);
  const showToast = useUIStore((s) => s.showToast);

  // Решение о показе принимается один раз: иначе экран мигнёт посреди сессии,
  // когда токен истечёт и store вернётся в гостя.
  const [isVisible, setIsVisible] = useState(() => !hasSeenAuthIntro());
  const configured = isDiscordConfigured();

  const dismiss = useCallback(() => {
    markAuthIntroSeen();
    setIsVisible(false);
  }, []);

  const { continueAsGuest } = useDiscordLogin();

  // Уже вошедшему (сессия восстановилась из хранилища) показывать нечего.
  useEffect(() => {
    if (isAuthenticated) dismiss();
  }, [dismiss, isAuthenticated]);

  if (!isVisible || isAuthenticated || authStatus === 'authenticating') return null;

  const handleGuest = () => {
    continueAsGuest();
    dismiss();
    showToast('Слушаем без аккаунта. Войти можно в любой момент в настройках.', 'info');
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-gate-title"
      className="animate-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal)',
        display: 'flex',
        justifyContent: 'center',
        /*
         * Прокрутка и `margin: auto` у карточки вместо `alignItems: center`.
         * Отцентрованный флекс-элемент, который выше контейнера, вылезает
         * *в обе стороны*, и верх при прокрутке недостижим — в браузерах это
         * так и работает. На экране 360×640 у карточки пропадал заголовок
         * «Войти через Discord?», и вернуть его было нечем.
         * `margin: auto` центрирует ровно так же, пока место есть, и честно
         * отдаёт прокрутку, когда его нет.
         */
        overflowY: 'auto',
        /*
         * Безопасные зоны: карточка накрывает экран целиком (viewport-fit=cover),
         * поэтому без этих отступов её край уходит под часы и под полосу жеста.
         */
        padding:
          'calc(var(--safe-top) + var(--space-4)) calc(var(--safe-right) + var(--space-4))' +
          ' calc(var(--safe-bottom) + var(--space-4)) calc(var(--safe-left) + var(--space-4))',
        backgroundColor: 'var(--scrim-strong)'
      } as React.CSSProperties}
      data-testid="welcome-gate"
    >
      <div
        className="panel-raised animate-slide-up"
        style={{
          width: '100%',
          maxWidth: '520px',
          margin: 'auto',
          flexShrink: 0,
          padding: 'var(--space-6)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-5)'
        }}
      >
        {/*
          * Было по шаблону посадочной страницы: надзаголовок «ДОБРО ПОЖАЛОВАТЬ»,
          * под ним название приложения крупным кеглем. Но человек уже запустил
          * Wireon Sounds — сообщать ему название незачем, а приветствие не несёт
          * никакого смысла вообще. Экран существует ради одного вопроса, поэтому
          * вопрос и стоит в заголовке.
          */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <h1
            id="welcome-gate-title"
            style={{
              margin: 0,
              fontSize: 'var(--text-xl)',
              lineHeight: 'var(--leading-xl)',
              letterSpacing: 'var(--tracking-xl)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            Войти через Discord?
          </h1>
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-secondary)'
            }}
          >
            Отдельного пароля здесь нет: вход через Discord — это и есть регистрация.
            Слушать можно и без аккаунта, но плейлисты и избранное появятся только с ним.
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
          {PERKS.map((perk) => (
            <li key={perk.title} style={{ display: 'flex', gap: 'var(--space-3)' }}>
              {/*
                * Иконка стоит без рамки и подложки. Плитка 32×32 вокруг неё ничего
                * не отделяла — текст и так справа, — а три таких плитки в столбик
                * превращали честный список в сетку «преимуществ».
                */}
              <span
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  paddingTop: '2px',
                  color: 'var(--text-muted)'
                }}
              >
                {perk.icon}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 'var(--text-sm)',
                    lineHeight: 'var(--leading-sm)',
                    fontWeight: 'var(--weight-medium)',
                    color: 'var(--text-primary)'
                  }}
                >
                  {perk.title}
                </span>
                <span
                  style={{
                    fontSize: 'var(--text-xs)',
                    lineHeight: 'var(--leading-xs)',
                    color: 'var(--text-muted)'
                  }}
                >
                  {perk.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <DiscordLoginButton
            size="lg"
            fullWidth
            text="Войти через Discord"
            onSuccess={(user) => {
              dismiss();
              showToast(`Вы вошли как ${user.username}.`, 'success');
            }}
            data-testid="welcome-gate-login"
          />

          <Button variant="ghost" size="md" fullWidth onClick={handleGuest} data-testid="welcome-gate-guest">
            Продолжить без аккаунта
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
          data-testid="welcome-gate-scopes"
        >
          {configured ? <ShieldCheck size={ICON.xs} aria-hidden="true" /> : <DiscordIcon size={ICON.xs} />}
          {configured
            ? 'Discord сообщает только имя, аватар и e-mail. Токен хранится на этом устройстве.'
            : 'В этой сборке вход через Discord не настроен — можно продолжить без аккаунта.'}
        </p>
      </div>
    </div>
  );
};

export default WelcomeGate;
