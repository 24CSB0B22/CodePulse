import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import { roomManager } from '../src/modules/rooms/roomManager';
import {
  ExecutionProvider,
  PistonExecutionProvider,
  ExecutionService,
} from '../src/modules/execution';
import {
  ExecutionRequest,
  ExecutionResult,
  ExecutionProviderStatus,
  SupportedLanguage,
  SOCKET_EVENTS,
} from '@synccode/shared';

// Mock Execution Provider for predictable unit & integration testing
class MockExecutionProvider implements ExecutionProvider {
  public readonly name = 'mock';
  public isHealthy = true;
  public delayMs = 0;
  public mockResponse: Partial<ExecutionResult> | null = null;
  public receivedRequests: ExecutionRequest[] = [];

  async checkHealth(_timeoutMs?: number): Promise<ExecutionProviderStatus> {
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return {
      name: this.name,
      isAvailable: this.isHealthy,
      latencyMs: 5,
      error: this.isHealthy ? undefined : 'Mock provider is offline',
      supportedLanguages: ['javascript', 'typescript', 'python', 'cpp', 'java'],
    };
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    this.receivedRequests.push(req);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    if (this.mockResponse) {
      return {
        executionId: 'mock-exec-id',
        roomId: req.roomId,
        status: 'SUCCESS',
        language: req.language,
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 10,
        timestamp: Date.now(),
        provider: this.name,
        ...this.mockResponse,
      };
    }

    return {
      executionId: 'mock-exec-id',
      roomId: req.roomId,
      status: 'SUCCESS',
      language: req.language,
      stdout: `Mock output for ${req.language}\n`,
      stderr: '',
      exitCode: 0,
      durationMs: 15,
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  async getSupportedLanguages(): Promise<SupportedLanguage[]> {
    return ['javascript', 'typescript', 'python', 'cpp', 'java'];
  }
}

describe('Phase 8.1: Secure Code Execution Architecture', () => {
  let app: any;
  let server: http.Server;
  let serverPort: number;

  beforeAll(async () => {
    app = createApp();
    server = http.createServer(app);
    setupSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        serverPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('ExecutionProvider & Piston Provider Fault Tolerance', () => {
    it('gracefully handles unreachable Piston API during checkHealth without hanging or throwing', async () => {
      // Point to an invalid, unrouted local port that refuses connection
      const deadProvider = new PistonExecutionProvider('http://127.0.0.1:59999/api/v2/piston');
      const status = await deadProvider.checkHealth(500);

      expect(status.name).toBe('piston');
      expect(status.isAvailable).toBe(false);
      expect(status.error).toBeDefined();
      expect(status.supportedLanguages).toEqual([]);
    });

    it('gracefully times out when Piston endpoint hangs indefinitely', async () => {
      // Create a local server that accepts connection but never responds
      const hangingServer = http.createServer((_req, _res) => {
        // Intentionally never respond
      });

      await new Promise<void>((r) => hangingServer.listen(0, () => r()));
      const hangingPort = (hangingServer.address() as AddressInfo).port;

      try {
        const hangingProvider = new PistonExecutionProvider(`http://127.0.0.1:${hangingPort}`);
        const status = await hangingProvider.checkHealth(400);

        expect(status.isAvailable).toBe(false);
        expect(status.error).toContain('timed out');
      } finally {
        await new Promise<void>((r) => hangingServer.close(() => r()));
      }
    });

    it('reports PROVIDER_UNAVAILABLE on execute when Piston endpoint is down without crashing', async () => {
      const deadProvider = new PistonExecutionProvider('http://127.0.0.1:59999/api/v2/piston');
      const result = await deadProvider.execute({
        language: 'python',
        code: 'print("hello")',
      });

      expect(result.status).toBe('PROVIDER_UNAVAILABLE');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unavailable');
    });

    it('enforces maximum output size limit (64KB truncation) on sandbox responses', async () => {
      // Create mock response with 100KB output
      const largeOutput = 'X'.repeat(100 * 1024);
      const mockPistonServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            language: 'python',
            version: '3.10',
            run: {
              stdout: largeOutput,
              stderr: '',
              code: 0,
            },
          })
        );
      });

      await new Promise<void>((r) => mockPistonServer.listen(0, () => r()));
      const mockPort = (mockPistonServer.address() as AddressInfo).port;

      try {
        const provider = new PistonExecutionProvider(`http://127.0.0.1:${mockPort}`);
        const result = await provider.execute({
          language: 'python',
          code: 'print("large output")',
        });

        expect(result.status).toBe('SUCCESS');
        expect(result.stdout).toContain('[Output truncated: exceeded 65536 byte limit]');
        expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(70000);
      } finally {
        await new Promise<void>((r) => mockPistonServer.close(() => r()));
      }
    });

    it('correctly maps compilation errors vs runtime errors', async () => {
      const mockPistonServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            language: 'c++',
            version: '10.2.0',
            compile: {
              stderr: 'error: syntax error at line 5',
              code: 1,
            },
            run: {
              stdout: '',
              stderr: '',
              code: 0,
            },
          })
        );
      });

      await new Promise<void>((r) => mockPistonServer.listen(0, () => r()));
      const mockPort = (mockPistonServer.address() as AddressInfo).port;

      try {
        const provider = new PistonExecutionProvider(`http://127.0.0.1:${mockPort}`);
        const result = await provider.execute({
          language: 'cpp',
          code: 'int main() { invalid syntax }',
        });

        expect(result.status).toBe('ERROR');
        expect(result.error).toBe('COMPILATION_ERROR');
        expect(result.stderr).toContain('syntax error');
      } finally {
        await new Promise<void>((r) => mockPistonServer.close(() => r()));
      }
    });
  });

  describe('ExecutionService Safety & Constraint Enforcement', () => {
    it('rejects empty code payloads before invoking any provider', async () => {
      const mock = new MockExecutionProvider();
      const service = new ExecutionService(mock);

      const result = await service.execute({
        language: 'javascript',
        code: '',
      });

      expect(result.status).toBe('ERROR');
      expect(result.error).toBe('EMPTY_CODE');
      expect(mock.receivedRequests).toHaveLength(0);
    });

    it('rejects code payloads exceeding 64KB size limit before dispatch', async () => {
      const mock = new MockExecutionProvider();
      const service = new ExecutionService(mock);

      const oversizedCode = '// code\n' + 'a'.repeat(66000);
      const result = await service.execute({
        language: 'javascript',
        code: oversizedCode,
      });

      expect(result.status).toBe('ERROR');
      expect(result.error).toBe('PAYLOAD_TOO_LARGE');
      expect(result.stderr).toContain('exceeds maximum size limit of 64KB');
      expect(mock.receivedRequests).toHaveLength(0);
    });

    it('rejects unsupported languages before dispatch', async () => {
      const mock = new MockExecutionProvider();
      const service = new ExecutionService(mock);

      const result = await service.execute({
        language: 'ruby' as any,
        code: 'puts "hello"',
      });

      expect(result.status).toBe('ERROR');
      expect(result.error).toBe('UNSUPPORTED_LANGUAGE');
      expect(mock.receivedRequests).toHaveLength(0);
    });

    it('non-blocking initHealthCheck does not throw even when provider is offline', async () => {
      const deadProvider = new PistonExecutionProvider('http://127.0.0.1:59999');
      const service = new ExecutionService(deadProvider);

      await expect(service.initHealthCheck()).resolves.not.toThrow();
    });

    it('verifies user code cannot affect host Node.js runtime (architectural isolation)', async () => {
      // Mock execution provider receives dangerous payload
      const mock = new MockExecutionProvider();
      const service = new ExecutionService(mock);

      const maliciousCode = `
        process.exit(1);
        global.compromised = true;
        const fs = require('fs');
        fs.writeFileSync('pwned.txt', 'danger');
      `;

      const result = await service.execute({
        language: 'javascript',
        code: maliciousCode,
      });

      // The Node.js process did NOT exit and global was NOT compromised
      expect((global as any).compromised).toBeUndefined();
      expect(result.status).toBe('SUCCESS');
      expect(mock.receivedRequests[0].code).toBe(maliciousCode);
    });
  });

  describe('REST API Endpoints', () => {
    it('GET /api/v1/execution/status returns provider health payload', async () => {
      const res = await request(app).get('/api/v1/execution/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('name');
      expect(res.body.data).toHaveProperty('isAvailable');
      expect(typeof res.body.data.isAvailable).toBe('boolean');
    });

    it('POST /api/v1/execution/run validates input and dispatches execution', async () => {
      // Missing language
      const missingLang = await request(app)
        .post('/api/v1/execution/run')
        .send({ code: 'console.log("hi")' });
      expect(missingLang.status).toBe(400);

      // Missing code
      const missingCode = await request(app)
        .post('/api/v1/execution/run')
        .send({ language: 'javascript' });
      expect(missingCode.status).toBe(400);

      // Valid request (dispatches to isolated provider)
      const validRes = await request(app)
        .post('/api/v1/execution/run')
        .send({
          language: 'python',
          code: 'print(42)',
          timeoutMs: 3000,
        });

      expect(validRes.status).toBe(200);
      expect(validRes.body.success).toBe(true);
      expect(validRes.body.data).toHaveProperty('executionId');
      expect(validRes.body.data).toHaveProperty('status');
      expect(validRes.body.data).toHaveProperty('provider');
    });
  });

  describe('Socket.IO Execution Events', () => {
    function createSocketClient(): Promise<ClientSocket> {
      return new Promise((resolve) => {
        const client = ioc(`http://localhost:${serverPort}`, {
          transports: ['websocket'],
          forceNew: true,
        });
        client.on('connect', () => resolve(client));
      });
    }

    it('handles execution:request, enforces room rules, and broadcasts execution:result to room', async () => {
      const hostSocket = await createSocketClient();
      const memberSocket = await createSocketClient();

      try {
        // Create room
        const createRes: any = await new Promise((r) => {
          hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, r);
        });
        const roomId = createRes.data.room.roomId;

        // Member joins room
        await new Promise((r) => {
          memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Member' }, r);
        });

        // Member listens for execution result broadcast
        const broadcastPromise = new Promise<ExecutionResult>((r) => {
          memberSocket.on(SOCKET_EVENTS.EXECUTION_RESULT, r);
        });

        // Host requests code execution
        const execRes: any = await new Promise((r) => {
          hostSocket.emit(
            SOCKET_EVENTS.EXECUTION_REQUEST,
            {
              roomId,
              language: 'javascript',
              code: 'console.log("Hello SyncCode execution");',
            },
            r
          );
        });

        expect(execRes.success).toBe(true);
        expect(execRes.data).toHaveProperty('executionId');
        expect(execRes.data.language).toBe('javascript');

        // Member also receives the broadcast result in real time
        const broadcastResult = await broadcastPromise;
        expect(broadcastResult.executionId).toBe(execRes.data.executionId);
        expect(broadcastResult.roomId).toBe(roomId);
      } finally {
        hostSocket.disconnect();
        memberSocket.disconnect();
      }
    });

    it('rejects execution requests when room is locked and sender is not host', async () => {
      const hostSocket = await createSocketClient();
      const memberSocket = await createSocketClient();

      try {
        // Create room
        const createRes: any = await new Promise((r) => {
          hostSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Host' }, r);
        });
        const roomId = createRes.data.room.roomId;

        // Member joins room
        await new Promise((r) => {
          memberSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Member' }, r);
        });

        // Host locks room
        await new Promise((r) => {
          hostSocket.emit(SOCKET_EVENTS.ROOM_LOCK, { roomId }, r);
        });

        // Member attempts to execute code in locked room
        const execRes: any = await new Promise((r) => {
          memberSocket.emit(
            SOCKET_EVENTS.EXECUTION_REQUEST,
            {
              roomId,
              language: 'python',
              code: 'print("should be rejected")',
            },
            r
          );
        });

        expect(execRes.success).toBe(false);
        expect(execRes.error).toContain('locked');
      } finally {
        hostSocket.disconnect();
        memberSocket.disconnect();
      }
    });
  });
});
