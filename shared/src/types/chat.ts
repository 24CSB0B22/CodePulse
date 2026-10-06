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
  roomId: string;
  content: string;
}
