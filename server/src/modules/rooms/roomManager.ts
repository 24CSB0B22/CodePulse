import crypto from 'crypto';
import bcrypt from 'bcrypt';
import {
  RoomState,
  Participant,
  ParticipantColor,
  PARTICIPANT_PALETTE,
  CreateRoomRequest,
  JoinRoomRequest,
  ReconnectRequest,
  RoomErrorCode,
  RoomDocument,
  CursorPosition,
  MonacoRange,
  PresenceUpdatePayload,
} from '@synccode/shared';

export interface RoomParticipantEntity extends Participant {
  socketId: string;
  reconnectToken: string;
}

export interface RoomEntity {
  roomId: string;
  hostId: string;
  isLocked: boolean;
  passwordHash?: string;
  document: RoomDocument;
  participants: Map<string, RoomParticipantEntity>;
  createdAt: number;
  hostDisconnectedAt?: number;
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
  private hostPromotionTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly hostDisconnectGraceMs = 30_000) {}

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
   * Hashes a room password using bcrypt with standard cost factor (10 rounds).
   */
  private hashPassword(password: string): string {
    return bcrypt.hashSync(password, 10);
  }

  /**
   * Validates a candidate password against the stored bcrypt hash.
   */
  private verifyPassword(password: string, storedHash: string): boolean {
    return bcrypt.compareSync(password, storedHash);
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
  ): { room: RoomState; participant: Participant; reconnectToken: string } {
    if (!request.displayName || request.displayName.trim().length === 0) {
      throw new RoomError('INVALID_REQUEST', 'Display name is required');
    }

    const roomId = this.generateRoomId();
    const userId = hostUserId || `user-${crypto.randomBytes(6).toString('hex')}`;
    const reconnectToken = crypto.randomBytes(32).toString('hex');
    const displayName = request.displayName.trim().slice(0, 32);

    const hostColor = PARTICIPANT_PALETTE[0];
    const hostParticipant: RoomParticipantEntity = {
      userId,
      socketId,
      reconnectToken,
      displayName,
      role: 'HOST',
      color: hostColor,
      connectionState: 'CONNECTED',
      isMuted: true,
      isSpeaking: false,
      isTyping: false,
    };

    const initialLang = request.language || 'javascript';
    const defaultTemplate =
      request.initialContent ||
      (initialLang === 'java'
        ? `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, SyncCode!");\n    }\n}\n`
        : initialLang === 'python'
          ? `# Welcome to SyncCode! (Room: ${roomId})\n# Connected as Host: ${displayName}\n\nprint("Hello, SyncCode!")\n`
          : initialLang === 'cpp'
            ? `// Welcome to SyncCode! (Room: ${roomId})\n// Connected as Host: ${displayName}\n\n#include <iostream>\n\nint main() {\n    std::cout << "Hello, SyncCode!" << std::endl;\n    return 0;\n}\n`
            : `// Welcome to SyncCode! (Room: ${roomId})\n// Connected as Host: ${displayName}\n\nfunction main() {\n  console.log("Hello, SyncCode!");\n}\n\nmain();\n`);

    const roomEntity: RoomEntity = {
      roomId,
      hostId: userId,
      isLocked: false,
      passwordHash: request.password ? this.hashPassword(request.password) : undefined,
      document: {
        filename:
          initialLang === 'java'
            ? 'Main.java'
            : initialLang === 'python'
              ? 'main.py'
              : initialLang === 'cpp'
                ? 'main.cpp'
                : 'main.js',
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
      reconnectToken,
    };
  }

  /**
   * Admits a participant into an existing room.
   */
  public joinRoom(
    request: JoinRoomRequest,
    socketId: string
  ): { room: RoomState; participant: Participant; reconnectToken: string; isReconnection: boolean } {
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

    const displayName = (request.displayName || '').trim().slice(0, 32);
    if (!displayName) {
      throw new RoomError('INVALID_REQUEST', 'Display name is required');
    }

    // 1. Genuine Reconnection Check (Requires valid, matching reconnect token)
    if (request.userId && room.participants.has(request.userId)) {
      const existing = room.participants.get(request.userId)!;

      // Verify token authenticity
      if (!request.reconnectToken || request.reconnectToken !== existing.reconnectToken) {
        throw new RoomError('UNAUTHORIZED', 'Invalid or missing reconnect token for participant identity');
      }

      // Prevent claiming an identity that is currently connected
      if (existing.connectionState === 'CONNECTED') {
        throw new RoomError('IDENTITY_IN_USE', 'Participant identity is already actively in use');
      }

      // Restore session
      existing.socketId = socketId;
      existing.connectionState = 'CONNECTED';
      if (room.hostId === existing.userId) {
        const timer = this.hostPromotionTimers.get(roomId);
        if (timer) clearTimeout(timer);
        this.hostPromotionTimers.delete(roomId);
        room.hostDisconnectedAt = undefined;
      }
      if (displayName) {
        existing.displayName = displayName;
      }
      this.socketToRoom.set(socketId, { roomId, userId: existing.userId });
      this.promoteAfterHostGraceIfNeeded(room, existing);

      return {
        room: this.serializeRoom(room),
        participant: this.serializeParticipant(existing),
        reconnectToken: existing.reconnectToken,
        isReconnection: true,
      };
    }

    // If client supplied an invalid reconnectToken for an unknown or mismatched userId
    if (request.reconnectToken && (!request.userId || !room.participants.has(request.userId))) {
      throw new RoomError('INVALID_RECONNECT_TOKEN', 'Reconnect token does not match any room participant');
    }

    // 2. Capacity verification for new admissions: max 5 active participants
    const activeParticipantsCount = Array.from(room.participants.values()).filter(
      (p) => p.connectionState === 'CONNECTED'
    ).length;

    if (activeParticipantsCount >= 5) {
      throw new RoomError('ROOM_FULL', 'Room has reached maximum capacity of 5 participants');
    }

    // 3. New participant registration with server-generated identity
    const newUserId = `user-${crypto.randomBytes(6).toString('hex')}`;
    const reconnectToken = crypto.randomBytes(32).toString('hex');
    const assignedColor = this.assignUniqueColor(room);

    const newParticipant: RoomParticipantEntity = {
      userId: newUserId,
      socketId,
      reconnectToken,
      displayName,
      role: 'MEMBER',
      color: assignedColor,
      connectionState: 'CONNECTED',
      isMuted: true,
      isSpeaking: false,
      isTyping: false,
    };

    room.participants.set(newUserId, newParticipant);
    this.socketToRoom.set(socketId, { roomId, userId: newUserId });

    // If the host's grace period expired while no member was online to promote,
    // assign host to the first participant who returns.
    if (
      room.hostDisconnectedAt !== undefined &&
      Date.now() - room.hostDisconnectedAt >= this.hostDisconnectGraceMs
    ) {
      this.promoteAfterHostGraceIfNeeded(room, newParticipant);
    }

    return {
      room: this.serializeRoom(room),
      participant: this.serializeParticipant(newParticipant),
      reconnectToken,
      isReconnection: false,
    };
  }

  /**
   * Reconnects an existing participant into their active room.
   */
  public reconnectParticipant(
    request: ReconnectRequest,
    socketId: string
  ): { room: RoomState; participant: Participant; reconnectToken: string } {
    const roomId = request.roomId?.trim();
    const userId = request.userId?.trim();

    if (!roomId || !userId) {
      throw new RoomError('INVALID_REQUEST', 'Room ID and User ID are required');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    const participant = room.participants.get(userId);
    if (!participant) {
      throw new RoomError('UNAUTHORIZED', `Participant '${userId}' is not a member of room '${roomId}'`);
    }

    // Token authenticity check if token is present
    if (participant.reconnectToken && request.reconnectToken) {
      if (participant.reconnectToken !== request.reconnectToken) {
        throw new RoomError('UNAUTHORIZED', 'Invalid reconnect token');
      }
    }

    // Unmap any previous socket for this user in this room
    for (const [sId, ctx] of this.socketToRoom.entries()) {
      if (ctx.userId === userId && ctx.roomId === roomId && sId !== socketId) {
        this.socketToRoom.delete(sId);
      }
    }

    // Restore participant connection
    participant.socketId = socketId;
    participant.connectionState = 'CONNECTED';

    // If host was disconnected, cancel host promotion timer
    if (room.hostId === userId) {
      const timer = this.hostPromotionTimers.get(roomId);
      if (timer) clearTimeout(timer);
      this.hostPromotionTimers.delete(roomId);
      room.hostDisconnectedAt = undefined;
    }

    this.socketToRoom.set(socketId, { roomId, userId });

    return {
      room: this.serializeRoom(room),
      participant: this.serializeParticipant(participant),
      reconnectToken: participant.reconnectToken,
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

    // Mark as disconnected and clear live cursor/typing
    participant.connectionState = 'DISCONNECTED';
    participant.isTyping = false;
    delete participant.cursor;
    delete participant.selection;

    // Give the host a grace window to reconnect before promoting another participant.
    if (room.hostId === userId) {
      room.hostDisconnectedAt = Date.now();
      const existingTimer = this.hostPromotionTimers.get(roomId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        this.hostPromotionTimers.delete(roomId);
        const currentRoom = this.rooms.get(roomId);
        const disconnectedHost = currentRoom?.participants.get(userId);
        if (
          !currentRoom ||
          currentRoom.hostId !== userId ||
          disconnectedHost?.connectionState !== 'DISCONNECTED'
        ) {
          return;
        }

        const nextActive = Array.from(currentRoom.participants.values()).find(
          (p) => p.userId !== userId && p.connectionState === 'CONNECTED'
        );
        if (nextActive) {
          disconnectedHost.role = 'MEMBER';
          nextActive.role = 'HOST';
          currentRoom.hostId = nextActive.userId;
          currentRoom.hostDisconnectedAt = undefined;
        }
      }, this.hostDisconnectGraceMs);
      timer.unref?.();
      this.hostPromotionTimers.set(roomId, timer);
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

  private promoteAfterHostGraceIfNeeded(room: RoomEntity, candidate: RoomParticipantEntity): void {
    if (
      room.hostDisconnectedAt === undefined ||
      Date.now() - room.hostDisconnectedAt < this.hostDisconnectGraceMs
    ) {
      return;
    }

    const formerHost = room.participants.get(room.hostId);
    if (!formerHost || formerHost.connectionState !== 'DISCONNECTED') return;

    const timer = this.hostPromotionTimers.get(room.roomId);
    if (timer) clearTimeout(timer);
    this.hostPromotionTimers.delete(room.roomId);

    formerHost.role = 'MEMBER';
    candidate.role = 'HOST';
    room.hostId = candidate.userId;
    room.hostDisconnectedAt = undefined;
  }

  /**
   * Host Control: Locks the room to prevent non-host edits.
   */
  public lockRoom(socketId: string, targetRoomId?: string): RoomState {
    const context = this.socketToRoom.get(socketId);
    const roomId = targetRoomId || context?.roomId;
    if (!roomId) {
      throw new RoomError('INVALID_REQUEST', 'Not in a room');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    // Authoritative host validation
    if (!context || room.hostId !== context.userId) {
      throw new RoomError('UNAUTHORIZED', 'Only the room host can lock the room');
    }

    room.isLocked = true;
    return this.serializeRoom(room);
  }

  /**
   * Host Control: Unlocks the room, restoring editing privileges.
   */
  public unlockRoom(socketId: string, targetRoomId?: string): RoomState {
    const context = this.socketToRoom.get(socketId);
    const roomId = targetRoomId || context?.roomId;
    if (!roomId) {
      throw new RoomError('INVALID_REQUEST', 'Not in a room');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    // Authoritative host validation
    if (!context || room.hostId !== context.userId) {
      throw new RoomError('UNAUTHORIZED', 'Only the room host can unlock the room');
    }

    room.isLocked = false;
    return this.serializeRoom(room);
  }

  /**
   * Host Control: Forcefully ejects a participant from the room.
   */
  public removeParticipant(
    socketId: string,
    targetUserId: string,
    targetRoomId?: string
  ): {
    roomId: string;
    targetParticipant: Participant;
    remainingParticipants: Participant[];
    targetSocketId: string;
  } {
    const context = this.socketToRoom.get(socketId);
    const roomId = targetRoomId || context?.roomId;
    if (!roomId) {
      throw new RoomError('INVALID_REQUEST', 'Not in a room');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    // Authoritative host validation
    if (!context || room.hostId !== context.userId) {
      throw new RoomError('UNAUTHORIZED', 'Only the room host can remove participants');
    }

    // Host cannot remove themselves
    if (targetUserId === room.hostId || targetUserId === context.userId) {
      throw new RoomError('INVALID_REQUEST', 'Host cannot remove themselves from the room');
    }

    const target = room.participants.get(targetUserId);
    if (!target) {
      throw new RoomError('INVALID_REQUEST', 'Target participant not found in this room');
    }

    const targetSocketId = target.socketId;

    // Clean up participant and socket mappings
    this.socketToRoom.delete(targetSocketId);
    room.participants.delete(targetUserId);

    const remaining = Array.from(room.participants.values())
      .filter((p) => p.connectionState === 'CONNECTED')
      .map((p) => this.serializeParticipant(p));

    return {
      roomId,
      targetParticipant: this.serializeParticipant(target),
      remainingParticipants: remaining,
      targetSocketId,
    };
  }

  /**
   * Host Control: Closes and cleanly terminates the room session.
   */
  public closeRoom(
    socketId: string,
    targetRoomId?: string
  ): { roomId: string; affectedSocketIds: string[] } {
    const context = this.socketToRoom.get(socketId);
    const roomId = targetRoomId || context?.roomId;
    if (!roomId) {
      throw new RoomError('INVALID_REQUEST', 'Not in a room');
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', `Room '${roomId}' does not exist`);
    }

    // Authoritative host validation
    if (!context || room.hostId !== context.userId) {
      throw new RoomError('UNAUTHORIZED', 'Only the room host can close the room');
    }

    const affectedSocketIds: string[] = [];
    const hostPromotionTimer = this.hostPromotionTimers.get(roomId);
    if (hostPromotionTimer) clearTimeout(hostPromotionTimer);
    this.hostPromotionTimers.delete(roomId);
    for (const p of room.participants.values()) {
      affectedSocketIds.push(p.socketId);
      this.socketToRoom.delete(p.socketId);
    }

    this.rooms.delete(roomId);

    return {
      roomId,
      affectedSocketIds,
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
   * Updates participant cursor position and optional selection range.
   */
  public updateCursor(
    socketId: string,
    position: CursorPosition,
    selection?: MonacoRange
  ): { roomId: string; participant: Participant } | null {
    const mapping = this.socketToRoom.get(socketId);
    if (!mapping) return null;

    const room = this.rooms.get(mapping.roomId);
    if (!room) return null;

    const participant = room.participants.get(mapping.userId);
    if (!participant || participant.connectionState !== 'CONNECTED') return null;

    participant.cursor = {
      lineNumber: Math.max(1, position.lineNumber),
      column: Math.max(1, position.column),
    };

    if (selection) {
      participant.selection = selection;
    } else {
      delete participant.selection;
    }

    return {
      roomId: room.roomId,
      participant: this.serializeParticipant(participant),
    };
  }

  /**
   * Updates participant presence state (typing status, microphone, speaking).
   */
  public updatePresence(
    socketId: string,
    update: Partial<PresenceUpdatePayload>
  ): { roomId: string; participant: Participant } | null {
    const mapping = this.socketToRoom.get(socketId);
    if (!mapping) return null;

    const room = this.rooms.get(mapping.roomId);
    if (!room) return null;

    const participant = room.participants.get(mapping.userId);
    if (!participant || participant.connectionState !== 'CONNECTED') return null;

    if (typeof update.isTyping === 'boolean') {
      participant.isTyping = update.isTyping;
    }
    if (typeof update.isMuted === 'boolean') {
      participant.isMuted = update.isMuted;
    }
    if (typeof update.isSpeaking === 'boolean') {
      participant.isSpeaking = update.isSpeaking;
    }

    return {
      roomId: room.roomId,
      participant: this.serializeParticipant(participant),
    };
  }

  /**
   * Retrieves the current socket ID for a given user in a room.
   */
  public getParticipantSocketId(roomId: string, userId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const participant = room.participants.get(userId);
    return participant ? participant.socketId : null;
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
   * Strips internal fields (like socketId and reconnectToken) from participant object.
   */
  private serializeParticipant(p: RoomParticipantEntity | (Participant & { socketId: string })): Participant {
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
