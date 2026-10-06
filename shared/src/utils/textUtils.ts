import { MonacoRange } from '../types/operations';

/**
 * Converts a 1-indexed (line, column) Monaco coordinate to a 0-indexed character offset.
 */
export function positionToOffset(text: string, lineNumber: number, column: number): number {
  let currentLine = 1;
  let offset = 0;
  const len = text.length;

  while (offset < len && currentLine < lineNumber) {
    if (text[offset] === '\n') {
      currentLine++;
    }
    offset++;
  }

  return offset + Math.max(0, column - 1);
}

/**
 * Converts a 0-indexed character offset back into a 1-indexed (line, column) Monaco coordinate.
 */
export function offsetToPosition(text: string, offset: number): { lineNumber: number; column: number } {
  let lineNumber = 1;
  let column = 1;
  const clampedOffset = Math.max(0, Math.min(offset, text.length));

  for (let i = 0; i < clampedOffset; i++) {
    if (text[i] === '\n') {
      lineNumber++;
      column = 1;
    } else {
      column++;
    }
  }

  return { lineNumber, column };
}

/**
 * Extracts deleted text within the given Monaco range from currentText.
 */
export function extractDeletedText(currentText: string, range: MonacoRange): string {
  const startOffset = positionToOffset(currentText, range.startLineNumber, range.startColumn);
  const endOffset = positionToOffset(currentText, range.endLineNumber, range.endColumn);
  return currentText.slice(startOffset, endOffset);
}

/**
 * Pure function applying a delta edit operation to a raw text buffer.
 */
export function applyOperationToText(
  currentText: string,
  range: MonacoRange,
  insertedText: string
): string {
  const startOffset = positionToOffset(currentText, range.startLineNumber, range.startColumn);
  const endOffset = positionToOffset(currentText, range.endLineNumber, range.endColumn);
  return currentText.slice(0, startOffset) + insertedText + currentText.slice(endOffset);
}

/**
 * Determines whether two ranges overlap.
 */
export function rangesOverlap(a: MonacoRange, b: MonacoRange): boolean {
  // If one range ends strictly before the other begins:
  const aBeforeB =
    a.endLineNumber < b.startLineNumber ||
    (a.endLineNumber === b.startLineNumber && a.endColumn <= b.startColumn);

  const bBeforeA =
    b.endLineNumber < a.startLineNumber ||
    (b.endLineNumber === a.startLineNumber && b.endColumn <= a.startColumn);

  return !(aBeforeB || bBeforeA);
}

/**
 * Transforms / rebases candidate range against an earlier operation that has already been applied.
 * Returns null if ranges overlap conflictingly.
 */
export function transformRange(
  candidate: MonacoRange,
  earlierRange: MonacoRange,
  earlierInsertedText: string,
  earlierDeletedLength: number
): MonacoRange | null {
  if (rangesOverlap(candidate, earlierRange)) {
    return null; // Overlapping collision requires snapshot sync
  }

  // If candidate is before earlier range, its coordinates are unaffected
  const candidateIsBefore =
    candidate.endLineNumber < earlierRange.startLineNumber ||
    (candidate.endLineNumber === earlierRange.startLineNumber &&
      candidate.endColumn <= earlierRange.startColumn);

  if (candidateIsBefore) {
    return { ...candidate };
  }

  // Calculate lines added/removed by earlier edit
  const earlierLinesAdded = earlierInsertedText.split('\n').length - 1;
  const earlierLinesDeleted = earlierRange.endLineNumber - earlierRange.startLineNumber;
  const lineDelta = earlierLinesAdded - earlierLinesDeleted;

  // Characters change on the transition line
  const charDelta =
    earlierInsertedText.length - earlierDeletedLength;

  // If candidate is strictly below the earlier edit lines
  if (candidate.startLineNumber > earlierRange.endLineNumber) {
    return {
      startLineNumber: candidate.startLineNumber + lineDelta,
      startColumn: candidate.startColumn,
      endLineNumber: candidate.endLineNumber + lineDelta,
      endColumn: candidate.endColumn,
    };
  }

  // If candidate is on the same line after the earlier edit on that line
  if (candidate.startLineNumber === earlierRange.endLineNumber) {
    const isSingleLineInsert = earlierLinesAdded === 0;
    return {
      startLineNumber: candidate.startLineNumber + lineDelta,
      startColumn: isSingleLineInsert ? candidate.startColumn + charDelta : candidate.startColumn,
      endLineNumber: candidate.endLineNumber + lineDelta,
      endColumn:
        candidate.endLineNumber === earlierRange.endLineNumber && isSingleLineInsert
          ? candidate.endColumn + charDelta
          : candidate.endColumn,
    };
  }

  return { ...candidate };
}
