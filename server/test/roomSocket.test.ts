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

  it('should allow host to lock/unlock room, broadcasting state and rejecting non-host', async () => {
    const hostSocket = await createClient();
    const memberSocket = await createClient();

    const createRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'AliceHost' }, r);
    });
    const roomId = createRes.data.room.roomId;

    await new Promise((r) => {
      memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'BobMember' }, r);
    });

    // 1. Non-host attempts to lock room
    const nonHostLockRes: any = await new Promise((r) => {
      memberSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, r);
    });
    expect(nonHostLockRes.success).toBe(false);
    expect(nonHostLockRes.error.code).toBe('UNAUTHORIZED');

    // 2. Member listens for room:lock broadcast
    const lockBroadcastPromise = new Promise<{ roomId: string; isLocked: boolean }>((r) => {
      memberSocket.on(SOCKET_EVENTS.ROOM_LOCK, r);
    });

    // 3. Host locks room
    const hostLockRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, r);
    });
    expect(hostLockRes.success).toBe(true);
    expect(hostLockRes.data.room.isLocked).toBe(true);

    const lockBroadcast = await lockBroadcastPromise;
    expect(lockBroadcast.isLocked).toBe(true);

    // 4. Host unlocks room
    const unlockBroadcastPromise = new Promise<{ roomId: string; isLocked: boolean }>((r) => {
      memberSocket.on(SOCKET_EVENTS.ROOM_UNLOCK, r);
    });

    const hostUnlockRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_UNLOCK, { roomId }, r);
    });
    expect(hostUnlockRes.success).toBe(true);
    expect(hostUnlockRes.data.room.isLocked).toBe(false);

    const unlockBroadcast = await unlockBroadcastPromise;
    expect(unlockBroadcast.isLocked).toBe(false);
  });

  it('should allow host to remove participant, notifying target and remaining participants', async () => {
    const hostSocket = await createClient();
    const memberSocket = await createClient();
    const observerSocket = await createClient();

    const createRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, r);
    });
    const roomId = createRes.data.room.roomId;

    const bobJoinRes: any = await new Promise((r) => {
      memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, r);
    });
    const bobId = bobJoinRes.data.participant.userId;

    await new Promise((r) => {
      observerSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Charlie' }, r);
    });

    // Target member listens for participant:remove
    const targetRemovedPromise = new Promise<{ roomId: string; message: string }>((r) => {
      memberSocket.on(SOCKET_EVENTS.PARTICIPANT_REMOVE, r);
    });

    // Observer listens for participant:left
    const observerNotifiedPromise = new Promise<ParticipantLeftPayload>((r) => {
      observerSocket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, r);
    });

    // Non-host attempts remove
    const nonHostRemoveRes: any = await new Promise((r) => {
      observerSocket.emit(SOCKET_EVENTS.PARTICIPANT_REMOVE, { roomId, targetUserId: bobId }, r);
    });
    expect(nonHostRemoveRes.success).toBe(false);
    expect(nonHostRemoveRes.error.code).toBe('UNAUTHORIZED');

    // Host removes Bob
    const hostRemoveRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.PARTICIPANT_REMOVE, { roomId, targetUserId: bobId }, r);
    });
    expect(hostRemoveRes.success).toBe(true);

    const targetNotice = await targetRemovedPromise;
    expect(targetNotice.roomId).toBe(roomId);

    const leftNotice = await observerNotifiedPromise;
    expect(leftNotice.userId).toBe(bobId);
    expect(leftNotice.reason).toBe('Removed by host');
  });

  it('should allow host to close room, notifying all participants and cleaning up room channel', async () => {
    const hostSocket = await createClient();
    const memberSocket = await createClient();

    const createRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, r);
    });
    const roomId = createRes.data.room.roomId;

    await new Promise((r) => {
      memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Member' }, r);
    });

    const memberClosePromise = new Promise<{ roomId: string; reason: string }>((r) => {
      memberSocket.on(SOCKET_EVENTS.ROOM_CLOSE, r);
    });

    // Host closes room
    const closeRes: any = await new Promise((r) => {
      hostSocket.emit(SOCKET_EVENTS.ROOM_CLOSE, { roomId }, r);
    });
    expect(closeRes.success).toBe(true);

    const closeNotice = await memberClosePromise;
    expect(closeNotice.roomId).toBe(roomId);
    expect(closeNotice.reason).toBe('Room has been closed by host');
  });

  it('should broadcast cursor:update to peers when collaborator moves cursor', async () => {
    const userA = await createClient();
    const userB = await createClient();

    const createRes: any = await new Promise((r) => {
      userA.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'UserA' }, r);
    });
    const roomId = createRes.data.room.roomId;

    const joinRes: any = await new Promise((r) => {
      userB.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'UserB' }, r);
    });
    const userBId = joinRes.data.participant.userId;

    const cursorPromise = new Promise<any>((resolve) => {
      userA.on(SOCKET_EVENTS.CURSOR_UPDATE, resolve);
    });

    // User B emits cursor:update
    userB.emit(SOCKET_EVENTS.CURSOR_UPDATE, {
      roomId,
      position: { lineNumber: 4, column: 15 },
      selection: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 15 },
    });

    const cursorUpdate = await cursorPromise;
    expect(cursorUpdate.userId).toBe(userBId);
    expect(cursorUpdate.displayName).toBe('UserB');
    expect(cursorUpdate.position).toEqual({ lineNumber: 4, column: 15 });
    expect(cursorUpdate.selection).toEqual({
      startLineNumber: 4,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 15,
    });
  });

  it('should broadcast presence:update to all room members when typing or mic toggles', async () => {
    const userA = await createClient();
    const userB = await createClient();

    const createRes: any = await new Promise((r) => {
      userA.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'UserA' }, r);
    });
    const roomId = createRes.data.room.roomId;

    const joinRes: any = await new Promise((r) => {
      userB.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'UserB' }, r);
    });
    const userBId = joinRes.data.participant.userId;

    const presencePromise = new Promise<any>((resolve) => {
      userA.on(SOCKET_EVENTS.PRESENCE_UPDATE, (p) => {
        if (p.userId === userBId && p.isTyping !== undefined) {
          resolve(p);
        }
      });
    });

    // User B emits typing presence update
    userB.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
      roomId,
      isTyping: true,
      isMuted: true,
    });

    const presenceUpdate = await presencePromise;
    expect(presenceUpdate.userId).toBe(userBId);
    expect(presenceUpdate.isTyping).toBe(true);
    expect(presenceUpdate.isMuted).toBe(true);
  });
});
