import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  CreateRoomRequest,
  JoinRoomRequest,
  LeaveRoomRequest,
  RoomErrorPayload,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  PresenceUpdatePayload,
} from '@synccode/shared';
import { roomManager, RoomError } from '../modules/rooms/roomManager';

export function registerRoomHandlers(io: Server, socket: Socket): void {
  /**
   * Handle room:create
   */
  socket.on(
    SOCKET_EVENTS.ROOM_CREATE,
    (
      payload: CreateRoomRequest,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const { room, participant } = roomManager.createRoom(payload, socket.id);

        // Join the Socket.IO room channel
        socket.join(room.roomId);

        // Send room state to the creator
        socket.emit(SOCKET_EVENTS.ROOM_STATE, room);

        if (typeof callback === 'function') {
          callback({
            success: true,
            data: { room, participant },
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
      payload: JoinRoomRequest,
      callback?: (response: { success: boolean; data?: any; error?: RoomErrorPayload }) => void
    ) => {
      try {
        const { room, participant, isReconnection } = roomManager.joinRoom(payload, socket.id);

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

        if (typeof callback === 'function') {
          callback({
            success: true,
            data: { room, participant, isReconnection },
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
      }

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    }
  );

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
    }
  });
}
