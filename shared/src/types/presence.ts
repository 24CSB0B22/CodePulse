import { CursorPosition } from './room';
import { MonacoRange } from './operations';

export interface CursorUpdatePayload {
  roomId?: string;
  position: CursorPosition;
  selection?: MonacoRange;
}

export interface RemoteCursorBroadcast {
  roomId?: string;
  userId: string;
  displayName: string;
  colorHex: string;
  position: CursorPosition;
  selection?: MonacoRange;
}

export interface TypingUpdatePayload {
  roomId?: string;
  userId?: string;
  isTyping: boolean;
}
