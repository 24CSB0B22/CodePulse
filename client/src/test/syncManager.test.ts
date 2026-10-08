import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncManager } from '../collaboration/SyncManager';
import {
  SOCKET_EVENTS,
  EditOperation,
  BroadcastEditOperation,
  OperationAck,
  RemoteCursorBroadcast,
} from '@synccode/shared';

describe('SyncManager Unit Tests', () => {
  let mockEditor: any;
  let mockModel: any;
  let mockSocket: any;
  let modelContentChangeListeners: Array<(event: any) => void>;
  let cursorPositionListeners: Array<(event: any) => void>;
  let cursorSelectionListeners: Array<(event: any) => void>;
  let socketListeners: Map<string, Array<(payload: any) => void>>;
  let editorSubscription: { dispose: ReturnType<typeof vi.fn> };
  let cursorPositionSubscription: { dispose: ReturnType<typeof vi.fn> };
  let cursorSelectionSubscription: { dispose: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    modelContentChangeListeners = [];
    cursorPositionListeners = [];
    cursorSelectionListeners = [];
    socketListeners = new Map();
    editorSubscription = { dispose: vi.fn() };
    cursorPositionSubscription = { dispose: vi.fn() };
    cursorSelectionSubscription = { dispose: vi.fn() };

    mockModel = {
      getValue: vi.fn().mockReturnValue('hello world'),
      applyEdits: vi.fn(),
      setValue: vi.fn(),
    };

    mockEditor = {
      getModel: vi.fn().mockReturnValue(mockModel),
      onDidChangeModelContent: vi.fn().mockImplementation((listener) => {
        modelContentChangeListeners.push(listener);
        return editorSubscription;
      }),
      onDidChangeCursorPosition: vi.fn().mockImplementation((listener) => {
        cursorPositionListeners.push(listener);
        return cursorPositionSubscription;
      }),
      onDidChangeCursorSelection: vi.fn().mockImplementation((listener) => {
        cursorSelectionListeners.push(listener);
        return cursorSelectionSubscription;
      }),
      getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 5 }),
      getSelection: vi.fn().mockReturnValue({
        isEmpty: () => true,
        startLineNumber: 1,
        startColumn: 5,
        endLineNumber: 1,
        endColumn: 5,
      }),
      executeEdits: vi.fn(),
      deltaDecorations: vi.fn().mockReturnValue(['dec-1']),
    };

    mockSocket = {
      emit: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: (p: any) => void) => {
        if (!socketListeners.has(event)) {
          socketListeners.set(event, []);
        }
        socketListeners.get(event)!.push(handler);
      }),
      off: vi.fn().mockImplementation((event: string, handler: (p: any) => void) => {
        const handlers = socketListeners.get(event) || [];
        socketListeners.set(
          event,
          handlers.filter((h) => h !== handler)
        );
      }),
    };
  });

  it('should initialize with starting revision and register listeners', () => {
    const statusCallback = vi.fn();
    new SyncManager(
      mockEditor,
      mockSocket,
      'test-room',
      'user-1',
      0,
      statusCallback
    );

    expect(mockEditor.onDidChangeModelContent).toHaveBeenCalled();
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_ACK, expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_OPERATION, expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_SYNC, expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.CURSOR_UPDATE, expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_EVENTS.PRESENCE_UPDATE, expect.any(Function));

    expect(statusCallback).toHaveBeenCalledWith({
      revision: 0,
      pendingCount: 0,
      isSynced: true,
    });
  });

  it('should generate insertion operation and emit typing presence when user types in Monaco', () => {
    new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 0);

    const changeEvent = {
      changes: [
        {
          range: {
            startLineNumber: 1,
            startColumn: 12,
            endLineNumber: 1,
            endColumn: 12,
          },
          rangeOffset: 11,
          rangeLength: 0,
          text: '!',
        },
      ],
    };

    modelContentChangeListeners[0](changeEvent);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.EDITOR_OPERATION,
      expect.objectContaining({
        userId: 'user-1',
        roomId: 'test-room',
        baseRevision: 0,
        insertedText: '!',
        deletedText: '',
        deleteCount: 0,
        clientSequence: 1,
      })
    );

    // Typing presence notification emitted
    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.PRESENCE_UPDATE,
      expect.objectContaining({
        roomId: 'test-room',
        isTyping: true,
      })
    );
  });

  it('should generate deletion operation when user deletes text', () => {
    new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 5);

    const changeEvent = {
      changes: [
        {
          range: {
            startLineNumber: 1,
            startColumn: 6,
            endLineNumber: 1,
            endColumn: 12,
          },
          rangeOffset: 5,
          rangeLength: 6,
          text: '',
        },
      ],
    };

    modelContentChangeListeners[0](changeEvent);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.EDITOR_OPERATION,
      expect.objectContaining({
        userId: 'user-1',
        roomId: 'test-room',
        baseRevision: 5,
        insertedText: '',
        deletedText: ' world',
        deleteCount: 6,
      })
    );
  });

  it('should generate replacement operation when user replaces text', () => {
    new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 2);

    const changeEvent = {
      changes: [
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 6,
          },
          rangeOffset: 0,
          rangeLength: 5,
          text: 'Greetings',
        },
      ],
    };

    modelContentChangeListeners[0](changeEvent);

    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.EDITOR_OPERATION,
      expect.objectContaining({
        userId: 'user-1',
        roomId: 'test-room',
        baseRevision: 2,
        insertedText: 'Greetings',
        deletedText: 'hello',
        deleteCount: 5,
      })
    );
  });

  it('should handle editor:ack, update revision, and decrement pending count', () => {
    const statusCallback = vi.fn();
    new SyncManager(
      mockEditor,
      mockSocket,
      'test-room',
      'user-1',
      0,
      statusCallback
    );

    // Simulate typing to queue a pending operation
    modelContentChangeListeners[0]({
      changes: [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          rangeOffset: 0,
          rangeLength: 0,
          text: 'a',
        },
      ],
    });

    const emittedOp = mockSocket.emit.mock.calls.find(
      (c: any[]) => c[0] === SOCKET_EVENTS.EDITOR_OPERATION
    )[1] as EditOperation;

    expect(statusCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingCount: 1,
        isSynced: false,
      })
    );

    // Simulate server ACK
    const ackHandlers = socketListeners.get(SOCKET_EVENTS.EDITOR_ACK) || [];
    ackHandlers[0]({
      operationId: emittedOp.operationId,
      revision: 1,
      clientSequence: 1,
    } as OperationAck);

    expect(statusCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 1,
        pendingCount: 0,
        isSynced: true,
      })
    );
  });

  it('should apply remote operations to Monaco with visual edit attribution in author color', () => {
    const statusCallback = vi.fn();
    new SyncManager(
      mockEditor,
      mockSocket,
      'test-room',
      'user-1',
      0,
      statusCallback
    );

    const remoteOp: BroadcastEditOperation = {
      operationId: 'op-remote-123',
      roomId: 'test-room',
      userId: 'user-2',
      baseRevision: 0,
      revision: 1,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      insertedText: 'remote text',
      deletedText: '',
      deleteCount: 0,
      timestamp: Date.now(),
      clientSequence: 1,
      authorColor: '#F59E0B',
      authorName: 'Bob',
    };

    const remoteHandlers = socketListeners.get(SOCKET_EVENTS.EDITOR_OPERATION) || [];
    remoteHandlers[0](remoteOp);

    // Monaco executeEdits should be invoked to apply remote text
    expect(mockEditor.executeEdits).toHaveBeenCalledWith('remote-collaboration', [
      {
        range: expect.any(Object),
        text: 'remote text',
        forceMoveMarkers: true,
      },
    ]);

    // Monaco deltaDecorations should be called for fading attribution
    expect(mockEditor.deltaDecorations).toHaveBeenCalled();

    // Assert that status was updated to revision 1
    expect(statusCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        revision: 1,
        isSynced: true,
      })
    );
  });

  it('should emit cursor:update when local cursor moves in Monaco', () => {
    new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 0);

    // Trigger cursor change
    cursorPositionListeners[0]({});

    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.CURSOR_UPDATE,
      expect.objectContaining({
        roomId: 'test-room',
        position: { lineNumber: 1, column: 5 },
      })
    );
  });

  it('should render remote cursor and selection decorations when cursor:update arrives', () => {
    new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 0);

    const remoteCursorPayload: RemoteCursorBroadcast = {
      roomId: 'test-room',
      userId: 'user-2',
      displayName: 'Bob',
      colorHex: '#10B981',
      position: { lineNumber: 3, column: 8 },
      selection: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 8 },
    };

    const cursorHandlers = socketListeners.get(SOCKET_EVENTS.CURSOR_UPDATE) || [];
    cursorHandlers[0](remoteCursorPayload);

    // Should create decorations in Monaco for cursor and selection
    expect(mockEditor.deltaDecorations).toHaveBeenCalledWith(
      [],
      expect.arrayContaining([
        expect.objectContaining({
          options: expect.objectContaining({
            className: expect.stringContaining('remote-selection-user2'),
          }),
        }),
        expect.objectContaining({
          options: expect.objectContaining({
            className: expect.stringContaining('remote-cursor-user2'),
            showIfCollapsed: true,
          }),
        }),
      ])
    );
  });

  it('should dispose its Monaco and Socket.IO listeners without removing other listeners', () => {
    const manager = new SyncManager(mockEditor, mockSocket, 'test-room', 'user-1', 0);

    manager.destroy();

    expect(editorSubscription.dispose).toHaveBeenCalledOnce();
    expect(cursorPositionSubscription.dispose).toHaveBeenCalledOnce();
    expect(cursorSelectionSubscription.dispose).toHaveBeenCalledOnce();
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_ACK, expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_OPERATION, expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.EDITOR_SYNC, expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.CURSOR_UPDATE, expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith(SOCKET_EVENTS.PRESENCE_UPDATE, expect.any(Function));
  });
});
