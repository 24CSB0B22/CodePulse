import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  CreateRoomRequest,
  JoinRoomRequest,
  LeaveRoomRequest,
  RoomLockRequest,
  ParticipantRemoveRequest,
  RoomCloseRequest,
  RoomErrorPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  PresenceUpdatePayload,
  CursorUpdatePayload,
  RemoteCursorBroadcast,
  ReconnectRequest,
  ReconnectResponse,
} from '@synccode/shared';
import { roomManager, RoomError } from '../modules/rooms/roomManager';
import { broadcastSystemChatMessage } from './chatHandlers';
import { syncEngine } from '../modules/collaboration/syncEngine';
import {
  validatePayload,
  createRoomSchema,
  joinRoomSchema,
  reconnectRequestSchema,
  roomLockSchema,
  roomUnlockSchema,
  participantRemoveSchema,
  roomCloseSchema,
  cursorUpdateSchema,
  presenceUpdateSchema,
} from '../validation/socketSchemas';
import { checkCursorRateLimit } from './editorRateLimiter';

export function registerRoomHandlers(io: Server, socket: Socket): void {
  /**
   * Handle room:create
   */
  socket.on(
    SOCKET_EVENTS.ROOM_CREATE,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(createRoomSchema, rawPayload);
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data as CreateRoomRequest;
        const { room, participant, reconnectToken } = roomManager.createRoom(payload, socket.id);

        // Join the Socket.IO room channel
        socket.join(room.roomId);

        // Send room state to the creator
        socket.emit(SOCKET_EVENTS.ROOM_STATE, room);

        if (typeof callback === 'function') {
          callback({
            success: true,
            data: { room, participant, reconnectToken },
          });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to create room' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle room:join
   */
  socket.on(
    SOCKET_EVENTS.ROOM_JOIN,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(joinRoomSchema, rawPayload);
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data as JoinRoomRequest;
        const { room, participant, reconnectToken, isReconnection } = roomManager.joinRoom(payload, socket.id);

        // Join the Socket.IO room channel
        socket.join(room.roomId);

        // Deliver full authoritative room state to the joining participant
        socket.emit(SOCKET_EVENTS.ROOM_STATE, room);

        // Notify existing room members of new participant admission
        const joinedPayload: ParticipantJoinedPayload = {
          roomId: room.roomId,
          participant,
        };
        socket.to(room.roomId).emit(SOCKET_EVENTS.PARTICIPANT_JOINED, joinedPayload);

        // Emit presence update
        const presencePayload: PresenceUpdatePayload = {
          roomId: room.roomId,
          userId: participant.userId,
          connectionState: 'CONNECTED',
        };
        io.to(room.roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, presencePayload);

        // Broadcast system chat notification
        broadcastSystemChatMessage(io, room.roomId, `${participant.displayName} joined the workspace`);

        if (typeof callback === 'function') {
          callback({
            success: true,
            data: { room, participant, reconnectToken, isReconnection },
          });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to join room' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle room:leave
   */
  socket.on(
    SOCKET_EVENTS.ROOM_LEAVE,
    (
      payload?: LeaveRoomRequest,
      callback?: (response: { success: boolean; data?: any }) => void
    ) => {
      const leaveResult = roomManager.leaveRoom(socket.id);
      if (leaveResult) {
        const { roomId, participant } = leaveResult;
        socket.leave(roomId);

        const leftPayload: ParticipantLeftPayload = {
          roomId,
          userId: participant.userId,
          displayName: participant.displayName,
          reason: 'User left the room',
        };

        // Notify remaining participants
        socket.to(roomId).emit(SOCKET_EVENTS.PARTICIPANT_LEFT, leftPayload);

        const presencePayload: PresenceUpdatePayload = {
          roomId,
          userId: participant.userId,
          connectionState: 'DISCONNECTED',
        };
        socket.to(roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, presencePayload);

        // Broadcast system chat notification
        broadcastSystemChatMessage(io, roomId, `${participant.displayName} left the workspace`);
      }

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    }
  );

  /**
   * Handle reconnect:request
   */
  socket.on(
    SOCKET_EVENTS.RECONNECT_REQUEST,
    (
      rawPayload: unknown,
      callback?: (response: ReconnectResponse) => void
    ) => {
      try {
        const validation = validatePayload(reconnectRequestSchema, rawPayload);
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') callback({ success: false, error: errorPayload });
          return;
        }
        const payload = validation.data as ReconnectRequest;

        const { room, participant, reconnectToken } = roomManager.reconnectParticipant(
          payload,
          socket.id
        );

        // Join the Socket.IO room channel
        socket.join(room.roomId);

        // Retrieve delta operations or latest snapshot based on lastKnownRevision
        const syncPayload = syncEngine.getSyncPayload(room.roomId, payload.lastKnownRevision ?? 0) || {
          type: 'SNAPSHOT' as const,
          currentRevision: room.document.currentRevision,
          snapshotContent: room.document.content,
        };

        // Deliver full authoritative room state to the reconnected participant
        socket.emit(SOCKET_EVENTS.ROOM_STATE, room);

        // Send missing deltas or snapshot directly to the reconnected editor
        socket.emit(SOCKET_EVENTS.EDITOR_SYNC, syncPayload);

        // Broadcast presence update (CONNECTED) to all participants in the room
        const presencePayload: PresenceUpdatePayload = {
          roomId: room.roomId,
          userId: participant.userId,
          connectionState: 'CONNECTED',
        };
        io.to(room.roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, presencePayload);

        // Broadcast system chat notification
        broadcastSystemChatMessage(io, room.roomId, `${participant.displayName} reconnected to the workspace`);

        if (typeof callback === 'function') {
          callback({
            success: true,
            room,
            participant,
            syncPayload,
          });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to reconnect session' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle room:lock (Host Control)
   */
  socket.on(
    SOCKET_EVENTS.ROOM_LOCK,
    (
      rawPayload?: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(roomLockSchema, rawPayload ?? {});
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data;
        const room = roomManager.lockRoom(socket.id, payload?.roomId);
        const host = room.participants.find((p) => p.userId === room.hostId);
        const hostName = host?.displayName || 'Host';

        // Broadcast lock notification and updated room state
        io.to(room.roomId).emit(SOCKET_EVENTS.ROOM_LOCK, { roomId: room.roomId, isLocked: true });
        io.to(room.roomId).emit(SOCKET_EVENTS.ROOM_STATE, room);

        // Broadcast system chat notification
        broadcastSystemChatMessage(io, room.roomId, `Room locked by ${hostName}`);

        if (typeof callback === 'function') {
          callback({ success: true, data: { room } });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to lock room' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle room:unlock (Host Control)
   */
  socket.on(
    SOCKET_EVENTS.ROOM_UNLOCK,
    (
      rawPayload?: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(roomUnlockSchema, rawPayload ?? {});
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data;
        const room = roomManager.unlockRoom(socket.id, payload?.roomId);
        const host = room.participants.find((p) => p.userId === room.hostId);
        const hostName = host?.displayName || 'Host';

        // Broadcast unlock notification and updated room state
        io.to(room.roomId).emit(SOCKET_EVENTS.ROOM_UNLOCK, { roomId: room.roomId, isLocked: false });
        io.to(room.roomId).emit(SOCKET_EVENTS.ROOM_STATE, room);

        // Broadcast system chat notification
        broadcastSystemChatMessage(io, room.roomId, `Room unlocked by ${hostName}`);

        if (typeof callback === 'function') {
          callback({ success: true, data: { room } });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to unlock room' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle participant:remove (Host Control)
   */
  socket.on(
    SOCKET_EVENTS.PARTICIPANT_REMOVE,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(participantRemoveSchema, rawPayload);
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data;

        const result = roomManager.removeParticipant(socket.id, payload.targetUserId, payload.roomId);

        // Target socket notification and ejection
        const targetSocket = io.sockets.sockets.get(result.targetSocketId);
        if (targetSocket) {
          targetSocket.emit(SOCKET_EVENTS.PARTICIPANT_REMOVE, {
            roomId: result.roomId,
            message: 'You have been removed from the room by the host',
          });
          targetSocket.leave(result.roomId);
        }

        // Notify remaining participants
        const leftPayload: ParticipantLeftPayload = {
          roomId: result.roomId,
          userId: result.targetParticipant.userId,
          displayName: result.targetParticipant.displayName,
          reason: 'Removed by host',
        };
        io.to(result.roomId).emit(SOCKET_EVENTS.PARTICIPANT_LEFT, leftPayload);

        const presencePayload: PresenceUpdatePayload = {
          roomId: result.roomId,
          userId: result.targetParticipant.userId,
          connectionState: 'DISCONNECTED',
        };
        io.to(result.roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, presencePayload);

        // Broadcast system chat notification
        broadcastSystemChatMessage(
          io,
          result.roomId,
          `${result.targetParticipant.displayName} was removed from the workspace by the host`
        );

        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to remove participant' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle room:close (Host Control)
   */
  socket.on(
    SOCKET_EVENTS.ROOM_CLOSE,
    (
      rawPayload?: unknown,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const validation = validatePayload(roomCloseSchema, rawPayload ?? {});
        if (!validation.success) {
          const errorPayload: RoomErrorPayload = {
            code: 'INVALID_REQUEST',
            message: validation.error,
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);
          if (typeof callback === 'function') {
            callback({ success: false, error: errorPayload });
          }
          return;
        }
        const payload = validation.data;
        const result = roomManager.closeRoom(socket.id, payload?.roomId);

        // Broadcast close event to room members before channel cleanup
        io.to(result.roomId).emit(SOCKET_EVENTS.ROOM_CLOSE, {
          roomId: result.roomId,
          reason: 'Room has been closed by host',
        });

        // Eject all sockets from the Socket.IO channel
        io.in(result.roomId).socketsLeave(result.roomId);

        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (err: unknown) {
        const errorPayload: RoomErrorPayload =
          err instanceof RoomError
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL_ERROR', message: 'Failed to close room' };

        socket.emit(SOCKET_EVENTS.ROOM_ERROR, errorPayload);

        if (typeof callback === 'function') {
          callback({ success: false, error: errorPayload });
        }
      }
    }
  );

  /**
   * Handle cursor:update
   */
  socket.on(SOCKET_EVENTS.CURSOR_UPDATE, (rawPayload: unknown) => {
    if (!checkCursorRateLimit(socket.id)) {
      return;
    }
    const validation = validatePayload(cursorUpdateSchema, rawPayload);
    if (!validation.success) return;
    const payload = validation.data;

    const result = roomManager.updateCursor(socket.id, payload.position, payload.selection);
    if (result && result.participant.cursor) {
      const broadcastPayload: RemoteCursorBroadcast = {
        roomId: result.roomId,
        userId: result.participant.userId,
        displayName: result.participant.displayName,
        colorHex: result.participant.color.hex,
        position: result.participant.cursor,
        selection: result.participant.selection,
      };

      // Broadcast to other collaborators in the room
      socket.to(result.roomId).emit(SOCKET_EVENTS.CURSOR_UPDATE, broadcastPayload);
      socket.to(result.roomId).emit(SOCKET_EVENTS.CURSOR_BROADCAST, broadcastPayload);
    }
  });

  /**
   * Handle presence:update
   */
  socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, (rawPayload: unknown) => {
    const validation = validatePayload(presenceUpdateSchema, rawPayload);
    if (!validation.success) return;
    const payload = validation.data;

    const result = roomManager.updatePresence(socket.id, payload);
    if (result) {
      const broadcastPayload: PresenceUpdatePayload = {
        roomId: result.roomId,
        userId: result.participant.userId,
        connectionState: result.participant.connectionState,
        isTyping: result.participant.isTyping,
        isMuted: result.participant.isMuted,
        isSpeaking: result.participant.isSpeaking,
        cursor: result.participant.cursor,
        selection: result.participant.selection,
      };

      // Broadcast to all participants in the room
      io.to(result.roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, broadcastPayload);
    }
  });

  /**
   * Handle socket disconnection
   */
  socket.on('disconnect', () => {
    const leaveResult = roomManager.leaveRoom(socket.id);
    if (leaveResult) {
      const { roomId, participant } = leaveResult;

      const leftPayload: ParticipantLeftPayload = {
        roomId,
        userId: participant.userId,
        displayName: participant.displayName,
        reason: 'Client disconnected',
      };

      socket.to(roomId).emit(SOCKET_EVENTS.PARTICIPANT_LEFT, leftPayload);

      const presencePayload: PresenceUpdatePayload = {
        roomId,
        userId: participant.userId,
        connectionState: 'DISCONNECTED',
      };
      socket.to(roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, presencePayload);

      // Broadcast system chat notification
      broadcastSystemChatMessage(io, roomId, `${participant.displayName} disconnected`);
    }
  });
}
