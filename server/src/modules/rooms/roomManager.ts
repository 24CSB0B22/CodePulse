import crypto from 'crypto';
import {
  RoomState,
  Participant,
  ParticipantColor,
  PARTICIPANT_PALETTE,
  CreateRoomRequest,
  JoinRoomRequest,
  RoomErrorCode,
  RoomDocument,
} from '@synccode/shared';

export interface RoomEntity {
  roomId: string;
  hostId: string;
  isLocked: boolean;
  passwordHash?: string;
  document: RoomDocument;
  participants: Map<string, Participant & { socketId: string }>;
  createdAt: number;
}

export class RoomError extends Error {
  constructor(
    public code: RoomErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

export class RoomManager {
  private rooms: Map<string, RoomEntity> = new Map();
  private socketToRoom: Map<string, { roomId: string; userId: string }> = new Map();

  /**
   * Generates a cryptographically secure, collision-resistant Room ID.
   * Format: sync-xxxx-yyyy (e.g., sync-7f2a-b9c1)
   */
  private generateRoomId(): string {
    let roomId = '';
    do {
      const bytes = crypto.randomBytes(4).toString('hex');
      roomId = `sync-${bytes.slice(0, 4)}-${bytes.slice(4)}`;
    } while (this.rooms.has(roomId));
    return roomId;
  }

  /**
   * Hashes a room password using PBKDF2 with a random salt.
   */
  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  /**
   * Validates a candidate password against the stored salt:hash string.
   */
  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;
    const testHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(testHash, 'hex'), Buffer.from(key, 'hex'));
  }

  /**
   * Selects an unused color from the palette for a new participant in the room.
   */
  private assignUniqueColor(room: RoomEntity): ParticipantColor {
    const usedHexes = new Set<string>();
    for (const p of room.participants.values()) {
      if (p.connectionState === 'CONNECTED') {
        usedHexes.add(p.color.hex);
      }
    }

    const availableColor = PARTICIPANT_PALETTE.find((c) => !usedHexes.has(c.hex));
    if (availableColor) {
      return availableColor;
    }
    return PARTICIPANT_PALETTE[room.participants.size % PARTICIPANT_PALETTE.length];
  }

  /**
   * Creates a new private room.
   */
  public createRoom(
    request: CreateRoomRequest,
    socketId: string,
    hostUserId?: string
  ): { room: RoomState; participant: Participant } {
    if (!request.displayName || request.displayName.trim().length === 0) {
      throw new RoomError('INVALID_REQUEST', 'Display name is required');
    }

    const roomId = this.generateRoomId();
    const userId = hostUserId || `user-${crypto.randomBytes(6).toString('hex')}`;
    const displayName = request.displayName.trim().slice(0, 32);

    const hostColor = PARTICIPANT_PALETTE[0];
    const hostParticipant: Participant & { socketId: string } = {
      userId,
      socketId,
      displayName,
      role: 'HOST',
      color: hostColor,
      connectionState: 'CONNECTED',
      isMuted: false,
      isSpeaking: false,
      isTyping: false,
    };

    const initialLang = request.language || 'javascript';
    const defaultTemplate =
      request.initialContent ||
      `// Welcome to SyncCode! (Room: ${roomId})\n// Connected as Host: ${displayName}\n\nfunction main() {\n  console.log("Hello, SyncCode!");\n}\n\nmain();\n`;

    const roomEntity: RoomEntity = {
      roomId,
      hostId: userId,
      isLocked: false,
      passwordHash: request.password ? this.hashPassword(request.password) : undefined,
      document: {
        filename: initialLang === 'python' ? 'main.py' : initialLang === 'cpp' ? 'main.cpp' : 'main.js',
        language: initialLang,
        content: defaultTemplate,
        currentRevision: 0,
      },
      participants: new Map([[userId, hostParticipant]]),
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, roomEntity);
    this.socketToRoom.set(socketId, { roomId, userId });

    return {
      room: this.serializeRoom(roomEntity),
      participant: this.serializeParticipant(hostParticipant),
    };
  }

