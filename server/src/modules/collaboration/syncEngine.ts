import {
  EditOperation,
  BroadcastEditOperation,
  OperationAck,
  EditorSyncPayload,
  applyOperationToText,
  transformRange,
} from '@synccode/shared';
import { roomManager, RoomEntity } from '../rooms/roomManager';

export interface OperationResult {
  success: boolean;
  broadcastOp?: BroadcastEditOperation;
  ack?: OperationAck;
  requiresSync?: boolean;
  syncPayload?: EditorSyncPayload;
  isDuplicate?: boolean;
  error?: string;
}

export class SyncEngine {
  // Retains up to 500 recent operations per room for delta rebase and recovery
  private operationLogs: Map<string, BroadcastEditOperation[]> = new Map();

  // Tracks processed operation IDs and their acks for idempotency / duplicate detection
  private processedOperationAcks: Map<string, OperationAck> = new Map();

  // Sequential execution queue per room to serialize concurrent operations
  private roomQueues: Map<string, Promise<any>> = new Map();

  /**
   * Enqueues an operation into the room's serial pipeline to eliminate async race conditions.
   */
  public async processOperation(
    roomId: string,
    operation: EditOperation,
    socketId: string
  ): Promise<OperationResult> {
    const previousTask = this.roomQueues.get(roomId) || Promise.resolve();

    const currentTask = previousTask
      .catch(() => {}) // Continue even if a previous operation errored
      .then(() => this.executeOperation(roomId, operation, socketId));

    this.roomQueues.set(roomId, currentTask);
    return currentTask;
  }

  /**
   * Internal execution of a single validated operation on the room's authoritative buffer.
   */
  private executeOperation(
    roomId: string,
    operation: EditOperation,
    socketId: string
  ): OperationResult {
    const room = roomManager.getRoomEntity(roomId);
    if (!room) {
      return { success: false, error: 'ROOM_NOT_FOUND' };
    }

    // 1. Validate Participant
    const participant = room.participants.get(operation.userId);
    if (!participant || participant.connectionState !== 'CONNECTED') {
      return { success: false, error: 'PARTICIPANT_NOT_CONNECTED' };
    }

    // Check socket mapping matches
    const socketContext = roomManager.getSocketContext(socketId);
    if (!socketContext || socketContext.userId !== operation.userId || socketContext.roomId !== roomId) {
      return { success: false, error: 'UNAUTHORIZED_SOCKET' };
    }

    // 2. Validate Edit Permission
    if (room.isLocked && participant.role !== 'HOST') {
      return { success: false, error: 'ROOM_IS_LOCKED' };
    }

    // Duplicate operation check using operationId
    const existingAck = this.processedOperationAcks.get(operation.operationId);
    if (existingAck) {
      return {
        success: true,
        ack: existingAck,
        isDuplicate: true,
      };
    }

    // 3. Validate Operation Structure
    if (
      !operation.operationId ||
      typeof operation.baseRevision !== 'number' ||
      typeof operation.clientSequence !== 'number' ||
      !operation.range ||
      typeof operation.range.startLineNumber !== 'number' ||
      typeof operation.range.startColumn !== 'number' ||
      typeof operation.range.endLineNumber !== 'number' ||
      typeof operation.range.endColumn !== 'number' ||
      typeof operation.insertedText !== 'string' ||
      typeof operation.deletedText !== 'string'
    ) {
      return { success: false, error: 'INVALID_OPERATION_PAYLOAD' };
    }

    if (
      operation.insertedText.length > 50_000 ||
      operation.deletedText.length > 50_000
    ) {
      return { success: false, error: 'OPERATION_TOO_LARGE' };
    }

    const doc = room.document;
    const currentRevision = doc.currentRevision;
    let targetRange = { ...operation.range };

    // Initialize room log if needed
    if (!this.operationLogs.has(roomId)) {
      this.operationLogs.set(roomId, []);
    }
    const log = this.operationLogs.get(roomId)!;

    // 4. Check baseRevision
    if (operation.baseRevision > currentRevision) {
      // Future revision anomaly -> force sync
      return {
        success: false,
        requiresSync: true,
        syncPayload: {
          type: 'SNAPSHOT',
          currentRevision: doc.currentRevision,
          snapshotContent: doc.content,
        },
      };
    }

    if (operation.baseRevision < currentRevision) {
      // Client is editing against a stale revision -> attempt to transform
      // Only rebase against intervening operations from OTHER users.
      // The sender's local buffer already optimistically includes their own pending edits.
      const interveningOps = log.filter(
        (op) => op.revision > operation.baseRevision && op.userId !== operation.userId
      );

      let transformedRange = { ...targetRange };
      let rebaseSuccess = true;

      for (const earlierOp of interveningOps) {
        const result = transformRange(
          transformedRange,
          earlierOp.range,
          earlierOp.insertedText,
          earlierOp.deletedText.length
        );

        if (!result) {
          rebaseSuccess = false;
          break;
        }
        transformedRange = result;
      }

      if (!rebaseSuccess) {
        // Range collision could not be safely transformed -> send snapshot sync
        return {
          success: false,
          requiresSync: true,
          syncPayload: {
            type: 'SNAPSHOT',
            currentRevision: doc.currentRevision,
            snapshotContent: doc.content,
          },
        };
      }

      targetRange = transformedRange;
    }

    // 5. Apply to Server Authoritative Buffer
    try {
      doc.content = applyOperationToText(doc.content, targetRange, operation.insertedText);
    } catch {
      return {
        success: false,
        requiresSync: true,
        syncPayload: {
          type: 'SNAPSHOT',
          currentRevision: doc.currentRevision,
          snapshotContent: doc.content,
        },
      };
    }

    // 6. Assign New Monotonically Increasing Revision
    doc.currentRevision += 1;
    const newRevision = doc.currentRevision;

    const broadcastOp: BroadcastEditOperation = {
      operationId: operation.operationId,
      roomId,
      userId: operation.userId,
      baseRevision: operation.baseRevision,
      range: targetRange,
      insertedText: operation.insertedText,
      deletedText: operation.deletedText,
      deleteCount: operation.deleteCount,
      timestamp: Date.now(),
      clientSequence: operation.clientSequence,
      revision: newRevision,
      authorColor: participant.color.hex,
      authorName: participant.displayName,
    };

    // Store in ring log
    log.push(broadcastOp);
    if (log.length > 500) {
      log.shift(); // Keep latest 500 ops
    }

    const ack: OperationAck = {
      operationId: operation.operationId,
      revision: newRevision,
      clientSequence: operation.clientSequence,
    };

    // Retain processed operation ack for duplicate detection
    this.processedOperationAcks.set(operation.operationId, ack);
    if (this.processedOperationAcks.size > 2000) {
      const firstKey = this.processedOperationAcks.keys().next().value;
      if (firstKey) this.processedOperationAcks.delete(firstKey);
    }

    return {
      success: true,
      broadcastOp,
      ack,
    };
  }

