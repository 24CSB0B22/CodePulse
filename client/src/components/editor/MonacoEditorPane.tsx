import React, { useRef, useEffect } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { getSocket } from '../../services/socket';
import { SyncManager, SyncStatus } from '../../collaboration/SyncManager';

interface MonacoEditorPaneProps {
  roomId: string;
  userId: string;
  initialContent: string;
  language: string;
  initialRevision: number;
  isReadOnly?: boolean;
  onStatusChange?: (status: SyncStatus) => void;
}

export const MonacoEditorPane: React.FC<MonacoEditorPaneProps> = ({
  roomId,
  userId,
  initialContent,
  language,
  initialRevision,
  isReadOnly = false,
  onStatusChange,
}) => {
  const syncManagerRef = useRef<SyncManager | null>(null);

  const handleEditorMount: OnMount = (editorInstance) => {
    const socket = getSocket();

    // Instantiate SyncManager attached to this Monaco editor
    syncManagerRef.current = new SyncManager(
      editorInstance,
      socket,
      roomId,
      userId,
      initialRevision,
      onStatusChange
    );

    if (typeof window !== 'undefined') {
      (window as any).__monacoEditor = editorInstance;
      (window as any).__syncManager = syncManagerRef.current;
    }
  };

  useEffect(() => {
    return () => {
      if (syncManagerRef.current) {
        syncManagerRef.current.destroy();
        syncManagerRef.current = null;
      }
      if (typeof window !== 'undefined') {
        delete (window as any).__monacoEditor;
        delete (window as any).__syncManager;
      }
    };
  }, []);

  useEffect(() => {
    if (syncManagerRef.current) {
      syncManagerRef.current.syncToDocument(initialContent, initialRevision);
    }
  }, [initialContent, initialRevision]);

  // Map internal language identifiers to Monaco language IDs
  const monacoLanguage =
    language === 'cpp'
      ? 'cpp'
      : language === 'python'
        ? 'python'
        : language === 'java'
          ? 'java'
          : 'javascript';

  return (
    <div className="w-full h-full flex-1 relative bg-slate-950 overflow-hidden">
      <Editor
        height="100%"
        theme="vs-dark"
        language={monacoLanguage}
        defaultValue={initialContent}
        onMount={handleEditorMount}
        options={{
          readOnly: isReadOnly,
          minimap: { enabled: true, side: 'right' },
          fontSize: 14,
          fontFamily: "'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
          fontLigatures: true,
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          cursorSmoothCaretAnimation: 'on',
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'on',
          renderWhitespace: 'selection',
        }}
        loading={
          <div className="flex items-center justify-center h-full text-slate-400 text-xs font-mono">
            Loading Monaco Collaborative Editor...
          </div>
        }
      />
    </div>
  );
};
