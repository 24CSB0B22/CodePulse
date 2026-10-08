import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkspaceView } from '../components/room/WorkspaceView';
import { SyncManager } from '../collaboration/SyncManager';
import { RoomState, Participant, EditorSyncPayload, PARTICIPANT_PALETTE } from '@synccode/shared';

describe('Client Reconnection & Resilience Tests', () => {
  const dummyParticipant: Participant = {
    userId: 'user-1',
    displayName: 'Alice',
    role: 'HOST',
    color: PARTICIPANT_PALETTE[0],
    connectionState: 'CONNECTED',
    isMuted: false,
    isSpeaking: false,
  };

  const dummyRoomState: RoomState = {
    roomId: 'sync-test-room',
    hostId: 'user-1',
    isLocked: false,
    maxParticipants: 5,
    participants: [dummyParticipant],
    document: {
      filename: 'main.js',
      language: 'javascript',
      content: '// Test content\n',
      currentRevision: 10,
    },
  };

  it('renders "Reconnecting..." banner when isReconnecting is true while preserving workspace view', () => {
    render(
      <WorkspaceView
        roomState={dummyRoomState}
        currentParticipant={dummyParticipant}
        chatMessages={[]}
        isReconnecting={true}
        onSendMessage={vi.fn()}
        onLeaveRoom={vi.fn()}
      />
    );

    expect(screen.getByText(/Reconnecting\.\.\. Local state preserved\./i)).toBeInTheDocument();
    expect(screen.getByText('sync-test-room')).toBeInTheDocument();
    expect(screen.getByText('main.js')).toBeInTheDocument();
  });

  it('does not render "Reconnecting..." banner when connected normally', () => {
    render(
      <WorkspaceView
        roomState={dummyRoomState}
        currentParticipant={dummyParticipant}
        chatMessages={[]}
        isReconnecting={false}
        onSendMessage={vi.fn()}
        onLeaveRoom={vi.fn()}
      />
    );

    expect(screen.queryByText(/Reconnecting\.\.\. Local state preserved\./i)).not.toBeInTheDocument();
  });

  it('SyncManager maintains latest known revision and applies missing deltas correctly', () => {
    const mockModel = {
      getValue: vi.fn().mockReturnValue('Initial code'),
      getFullModelRange: vi.fn(),
    };

    const mockEditor: any = {
      getModel: vi.fn().mockReturnValue(mockModel),
      executeEdits: vi.fn(),
      onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidChangeCursorPosition: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      deltaDecorations: vi.fn().mockReturnValue([]),
    };

    const mockSocket: any = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      connected: true,
    };

    const syncManager = new SyncManager(
      mockEditor,
      mockSocket,
      'room-1',
      'user-1',
      5
    );

    // Initial revision is maintained
    expect(syncManager.getLatestKnownRevision()).toBe(5);

    // Receive delta payload with 2 missing operations from peer (rev 6 and rev 7)
    const deltaPayload: EditorSyncPayload = {
      type: 'DELTA',
      currentRevision: 7,
      operations: [
        {
          operationId: 'op-6',
          roomId: 'room-1',
          userId: 'user-2',
          baseRevision: 5,
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          insertedText: '// Added line\n',
          deletedText: '',
          timestamp: Date.now(),
          clientSequence: 1,
          revision: 6,
          authorColor: '#10B981',
          authorName: 'Bob',
        },
        {
          operationId: 'op-7',
          roomId: 'room-1',
          userId: 'user-2',
          baseRevision: 6,
          range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 },
          insertedText: '// Second line\n',
          deletedText: '',
          timestamp: Date.now(),
          clientSequence: 2,
          revision: 7,
          authorColor: '#10B981',
          authorName: 'Bob',
        },
      ],
    };

    syncManager.applySyncPayload(deltaPayload);

    // Revision advances to 7
    expect(syncManager.getLatestKnownRevision()).toBe(7);
    expect(mockEditor.executeEdits).toHaveBeenCalledTimes(2);

    syncManager.destroy();
  });

  it('SyncManager resets buffer and revision cleanly on SNAPSHOT sync payload', () => {
    const mockModel = {
      getValue: vi.fn().mockReturnValue('Initial'),
      getFullModelRange: vi.fn().mockReturnValue({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 8,
      }),
    };

    const mockEditor: any = {
      getModel: vi.fn().mockReturnValue(mockModel),
      executeEdits: vi.fn(),
      onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidChangeCursorPosition: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      deltaDecorations: vi.fn().mockReturnValue([]),
    };

    const mockSocket: any = {
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      connected: true,
    };

    const syncManager = new SyncManager(
      mockEditor,
      mockSocket,
      'room-1',
      'user-1',
      2
    );

    const snapshotPayload: EditorSyncPayload = {
      type: 'SNAPSHOT',
      currentRevision: 42,
      snapshotContent: 'Brand new snapshot content',
    };

    syncManager.applySyncPayload(snapshotPayload);

    expect(syncManager.getLatestKnownRevision()).toBe(42);
    expect(mockEditor.executeEdits).toHaveBeenCalledWith(
      'sync-snapshot',
      expect.arrayContaining([
        expect.objectContaining({
          text: 'Brand new snapshot content',
        }),
      ])
    );

    syncManager.destroy();
  });
});
