import React, { useState, useRef, useEffect } from 'react';
import { ChatMessage, MAX_CHAT_MESSAGE_LENGTH } from '@synccode/shared';
import { MessageSquare, Send, X, AlertCircle } from 'lucide-react';

interface ChatPanelProps {
  messages: ChatMessage[];
  currentUserId: string;
  onSendMessage: (content: string) => Promise<{ success: boolean; error?: string }>;
  onClose?: () => void;
}

function formatTime(timestamp: number): string {
  try {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export const MAX_RENDERED_CHAT_MESSAGES = 200;

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  currentUserId,
  onSendMessage,
  onClose,
}) => {
  const [inputText, setInputText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isCapped = messages.length > MAX_RENDERED_CHAT_MESSAGES;
  const displayMessages = isCapped
    ? messages.slice(-MAX_RENDERED_CHAT_MESSAGES)
    : messages;

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (typeof messagesEndRef.current?.scrollIntoView === 'function') {
      messagesEndRef.current.scrollIntoView({ behavior });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const trimmed = inputText.trim();
    if (!trimmed) {
      setErrorMessage('Message cannot be empty');
      return;
    }

    if (trimmed.length > MAX_CHAT_MESSAGE_LENGTH) {
      setErrorMessage(`Message exceeds limit (${MAX_CHAT_MESSAGE_LENGTH} characters)`);
      return;
    }

    setErrorMessage(null);
    setIsSending(true);

    try {
      const res = await onSendMessage(trimmed);
      if (res.success) {
        setInputText('');
      } else {
        setErrorMessage(res.error || 'Failed to send message');
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Network error');
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <aside
      className="w-80 h-full bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 overflow-hidden text-slate-200"
      aria-label="Room Chat"
    >
      {/* Chat Header */}
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/90 backdrop-blur shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-indigo-400" />
          <h2 className="font-semibold text-sm text-white">Room Chat</h2>
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {messages.length}
          </span>
        </div>

        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Close Chat"
            aria-label="Close Chat"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Message Feed */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 font-sans text-xs">
        {isCapped && (
          <div className="text-center py-1 text-[10px] text-slate-500 bg-slate-800/40 rounded">
            Showing latest {MAX_RENDERED_CHAT_MESSAGES} messages
          </div>
        )}
        {displayMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-500">
            <MessageSquare className="w-8 h-8 mb-2 opacity-40 text-slate-400" />
            <p className="font-medium text-slate-400 text-xs">No messages yet</p>
            <p className="text-[11px] text-slate-500 mt-1">
              Start the conversation with your room members.
            </p>
          </div>
        ) : (
          displayMessages.map((msg) => {
            if (msg.isSystem) {
              return (
                <div key={msg.messageId} className="flex justify-center my-2">
                  <div className="max-w-[90%] px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 text-slate-400 text-[11px] italic text-center flex items-center gap-1.5 shadow-sm">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-400 inline-block shrink-0" />
                    <span>{msg.content}</span>
                    <span className="text-[10px] text-slate-500 not-italic ml-1">
                      {formatTime(msg.timestamp)}
                    </span>
                  </div>
                </div>
              );
            }

            const isSelf = msg.userId === currentUserId;

            return (
              <div
                key={msg.messageId}
                className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
              >
                {/* Sender Identity & Timestamp */}
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span
                    className="font-medium text-[11px]"
                    style={{ color: msg.colorHex }}
                  >
                    {isSelf ? `${msg.displayName} (You)` : msg.displayName}
                  </span>
                  <span className="text-[10px] text-slate-500">
                    {formatTime(msg.timestamp)}
                  </span>
                </div>

                {/* Message Bubble (Safe XSS Rendering) */}
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl text-xs break-words whitespace-pre-wrap shadow-sm select-text ${
                    isSelf
                      ? 'bg-indigo-600 text-white rounded-tr-none'
                      : 'bg-slate-800 text-slate-200 border border-slate-700/70 rounded-tl-none'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="px-3 py-1.5 bg-rose-950/80 border-t border-rose-900/80 flex items-center gap-2 text-rose-300 text-[11px] shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
          <span className="truncate flex-1">{errorMessage}</span>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-rose-400 hover:text-white"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Input Form */}
      <form
        onSubmit={handleSend}
        className="p-3 border-t border-slate-800 bg-slate-900/90 shrink-0 flex flex-col gap-1.5"
      >
        <div className="relative">
          <textarea
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              if (errorMessage) setErrorMessage(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send)"
            rows={2}
            maxLength={MAX_CHAT_MESSAGE_LENGTH + 20}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 resize-none"
            aria-label="Chat message input"
          />
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-500 px-0.5">
          <span
            className={
              inputText.length > MAX_CHAT_MESSAGE_LENGTH
                ? 'text-rose-400 font-semibold'
                : 'text-slate-500'
            }
          >
            {inputText.length} / {MAX_CHAT_MESSAGE_LENGTH}
          </span>

          <button
            type="submit"
            disabled={!inputText.trim() || inputText.length > MAX_CHAT_MESSAGE_LENGTH || isSending}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white font-medium text-xs transition"
          >
            <span>Send</span>
            <Send className="w-3 h-3" />
          </button>
        </div>
      </form>
    </aside>
  );
};
