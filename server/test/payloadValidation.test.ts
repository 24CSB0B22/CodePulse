import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import { SOCKET_EVENTS } from '@synccode/shared';
import { clearEditorRateLimits } from '../src/socket/editorRateLimiter';
import { clearChatRateLimits } from '../src/socket/chatHandlers';

describe('Socket Payload Validation & Rate Limiting Tests', () => {
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
    clearEditorRateLimits();
    clearChatRateLimits();
  });

  describe('Socket Payload Validation (Item 3)', () => {
    it('rejects room:create with missing or empty displayName without crashing', async () => {
      const client = await createClient();

      // Missing displayName
      const res1 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_CREATE, {}, resolve);
      });
      expect(res1.success).toBe(false);
      expect(res1.error?.code).toBe('INVALID_REQUEST');

      // Empty displayName
      const res2 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: '   ' }, resolve);
      });
      expect(res2.success).toBe(false);
      expect(res2.error?.code).toBe('INVALID_REQUEST');

      // Malformed non-object
      const res3 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_CREATE, 'not an object', resolve);
      });
      expect(res3.success).toBe(false);
      expect(res3.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects room:join with missing roomId or displayName without crashing', async () => {
      const client = await createClient();

      const res1 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_JOIN, { displayName: 'User' }, resolve);
      });
      expect(res1.success).toBe(false);
      expect(res1.error?.code).toBe('INVALID_REQUEST');

      const res2 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId: 'room-123' }, resolve);
      });
      expect(res2.success).toBe(false);
      expect(res2.error?.code).toBe('INVALID_REQUEST');

      const res3 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.ROOM_JOIN, null, resolve);
      });
      expect(res3.success).toBe(false);
      expect(res3.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects reconnect:request with invalid or missing fields', async () => {
      const client = await createClient();

      const res1 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.RECONNECT_REQUEST, { roomId: 'test' }, resolve);
      });
      expect(res1.success).toBe(false);
      expect(res1.error?.code).toBe('INVALID_REQUEST');

      const res2 = await new Promise<any>((resolve) => {
        client.emit(SOCKET_EVENTS.RECONNECT_REQUEST, { roomId: 123, userId: true }, resolve);
      });
      expect(res2.success).toBe(false);
      expect(res2.error?.code).toBe('INVALID_REQUEST');
    });

    it('rejects editor:operation with malformed range or missing insertedText', async () => {
      const host = await createClient();
      const createRes = await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, resolve);
      });
      const roomId = createRes.data.room.roomId;

      // Malformed payload: missing range
      const res1 = await new Promise<any>((resolve) => {
        host.emit(
          SOCKET_EVENTS.EDITOR_OPERATION,
          {
            operationId: 'op-bad-1',
            baseRevision: 0,
            insertedText: 'hello',
          },
          resolve
        );
      });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain('INVALID_PAYLOAD');

      // Malformed range: non-numeric line numbers
      const res2 = await new Promise<any>((resolve) => {
        host.emit(
          SOCKET_EVENTS.EDITOR_OPERATION,
          {
            operationId: 'op-bad-2',
            baseRevision: 0,
            range: { startLineNumber: 'one', startColumn: 1, endLineNumber: 1, endColumn: 1 },
            insertedText: 'hello',
          },
          resolve
        );
      });
      expect(res2.success).toBe(false);
      expect(res2.error).toContain('INVALID_PAYLOAD');

      // Missing insertedText
      const res3 = await new Promise<any>((resolve) => {
        host.emit(
          SOCKET_EVENTS.EDITOR_OPERATION,
          {
            operationId: 'op-bad-3',
            baseRevision: 0,
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          },
          resolve
        );
      });
      expect(res3.success).toBe(false);
      expect(res3.error).toContain('INVALID_PAYLOAD');
    });

    it('handles malformed cursor:update and presence:update without crashing', async () => {
      const host = await createClient();
      await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, resolve);
      });

      // Send arbitrary invalid structures
      host.emit(SOCKET_EVENTS.CURSOR_UPDATE, 'not an object');
      host.emit(SOCKET_EVENTS.CURSOR_UPDATE, { position: { lineNumber: 'abc' } });
      host.emit(SOCKET_EVENTS.PRESENCE_UPDATE, null);
      host.emit(SOCKET_EVENTS.PRESENCE_UPDATE, { connectionState: 'INVALID_STATE' });

      // Ping to verify server is alive and responding normally
      const pong = await new Promise<boolean>((resolve) => {
        host.emit(SOCKET_EVENTS.PING, () => resolve(true));
      });
      expect(pong).toBe(true);
    });
  });

  describe('Operation Size Limits & Rate Limiting (Item 4)', () => {
    it('rejects editor:operation when insertedText exceeds maximum length (50,000 characters)', async () => {
      const host = await createClient();
      const createRes = await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'SizeHost' }, resolve);
      });

      const oversizedText = 'X'.repeat(50_001);
      const res = await new Promise<any>((resolve) => {
        host.emit(
          SOCKET_EVENTS.EDITOR_OPERATION,
          {
            operationId: 'op-oversized-text',
            baseRevision: 0,
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            insertedText: oversizedText,
          },
          resolve
        );
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('INVALID_PAYLOAD');
    });

    it('rejects editor:operation when rangeLength exceeds delete limit (50,000)', async () => {
      const host = await createClient();
      await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'DeleteHost' }, resolve);
      });

      const res = await new Promise<any>((resolve) => {
        host.emit(
          SOCKET_EVENTS.EDITOR_OPERATION,
          {
            operationId: 'op-oversized-delete',
            baseRevision: 0,
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
            rangeLength: 50_001,
            insertedText: '',
          },
          resolve
        );
      });

      expect(res.success).toBe(false);
      expect(res.error).toContain('INVALID_PAYLOAD');
    });

    it('permits normal fast typing operations without triggering rate limits', async () => {
      const host = await createClient();
      await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'TypingUser' }, resolve);
      });

      // Simulate 15 consecutive keystrokes
      for (let i = 0; i < 15; i++) {
        const res = await new Promise<any>((resolve) => {
          host.emit(
            SOCKET_EVENTS.EDITOR_OPERATION,
            {
              operationId: `op-fast-${i}`,
              baseRevision: i,
              range: { startLineNumber: 1, startColumn: i + 1, endLineNumber: 1, endColumn: i + 1 },
              insertedText: `a`,
              deletedText: '',
              clientSequence: i + 1,
            },
            resolve
          );
        });
        expect(res.success).toBe(true);
        expect(res.ack?.revision).toBe(i + 1);
      }
    });

    it('rejects rapid flood burst exceeding editor rate limits with RATE_LIMITED', async () => {
      const host = await createClient();
      await new Promise<any>((resolve) => {
        host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Flooder' }, resolve);
      });

      let rateLimitedCount = 0;
      // Fire 140 operations instantaneously (exceeding 120 limit)
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 140; i++) {
        promises.push(
          new Promise<any>((resolve) => {
            host.emit(
              SOCKET_EVENTS.EDITOR_OPERATION,
              {
                operationId: `op-flood-${i}`,
                baseRevision: 0,
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
                insertedText: 'x',
                deletedText: '',
                clientSequence: i + 1,
              },
              resolve
            );
          })
        );
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        if (!res.success && res.error === 'RATE_LIMITED') {
          rateLimitedCount++;
        }
      }

      expect(rateLimitedCount).toBeGreaterThan(0);
    });
  });
});
