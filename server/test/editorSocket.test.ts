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
} from '@synccode/shared';

describe('Editor Socket.IO Integration & Network Tests', () => {
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

  it('should broadcast delta operation to peers and emit editor:ack to sender', async () => {
    const host = await createClient();
    const peer = await createClient();

    // 1. Host creates room
    const createRes: any = await new Promise((r) => {
      host.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'AliceHost', initialContent: 'line 1\nline 2\n' },
        r
      );
    });
    const roomId = createRes.data.room.roomId;
    const aliceId = createRes.data.participant.userId;

    // 2. Peer joins room
    await new Promise((r) => {
      peer.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'BobPeer' }, r);
    });

    // 3. Setup listeners
    const ackPromise = new Promise<OperationAck>((resolve) => {
      host.on(SOCKET_EVENTS.EDITOR_ACK, resolve);
    });

    const peerOperationPromise = new Promise<BroadcastEditOperation>((resolve) => {
      peer.on(SOCKET_EVENTS.EDITOR_OPERATION, (op) => {
        resolve(op);
      });
    });

    // 4. Host emits editor:operation delta
    const op: EditOperation = {
      operationId: 'net-op-1',
      userId: aliceId,
      roomId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: '// Alice was here\n',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
    };

    host.emit(SOCKET_EVENTS.EDITOR_OPERATION, op);

    // 5. Assertions
    const [ack, receivedBroadcast] = await Promise.all([ackPromise, peerOperationPromise]);

    expect(ack.operationId).toBe('net-op-1');
    expect(ack.revision).toBe(1);
    expect(ack.clientSequence).toBe(1);

    expect(receivedBroadcast.revision).toBe(1);
    expect(receivedBroadcast.operationId).toBe('net-op-1');
    expect(receivedBroadcast.insertedText).toBe('// Alice was here\n');
    expect(receivedBroadcast.authorName).toBe('AliceHost');
    expect(receivedBroadcast.authorColor).toBeDefined();

    // Verify it is a delta and NOT a full document dump
    expect((receivedBroadcast as any).content).toBeUndefined();
  });

  it('should support editor:sync request to fetch catch-up state', async () => {
    const host = await createClient();

    const createRes: any = await new Promise((r) => {
      host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'SyncTester' }, r);
    });
    const roomId = createRes.data.room.roomId;
    const userId = createRes.data.participant.userId;

    // Perform an edit to bump revision to 1
    await new Promise((r) => {
      host.emit(
        SOCKET_EVENTS.EDITOR_OPERATION,
        {
          operationId: 'bump-1',
          userId,
          roomId,
          baseRevision: 0,
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          insertedText: 'console.log(1);\n',
          deletedText: '',
          timestamp: Date.now(),
          clientSequence: 1,
        },
        r
      );
    });

    // Request sync from revision 0
    const syncPromise = new Promise<EditorSyncPayload>((resolve) => {
      host.on(SOCKET_EVENTS.EDITOR_SYNC, resolve);
    });

    host.emit(SOCKET_EVENTS.EDITOR_SYNC, { roomId, lastKnownRevision: 0 });

    const syncPayload = await syncPromise;
    expect(syncPayload.currentRevision).toBe(1);
    expect(syncPayload.type).toBe('DELTA');
    expect(syncPayload.operations).toHaveLength(1);
  });
});