  /**
   * Generates a sync payload for a client catching up after connection loss or divergence.
   */
  public getSyncPayload(roomId: string, lastKnownRevision: number): EditorSyncPayload | null {
    const room = roomManager.getRoomEntity(roomId);
    if (!room) return null;

    const doc = room.document;
    const log = this.operationLogs.get(roomId) || [];

    // If client is already up to date
    if (lastKnownRevision === doc.currentRevision) {
      return {
        type: 'DELTA',
        currentRevision: doc.currentRevision,
        operations: [],
      };
    }

    // Check if all missing operations exist in the log
    // We can only replay deltas if the log contains the next needed revision (lastKnownRevision + 1)
    const canReplayDeltas =
      log.length > 0 &&
      lastKnownRevision >= 0 &&
      lastKnownRevision < doc.currentRevision &&
      log[0].revision <= lastKnownRevision + 1;

    if (canReplayDeltas) {
      const missedOps = log.filter((op) => op.revision > lastKnownRevision);
      return {
        type: 'DELTA',
        currentRevision: doc.currentRevision,
        operations: missedOps,
      };
    }

    // Stale beyond operation log memory or uninitialized -> return full snapshot
    return {
      type: 'SNAPSHOT',
      currentRevision: doc.currentRevision,
      snapshotContent: doc.content,
    };
  }

  public clearOperationLog(roomId: string): void {
    this.operationLogs.delete(roomId);
  }

  public trimOperationLog(roomId: string, keepCount: number): void {
    const log = this.operationLogs.get(roomId);
    if (log && log.length > keepCount) {
      this.operationLogs.set(roomId, log.slice(log.length - keepCount));
    }
  }

  public clearProcessedOperations(): void {
    this.processedOperationAcks.clear();
  }
}

export const syncEngine = new SyncEngine();
