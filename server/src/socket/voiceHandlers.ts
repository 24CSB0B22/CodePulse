import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  VoiceOfferPayload,
  VoiceAnswerPayload,
  VoiceIceCandidatePayload,
  VoicePeerJoinedPayload,
  VoicePeerLeftPayload,
  PresenceUpdatePayload,
} from '@synccode/shared';
import { roomManager } from '../modules/rooms/roomManager';
import {
  validatePayload,
  voiceOfferSchema,
  voiceAnswerSchema,
  voiceIceCandidateSchema,
  voiceSpeakingSchema,
} from '../validation/socketSchemas';

export function registerVoiceHandlers(io: Server, socket: Socket): void {
  /**
   * Handle voice:join
   * Notifies existing peers in the room that this user has enabled voice communication.
   * Also responds with existing peers so the joining client can prepare peer connections.
   */
  socket.on(
    SOCKET_EVENTS.VOICE_JOIN,
    (
      payload?: { roomId?: string },
      callback?: (response: { success: boolean; peers?: string[]; error?: string }) => void
    ) => {
      const context = roomManager.getSocketContext(socket.id);
      if (!context) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'NOT_IN_A_ROOM' });
        }
        return;
      }

      const room = roomManager.getRoomEntity(context.roomId);
      if (!room) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'ROOM_NOT_FOUND' });
        }
        return;
      }

      const participant = room.participants.get(context.userId);
      if (!participant) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'PARTICIPANT_NOT_FOUND' });
        }
        return;
      }

      // Notify other room participants that a peer joined voice
      const peerJoinedPayload: VoicePeerJoinedPayload = {
        roomId: context.roomId,
        userId: participant.userId,
        displayName: participant.displayName,
      };
      socket.to(context.roomId).emit(SOCKET_EVENTS.VOICE_PEER_JOINED, peerJoinedPayload);

      // Collect existing other connected participants in the room
      const existingPeers: string[] = [];
      for (const [userId, p] of room.participants.entries()) {
        if (userId !== context.userId && p.connectionState === 'CONNECTED') {
          existingPeers.push(userId);
        }
      }

      if (typeof callback === 'function') {
        callback({ success: true, peers: existingPeers });
      }
    }
  );

  /**
   * Handle voice:offer (WebRTC SDP Offer Signaling Relay)
   * Server strictly relays the SDP offer to the target participant; NO audio touches the server.
   */
  socket.on(
    SOCKET_EVENTS.VOICE_OFFER,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void
    ) => {
      const validation = validatePayload(voiceOfferSchema, rawPayload);
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `INVALID_PAYLOAD: ${validation.error}` });
        }
        return;
      }

      const payload = validation.data;
      const context = roomManager.getSocketContext(socket.id);
      if (!context) {
        if (typeof callback === 'function') callback({ success: false, error: 'NOT_IN_A_ROOM' });
        return;
      }

      const roomId = payload.roomId || context.roomId;
      const callerUserId = context.userId;
      const caller = roomManager.getRoomEntity(roomId)?.participants.get(callerUserId);

      const targetSocketId = roomManager.getParticipantSocketId(roomId, payload.targetUserId);
      if (!targetSocketId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'TARGET_PEER_NOT_CONNECTED' });
        }
        return;
      }

      const relayPayload: VoiceOfferPayload = {
        roomId,
        callerUserId,
        callerName: caller?.displayName || 'Peer',
        targetUserId: payload.targetUserId,
        description: payload.description,
      };

      io.to(targetSocketId).emit(SOCKET_EVENTS.VOICE_OFFER, relayPayload);

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    }
  );

  /**
   * Handle voice:answer (WebRTC SDP Answer Signaling Relay)
   */
  socket.on(
    SOCKET_EVENTS.VOICE_ANSWER,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void
    ) => {
      const validation = validatePayload(voiceAnswerSchema, rawPayload);
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `INVALID_PAYLOAD: ${validation.error}` });
        }
        return;
      }

      const payload = validation.data;
      const context = roomManager.getSocketContext(socket.id);
      if (!context) {
        if (typeof callback === 'function') callback({ success: false, error: 'NOT_IN_A_ROOM' });
        return;
      }

      const roomId = payload.roomId || context.roomId;
      const answererUserId = context.userId;

      const targetSocketId = roomManager.getParticipantSocketId(roomId, payload.targetUserId);
      if (!targetSocketId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'TARGET_PEER_NOT_CONNECTED' });
        }
        return;
      }

      const relayPayload: VoiceAnswerPayload = {
        roomId,
        answererUserId,
        targetUserId: payload.targetUserId,
        description: payload.description,
      };

      io.to(targetSocketId).emit(SOCKET_EVENTS.VOICE_ANSWER, relayPayload);

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    }
  );

  /**
   * Handle voice:ice-candidate (WebRTC ICE Candidate Signaling Relay)
   */
  socket.on(
    SOCKET_EVENTS.VOICE_ICE_CANDIDATE,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; error?: string }) => void
    ) => {
      const validation = validatePayload(voiceIceCandidateSchema, rawPayload);
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `INVALID_PAYLOAD: ${validation.error}` });
        }
        return;
      }

      const payload = validation.data;
      const context = roomManager.getSocketContext(socket.id);
      if (!context) {
        if (typeof callback === 'function') callback({ success: false, error: 'NOT_IN_A_ROOM' });
        return;
      }

      const roomId = payload.roomId || context.roomId;
      const senderUserId = context.userId;

      const targetSocketId = roomManager.getParticipantSocketId(roomId, payload.targetUserId);
      if (!targetSocketId) {
        // Peer may have already disconnected; cleanly ignore
        if (typeof callback === 'function') callback({ success: false, error: 'PEER_NOT_FOUND' });
        return;
      }

      const relayPayload: VoiceIceCandidatePayload = {
        roomId,
        senderUserId,
        targetUserId: payload.targetUserId,
        candidate: payload.candidate,
      };

      io.to(targetSocketId).emit(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, relayPayload);

      if (typeof callback === 'function') {
        callback({ success: true });
      }
    }
  );

  /**
   * Handle voice:speaking (Speaking status broadcast)
   */
  socket.on(SOCKET_EVENTS.VOICE_SPEAKING, (rawPayload: unknown) => {
    const validation = validatePayload(voiceSpeakingSchema, rawPayload);
    if (!validation.success) return;

    const payload = validation.data;
    const context = roomManager.getSocketContext(socket.id);
    if (!context) return;

    const result = roomManager.updatePresence(socket.id, { isSpeaking: payload.isSpeaking });
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
      io.to(result.roomId).emit(SOCKET_EVENTS.PRESENCE_UPDATE, broadcastPayload);
    }
  });

  /**
   * Handle voice:leave
   */
  socket.on(SOCKET_EVENTS.VOICE_LEAVE, () => {
    const context = roomManager.getSocketContext(socket.id);
    if (context) {
      const leftPayload: VoicePeerLeftPayload = {
        roomId: context.roomId,
        userId: context.userId,
      };
      socket.to(context.roomId).emit(SOCKET_EVENTS.VOICE_PEER_LEFT, leftPayload);
    }
  });
}
