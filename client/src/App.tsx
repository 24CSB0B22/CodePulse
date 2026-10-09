import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getSocket } from './services/socket';
import {
  SOCKET_EVENTS,
  RoomState,
  Participant,
  CreateRoomRequest,
  JoinRoomRequest,
  RoomErrorPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  PresenceUpdatePayload,
  RemoteCursorBroadcast,
  ChatMessage,
  SendChatMessageResponse,
  ReconnectRequest,
  ReconnectResponse,
} from '@synccode/shared';
import { LandingView } from './components/room/LandingView';
import { WorkspaceView } from './components/room/WorkspaceView';
import { ActivityNotifications, ActivityNotification } from './components/room/ActivityNotifications';
import { VoiceManager, VoiceStatus } from './collaboration/VoiceManager';

interface SessionCredentials {
  roomId: string;
  userId: string;
  reconnectToken: string;
  displayName: string;
}

export const MAX_STORED_CHAT_MESSAGES = 200;

export const App: React.FC = () => {
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);
  const [error, setError] = useState<RoomErrorPayload | null>(null);
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);

  // Retain secure reconnect credentials and voice manager in memory
  const sessionCredentialsRef = useRef<SessionCredentials | null>(null);
  const roomStateRef = useRef<RoomState | null>(null);
  const voiceManagerRef = useRef<VoiceManager | null>(null);

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  const addNotification = useCallback(
    (type: 'join' | 'leave' | 'info', message: string) => {
      const id = `${Date.now()}-${Math.random()}`;
      setNotifications((prev) => [...prev, { id, type, message, timestamp: Date.now() }]);
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, 4000);
    },
    []
  );

  useEffect(() => {
    const socket = getSocket();

    // 1. Authoritative Room State
    const onRoomState = (state: RoomState) => {
      setRoomState(state);
      setIsLoading(false);
      setError(null);
    };

    // 2. Participant Joined
    const onParticipantJoined = (payload: ParticipantJoinedPayload) => {
      setRoomState((prev) => {
        if (!prev || prev.roomId !== payload.roomId) return prev;
        const exists = prev.participants.some((p) => p.userId === payload.participant.userId);
        const updated = exists
          ? prev.participants.map((p) =>
              p.userId === payload.participant.userId ? payload.participant : p
            )
          : [...prev.participants, payload.participant];

        return { ...prev, participants: updated };
      });

      addNotification('join', `${payload.participant.displayName} joined the room`);
    };

    // 3. Participant Left
    const onParticipantLeft = (payload: ParticipantLeftPayload) => {
      setRoomState((prev) => {
        if (!prev || prev.roomId !== payload.roomId) return prev;
        if (payload.reason === 'Client disconnected') {
          // Involuntary disconnect: retain participant in roster as DISCONNECTED (Offline)
          const updated = prev.participants.map((p) =>
            p.userId === payload.userId
              ? {
                  ...p,
                  connectionState: 'DISCONNECTED' as const,
                  isTyping: false,
                  cursor: undefined,
                  selection: undefined,
                }
              : p
          );
          return { ...prev, participants: updated };
        }
        // Explicit leave or ejection: remove from roster
        const updated = prev.participants.filter((p) => p.userId !== payload.userId);
        return { ...prev, participants: updated };
      });

      addNotification(
        'leave',
        `${payload.displayName} ${payload.reason === 'Client disconnected' ? 'disconnected' : 'left the room'}`
      );
    };

    // 4. Presence Update
    const onPresenceUpdate = (payload: PresenceUpdatePayload) => {
      setRoomState((prev) => {
        if (!prev || prev.roomId !== payload.roomId) return prev;
        const updated = prev.participants.map((p) => {
          if (p.userId !== payload.userId) return p;
          return {
            ...p,
            ...(payload.connectionState ? { connectionState: payload.connectionState } : {}),
            ...(payload.isTyping !== undefined ? { isTyping: payload.isTyping } : {}),
            ...(payload.isMuted !== undefined ? { isMuted: payload.isMuted } : {}),
            ...(payload.isSpeaking !== undefined ? { isSpeaking: payload.isSpeaking } : {}),
            ...(payload.cursor ? { cursor: payload.cursor } : {}),
            ...(payload.selection ? { selection: payload.selection } : {}),
          };
        });
        return { ...prev, participants: updated };
      });

      setCurrentParticipant((prev) => {
        if (!prev || prev.userId !== payload.userId) return prev;
        return {
          ...prev,
          ...(payload.connectionState ? { connectionState: payload.connectionState } : {}),
          ...(payload.isTyping !== undefined ? { isTyping: payload.isTyping } : {}),
          ...(payload.isMuted !== undefined ? { isMuted: payload.isMuted } : {}),
          ...(payload.isSpeaking !== undefined ? { isSpeaking: payload.isSpeaking } : {}),
        };
      });
    };

    // 4b. Remote Cursor Broadcast Update
    const onCursorUpdate = (payload: RemoteCursorBroadcast) => {
      setRoomState((prev) => {
        if (!prev) return prev;
        const updated = prev.participants.map((p) =>
          p.userId === payload.userId
            ? { ...p, cursor: payload.position, selection: payload.selection }
            : p
        );
        return { ...prev, participants: updated };
      });
    };

    // 5. Host Lock & Unlock broadcasts
    const onRoomLock = (payload: { roomId: string; isLocked: boolean }) => {
      setRoomState((prev) => (prev ? { ...prev, isLocked: payload.isLocked } : prev));
      addNotification('info', 'Workspace locked by host (Read-only mode)');
    };

    const onRoomUnlock = (payload: { roomId: string; isLocked: boolean }) => {
      setRoomState((prev) => (prev ? { ...prev, isLocked: payload.isLocked } : prev));
      addNotification('info', 'Workspace unlocked by host (Editing enabled)');
    };

    // 6. Host Close Room
    const onRoomClose = (payload: { roomId: string; reason?: string }) => {
      sessionCredentialsRef.current = null;
      setRoomState(null);
      setCurrentParticipant(null);
      setChatMessages([]);
      addNotification('leave', payload.reason || 'The workspace was closed by the host.');
    };

    // 7. Ejected by Host
    const onParticipantRemove = (payload: { roomId: string; message?: string }) => {
      sessionCredentialsRef.current = null;
      setRoomState(null);
      setCurrentParticipant(null);
      setChatMessages([]);
      addNotification('leave', payload.message || 'You were removed from the workspace by the host.');
    };

    // 8. Room Error
    const onRoomError = (err: RoomErrorPayload) => {
      setError(err);
      setIsLoading(false);
    };

    // 8b. Chat Message Received
    const onChatMessage = (message: ChatMessage) => {
      setChatMessages((prev) => {
        const next = [...prev, message];
        if (next.length > MAX_STORED_CHAT_MESSAGES) {
          return next.slice(-MAX_STORED_CHAT_MESSAGES);
        }
        return next;
      });
    };

    // 9. Automatic Socket Reconnect Handler
    const onConnect = () => {
      const creds = sessionCredentialsRef.current;
      if (creds && roomStateRef.current) {
        setIsReconnecting(true);
        // Retrieve the latest known document revision from Monaco SyncManager or current state
        const syncMgr = (window as any).__syncManager;
        const lastKnownRevision =
          syncMgr?.getLatestKnownRevision?.() ?? roomStateRef.current.document.currentRevision;

        const reconnectReq: ReconnectRequest = {
          roomId: creds.roomId,
          userId: creds.userId,
          lastKnownRevision,
          reconnectToken: creds.reconnectToken,
        };

        socket.emit(
          SOCKET_EVENTS.RECONNECT_REQUEST,
          reconnectReq,
          (res: ReconnectResponse) => {
            setIsReconnecting(false);
            if (res.success && res.room) {
              setRoomState(res.room);
              if (res.participant) {
                setCurrentParticipant(res.participant);
              }
              if (res.syncPayload && syncMgr) {
                syncMgr.applySyncPayload(res.syncPayload);
              }
              if (syncMgr) {
                syncMgr.flushPendingOperations();
              }
              voiceManagerRef.current?.handleReconnected();
              addNotification('info', 'Reconnected to workspace successfully.');
            }
          }
        );
      }
    };

    const onDisconnect = () => {
      if (sessionCredentialsRef.current && roomStateRef.current) {
        setIsReconnecting(true);
        // Preserve local state while marking current participant as RECONNECTING
        setCurrentParticipant((prev) => (prev ? { ...prev, connectionState: 'RECONNECTING' } : prev));
        setRoomState((prev) => {
          if (!prev) return prev;
          const updated = prev.participants.map((p) =>
            p.userId === sessionCredentialsRef.current?.userId
              ? { ...p, connectionState: 'RECONNECTING' as const }
              : p
          );
          return { ...prev, participants: updated };
        });
        addNotification('info', 'Connection interrupted. Reconnecting...');
      }
    };

    socket.on(SOCKET_EVENTS.ROOM_STATE, onRoomState);
    socket.on(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantJoined);
    socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantLeft);
    socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
    socket.on(SOCKET_EVENTS.CURSOR_UPDATE, onCursorUpdate);
    socket.on(SOCKET_EVENTS.CURSOR_BROADCAST, onCursorUpdate);
    socket.on(SOCKET_EVENTS.ROOM_LOCK, onRoomLock);
    socket.on(SOCKET_EVENTS.ROOM_UNLOCK, onRoomUnlock);
    socket.on(SOCKET_EVENTS.ROOM_CLOSE, onRoomClose);
    socket.on(SOCKET_EVENTS.PARTICIPANT_REMOVE, onParticipantRemove);
    socket.on(SOCKET_EVENTS.ROOM_ERROR, onRoomError);
    socket.on(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off(SOCKET_EVENTS.ROOM_STATE, onRoomState);
      socket.off(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantJoined);
      socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantLeft);
      socket.off(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
      socket.off(SOCKET_EVENTS.CURSOR_UPDATE, onCursorUpdate);
      socket.off(SOCKET_EVENTS.CURSOR_BROADCAST, onCursorUpdate);
      socket.off(SOCKET_EVENTS.ROOM_LOCK, onRoomLock);
      socket.off(SOCKET_EVENTS.ROOM_UNLOCK, onRoomUnlock);
      socket.off(SOCKET_EVENTS.ROOM_CLOSE, onRoomClose);
      socket.off(SOCKET_EVENTS.PARTICIPANT_REMOVE, onParticipantRemove);
      socket.off(SOCKET_EVENTS.ROOM_ERROR, onRoomError);
      socket.off(SOCKET_EVENTS.CHAT_MESSAGE, onChatMessage);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [addNotification]);

  const handleCreateRoom = (request: CreateRoomRequest) => {
    setIsLoading(true);
    setError(null);
    const socket = getSocket();

    socket.emit(
      SOCKET_EVENTS.ROOM_CREATE,
      request,
      (res: {
        success: boolean;
        data?: { room: RoomState; participant: Participant; reconnectToken: string };
        error?: RoomErrorPayload;
      }) => {
        setIsLoading(false);
        if (res.success && res.data) {
          sessionCredentialsRef.current = {
            roomId: res.data.room.roomId,
            userId: res.data.participant.userId,
            reconnectToken: res.data.reconnectToken,
            displayName: res.data.participant.displayName,
          };
          setRoomState(res.data.room);
          setCurrentParticipant(res.data.participant);
          addNotification('info', `Room ${res.data.room.roomId} created. You are Host.`);
        } else if (res.error) {
          setError(res.error);
        }
      }
    );
  };

  const handleJoinRoom = (request: JoinRoomRequest) => {
    setIsLoading(true);
    setError(null);
    const socket = getSocket();

    socket.emit(
      SOCKET_EVENTS.ROOM_JOIN,
      request,
      (res: {
        success: boolean;
        data?: { room: RoomState; participant: Participant; reconnectToken: string; isReconnection: boolean };
        error?: RoomErrorPayload;
      }) => {
        setIsLoading(false);
        if (res.success && res.data) {
          sessionCredentialsRef.current = {
            roomId: res.data.room.roomId,
            userId: res.data.participant.userId,
            reconnectToken: res.data.reconnectToken,
            displayName: res.data.participant.displayName,
          };
          setRoomState(res.data.room);
          setCurrentParticipant(res.data.participant);
          addNotification('info', `Joined room ${res.data.room.roomId} as ${res.data.participant.displayName}`);
        } else if (res.error) {
          setError(res.error);
        }
      }
    );
  };

  // WebRTC Voice Communication Mesh Lifecycle
  useEffect(() => {
    if (!roomState || !currentParticipant) {
      if (voiceManagerRef.current) {
        voiceManagerRef.current.destroy();
        voiceManagerRef.current = null;
        setVoiceStatus(null);
      }
      return;
    }

    const socket = getSocket();
    const vm = new VoiceManager(socket, roomState.roomId, currentParticipant.userId, {
      onStatusChange: (status) => setVoiceStatus(status),
      onSpeakingChange: (isSpeaking) => {
        setCurrentParticipant((prev) => (prev ? { ...prev, isSpeaking } : prev));
      },
    });
    voiceManagerRef.current = vm;
    (window as any).__voiceManager = vm;

    return () => {
      vm.destroy();
      if (voiceManagerRef.current === vm) {
        voiceManagerRef.current = null;
        delete (window as any).__voiceManager;
      }
    };
  }, [roomState?.roomId, currentParticipant?.userId]);

  const handleLeaveRoom = () => {
    if (!roomState) return;
    const socket = getSocket();

    if (voiceManagerRef.current) {
      voiceManagerRef.current.destroy();
      voiceManagerRef.current = null;
      setVoiceStatus(null);
    }

    sessionCredentialsRef.current = null;
    socket.emit(SOCKET_EVENTS.ROOM_LEAVE, { roomId: roomState.roomId });
    setRoomState(null);
    setCurrentParticipant(null);
    setChatMessages([]);
    addNotification('info', 'You have left the workspace.');
  };

  const handleToggleLock = () => {
    if (!roomState) return;
    const socket = getSocket();
    const event = roomState.isLocked ? SOCKET_EVENTS.ROOM_UNLOCK : SOCKET_EVENTS.ROOM_LOCK;
    socket.emit(event, { roomId: roomState.roomId });
  };

  const handleCloseRoom = () => {
    if (!roomState) return;
    const socket = getSocket();
    socket.emit(SOCKET_EVENTS.ROOM_CLOSE, { roomId: roomState.roomId });
  };

  const handleRemoveParticipant = (targetUserId: string) => {
    if (!roomState) return;
    const socket = getSocket();
    socket.emit(SOCKET_EVENTS.PARTICIPANT_REMOVE, { roomId: roomState.roomId, targetUserId });
  };

  const handleToggleMic = async () => {
    if (!roomState || !currentParticipant) return;
    const vm = voiceManagerRef.current;
    if (!vm) return;

    if (!voiceStatus?.isJoined) {
      // First click: prompt for microphone permission and join voice communication mesh
      const res = await vm.joinVoice(false);
      if (res.success) {
        setCurrentParticipant((prev) => (prev ? { ...prev, isMuted: false } : prev));
        addNotification('info', 'Voice audio connected.');
      } else {
        addNotification('info', res.error || 'Microphone access denied.');
      }
    } else {
      // Already joined: toggle mute / unmute state
      const isMuted = vm.toggleMute();
      setCurrentParticipant((prev) => (prev ? { ...prev, isMuted } : prev));
    }
  };

  const handleSendChatMessage = useCallback(
    (content: string): Promise<{ success: boolean; error?: string }> => {
      return new Promise((resolve) => {
        const socket = getSocket();
        socket.emit(
          SOCKET_EVENTS.CHAT_SEND,
          { content },
          (res?: SendChatMessageResponse) => {
            if (res && res.success) {
              resolve({ success: true });
            } else {
              resolve({
                success: false,
                error: res?.error?.message || 'Failed to send chat message',
              });
            }
          }
        );
      });
    },
    []
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {roomState && currentParticipant ? (
        <WorkspaceView
          roomState={roomState}
          currentParticipant={currentParticipant}
          chatMessages={chatMessages}
          isReconnecting={isReconnecting}
          onSendMessage={handleSendChatMessage}
          onLeaveRoom={handleLeaveRoom}
          onToggleLock={handleToggleLock}
          onCloseRoom={handleCloseRoom}
          onRemoveParticipant={handleRemoveParticipant}
          onToggleMic={handleToggleMic}
        />
      ) : (
        <LandingView
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          isLoading={isLoading}
          error={error}
          onClearError={() => setError(null)}
        />
      )}

      {/* Floating System Notifications */}
      <ActivityNotifications notifications={notifications} />
    </div>
  );
};
