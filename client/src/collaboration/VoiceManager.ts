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
  makingOffer: boolean;
  ignoreOffer: boolean;
  isPolite: boolean;
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

      // Ensure local tracks are attached to all existing peer connections
      for (const peerRecord of this.peers.values()) {
        this.ensureLocalTracks(peerRecord);
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
      const targetPeers = new Set<string>();
      if (res && res.peers && Array.isArray(res.peers)) {
        for (const peerUserId of res.peers) {
          if (peerUserId !== this.currentUserId) {
            targetPeers.add(peerUserId);
          }
        }
      }
      for (const peerUserId of this.peers.keys()) {
        if (peerUserId !== this.currentUserId) {
          targetPeers.add(peerUserId);
        }
      }

      for (const peerUserId of targetPeers) {
        await this.initiateCallToPeer(peerUserId);
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
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}] Local audio track ${track.id} enabled=${track.enabled}`
      );
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
   * Ensures local audio tracks are attached to the peer connection senders.
   */
  private ensureLocalTracks(peerRecord: PeerRecord): void {
    if (!this.localStream) return;
    const pc = peerRecord.pc;
    const senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];

    for (const track of this.localStream.getAudioTracks()) {
      const existingSender = senders.find(
        (s) => s.track === track || (s.track && s.track.kind === 'audio')
      );

      if (!existingSender) {
        pc.addTrack(track, this.localStream);
        console.log(
          `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerRecord.userId}] Added local audio track ${track.id} (enabled: ${track.enabled}, readyState: ${track.readyState})`
        );
      } else if (existingSender.track !== track) {
        if (typeof existingSender.replaceTrack === 'function') {
          existingSender.replaceTrack(track).catch((err) => {
            console.warn(
              `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerRecord.userId}] Failed to replaceTrack:`,
              err
            );
          });
          console.log(
            `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerRecord.userId}] Replaced local audio track with ${track.id} (enabled: ${track.enabled}, readyState: ${track.readyState})`
          );
        }
      } else {
        console.log(
          `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerRecord.userId}] Audio sender track state: id=${track.id}, enabled=${track.enabled}, readyState=${track.readyState}`
        );
      }
    }
  }

  /**
   * Creates RTCPeerConnection and initiates SDP Offer to a target peer.
   */
  private async initiateCallToPeer(targetUserId: string): Promise<void> {
    const peerRecord = this.getOrCreatePeerRecord(targetUserId);
    this.ensureLocalTracks(peerRecord);
    const pc = peerRecord.pc;

    if (peerRecord.makingOffer || pc.signalingState !== 'stable') {
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${targetUserId}] Skipping initiateCallToPeer: makingOffer=${peerRecord.makingOffer}, signalingState=${pc.signalingState}`
      );
      return;
    }

    try {
      peerRecord.makingOffer = true;
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${targetUserId}] Initiating offer. signalingState before: ${pc.signalingState}`
      );

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });

      if (pc.signalingState !== 'stable') {
        console.warn(
          `[VoiceManager] [local: ${this.currentUserId}, remote: ${targetUserId}] Aborting offer creation: signalingState transitioned to ${pc.signalingState}`
        );
        return;
      }

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
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${targetUserId}] Sent offer successfully. Current signalingState: ${pc.signalingState}`
      );
    } catch (err) {
      console.error(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${targetUserId}] Failed to create offer:`,
        err
      );
    } finally {
      peerRecord.makingOffer = false;
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
   * Handles incoming remote SDP offer from a peer using the Perfect Negotiation pattern.
   */
  private async handleRemoteOffer(payload: VoiceOfferPayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.callerUserId;

    const peerRecord = this.getOrCreatePeerRecord(peerUserId);
    this.ensureLocalTracks(peerRecord);
    const pc = peerRecord.pc;

    console.log(
      `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Received offer. Current signalingState: ${pc.signalingState}, makingOffer: ${peerRecord.makingOffer}, isPolite: ${peerRecord.isPolite}`
    );

    // Check for glare / offer collision
    const offerCollision = peerRecord.makingOffer || pc.signalingState !== 'stable';

    peerRecord.ignoreOffer = !peerRecord.isPolite && offerCollision;
    if (peerRecord.ignoreOffer) {
      console.warn(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Glare detected: Impolite peer ignoring colliding remote offer.`
      );
      return;
    }

    try {
      if (offerCollision) {
        console.log(
          `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Glare detected: Polite peer rolling back local offer to accept remote offer.`
        );
        await pc.setLocalDescription({ type: 'rollback' });
      }

      const remoteDesc = new RTCSessionDescription({
        type: payload.description.type as RTCSdpType,
        sdp: payload.description.sdp,
      });

      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Applying offer, signalingState before: ${pc.signalingState}`
      );
      await pc.setRemoteDescription(remoteDesc);
      peerRecord.isRemoteDescriptionSet = true;

      // Drain any queued ICE candidates
      await this.drainQueuedCandidates(peerRecord);

      // Create and set local answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Created and set answer, signalingState: ${pc.signalingState}`
      );

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
      console.error(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Failed to handle remote offer:`,
        err
      );
    }
  }

  /**
   * Handles incoming remote SDP answer from a peer.
   * Only calls setRemoteDescription when in 'have-local-offer' state.
   */
  private async handleRemoteAnswer(payload: VoiceAnswerPayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.answererUserId;

    const peerRecord = this.peers.get(peerUserId);
    if (!peerRecord) {
      console.warn(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Received answer for non-existent peer record.`
      );
      return;
    }

    const pc = peerRecord.pc;
    const belongsToCurrentNegotiation = pc.signalingState === 'have-local-offer';

    console.log(
      `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Received answer. Current signalingState: ${pc.signalingState}. Belongs to current negotiation: ${belongsToCurrentNegotiation}`
    );

    // Requirement 2: Call setRemoteDescription(answer) only when the corresponding peer connection is in have-local-offer state.
    // Prevent duplicate or stale answers from being applied.
    if (!belongsToCurrentNegotiation) {
      console.warn(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Stale or duplicate answer ignored. signalingState before: '${pc.signalingState}'. Belongs to current negotiation: false`
      );
      return;
    }

    try {
      const remoteDesc = new RTCSessionDescription({
        type: payload.description.type as RTCSdpType,
        sdp: payload.description.sdp,
      });

      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Applying answer, signalingState before: ${pc.signalingState}`
      );
      await pc.setRemoteDescription(remoteDesc);
      peerRecord.isRemoteDescriptionSet = true;
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Remote answer applied successfully. New signalingState: ${pc.signalingState}`
      );

      await this.drainQueuedCandidates(peerRecord);
    } catch (err) {
      console.error(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Failed to set remote answer:`,
        err
      );
    }
  }

  /**
   * Handles incoming remote ICE candidate from a peer.
   */
  private async handleRemoteIceCandidate(payload: VoiceIceCandidatePayload): Promise<void> {
    if (payload.targetUserId !== this.currentUserId) return;
    const peerUserId = payload.senderUserId;

    const peerRecord = this.peers.get(peerUserId);
    if (!peerRecord) {
      console.warn(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Received ICE candidate for unknown peer.`
      );
      return;
    }

    const candidateInit: RTCIceCandidateInit = {
      candidate: payload.candidate.candidate,
      sdpMid: payload.candidate.sdpMid,
      sdpMLineIndex: payload.candidate.sdpMLineIndex,
      usernameFragment: payload.candidate.usernameFragment,
    };

    if (peerRecord.isRemoteDescriptionSet && peerRecord.pc.remoteDescription) {
      try {
        await peerRecord.pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        if (!peerRecord.ignoreOffer) {
          console.warn(
            `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Failed to add ICE candidate:`,
            err
          );
        }
      }
    } else {
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Queued ICE candidate (waiting for remote description).`
      );
      peerRecord.queuedCandidates.push(candidateInit);
    }
  }

  private async drainQueuedCandidates(peerRecord: PeerRecord): Promise<void> {
    if (!peerRecord.isRemoteDescriptionSet || !peerRecord.pc.remoteDescription) return;

    while (peerRecord.queuedCandidates.length > 0) {
      const cand = peerRecord.queuedCandidates.shift();
      if (cand) {
        try {
          await peerRecord.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          if (!peerRecord.ignoreOffer) {
            console.warn(
              `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerRecord.userId}] Failed to add queued ICE candidate:`,
              err
            );
          }
        }
      }
    }
  }

  /**
   * Retrieves an existing peer record or creates a new RTCPeerConnection.
   */
  private getOrCreatePeerRecord(peerUserId: string): PeerRecord {
    let record = this.peers.get(peerUserId);
    if (record && record.pc.connectionState !== 'closed') {
      this.ensureLocalTracks(record);
      return record;
    }

    if (record) {
      this.removePeer(peerUserId);
    }

    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
    const isPolite = this.currentUserId > peerUserId;

    record = {
      userId: peerUserId,
      pc,
      queuedCandidates: [],
      isRemoteDescriptionSet: false,
      makingOffer: false,
      ignoreOffer: false,
      isPolite,
    };

    this.peers.set(peerUserId, record);

    // Attach local audio track if microphone stream is already active
    this.ensureLocalTracks(record);

    // Handle local ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
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
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Remote audio track received: id=${event.track.id}, kind=${event.track.kind}, enabled=${event.track.enabled}, readyState=${event.track.readyState}`
      );

      const stream =
        event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);

      if (!record!.audioElement) {
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.srcObject = stream;
        record!.audioElement = audio;
      } else {
        record!.audioElement.srcObject = stream;
      }

      if (typeof record!.audioElement.play === 'function') {
        record!.audioElement.play().catch((err) => {
          console.warn(
            `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] Remote audio play() promise rejected:`,
            err
          );
        });
      }
    };

    // Monitor peer connection state & log diagnostics
    pc.onconnectionstatechange = () => {
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] connectionState: ${pc.connectionState}, iceConnectionState: ${pc.iceConnectionState}`
      );
      if (pc.connectionState === 'failed') {
        pc.restartIce?.();
      }
      this.emitStatus(null);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(
        `[VoiceManager] [local: ${this.currentUserId}, remote: ${peerUserId}] iceConnectionState: ${pc.iceConnectionState}, connectionState: ${pc.connectionState}`
      );
    };

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
