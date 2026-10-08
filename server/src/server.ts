import http from 'http';
import { createApp } from './app';
import { setupSocketServer } from './socket';
import { ENV } from './config/env';
import { executionService } from './modules/execution';

const app = createApp();
const httpServer = http.createServer(app);
const io = setupSocketServer(httpServer);

if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(ENV.PORT, () => {
    console.log(`===============================================`);
    console.log(`🚀 SyncCode Server running on port ${ENV.PORT}`);
    console.log(`🌍 Environment: ${ENV.NODE_ENV}`);
    console.log(`📡 Client Origin: ${ENV.CLIENT_ORIGIN}`);
    console.log(`===============================================`);

    // Non-blocking background health check for code execution sandbox
    executionService.initHealthCheck().catch(() => {});
  });
}

export { app, httpServer, io };
