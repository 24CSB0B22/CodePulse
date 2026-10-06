import { Socket } from 'socket.io-client';
import * as monaco from 'monaco-editor';
import {
  SOCKET_EVENTS,
  EditOperation,
  BroadcastEditOperation,
  OperationAck,
  EditorSyncPayload,
  MonacoRange,
} from '@synccode/shared';

export interface SyncStatus {
  revision: number;
  pendingCount: number;
  isSynced: boolean;
}

export class SyncManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private socket: Socket;
  private roomId: string;
  private userId: string;

  private currentRevision: number;
  private clientSequence: number = 0;
  private pendingOperations: Map<string, EditOperation> = new Map();

  // Flag to suppress echo loop when applying remote edits to Monaco
  private isApplyingRemoteEdit: boolean = false;

  // Track Monaco decorations for fading recent edit highlights
  private editDecorations: string[] = [];

  // Callback for UI status bar updates
  private onStatusChange?: (status: SyncStatus) => void;

  constructor(
    editor: monaco.editor.IStandaloneCodeEditor,
    socket: Socket,
    roomId: string,
    userId: string,
    initialRevision: number,
    onStatusChange?: (status: SyncStatus) => void
  ) {
    this.editor = editor;
    this.socket = socket;
    this.roomId = roomId;
    this.userId = userId;
    this.currentRevision = initialRevision;
    this.onStatusChange = onStatusChange;

    this.setupListeners();
    this.emitStatus();
  }

  private setupListeners(): void {
    // 1. Monaco Editor Content Changes (Local Edits)
    this.editor.onDidChangeModelContent((event) => {
      if (this.isApplyingRemoteEdit) {
        return; // Suppress echo loop
      }

      for (const change of event.changes) {
        this.handleLocalChange(change);
      }
    });

    // 2. Server Acknowledgement (editor:ack)
    this.socket.on(SOCKET_EVENTS.EDITOR_ACK, (ack: OperationAck) => {
      this.handleServerAck(ack);
    });

    // 3. Remote Operation Broadcast (editor:operation)
    this.socket.on(SOCKET_EVENTS.EDITOR_OPERATION, (remoteOp: BroadcastEditOperation) => {
      this.handleRemoteOperation(remoteOp);
    });

    // 4. Server Sync / Catch-up (editor:sync)
    this.socket.on(SOCKET_EVENTS.EDITOR_SYNC, (payload: EditorSyncPayload) => {
      this.handleEditorSync(payload);
    });
  }

  /**
   * Handles user typing in Monaco editor.
   * Generates delta operation, records as pending, and emits to server.
   */
  private handleLocalChange(change: monaco.editor.IModelContentChange): void {
    const range: MonacoRange = {
      startLineNumber: change.range.startLineNumber,
      startColumn: change.range.startColumn,
      endLineNumber: change.range.endLineNumber,
      endColumn: change.range.endColumn,
    };

    const operationId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.clientSequence++;

    const operation: EditOperation = {
      operationId,
      userId: this.userId,
      roomId: this.roomId,
      baseRevision: this.currentRevision,
      range,
      insertedText: change.text,
      deletedText: '', // Range defines deleted text
      deleteCount: change.rangeLength,
      timestamp: Date.now(),
      clientSequence: this.clientSequence,
    };

    // Store in pending queue
    this.pendingOperations.set(operationId, operation);
    this.emitStatus();

    // Transmit delta operation over Socket.IO (No full document dump)
    this.socket.emit(SOCKET_EVENTS.EDITOR_OPERATION, operation);
  }

  /**
   * Handles server acknowledgement of an accepted operation.
   */
  private handleServerAck(ack: OperationAck): void {
    if (this.pendingOperations.has(ack.operationId)) {
      this.pendingOperations.delete(ack.operationId);
      this.currentRevision = Math.max(this.currentRevision, ack.revision);
      this.emitStatus();
    }
  }

  /**
   * Handles incoming remote operation delta from a peer collaborator.
   */
  private handleRemoteOperation(remoteOp: BroadcastEditOperation): void {
    // If this is our own operation echoed back, ignore (handled via ack)
    if (remoteOp.userId === this.userId) {
      return;
    }

    const model = this.editor.getModel();
    if (!model) return;

    this.isApplyingRemoteEdit = true;
    try {
      const monacoRange = new monaco.Range(
        remoteOp.range.startLineNumber,
        remoteOp.range.startColumn,
        remoteOp.range.endLineNumber,
        remoteOp.range.endColumn
      );

      // Apply the delta edit non-destructively to the Monaco model
      this.editor.executeEdits('remote-collaboration', [
        {
          range: monacoRange,
          text: remoteOp.insertedText,
          forceMoveMarkers: true,
        },
      ]);

      // Update authoritative revision
      this.currentRevision = Math.max(this.currentRevision, remoteOp.revision);

      // Apply temporary fading colored attribution decoration
      this.applyFadingAttribution(remoteOp);
    } finally {
      this.isApplyingRemoteEdit = false;
      this.emitStatus();
    }
  }

  /**
   * Applies temporary, semi-transparent colored decoration to the recently modified range.
   * Automatically fades out after 3000ms without modifying syntax tokens.
   */
  private applyFadingAttribution(op: BroadcastEditOperation): void {
    const linesInserted = op.insertedText.split('\n').length - 1;
    const endLine = op.range.startLineNumber + linesInserted;

    const highlightRange = new monaco.Range(
      op.range.startLineNumber,
      1,
      endLine,
      1
    );

    // Create dynamic inline CSS class for participant's color
    const className = `edit-highlight-${op.userId.replace(/[^a-zA-Z0-9]/g, '')}`;
    if (!document.getElementById(className)) {
      const style = document.createElement('style');
      style.id = className;
      style.innerHTML = `
        .${className} {
          background-color: ${op.authorColor}26 !important; /* ~15% opacity */
          transition: background-color 1s ease-out;
        }
      `;
      document.head.appendChild(style);
    }

    const newDecorations = this.editor.deltaDecorations(this.editDecorations, [
      {
        range: highlightRange,
        options: {
          isWholeLine: true,
          className,
          overviewRuler: {
            color: op.authorColor,
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      },
    ]);

    this.editDecorations = newDecorations;

    // Fade out and clear after 3000ms
    setTimeout(() => {
      this.editDecorations = this.editor.deltaDecorations(this.editDecorations, []);
    }, 3000);
  }

  /**
   * Handles server sync payload when re-synchronizing after disconnect or stale edit.
   */
  private handleEditorSync(payload: EditorSyncPayload): void {
    const model = this.editor.getModel();
    if (!model) return;

    this.isApplyingRemoteEdit = true;
    try {
      if (payload.type === 'SNAPSHOT' && typeof payload.snapshotContent === 'string') {
        const fullRange = model.getFullModelRange();
        this.editor.executeEdits('sync-snapshot', [
          {
            range: fullRange,
            text: payload.snapshotContent,
            forceMoveMarkers: true,
          },
        ]);
        this.currentRevision = payload.currentRevision;
        this.pendingOperations.clear();
      } else if (payload.type === 'DELTA' && payload.operations) {
        for (const op of payload.operations) {
          const monacoRange = new monaco.Range(
            op.range.startLineNumber,
            op.range.startColumn,
            op.range.endLineNumber,
            op.range.endColumn
          );
          this.editor.executeEdits('sync-delta', [
            {
              range: monacoRange,
              text: op.insertedText,
              forceMoveMarkers: true,
            },
          ]);
        }
        this.currentRevision = payload.currentRevision;
      }
    } finally {
      this.isApplyingRemoteEdit = false;
      this.emitStatus();
    }
  }

  /**
   * Request synchronization from server.
   */
  public requestSync(): void {
    this.socket.emit(SOCKET_EVENTS.EDITOR_SYNC, {
      roomId: this.roomId,
      lastKnownRevision: this.currentRevision,
    });
  }

  private emitStatus(): void {
    if (this.onStatusChange) {
      this.onStatusChange({
        revision: this.currentRevision,
        pendingCount: this.pendingOperations.size,
        isSynced: this.pendingOperations.size === 0,
      });
    }
  }

  public destroy(): void {
    this.socket.off(SOCKET_EVENTS.EDITOR_ACK);
    this.socket.off(SOCKET_EVENTS.EDITOR_OPERATION);
    this.socket.off(SOCKET_EVENTS.EDITOR_SYNC);
  }
}
