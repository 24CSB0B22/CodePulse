import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LandingView } from '../components/room/LandingView';
import { RoomHeader } from '../components/room/RoomHeader';
import { ParticipantList } from '../components/room/ParticipantList';
import { ActivityNotifications } from '../components/room/ActivityNotifications';
import { Participant, PARTICIPANT_PALETTE } from '@synccode/shared';

describe('Client UI Component Rendering Tests', () => {
  it('renders LandingView with Create Room and Join Room forms', () => {
    const handleCreate = vi.fn();
    const handleJoin = vi.fn();

    render(
      <LandingView
        onCreateRoom={handleCreate}
        onJoinRoom={handleJoin}
        isLoading={false}
        error={null}
        onClearError={vi.fn()}
      />
    );

    expect(screen.getByText(/Code Together, In Real Time/i)).toBeInTheDocument();
    expect(screen.getByText('Create Workspace')).toBeInTheDocument();

    // Switch to Join Room tab
    const joinTab = screen.getByRole('button', { name: /Join Room/i });
    fireEvent.click(joinTab);

    expect(screen.getByText('Join Workspace')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/sync-7f2a-b9c1/i)).toBeInTheDocument();
  });

  it('renders RoomHeader with room information and controls', () => {
    const handleLeave = vi.fn();
    const handleToggleLock = vi.fn();
    const handleClose = vi.fn();

    render(
      <RoomHeader
        roomId="sync-1234-5678"
        language="javascript"
        participantCount={2}
        maxParticipants={5}
        isLocked={false}
        isHost={true}
        onLeaveRoom={handleLeave}
        onToggleLock={handleToggleLock}
        onCloseRoom={handleClose}
      />
    );

    expect(screen.getByText('sync-1234-5678')).toBeInTheDocument();
    expect(screen.getByText('javascript')).toBeInTheDocument();
    expect(screen.getByText('2 / 5 Users')).toBeInTheDocument();
    expect(screen.getByText('Lock')).toBeInTheDocument();
    expect(screen.getByText('Close')).toBeInTheDocument();
    expect(screen.getByText('Leave Room')).toBeInTheDocument();

    // Click Leave Room
    fireEvent.click(screen.getByText('Leave Room'));
    expect(handleLeave).toHaveBeenCalledTimes(1);

    // Click Lock
    fireEvent.click(screen.getByText('Lock'));
    expect(handleToggleLock).toHaveBeenCalledTimes(1);
  });

  it('renders ParticipantList with host, member badges and eject action', () => {
    const mockParticipants: Participant[] = [
      {
        userId: 'user-alice',
        displayName: 'Alice',
        role: 'HOST',
        color: PARTICIPANT_PALETTE[0],
        connectionState: 'CONNECTED',
        isMuted: false,
        isSpeaking: false,
      },
      {
        userId: 'user-bob',
        displayName: 'Bob',
        role: 'MEMBER',
        color: PARTICIPANT_PALETTE[1],
        connectionState: 'CONNECTED',
        isMuted: false,
        isSpeaking: false,
      },
    ];

    const handleRemove = vi.fn();

    render(
      <ParticipantList
        participants={mockParticipants}
        currentUserId="user-alice"
        maxParticipants={5}
        isHost={true}
        onRemoveParticipant={handleRemove}
      />
    );

    expect(screen.getByText('Collaborators (2/5)')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();

    // Host should see eject button for Bob
    const ejectButton = screen.getByTitle('Remove Bob from room');
    expect(ejectButton).toBeInTheDocument();
    fireEvent.click(ejectButton);
    expect(handleRemove).toHaveBeenCalledWith('user-bob');
  });

  it('renders ActivityNotifications correctly', () => {
    const notifications = [
      { id: '1', type: 'join' as const, message: 'Bob joined the room', timestamp: Date.now() },
      { id: '2', type: 'info' as const, message: 'Workspace locked by host', timestamp: Date.now() },
    ];

    render(<ActivityNotifications notifications={notifications} />);

    expect(screen.getByText('Bob joined the room')).toBeInTheDocument();
    expect(screen.getByText('Workspace locked by host')).toBeInTheDocument();
  });

  it('renders online/reconnecting/offline states, typing status, and microphone controls in ParticipantList', () => {
    const handleToggleMic = vi.fn();
    const mockParticipants: Participant[] = [
      {
        userId: 'user-alice',
        displayName: 'Alice',
        role: 'HOST',
        color: PARTICIPANT_PALETTE[0],
        connectionState: 'CONNECTED',
        isMuted: false,
        isSpeaking: false,
        cursor: { lineNumber: 2, column: 8 },
      },
      {
        userId: 'user-bob',
        displayName: 'Bob',
        role: 'MEMBER',
        color: PARTICIPANT_PALETTE[1],
        connectionState: 'CONNECTED',
        isMuted: true,
        isSpeaking: false,
        isTyping: true,
      },
      {
        userId: 'user-charlie',
        displayName: 'Charlie',
        role: 'MEMBER',
        color: PARTICIPANT_PALETTE[2],
        connectionState: 'DISCONNECTED',
        isMuted: true,
        isSpeaking: false,
      },
    ];

    render(
      <ParticipantList
        participants={mockParticipants}
        currentUserId="user-alice"
        maxParticipants={5}
        isHost={true}
        onToggleMic={handleToggleMic}
      />
    );

    // Verify Bob is typing
    expect(screen.getByText('Typing...')).toBeInTheDocument();

    // Verify Alice's cursor position is displayed
    expect(screen.getByText('Ln 2, Col 8')).toBeInTheDocument();

    // Verify Charlie is offline
    expect(screen.getByText('Offline')).toBeInTheDocument();

    // Verify Alice can toggle mic
    const micButton = screen.getByTitle('Click to Mute Microphone');
    expect(micButton).toBeInTheDocument();
    fireEvent.click(micButton);
    expect(handleToggleMic).toHaveBeenCalledTimes(1);
  });
});
