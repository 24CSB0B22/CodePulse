import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  ChatMessage,
  SendChatMessageResponse,
  MAX_CHAT_MESSAGE_LENGTH,
} from '@synccode/shared';
import { clearChatRateLimits } from '../src/socket/chatHandlers';

describe('Room Chat Handlers Integration Tests', () => {
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
    clearChatRateLimits();
  });

  it('should deliver chat messages between room members with authoritative display name and color', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    // 1. Host creates room
    let roomId = '';
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Alice' },
        (res: any) => {
          expect(res.success).toBe(true);
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    // 2. Guest joins room
    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Bob' },
        (res: any) => {
          expect(res.success).toBe(true);
          resolve();
        }
      );
    });

    // 3. Guest listens for host message
    const receivedPromise = new Promise<ChatMessage>((resolve) => {
      guestSocket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
        if (!msg.isSystem && msg.displayName === 'Alice') {
          resolve(msg);
        }
      });
    });

    // 4. Host sends message
    const ackPromise = new Promise<SendChatMessageResponse>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.CHAT_SEND,
        { content: 'Hello everyone in SyncCode!' },
        (res: SendChatMessageResponse) => resolve(res)
      );
    });

    const [ack, received] = await Promise.all([ackPromise, receivedPromise]);

    expect(ack.success).toBe(true);
    expect(ack.message?.content).toBe('Hello everyone in SyncCode!');
    expect(ack.message?.displayName).toBe('Alice');
    expect(ack.message?.colorHex).toBeDefined();

    expect(received.content).toBe('Hello everyone in SyncCode!');
    expect(received.displayName).toBe('Alice');
    expect(received.colorHex).toBe(ack.message?.colorHex);
    expect(received.isSystem).toBe(false);
    expect(typeof received.timestamp).toBe('number');
  });

  it('should reject empty or whitespace-only messages', async () => {
    const hostSocket = await createClient();

    let roomId = '';
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'ValidatorHost' },
        (res: any) => {
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    const res1 = await new Promise<SendChatMessageResponse>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.CHAT_SEND, { content: '' }, resolve);
    });
    expect(res1.success).toBe(false);
    expect(res1.error?.code).toBe('INVALID_MESSAGE');

    const res2 = await new Promise<SendChatMessageResponse>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.CHAT_SEND, { content: '   \n   ' }, resolve);
    });
    expect(res2.success).toBe(false);
    expect(res2.error?.code).toBe('INVALID_MESSAGE');
  });

  it('should reject messages exceeding maximum allowed length', async () => {
    const hostSocket = await createClient();

    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'LimitHost' },
        () => resolve()
      );
    });

    const longMessage = 'A'.repeat(MAX_CHAT_MESSAGE_LENGTH + 5);

    const res = await new Promise<SendChatMessageResponse>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.CHAT_SEND, { content: longMessage }, resolve);
    });

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('MESSAGE_TOO_LONG');
    expect(res.error?.message).toContain(`${MAX_CHAT_MESSAGE_LENGTH}`);
  });

  it('should enforce sliding-window rate limiting on spamming', async () => {
    const spamSocket = await createClient();

    await new Promise<void>((resolve) => {
      spamSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'Spammer' },
        () => resolve()
      );
    });

    const responses: SendChatMessageResponse[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await new Promise<SendChatMessageResponse>((resolve) => {
        spamSocket.emit(SOCKET_EVENTS.CHAT_SEND, { content: `Message ${i + 1}` }, resolve);
      });
      responses.push(res);
    }

    const successCount = responses.filter((r) => r.success).length;
    const rateLimitedCount = responses.filter(
      (r) => !r.success && r.error?.code === 'RATE_LIMITED'
    ).length;

    expect(successCount).toBe(5);
    expect(rateLimitedCount).toBe(2);
  });

  it('should broadcast system join and leave chat notifications', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    let roomId = '';
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'AliceSys' },
        (res: any) => {
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    const systemMessages: ChatMessage[] = [];
    hostSocket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
      if (msg.isSystem) {
        systemMessages.push(msg);
      }
    });

    // Guest joins room
    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'BobSys' },
        () => resolve()
      );
    });

    // Wait for join notification
    await new Promise((r) => setTimeout(r, 100));

    expect(systemMessages.some((m) => m.content.includes('BobSys joined the workspace'))).toBe(true);

    // Guest leaves room
    await new Promise<void>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.ROOM_LEAVE, {}, () => resolve());
    });

    // Wait for leave notification
    await new Promise((r) => setTimeout(r, 100));

    expect(systemMessages.some((m) => m.content.includes('BobSys left the workspace'))).toBe(true);
  });

  it('should broadcast system chat messages when host locks and unlocks the room', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    let roomId = '';
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'AliceHost' },
        (res: any) => {
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'BobMember' },
        () => resolve()
      );
    });

    const receivedSystemChat: ChatMessage[] = [];
    guestSocket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
      if (msg.isSystem) {
        receivedSystemChat.push(msg);
      }
    });

    // 1. Host locks room -> system chat message emitted
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));

    const lockMsg = receivedSystemChat.find((m) => m.content.includes('Room locked by AliceHost'));
    expect(lockMsg).toBeDefined();
    expect(lockMsg?.isSystem).toBe(true);

    // 2. Host unlocks room -> system chat message emitted
    await new Promise<void>((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_UNLOCK, { roomId }, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));

    const unlockMsg = receivedSystemChat.find((m) => m.content.includes('Room unlocked by AliceHost'));
    expect(unlockMsg).toBeDefined();
    expect(unlockMsg?.isSystem).toBe(true);
  });

  it('should reject non-host lock and unlock attempts without broadcasting system chat messages', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    let roomId = '';
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'AliceHost' },
        (res: any) => {
          roomId = res.data.room.roomId;
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'BobMember' },
        () => resolve()
      );
    });

    const receivedSystemChat: ChatMessage[] = [];
    hostSocket.on(SOCKET_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
      if (msg.isSystem) {
        receivedSystemChat.push(msg);
      }
    });

    // Clear any prior join messages
    receivedSystemChat.length = 0;

    // 1. Non-host tries to lock -> error returned, NO system message
    const lockRes = await new Promise<any>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, resolve);
    });
    expect(lockRes.success).toBe(false);
    expect(lockRes.error?.code).toBe('UNAUTHORIZED');

    await new Promise((r) => setTimeout(r, 100));
    expect(receivedSystemChat.some((m) => m.content.includes('Room locked'))).toBe(false);

    // 2. Non-host tries to unlock -> error returned, NO system message
    const unlockRes = await new Promise<any>((resolve) => {
      guestSocket.emit(SOCKET_EVENTS.ROOM_UNLOCK, { roomId }, resolve);
    });
    expect(unlockRes.success).toBe(false);
    expect(unlockRes.error?.code).toBe('UNAUTHORIZED');

    await new Promise((r) => setTimeout(r, 100));
    expect(receivedSystemChat.some((m) => m.content.includes('Room unlocked'))).toBe(false);
  });
});
