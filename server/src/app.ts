import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ENV } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { executionRouter } from './routes/executionRoutes';

export function createApp(): Application {
  const app = express();

  const isProd = ENV.NODE_ENV === 'production';
  const allowedOrigins = isProd
    ? [ENV.CLIENT_ORIGIN]
    : [ENV.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];

  // Content-Security-Policy & Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'",
            "'unsafe-inline'", // Monaco editor inline initialization & scripts
            "'unsafe-eval'", // Monaco dynamic web worker evaluation
          ],
          styleSrc: ["'self'", "'unsafe-inline'"], // Monaco & Tailwind dynamic styling
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: [
            "'self'",
            'ws:',
            'wss:',
            'blob:',
            ENV.CLIENT_ORIGIN,
            ...(isProd ? [] : ['http://localhost:5173', 'ws://localhost:5173', 'http://127.0.0.1:5173', 'ws://127.0.0.1:5173']),
          ],
          workerSrc: ["'self'", 'blob:'], // Monaco editor background workers
          childSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true;
    if (isProd) {
      return origin === ENV.CLIENT_ORIGIN;
    }
    if (allowedOrigins.includes(origin)) {
      return true;
    }
    // Allow LAN origins for multi-device testing (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    return /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/.test(
      origin
    );
  };

  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check endpoint
  app.get('/api/v1/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'SyncCode Server',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: ENV.NODE_ENV,
    });
  });

  // Sandboxed Code Execution routes
  app.use('/api/v1/execution', executionRouter);

  // Catch 404s
  app.use(notFoundHandler);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
