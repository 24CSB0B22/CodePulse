import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import { SOCKET_EVENTS, EditOperation, BroadcastEditOperation } from '@synccode/shared';
import { roomManager } from '../src/modules/rooms/roomManager';

describe('Real-Time Operation Latency & Multi-Client Load Verification (Item 11)', () => {
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

  it('measures operation round-trip and broadcast latency across 5 concurrent participants', async () => {
    const clients: ClientSocketType[] = [];
    const clientUserIds: string[] = [];

    // 1. Host creates room
    const host = await createClient();
    clients.push(host);

    const createRes: any = await new Promise((resolve) => {
      host.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Participant-0', initialContent: 'line 1\nline 2\nline 3\nline 4\nline 5\n' },
        resolve
      );
    });
    const roomId = createRes.data.room.roomId;
    clientUserIds.push(createRes.data.participant.userId);

    // 2. 4 Guests join room
    for (let i = 1; i < 5; i++) {
      const guest = await createClient();
      clients.push(guest);
      const joinRes: any = await new Promise((resolve) => {
        guest.emit(
          SOCKET_EVENTS.ROOM_JOIN,
          { roomId, displayName: `Participant-${i}` },
          resolve
        );
      });
      clientUserIds.push(joinRes.data.participant.userId);
    }

    expect(clients.length).toBe(5);

    // Track operation delivery times across peer clients
    const latencies: number[] = [];
    let currentRevision = 0;

    // Run 20 sequential operations across the 5 clients (4 operations per client)
    for (let round = 0; round < 20; round++) {
      const senderIndex = round % 5;
      const sender = clients[senderIndex];
      const senderUserId = clientUserIds[senderIndex];

      const opStart = performance.now();

      const op: EditOperation = {
        operationId: `bench-op-${round}`,
        userId: senderUserId,
        roomId,
        baseRevision: currentRevision,
        range: {
          startLineNumber: (round % 5) + 1,
          startColumn: 1,
          endLineNumber: (round % 5) + 1,
          endColumn: 1,
        },
        insertedText: `[${senderIndex}]`,
        deletedText: '',
        clientSequence: round + 1,
        timestamp: Date.now(),
      };

      // Set up broadcast listener on a peer client to measure peer-delivery latency
      const peerIndex = (senderIndex + 1) % 5;
      const peer = clients[peerIndex];

      const peerReceivedPromise = new Promise<BroadcastEditOperation>((resolve) => {
        const handler = (broadcastOp: BroadcastEditOperation) => {
          if (broadcastOp.operationId === op.operationId) {
            peer.off(SOCKET_EVENTS.EDITOR_OPERATION, handler);
            resolve(broadcastOp);
          }
        };
        peer.on(SOCKET_EVENTS.EDITOR_OPERATION, handler);
      });

      // Emit operation and await ack
      const ackRes: any = await new Promise((resolve) => {
        sender.emit(SOCKET_EVENTS.EDITOR_OPERATION, op, resolve);
      });

      expect(ackRes.success).toBe(true);
      currentRevision = ackRes.ack.revision;

      // Await peer reception
      const broadcastOp = await peerReceivedPromise;
      const opEnd = performance.now();
      const elapsed = opEnd - opStart;

      latencies.push(elapsed);
      expect(broadcastOp.revision).toBe(currentRevision);
    }

    const minLat = Math.min(...latencies);
    const maxLat = Math.max(...latencies);
    const avgLat = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95Lat = sorted[Math.floor(sorted.length * 0.95)];

    console.log(`\nLatency Benchmark (5 clients, 20 operations):`);
    console.log(`- Min: ${minLat.toFixed(2)}ms`);
    console.log(`- Max: ${maxLat.toFixed(2)}ms`);
    console.log(`- Avg: ${avgLat.toFixed(2)}ms`);
    console.log(`- P95: ${p95Lat.toFixed(2)}ms\n`);

    // Verify sub-100ms requirement
    expect(avgLat).toBeLessThan(100);
    expect(p95Lat).toBeLessThan(100);

    // Verify final room revision is exactly 20
    const finalRoom = roomManager.getRoomEntity(roomId);
    expect(finalRoom?.document.currentRevision).toBe(20);
  });
});
