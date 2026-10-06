import React from 'react';
import { Participant } from '@synccode/shared';
import { Crown, User, Wifi, WifiOff } from 'lucide-react';

interface ParticipantListProps {
  participants: Participant[];
  currentUserId: string;
  maxParticipants: number;
}

export const ParticipantList: React.FC<ParticipantListProps> = ({
  participants,
  currentUserId,
  maxParticipants,
}) => {
  const emptySlots = Math.max(0, maxParticipants - participants.length);

  return (
    <aside className="w-full sm:w-64 border-r border-slate-800 bg-slate-900/40 p-4 flex flex-col shrink-0">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-800/80">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Collaborators ({participants.length}/{maxParticipants})
        </h3>
      </div>

      <div className="space-y-2 flex-1 overflow-y-auto">
        {participants.map((p) => {
          const isCurrentUser = p.userId === currentUserId;
          const isConnected = p.connectionState === 'CONNECTED';

          return (
            <div
              key={p.userId}
              className={`p-2.5 rounded-xl border flex items-center justify-between gap-3 transition ${
                isCurrentUser
                  ? 'bg-slate-800/80 border-slate-700/80 shadow-sm'
                  : 'bg-slate-950/60 border-slate-800/70 hover:bg-slate-900/60'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {/* Colored Avatar */}
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs text-white shadow shrink-0"
                  style={{ backgroundColor: p.color.hex }}
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
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: isConnected ? '#10B981' : '#F59E0B' }}
                    />
                    <span>{p.role === 'HOST' ? 'Host' : 'Member'}</span>
                  </div>
                </div>
              </div>

              {/* Status Icons */}
              <div className="flex items-center gap-1 shrink-0">
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
                  <span title="Reconnecting">
                    <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                  </span>
                )}
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
