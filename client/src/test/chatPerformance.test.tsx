import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatPanel, MAX_RENDERED_CHAT_MESSAGES } from '../components/chat/ChatPanel';
import { ChatMessage } from '@synccode/shared';

window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('Chat Rendering Performance & Bounded Memory (Item 9)', () => {
  it('bounds rendering to MAX_RENDERED_CHAT_MESSAGES (200) to prevent DOM explosion', () => {
    const totalMessages = 300;
    const messages: ChatMessage[] = [];

    for (let i = 0; i < totalMessages; i++) {
      messages.push({
        messageId: `msg-${i}`,
        roomId: 'room-test',
        userId: `user-${i % 5}`,
        displayName: `User ${i % 5}`,
        colorHex: '#3b82f6',
        content: `Message sequence index ${i}`,
        timestamp: Date.now() + i * 1000,
        isSystem: false,
      });
    }

    render(
      <ChatPanel
        messages={messages}
        currentUserId="user-0"
        onSendMessage={vi.fn().mockResolvedValue({ success: true })}
      />
    );

    // Verify indicator banner is shown
    expect(screen.getByText(`Showing latest ${MAX_RENDERED_CHAT_MESSAGES} messages`)).toBeInTheDocument();

    // Verify oldest messages (e.g. index 0, 50, 99) are NOT in the DOM
    expect(screen.queryByText('Message sequence index 0')).not.toBeInTheDocument();
    expect(screen.queryByText('Message sequence index 50')).not.toBeInTheDocument();
    expect(screen.queryByText('Message sequence index 99')).not.toBeInTheDocument();

    // Verify latest messages (e.g. index 100, 250, 299) ARE in the DOM
    expect(screen.getByText('Message sequence index 100')).toBeInTheDocument();
    expect(screen.getByText('Message sequence index 250')).toBeInTheDocument();
    expect(screen.getByText('Message sequence index 299')).toBeInTheDocument();
  });
});
