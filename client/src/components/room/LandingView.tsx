import React, { useState } from 'react';
import { CreateRoomRequest, JoinRoomRequest, RoomErrorPayload } from '@synccode/shared';
import { Lock, PlusCircle, LogIn, Code2, Users, AlertCircle, KeyRound, Sparkles } from 'lucide-react';

interface LandingViewProps {
  onCreateRoom: (request: CreateRoomRequest) => void;
  onJoinRoom: (request: JoinRoomRequest) => void;
  isLoading: boolean;
  error: RoomErrorPayload | null;
  onClearError: () => void;
}

export const LandingView: React.FC<LandingViewProps> = ({
  onCreateRoom,
  onJoinRoom,
  isLoading,
  error,
  onClearError,
}) => {
  const [tab, setTab] = useState<'create' | 'join'>('create');

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [password, setPassword] = useState('');
  const [enablePassword, setEnablePassword] = useState(false);
  const [language, setLanguage] = useState('javascript');

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    onClearError();
    onCreateRoom({
      displayName: displayName.trim(),
      password: enablePassword && password.trim() ? password.trim() : undefined,
      language,
    });
  };

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !roomId.trim()) return;
    onClearError();
    onJoinRoom({
      roomId: roomId.trim().toLowerCase(),
      displayName: displayName.trim(),
      password: password.trim() ? password.trim() : undefined,
    });
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 md:p-8 max-w-xl mx-auto w-full">
      {/* Hero Header */}
      <div className="text-center mb-8 space-y-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/80 border border-indigo-800 text-indigo-400 text-xs font-medium mb-1">
          <Sparkles className="w-3.5 h-3.5 text-indigo-400" /> Real-time Pair & Group Programming (Max 5 Users)
        </div>
        <h2 className="text-3xl font-extrabold text-white tracking-tight sm:text-4xl">
          Code Together, In Real Time
        </h2>
        <p className="text-sm text-slate-400 max-w-md mx-auto">
          Create a private workspace or join with a Room ID to collaborate seamlessly with live presence and synchronized code.
        </p>
      </div>

      {/* Main Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl backdrop-blur-sm w-full overflow-hidden">
        {/* Tab Switcher */}
        <div className="grid grid-cols-2 border-b border-slate-800 text-sm font-medium">
          <button
            onClick={() => {
              setTab('create');
              onClearError();
            }}
            className={`py-3.5 px-4 flex items-center justify-center gap-2 transition-all ${
              tab === 'create'
                ? 'bg-slate-800/80 text-white border-b-2 border-indigo-500 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
            }`}
          >
            <PlusCircle className="w-4 h-4 text-indigo-400" />
            Create Room
          </button>
          <button
            onClick={() => {
              setTab('join');
              onClearError();
            }}
            className={`py-3.5 px-4 flex items-center justify-center gap-2 transition-all ${
              tab === 'join'
                ? 'bg-slate-800/80 text-white border-b-2 border-indigo-500 font-semibold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/30'
            }`}
          >
            <LogIn className="w-4 h-4 text-indigo-400" />
            Join Room
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="m-5 mb-0 p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/80 flex items-start gap-3 text-rose-300 text-sm animate-fadeIn">
            <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">{error.code === 'ROOM_FULL' ? 'Room Is Full' : 'Join Error'}</p>
              <p className="text-xs text-rose-300 mt-0.5">{error.message}</p>
            </div>
          </div>
        )}

        {/* Tab 1: Create Room Form */}
        {tab === 'create' && (
          <form onSubmit={handleCreateSubmit} className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Your Display Name <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  placeholder="e.g., Alice"
                  maxLength={32}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Starter Language
              </label>
              <div className="relative">
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition appearance-none cursor-pointer"
                >
                  <option value="javascript">JavaScript (Node.js)</option>
                  <option value="python">Python 3</option>
                  <option value="cpp">C++ (GCC)</option>
                  <option value="java">Java 17</option>
                </select>
                <Code2 className="w-4 h-4 text-slate-400 absolute right-3.5 top-3 pointer-events-none" />
              </div>
            </div>

            <div className="pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={enablePassword}
                  onChange={(e) => setEnablePassword(e.target.checked)}
                  className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-indigo-500 h-4 w-4"
                />
                <span className="flex items-center gap-1.5 font-medium">
                  <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                  Protect room with password (optional)
                </span>
              </label>

              {enablePassword && (
                <div className="mt-2.5">
                  <input
                    type="password"
                    placeholder="Enter private room password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                  />
                </div>
              )}
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading || !displayName.trim()}
                className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <span>Generating Secure Room...</span>
                ) : (
                  <>
                    <PlusCircle className="w-4 h-4" />
                    <span>Create Workspace</span>
                  </>
                )}
              </button>
            </div>

            <p className="text-center text-[11px] text-slate-500 flex items-center justify-center gap-1.5 pt-1">
              <Users className="w-3.5 h-3.5" /> Room limited to maximum 5 concurrent collaborators
            </p>
          </form>
        )}

        {/* Tab 2: Join Room Form */}
        {tab === 'join' && (
          <form onSubmit={handleJoinSubmit} className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Room ID <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g., sync-7f2a-b9c1"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm font-mono text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Your Display Name <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                placeholder="e.g., Bob"
                maxLength={32}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                Room Password (if protected)
              </label>
              <div className="relative">
                <input
                  type="password"
                  placeholder="Leave blank if public"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition"
                />
                <Lock className="w-4 h-4 text-slate-500 absolute right-3.5 top-3 pointer-events-none" />
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading || !displayName.trim() || !roomId.trim()}
                className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <span>Connecting to Room...</span>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" />
                    <span>Join Workspace</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
