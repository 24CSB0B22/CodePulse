import { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS, ExecutionResult } from '@synccode/shared';
import { roomManager } from '../modules/rooms/roomManager';
import { executionService } from '../modules/execution';
import { validatePayload, executionRequestSchema } from '../validation/socketSchemas';

export function registerExecutionHandlers(io: Server, socket: Socket): void {
  /**
   * Handle execution:request
   * Dispatches code execution request to the isolated sandbox service.
   * Arbitrary code is NEVER executed inside Node.js.
   */
  socket.on(
    SOCKET_EVENTS.EXECUTION_REQUEST,
    async (
      rawPayload: unknown,
      callback?: (response: { success: boolean; data?: ExecutionResult; error?: string }) => void
    ) => {
      const validation = validatePayload(executionRequestSchema, rawPayload);
      if (!validation.success) {
        if (typeof callback === 'function') {
          callback({ success: false, error: validation.error });
        }
        return;
      }

      const payload = validation.data;
      const context = roomManager.getSocketContext(socket.id);
      const roomId = payload.roomId || (context ? context.roomId : undefined);

      if (!roomId) {
        if (typeof callback === 'function') {
          callback({ success: false, error: 'A valid roomId is required for code execution' });
        }
        return;
      }

      const room = roomManager.getRoomEntity(roomId);
      if (!room) {
        if (typeof callback === 'function') {
          callback({ success: false, error: `Room '${roomId}' does not exist` });
        }
        return;
      }

      // Check if room is locked and sender is not host
      if (room.isLocked && context && room.hostId !== context.userId) {
        if (typeof callback === 'function') {
          callback({
            success: false,
            error: 'Room is locked in read-only mode by the host. Code execution is restricted.',
          });
        }
        return;
      }

      try {
        const result = await executionService.execute({
          roomId,
          language: payload.language,
          code: payload.code,
          stdin: payload.stdin,
          args: payload.args,
          timeoutMs: payload.timeoutMs,
        });

        // Broadcast execution result to room participants so output is synchronized
        io.to(roomId).emit(SOCKET_EVENTS.EXECUTION_RESULT, result);

        if (typeof callback === 'function') {
          callback({ success: true, data: result });
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Execution failed';
        if (typeof callback === 'function') {
          callback({ success: false, error: errorMessage });
        }
      }
    }
  );
}
