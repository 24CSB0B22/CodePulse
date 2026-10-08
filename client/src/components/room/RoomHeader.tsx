import React, { useState } from 'react';
import { Copy, Check, LogOut, Users, Lock, Unlock, Code2, XOctagon, MessageSquare, Mic, MicOff, Volume2 } from 'lucide-react';

interface RoomHeaderProps {
  roomId: string;
  language: string;
  participantCount: number;
  maxParticipants: number;
  isLocked: boolean;
  isHost?: boolean;
  isChatOpen?: boolean;
  unreadChatCount?: number;
  isMuted?: boolean;
  isSpeaking?: boolean;
  onToggleMic?: () => void;
  onToggleChat?: () => void;
  onToggleLock?: () => void;
  onCloseRoom?: () => void;
  onLeaveRoom: () => void;
}

export const RoomHeader: React.FC<RoomHeaderProps> = ({
  roomId,
  language,
  participantCount,
  maxParticipants,
  isLocked,
  isHost,
  isChatOpen,
  unreadChatCount,
  isMuted,
  isSpeaking,
  onToggleMic,
  onToggleChat,
  onToggleLock,
  onCloseRoom,
  onLeaveRoom,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
      {/* Brand & Room Identity */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-sm shrink-0">
          SC
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Room</span>
            <span className="font-mono text-sm font-bold text-white truncate">{roomId}</span>
            <button
              onClick={handleCopy}
              className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-white transition flex items-center gap-1 text-[11px]"
              title="Copy Room ID"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 font-sans">Copied!</span>
                </>
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Middle Badges */}
      <div className="hidden sm:flex items-center gap-3">
        {/* Language Badge */}
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 text-xs font-medium">
          <Code2 className="w-3.5 h-3.5 text-indigo-400" />
          <span className="capitalize">{language}</span>
        </div>

        {/* Capacity Badge */}
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 text-xs font-medium">
          <Users className="w-3.5 h-3.5 text-emerald-400" />
          <span>
            {participantCount} / {maxParticipants} Users
          </span>
        </div>

        {/* Lock State */}
        {isLocked && (
          <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-950/60 border border-amber-800/80 text-amber-300 text-xs font-medium">
            <Lock className="w-3.5 h-3.5 text-amber-400" />
            <span>Read-Only</span>
          </div>
        )}
      </div>

      {/* Right Controls: Host actions & Leave Room */}
      <div className="flex items-center gap-2">
        {isHost && (
          <>
            {onToggleLock && (
              <button
                onClick={onToggleLock}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition border ${
                  isLocked
                    ? 'bg-amber-950/80 border-amber-700 text-amber-300 hover:bg-amber-900/80'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700'
                }`}
                title={isLocked ? 'Unlock Editor for members' : 'Lock Editor (Read-Only for members)'}
              >
                {isLocked ? (
                  <Lock className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Unlock className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span>{isLocked ? 'Unlock' : 'Lock'}</span>
              </button>
            )}

            {onCloseRoom && (
              <button
                onClick={onCloseRoom}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-rose-800/80 bg-rose-950/60 text-rose-300 hover:bg-rose-900/80 text-xs font-medium transition"
                title="Close room for all participants"
              >
                <XOctagon className="w-3.5 h-3.5" />
                <span>Close</span>
              </button>
            )}
          </>
        )}

        {onToggleMic && (
          <button
            onClick={onToggleMic}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition border ${
              isMuted
                ? 'bg-rose-950/80 border-rose-800 text-rose-300 hover:bg-rose-900/80'
                : isSpeaking
                  ? 'bg-emerald-900 border-emerald-400 text-emerald-200 ring-1 ring-emerald-400/50 animate-pulse'
                  : 'bg-emerald-950/80 border-emerald-800 text-emerald-300 hover:bg-emerald-900/80'
            }`}
            title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            aria-label={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
          >
            {isMuted ? (
              <>
                <MicOff className="w-3.5 h-3.5 text-rose-400" />
                <span>Muted</span>
              </>
            ) : isSpeaking ? (
              <>
                <Volume2 className="w-3.5 h-3.5 text-emerald-300" />
                <span>Speaking</span>
              </>
            ) : (
              <>
                <Mic className="w-3.5 h-3.5 text-emerald-400" />
                <span>Mic On</span>
              </>
            )}
          </button>
        )}

        {onToggleChat && (
          <button
            onClick={onToggleChat}
            className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition border ${
              isChatOpen
                ? 'bg-indigo-950/80 border-indigo-700 text-indigo-300 hover:bg-indigo-900/80'
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700'
            }`}
            title={isChatOpen ? 'Close Chat' : 'Open Chat'}
            aria-label="Toggle Chat"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Chat</span>
            {unreadChatCount && unreadChatCount > 0 ? (
              <span className="ml-0.5 px-1.5 py-0.2 bg-rose-500 text-white text-[10px] font-bold rounded-full">
                {unreadChatCount}
              </span>
            ) : null}
          </button>
        )}

        <button
          onClick={onLeaveRoom}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-rose-800 hover:bg-rose-950/40 text-slate-300 hover:text-rose-300 text-xs font-medium transition"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span>Leave Room</span>
        </button>
      </div>
    </header>
  );
};
