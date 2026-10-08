export const MAX_CHAT_MESSAGE_LENGTH = 1000;

export interface ChatMessage {
  messageId: string;
  roomId: string;
  userId: string;
  displayName: string;
  colorHex: string;
  content: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface SendChatMessageRequest {
  roomId?: string;
  content: string;
}

export type ChatErrorCode =
  | 'INVALID_MESSAGE'
  | 'MESSAGE_TOO_LONG'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'ROOM_NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ChatErrorPayload {
  code: ChatErrorCode;
  message: string;
}

export interface SendChatMessageResponse {
  success: boolean;
  message?: ChatMessage;
  error?: ChatErrorPayload;
}
