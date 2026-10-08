import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  ChatMessage,
  SendChatMessageResponse,
} from '@synccode/shared';
import { clearChatRateLimits } from '../src/socket/chatHandlers';

describe('Chat 5-Participant Integration Tests', () => {
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

  it('should support full 5-participant room chatting with distinct colors and broadcast delivery', async () => {
    clearChatRateLimits();
    const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];
    const sockets: ClientSocketType[] = [];

    for (let i = 0; i < 5; i++) {
      const s = await createClient();
      sockets.push(s);
    }

    // 1. First user (Alice) creates the room
    let roomId = '';
    const assignedColors: string[] = [];

    await new Promise<void>((resolve) => {
      sockets[0].emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: names[0] },
        (res: any) => {
          expect(res.success).toBe(true);
          roomId = res.data.room.roomId;
          assignedColors.push(res.data.participant.color.hex);
          resolve();
        }
      );
    });

    // 2. Next 4 users join the room
    for (let i = 1; i < 5; i++) {
      await new Promise<void>((resolve) => {
        sockets[i].emit(
          SOCKET_EVENTS.ROOM_JOIN,
          { roomId, displayName: names[i] },
          (res: any) => {
            expect(res.success).toBe(true);
            assignedColors.push(res.data.participant.color.hex);
            resolve();
          }
        );
      });
    }

    // Verify all 5 assigned colors are unique
    const uniqueColors = new Set(assignedColors);
    expect(uniqueColors.size).toBe(5);

    // 3. Track messages received on each client
    const messagesPerClient: ChatMessage[][] = [[], [], [], [], []];
    sockets.forEach((s, idx) => {
      s.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
        if (!msg.isSystem) {
          messagesPerClient[idx].push(msg);
        }
      });
    });

    // 4. Each of the 5 participants sends a chat message
    for (let i = 0; i < 5; i++) {
      const msgContent = `Hello from ${names[i]}!`;
      const res = await new Promise<SendChatMessageResponse>((resolve) => {
        sockets[i].emit(
          SOCKET_EVENTS.CHAT_SEND,
          { content: msgContent },
          (response: SendChatMessageResponse) => resolve(response)
        );
      });
      expect(res.success).toBe(true);
      expect(res.message?.content).toBe(msgContent);
      expect(res.message?.displayName).toBe(names[i]);
      expect(res.message?.colorHex).toBe(assignedColors[i]);
    }

    // Wait for all broadcasts to arrive
    await new Promise((r) => setTimeout(r, 200));

    // 5. Verify every participant received all 5 messages
    for (let i = 0; i < 5; i++) {
      expect(messagesPerClient[i].length).toBe(5);
      const contents = messagesPerClient[i].map((m) => m.content);
      for (const name of names) {
        expect(contents).toContain(`Hello from ${name}!`);
      }
    }

    // 6. Verify 6th user cannot join (Room Capacity Constraint = 5)
    const extraSocket = await createClient();
    const rejectRes = await new Promise<any>((resolve) => {
      extraSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Frank' },
        (response: any) => resolve(response)
      );
    });
    expect(rejectRes.success).toBe(false);
    expect(rejectRes.error?.code).toBe('ROOM_FULL');

    // Clean up
    extraSocket.disconnect();
  });
});
