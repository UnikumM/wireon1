import React, { useState, useEffect } from 'react';
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
  const isConnected = useGroupListenStore((s) => s.isConnected);
  const connectionStatus = useGroupListenStore((s) => s.connectionStatus);
  const connectionError = useGroupListenStore((s) => s.connectionError);
  const participants = useGroupListenStore((s) => s.participants);
  const isSyncing = useGroupListenStore((s) => s.isSyncing);
  const storeError = useGroupListenStore((s) => s.error);
  const chatMessages = useGroupListenStore((s) => s.chatMessages);

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

  const connection = CONNECTION_COPY[connectionStatus] ?? CONNECTION_COPY.offline;

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
        : `https://wireon.app/#room=${roomId}`;
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Radio size={ICON.lg} style={{ color: 'var(--text-secondary)' }} />
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {/* Connected Active Room View */}
        {isConnected && roomId ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Room Banner */}
            <div
              style={{
                backgroundColor: 'var(--surface-3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-4)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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

                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleCopyCode}
                    icon={copied ? <Check size={ICON.sm} style={{ color: 'var(--success)' }} /> : <Copy size={ICON.sm} />}
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
                <span style={{ color: connection.color, flexShrink: 0, marginTop: '1px' }}>
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
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', color: connection.color }}>
                    {connection.title}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    {connection.hint}
                  </div>
                  {connectionError && connectionStatus !== 'online' && (
                    <div
                      data-testid="group-listen-connection-error"
                      style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px' }}
                    >
                      Причина: {connectionError}
                    </div>
                  )}
                </div>
              </div>

              {/* Status and Role Badges */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: 'var(--text-xs)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: isHost ? 'var(--warning-soft)' : 'var(--surface-2)',
                    color: isHost ? 'var(--warning)' : 'var(--text-secondary)',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  {isHost ? <Crown size={ICON.xs} /> : <Users size={ICON.xs} />}
                  {isHost ? 'Вы ведущий' : 'Вы слушаете'}
                </span>

                <span
                  data-testid="group-listen-sync-badge"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: 'var(--text-xs)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: isSyncing ? 'var(--info-soft)' : 'var(--surface-2)',
                    color: isSyncing ? 'var(--info)' : 'var(--text-muted)',
                    border: '1px solid var(--border-subtle)'
                  }}
                >
                  <Wifi size={ICON.xs} />
                  {isSyncing ? 'Подстраиваемся…' : 'Совпадает'}
                </span>
              </div>
            </div>

            {/* Currently Playing in Room */}
            {currentTrack && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3)',
                  backgroundColor: 'var(--surface-2)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <img
                  src={currentTrack.artworkUrl || ''}
                  alt=""
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: 'var(--radius-sm)',
                    objectFit: 'cover',
                    backgroundColor: 'var(--surface-4)'
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    className="text-truncate"
                    style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}
                  >
                    {currentTrack.title}
                  </div>
                  <div className="text-truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {currentTrack.artist} • {isPlaying ? 'играет' : 'на паузе'}
                  </div>
                </div>
                <Music2 size={ICON.md} style={{ color: 'var(--accent)', flexShrink: 0 }} />
              </div>
            )}

            {/* Participants Section */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {/*
                * Капс раньше стоял на всей строке, а не на подписи, поэтому его
                * наследовала и кнопка справа: «ЧАТ (0)». Теперь регистр — забота
                * самой подписи.
                */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <span className="section-label">Участники ({participants.length})</span>
                <button
                  type="button"
                  onClick={() => setShowChat(!showChat)}
                  data-testid="group-listen-chat-toggle"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: showChat ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: 'var(--text-sm)',
                    letterSpacing: 'var(--tracking-sm)'
                  }}
                >
                  <MessageSquare size={ICON.xs} />
                  {showChat ? 'Скрыть чат' : `Чат (${chatMessages.length})`}
                </button>
              </div>

              <div
                data-testid="group-listen-participant-list"
                className="scrollbar-thin"
                style={{
                  maxHeight: '140px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                  backgroundColor: 'var(--surface-sunken)',
                  padding: 'var(--space-2)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                {participants.length === 0 ? (
                  <div
                    style={{
                      padding: 'var(--space-2)',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-muted)',
                      textAlign: 'center'
                    }}
                  >
                    Пока никого нет. Отправьте код друзьям.
                  </div>
                ) : (
                  participants.map((p) => (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '4px 8px',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: 'var(--surface-2)',
                        fontSize: 'var(--text-xs)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                        {p.avatarUrl ? (
                          <img
                            src={p.avatarUrl}
                            alt=""
                            style={{ width: '20px', height: '20px', borderRadius: '50%' }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '20px',
                              height: '20px',
                              borderRadius: '50%',
                              backgroundColor: 'var(--surface-4)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 'var(--text-xs)',
                              fontWeight: 'var(--weight-semibold)',
                              color: 'var(--text-primary)'
                            }}
                          >
                            {p.username.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span style={{ fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{p.username}</span>
                      </div>

                      {p.isHost && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '2px',
                            fontSize: 'var(--text-xs)',
                            color: 'var(--warning)',
                            backgroundColor: 'var(--warning-soft)',
                            padding: '1px 5px',
                            borderRadius: 'var(--radius-xs)'
                          }}
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
                className="animate-drop-in"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  backgroundColor: 'var(--surface-sunken)',
                  padding: 'var(--space-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)'
                }}
              >
                <div
                  className="scrollbar-thin"
                  style={{
                    maxHeight: '120px',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px'
                  }}
                >
                  {chatMessages.length === 0 ? (
                    <div
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--text-muted)',
                        textAlign: 'center',
                        padding: 'var(--space-2)'
                      }}
                    >
                      Сообщений пока нет.
                    </div>
                  ) : (
                    chatMessages.map((m) => (
                      <div key={m.id} style={{ fontSize: 'var(--text-xs)' }}>
                        <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-secondary)' }}>{m.senderName}: </span>
                        <span style={{ color: 'var(--text-primary)' }}>{m.text}</span>
                      </div>
                    ))
                  )}
                </div>

                <form onSubmit={handleSendChat} style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Написать сообщение…"
                    aria-label="Сообщение в чат комнаты"
                    data-testid="group-listen-chat-input"
                    style={{
                      flex: 1,
                      backgroundColor: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '4px 8px',
                      color: 'var(--text-primary)',
                      fontSize: 'var(--text-xs)'
                    }}
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
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 'var(--space-2)' }}>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {/* Tabs Header */}
            <div
              role="tablist"
              aria-label="Как присоединиться"
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 'var(--space-1)',
                backgroundColor: 'var(--surface-sunken)',
                padding: '3px',
                borderRadius: 'var(--radius-lg)'
              }}
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
                className="animate-drop-in"
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  backgroundColor: 'var(--danger-soft)',
                  color: 'var(--danger)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 'var(--text-xs)',
                  border: '1px solid var(--danger)'
                }}
              >
                {error}
              </div>
            )}

            {/* Tab: Host */}
            {tab === 'host' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Включайте музыку — остальные услышат то же самое и в тот же момент. Пауза, перемотка и смена
                  трека повторяются у всех, задержка сети учитывается автоматически.
                </div>

                <div
                  style={{
                    backgroundColor: 'var(--surface-2)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-3)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--space-2)'
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-primary)',
                      fontWeight: 'var(--weight-semibold)'
                    }}
                  >
                    {/* Пояснение, а не сюрприз: значок справки. */}
                    <HelpCircle size={ICON.sm} style={{ color: 'var(--text-secondary)' }} />
                    <span>Как это работает</span>
                  </div>
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: '20px',
                      fontSize: 'var(--text-xs)',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px'
                    }}
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
                onSubmit={handleJoinRoom}
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
              >
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  Введите код из 6 символов, который дал ведущий, — и вы подключитесь к его прослушиванию.
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
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
                    style={{
                      padding: 'var(--space-3)',
                      backgroundColor: 'var(--surface-sunken)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      fontSize: 'var(--text-xl)',
                      fontFamily: 'var(--font-mono)',
                      fontWeight: 'var(--weight-bold)',
                      letterSpacing: '0.2em',
                      textAlign: 'center',
                      color: 'var(--text-primary)',
                      textTransform: 'uppercase',
                      outline: 'none'
                    }}
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
