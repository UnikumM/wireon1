import React, { useState, useEffect, useRef } from 'react';
import {
  Users,
  Radio,
  Copy,
  Check,
  LogIn,
  LogOut,
  Crown,
  Wifi,
  WifiOff,
  HelpCircle,
  Music2,
  Send,
  MessageSquare,
  Loader2,
  MonitorSmartphone
} from 'lucide-react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ICON } from '../../styles/icons';
import { useGroupListenStore } from '../../store/useGroupListenStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import type { GroupConnectionStatus } from '../../services/groupListenService';

export interface GroupListenModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * How the room describes itself to the user.
 *
 * `local` is the one that matters: the room exists, but no broker could be
 * reached, so nobody outside this computer can hear it. Showing that as "в
 * эфире" is exactly what made group listening look broken — everything seemed
 * fine right up until the other person said they saw nothing.
 *
 * Colours are state tokens, not hexes: the badge has to keep its meaning after
 * the user switches the theme, and a literal green would stay dark-theme green
 * on a white surface.
 */
const CONNECTION_COPY: Record<
  GroupConnectionStatus,
  { badge: string; title: string; hint: string; color: string; soft: string }
> = {
  online: {
    badge: 'В эфире',
    title: 'Синхронизация активна',
    hint: 'Всё, что вы включаете, слышат остальные участники комнаты.',
    color: 'var(--success)',
    soft: 'var(--success-soft)'
  },
  connecting: {
    badge: 'Подключение',
    title: 'Подключаемся к серверу синхронизации',
    hint: 'Комната уже создана — как только соединение установится, к ней смогут присоединиться друзья.',
    color: 'var(--warning)',
    soft: 'var(--warning-soft)'
  },
  local: {
    badge: 'Только здесь',
    title: 'Только это устройство',
    hint: 'Сервер синхронизации недоступен, поэтому комната работает лишь между окнами этого компьютера.',
    color: 'var(--warning)',
    soft: 'var(--warning-soft)'
  },
  offline: {
    badge: 'Не в комнате',
    title: 'Нет активной комнаты',
    hint: 'Создайте комнату или войдите по коду.',
    color: 'var(--text-muted)',
    soft: 'var(--surface-2)'
  }
};

