import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  RoomState,
  ParticipantJoinedPayload,
  ParticipantLeftPayload,
  RoomErrorPayload,
} from '@synccode/shared';

describe('Room Socket.IO Integration Tests', () => {
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

  it('should create room, join socket room, and receive room:state event', async () => {
    const hostSocket = await createClient();

    const roomStatePromise = new Promise<RoomState>((resolve) => {
      hostSocket.on(SOCKET_EVENTS.ROOM_STATE, resolve);
    });

    const createCallbackPromise = new Promise<any>((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'AliceHost' },
        (response: any) => resolve(response)
      );
    });

    const [roomState, createRes] = await Promise.all([roomStatePromise, createCallbackPromise]);

    expect(createRes.success).toBe(true);
    expect(createRes.data.room.roomId).toMatch(/^sync-/);
    expect(createRes.data.participant.displayName).toBe('AliceHost');
    expect(createRes.data.participant.role).toBe('HOST');
    expect(roomState.roomId).toBe(createRes.data.room.roomId);
    expect(roomState.participants).toHaveLength(1);
  });

  it('should broadcast participant:joined to existing members when new user joins', async () => {
    const hostSocket = await createClient();
    const joinerSocket = await createClient();

    // Host creates room
    const createRes: any = await new Promise((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'HostUser' }, resolve);
    });
    const roomId = createRes.data.room.roomId;

    // Host listens for new participant
    const hostNotifiedPromise = new Promise<ParticipantJoinedPayload>((resolve) => {
      hostSocket.on(SOCKET_EVENTS.PARTICIPANT_JOINED, resolve);
    });

    // Joiner joins room
    const joinRes: any = await new Promise((resolve) => {
      joinerSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'BobJoiner' },
        resolve
      );
    });

    expect(joinRes.success).toBe(true);
    expect(joinRes.data.participant.displayName).toBe('BobJoiner');

    const notification = await hostNotifiedPromise;
    expect(notification.roomId).toBe(roomId);
    expect(notification.participant.displayName).toBe('BobJoiner');
    expect(notification.participant.role).toBe('MEMBER');
  });

  it('should broadcast participant:left when member emits room:leave', async () => {
    const hostSocket = await createClient();
    const memberSocket = await createClient();

    const createRes: any = await new Promise((resolve) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'HostUser' }, resolve);
    });
    const roomId = createRes.data.room.roomId;

    await new Promise((resolve) => {
      memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Leaver' }, resolve);
    });

    const leftNotificationPromise = new Promise<ParticipantLeftPayload>((resolve) => {
      hostSocket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, resolve);
    });

    // Member leaves
    memberSocket.emit(SOCKET_EVENTS.ROOM_LEAVE, { roomId });

    const leftEvent = await leftNotificationPromise;
    expect(leftEvent.roomId).toBe(roomId);
    expect(leftEvent.displayName).toBe('Leaver');
  });

  it('should reject 6th participant with ROOM_FULL error when capacity of 5 is reached', async () => {
    const sockets = await Promise.all([
      createClient(),
      createClient(),
      createClient(),
      createClient(),
      createClient(),
      createClient(), // 6th client
    ]);

    const host = sockets[0];
    const createRes: any = await new Promise((resolve) => {
      host.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'User1' }, resolve);
    });
    const roomId = createRes.data.room.roomId;

    // Join users 2 through 5
    for (let i = 1; i <= 4; i++) {
      const res: any = await new Promise((resolve) => {
        sockets[i].emit(
          SOCKET_EVENTS.ROOM_JOIN,
          { roomId, displayName: `User${i + 1}` },
          resolve
        );
      });
      expect(res.success).toBe(true);
    }

    // Attempt to join 6th user
    const sixthSocket = sockets[5];
    const sixthErrorPromise = new Promise<RoomErrorPayload>((resolve) => {
      sixthSocket.on(SOCKET_EVENTS.ROOM_ERROR, resolve);
    });

    const sixthJoinRes: any = await new Promise((resolve) => {
      sixthSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'User6' },
        resolve
      );
    });

    expect(sixthJoinRes.success).toBe(false);
    expect(sixthJoinRes.error.code).toBe('ROOM_FULL');

    const errorEvent = await sixthErrorPromise;
    expect(errorEvent.code).toBe('ROOM_FULL');
  });

  it('should reject unauthorized access when room password is missing or wrong', async () => {
    const hostSocket = await createClient();
    const guestSocket = await createClient();

    const createRes: any = await new Promise((resolve) => {
      hostSocket.emit(
        SOCKET_EVENTS.ROOM_CREATE,
        { displayName: 'SecureHost', password: 'secret-pass-123' },
        resolve
      );
    });
    const roomId = createRes.data.room.roomId;

    // Attempt with incorrect password
    const wrongPassRes: any = await new Promise((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Guest', password: 'wrong-password' },
        resolve
      );
    });

    expect(wrongPassRes.success).toBe(false);
    expect(wrongPassRes.error.code).toBe('INVALID_PASSWORD');

    // Attempt with correct password
    const correctPassRes: any = await new Promise((resolve) => {
      guestSocket.emit(
        SOCKET_EVENTS.ROOM_JOIN,
        { roomId, displayName: 'Guest', password: 'secret-pass-123' },
        resolve
      );
    });

    expect(correctPassRes.success).toBe(true);
    expect(correctPassRes.data.participant.displayName).toBe('Guest');
  });
});
