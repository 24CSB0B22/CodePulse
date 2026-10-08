/**
 * Core operation/delta synchronization data contracts.
 * Matches AGENTS.md requirements.
 */

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditOperation {
  operationId: string;
  userId: string;
  baseRevision: number;
  range: MonacoRange;
  insertedText: string;
  deletedText: string;
  deleteCount?: number;
  rangeLength?: number;
  timestamp: number;
  clientSequence: number;
  roomId?: string;
}

export interface BroadcastEditOperation extends EditOperation {
  revision: number;
  authorColor: string;
  authorName: string;
}

export interface OperationAck {
  operationId: string;
  revision: number;
  clientSequence: number;
}

export type SyncType = 'DELTA' | 'SNAPSHOT';

export interface EditorSyncRequest {
  roomId: string;
  lastKnownRevision: number;
}

export interface EditorSyncPayload {
  type: SyncType;
  currentRevision: number;
  operations?: BroadcastEditOperation[];
  snapshotContent?: string;
}