export const GroupListenModal: React.FC<GroupListenModalProps> = ({ isOpen, onClose }) => {
  const roomId = useGroupListenStore((s) => s.roomId);
  const isHost = useGroupListenStore((s) => s.isHost);
  const hostId = useGroupListenStore((s) => s.hostId);
  const isConnected = useGroupListenStore((s) => s.isConnected);
  const connectionStatus = useGroupListenStore((s) => s.connectionStatus);
  const connectionError = useGroupListenStore((s) => s.connectionError);
  const participants = useGroupListenStore((s) => s.participants);
  const isSyncing = useGroupListenStore((s) => s.isSyncing);
  const storeError = useGroupListenStore((s) => s.error);
  const chatMessages = useGroupListenStore((s) => s.chatMessages);
  const chatListRef = useRef<HTMLDivElement | null>(null);

  /*
   * Новое сообщение — список сам уезжает вниз. Без этого, чтобы увидеть ответ,
   * приходилось каждый раз прокручивать вручную.
   */
  useEffect(() => {
    const list = chatListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chatMessages.length]);

  const createRoom = useGroupListenStore((s) => s.createRoom);
  const joinRoom = useGroupListenStore((s) => s.joinRoom);
  const leaveRoom = useGroupListenStore((s) => s.leaveRoom);
  const sendChat = useGroupListenStore((s) => s.sendChat);
  const clearError = useGroupListenStore((s) => s.clearError);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const showToast = useUIStore((s) => s.showToast);

  const [tab, setTab] = useState<'host' | 'join'>('host');
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [showChat, setShowChat] = useState(false);

  const awaitingHost = isConnected && !isHost && !hostId && !participants.some((participant) => participant.isHost);
  const connection = awaitingHost && connectionStatus === 'online' ? {
    badge: 'Ждём ведущего', title: 'Синхронизация приостановлена',
    hint: 'Ведущий пока не подключён. Музыка играет только у вас.',
    color: 'var(--warning)', soft: 'var(--warning-soft)'
  } : CONNECTION_COPY[connectionStatus] ?? CONNECTION_COPY.offline;

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      clearError();
      setCopied(false);
      setJoinCode('');
    }
  }, [isOpen, clearError]);

  useEffect(() => {
    if (storeError) {
      setError(storeError);
    }
  }, [storeError]);

  const handleCreateRoom = async () => {
    try {
      setLoading(true);
      setError(null);
      const code = await createRoom();
      showToast(`Комната ${code} создана`, 'success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось создать комнату';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const sanitized = joinCode.trim().toUpperCase();
    if (sanitized.length !== 6) {
      setError('Код комнаты состоит ровно из 6 символов');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      await joinRoom(sanitized);
      showToast(`Вы в комнате ${sanitized}`, 'success');
      setJoinCode('');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Не удалось войти в комнату';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyCode = () => {
    if (!roomId) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(roomId);
      }
      setCopied(true);
      showToast(`Код ${roomId} скопирован`, 'info');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      showToast(`Код комнаты: ${roomId}`, 'info');
    }
  };

  const handleCopyShareLink = () => {
    if (!roomId) return;
    const shareUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}/#room=${roomId}`
        : `wireon://room/${roomId}`;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(shareUrl);
      }
      setCopied(true);
      showToast('Ссылка-приглашение скопирована', 'info');
    } catch {
      showToast(`Ссылка: ${shareUrl}`, 'info');
    }
  };

  const handleLeaveRoom = () => {
    leaveRoom();
    showToast(isHost ? 'Комната закрыта' : 'Вы вышли из комнаты', 'info');
  };

  const handleSendChat = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!chatInput.trim()) return;
    sendChat(chatInput.trim());
    setChatInput('');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="540px"
      title={
        <div className="group-listen-title row gap-2">
          <Radio size={ICON.lg} className="text-secondary" />
          <span>Слушать вместе</span>
          {isConnected && (
            <span
              data-testid="group-listen-badge"
              data-status={connectionStatus}
              style={{
                fontSize: 'var(--text-xs)',
                fontWeight: 'var(--weight-semibold)',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: connection.soft,
                color: connection.color,
                border: `1px solid ${connection.soft}`,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: connection.color,
                  boxShadow: connectionStatus === 'online' ? `0 0 6px ${connection.color}` : 'none'
                }}
              />
              {connection.badge}
            </span>
          )}
        </div>
      }
      data-testid="group-listen-modal"
    >
      <div className="stack gap-4">
        {/* Connected Active Room View */}
        {isConnected && roomId ? (
          <div className="stack gap-4">
            {/* Room Banner */}
            <div
              className="radius-lg p-4 stack gap-3 bg-surface-3 border-line"
            >
              <div className="group-listen-room-row row justify-between">
                <div>
                  <div className="section-label">Код комнаты</div>
                  <div
                    data-testid="group-listen-room-code"
                    style={{
                      fontSize: 'var(--text-2xl)',
                      fontWeight: 'var(--weight-bold)',
                      letterSpacing: '0.15em',
                      color: 'var(--text-primary)',
                      // Не 'monospace': код комнаты диктуют вслух, и важно, чтобы
                      // ноль и «O» отличались. Это даёт гарнитура из движка, а не
                      // моноширинный шрифт по умолчанию в системе.
                      fontFamily: 'var(--font-mono)'
                    }}
                  >
                    {roomId}
                  </div>
                </div>

                <div className="group-listen-room-actions row-stretch gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleCopyCode}
                    icon={copied ? <Check size={ICON.sm} className="text-success" /> : <Copy size={ICON.sm} />}
                    data-testid="group-listen-copy-btn"
                  >
                    {copied ? 'Скопировано' : 'Копировать код'}
                  </Button>
                  <Button size="sm" variant="subtle" onClick={handleCopyShareLink} title="Скопировать ссылку-приглашение">
                    Ссылка
                  </Button>
                </div>
              </div>

              {/* Connection truth: whether anyone outside this machine can hear it */}
              <div
                data-testid="group-listen-connection"
                data-status={connectionStatus}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: connection.soft,
                  border: `1px solid ${connection.soft}`
                }}
              >
                <span className="shrink-0" style={{ color: connection.color, marginTop: '1px' }}>
                  {connectionStatus === 'online' ? (
                    <Wifi size={ICON.sm} />
                  ) : connectionStatus === 'connecting' ? (
                    <Loader2 size={ICON.sm} className="animate-spin" />
                  ) : connectionStatus === 'local' ? (
                    <MonitorSmartphone size={ICON.sm} />
                  ) : (
                    <WifiOff size={ICON.sm} />
                  )}
                </span>
                <div className="min-0">
                  <div className="text-xs weight-semibold" style={{ color: connection.color }}>
                    {connection.title}
                  </div>
                  <div className="text-xs text-secondary" style={{ lineHeight: 1.45 }}>
                    {connection.hint}
                  </div>
                  {connectionError && connectionStatus !== 'online' && (
                    <div
                      data-testid="group-listen-connection-error"
                      className="text-xs text-muted mt-px"
                    >
                      Причина: {connectionError}
                    </div>
                  )}
                </div>
              </div>

              {/* Status and Role Badges */}
              <div className="row gap-2 wrap">
                <span
                  className="inline-row text-xs radius-full gap-1 border-subtle" style={{ padding: '2px 8px', backgroundColor: isHost ? 'var(--warning-soft)' : 'var(--surface-2)', color: isHost ? 'var(--warning)' : 'var(--text-secondary)' }}
                >
                  {isHost ? <Crown size={ICON.xs} /> : <Users size={ICON.xs} />}
                  {isHost ? 'Вы ведущий' : 'Вы слушаете'}
                </span>

                <span
                  data-testid="group-listen-sync-badge"
                  className="inline-row text-xs radius-full gap-1 border-subtle" style={{ padding: '2px 8px', backgroundColor: isSyncing ? 'var(--info-soft)' : 'var(--surface-2)', color: isSyncing ? 'var(--info)' : 'var(--text-muted)' }}
                >
                  <Wifi size={ICON.xs} />
                  {awaitingHost ? 'Нет ведущего' : isSyncing ? 'Подстраиваемся…' : 'Совпадает'}
                </span>
              </div>
            </div>

            {/* Currently Playing in Room */}
            {currentTrack && (
              <div
                className="row gap-3 p-3 radius-md bg-surface-2 border-subtle"
              >
                <img
                  src={currentTrack.artworkUrl || ''}
                  alt=""
                  className="radius-sm bg-surface-4" style={{ width: '40px', height: '40px', objectFit: 'cover' }}
                />
                <div className="grow">
                  <div
                    className="text-truncate text-sm weight-semibold text-primary"
                  >
                    {currentTrack.title}
                  </div>
                  <div className="text-truncate text-xs text-muted">
                    {currentTrack.artist} • {isPlaying ? 'играет' : 'на паузе'}
                  </div>
                </div>
                <Music2 size={ICON.md} className="text-accent shrink-0" />
              </div>
            )}

            {/* Participants Section */}
            <div className="stack gap-2">
              {/*
                * Капс раньше стоял на всей строке, а не на подписи, поэтому его
                * наследовала и кнопка справа: «ЧАТ (0)». Теперь регистр — забота
                * самой подписи.
                */}
              <div
                className="group-listen-participants-heading row justify-between"
              >
                <span className="section-label">Участники ({participants.length})</span>
                <button
                  type="button"
                  onClick={() => setShowChat(!showChat)}
                  data-testid="group-listen-chat-toggle"
                  className="pointer row text-sm bg-none border-none gap-1 tracking-sm" style={{ color: showChat ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  <MessageSquare size={ICON.xs} />
                  {showChat ? 'Скрыть чат' : `Чат (${chatMessages.length})`}
                </button>
              </div>

              <div
                data-testid="group-listen-participant-list"
                className="scrollbar-thin stack gap-1 p-2 radius-md bg-sunken border-subtle"
                style={{ maxHeight: '140px', overflowY: 'auto' }}
              >
                {participants.length === 0 ? (
                  <div
                    className="p-2 text-xs text-muted text-center"
                  >
                    Пока никого нет. Отправьте код друзьям.
                  </div>
                ) : (
                  participants.map((p) => (
                    <div
                      key={p.id}
                      className="row justify-between radius-sm text-xs bg-surface-2" style={{ padding: '4px 8px' }}
                    >
                      <div className="group-listen-participant-identity row gap-2">
                        {p.avatarUrl ? (
                          <img
                            className="group-listen-participant-avatar"
                            src={p.avatarUrl}
                            alt=""
                            style={{ width: '20px', height: '20px', borderRadius: '50%' }}
                          />
                        ) : (
                          <div
                            className="group-listen-participant-avatar row justify-center text-xs weight-semibold text-primary bg-surface-4"
                            style={{ width: '20px', height: '20px', borderRadius: '50%' }}
                          >
                            {p.username.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="group-listen-participant-name weight-medium text-primary">{p.username}</span>
                      </div>

                      {p.isHost && (
                        <span
                          className="group-listen-host-badge inline-row gap-px text-xs text-warning radius-xs bg-warning-soft"
                          style={{ padding: '1px 5px' }}
                        >
                          <Crown size={ICON.xs} /> Ведущий
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Chat Drawer */}
            {showChat && (
              <div
                // Чат раскрывается по нажатию и ровно под своей кнопкой —
                // случай, для которого выпадение и заведено: панель растёт от
                // верхнего края, продолжая нажатие, а не возникает сама собой.
                className="animate-drop-in stack gap-2 p-3 radius-md bg-sunken border-line"
              >
                <div
                  ref={chatListRef}
                  className="scrollbar-thin stack gap-1"
                  data-testid="group-listen-chat-list"
                  style={{ maxHeight: '120px', overflowY: 'auto' }}
                >
                  {chatMessages.length === 0 ? (
                    <div
                      className="text-xs text-muted text-center p-2"
                    >
                      Сообщений пока нет.
                    </div>
                  ) : (
                    chatMessages.map((m) => (
                      <div key={m.id} className="text-xs">
                        <span className="weight-semibold text-secondary">{m.senderName}: </span>
                        <span className="text-primary">{m.text}</span>
                      </div>
                    ))
                  )}
                </div>

                <form className="group-listen-chat-form row-stretch gap-2" onSubmit={handleSendChat}>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Написать сообщение…"
                    aria-label="Сообщение в чат комнаты"
                    data-testid="group-listen-chat-input"
                    className="flex-1 radius-sm text-primary text-xs bg-surface-2 border-line" style={{ padding: '4px 8px' }}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="secondary"
                    icon={<Send size={ICON.xs} />}
                    data-testid="group-listen-send-chat-btn"
                  >
                    Отправить
                  </Button>
                </form>
              </div>
            )}

            {/* Leave Room Action */}
            <div className="row-stretch justify-end pt-2">
              <Button
                variant="danger"
                size="sm"
                onClick={handleLeaveRoom}
                icon={<LogOut size={ICON.sm} />}
                data-testid="group-listen-leave-btn"
              >
                {isHost ? 'Закрыть комнату' : 'Выйти'}
              </Button>
            </div>
          </div>
        ) : (
          /* Not Connected: Host / Join Tabs */
          <div className="stack gap-4">
            {/* Tabs Header */}
            <div
              role="tablist"
              aria-label="Как присоединиться"
              className="segmented"
              data-index={tab === 'host' ? 0 : 1}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'host'}
                onClick={() => {
                  setTab('host');
                  setError(null);
                }}
                data-testid="group-listen-host-tab"
                // Вид — в `.segmented-tab` (global.css §13), состояние
                // читается из `aria-selected`. Инлайновые цвета глушили бы
                // ховер: инлайн старше правила таблицы стилей.
                className="segmented-tab"
              >
                Создать
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'join'}
                onClick={() => {
                  setTab('join');
                  setError(null);
                }}
                data-testid="group-listen-join-tab"
                className="segmented-tab"
              >
                Войти по коду
              </button>
            </div>

            {/* Error banner */}
            {error && (
              <div
                role="alert"
                data-testid="group-listen-error"
                // Отказ приходит в ответ на нажатие, и его надо заметить:
                // строка, появившаяся между кадрами, теряется среди того, что
                // уже было на месте.
                className="animate-drop-in text-danger radius-sm text-xs py-2 px-3 bg-danger-soft"
                style={{ border: '1px solid var(--danger)' }}
              >
                {error}
              </div>
            )}

            {/* Tab: Host */}
            {tab === 'host' ? (
              <div key="host" className="animate-fade-in stack gap-4">
                <div className="text-sm text-secondary" style={{ lineHeight: 1.5 }}>
                  Включайте музыку — остальные услышат то же самое и в тот же момент. Пауза, перемотка и смена
                  трека повторяются у всех, задержка сети учитывается автоматически.
                </div>

                <div
                  className="radius-md p-3 stack gap-2 bg-surface-2 border-subtle"
                >
                  <div
                    className="row gap-2 text-xs text-primary weight-semibold"
                  >
                    {/* Пояснение, а не сюрприз: значок справки. */}
                    <HelpCircle size={ICON.sm} className="text-secondary" />
                    <span>Как это работает</span>
                  </div>
                  <ul
                    className="m-0 text-xs text-muted stack gap-1" style={{ paddingLeft: '20px' }}
                  >
                    <li>Код из 6 символов — им и делятся с друзьями</li>
                    <li>Расхождение больше 0,35 с выправляется само</li>
                    <li>Очередь целиком уходит всем участникам</li>
                    <li>Кто присоединился позже — попадает на текущую секунду</li>
                  </ul>
                </div>

                <Button
                  variant="primary"
                  size="md"
                  onClick={handleCreateRoom}
                  disabled={loading}
                  icon={<Radio size={ICON.md} />}
                  data-testid="group-listen-create-btn"
                  style={{ width: '100%' }}
                >
                  {loading ? 'Создаём комнату…' : 'Создать комнату'}
                </Button>
              </div>
            ) : (
              /* Tab: Join */
              <form
                key="join"
                className="animate-fade-in stack gap-4"
                onSubmit={handleJoinRoom}
              >
                <div className="text-sm text-secondary" style={{ lineHeight: 1.5 }}>
                  Введите код из 6 символов, который дал ведущий, — и вы подключитесь к его прослушиванию.
                </div>

                <div className="stack gap-2">
                  <label htmlFor="group-listen-code-input" className="section-label">
                    Код комнаты
                  </label>
                  <input
                    id="group-listen-code-input"
                    type="text"
                    maxLength={6}
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="например VR7K9X"
                    autoComplete="off"
                    data-testid="group-listen-code-input"
                    className="p-3 radius-md text-xl weight-bold text-center text-primary" style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.2em', textTransform: 'uppercase' }}
                  />
                </div>

                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  disabled={loading || joinCode.trim().length !== 6}
                  icon={<LogIn size={ICON.md} />}
                  data-testid="group-listen-join-btn"
                  style={{ width: '100%' }}
                >
                  {loading ? 'Подключаемся…' : 'Войти в комнату'}
                </Button>
              </form>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
