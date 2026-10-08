import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import { createApp } from '../src/app';
import { setupSocketServer } from '../src/socket';
import {
  SOCKET_EVENTS,
  VoiceOfferPayload,
  VoiceAnswerPayload,
  VoiceIceCandidatePayload,
  VoicePeerJoinedPayload,
  VoicePeerLeftPayload,
  PresenceUpdatePayload,
} from '@synccode/shared';

describe('WebRTC Voice Signaling Relay Integration Tests', () => {
  let httpServer: http.Server;
  let port: number;
  const activeSockets: ClientSocketType[] = [];

  const createClient = (): Promise<ClientSocketType> => {
    return new Promise((resolve, reject) => {
      const socket = ClientSocket(`http://localhost:${port}`, {
        transports: ['websocket'],
      });
      socket.on('connect', () => {
        activeSockets.push(socket);
        resolve(socket);
      });
      socket.on('connect_error', reject);
    });
  };

  beforeAll(async () => {
    const app = createApp();
    httpServer = http.createServer(app);
    setupSocketServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        if (addr && typeof addr !== 'string') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    for (const socket of activeSockets) {
      if (socket.connected) {
        socket.disconnect();
      }
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('handles voice:join and informs peers with voice:peer-joined', async () => {
    const aliceSocket = await createClient();
    const bobSocket = await createClient();

    // Alice creates room
    const createRes: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Alice' }, resolve);
    });
    const roomId = createRes.data.room.roomId;
    const aliceUserId = createRes.data.participant.userId;

    // Bob joins room
    const joinRes: any = await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, resolve);
    });
    const bobUserId = joinRes.data.participant.userId;

    // Alice listens for Bob joining voice
    const peerJoinedPromise = new Promise<VoicePeerJoinedPayload>((resolve) => {
      aliceSocket.once(SOCKET_EVENTS.VOICE_PEER_JOINED, resolve);
    });

    // Bob joins voice
    const bobVoiceJoinRes: any = await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.VOICE_JOIN, { roomId }, resolve);
    });

    expect(bobVoiceJoinRes.success).toBe(true);
    expect(bobVoiceJoinRes.peers).toContain(aliceUserId);

    const peerJoined = await peerJoinedPromise;
    expect(peerJoined.userId).toBe(bobUserId);
    expect(peerJoined.displayName).toBe('Bob');
  });

  it('strictly relays voice:offer, voice:answer, and voice:ice-candidate directly between peers', async () => {
    const aliceSocket = await createClient();
    const bobSocket = await createClient();

    const createRes: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Alice' }, resolve);
    });
    const roomId = createRes.data.room.roomId;
    const aliceUserId = createRes.data.participant.userId;

    const joinRes: any = await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, resolve);
    });
    const bobUserId = joinRes.data.participant.userId;

    // 1. Alice sends offer to Bob
    const offerPromise = new Promise<VoiceOfferPayload>((resolve) => {
      bobSocket.once(SOCKET_EVENTS.VOICE_OFFER, resolve);
    });

    const mockOffer: VoiceOfferPayload = {
      roomId,
      callerUserId: aliceUserId,
      callerName: 'Alice',
      targetUserId: bobUserId,
      description: { type: 'offer', sdp: 'v=0\r\no=alice 1234 5678 IN IP4 127.0.0.1\r\ns=-\r\n' },
    };

    const offerAck: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.VOICE_OFFER, mockOffer, resolve);
    });
    expect(offerAck.success).toBe(true);

    const receivedOffer = await offerPromise;
    expect(receivedOffer.callerUserId).toBe(aliceUserId);
    expect(receivedOffer.targetUserId).toBe(bobUserId);
    expect(receivedOffer.description.type).toBe('offer');
    expect(receivedOffer.description.sdp).toBe(mockOffer.description.sdp);

    // 2. Bob sends answer back to Alice
    const answerPromise = new Promise<VoiceAnswerPayload>((resolve) => {
      aliceSocket.once(SOCKET_EVENTS.VOICE_ANSWER, resolve);
    });

    const mockAnswer: VoiceAnswerPayload = {
      roomId,
      answererUserId: bobUserId,
      targetUserId: aliceUserId,
      description: { type: 'answer', sdp: 'v=0\r\no=bob 8765 4321 IN IP4 127.0.0.1\r\ns=-\r\n' },
    };

    const answerAck: any = await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.VOICE_ANSWER, mockAnswer, resolve);
    });
    expect(answerAck.success).toBe(true);

    const receivedAnswer = await answerPromise;
    expect(receivedAnswer.answererUserId).toBe(bobUserId);
    expect(receivedAnswer.targetUserId).toBe(aliceUserId);
    expect(receivedAnswer.description.type).toBe('answer');

    // 3. ICE Candidate relay from Alice to Bob
    const candidatePromise = new Promise<VoiceIceCandidatePayload>((resolve) => {
      bobSocket.once(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, resolve);
    });

    const mockCandidate: VoiceIceCandidatePayload = {
      roomId,
      senderUserId: aliceUserId,
      targetUserId: bobUserId,
      candidate: {
        candidate: 'candidate:1 1 UDP 2122252543 192.168.1.100 50000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    };

    const candidateAck: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.VOICE_ICE_CANDIDATE, mockCandidate, resolve);
    });
    expect(candidateAck.success).toBe(true);

    const receivedCandidate = await candidatePromise;
    expect(receivedCandidate.senderUserId).toBe(aliceUserId);
    expect(receivedCandidate.candidate.candidate).toBe(mockCandidate.candidate.candidate);
  });

  it('broadcasts voice:speaking updates to peers via presence:update', async () => {
    const aliceSocket = await createClient();
    const bobSocket = await createClient();

    const createRes: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Alice' }, resolve);
    });
    const roomId = createRes.data.room.roomId;
    const aliceUserId = createRes.data.participant.userId;

    await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, resolve);
    });

    const presencePromise = new Promise<PresenceUpdatePayload>((resolve) => {
      bobSocket.on(SOCKET_EVENTS.PRESENCE_UPDATE, (payload: PresenceUpdatePayload) => {
        if (payload.userId === aliceUserId && payload.isSpeaking === true) {
          resolve(payload);
        }
      });
    });

    aliceSocket.emit(SOCKET_EVENTS.VOICE_SPEAKING, { roomId, isSpeaking: true });

    const presence = await presencePromise;
    expect(presence.isSpeaking).toBe(true);
    expect(presence.userId).toBe(aliceUserId);
  });

  it('notifies room when peer leaves voice with voice:peer-left', async () => {
    const aliceSocket = await createClient();
    const bobSocket = await createClient();

    const createRes: any = await new Promise((resolve) => {
      aliceSocket.emit(SOCKET_EVENTS.ROOM_CREATE, { displayName: 'Alice' }, resolve);
    });
    const roomId = createRes.data.room.roomId;

    const joinRes: any = await new Promise((resolve) => {
      bobSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomId, displayName: 'Bob' }, resolve);
    });
    const bobUserId = joinRes.data.participant.userId;

    const peerLeftPromise = new Promise<VoicePeerLeftPayload>((resolve) => {
      aliceSocket.once(SOCKET_EVENTS.VOICE_PEER_LEFT, resolve);
    });

    bobSocket.emit(SOCKET_EVENTS.VOICE_LEAVE);

    const peerLeft = await peerLeftPromise;
    expect(peerLeft.userId).toBe(bobUserId);
  });
});
