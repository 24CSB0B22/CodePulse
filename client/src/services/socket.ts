import { io, Socket } from 'socket.io-client';
import { CLIENT_ENV } from '../config/env';

let socketInstance: Socket | null = null;

export function getSocket(): Socket {
  if (!socketInstance) {
    socketInstance = io(CLIENT_ENV.SERVER_URL, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    if (typeof window !== 'undefined') {
      (window as any).__synccode_socket = socketInstance;
    }
  }
  return socketInstance;
}
