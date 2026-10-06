import React, { useState } from 'react';
import { RoomState, Participant } from '@synccode/shared';
import { RoomHeader } from './RoomHeader';
import { ParticipantList } from './ParticipantList';
import { MonacoEditorPane } from '../editor/MonacoEditorPane';
import { SyncStatus } from '../../collaboration/SyncManager';
import { Code2, CheckCircle2, RefreshCw } from 'lucide-react';

interface WorkspaceViewProps {
  roomState: RoomState;
  currentParticipant: Participant;
  onLeaveRoom: () => void;
}

export const WorkspaceView: React.FC<WorkspaceViewProps> = ({
  roomState,
  currentParticipant,
  onLeaveRoom,
}) => {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    revision: roomState.document.currentRevision,
    pendingCount: 0,
    isSynced: true,
  });

  return (
    <div className="flex-1 flex flex-col h-screen overflow-hidden bg-slate-950">
      {/* Top Header */}
      <RoomHeader
        roomId={roomState.roomId}
        language={roomState.document.language}
        participantCount={roomState.participants.length}
        maxParticipants={roomState.maxParticipants}
        isLocked={roomState.isLocked}
        onLeaveRoom={onLeaveRoom}
      />

      {/* Main Split Layout */}
      <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
        {/* Left: Participant Roster */}
        <ParticipantList
          participants={roomState.participants}
          currentUserId={currentParticipant.userId}
          maxParticipants={roomState.maxParticipants}
        />

        {/* Center: Monaco Collaborative Editor */}
        <main className="flex-1 flex flex-col bg-slate-950 overflow-hidden relative">
          {/* Editor Tab Bar */}
          <div className="border-b border-slate-800 bg-slate-900/60 px-4 py-2 flex items-center justify-between text-xs shrink-0">
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded bg-slate-800 border border-slate-700/80 font-mono text-slate-200 flex items-center gap-1.5 shadow-sm">
                <Code2 className="w-3.5 h-3.5 text-indigo-400" />
                {roomState.document.filename}
              </span>
            </div>

            <div className="flex items-center gap-3 font-mono text-[11px]">
              {syncStatus.isSynced ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Synchronized (Rev {syncStatus.revision})
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-amber-400">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Syncing ({syncStatus.pendingCount} pending)
                </span>
              )}
            </div>
          </div>

          {/* Monaco Editor Pane */}
          <div className="flex-1 relative overflow-hidden">
            <MonacoEditorPane
              roomId={roomState.roomId}
              userId={currentParticipant.userId}
              initialContent={roomState.document.content}
              language={roomState.document.language}
              initialRevision={roomState.document.currentRevision}
              isReadOnly={roomState.isLocked && currentParticipant.role !== 'HOST'}
              onStatusChange={setSyncStatus}
            />
          </div>

          {/* Bottom Status Bar */}
          <footer className="border-t border-slate-800 bg-slate-900/80 px-4 py-1.5 flex items-center justify-between text-[11px] text-slate-400 font-mono shrink-0">
            <div className="flex items-center gap-4">
              <span>Revision: {syncStatus.revision}</span>
              <span>UTF-8</span>
              <span className="capitalize">{roomState.document.language}</span>
              <span>Spaces: 2</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-300">Monaco Engine Active</span>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};
