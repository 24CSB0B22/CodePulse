import React, { useEffect, useState, useCallback } from 'react';
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
} from '@synccode/shared';
import { LandingView } from './components/room/LandingView';
import { WorkspaceView } from './components/room/WorkspaceView';
import { ActivityNotifications, ActivityNotification } from './components/room/ActivityNotifications';

export const App: React.FC = () => {
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<RoomErrorPayload | null>(null);
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);

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
        const updated = prev.participants.filter((p) => p.userId !== payload.userId);
        return { ...prev, participants: updated };
      });

      addNotification('leave', `${payload.displayName} left the room`);
    };

    // 4. Presence Update
    const onPresenceUpdate = (payload: PresenceUpdatePayload) => {
      setRoomState((prev) => {
        if (!prev || prev.roomId !== payload.roomId) return prev;
        const updated = prev.participants.map((p) =>
          p.userId === payload.userId
            ? { ...p, connectionState: payload.connectionState }
            : p
        );
        return { ...prev, participants: updated };
      });
    };

    // 5. Room Error
    const onRoomError = (err: RoomErrorPayload) => {
      setError(err);
      setIsLoading(false);
    };

    socket.on(SOCKET_EVENTS.ROOM_STATE, onRoomState);
    socket.on(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantJoined);
    socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantLeft);
    socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
    socket.on(SOCKET_EVENTS.ROOM_ERROR, onRoomError);

    return () => {
      socket.off(SOCKET_EVENTS.ROOM_STATE, onRoomState);
      socket.off(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantJoined);
      socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantLeft);
      socket.off(SOCKET_EVENTS.PRESENCE_UPDATE, onPresenceUpdate);
      socket.off(SOCKET_EVENTS.ROOM_ERROR, onRoomError);
    };
  }, [addNotification]);

  const handleCreateRoom = (request: CreateRoomRequest) => {
    setIsLoading(true);
    setError(null);
    const socket = getSocket();

    socket.emit(
      SOCKET_EVENTS.ROOM_CREATE,
      request,
      (res: { success: boolean; data?: { room: RoomState; participant: Participant }; error?: RoomErrorPayload }) => {
        setIsLoading(false);
        if (res.success && res.data) {
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
        data?: { room: RoomState; participant: Participant; isReconnection: boolean };
        error?: RoomErrorPayload;
      }) => {
        setIsLoading(false);
        if (res.success && res.data) {
          setRoomState(res.data.room);
          setCurrentParticipant(res.data.participant);
          addNotification('info', `Joined room ${res.data.room.roomId} as ${res.data.participant.displayName}`);
        } else if (res.error) {
          setError(res.error);
        }
      }
    );
  };

  const handleLeaveRoom = () => {
    if (!roomState) return;
    const socket = getSocket();

    socket.emit(SOCKET_EVENTS.ROOM_LEAVE, { roomId: roomState.roomId });
    setRoomState(null);
    setCurrentParticipant(null);
    addNotification('info', 'You have left the workspace.');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col antialiased">
      {roomState && currentParticipant ? (
        <WorkspaceView
          roomState={roomState}
          currentParticipant={currentParticipant}
          onLeaveRoom={handleLeaveRoom}
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
