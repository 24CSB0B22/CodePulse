/**
 * Pre-allocated deterministic color palette for up to 5 concurrent participants in a room.
 * Each color provides strong contrast in dark mode without overwhelming Monaco's syntax highlighting.
 */
export interface ParticipantColor {
  name: string;
  hex: string;
  cursorHex: string;
  highlightRgba: string; // Fading attribution background highlight (15% opacity)
}

export const PARTICIPANT_PALETTE: readonly ParticipantColor[] = [
  {
    name: 'Emerald',
    hex: '#10B981',
    cursorHex: '#10B981',
    highlightRgba: 'rgba(16, 185, 129, 0.18)',
  },
  {
    name: 'Amber',
    hex: '#F59E0B',
    cursorHex: '#F59E0B',
    highlightRgba: 'rgba(245, 158, 11, 0.18)',
  },
  {
    name: 'Indigo',
    hex: '#6366F1',
    cursorHex: '#6366F1',
    highlightRgba: 'rgba(99, 102, 241, 0.18)',
  },
  {
    name: 'Rose',
    hex: '#F43F5E',
    cursorHex: '#F43F5E',
    highlightRgba: 'rgba(244, 63, 94, 0.18)',
  },
  {
    name: 'Cyan',
    hex: '#06B6D4',
    cursorHex: '#06B6D4',
    highlightRgba: 'rgba(6, 182, 212, 0.18)',
  },
] as const;

/**
 * Returns a deterministic color based on participant index in the room (0..4).
 */
export function getParticipantColor(index: number): ParticipantColor {
  return PARTICIPANT_PALETTE[index % PARTICIPANT_PALETTE.length];
}