  /**
   * Admits a participant into an existing room.
   */
  public joinRoom(
    request: JoinRoomRequest,
    socketId: string
  ): { room: RoomState; participant: Participant; isReconnection: boolean } {
    const roomId = request.roomId?.trim();
    if (!roomId) {
      throw new RoomError('INVALID_REQUEST', 'Room ID is required');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    // Password verification
    if (room.passwordHash) {
      if (!request.password || !this.verifyPassword(request.password, room.passwordHash)) {
        throw new RoomError('INVALID_PASSWORD', 'Invalid password for this room');
      }
    }

    const displayName = (request.displayName || 'Collaborator').trim().slice(0, 32);
    let userId = request.userId;
    let existingParticipant: (Participant & { socketId: string }) | undefined;

    // Check if user is reconnecting by userId or matching displayName
    if (userId && room.participants.has(userId)) {
      existingParticipant = room.participants.get(userId);
    } else {
      for (const p of room.participants.values()) {
        if (p.displayName.toLowerCase() === displayName.toLowerCase() && p.connectionState === 'DISCONNECTED') {
          existingParticipant = p;
          userId = p.userId;
          break;
        }
      }
    }

    // If reconnecting
    if (existingParticipant && userId) {
      existingParticipant.socketId = socketId;
      existingParticipant.connectionState = 'CONNECTED';
      existingParticipant.displayName = displayName;
      this.socketToRoom.set(socketId, { roomId, userId });

      return {
        room: this.serializeRoom(room),
        participant: this.serializeParticipant(existingParticipant),
        isReconnection: true,
      };
    }

    // Capacity verification: max 5 active participants
    const activeParticipantsCount = Array.from(room.participants.values()).filter(
      (p) => p.connectionState === 'CONNECTED'
    ).length;

    if (activeParticipantsCount >= 5) {
      throw new RoomError('ROOM_FULL', 'Room has reached maximum capacity of 5 participants');
    }

    // Create new participant
    userId = userId || `user-${crypto.randomBytes(6).toString('hex')}`;
    const assignedColor = this.assignUniqueColor(room);

    const newParticipant: Participant & { socketId: string } = {
      userId,
      socketId,
      displayName,
      role: 'MEMBER',
      color: assignedColor,
      connectionState: 'CONNECTED',
      isMuted: false,
      isSpeaking: false,
      isTyping: false,
    };

    room.participants.set(userId, newParticipant);
    this.socketToRoom.set(socketId, { roomId, userId });

    return {
      room: this.serializeRoom(room),
      participant: this.serializeParticipant(newParticipant),
      isReconnection: false,
    };
  }

  /**
   * Handles leaving a room explicitly or via socket disconnection.
   */
  public leaveRoom(
    socketId: string
  ): { roomId: string; participant: Participant; remainingParticipants: Participant[] } | null {
    const mapping = this.socketToRoom.get(socketId);
    if (!mapping) return null;

    const { roomId, userId } = mapping;
    this.socketToRoom.delete(socketId);

    const room = this.rooms.get(roomId);
    if (!room) return null;

    const participant = room.participants.get(userId);
    if (!participant) return null;

    // Mark as disconnected
    participant.connectionState = 'DISCONNECTED';

    // If host disconnects, promote earliest joined connected participant if available
    if (room.hostId === userId) {
      const nextActive = Array.from(room.participants.values()).find(
        (p) => p.userId !== userId && p.connectionState === 'CONNECTED'
      );
      if (nextActive) {
        nextActive.role = 'HOST';
        room.hostId = nextActive.userId;
      }
    }

    const remaining = Array.from(room.participants.values())
      .filter((p) => p.connectionState === 'CONNECTED')
      .map((p) => this.serializeParticipant(p));

    return {
      roomId,
      participant: this.serializeParticipant(participant),
      remainingParticipants: remaining,
    };
  }

  /**
   * Retrieves raw RoomEntity by ID (for internal module use).
   */
  public getRoomEntity(roomId: string): RoomEntity | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Retrieves sanitized room state by ID.
   */
  public getRoom(roomId: string): RoomState | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return this.serializeRoom(room);
  }

  /**
   * Lookup room info for a socket.
   */
  public getSocketContext(socketId: string): { roomId: string; userId: string } | null {
    return this.socketToRoom.get(socketId) || null;
  }

  /**
   * Serializes a room entity into public RoomState without sensitive fields.
   */
  private serializeRoom(room: RoomEntity): RoomState {
    const participants = Array.from(room.participants.values())
      .filter((p) => p.connectionState === 'CONNECTED')
      .map((p) => this.serializeParticipant(p));

    return {
      roomId: room.roomId,
      hostId: room.hostId,
      isLocked: room.isLocked,
      maxParticipants: 5,
      participants,
      document: { ...room.document },
      hasPassword: Boolean(room.passwordHash),
    };
  }

  /**
   * Strips internal fields (like socketId) from participant object.
   */
  private serializeParticipant(p: Participant & { socketId: string }): Participant {
    return {
      userId: p.userId,
      displayName: p.displayName,
      role: p.role,
      color: p.color,
      connectionState: p.connectionState,
      isMuted: p.isMuted,
      isSpeaking: p.isSpeaking,
      cursor: p.cursor,
      selection: p.selection,
      isTyping: p.isTyping,
    };
  }
}

// Singleton instance for the application
export const roomManager = new RoomManager();
