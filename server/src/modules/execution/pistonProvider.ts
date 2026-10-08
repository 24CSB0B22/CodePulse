import crypto from 'crypto';
import {
  ExecutionRequest,
  ExecutionResult,
  ExecutionProviderStatus,
  SupportedLanguage,
} from '@synccode/shared';
import { ExecutionProvider, ExecutionProviderOptions } from './executionProvider';

interface PistonFile {
  name?: string;
  content: string;
  encoding?: string;
}

interface PistonStageResult {
  stdout?: string;
  stderr?: string;
  output?: string;
  code?: number | null;
  signal?: string | null;
  message?: string;
}

interface PistonExecuteResponse {
  language: string;
  version: string;
  run?: PistonStageResult;
  compile?: PistonStageResult;
  message?: string;
}

const LANGUAGE_CONFIG: Record<
  SupportedLanguage,
  { pistonLanguage: string; defaultFileName: string }
> = {
  javascript: { pistonLanguage: 'javascript', defaultFileName: 'index.js' },
  typescript: { pistonLanguage: 'typescript', defaultFileName: 'index.ts' },
  python: { pistonLanguage: 'python', defaultFileName: 'main.py' },
  cpp: { pistonLanguage: 'c++', defaultFileName: 'main.cpp' },
  java: { pistonLanguage: 'java', defaultFileName: 'Main.java' },
};

