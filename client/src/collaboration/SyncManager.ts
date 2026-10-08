import { Socket } from 'socket.io-client';
import * as monaco from 'monaco-editor';
import {
  SOCKET_EVENTS,
  EditOperation,
  BroadcastEditOperation,
  OperationAck,
  EditorSyncPayload,
  MonacoRange,
  CursorPosition,
  RemoteCursorBroadcast,
  CursorUpdatePayload,
  PresenceUpdatePayload,
  ParticipantLeftPayload,
  createEditOperation,
} from '@synccode/shared';

export interface SyncStatus {
  revision: number;
  pendingCount: number;
  isSynced: boolean;
}

interface RemoteCursorRecord {
  userId: string;
  displayName: string;
  colorHex: string;
  decorationIds: string[];
  position: CursorPosition;
  selection?: MonacoRange;
}

/**
 * Safely sanitizes a display name for inclusion inside CSS content: "..."
 * Strictly escapes backslashes and double quotes, normalizes newlines/carriage returns
 * to spaces, removes control characters, and limits string length.
 * Guarantees that the value can never escape the CSS string literal.
 */
export function escapeCssString(str: string): string {
  if (typeof str !== 'string') return '';
  const clamped = str.slice(0, 32);
  let escaped = '';
  for (let i = 0; i < clamped.length; i++) {
    const ch = clamped[i];
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') {
      escaped += ' ';
    } else if (code < 32 || code === 127) {
      // Strip ASCII control characters
      continue;
    } else if (ch === '\\') {
      escaped += '\\\\';
    } else if (ch === '"') {
      escaped += '\\"';
    } else {
      escaped += ch;
    }
  }
  return escaped;
}

/**
 * Validates and sanitizes a CSS color string to guarantee safe CSS emission.
 * Accepts only standard hex color formats (#RGB, #RGBA, #RRGGBB, #RRGGBBAA).
 */
export function sanitizeCssColor(color: string, fallback = '#3b82f6'): string {
  if (typeof color === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
    return color;
  }
  return fallback;
}

export class SyncManager {
  private editor: monaco.editor.IStandaloneCodeEditor;
  public readonly socket: Socket;
  private roomId: string;
  private userId: string;

  private currentRevision: number;
  private clientSequence: number = 0;
  private lastKnownContent: string;
  private pendingOperations: Map<string, EditOperation> = new Map();

  // Monaco subscriptions
  private editorContentSubscription: { dispose: () => void } | null = null;
  private cursorPositionSubscription: { dispose: () => void } | null = null;
  private cursorSelectionSubscription: { dispose: () => void } | null = null;

  // Socket event handler references
  private readonly onServerAck = (ack: OperationAck) => this.handleServerAck(ack);
  private readonly onRemoteOperation = (operation: BroadcastEditOperation) =>
    this.handleRemoteOperation(operation);
  private readonly onEditorSync = (payload: EditorSyncPayload) => this.handleEditorSync(payload);
  private readonly onRemoteCursor = (payload: RemoteCursorBroadcast) => this.handleRemoteCursor(payload);
  private readonly onParticipantLeft = (payload: ParticipantLeftPayload) =>
    this.removeRemoteCursor(payload.userId);
  private readonly onPresenceUpdate = (payload: PresenceUpdatePayload) => {
    if (payload.connectionState === 'DISCONNECTED') {
      this.removeRemoteCursor(payload.userId);
    }
  };

  // Flag to suppress echo loop when applying remote edits to Monaco
  private isApplyingRemoteEdit: boolean = false;

  // Track Monaco decorations for remote cursors and selections
  private remoteCursors: Map<string, RemoteCursorRecord> = new Map();

  // Track Monaco decorations and active timers for fading recent edit highlights
  private activeEditDecorations: Map<string, ReturnType<typeof setTimeout>> = new Map();

  // Throttling for cursor emission
  private cursorThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursorUpdate: CursorUpdatePayload | null = null;

  // Debounce for typing status
  private typingTimeout: ReturnType<typeof setTimeout> | null = null;
  private isTypingActive: boolean = false;

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
    this.lastKnownContent = editor.getModel()?.getValue() ?? '';
    this.onStatusChange = onStatusChange;

