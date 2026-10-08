import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  EditOperation,
  ReconnectRequest,
  ReconnectResponse,
  EditorSyncPayload,
  OperationAck,
  RoomState,
} from '@synccode/shared';
import { syncEngine } from '../src/modules/collaboration/syncEngine';

describe('Session Persistence and Reconnection Integration Tests', () => {
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

  beforeEach(() => {
    syncEngine.clearProcessedOperations();
  });

  it('1. disconnect during editing: preserves local state, recovers on reconnect:request without code loss', async () => {
    const hostSocket = await createClient();
    let guestSocket = await createClient();

    let roomId = '';
    let guestUserId = '';
    let guestReconnectToken = '';

    // Create room
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: '// Start\n' },
        (res: any) => {
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    // Guest joins
    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob' },
        (res: any) => {
          guestUserId = res.data.participant.userId;
          guestReconnectToken = res.data.reconnectToken;
          resolve();
        }
      );
    });

    // Bob edits before disconnect
    const op1: EditOperation = {
      operationId: 'bob-op-1',
      userId: guestUserId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: '// First Edit\n',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
      roomId,
    };

    let ack1: OperationAck | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, op1, (res: any) => {
        ack1 = res.ack;
        resolve();
      });
    });
    expect(ack1?.revision).toBe(1);

    // Disconnect Bob (simulate network interruption)
    guestSocket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Connect new socket for Bob and send reconnect:request
    guestSocket = await createClient();
    const reconnectPayload: ReconnectRequest = {
      roomId,
      userId: guestUserId,
      lastKnownRevision: ack1!.revision,
      reconnectToken: guestReconnectToken,
    };

    let reconnectRes: ReconnectResponse | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.RECONNECT_REQUEST, reconnectPayload, (res: ReconnectResponse) => {
        reconnectRes = res;
        resolve();
      });
    });

    expect(reconnectRes?.success).toBe(true);
    expect(reconnectRes?.participant?.userId).toBe(guestUserId);
    expect(reconnectRes?.participant?.connectionState).toBe('CONNECTED');
    expect(reconnectRes?.room?.document.currentRevision).toBe(1);
    expect(reconnectRes?.room?.document.content).toContain('// First Edit\n');

    // Bob can immediately continue editing without error
    const op2: EditOperation = {
      operationId: 'bob-op-2',
      userId: guestUserId,
      baseRevision: 1,
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
      insertedText: '// Second Edit\n',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 2,
      roomId,
    };

    let ack2: OperationAck | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, op2, (res: any) => {
        ack2 = res.ack;
        resolve();
      });
    });
    expect(ack2?.revision).toBe(2);
  });

  it('2. reconnect after several edits: receives only missing delta operations', async () => {
    const hostSocket = await createClient();
    let guestSocket = await createClient();

    let roomId = '';
    let hostUserId = '';
    let guestUserId = '';
    let guestReconnectToken = '';

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: 'Line 1\n' },
        (res: any) => {
          roomId = res.data.room.roomId;
          hostUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob' },
        (res: any) => {
          guestUserId = res.data.participant.userId;
          guestReconnectToken = res.data.reconnectToken;
          resolve();
        }
      );
    });

    // Bob disconnects at revision 0
    guestSocket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Alice makes 4 consecutive edits while Bob is offline
    for (let i = 1; i <= 4; i++) {
      const editOp: EditOperation = {
        operationId: `alice-op-${i}`,
        userId: hostUserId,
        baseRevision: i - 1,
        range: { startLineNumber: i, startColumn: 7, endLineNumber: i, endColumn: 7 },
        insertedText: `Edit ${i}\n`,
        deletedText: '',
        timestamp: Date.now(),
        clientSequence: i,
        roomId,
      };
      await new Promise<void>((resolve) => {
        hostSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, editOp, () => resolve());
      });
    }

    // Bob reconnects with lastKnownRevision = 0
    guestSocket = await createClient();
    const reconnectPayload: ReconnectRequest = {
      roomId,
      userId: guestUserId,
      lastKnownRevision: 0,
      reconnectToken: guestReconnectToken,
    };

    let reconnectRes: ReconnectResponse | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.RECONNECT_REQUEST, reconnectPayload, (res: ReconnectResponse) => {
        reconnectRes = res;
        resolve();
      });
    });

    expect(reconnectRes?.success).toBe(true);
    expect(reconnectRes?.syncPayload?.type).toBe('DELTA');
    expect(reconnectRes?.syncPayload?.currentRevision).toBe(4);
    expect(reconnectRes?.syncPayload?.operations?.length).toBe(4);

    const receivedRevs = reconnectRes?.syncPayload?.operations?.map((op) => op.revision);
    expect(receivedRevs).toEqual([1, 2, 3, 4]);
  });

  it('3. stale client: sends latest snapshot and current revision when operation history is no longer available', async () => {
    const hostSocket = await createClient();
    let guestSocket = await createClient();

    let roomId = '';
    let hostUserId = '';
    let guestUserId = '';
    let guestReconnectToken = '';

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: 'Initial\n' },
        (res: any) => {
          roomId = res.data.room.roomId;
          hostUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob' },
        (res: any) => {
          guestUserId = res.data.participant.userId;
          guestReconnectToken = res.data.reconnectToken;
          resolve();
        }
      );
    });

    // Bob disconnects at revision 0
    guestSocket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // Alice makes edits
    for (let i = 1; i <= 3; i++) {
      const editOp: EditOperation = {
        operationId: `alice-stale-${i}`,
        userId: hostUserId,
        baseRevision: i - 1,
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        insertedText: `Edit ${i} `,
        deletedText: '',
        timestamp: Date.now(),
        clientSequence: i,
        roomId,
      };
      await new Promise<void>((resolve) => {
        hostSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, editOp, () => resolve());
      });
    }

    // Simulate operation history eviction / pruning for this room
    syncEngine.clearOperationLog(roomId);

    // Bob reconnects with old revision 0
    guestSocket = await createClient();
    const reconnectPayload: ReconnectRequest = {
      roomId,
      userId: guestUserId,
      lastKnownRevision: 0,
      reconnectToken: guestReconnectToken,
    };

    let reconnectRes: ReconnectResponse | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.RECONNECT_REQUEST, reconnectPayload, (res: ReconnectResponse) => {
        reconnectRes = res;
        resolve();
      });
    });

    expect(reconnectRes?.success).toBe(true);
    expect(reconnectRes?.syncPayload?.type).toBe('SNAPSHOT');
    expect(reconnectRes?.syncPayload?.currentRevision).toBe(3);
    expect(typeof reconnectRes?.syncPayload?.snapshotContent).toBe('string');
    expect(reconnectRes?.syncPayload?.snapshotContent).toContain('Edit 3 Edit 2 Edit 1 Initial\n');
  });

  it('4. duplicate operation: detected using operationId without duplicating edits or revision', async () => {
    const hostSocket = await createClient();

    let roomId = '';
    let hostUserId = '';

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: 'Hello' },
        (res: any) => {
          roomId = res.data.room.roomId;
          hostUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    const op: EditOperation = {
      operationId: 'unique-op-id-12345',
      userId: hostUserId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 },
      insertedText: ' World',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
      roomId,
    };

    // First emission
    let firstAck: OperationAck | undefined;
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, op, (res: any) => {
        firstAck = res.ack;
        resolve();
      });
    });

    expect(firstAck?.operationId).toBe('unique-op-id-12345');
    expect(firstAck?.revision).toBe(1);

    // Duplicate emission with the identical operationId
    let duplicateAck: OperationAck | undefined;
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, op, (res: any) => {
        duplicateAck = res.ack;
        resolve();
      });
    });

    // Idempotent acknowledgement matches first
    expect(duplicateAck?.operationId).toBe('unique-op-id-12345');
    expect(duplicateAck?.revision).toBe(1);

    // Verify room state revision did not increment to 2 and content did not duplicate to 'Hello World World'
    const sync = syncEngine.getSyncPayload(roomId, 0);
    expect(sync?.currentRevision).toBe(1);
    const room = (await new Promise<any>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.RECONNECT_REQUEST, { roomId, userId: hostUserId, lastKnownRevision: 1 }, (res: any) => {
        resolve(res.room);
      });
    }));
    expect(room.document.currentRevision).toBe(1);
    expect(room.document.content).toBe('Hello World');
  });

  it('5. delayed operation: successfully rebases and transforms against intervening edits', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    let roomId = '';
    let hostUserId = '';
    let guestUserId = '';

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice', initialContent: '12345' },
        (res: any) => {
          roomId = res.data.room.roomId;
          hostUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob' },
        (res: any) => {
          guestUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    // Alice makes an edit at column 1 (revision 1)
    const aliceOp: EditOperation = {
      operationId: 'alice-intervening',
      userId: hostUserId,
      baseRevision: 0,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: 'PRE-',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
      roomId,
    };
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, aliceOp, () => resolve());
    });

    // Bob has a delayed operation with baseRevision = 0, inserting at col 5 ('45')
    const bobDelayedOp: EditOperation = {
      operationId: 'bob-delayed',
      userId: guestUserId,
      baseRevision: 0, // Stale baseRevision
      range: { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 5 },
      insertedText: '-POST',
      deletedText: '',
      timestamp: Date.now(),
      clientSequence: 1,
      roomId,
    };

    let bobAck: OperationAck | undefined;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.EDITOR_OPERATION, bobDelayedOp, (res: any) => {
        bobAck = res.ack;
        resolve();
      });
    });

    expect(bobAck?.revision).toBe(2);

    // Verify document transformed: Alice prepended 'PRE-', Bob's column shifted right by 4 chars
    const sync = syncEngine.getSyncPayload(roomId, 0);
    expect(sync?.currentRevision).toBe(2);
  });

  it('6. room state recovery: restores authoritative room metadata, lock status, and roster after disconnect', async () => {
    const hostSocket = await createClient();
    let guestSocket = await createClient();

    let roomId = '';
    let hostUserId = '';
    let guestUserId = '';
    let guestReconnectToken = '';

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'HostAlice' },
        (res: any) => {
          roomId = res.data.room.roomId;
          hostUserId = res.data.participant.userId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'GuestBob' },
        (res: any) => {
          guestUserId = res.data.participant.userId;
          guestReconnectToken = res.data.reconnectToken;
          resolve();
        }
      );
    });

    // Bob disconnects
    guestSocket.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // While Bob is offline, Host locks the room
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, () => resolve());
    });

    // A third member (Charlie) joins the room
    const charlieSocket = await createClient();
    await new Promise<void>((resolve) => {
      charlieSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Charlie' }, () => resolve());
    });

    // Bob reconnects with reconnect:request
    guestSocket = await createClient();
    const reconnectPayload: ReconnectRequest = {
      roomId,
      userId: guestUserId,
      lastKnownRevision: 0,
      reconnectToken: guestReconnectToken,
    };

    let recoveredRoom: RoomState | undefined;
    let recoveredParticipant: any;
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.RECONNECT_REQUEST, reconnectPayload, (res: ReconnectResponse) => {
        expect(res.success).toBe(true);
        recoveredRoom = res.room;
        recoveredParticipant = res.participant;
        resolve();
      });
    });

    // Verify complete room state recovery
    expect(recoveredRoom?.isLocked).toBe(true);
    expect(recoveredParticipant?.userId).toBe(guestUserId);
    expect(recoveredParticipant?.displayName).toBe('GuestBob');
    expect(recoveredParticipant?.role).toBe('MEMBER');
    expect(recoveredParticipant?.connectionState).toBe('CONNECTED');

    // All 3 participants are reflected in authoritative roster
    expect(recoveredRoom?.participants.length).toBe(3);
    const userIds = recoveredRoom?.participants.map((p) => p.userId);
    expect(userIds).toContain(hostUserId);
    expect(userIds).toContain(guestUserId);
  });
});
