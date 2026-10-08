import { describe, it, expect } from 'vitest';
import { escapeCssString, sanitizeCssColor } from '../collaboration/SyncManager';

describe('CSS Sanitization in SyncManager', () => {
  it('escapes double quotes to prevent string breakout', () => {
    const malicious = 'Alice" style="color:red';
    const escaped = escapeCssString(malicious);
    expect(escaped).toBe('Alice\\" style=\\"color:red');
    expect(escaped).not.toContain('Alice"');
  });

  it('escapes backslashes so they cannot neutralize closing quotes', () => {
    const malicious = 'Bob\\';
    const escaped = escapeCssString(malicious);
    expect(escaped).toBe('Bob\\\\');
    // In CSS string `content: "${safeName}"`, this becomes `content: "Bob\\";` which is safe
  });

  it('replaces newlines and carriage returns with spaces to prevent multiline CSS syntax breakage', () => {
    const malicious = 'Charlie\nline2\rline3\r\nline4';
    const escaped = escapeCssString(malicious);
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\r');
    expect(escaped).toBe('Charlie line2 line3  line4');
  });

  it('handles combinations of backslashes, quotes, and newlines', () => {
    const malicious = 'Dave\\"}\nb{color:red}\n/*';
    const escaped = escapeCssString(malicious);
    expect(escaped).not.toContain('\n');
    expect(escaped).toContain('\\\\');
    expect(escaped).toContain('\\"');
    // Verify when placed in content: "${escaped}", it cannot break out of the string literal
    const cssRule = `content: "${escaped}";`;
    expect(cssRule).toBe('content: "Dave\\\\\\"} b{color:red} /*";');
  });

  it('strips ASCII control characters', () => {
    const malicious = 'Eve\x00\x07\x1b\x7fAttacker';
    const escaped = escapeCssString(malicious);
    expect(escaped).toBe('EveAttacker');
  });

  it('clamps length to 32 characters', () => {
    const longName = 'A'.repeat(100);
    const escaped = escapeCssString(longName);
    expect(escaped.length).toBe(32);
  });

  it('sanitizes CSS color strings rejecting CSS injection payloads', () => {
    expect(sanitizeCssColor('#3b82f6')).toBe('#3b82f6');
    expect(sanitizeCssColor('#abc')).toBe('#abc');
    expect(sanitizeCssColor('#12345678')).toBe('#12345678');
    
    // Malicious or invalid values fall back to safe blue
    expect(sanitizeCssColor('red; background: black')).toBe('#3b82f6');
    expect(sanitizeCssColor('url(evil.com)')).toBe('#3b82f6');
    expect(sanitizeCssColor('javascript:alert(1)')).toBe('#3b82f6');
    expect(sanitizeCssColor('')).toBe('#3b82f6');
  });
});