    this.setupListeners();
    this.emitStatus();
  }

  private setupListeners(): void {
    // 1. Monaco Editor Content Changes (Local Edits)
    this.editorContentSubscription = this.editor.onDidChangeModelContent((event) => {
      const baseContent = this.lastKnownContent;
      if (!this.isApplyingRemoteEdit) {
        for (const change of event.changes) {
          this.handleLocalChange(change, baseContent);
        }
      }
      this.lastKnownContent = this.editor.getModel()?.getValue() ?? baseContent;
    });

    // 2. Monaco Cursor Position & Selection Changes (Local Cursor tracking)
    if (typeof this.editor.onDidChangeCursorPosition === 'function') {
      this.cursorPositionSubscription = this.editor.onDidChangeCursorPosition(() => {
        this.handleLocalCursorChange();
      });
    }

    if (typeof this.editor.onDidChangeCursorSelection === 'function') {
      this.cursorSelectionSubscription = this.editor.onDidChangeCursorSelection(() => {
        this.handleLocalCursorChange();
      });
    }

    // 3. Server Acknowledgement (editor:ack)
    this.socket.on(SOCKET_EVENTS.EDITOR_ACK, this.onServerAck);

    // 4. Remote Operation Broadcast (editor:operation)
    this.socket.on(SOCKET_EVENTS.EDITOR_OPERATION, this.onRemoteOperation);

    // 5. Server Sync / Catch-up (editor:sync)
    this.socket.on(SOCKET_EVENTS.EDITOR_SYNC, this.onEditorSync);

    // 6. Remote Cursors (cursor:update / cursor:broadcast)
    this.socket.on(SOCKET_EVENTS.CURSOR_UPDATE, this.onRemoteCursor);
    this.socket.on(SOCKET_EVENTS.CURSOR_BROADCAST, this.onRemoteCursor);

    // 7. Presence / Disconnect cleanup
    this.socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, this.onParticipantLeft);
    this.socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, this.onPresenceUpdate);
  }

  /**
   * Handles user typing in Monaco editor.
   * Generates delta operation, records as pending, notifies typing presence, and emits to server.
   */
  private handleLocalChange(change: monaco.editor.IModelContentChange, baseContent: string): void {
    const range: MonacoRange = {
      startLineNumber: change.range.startLineNumber,
      startColumn: change.range.startColumn,
      endLineNumber: change.range.endLineNumber,
      endColumn: change.range.endColumn,
    };

    const operationId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.clientSequence++;

    const operation: EditOperation = createEditOperation({
      operationId,
      userId: this.userId,
      roomId: this.roomId,
      baseRevision: this.currentRevision,
      range,
      rangeOffset: change.rangeOffset,
      rangeLength: change.rangeLength,
      insertedText: change.text,
      baseContent,
      timestamp: Date.now(),
      clientSequence: this.clientSequence,
    });

    // Store in pending queue
    this.pendingOperations.set(operationId, operation);
    this.emitStatus();

    // Notify typing status
    this.notifyTyping();

    // Transmit delta operation over Socket.IO (No full document dump)
    this.socket.emit(SOCKET_EVENTS.EDITOR_OPERATION, operation);
  }

  /**
   * Emits presence typing status: sets isTyping true, debounces to false after 1500ms inactivity.
   */
  private notifyTyping(): void {
    if (!this.isTypingActive) {
      this.isTypingActive = true;
      this.socket.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
        roomId: this.roomId,
        isTyping: true,
      });
    }

    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
    }

    this.typingTimeout = setTimeout(() => {
      this.isTypingActive = false;
      this.socket.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
        roomId: this.roomId,
        isTyping: false,
      });
      this.typingTimeout = null;
    }, 1500);
  }

  /**
   * Tracks local cursor position and selection, throttled to 40ms to avoid network flooding.
   */
  private handleLocalCursorChange(): void {
    const position = this.editor.getPosition();
    if (!position) return;

    const selection = this.editor.getSelection();
    const selectionRange: MonacoRange | undefined =
      selection && !selection.isEmpty()
        ? {
            startLineNumber: selection.startLineNumber,
            startColumn: selection.startColumn,
            endLineNumber: selection.endLineNumber,
            endColumn: selection.endColumn,
          }
        : undefined;

    const updatePayload: CursorUpdatePayload = {
      roomId: this.roomId,
      position: { lineNumber: position.lineNumber, column: position.column },
      selection: selectionRange,
    };

    if (!this.cursorThrottleTimer) {
      // Send immediately on first motion
      this.socket.emit(SOCKET_EVENTS.CURSOR_UPDATE, updatePayload);
      this.cursorThrottleTimer = setTimeout(() => {
        this.cursorThrottleTimer = null;
        if (this.pendingCursorUpdate) {
          this.socket.emit(SOCKET_EVENTS.CURSOR_UPDATE, this.pendingCursorUpdate);
          this.pendingCursorUpdate = null;
        }
      }, 40);
    } else {
      // Queue update for throttle window flush
      this.pendingCursorUpdate = updatePayload;
    }
  }

  /**
   * Handles incoming remote cursor broadcasts.
   * Renders participant's colored cursor line, floating name tag, and selection range.
   */
  private handleRemoteCursor(payload: RemoteCursorBroadcast): void {
    if (!payload || payload.userId === this.userId || !payload.position) {
      return;
    }

    const safeId = payload.userId.replace(/[^a-zA-Z0-9]/g, '');
    this.ensureCursorStyles(safeId, payload.colorHex, payload.displayName);

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    // 1. Remote selection range decoration (if non-empty selection exists)
    if (
      payload.selection &&
      (payload.selection.startLineNumber !== payload.selection.endLineNumber ||
        payload.selection.startColumn !== payload.selection.endColumn)
    ) {
      decorations.push({
        range: new monaco.Range(
          payload.selection.startLineNumber,
          payload.selection.startColumn,
          payload.selection.endLineNumber,
          payload.selection.endColumn
        ),
        options: {
          className: `remote-selection-${safeId}`,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }

    // 2. Remote cursor line decoration with name tag
    decorations.push({
      range: new monaco.Range(
        payload.position.lineNumber,
        payload.position.column,
        payload.position.lineNumber,
        payload.position.column
      ),
      options: {
        className: `remote-cursor-${safeId}`,
        showIfCollapsed: true,
        hoverMessage: { value: `**${payload.displayName}** is editing here` },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });

    const existing = this.remoteCursors.get(payload.userId);
    const oldDecorationIds = existing ? existing.decorationIds : [];
    const newDecorationIds = this.editor.deltaDecorations(oldDecorationIds, decorations);

    this.remoteCursors.set(payload.userId, {
      userId: payload.userId,
      displayName: payload.displayName,
      colorHex: payload.colorHex,
      decorationIds: newDecorationIds,
      position: payload.position,
      selection: payload.selection,
    });
  }

  /**
   * Injects or updates dynamic CSS for remote cursor and selection.
   */
  private ensureCursorStyles(safeId: string, colorHex: string, displayName: string): void {
    const styleId = `style-cursor-${safeId}`;
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }

    const safeName = escapeCssString(displayName);
    const safeColor = sanitizeCssColor(colorHex);
    styleEl.textContent = `
      .remote-cursor-${safeId} {
        border-left: 2px solid ${safeColor} !important;
        box-sizing: border-box !important;
        pointer-events: none !important;
        z-index: 50 !important;
        position: relative !important;
      }
      .remote-cursor-${safeId}::after {
        content: "${safeName}";
        position: absolute;
        top: -16px;
        left: -2px;
        background-color: ${safeColor};
        color: #ffffff;
        font-size: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-weight: 600;
        line-height: 14px;
        padding: 0 4px;
        border-radius: 2px 2px 2px 0;
        white-space: nowrap;
        pointer-events: none;
        z-index: 100;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
      }
      .remote-selection-${safeId} {
        background-color: ${safeColor}33 !important; /* ~20% opacity */
        pointer-events: none !important;
      }
    `;
  }

  /**
   * Removes remote cursor decorations and dynamic styles for a given user.
   */
  public removeRemoteCursor(userId: string): void {
    const existing = this.remoteCursors.get(userId);
    if (existing) {
      this.editor.deltaDecorations(existing.decorationIds, []);
      this.remoteCursors.delete(userId);
      const safeId = userId.replace(/[^a-zA-Z0-9]/g, '');
      const styleEl = document.getElementById(`style-cursor-${safeId}`);
      if (styleEl) styleEl.remove();
    }
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
      this.lastKnownContent = model.getValue();

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
   * Uses participant's unique color (~18% opacity) preserving Monaco syntax tokens.
   * Automatically clears after 3000ms. Does NOT permanently color source code.
   */
  private applyFadingAttribution(op: BroadcastEditOperation): void {
    let highlightRange: monaco.Range;

    if (op.insertedText && op.insertedText.length > 0) {
      const lines = op.insertedText.split('\n');
      const endLine = op.range.startLineNumber + lines.length - 1;
      const endCol =
        lines.length === 1
          ? op.range.startColumn + lines[0].length
          : lines[lines.length - 1].length + 1;

      highlightRange = new monaco.Range(
        op.range.startLineNumber,
        op.range.startColumn,
        endLine,
        endCol
      );
    } else {
      // Deletion: highlight the insertion/deletion point briefly
      highlightRange = new monaco.Range(
        op.range.startLineNumber,
        Math.max(1, op.range.startColumn - 1),
        op.range.startLineNumber,
        op.range.startColumn + 1
      );
    }

    const safeId = op.userId.replace(/[^a-zA-Z0-9]/g, '');
    const className = `edit-highlight-${safeId}`;
    const styleId = `style-highlight-${safeId}`;

    const safeColor = sanitizeCssColor(op.authorColor);

    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .${className} {
          background-color: ${safeColor}2e !important; /* ~18% opacity */
          transition: background-color 1.5s ease-out;
        }
      `;
      document.head.appendChild(style);
    }

    const newDecorations = this.editor.deltaDecorations([], [
      {
        range: highlightRange,
        options: {
          isWholeLine: false,
          className,
          overviewRuler: {
            color: op.authorColor,
            position: monaco.editor.OverviewRulerLane.Left,
          },
          hoverMessage: { value: `Recent edit by **${op.authorName}**` },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      },
    ]);

    if (newDecorations.length > 0) {
      const decId = newDecorations[0];
      const timer = setTimeout(() => {
        this.editor.deltaDecorations([decId], []);
        this.activeEditDecorations.delete(decId);
      }, 3000);
      this.activeEditDecorations.set(decId, timer);
    }
  }

  /**
   * Handles server sync payload when re-synchronizing after disconnect or stale edit.
   */
  private handleEditorSync(payload: EditorSyncPayload): void {
    const model = this.editor.getModel();
    if (!model) return;
    if (this.currentRevision >= payload.currentRevision) return;

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
        this.lastKnownContent = model.getValue();
      } else if (payload.type === 'DELTA' && payload.operations) {
        for (const op of payload.operations) {
          // If this is our own operation replayed from server history, acknowledge and clear pending
          if (op.userId === this.userId) {
            this.pendingOperations.delete(op.operationId);
            this.currentRevision = Math.max(this.currentRevision, op.revision);
            continue;
          }

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
          this.currentRevision = Math.max(this.currentRevision, op.revision);
        }
        this.currentRevision = Math.max(this.currentRevision, payload.currentRevision);
        this.lastKnownContent = model.getValue();
      }
    } finally {
      this.isApplyingRemoteEdit = false;
      this.emitStatus();
    }
  }

  /**
   * Returns the current authoritative revision tracked by the client.
   */
  public getLatestKnownRevision(): number {
    return this.currentRevision;
  }

  /**
   * Flushes any unacknowledged pending operations to the server (e.g., after reconnect).
   */
  public flushPendingOperations(): void {
    if (!this.socket.connected) return;
    for (const op of this.pendingOperations.values()) {
      this.socket.emit(SOCKET_EVENTS.EDITOR_OPERATION, op);
    }
  }

  /**
   * Applies an EditorSyncPayload directly (delta operations or snapshot).
   */
  public applySyncPayload(payload: EditorSyncPayload): void {
    this.handleEditorSync(payload);
  }

  /**
   * Resynchronizes local Monaco buffer to authoritative document state (e.g. upon reconnect).
   */
  public syncToDocument(content: string, revision: number): void {
    const model = this.editor.getModel();
    if (!model) return;
    if (this.currentRevision >= revision && model.getValue() === content) return;

    this.isApplyingRemoteEdit = true;
    try {
      const fullRange = model.getFullModelRange();
      this.editor.executeEdits('reconnect-sync', [
        {
          range: fullRange,
          text: content,
          forceMoveMarkers: true,
        },
      ]);
      this.currentRevision = Math.max(this.currentRevision, revision);
      this.pendingOperations.clear();
      this.lastKnownContent = model.getValue();
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
    this.editorContentSubscription?.dispose();
    this.editorContentSubscription = null;

    this.cursorPositionSubscription?.dispose();
    this.cursorPositionSubscription = null;

    this.cursorSelectionSubscription?.dispose();
    this.cursorSelectionSubscription = null;

    if (this.cursorThrottleTimer) {
      clearTimeout(this.cursorThrottleTimer);
      this.cursorThrottleTimer = null;
    }

    if (this.typingTimeout) {
      clearTimeout(this.typingTimeout);
      this.typingTimeout = null;
    }

    // Clean up all remote cursor decorations and styles
    for (const [userId, cursor] of this.remoteCursors.entries()) {
      this.editor.deltaDecorations(cursor.decorationIds, []);
      const safeId = userId.replace(/[^a-zA-Z0-9]/g, '');
      const styleEl = document.getElementById(`style-cursor-${safeId}`);
      if (styleEl) styleEl.remove();
    }
    this.remoteCursors.clear();

    // Clean up all active edit decorations and timers
    for (const [decId, timer] of this.activeEditDecorations.entries()) {
      clearTimeout(timer);
      this.editor.deltaDecorations([decId], []);
    }
    this.activeEditDecorations.clear();

    // Remove socket listeners
    this.socket.off(SOCKET_EVENTS.EDITOR_ACK, this.onServerAck);
    this.socket.off(SOCKET_EVENTS.EDITOR_OPERATION, this.onRemoteOperation);
    this.socket.off(SOCKET_EVENTS.EDITOR_SYNC, this.onEditorSync);
    this.socket.off(SOCKET_EVENTS.CURSOR_UPDATE, this.onRemoteCursor);
    this.socket.off(SOCKET_EVENTS.CURSOR_BROADCAST, this.onRemoteCursor);
    this.socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, this.onParticipantLeft);
    this.socket.off(SOCKET_EVENTS.PRESENCE_UPDATE, this.onPresenceUpdate);
  }
}
