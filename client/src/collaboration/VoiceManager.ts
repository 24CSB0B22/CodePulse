import { Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  VoiceOfferPayload,
  VoiceAnswerPayload,
  VoiceIceCandidatePayload,
  VoicePeerJoinedPayload,
  VoicePeerLeftPayload,
} from '@synccode/shared';

export interface VoiceStatus {
  isSupported: boolean;
  isJoined: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  activePeerCount: number;
  error: string | null;
}

interface PeerRecord {
  userId: string;
  pc: RTCPeerConnection;
  audioElement?: HTMLAudioElement;
  queuedCandidates: RTCIceCandidateInit[];
  isRemoteDescriptionSet: boolean;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class VoiceManager {
  private socket: Socket;
  private roomId: string;
  private currentUserId: string;

  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private speakingInterval: any = null;

  private isJoined: boolean = false;
  private isMuted: boolean = false;
  private isSpeaking: boolean = false;
  private lastSpeakingTimestamp: number = 0;

  private peers: Map<string, PeerRecord> = new Map();
  private onStatusChange?: (status: VoiceStatus) => void;
  private onSpeakingChange?: (isSpeaking: boolean) => void;

  // Socket event listener references
  private readonly onVoicePeerJoined = (payload: VoicePeerJoinedPayload) => this.handlePeerJoined(payload);
  private readonly onVoiceOffer = (payload: VoiceOfferPayload) => this.handleRemoteOffer(payload);
  private readonly onVoiceAnswer = (payload: VoiceAnswerPayload) => this.handleRemoteAnswer(payload);
  private readonly onVoiceIceCandidate = (payload: VoiceIceCandidatePayload) => this.handleRemoteIceCandidate(payload);
  private readonly onVoicePeerLeft = (payload: VoicePeerLeftPayload) => this.removePeer(payload.userId);
  private readonly onParticipantLeft = (payload: { userId: string }) => this.removePeer(payload.userId);

  constructor(
    socket: Socket,
    roomId: string,
    currentUserId: string,
    options?: {
      onStatusChange?: (status: VoiceStatus) => void;
      onSpeakingChange?: (isSpeaking: boolean) => void;
    }
  ) {
    this.socket = socket;
    this.roomId = roomId;
    this.currentUserId = currentUserId;
    this.onStatusChange = options?.onStatusChange;
    this.onSpeakingChange = options?.onSpeakingChange;

    this.setupSocketListeners();
  }

  private setupSocketListeners(): void {
    this.socket.on(SOCKET_EVENTS.VOICE_PEER_JOINED, this.onVoicePeerJoined);
    this.socket.on(SOCKET_EVENTS.VOICE_OFFER, this.onVoiceOffer);
    this.socket.on(SOCKET_EVENTS.VOICE_ANSWER, this.onVoiceAnswer);
    this.socket.on(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, this.onVoiceIceCandidate);
    this.socket.on(SOCKET_EVENTS.VOICE_PEER_LEFT, this.onVoicePeerLeft);
    this.socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, this.onParticipantLeft);
  }

  /**
   * Initializes local microphone audio and joins room voice communication mesh.
   */
  public async joinVoice(startMuted = false): Promise<{ success: boolean; error?: string }> {
    if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
      const err = 'WebRTC / Microphone is not supported in this browser environment';
      this.emitStatus(err);
      return { success: false, error: err };
    }

