/**
 * Centralized Socket.IO event names shared between client and server.
 */
export const SOCKET_EVENTS = {
  // Connection / Lifecycle
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  CONNECT_ERROR: 'connect_error',
  PING: 'ping',
  PONG: 'pong',

  // Room lifecycle
  ROOM_CREATE: 'room:create',
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  ROOM_STATE: 'room:state',
  ROOM_LOCK: 'room:lock',
  ROOM_UNLOCK: 'room:unlock',
  ROOM_CLOSE: 'room:close',
  ROOM_ERROR: 'room:error',

  // Participant updates
  PARTICIPANT_JOINED: 'participant:joined',
  PARTICIPANT_LEFT: 'participant:left',
  PARTICIPANT_UPDATE: 'participant:update',
  PARTICIPANT_REMOVE: 'participant:remove',

  // Collaborative editing
  EDITOR_OPERATION: 'editor:operation',
  EDITOR_ACK: 'editor:ack',
  EDITOR_SYNC: 'editor:sync',

  // Presence & Cursors
  CURSOR_UPDATE: 'cursor:update',
  CURSOR_BROADCAST: 'cursor:broadcast',
  PRESENCE_TYPING: 'presence:typing',
  PRESENCE_UPDATE: 'presence:update',

  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_MESSAGE: 'chat:message',

  // Voice (WebRTC Signaling)
  VOICE_JOIN: 'voice:join',
  VOICE_LEAVE: 'voice:leave',
  VOICE_OFFER: 'voice:offer',
  VOICE_ANSWER: 'voice:answer',
  VOICE_ICE_CANDIDATE: 'voice:ice-candidate',
  VOICE_PEER_JOINED: 'voice:peer-joined',
  VOICE_PEER_LEFT: 'voice:peer-left',
  VOICE_SPEAKING: 'voice:speaking',

  // Execution
  EXECUTION_REQUEST: 'execution:request',
  EXECUTION_RESULT: 'execution:result',

  // Reconnection
  RECONNECT_REQUEST: 'reconnect:request',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
