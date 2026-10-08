import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager, RoomError } from '../src/modules/rooms/roomManager';

describe('RoomManager Business Logic & Security Hardening', () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager();
  });

  // ========================================================
  // ROOM CREATION & STARTER TEMPLATES
  // ========================================================
  it('should create a room with unique ID, host role, color, and reconnectToken', () => {
    const { room, participant, reconnectToken } = rm.createRoom(
      { displayName: 'Alice', language: 'javascript' },
      'socket-1'
    );

    expect(room.roomId).toMatch(/^sync-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(room.hostId).toBe(participant.userId);
    expect(participant.displayName).toBe('Alice');
    expect(participant.role).toBe('HOST');
    expect(participant.color.hex).toBe('#10B981'); // First palette color
    expect(room.participants).toHaveLength(1);
    expect(room.maxParticipants).toBe(5);
    expect(typeof reconnectToken).toBe('string');
    expect(reconnectToken.length).toBeGreaterThan(16);
    expect((participant as any).reconnectToken).toBeUndefined(); // Token never exposed on public participant
  });

  it('should create a Java room with Main.java and a matching public class Main', () => {
    const { room } = rm.createRoom({ displayName: 'JavaHost', language: 'java' }, 'java-socket');

    expect(room.document.filename).toBe('Main.java');
    expect(room.document.language).toBe('java');
    expect(room.document.content).toContain('public class Main');
    expect(room.document.content).toContain('public static void main(String[] args)');
  });

  // ========================================================
  // PARTICIPANT IDENTITY & RECONNECT SECURITY
  // ========================================================
  it('should allow normal first-time join and return a secure reconnect token', () => {
    const { room: createdRoom } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');

    const { room, participant, reconnectToken, isReconnection } = rm.joinRoom(
      { roomId: createdRoom.roomId, displayName: 'Bob' },
      'socket-2'
    );

    expect(isReconnection).toBe(false);
    expect(room.participants).toHaveLength(2);
    expect(participant.displayName).toBe('Bob');
    expect(participant.role).toBe('MEMBER');
    expect(typeof reconnectToken).toBe('string');
  });

  it('should reject missing or blank participant display names', () => {
    const { room } = rm.createRoom({ displayName: 'Host' }, 'host-socket');

    expect(() => rm.joinRoom({ roomId: room.roomId, displayName: '   ' }, 'blank-socket'))
      .toThrowError(/display name is required/i);
    expect(rm.getRoom(room.roomId)?.participants).toHaveLength(1);
  });

  it('should preserve host through the reconnect grace period and promote only after it expires', async () => {
    const manager = new RoomManager(35);
    const { room, participant: host, reconnectToken } = manager.createRoom(
      { displayName: 'Host' },
      'host-socket'
    );
    const { participant: member } = manager.joinRoom(
      { roomId: room.roomId, displayName: 'Member' },
      'member-socket'
    );

    manager.leaveRoom('host-socket');
    expect(manager.getRoom(room.roomId)?.hostId).toBe(host.userId);
    expect(manager.getRoom(room.roomId)?.participants[0].role).toBe('MEMBER');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.getRoom(room.roomId)?.hostId).toBe(member.userId);
    expect(manager.getRoom(room.roomId)?.participants.find((p) => p.userId === member.userId)?.role)
      .toBe('HOST');

    const reconnectedHost = manager.joinRoom(
      { roomId: room.roomId, displayName: 'Host', userId: host.userId, reconnectToken },
      'host-reconnected-socket'
    );
    expect(reconnectedHost.isReconnection).toBe(true);
    expect(reconnectedHost.participant.role).toBe('MEMBER');
    expect(reconnectedHost.room.hostId).toBe(member.userId);
  });

  it('should retain host role if the host reconnects before the grace period expires', async () => {
    const manager = new RoomManager(40);
    const { room, participant: host, reconnectToken } = manager.createRoom(
      { displayName: 'Host' },
      'host-socket'
    );
    const { participant: member } = manager.joinRoom(
      { roomId: room.roomId, displayName: 'Member' },
      'member-socket'
    );

    manager.leaveRoom('host-socket');
    const reconnect = manager.joinRoom(
      { roomId: room.roomId, displayName: 'Host', userId: host.userId, reconnectToken },
      'host-reconnected-socket'
    );

    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(reconnect.participant.role).toBe('HOST');
    expect(manager.getRoom(room.roomId)?.hostId).toBe(host.userId);
    expect(manager.getRoom(room.roomId)?.participants.find((p) => p.userId === member.userId)?.role)
      .toBe('MEMBER');
  });

  it('should reject attempted identity takeover when userId is provided without a valid token', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');
    const { participant: bob } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-2'
    );

    // Attacker tries to claim Bob's userId without reconnect token
    expect(() => {
      rm.joinRoom(
        { roomId: room.roomId, displayName: 'Attacker', userId: bob.userId },
        'socket-attacker'
      );
    }).toThrowError(/unauthorized|reconnect token/i);

    // Attacker tries to claim Bob's userId with bogus token
    expect(() => {
      rm.joinRoom(
        { roomId: room.roomId, displayName: 'Attacker', userId: bob.userId, reconnectToken: 'fake-token' },
        'socket-attacker'
      );
    }).toThrowError(/unauthorized|reconnect token/i);
  });

  it('should reject duplicate active userId if participant is already CONNECTED', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');
    const { participant: bob, reconnectToken: bobToken } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-2'
    );

    // Even with legitimate token, cannot claim an active connected socket
    expect(() => {
      rm.joinRoom(
        { roomId: room.roomId, displayName: 'Bob', userId: bob.userId, reconnectToken: bobToken },
        'socket-duplicate'
      );
    }).toThrowError(/already actively in use/i);
  });

  it('should permit legitimate reconnect after disconnect with valid reconnect token', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');
    const { participant: bob, reconnectToken: bobToken } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-2'
    );

    // Bob disconnects
    const leaveRes = rm.leaveRoom('socket-2');
    expect(leaveRes?.participant.connectionState).toBe('DISCONNECTED');

    // Bob reconnects with new socket ID, same userId, and legitimate reconnectToken
    const reconnectRes = rm.joinRoom(
      {
        roomId: room.roomId,
        displayName: 'Bob',
        userId: bob.userId,
        reconnectToken: bobToken,
      },
      'socket-2-reconnected'
    );

    expect(reconnectRes.isReconnection).toBe(true);
    expect(reconnectRes.participant.userId).toBe(bob.userId);
    expect(reconnectRes.participant.connectionState).toBe('CONNECTED');

    // Verify socket mapping updated
    const ctx = rm.getSocketContext('socket-2-reconnected');
    expect(ctx?.userId).toBe(bob.userId);
  });

  it('should reject invalid reconnect token for an unknown user ID', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');

    expect(() => {
      rm.joinRoom(
        { roomId: room.roomId, displayName: 'Stranger', userId: 'user-nonexistent', reconnectToken: 'bogus' },
        'socket-stranger'
      );
    }).toThrowError(/reconnect token does not match/i);
  });

  it('should NOT allow claiming a disconnected participant using display-name alone', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');
    const { participant: bob } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-2'
    );

    // Bob disconnects
    rm.leaveRoom('socket-2');

    // Impersonator joins with same display name 'Bob', but NO reconnectToken/userId
    const impersonatorRes = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-impersonator'
    );

    // Impersonator receives their OWN distinct server-generated userId!
    expect(impersonatorRes.isReconnection).toBe(false);
    expect(impersonatorRes.participant.userId).not.toBe(bob.userId);
  });

  // ========================================================
  // ROOM CAPACITY & PASSWORD SECURITY
  // ========================================================
  it('should reject sixth participant when room reaches maximum 5 capacity', () => {
    const { room } = rm.createRoom({ displayName: 'User1' }, 'socket-1');

    rm.joinRoom({ roomId: room.roomId, displayName: 'User2' }, 'socket-2');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User3' }, 'socket-3');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User4' }, 'socket-4');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User5' }, 'socket-5');

    const updatedRoom = rm.getRoom(room.roomId);
    expect(updatedRoom?.participants).toHaveLength(5);

    expect(() => {
      rm.joinRoom({ roomId: room.roomId, displayName: 'User6' }, 'socket-6');
    }).toThrowError(/maximum capacity/i);
  });

  it('should enforce bcrypt password hashing and never expose hash or plaintext', () => {
    const { room } = rm.createRoom(
      { displayName: 'Host', password: 'secret-password-123' },
      'socket-host'
    );

    expect(room.hasPassword).toBe(true);
    expect((room as any).passwordHash).toBeUndefined(); // Never exposed publicly

    // Verify server entity contains standard bcrypt hash
    const entity = rm.getRoomEntity(room.roomId);
    expect(entity?.passwordHash).toBeDefined();
    expect(entity?.passwordHash).toMatch(/^\$2[aby]?\$\d{2}\$/); // Standard bcrypt signature
    expect(entity?.passwordHash).not.toContain('secret-password-123'); // Not plaintext

    // Incorrect password rejected
    expect(() => {
      rm.joinRoom({ roomId: room.roomId, displayName: 'Attacker', password: 'wrong' }, 'socket-a');
    }).toThrowError(/invalid password/i);

    // Correct password accepted
    const { participant } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Member', password: 'secret-password-123' },
      'socket-c'
    );
    expect(participant.displayName).toBe('Member');
  });

  // ========================================================
  // HOST CONTROLS: LOCK, UNLOCK, REMOVE, CLOSE
  // ========================================================
  it('should allow host to lock and unlock room, and reject non-host lock attempts', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-host');
    rm.joinRoom({ roomId: room.roomId, displayName: 'Bob' }, 'socket-member');

    // Non-host attempts lock
    expect(() => {
      rm.lockRoom('socket-member', room.roomId);
    }).toThrowError(/only the room host/i);

    // Host locks room
    const lockedRoom = rm.lockRoom('socket-host', room.roomId);
    expect(lockedRoom.isLocked).toBe(true);

    // Non-host attempts unlock
    expect(() => {
      rm.unlockRoom('socket-member', room.roomId);
    }).toThrowError(/only the room host/i);

    // Host unlocks room
    const unlockedRoom = rm.unlockRoom('socket-host', room.roomId);
    expect(unlockedRoom.isLocked).toBe(false);
  });

  it('should allow host to remove participant and prevent continued operations using old socket', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-host');
    const { participant: bob } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-bob'
    );

    // Host cannot remove themselves
    expect(() => {
      rm.removeParticipant('socket-host', room.hostId, room.roomId);
    }).toThrowError(/cannot remove themselves/i);

    // Non-host cannot remove
    expect(() => {
      rm.removeParticipant('socket-bob', room.hostId, room.roomId);
    }).toThrowError(/only the room host/i);

    // Host removes Bob
    const result = rm.removeParticipant('socket-host', bob.userId, room.roomId);
    expect(result.targetParticipant.userId).toBe(bob.userId);
    expect(result.remainingParticipants).toHaveLength(1);

    // Bob socket mapping is completely deleted
    expect(rm.getSocketContext('socket-bob')).toBeNull();

    // Bob is no longer in room participants
    const currentRoom = rm.getRoom(room.roomId);
    expect(currentRoom?.participants.some((p) => p.userId === bob.userId)).toBe(false);
  });

  it('should allow host to close room and clean up all state and socket mappings', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-host');
    rm.joinRoom({ roomId: room.roomId, displayName: 'Bob' }, 'socket-bob');

    // Non-host cannot close room
    expect(() => {
      rm.closeRoom('socket-bob', room.roomId);
    }).toThrowError(/only the room host/i);

    // Host closes room
    const closeResult = rm.closeRoom('socket-host', room.roomId);
    expect(closeResult.affectedSocketIds).toContain('socket-host');
    expect(closeResult.affectedSocketIds).toContain('socket-bob');

    // Room is completely deleted
    expect(rm.getRoom(room.roomId)).toBeNull();
    expect(rm.getSocketContext('socket-host')).toBeNull();
    expect(rm.getSocketContext('socket-bob')).toBeNull();
  });

  // ========================================================
  // COLLABORATIVE PRESENCE & CURSOR MANAGEMENT
  // ========================================================
  it('should assign unique room colors to at least 3 participants', () => {
    const { room, participant: userA } = rm.createRoom({ displayName: 'Alice' }, 'socket-a');
    const { participant: userB } = rm.joinRoom({ roomId: room.roomId, displayName: 'Bob' }, 'socket-b');
    const { participant: userC } = rm.joinRoom({ roomId: room.roomId, displayName: 'Charlie' }, 'socket-c');

    expect(userA.color.hex).toBeDefined();
    expect(userB.color.hex).toBeDefined();
    expect(userC.color.hex).toBeDefined();

    // Verify User A != User B != User C
    expect(userA.color.hex).not.toBe(userB.color.hex);
    expect(userB.color.hex).not.toBe(userC.color.hex);
    expect(userA.color.hex).not.toBe(userC.color.hex);
  });

  it('should update participant cursor and selection', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-a');
    const result = rm.updateCursor(
      'socket-a',
      { lineNumber: 5, column: 12 },
      { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 12 }
    );

    expect(result).not.toBeNull();
    expect(result?.participant.cursor).toEqual({ lineNumber: 5, column: 12 });
    expect(result?.participant.selection).toEqual({
      startLineNumber: 5,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 12,
    });
  });

  it('should update presence fields (typing, mic, speaking)', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-a');

    const typingResult = rm.updatePresence('socket-a', { isTyping: true });
    expect(typingResult?.participant.isTyping).toBe(true);

    const micResult = rm.updatePresence('socket-a', { isMuted: true, isSpeaking: false });
    expect(micResult?.participant.isMuted).toBe(true);
    expect(micResult?.participant.isSpeaking).toBe(false);
  });

  it('should clear cursor and typing status when participant disconnects', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-a');
    const { participant: bob } = rm.joinRoom({ roomId: room.roomId, displayName: 'Bob' }, 'socket-b');

    rm.updateCursor('socket-b', { lineNumber: 10, column: 4 });
    rm.updatePresence('socket-b', { isTyping: true });

    // Bob disconnects
    rm.leaveRoom('socket-b');

    const entity = rm.getRoomEntity(room.roomId);
    const bobEntity = entity?.participants.get(bob.userId);
    expect(bobEntity?.connectionState).toBe('DISCONNECTED');
    expect(bobEntity?.isTyping).toBe(false);
    expect(bobEntity?.cursor).toBeUndefined();
    expect(bobEntity?.selection).toBeUndefined();
  });
});
