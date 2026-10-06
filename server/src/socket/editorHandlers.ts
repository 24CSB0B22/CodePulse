import { Server, Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  EditOperation,
  EditorSyncRequest,
  OperationAck,
} from '@synccode/shared';
import { syncEngine } from '../modules/collaboration/syncEngine';
import { roomManager } from '../modules/rooms/roomManager';

export function registerEditorHandlers(io: Server, socket: Socket): void {
  /**
   * Handle editor:operation
   */
  socket.on(
    SOCKET_EVENTS.EDITOR_OPERATION,
    async (
      operation: EditOperation,
      callback?: (response: {
        success: boolean;
        ack?: OperationAck;
        requiresSync?: boolean;
        error?: string;
      }) => void
    ) => {
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
      payload: EditorSyncRequest,
      callback?: (response: { success: boolean; data?: any; error?: string }) => void
    ) => {
      const context = roomManager.getSocketContext(socket.id);
      const roomId = payload.roomId || context?.roomId;

      if (!roomId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'NOT_IN_A_ROOM' });
        }
        return;
      }

      const syncPayload = syncEngine.getSyncPayload(roomId, payload.lastKnownRevision ?? 0);
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
