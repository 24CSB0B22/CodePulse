import { Router, Request, Response } from 'express';
import { executionService } from '../modules/execution';
import { SupportedLanguage } from '@synccode/shared';

export const executionRouter = Router();

/**
 * GET /api/v1/execution/status
 * Returns current sandbox execution provider status and language runtimes.
 */
executionRouter.get('/status', async (_req: Request, res: Response) => {
  const status = await executionService.checkHealth(2500);
  res.status(200).json({
    success: true,
    data: status,
  });
});

/**
 * POST /api/v1/execution/run
 * Dispatches code execution to the isolated sandbox provider.
 * Never executes code directly on the host server.
 */
executionRouter.post('/run', async (req: Request, res: Response) => {
  const { roomId, language, code, stdin, args, timeoutMs } = req.body;

  if (!language || typeof language !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: language',
    });
  }

  if (typeof code !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: code',
    });
  }

  const result = await executionService.execute({
    roomId,
    language: language as SupportedLanguage,
    code,
    stdin,
    args,
    timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
  });

  return res.status(200).json({
    success: true,
    data: result,
  });
});
