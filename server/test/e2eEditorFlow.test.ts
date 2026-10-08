import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  BroadcastEditOperation,
  OperationAck,
  EditOperation,
  EditorSyncPayload,
  createEditOperation,
  applyOperationToText,
} from '@synccode/shared';
import { roomManager } from '../src/modules/rooms/roomManager';

describe('End-to-End Collaborative Editor Flow & Reconnection Tests', () => {
  let httpServer: http.Server;
  let port: number;
  const activeSockets: ClientSocketType[] = [];

  const createClient = (): Promise<ClientSocketType> => {
    return new Promise((resolve, reject) => {
      const socket = ClientSocket(`http://localhost:${port}`, {
        transports: ['websocket'],
      });
      socket.on('connect', () => {
        activeSockets.push(socket);
        resolve(socket);
      });
      socket.on('connect_error', reject);
    });
  };

  beforeAll(async () => {
    const app = createApp();
    httpServer = http.createServer(app);
    setupSocketServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        if (addr && typeof addr !== 'string') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const socket of activeSockets) {
      if (socket.connected) {
        socket.disconnect();
      }
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('verifies Java room initialization produces Main.java with public class Main', async () => {
    const socket = await createClient();

    const createRes: any = await new Promise((r) => {
      socket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'JavaDev', language: 'java' },
        r
      );
    });

    expect(createRes.success).toBe(true);
    expect(createRes.data.room.document.filename).toBe('Main.java');
    expect(createRes.data.room.document.language).toBe('java');
    expect(createRes.data.room.document.content).toContain('public class Main');
    expect(createRes.data.room.document.content).toContain('public static void main(String[] args)');
  });

  it('verifies insert, delete, replace, and undo/redo operations emit correct delta metadata and server updates document', async () => {
    const host = await createClient();
    const initialText = 'hello world\n';

    const createRes: any = await new Promise((r) => {
      host.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: initialText },
        r
      );
    });
    const roomId = createRes.data.room.roomId;
    const userId = createRes.data.participant.userId;
    let currentDoc = initialText;
    let currentRevision = 0;
    let sequence = 0;

    // Helper to send op and await ack
    const sendOp = async (op: EditOperation): Promise<OperationAck> => {
      return new Promise((resolve) => {
        host.emit(SOCKET_EVENTS.EDITOR_OPERATION, op, (res: any) => {
          resolve(res.ack);
        });
      });
    };

    // 1. INSERTION: Insert ' brave' after 'hello'
    sequence++;
    const insertOp = createEditOperation({
      operationId: `op-${sequence}`,
      userId,
      roomId,
      baseRevision: currentRevision,
      range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 },
      rangeOffset: 5,
      rangeLength: 0,
      insertedText: ' brave',
      baseContent: currentDoc,
      timestamp: Date.now(),
      clientSequence: sequence,
    });

    expect(insertOp.rangeLength).toBe(0);
    expect(insertOp.deleteCount).toBe(0);
    expect(insertOp.deletedText).toBe('');
    expect(insertOp.insertedText).toBe(' brave');
    expect(insertOp.clientSequence).toBe(sequence);

    const ack1 = await sendOp(insertOp);
    expect(ack1.revision).toBe(1);
    currentRevision = ack1.revision;
    currentDoc = applyOperationToText(currentDoc, insertOp.range, insertOp.insertedText);
    expect(currentDoc).toBe('hello brave world\n');
    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('hello brave world\n');

    // 2. REPLACEMENT: Replace 'brave' with 'wonderful'
    sequence++;
    const replaceOp = createEditOperation({
      operationId: `op-${sequence}`,
      userId,
      roomId,
      baseRevision: currentRevision,
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 12 },
      rangeOffset: 6,
      rangeLength: 5,
      insertedText: 'wonderful',
      baseContent: currentDoc,
      timestamp: Date.now(),
      clientSequence: sequence,
    });

    expect(replaceOp.deletedText).toBe('brave');
    expect(replaceOp.deleteCount).toBe(5);
    expect(replaceOp.insertedText).toBe('wonderful');

    const ack2 = await sendOp(replaceOp);
    expect(ack2.revision).toBe(2);
    currentRevision = ack2.revision;
    currentDoc = applyOperationToText(currentDoc, replaceOp.range, replaceOp.insertedText);
    expect(currentDoc).toBe('hello wonderful world\n');
    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('hello wonderful world\n');

    // 3. DELETION: Delete 'wonderful '
    sequence++;
    const deleteOp = createEditOperation({
      operationId: `op-${sequence}`,
      userId,
      roomId,
      baseRevision: currentRevision,
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 17 },
      rangeOffset: 6,
      rangeLength: 10,
      insertedText: '',
      baseContent: currentDoc,
      timestamp: Date.now(),
      clientSequence: sequence,
    });

    expect(deleteOp.deletedText).toBe('wonderful ');
    expect(deleteOp.deleteCount).toBe(10);
    expect(deleteOp.insertedText).toBe('');

    const ack3 = await sendOp(deleteOp);
    expect(ack3.revision).toBe(3);
    currentRevision = ack3.revision;
    currentDoc = applyOperationToText(currentDoc, deleteOp.range, deleteOp.insertedText);
    expect(currentDoc).toBe('hello world\n');
    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('hello world\n');

    // 4. UNDO SIMULATION: Re-insert 'wonderful ' that was deleted
    sequence++;
    const undoOp = createEditOperation({
      operationId: `op-${sequence}`,
      userId,
      roomId,
      baseRevision: currentRevision,
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 7 },
      rangeOffset: 6,
      rangeLength: 0,
      insertedText: 'wonderful ',
      baseContent: currentDoc,
      timestamp: Date.now(),
      clientSequence: sequence,
    });

    const ack4 = await sendOp(undoOp);
    expect(ack4.revision).toBe(4);
    currentRevision = ack4.revision;
    currentDoc = applyOperationToText(currentDoc, undoOp.range, undoOp.insertedText);
    expect(currentDoc).toBe('hello wonderful world\n');
    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('hello wonderful world\n');

    // 5. REDO SIMULATION: Delete 'wonderful ' again
    sequence++;
    const redoOp = createEditOperation({
      operationId: `op-${sequence}`,
      userId,
      roomId,
      baseRevision: currentRevision,
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 17 },
      rangeOffset: 6,
      rangeLength: 10,
      insertedText: '',
      baseContent: currentDoc,
      timestamp: Date.now(),
      clientSequence: sequence,
    });

    const ack5 = await sendOp(redoOp);
    expect(ack5.revision).toBe(5);
    currentRevision = ack5.revision;
    currentDoc = applyOperationToText(currentDoc, redoOp.range, redoOp.insertedText);
    expect(currentDoc).toBe('hello world\n');
    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('hello world\n');
  });

  it('verifies bidirectional editing between two clients at different and nearby positions', async () => {
    const clientA = await createClient();
    const clientB = await createClient();

    const initialContent = 'line 1: AAAAA\nline 2: BBBBB\n';
    const createRes: any = await new Promise((r) => {
      clientA.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent },
        r
      );
    });
    const roomId = createRes.data.room.roomId;
    const aliceId = createRes.data.participant.userId;

    const joinRes: any = await new Promise((r) => {
      clientB.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, r);
    });
    const bobId = joinRes.data.participant.userId;

    // Listeners for peer broadcasts
    const bReceivedFromA = new Promise<BroadcastEditOperation>((resolve) => {
      clientB.on(SOCKET_EVENTS.EDITOR_OPERATION, resolve);
    });

    // 1. Client A edits Line 1
    const opA: EditOperation = {
      operationId: 'op-A1',
      userId: aliceId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 14 },
      insertedText: '11111',
      deletedText: 'AAAAA',
      deleteCount: 5,
      timestamp: Date.now(),
      clientSequence: 1,
    };
    clientA.emit(SOCKET_EVENTS.EDITOR_OPERATION, opA);

    const broadcastToB = await bReceivedFromA;
    expect(broadcastToB.operationId).toBe('op-A1');
    expect(broadcastToB.revision).toBe(1);
    expect(broadcastToB.insertedText).toBe('11111');

    // 2. Client B edits Line 2 in response
    const aReceivedFromB = new Promise<BroadcastEditOperation>((resolve) => {
      clientA.on(SOCKET_EVENTS.EDITOR_OPERATION, resolve);
    });

    const opB: EditOperation = {
      operationId: 'op-B1',
      userId: bobId,
      roomId,
      baseRevision: 1,
      range: { startLineNumber: 2, startColumn: 9, endLineNumber: 2, endColumn: 14 },
      insertedText: '22222',
      deletedText: 'BBBBB',
      deleteCount: 5,
      timestamp: Date.now(),
      clientSequence: 1,
    };
    clientB.emit(SOCKET_EVENTS.EDITOR_OPERATION, opB);

    const broadcastToA = await aReceivedFromB;
    expect(broadcastToA.operationId).toBe('op-B1');
    expect(broadcastToA.revision).toBe(2);
    expect(broadcastToA.insertedText).toBe('22222');

    expect(roomManager.getRoomEntity(roomId)?.document.content).toBe('line 1: 11111\nline 2: 22222\n');

    // 3. Concurrent edits at nearby non-overlapping positions on Line 2
    // Base doc at rev 2: "line 1: 11111\nline 2: 22222\n"
    // Client A appends " [A]" after "line 2: 22222"
    // Client B replaces "line 2" with "ROW 2" at the start of Line 2
    const opA_nearby: EditOperation = {
      operationId: 'op-A2',
      userId: aliceId,
      roomId,
      baseRevision: 2,
      range: { startLineNumber: 2, startColumn: 14, endLineNumber: 2, endColumn: 14 },
      insertedText: ' [A]',
      deletedText: '',
      deleteCount: 0,
      timestamp: Date.now(),
      clientSequence: 2,
    };

    const opB_nearby: EditOperation = {
      operationId: 'op-B2',
      userId: bobId,
      roomId,
      baseRevision: 2,
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 },
      insertedText: 'ROW 2',
      deletedText: 'line 2',
      deleteCount: 6,
      timestamp: Date.now(),
      clientSequence: 2,
    };

    // Emit both concurrently
    const [ackA, ackB] = await Promise.all([
      new Promise<OperationAck>((r) => clientA.emit(SOCKET_EVENTS.EDITOR_OPERATION, opA_nearby, (res: any) => r(res.ack))),
      new Promise<OperationAck>((r) => clientB.emit(SOCKET_EVENTS.EDITOR_OPERATION, opB_nearby, (res: any) => r(res.ack))),
    ]);

    expect(ackA.revision).toBe(3);
    expect(ackB.revision).toBe(4);

    const finalContent = roomManager.getRoomEntity(roomId)?.document.content;
    expect(finalContent).toContain('ROW 2: 22222 [A]');
  });

  it('verifies reconnection flow: client disconnects, peer edits, client reconnects and catches up without lost or duplicated edits', async () => {
    const clientA = await createClient();
    const clientB = await createClient();

    const createRes: any = await new Promise((r) => {
      clientA.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: 'initial text\n' },
        r
      );
    });
    const roomId = createRes.data.room.roomId;
    const aliceId = createRes.data.participant.userId;

    const joinRes: any = await new Promise((r) => {
      clientB.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, r);
    });
    const bobId = joinRes.data.participant.userId;
    const bobToken = joinRes.data.reconnectToken;

    // Both clients are at revision 0
    // 1. Client B disconnects unexpectedly
    clientB.disconnect();

    // 2. Client A performs multiple edits while Client B is offline (revisions 1, 2, 3)
    let currentRev = 0;
    for (let i = 1; i <= 3; i++) {
      const op: EditOperation = {
        operationId: `offline-op-${i}`,
        userId: aliceId,
        roomId,
        baseRevision: currentRev,
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        insertedText: `update ${i}\n`,
        deletedText: '',
        deleteCount: 0,
        timestamp: Date.now(),
        clientSequence: i,
      };
      const ack: any = await new Promise((r) => {
        clientA.emit(SOCKET_EVENTS.EDITOR_OPERATION, op, (res: any) => r(res.ack));
      });
      currentRev = ack.revision;
    }
    expect(currentRev).toBe(3);

    // 3. Client B reconnects with a new socket, matching existing userId and valid reconnectToken
    const clientB_reconnected = await createClient();

    const reconnectJoinRes: any = await new Promise((r) => {
      clientB_reconnected.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob', userId: bobId, reconnectToken: bobToken },
        r
      );
    });
    expect(reconnectJoinRes.success).toBe(true);
    expect(reconnectJoinRes.data.isReconnection).toBe(true);

    // 4. Client B requests synchronization with lastKnownRevision = 0
    const syncPromise = new Promise<EditorSyncPayload>((resolve) => {
      clientB_reconnected.on(SOCKET_EVENTS.EDITOR_SYNC, resolve);
    });

    clientB_reconnected.emit(SOCKET_EVENTS.EDITOR_SYNC, {
      roomId,
      lastKnownRevision: 0,
    });

    const syncPayload = await syncPromise;
    expect(syncPayload.currentRevision).toBe(3);
    expect(syncPayload.type).toBe('DELTA');
    expect(syncPayload.operations).toHaveLength(3);

    // Replay deltas in sequence
    let reconstructedText = 'initial text\n';
    for (const op of syncPayload.operations!) {
      reconstructedText = applyOperationToText(reconstructedText, op.range, op.insertedText);
    }

    const serverFinalContent = roomManager.getRoomEntity(roomId)?.document.content;
    expect(reconstructedText).toBe(serverFinalContent);
    expect(reconstructedText).toBe('update 3\nupdate 2\nupdate 1\ninitial text\n');
  });
});
