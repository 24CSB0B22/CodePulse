import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { SOCKET_EVENTS } from '@synccode/shared';
import { ENV } from '../config/env';
import { registerRoomHandlers } from './roomHandlers';
import { registerEditorHandlers } from './editorHandlers';

export function setupSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: [ENV.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
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
  });

  return io;
}
