import { describe, it, expect, beforeEach } from 'vitest';
import { SyncEngine } from '../src/modules/collaboration/syncEngine';
import { roomManager } from '../src/modules/rooms/roomManager';
import { EditOperation } from '@synccode/shared';

describe('SyncEngine Unit & Concurrency Tests', () => {
  let engine: SyncEngine;
  let roomId: string;
  let aliceId: string;
  let bobId: string;

  beforeEach(() => {
    engine = new SyncEngine();

    // Create a room with Alice as host
    const createRes = roomManager.createRoom(
      { displayName: 'Alice', initialContent: 'const a = 1;\nconst b = 2;\n' },
      'socket-alice'
    );
    roomId = createRes.room.roomId;
    aliceId = createRes.participant.userId;

    // Join Bob
    const joinRes = roomManager.joinRoom({ roomId, displayName: 'Bob' }, 'socket-bob');
    bobId = joinRes.participant.userId;
  });

  it('should apply valid operation and increment revision monotonically', async () => {
    const op: EditOperation = {
      operationId: 'op-1',
      userId: aliceId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: '// Comment\n',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    const res = await engine.processOperation(roomId, op, 'socket-alice');
    expect(res.success).toBe(true);
    expect(res.ack?.revision).toBe(1);
    expect(res.broadcastOp?.revision).toBe(1);
    expect(res.broadcastOp?.insertedText).toBe('// Comment\n');

    const room = roomManager.getRoomEntity(roomId);
    expect(room?.document.currentRevision).toBe(1);
    expect(room?.document.content.startsWith('// Comment\nconst a = 1;')).toBe(true);
  });

  it('should reject operation with invalid payload structure', async () => {
    const invalidOp = {
      operationId: '',
      userId: aliceId,
      baseRevision: 0,
    } as any;

    const res = await engine.processOperation(roomId, invalidOp, 'socket-alice');
    expect(res.success).toBe(false);
    expect(res.error).toBe('INVALID_OPERATION_PAYLOAD');
  });

  it('should reject edits from unauthorized sockets or users not in room', async () => {
    const op: EditOperation = {
      operationId: 'op-unauth',
      userId: 'stranger-id',
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: 'test',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    const res = await engine.processOperation(roomId, op, 'socket-stranger');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/PARTICIPANT_NOT_CONNECTED|UNAUTHORIZED_SOCKET/);
  });

  it('CONCURRENCY TEST: Two users submit concurrent edits based on same baseRevision', async () => {
    // Both Alice and Bob start editing from baseRevision = 0
    // Alice edits Line 1 (inserts 'let' instead of 'const')
    const aliceOp: EditOperation = {
      operationId: 'alice-op-1',
      userId: aliceId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 },
      insertedText: 'let',
      deletedText: 'const',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    // Bob concurrently edits Line 2 (appends '// Bob line 2' at end of Line 2)
    const bobOp: EditOperation = {
      operationId: 'bob-op-1',
      userId: bobId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 2, startColumn: 13, endLineNumber: 2, endColumn: 13 },
      insertedText: ' // modified',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    // Dispatch both operations concurrently
    const [aliceRes, bobRes] = await Promise.all([
      engine.processOperation(roomId, aliceOp, 'socket-alice'),
      engine.processOperation(roomId, bobOp, 'socket-bob'),
    ]);

    expect(aliceRes.success).toBe(true);
    expect(bobRes.success).toBe(true);

    // One got revision 1, the other got revision 2
    expect(aliceRes.ack?.revision).toBe(1);
    expect(bobRes.ack?.revision).toBe(2);

    const room = roomManager.getRoomEntity(roomId);
    expect(room?.document.currentRevision).toBe(2);

    // Verify both changes are preserved in the authoritative document
    expect(room?.document.content).toContain('let a = 1;');
    expect(room?.document.content).toContain('const b = 2; // modified');
  });

  it('CONCURRENCY TEST: Conflicting overlapping edit safely triggers requiresSync with full snapshot', async () => {
    // Alice deletes characters 1..8 on line 1
    const aliceOp: EditOperation = {
      operationId: 'alice-conflict',
      userId: aliceId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 },
      insertedText: '',
      deletedText: 'const a ',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    // Bob concurrently edits an overlapping range (characters 4..10 on line 1) based on baseRevision 0
    const bobOp: EditOperation = {
      operationId: 'bob-conflict',
      userId: bobId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 10 },
      insertedText: 'OVERLAP',
      deletedText: 'st a =',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    const aliceRes = await engine.processOperation(roomId, aliceOp, 'socket-alice');
    expect(aliceRes.success).toBe(true);
    expect(aliceRes.ack?.revision).toBe(1);

    // Bob's overlapping edit against stale revision 0 cannot be cleanly transformed
    const bobRes = await engine.processOperation(roomId, bobOp, 'socket-bob');
    expect(bobRes.success).toBe(false);
    expect(bobRes.requiresSync).toBe(true);
    expect(bobRes.syncPayload?.type).toBe('SNAPSHOT');
    expect(bobRes.syncPayload?.currentRevision).toBe(1);
  });

  it('should return delta or snapshot sync payload on catch-up requests', async () => {
    // Generate 3 revisions
    for (let i = 1; i <= 3; i++) {
      await engine.processOperation(
        roomId,
        {
          operationId: `seq-op-${i}`,
          userId: aliceId,
          roomId,
          baseRevision: i - 1,
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          insertedText: `${i}\n`,
          deletedText: '',
          timestamp: Date.now(),
          clientSequence: i,
        },
        'socket-alice'
      );
    }

    // Client at revision 1 catches up
    const syncPayload = engine.getSyncPayload(roomId, 1);
    expect(syncPayload?.type).toBe('DELTA');
    expect(syncPayload?.currentRevision).toBe(3);
    expect(syncPayload?.operations).toHaveLength(2); // ops 2 and 3
  });
});
