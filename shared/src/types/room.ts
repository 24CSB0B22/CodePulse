import { ParticipantColor } from '../constants/colors';
import { MonacoRange } from './operations';

export type { MonacoRange };

export type UserRole = 'HOST' | 'MEMBER';
export type ConnectionState = 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export interface CursorPosition {
  lineNumber: number;
  column: number;
}

export interface Participant {
  userId: string;
  displayName: string;
  role: UserRole;
  color: ParticipantColor;
  connectionState: ConnectionState;
  isMuted: boolean;
  isSpeaking: boolean;
  cursor?: CursorPosition;
  selection?: MonacoRange;
  isTyping?: boolean;
}

export interface RoomDocument {
  filename: string;
  language: string;
  content: string;
  currentRevision: number;
}

export interface RoomState {
  roomId: string;
  hostId: string;
  isLocked: boolean;
  maxParticipants: 5;
  participants: Participant[];
  document: RoomDocument;
  hasPassword?: boolean;
}

export interface CreateRoomRequest {
  displayName: string;
  password?: string;
  language?: string;
  initialContent?: string;
}

export interface JoinRoomRequest {
  roomId: string;
  displayName: string;
  password?: string;
  userId?: string;
}

export interface LeaveRoomRequest {
  roomId: string;
  userId?: string;
}

export type RoomErrorCode =
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'INVALID_PASSWORD'
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'ALREADY_IN_ROOM'
  | 'INTERNAL_ERROR';

export interface RoomErrorPayload {
  code: RoomErrorCode;
  message: string;
}

export interface ParticipantJoinedPayload {
  roomId: string;
  participant: Participant;
}

export interface ParticipantLeftPayload {
  roomId: string;
  userId: string;
  displayName: string;
  reason?: string;
}

export interface PresenceUpdatePayload {
  roomId: string;
  userId: string;
  connectionState: ConnectionState;
}
