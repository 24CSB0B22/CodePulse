export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'cpp' | 'java';

export interface ExecutionRequest {
  roomId: string;
  language: SupportedLanguage;
  code: string;
}

export interface ExecutionResult {
  executionId: string;
  roomId: string;
  status: 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'MEMORY_LIMIT';
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timestamp: number;
}
