import { describe, it, expect, beforeEach } from 'vitest';
import { RoomManager, RoomError } from '../src/modules/rooms/roomManager';

describe('RoomManager Business Logic', () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager();
  });

  it('should create a room with unique ID and assign host role and color', () => {
    const { room, participant } = rm.createRoom(
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
  });

  it('should allow joining an existing room and assign a unique color', () => {
    const { room: createdRoom } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');

    const { room, participant } = rm.joinRoom(
      { roomId: createdRoom.roomId, displayName: 'Bob' },
      'socket-2'
    );

    expect(room.participants).toHaveLength(2);
    expect(participant.displayName).toBe('Bob');
    expect(participant.role).toBe('MEMBER');
    expect(participant.color.hex).not.toBe(createdRoom.participants[0].color.hex);
  });

  it('should reject non-existent room', () => {
    expect(() => {
      rm.joinRoom({ roomId: 'sync-nonexistent', displayName: 'Eve' }, 'socket-x');
    }).toThrowError(RoomError);
  });

  it('should reject sixth participant when room reaches maximum 5 capacity', () => {
    const { room } = rm.createRoom({ displayName: 'User1' }, 'socket-1');

    // Add 4 more participants to reach 5 total
    rm.joinRoom({ roomId: room.roomId, displayName: 'User2' }, 'socket-2');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User3' }, 'socket-3');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User4' }, 'socket-4');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User5' }, 'socket-5');

    const updatedRoom = rm.getRoom(room.roomId);
    expect(updatedRoom?.participants).toHaveLength(5);

    // Attempt to admit 6th participant
    expect(() => {
      rm.joinRoom({ roomId: room.roomId, displayName: 'User6' }, 'socket-6');
    }).toThrowError(/maximum capacity/i);
  });

  it('should enforce password authentication and reject unauthorized access', () => {
    const { room } = rm.createRoom(
      { displayName: 'Host', password: 'secret-password' },
      'socket-host'
    );

    expect(room.hasPassword).toBe(true);

    // Wrong password
    expect(() => {
      rm.joinRoom({ roomId: room.roomId, displayName: 'Attacker', password: 'wrong' }, 'socket-a');
    }).toThrowError(/invalid password/i);

    // Missing password
    expect(() => {
      rm.joinRoom({ roomId: room.roomId, displayName: 'Visitor' }, 'socket-b');
    }).toThrowError(/invalid password/i);

    // Correct password
    const { participant } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Member', password: 'secret-password' },
      'socket-c'
    );
    expect(participant.displayName).toBe('Member');
  });

  it('should handle leaving room and update participant state', () => {
    const { room } = rm.createRoom({ displayName: 'Alice' }, 'socket-1');
    const { participant: bob } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'Bob' },
      'socket-2'
    );

    const leaveResult = rm.leaveRoom('socket-2');
    expect(leaveResult).not.toBeNull();
    expect(leaveResult?.participant.userId).toBe(bob.userId);
    expect(leaveResult?.remainingParticipants).toHaveLength(1);
    expect(leaveResult?.remainingParticipants[0].displayName).toBe('Alice');
  });

  it('should handle duplicate / reconnecting participant seamlessly without consuming extra capacity', () => {
    const { room } = rm.createRoom({ displayName: 'User1' }, 'socket-1');
    const { participant: user2 } = rm.joinRoom(
      { roomId: room.roomId, displayName: 'User2' },
      'socket-2'
    );

    // Add up to 5 users
    rm.joinRoom({ roomId: room.roomId, displayName: 'User3' }, 'socket-3');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User4' }, 'socket-4');
    rm.joinRoom({ roomId: room.roomId, displayName: 'User5' }, 'socket-5');

    // User2 disconnects
    rm.leaveRoom('socket-2');

    // User2 reconnects with a new socketId and their existing userId
    const reconnectResult = rm.joinRoom(
      { roomId: room.roomId, displayName: 'User2', userId: user2.userId },
      'socket-2-reconnected'
    );

    expect(reconnectResult.isReconnection).toBe(true);
    expect(reconnectResult.participant.userId).toBe(user2.userId);
    expect(reconnectResult.room.participants).toHaveLength(5);
  });
});
