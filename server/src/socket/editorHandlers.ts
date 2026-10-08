import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  EditOperation,
  EditorSyncRequest,
  OperationAck,
} from '@synccode/shared';
import { syncEngine } from '../modules/collaboration/syncEngine';
import { roomManager } from '../modules/rooms/roomManager';
import {
  validatePayload,
  editorOperationSchema,
  editorSyncSchema,
} from '../validation/socketSchemas';
import { checkEditorRateLimit } from './editorRateLimiter';

export function registerEditorHandlers(io: Server, socket: Socket): void {
  /**
   * Handle editor:operation
   */
  socket.on(
    SOCKET_EVENTS.EDITOR_OPERATION,
    async (
      rawOperation: unknown,
      callback?: (response: {
        success: boolean;
        ack?: OperationAck;
        requiresSync?: boolean;
        error?: string;
      }) => void
    ) => {
      // 1. Rate Limiting Check
      if (!checkEditorRateLimit(socket.id)) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'RATE_LIMITED' });
        }
        return;
      }

      // 2. Runtime Schema Validation
      const validation = validatePayload(editorOperationSchema, rawOperation);
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `INVALID_PAYLOAD: ${validation.error}` });
        }
        return;
      }

      const operation = validation.data as EditOperation;
      const context = roomManager.getSocketContext(socket.id);
      const roomId = operation.roomId || context?.roomId;

      if (!roomId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'NOT_IN_A_ROOM' });
        }
        return;
      }

      // Ensure operation has roomId and authenticated userId from context
      if (context) {
        operation.userId = context.userId;
        operation.roomId = roomId;
      }

      const result = await syncEngine.processOperation(roomId, operation, socket.id);

      if (result.isDuplicate && result.ack) {
        // Idempotent duplicate: acknowledge sender without duplicate broadcast
        socket.emit(SOCKET_EVENTS.EDITOR_ACK, result.ack);
        if (typeof callback === 'function') {
          callback({ success: true, ack: result.ack });
        }
        return;
      }

      if (result.success && result.broadcastOp && result.ack) {
        // 1. Broadcast the accepted operation to all other collaborators in the room
        socket.to(roomId).emit(SOCKET_EVENTS.EDITOR_OPERATION, result.broadcastOp);

        // 2. Acknowledge the sender
        socket.emit(SOCKET_EVENTS.EDITOR_ACK, result.ack);

        if (typeof callback === 'function') {
          callback({ success: true, ack: result.ack });
        }
      } else if (result.requiresSync && result.syncPayload) {
        // Stale or colliding edit -> instruct client to resynchronize
        socket.emit(SOCKET_EVENTS.EDITOR_SYNC, result.syncPayload);

        if (typeof callback === 'function') {
          callback({ success: false, requiresSync: true });
        }
      } else {
        if (typeof callback === 'function') {
          callback({ success: false, error: result.error || 'OPERATION_REJECTED' });
        }
      }
    }
  );

  /**
   * Handle editor:sync
   */
  socket.on(
    SOCKET_EVENTS.EDITOR_SYNC,
    (
      rawPayload: unknown,
      callback?: (response: { success: boolean; data?: any; error?: string }) => void
    ) => {
      const validation = validatePayload(editorSyncSchema, rawPayload || {});
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `INVALID_PAYLOAD: ${validation.error}` });
        }
        return;
      }
      const payload = validation.data;

      const context = roomManager.getSocketContext(socket.id);
      if (!context) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'NOT_IN_A_ROOM' });
        }
        return;
      }

      if (payload.roomId && payload.roomId !== context.roomId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'UNAUTHORIZED' });
        }
        return;
      }

      const syncPayload = syncEngine.getSyncPayload(context.roomId, payload.lastKnownRevision ?? 0);
      if (syncPayload) {
        socket.emit(SOCKET_EVENTS.EDITOR_SYNC, syncPayload);

        if (typeof callback === 'function') {
          callback({ success: true, data: syncPayload });
        }
      } else {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'ROOM_NOT_FOUND' });
        }
      }
    }
  );
}
