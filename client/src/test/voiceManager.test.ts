import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoiceManager, VoiceStatus } from '../collaboration/VoiceManager';
import { SOCKET_EVENTS } from '@synccode/shared';

// Mock WebRTC and Web Audio APIs
class MockMediaStreamTrack {
  kind = 'audio';
  enabled = true;
  stop = vi.fn();
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class MockRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: any) {
    this.type = init.type;
    this.sdp = init.sdp;
  }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
  constructor(init: any) {
    this.candidate = init.candidate;
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
    this.usernameFragment = init.usernameFragment ?? null;
  }
}

class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = 'connected';
  signalingState: RTCSignalingState = 'stable';
  localDescription: any = null;
  remoteDescription: any = null;

  onicecandidate: ((ev: any) => any) | null = null;
  ontrack: ((ev: any) => any) | null = null;
  onconnectionstatechange: ((ev: any) => any) | null = null;

  addTrack = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-offer-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-answer-sdp' });
  setLocalDescription = vi.fn().mockImplementation((desc) => {
    this.localDescription = desc;
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn().mockImplementation((desc) => {
    this.remoteDescription = desc;
    return Promise.resolve();
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  restartIce = vi.fn();
  close = vi.fn();
}

class MockAnalyserNode {
  fftSize = 512;
  frequencyBinCount = 256;
  smoothingTimeConstant = 0.4;
  getByteFrequencyData = vi.fn((array: Uint8Array) => {
    array.fill(0);
  });
}

class MockAudioContext {
  state = 'running';
  createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
  });
  createAnalyser = vi.fn().mockReturnValue(new MockAnalyserNode());
  close = vi.fn().mockResolvedValue(undefined);
}

describe('VoiceManager', () => {
  let mockSocket: any;
  let socketEventHandlers: Record<string, Function>;
  let mockStream: MockMediaStream;

  beforeEach(() => {
    socketEventHandlers = {};
    mockSocket = {
      emit: vi.fn((_event: string, _payload?: any, ack?: Function) => {
        if (typeof ack === 'function') {
          ack({ success: true, peers: [] });
        }
      }),
      on: vi.fn((event: string, handler: Function) => {
        socketEventHandlers[event] = handler;
      }),
      off: vi.fn((event: string, handler: Function) => {
        if (socketEventHandlers[event] === handler) {
          delete socketEventHandlers[event];
        }
      }),
    };

    mockStream = new MockMediaStream();

    // Stub navigator.mediaDevices
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      writable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue(mockStream),
      },
    });

    // Stub global WebRTC and Audio APIs
    (globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
    (globalThis as any).RTCSessionDescription = MockRTCSessionDescription;
    (globalThis as any).RTCIceCandidate = MockRTCIceCandidate;
    (globalThis as any).AudioContext = MockAudioContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly detects WebRTC support in browser environment', () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-1');
    const status = vm.getStatus();
    expect(status.isSupported).toBe(true);
    expect(status.isJoined).toBe(false);
    expect(status.isMuted).toBe(false);
    expect(status.activePeerCount).toBe(0);
    vm.destroy();
  });

  it('initializes local audio and joins voice mesh on joinVoice()', async () => {
    const statusHistory: VoiceStatus[] = [];
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-1', {
      onStatusChange: (s) => statusHistory.push({ ...s }),
    });

    const res = await vm.joinVoice(false);
    expect(res.success).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    // Emits join event to server signaling relay
    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.VOICE_JOIN,
      { roomId: 'test-room' },
      expect.any(Function)
    );

    const status = vm.getStatus();
    expect(status.isJoined).toBe(true);
    expect(status.error).toBeNull();
    vm.destroy();
  });

  it('gracefully handles microphone permission denied', async () => {
    const permError = new Error('Permission denied');
    permError.name = 'NotAllowedError';
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(permError);

    const vm = new VoiceManager(mockSocket, 'test-room', 'user-1');
    const res = await vm.joinVoice(false);

    expect(res.success).toBe(false);
    expect(res.error).toContain('Microphone access denied');
    expect(vm.getStatus().isJoined).toBe(false);
    vm.destroy();
  });

  it('toggles microphone mute state and emits presence update', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-1');
    await vm.joinVoice(false);

    // Initial state: unmuted
    expect(vm.getStatus().isMuted).toBe(false);
    expect(mockStream.getAudioTracks()[0].enabled).toBe(true);

    // Mute
    const isMutedAfter = vm.toggleMute();
    expect(isMutedAfter).toBe(true);
    expect(vm.getStatus().isMuted).toBe(true);
    expect(mockStream.getAudioTracks()[0].enabled).toBe(false);
    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.PRESENCE_UPDATE, {
      roomId: 'test-room',
      isMuted: true,
      isSpeaking: false,
    });

    // Unmute
    const isUnmutedAfter = vm.toggleMute();
    expect(isUnmutedAfter).toBe(false);
    expect(vm.getStatus().isMuted).toBe(false);
    expect(mockStream.getAudioTracks()[0].enabled).toBe(true);
    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.PRESENCE_UPDATE, {
      roomId: 'test-room',
      isMuted: false,
      isSpeaking: false,
    });
    vm.destroy();
  });

  it('initiates WebRTC offer to new peer when peer joins the room', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-alice');
    await vm.joinVoice();

    // Trigger peer joined for 'user-bob'
    const handler = socketEventHandlers[SOCKET_EVENTS.VOICE_PEER_JOINED];
    expect(handler).toBeDefined();

    await handler({
      roomId: 'test-room',
      userId: 'user-bob',
      displayName: 'Bob',
    });

    // Check if voice:offer was emitted to user-bob
    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.VOICE_OFFER,
      expect.objectContaining({
        roomId: 'test-room',
        callerUserId: 'user-alice',
        targetUserId: 'user-bob',
        description: { type: 'offer', sdp: 'mock-offer-sdp' },
      })
    );
    vm.destroy();
  });

  it('handles received WebRTC offer, creates answer, and replies via voice:answer', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-bob');
    await vm.joinVoice();

    const offerHandler = socketEventHandlers[SOCKET_EVENTS.VOICE_OFFER];
    expect(offerHandler).toBeDefined();

    await offerHandler({
      roomId: 'test-room',
      callerUserId: 'user-alice',
      targetUserId: 'user-bob',
      description: { type: 'offer', sdp: 'remote-offer-sdp' },
    });

    // Should create answer and emit voice:answer
    expect(mockSocket.emit).toHaveBeenCalledWith(
      SOCKET_EVENTS.VOICE_ANSWER,
      expect.objectContaining({
        roomId: 'test-room',
        answererUserId: 'user-bob',
        targetUserId: 'user-alice',
        description: { type: 'answer', sdp: 'mock-answer-sdp' },
      })
    );
    vm.destroy();
  });

  it('handles incoming voice:answer and sets remote description', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-alice');
    await vm.joinVoice();

    // Alice connects to Bob
    await socketEventHandlers[SOCKET_EVENTS.VOICE_PEER_JOINED]({
      roomId: 'test-room',
      userId: 'user-bob',
      displayName: 'Bob',
    });

    // Answer received
    const answerHandler = socketEventHandlers[SOCKET_EVENTS.VOICE_ANSWER];
    await answerHandler({
      roomId: 'test-room',
      answererUserId: 'user-bob',
      targetUserId: 'user-alice',
      description: { type: 'answer', sdp: 'remote-answer-sdp' },
    });

    const activePeers = vm.getActivePeers();
    expect(activePeers).toContain('user-bob');
    vm.destroy();
  });

  it('queues and flushes ICE candidates when received before remote description', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-bob');
    await vm.joinVoice();

    // Pre-create peer record by having offer arrive
    const offerHandler = socketEventHandlers[SOCKET_EVENTS.VOICE_OFFER];
    await offerHandler({
      roomId: 'test-room',
      callerUserId: 'user-alice',
      targetUserId: 'user-bob',
      description: { type: 'offer', sdp: 'remote-offer-sdp' },
    });

    // ICE candidate received after remote description is set
    const iceHandler = socketEventHandlers[SOCKET_EVENTS.VOICE_ICE_CANDIDATE];
    await iceHandler({
      roomId: 'test-room',
      senderUserId: 'user-alice',
      targetUserId: 'user-bob',
      candidate: { candidate: 'candidate:1 1 UDP ...', sdpMid: '0', sdpMLineIndex: 0 },
    });

    expect(vm.getActivePeers()).toContain('user-alice');
    vm.destroy();
  });

  it('cleans up peer connection when voice:peer-left is received', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-alice');
    await vm.joinVoice();

    // Connect to Bob
    await socketEventHandlers[SOCKET_EVENTS.VOICE_PEER_JOINED]({
      roomId: 'test-room',
      userId: 'user-bob',
      displayName: 'Bob',
    });
    expect(vm.getActivePeers()).toContain('user-bob');

    // Bob leaves voice
    const leaveHandler = socketEventHandlers[SOCKET_EVENTS.VOICE_PEER_LEFT];
    leaveHandler({
      roomId: 'test-room',
      userId: 'user-bob',
    });

    expect(vm.getActivePeers()).not.toContain('user-bob');
    vm.destroy();
  });

  it('cleans up all resources and emits voice:leave on leaveVoice()', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-alice');
    await vm.joinVoice();

    await socketEventHandlers[SOCKET_EVENTS.VOICE_PEER_JOINED]({
      roomId: 'test-room',
      userId: 'user-bob',
      displayName: 'Bob',
    });

    vm.leaveVoice();

    expect(mockStream.getAudioTracks()[0].stop).toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.VOICE_LEAVE);
    expect(vm.getStatus().isJoined).toBe(false);
    expect(vm.getActivePeers()).toHaveLength(0);
    vm.destroy();
  });

  it('re-emits voice:join on handleReconnected() to restore mesh connections', async () => {
    const vm = new VoiceManager(mockSocket, 'test-room', 'user-alice');
    await vm.joinVoice();

    mockSocket.emit.mockClear();
    vm.handleReconnected();

    expect(mockSocket.emit).toHaveBeenCalledWith(SOCKET_EVENTS.VOICE_JOIN, {
      roomId: 'test-room',
    });
    vm.destroy();
  });
});
