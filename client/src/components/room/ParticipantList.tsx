import React from 'react';
import { Participant } from '@synccode/shared';
import {
  Crown,
  User,
  Wifi,
  WifiOff,
  UserMinus,
  Mic,
  MicOff,
  Volume2,
  Edit3,
} from 'lucide-react';

interface ParticipantListProps {
  participants: Participant[];
  currentUserId: string;
  maxParticipants: number;
  isHost?: boolean;
  onRemoveParticipant?: (userId: string) => void;
  onToggleMic?: () => void;
}

export const ParticipantList: React.FC<ParticipantListProps> = ({
  participants,
  currentUserId,
  maxParticipants,
  isHost,
  onRemoveParticipant,
  onToggleMic,
}) => {
  const emptySlots = Math.max(0, maxParticipants - participants.length);

  return (
    <aside className="w-full sm:w-64 border-r border-slate-800 bg-slate-900/40 p-4 flex flex-col shrink-0 select-none">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800/80">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Collaborators ({participants.length}/{maxParticipants})
        </h3>
      </div>

      <div className="space-y-2.5 flex-1 overflow-y-auto">
        {participants.map((p) => {
          const isCurrentUser = p.userId === currentUserId;
          const isConnected = p.connectionState === 'CONNECTED';
          const isReconnecting = p.connectionState === 'RECONNECTING';

          const connectionStatusLabel = isConnected
            ? 'Online'
            : isReconnecting
              ? 'Reconnecting...'
              : 'Offline';

          const statusColor = isConnected
            ? '#10B981'
            : isReconnecting
              ? '#F59E0B'
              : '#64748B';

          return (
            <div
              key={p.userId}
              data-testid={`participant-${p.userId}`}
              className={`p-2.5 rounded-xl border flex flex-col gap-2 transition ${
                isCurrentUser
                  ? 'bg-slate-800/80 border-slate-700/80 shadow-sm'
                  : 'bg-slate-950/60 border-slate-800/70 hover:bg-slate-900/60'
              }`}
            >
              {/* Header row: Avatar, Name, Role & Badges */}
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Colored Avatar */}
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs text-white shadow shrink-0"
                    style={{ backgroundColor: p.color.hex }}
                    title={`Color: ${p.color.name} (${p.color.hex})`}
                  >
                    {p.displayName.slice(0, 1).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-slate-200 truncate">
                        {p.displayName}
                      </span>
                      {isCurrentUser && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-400 border border-indigo-800 font-mono">
                          You
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: statusColor }}
                      />
                      <span>{connectionStatusLabel}</span>
                      <span>•</span>
                      <span>{p.role === 'HOST' ? 'Host' : 'Member'}</span>
                    </div>
                  </div>
                </div>

                {/* Status Icons: Host, Connection, Eject */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {p.role === 'HOST' && (
                    <span title="Room Host">
                      <Crown className="w-3.5 h-3.5 text-amber-400" />
                    </span>
                  )}

                  {isConnected ? (
                    <span title="Connected">
                      <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                    </span>
                  ) : (
                    <span title={connectionStatusLabel}>
                      <WifiOff
                        className={`w-3.5 h-3.5 ${
                          isReconnecting ? 'text-amber-400 animate-pulse' : 'text-slate-500'
                        }`}
                      />
                    </span>
                  )}

                  {/* Eject button for Host on other members */}
                  {isHost && !isCurrentUser && onRemoveParticipant && (
                    <button
                      onClick={() => onRemoveParticipant(p.userId)}
                      className="p-1 rounded hover:bg-rose-950/60 text-slate-400 hover:text-rose-400 transition"
                      title={`Remove ${p.displayName} from room`}
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Sub-row: Microphone State, Typing Indicator, and Cursor Location */}
              <div className="flex items-center justify-between text-[11px] pt-1 border-t border-slate-800/40 text-slate-400">
                {/* Left side: Microphone state */}
                <div className="flex items-center gap-1.5">
                  {isCurrentUser && onToggleMic ? (
                    <button
                      onClick={onToggleMic}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono transition ${
                        p.isMuted
                          ? 'bg-rose-950/60 text-rose-300 border border-rose-800/60 hover:bg-rose-900/60'
                          : p.isSpeaking
                            ? 'bg-emerald-900 text-emerald-200 border border-emerald-400 ring-1 ring-emerald-400/50 hover:bg-emerald-800 animate-pulse'
                            : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/60 hover:bg-emerald-900/60'
                      }`}
                      title={p.isMuted ? 'Click to Unmute Microphone' : 'Click to Mute Microphone'}
                    >
                      {p.isMuted ? (
                        <>
                          <MicOff className="w-3 h-3 text-rose-400" />
                          <span>Muted</span>
                        </>
                      ) : p.isSpeaking ? (
                        <>
                          <Volume2 className="w-3 h-3 text-emerald-300" />
                          <span>Speaking</span>
                        </>
                      ) : (
                        <>
                          <Mic className="w-3 h-3 text-emerald-400" />
                          <span>Active</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <div
                      className="flex items-center gap-1 font-mono text-[10px]"
                      title={
                        p.isSpeaking
                          ? 'Speaking'
                          : p.isMuted
                            ? 'Microphone muted'
                            : 'Microphone active'
                      }
                    >
                      {p.isSpeaking ? (
                        <span className="flex items-center gap-1 text-emerald-400 animate-pulse">
                          <Volume2 className="w-3 h-3" />
                          <span>Speaking</span>
                        </span>
                      ) : p.isMuted ? (
                        <span className="flex items-center gap-1 text-slate-500">
                          <MicOff className="w-3 h-3 text-slate-500" />
                          <span>Muted</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <Mic className="w-3 h-3 text-emerald-400" />
                          <span>Active</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Right side: Typing status OR cursor position */}
                <div className="flex items-center gap-1">
                  {p.isTyping ? (
                    <span
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium animate-pulse"
                      style={{
                        backgroundColor: `${p.color.hex}22`,
                        color: p.color.hex,
                        border: `1px solid ${p.color.hex}44`,
                      }}
                      title={`${p.displayName} is typing...`}
                    >
                      <Edit3 className="w-2.5 h-2.5" />
                      <span>Typing...</span>
                    </span>
                  ) : p.cursor ? (
                    <span className="text-[10px] font-mono text-slate-500">
                      Ln {p.cursor.lineNumber}, Col {p.cursor.column}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}

        {/* Empty Participant Slots */}
        {Array.from({ length: emptySlots }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="p-2.5 rounded-xl border border-dashed border-slate-800/70 bg-slate-950/20 flex items-center gap-2.5 text-slate-600 text-xs"
          >
            <div className="w-7 h-7 rounded-lg border border-dashed border-slate-800 flex items-center justify-center text-slate-600">
              <User className="w-3.5 h-3.5" />
            </div>
            <span className="italic text-[11px]">Available Slot ({participants.length + i + 1})</span>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-slate-800/80 text-[11px] text-slate-500 text-center">
        Max capacity 5 participants enforced
      </div>
    </aside>
  );
};
