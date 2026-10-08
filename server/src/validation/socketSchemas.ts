import { z } from 'zod';
import { MAX_CHAT_MESSAGE_LENGTH } from '@synccode/shared';

export const MAX_OPERATION_TEXT_LENGTH = 50_000;
export const MAX_OPERATION_DELETE_LENGTH = 50_000;
export const MAX_DISPLAY_NAME_LENGTH = 32;
export const MAX_ROOM_ID_LENGTH = 36;
export const MAX_PASSWORD_LENGTH = 64;

export const monacoRangeSchema = z.object({
  startLineNumber: z.number().int().min(1, 'startLineNumber must be at least 1'),
  startColumn: z.number().int().min(1, 'startColumn must be at least 1'),
  endLineNumber: z.number().int().min(1, 'endLineNumber must be at least 1'),
  endColumn: z.number().int().min(1, 'endColumn must be at least 1'),
});

export const cursorPositionSchema = z.object({
  lineNumber: z.number().int().min(1, 'lineNumber must be at least 1'),
  column: z.number().int().min(1, 'column must be at least 1'),
});

export const createRoomSchema = z.object({
  displayName: z
    .string({ required_error: 'displayName is required' })
    .trim()
    .min(1, 'Display name cannot be empty')
    .max(MAX_DISPLAY_NAME_LENGTH, `Display name cannot exceed ${MAX_DISPLAY_NAME_LENGTH} characters`),
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  language: z.string().max(32).optional(),
  initialContent: z.string().max(MAX_OPERATION_TEXT_LENGTH).optional(),
});

export const joinRoomSchema = z.object({
  roomId: z
    .string({ required_error: 'roomId is required' })
    .trim()
    .min(1, 'Room ID is required')
    .max(MAX_ROOM_ID_LENGTH, 'Invalid room ID length'),
  displayName: z
    .string({ required_error: 'displayName is required' })
    .trim()
    .min(1, 'Display name cannot be empty')
    .max(MAX_DISPLAY_NAME_LENGTH, `Display name cannot exceed ${MAX_DISPLAY_NAME_LENGTH} characters`),
  password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  userId: z.string().max(64).optional(),
  reconnectToken: z.string().max(128).optional(),
});

export const reconnectRequestSchema = z.object({
  roomId: z
    .string({ required_error: 'roomId is required' })
    .trim()
    .min(1, 'Room ID is required')
    .max(MAX_ROOM_ID_LENGTH),
  userId: z
    .string({ required_error: 'userId is required' })
    .trim()
    .min(1, 'userId is required')
    .max(64),
  reconnectToken: z.string().max(128).optional(),
  lastKnownRevision: z.number().int().min(0).optional(),
});

export const roomLockSchema = z
  .object({
    roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  })
  .optional()
  .nullable();

export const roomUnlockSchema = z
  .object({
    roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  })
  .optional()
  .nullable();

export const participantRemoveSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  targetUserId: z
    .string({ required_error: 'targetUserId is required' })
    .trim()
    .min(1, 'targetUserId cannot be empty')
    .max(64),
});

export const roomCloseSchema = z
  .object({
    roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  })
  .optional()
  .nullable();

export const editorOperationSchema = z.object({
  operationId: z
    .string({ required_error: 'operationId is required' })
    .min(1, 'operationId cannot be empty')
    .max(64),
  userId: z.string().max(64).optional(),
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  baseRevision: z.number().int().min(0, 'baseRevision must be non-negative'),
  range: monacoRangeSchema,
  rangeOffset: z.number().int().min(0).optional(),
  rangeLength: z
    .number()
    .int()
    .min(0)
    .max(MAX_OPERATION_DELETE_LENGTH, `rangeLength exceeds maximum limit of ${MAX_OPERATION_DELETE_LENGTH}`)
    .optional(),
  deleteCount: z
    .number()
    .int()
    .min(0)
    .max(MAX_OPERATION_DELETE_LENGTH, `deleteCount exceeds maximum limit of ${MAX_OPERATION_DELETE_LENGTH}`)
    .optional(),
  insertedText: z
    .string({ required_error: 'insertedText is required' })
    .max(MAX_OPERATION_TEXT_LENGTH, `insertedText exceeds maximum limit of ${MAX_OPERATION_TEXT_LENGTH}`),
  deletedText: z
    .string()
    .max(MAX_OPERATION_DELETE_LENGTH, `deletedText exceeds maximum limit of ${MAX_OPERATION_DELETE_LENGTH}`)
    .optional(),
  timestamp: z.number().min(0).optional(),
  clientSequence: z.number().int().min(0).optional(),
  baseContent: z.string().optional(),
});

export const editorSyncSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  lastKnownRevision: z.number().int().min(0, 'lastKnownRevision must be non-negative').optional(),
});

export const cursorUpdateSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  position: cursorPositionSchema,
  selection: monacoRangeSchema.optional(),
});

export const presenceUpdateSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  userId: z.string().max(64).optional(),
  connectionState: z.enum(['CONNECTED', 'DISCONNECTED', 'RECONNECTING']).optional(),
  isTyping: z.boolean().optional(),
  isMuted: z.boolean().optional(),
  isSpeaking: z.boolean().optional(),
  cursor: cursorPositionSchema.optional(),
  selection: monacoRangeSchema.optional(),
});

export const chatSendSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  content: z
    .string({ required_error: 'Message content is required' })
    .trim()
    .min(1, 'Message content cannot be empty')
    .max(MAX_CHAT_MESSAGE_LENGTH, `Message exceeds maximum allowed length of ${MAX_CHAT_MESSAGE_LENGTH} characters`),
});

export const voiceOfferSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  callerUserId: z.string().max(64).optional(),
  callerName: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional(),
  targetUserId: z.string().min(1, 'targetUserId is required').max(64),
  description: z.object({
    type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
    sdp: z.string().max(50_000),
  }),
});

export const voiceAnswerSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  answererUserId: z.string().max(64).optional(),
  targetUserId: z.string().min(1, 'targetUserId is required').max(64),
  description: z.object({
    type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
    sdp: z.string().max(50_000),
  }),
});

export const voiceIceCandidateSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  senderUserId: z.string().max(64).optional(),
  targetUserId: z.string().min(1, 'targetUserId is required').max(64),
  candidate: z.object({
    candidate: z.string().max(10_000),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().nullable().optional(),
    usernameFragment: z.string().max(64).nullable().optional(),
  }),
});

export const voiceSpeakingSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  userId: z.string().max(64).optional(),
  isSpeaking: z.boolean(),
});

export const executionRequestSchema = z.object({
  roomId: z.string().max(MAX_ROOM_ID_LENGTH).optional(),
  language: z.enum(['javascript', 'typescript', 'python', 'cpp', 'java']),
  code: z.string().min(1, 'Code cannot be empty').max(65536, 'Code payload cannot exceed 64KB'),
  stdin: z.string().max(10_000).optional(),
  args: z.array(z.string().max(1000)).max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(15000).optional(),
});

export interface ValidationSuccess<T> {
  success: true;
  data: T;
}

export interface ValidationFailure {
  success: false;
  error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validatePayload<T>(schema: z.ZodType<T>, payload: unknown): ValidationResult<T> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const firstIssue = result.error.issues[0];
  const errorMessage = firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : 'Invalid payload format';
  return { success: false, error: errorMessage };
}
