import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatPanel } from '../components/chat/ChatPanel';
import { ChatMessage, MAX_CHAT_MESSAGE_LENGTH } from '@synccode/shared';

// Mock scrollIntoView which is not implemented in jsdom
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('ChatPanel Component Tests', () => {
  it('renders empty chat state when no messages are present', () => {
    const handleSend = vi.fn().mockResolvedValue({ success: true });

    render(
      <ChatPanel
        messages={[]}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    expect(screen.getByText('Room Chat')).toBeInTheDocument();
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type a message/i)).toBeInTheDocument();
    expect(screen.getByText(`0 / ${MAX_CHAT_MESSAGE_LENGTH}`)).toBeInTheDocument();
  });

  it('renders user and system messages with sender colors and timestamps', () => {
    const handleSend = vi.fn().mockResolvedValue({ success: true });
    const messages: ChatMessage[] = [
      {
        messageId: 'sys-1',
        roomId: 'room-1',
        userId: 'system',
        displayName: 'System',
        colorHex: '#94A3B8',
        content: 'Alice joined the workspace',
        timestamp: Date.now() - 60000,
        isSystem: true,
      },
      {
        messageId: 'msg-1',
        roomId: 'room-1',
        userId: 'user-2',
        displayName: 'Bob',
        colorHex: '#10B981',
        content: 'Hello Alice, how are you?',
        timestamp: Date.now() - 30000,
        isSystem: false,
      },
      {
        messageId: 'msg-2',
        roomId: 'room-1',
        userId: 'user-1',
        displayName: 'Alice',
        colorHex: '#3B82F6',
        content: 'I am doing great!',
        timestamp: Date.now(),
        isSystem: false,
      },
    ];

    render(
      <ChatPanel
        messages={messages}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    expect(screen.getByText('Alice joined the workspace')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Hello Alice, how are you?')).toBeInTheDocument();
    expect(screen.getByText('Alice (You)')).toBeInTheDocument();
    expect(screen.getByText('I am doing great!')).toBeInTheDocument();
  });

  it('validates and submits message on click', async () => {
    const handleSend = vi.fn().mockResolvedValue({ success: true });

    render(
      <ChatPanel
        messages={[]}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    const input = screen.getByPlaceholderText(/Type a message/i);
    const sendButton = screen.getByRole('button', { name: /Send/i });

    // Initially disabled because input is empty
    expect(sendButton).toBeDisabled();

    // Type a message
    fireEvent.change(input, { target: { value: 'Awesome collaborative editor!' } });
    expect(sendButton).not.toBeDisabled();
    expect(screen.getByText(/29 \/ 1000/)).toBeInTheDocument();

    // Click send
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith('Awesome collaborative editor!');
      expect(input).toHaveValue('');
    });
  });

  it('submits on Enter key press', async () => {
    const handleSend = vi.fn().mockResolvedValue({ success: true });

    render(
      <ChatPanel
        messages={[]}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    const input = screen.getByPlaceholderText(/Type a message/i);
    fireEvent.change(input, { target: { value: 'Pressing enter to send' } });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    await waitFor(() => {
      expect(handleSend).toHaveBeenCalledWith('Pressing enter to send');
      expect(input).toHaveValue('');
    });
  });

  it('displays error message when sending fails or is rate limited', async () => {
    const handleSend = vi.fn().mockResolvedValue({
      success: false,
      error: 'You are sending messages too quickly. Please wait a few seconds.',
    });

    render(
      <ChatPanel
        messages={[]}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    const input = screen.getByPlaceholderText(/Type a message/i);
    const sendButton = screen.getByRole('button', { name: /Send/i });

    fireEvent.change(input, { target: { value: 'Spam message' } });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(
        screen.getByText(/You are sending messages too quickly/i)
      ).toBeInTheDocument();
    });
  });

  it('safely renders potentially malicious script content as text without XSS execution', () => {
    const handleSend = vi.fn().mockResolvedValue({ success: true });
    const maliciousPayload = '<script>alert("XSS")</script><img src="x" onerror="alert(1)"/>';

    const messages: ChatMessage[] = [
      {
        messageId: 'msg-xss',
        roomId: 'room-1',
        userId: 'user-hacker',
        displayName: 'Hacker',
        colorHex: '#EF4444',
        content: maliciousPayload,
        timestamp: Date.now(),
        isSystem: false,
      },
    ];

    const { container } = render(
      <ChatPanel
        messages={messages}
        currentUserId="user-1"
        onSendMessage={handleSend}
      />
    );

    // Verify script tags were NOT added as executable elements to the DOM
    const scriptElements = container.querySelectorAll('script');
    expect(scriptElements.length).toBe(0);

    // The text content should be displayed verbatim as safe text
    expect(screen.getByText(maliciousPayload)).toBeInTheDocument();
  });
});
