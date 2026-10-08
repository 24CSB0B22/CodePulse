export interface SimpleSessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp: string;
}

export interface SimpleIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface VoiceOfferPayload {
  roomId: string;
  callerUserId: string;
  callerName?: string;
  targetUserId: string;
  description: SimpleSessionDescription;
}

export interface VoiceAnswerPayload {
  roomId: string;
  answererUserId: string;
  targetUserId: string;
  description: SimpleSessionDescription;
}

export interface VoiceIceCandidatePayload {
  roomId: string;
  senderUserId: string;
  targetUserId: string;
  candidate: SimpleIceCandidate;
}

export interface VoicePeerJoinedPayload {
  roomId: string;
  userId: string;
  displayName: string;
}

export interface VoicePeerLeftPayload {
  roomId: string;
  userId: string;
}

export interface VoiceStatusUpdatePayload {
  roomId: string;
  userId: string;
  isMuted: boolean;
  isSpeaking: boolean;
}
