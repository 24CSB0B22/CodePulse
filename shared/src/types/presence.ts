import { CursorPosition } from './room';
import { MonacoRange } from './operations';

export interface CursorUpdatePayload {
  position: CursorPosition;
  selection?: MonacoRange;
}

export interface RemoteCursorBroadcast {
  userId: string;
  displayName: string;
  colorHex: string;
  position: CursorPosition;
  selection?: MonacoRange;
}

export interface TypingUpdatePayload {
  isTyping: boolean;
}
