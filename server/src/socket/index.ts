import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '@synccode/shared';
import { ENV } from '../config/env';
import { registerRoomHandlers } from './roomHandlers';
import { registerEditorHandlers } from './editorHandlers';
import { registerChatHandlers } from './chatHandlers';
import { registerVoiceHandlers } from './voiceHandlers';
import { registerExecutionHandlers } from './executionHandlers';

export function setupSocketServer(httpServer: HttpServer): Server {
  const isProd = ENV.NODE_ENV === 'production';
  const allowedOrigins = isProd
    ? [ENV.CLIENT_ORIGIN]
    : [ENV.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on(SOCKET_EVENTS.CONNECT, (socket: Socket) => {
    // Basic Ping/Pong check for connection health
    socket.on(SOCKET_EVENTS.PING, (callback?: () => void) => {
      socket.emit(SOCKET_EVENTS.PONG, { timestamp: Date.now() });
      if (typeof callback === 'function') {
        callback();
      }
    });

    // Register Room Management Event Handlers
    registerRoomHandlers(io, socket);

    // Register Collaborative Editor Event Handlers
    registerEditorHandlers(io, socket);

    // Register Room Chat Event Handlers
    registerChatHandlers(io, socket);

    // Register WebRTC Voice Signaling Event Handlers
    registerVoiceHandlers(io, socket);

    // Register Isolated Code Execution Event Handlers
    registerExecutionHandlers(io, socket);
  });

  return io;
}
