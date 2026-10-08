import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LandingView } from '../components/room/LandingView';

describe('Language & Template Selection Tests', () => {
  it('allows selecting different programming languages in Create Room form', () => {
    const handleCreate = vi.fn();

    render(
      <LandingView
        onCreateRoom={handleCreate}
        onJoinRoom={vi.fn()}
        isLoading={false}
        error={null}
        onClearError={vi.fn()}
      />
    );

    // Enter name
    const nameInput = screen.getByPlaceholderText(/e.g., Alice/i);
    fireEvent.change(nameInput, { target: { value: 'Developer' } });

    // Select Java language
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'java' } });
    expect((select as HTMLSelectElement).value).toBe('java');

    // Submit form
    const createButton = screen.getByText('Create Workspace');
    fireEvent.click(createButton);

    expect(handleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Developer',
        language: 'java',
      })
    );
  });

  it('supports Python, C++, and JavaScript options', () => {
    const handleCreate = vi.fn();

    render(
      <LandingView
        onCreateRoom={handleCreate}
        onJoinRoom={vi.fn()}
        isLoading={false}
        error={null}
        onClearError={vi.fn()}
      />
    );

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);

    expect(options).toContain('javascript');
    expect(options).toContain('python');
    expect(options).toContain('cpp');
    expect(options).toContain('java');
  });
});