export class PistonExecutionProvider implements ExecutionProvider {
  public readonly name = 'piston';
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl || process.env.PISTON_API_URL || 'https://emkc.org/api/v2/piston').replace(
      /\/+$/,
      ''
    );
  }

  /**
   * Fast health and availability check with strict timeout.
   * Does NOT throw; returns availability state and descriptive error if offline.
   */
  public async checkHealth(timeoutMs = 2500): Promise<ExecutionProviderStatus> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/runtimes`, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        return {
          name: this.name,
          isAvailable: false,
          latencyMs,
          endpoint: this.baseUrl,
          error: `Piston endpoint returned HTTP ${response.status} (${response.statusText})`,
          supportedLanguages: [],
        };
      }

      const runtimes: any = await response.json();
      const availableLanguages: string[] = Array.isArray(runtimes)
        ? runtimes.map((r: any) => r.language)
        : [];

      return {
        name: this.name,
        isAvailable: true,
        latencyMs,
        endpoint: this.baseUrl,
        supportedLanguages: availableLanguages,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;
      const isTimeout =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError');

      const errorMessage = isTimeout
        ? `Connection to Piston API timed out after ${timeoutMs}ms (external service unreachable or filtered)`
        : err instanceof Error
          ? `Failed to reach Piston API: ${err.message}`
          : 'Piston API unreachable';

      return {
        name: this.name,
        isAvailable: false,
        latencyMs,
        endpoint: this.baseUrl,
        error: errorMessage,
        supportedLanguages: [],
      };
    }
  }

  /**
   * Dispatches code execution to isolated Piston sandbox container.
   * Arbitrary user code is NEVER executed inside the Node.js process.
   */
  public async execute(
    request: ExecutionRequest,
    options?: ExecutionProviderOptions
  ): Promise<ExecutionResult> {
    const executionId = `exec-${crypto.randomUUID()}`;
    const startTime = Date.now();
    const config = LANGUAGE_CONFIG[request.language];

    if (!config) {
      return {
        executionId,
        roomId: request.roomId,
        status: 'ERROR',
        language: request.language,
        stdout: '',
        stderr: `Unsupported language: '${request.language}'. Supported: ${Object.keys(LANGUAGE_CONFIG).join(', ')}`,
        exitCode: 1,
        durationMs: 0,
        timestamp: Date.now(),
        provider: this.name,
        error: `Unsupported language: '${request.language}'`,
      };
    }

    const timeoutMs = Math.min(Math.max(options?.timeoutMs || request.timeoutMs || 5000, 1000), 15000);
    const maxOutputBytes = options?.maxOutputBytes || 65536; // 64KB output constraint

    const files: PistonFile[] = [
      {
        name: config.defaultFileName,
        content: request.code,
      },
    ];

    const payload = {
      language: config.pistonLanguage,
      version: '*',
      files,
      stdin: request.stdin || '',
      args: request.args || [],
      compile_timeout: 10000,
      run_timeout: timeoutMs,
    };

    // Controller with network safety margin over execution timeout
    const controller = new AbortController();
    const networkTimeout = timeoutMs + 3000;
    const timer = setTimeout(() => controller.abort(), networkTimeout);

    try {
      const response = await fetch(`${this.baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        let errorBody = '';
        try {
          const bodyJson: any = await response.json();
          errorBody = bodyJson.message || response.statusText;
        } catch {
          errorBody = response.statusText;
        }

        if (response.status === 429) {
          return {
            executionId,
            roomId: request.roomId,
            status: 'ERROR',
            language: request.language,
            stdout: '',
            stderr: 'Execution rate limit exceeded. Please wait a moment before running again.',
            exitCode: 429,
            durationMs,
            timestamp: Date.now(),
            provider: this.name,
            error: 'RATE_LIMITED',
          };
        }

        return {
          executionId,
          roomId: request.roomId,
          status: 'PROVIDER_UNAVAILABLE',
          language: request.language,
          stdout: '',
          stderr: `Piston sandbox returned HTTP ${response.status}: ${errorBody}`,
          exitCode: 1,
          durationMs,
          timestamp: Date.now(),
          provider: this.name,
          error: `HTTP_${response.status}: ${errorBody}`,
        };
      }

      const data = (await response.json()) as PistonExecuteResponse;

      // Check compilation failure
      if (data.compile && data.compile.code !== 0 && data.compile.code !== null) {
        const compileOut = this.truncate(
          (data.compile.stderr || data.compile.output || '').trim(),
          maxOutputBytes
        );
        return {
          executionId,
          roomId: request.roomId,
          status: 'ERROR',
          language: request.language,
          version: data.version,
          stdout: '',
          stderr: compileOut,
          compileOutput: compileOut,
          exitCode: data.compile.code || 1,
          durationMs,
          timestamp: Date.now(),
          provider: this.name,
          error: 'COMPILATION_ERROR',
        };
      }

      // Check execution stage
      const runStage = data.run || {};
      const rawStdout = runStage.stdout || '';
      const rawStderr = runStage.stderr || '';

      const stdout = this.truncate(rawStdout, maxOutputBytes);
      const stderr = this.truncate(rawStderr, maxOutputBytes);
      const exitCode = runStage.code !== null && runStage.code !== undefined ? runStage.code : 0;

      // Detect timeout / signal termination
      const isTimeout =
        runStage.signal === 'SIGKILL' ||
        runStage.signal === 'SIGTERM' ||
        (runStage.output || '').toLowerCase().includes('timed out');

      return {
        executionId,
        roomId: request.roomId,
        status: isTimeout ? 'TIMEOUT' : exitCode === 0 ? 'SUCCESS' : 'ERROR',
        language: request.language,
        version: data.version,
        stdout,
        stderr: isTimeout ? `${stderr}\nExecution timed out after ${timeoutMs}ms`.trim() : stderr,
        compileOutput: data.compile ? (data.compile.output || '').trim() : undefined,
        exitCode: isTimeout ? 124 : exitCode,
        durationMs,
        timestamp: Date.now(),
        provider: this.name,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError');

      if (isAbort) {
        return {
          executionId,
          roomId: request.roomId,
          status: 'TIMEOUT',
          language: request.language,
          stdout: '',
          stderr: `Execution timed out after ${timeoutMs}ms or external sandbox response was delayed.`,
          exitCode: 124,
          durationMs,
          timestamp: Date.now(),
          provider: this.name,
          error: 'TIMEOUT',
        };
      }

      const message = err instanceof Error ? err.message : 'Unknown network failure';
      return {
        executionId,
        roomId: request.roomId,
        status: 'PROVIDER_UNAVAILABLE',
        language: request.language,
        stdout: '',
        stderr: `External code execution sandbox is unavailable (${message}).`,
        exitCode: 1,
        durationMs,
        timestamp: Date.now(),
        provider: this.name,
        error: message,
      };
    }
  }

  /**
   * Retrieves array of supported languages for this provider.
   */
  public async getSupportedLanguages(): Promise<SupportedLanguage[]> {
    return Object.keys(LANGUAGE_CONFIG) as SupportedLanguage[];
  }

  private truncate(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
      return text;
    }
    const truncated = text.slice(0, maxBytes);
    return `${truncated}\n[Output truncated: exceeded ${maxBytes} byte limit]`;
  }
}
