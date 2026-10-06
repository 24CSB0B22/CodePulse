import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ENV } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

export function createApp(): Application {
  const app = express();

  // Basic security and CORS headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // For easier dev iframe / asset loading
    })
  );

  app.use(
    cors({
      origin: [ENV.CLIENT_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'],
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

  // Catch 404s
  app.use(notFoundHandler);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
