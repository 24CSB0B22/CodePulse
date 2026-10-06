import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import { SOCKET_EVENTS } from '@synccode/shared';

describe('Socket.IO Gateway', () => {
  let httpServer: http.Server;
  let clientSocket: ClientSocketType;
  let port: number;

  beforeAll(async () => {
    const app = createApp();
    httpServer = http.createServer(app);
    setupSocketServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const address = httpServer.address();
        if (address && typeof address !== 'string') {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('should establish connection successfully', async () => {
    clientSocket = ClientSocket(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    await new Promise<void>((resolve, reject) => {
      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        resolve();
      });
      clientSocket.on('connect_error', (err) => {
        reject(err);
      });
    });
  });

  it('should respond to ping with pong event', async () => {
    const pongReceived = new Promise<void>((resolve) => {
      clientSocket.on(SOCKET_EVENTS.PONG, (data) => {
        expect(data).toHaveProperty('timestamp');
        resolve();
      });
    });

    clientSocket.emit(SOCKET_EVENTS.PING);
    await pongReceived;
  });
});