    try {
      // 1. Request microphone permission and acquire local audio stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      this.localStream = stream;
      this.isJoined = true;
      this.isMuted = startMuted;

      // Apply initial mute state to audio tracks
      if (startMuted) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      // Notify room presence that microphone state changed
      this.socket.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
        roomId: this.roomId,
        isMuted: this.isMuted,
        isSpeaking: false,
      });

      // 2. Setup AudioContext & AnalyserNode for local speaking indicator
      this.setupSpeakingDetection(stream);

      // 3. Notify server signaling relay that we joined voice
      const res: any = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ success: true, peers: [] }), 500);
        this.socket.emit(
          SOCKET_EVENTS.VOICE_JOIN,
          { roomId: this.roomId },
          (response?: { success: boolean; peers?: string[]; error?: string }) => {
            clearTimeout(timer);
            resolve(response || { success: true, peers: [] });
          }
        );
      });

      // 4. Initiate WebRTC peer connection offers to any existing peers
      if (res && res.peers && Array.isArray(res.peers)) {
        for (const peerUserId of res.peers) {
          if (peerUserId !== this.currentUserId) {
            await this.initiateCallToPeer(peerUserId);
          }
        }
      }

      this.emitStatus(null);
      return { success: true };
    } catch (err: unknown) {
      let errorMessage = 'Microphone permission denied or audio device unavailable';
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorMessage = 'Microphone access denied. Please grant permission in browser settings.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errorMessage = 'No microphone device found on this system.';
        } else {
          errorMessage = err.message;
        }
      }

      this.emitStatus(errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Toggles microphone mute / unmute state.
   */
  public toggleMute(): boolean {
    if (!this.localStream) return this.isMuted;

    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isMuted;
    });

    if (this.isMuted && this.isSpeaking) {
      this.setSpeaking(false);
    }

    this.socket.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
      roomId: this.roomId,
      isMuted: this.isMuted,
      isSpeaking: false,
    });

    this.emitStatus(null);
    return this.isMuted;
  }

  /**
   * Sets up AudioContext AnalyserNode to detect speaking activity.
   */
  private setupSpeakingDetection(stream: MediaStream): void {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      this.audioContext = new AudioContextClass();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.4;
      source.connect(this.analyser);

      const bufferLength = this.analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      this.speakingInterval = setInterval(() => {
        if (!this.analyser || this.isMuted) {
          if (this.isSpeaking) this.setSpeaking(false);
          return;
        }

        this.analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        const SPEAKING_THRESHOLD = 14;
        const now = Date.now();

        if (average > SPEAKING_THRESHOLD) {
          this.lastSpeakingTimestamp = now;
          if (!this.isSpeaking) {
            this.setSpeaking(true);
          }
        } else if (this.isSpeaking && now - this.lastSpeakingTimestamp > 450) {
          this.setSpeaking(false);
        }
      }, 100);
    } catch {
      // AudioContext failure gracefully falls back to non-visual speaking
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.isSpeaking === speaking) return;
    this.isSpeaking = speaking;

    this.socket.emit(SOCKET_EVENTS.VOICE_SPEAKING, {
      roomId: this.roomId,
      isSpeaking: speaking,
    });

    if (this.onSpeakingChange) {
      this.onSpeakingChange(speaking);
    }
    this.emitStatus(null);
  }

  /**
   * Creates RTCPeerConnection and initiates SDP Offer to a target peer.
   */
  private async initiateCallToPeer(targetUserId: string): Promise<void> {
    const peerRecord = this.getOrCreatePeerRecord(targetUserId);
    const pc = peerRecord.pc;

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      await pc.setLocalDescription(offer);

      const offerPayload: VoiceOfferPayload = {
        roomId: this.roomId,
        callerUserId: this.currentUserId,
        targetUserId,
        description: {
          type: offer.type,
          sdp: offer.sdp || '',
        },
      };

      this.socket.emit(SOCKET_EVENTS.VOICE_OFFER, offerPayload);
    } catch (err) {
      console.error(`[VoiceManager] Failed to create offer to peer ${targetUserId}:`, err);
    }
  }

  /**
   * Handles peer joining event: initiates connection offer to newly joined peer.
   */
  private async handlePeerJoined(payload: VoicePeerJoinedPayload): Promise<void> {
    if (payload.userId === this.currentUserId) return;
    if (!this.isJoined || !this.localStream) return;

    // Existing joined peer creates offer to new joiner
    await this.initiateCallToPeer(payload.userId);
  }

  /**
   * Handles incoming remote SDP offer from a peer.
   */
  private async handleRemoteOffer(payload: VoiceOfferPayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.callerUserId;

    const peerRecord = this.getOrCreatePeerRecord(peerUserId);
    const pc = peerRecord.pc;

    try {
      const remoteDesc = new RTCSessionDescription({
        type: payload.description.type as RTCSdpType,
        sdp: payload.description.sdp,
      });

      await pc.setRemoteDescription(remoteDesc);
      peerRecord.isRemoteDescriptionSet = true;

      // Drain any queued ICE candidates
      await this.drainQueuedCandidates(peerRecord);

      // Create and send SDP answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const answerPayload: VoiceAnswerPayload = {
        roomId: this.roomId,
        answererUserId: this.currentUserId,
        targetUserId: peerUserId,
        description: {
          type: answer.type,
          sdp: answer.sdp || '',
        },
      };

      this.socket.emit(SOCKET_EVENTS.VOICE_ANSWER, answerPayload);
    } catch (err) {
      console.error(`[VoiceManager] Failed to handle offer from ${peerUserId}:`, err);
    }
  }

  /**
   * Handles incoming remote SDP answer from a peer.
   */
  private async handleRemoteAnswer(payload: VoiceAnswerPayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.answererUserId;

    const peerRecord = this.peers.get(peerUserId);
    if (!peerRecord) return;

    try {
      const remoteDesc = new RTCSessionDescription({
        type: payload.description.type as RTCSdpType,
        sdp: payload.description.sdp,
      });

      await peerRecord.pc.setRemoteDescription(remoteDesc);
      peerRecord.isRemoteDescriptionSet = true;

      await this.drainQueuedCandidates(peerRecord);
    } catch (err) {
      console.error(`[VoiceManager] Failed to set remote answer from ${peerUserId}:`, err);
    }
  }

  /**
   * Handles incoming remote ICE candidate from a peer.
   */
  private async handleRemoteIceCandidate(payload: VoiceIceCandidatePayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.senderUserId;

    const peerRecord = this.peers.get(peerUserId);
    if (!peerRecord) return;

    const candidateInit: RTCIceCandidateInit = {
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid,
      sdpMLineIndex: payload.candidate.sdpMLineIndex,
      usernameFragment: payload.candidate.usernameFragment,
    };

    if (peerRecord.isRemoteDescriptionSet) {
      try {
        await peerRecord.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        console.error(`[VoiceManager] Failed to add ICE candidate:`, err);
      }
    } else {
      peerRecord.queuedCandidates.push(candidateInit);
    }
  }

  private async drainQueuedCandidates(peerRecord: PeerRecord): Promise<void> {
    while (peerRecord.queuedCandidates.length > 0) {
      const cand = peerRecord.queuedCandidates.shift();
      if (cand) {
        try {
          await peerRecord.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          console.error('[VoiceManager] Failed to add queued ICE candidate:', err);
        }
      }
    }
  }

  /**
   * Retrieves an existing peer record or creates a new RTCPeerConnection.
   */
  private getOrCreatePeerRecord(peerUserId: string): PeerRecord {
    let record = this.peers.get(peerUserId);
    if (record) return record;

    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });

    // Add local audio tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Handle local ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidatePayload: VoiceIceCandidatePayload = {
          roomId: this.roomId,
          senderUserId: this.currentUserId,
          targetUserId: peerUserId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        };
        this.socket.emit(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, candidatePayload);
      }
    };

    // Handle incoming peer audio track
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        if (!record!.audioElement) {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = event.streams[0];
          record!.audioElement = audio;
        } else {
          record!.audioElement.srcObject = event.streams[0];
        }
      }
    };

    // Monitor peer connection state
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Attempt ICE restart if peer connection failed
        pc.restartIce();
      }
      this.emitStatus(null);
    };

    record = {
      userId: peerUserId,
      pc,
      queuedCandidates: [],
      isRemoteDescriptionSet: false,
    };

    this.peers.set(peerUserId, record);
    this.emitStatus(null);
    return record;
  }

  /**
   * Cleans up and disconnects a specific peer.
   */
  public removePeer(peerUserId: string): void {
    const record = this.peers.get(peerUserId);
    if (record) {
      if (record.audioElement) {
        record.audioElement.srcObject = null;
        record.audioElement.remove();
      }
      try {
        record.pc.close();
      } catch {}
      this.peers.delete(peerUserId);
      this.emitStatus(null);
    }
  }

  /**
   * Leaves voice room and cleans up all WebRTC media resources.
   */
  public leaveVoice(): void {
    if (this.isJoined) {
      this.socket.emit(SOCKET_EVENTS.VOICE_LEAVE);
      this.socket.emit(SOCKET_EVENTS.PRESENCE_UPDATE, {
        roomId: this.roomId,
        isMuted: true,
        isSpeaking: false,
      });
    }

    if (this.speakingInterval) {
      clearInterval(this.speakingInterval);
      this.speakingInterval = null;
    }

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    for (const [userId] of this.peers) {
      this.removePeer(userId);
    }
    this.peers.clear();

    this.isJoined = false;
    this.isSpeaking = false;
    this.emitStatus(null);
  }

  private emitStatus(error: string | null): void {
    if (this.onStatusChange) {
      this.onStatusChange({
        isSupported: typeof window !== 'undefined' && Boolean(navigator?.mediaDevices?.getUserMedia),
        isJoined: this.isJoined,
        isMuted: this.isMuted,
        isSpeaking: this.isSpeaking,
        activePeerCount: this.peers.size,
        error,
      });
    }
  }

  public getStatus(): VoiceStatus {
    return {
      isSupported: typeof window !== 'undefined' && Boolean(navigator?.mediaDevices?.getUserMedia),
      isJoined: this.isJoined,
      isMuted: this.isMuted,
      isSpeaking: this.isSpeaking,
      activePeerCount: this.peers.size,
      error: null,
    };
  }

  public getActivePeers(): string[] {
    return Array.from(this.peers.keys());
  }

  public setMuted(muted: boolean): void {
    if (this.isMuted === muted) return;
    this.toggleMute();
  }

  public handleReconnected(): void {
    if (this.isJoined) {
      this.socket.emit(SOCKET_EVENTS.VOICE_JOIN, { roomId: this.roomId });
    }
  }

  /**
   * Destroys manager and removes all socket listeners.
   */
  public destroy(): void {
    this.leaveVoice();

    this.socket.off(SOCKET_EVENTS.VOICE_PEER_JOINED, this.onVoicePeerJoined);
    this.socket.off(SOCKET_EVENTS.VOICE_OFFER, this.onVoiceOffer);
    this.socket.off(SOCKET_EVENTS.VOICE_ANSWER, this.onVoiceAnswer);
    this.socket.off(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, this.onVoiceIceCandidate);
    this.socket.off(SOCKET_EVENTS.VOICE_PEER_LEFT, this.onVoicePeerLeft);
    this.socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, this.onParticipantLeft);
  }
}
