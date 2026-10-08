import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  ChatMessage,
  SendChatMessageRequest,
  SendChatMessageResponse,
  MAX_CHAT_MESSAGE_LENGTH,
  ChatErrorPayload,
} from '@synccode/shared';
import { roomManager } from '../modules/rooms/roomManager';

interface RateLimitTracker {
  timestamps: number[];
}

// In-memory sliding window rate limiter: max 5 messages per 3,000ms per user
const rateLimiter = new Map<string, RateLimitTracker>();
const RATE_LIMIT_WINDOW_MS = 3_000;
const RATE_LIMIT_MAX_REQUESTS = 5;

// Periodically prune stale rate-limit entries every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, tracker] of rateLimiter.entries()) {
    tracker.timestamps = tracker.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (tracker.timestamps.length === 0) {
      rateLimiter.delete(key);
    }
  }
}, 60_000).unref();

export function checkChatRateLimit(key: string): boolean {
  const now = Date.now();
  const tracker = rateLimiter.get(key) || { timestamps: [] };
  tracker.timestamps = tracker.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

  if (tracker.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // Rate limit exceeded
  }

  tracker.timestamps.push(now);
  rateLimiter.set(key, tracker);
  return true; // Allowed
}

export function clearChatRateLimits(): void {
  rateLimiter.clear();
}

/**
 * Creates and broadcasts a system chat notification to a room.
 */
export function broadcastSystemChatMessage(io: Server, roomId: string, content: string): ChatMessage {
  const systemMessage: ChatMessage = {
    messageId: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    roomId,
    userId: 'system',
    displayName: 'System',
    colorHex: '#94A3B8', // Neutral slate accent
    content,
    timestamp: Date.now(),
    isSystem: true,
  };

  io.to(roomId).emit(SOCKET_EVENTS.CHAT_MESSAGE, systemMessage);
  return systemMessage;
}

export function registerChatHandlers(io: Server, socket: Socket): void {
  /**
   * Handle chat:send
   */
  socket.on(
    SOCKET_EVENTS.CHAT_SEND,
    (
      payload: SendChatMessageRequest,
      callback?: (response: SendChatMessageResponse) => void
    ) => {
      try {
        const context = roomManager.getSocketContext(socket.id);
        if (!context) {
          const error: ChatErrorPayload = {
            code: 'UNAUTHORIZED',
            message: 'You must be inside an active room to send messages',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        const room = roomManager.getRoomEntity(context.roomId);
        if (!room) {
          const error: ChatErrorPayload = {
            code: 'ROOM_NOT_FOUND',
            message: 'Target room does not exist',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        const participant = room.participants.get(context.userId);
        if (!participant || participant.connectionState !== 'CONNECTED') {
          const error: ChatErrorPayload = {
            code: 'UNAUTHORIZED',
            message: 'Participant is not connected',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        // 1. Rate Limiting Check
        const rateLimitKey = `${context.roomId}:${participant.userId}`;
        if (!checkChatRateLimit(rateLimitKey)) {
          const error: ChatErrorPayload = {
            code: 'RATE_LIMITED',
            message: 'You are sending messages too quickly. Please wait a few seconds.',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        // 2. Message Content Validation
        if (!payload || typeof payload.content !== 'string') {
          const error: ChatErrorPayload = {
            code: 'INVALID_MESSAGE',
            message: 'Message content is required',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        const trimmedContent = payload.content.trim();
        if (trimmedContent.length === 0) {
          const error: ChatErrorPayload = {
            code: 'INVALID_MESSAGE',
            message: 'Message content cannot be empty',
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        // 3. Maximum Length Validation
        if (trimmedContent.length > MAX_CHAT_MESSAGE_LENGTH) {
          const error: ChatErrorPayload = {
            code: 'MESSAGE_TOO_LONG',
            message: `Message exceeds maximum allowed length of ${MAX_CHAT_MESSAGE_LENGTH} characters`,
          };
          if (typeof callback === 'function') callback({ success: false, error });
          return;
        }

        // 4. Construct Authoritative Chat Message
        const message: ChatMessage = {
          messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          roomId: context.roomId,
          userId: participant.userId,
          displayName: participant.displayName,
          colorHex: participant.color.hex,
          content: trimmedContent,
          timestamp: Date.now(),
          isSystem: false,
        };

        // 5. Broadcast to All Sockets in Room
        io.to(context.roomId).emit(SOCKET_EVENTS.CHAT_MESSAGE, message);

        if (typeof callback === 'function') {
          callback({ success: true, message });
        }
      } catch (err: unknown) {
        const error: ChatErrorPayload = {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Failed to send chat message',
        };
        if (typeof callback === 'function') {
          callback({ success: false, error });
        }
      }
    }
  );
}
