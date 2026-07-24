/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';
import {
  applyTextEdits,
  countLines,
  countAddedLines,
  countAddedRemoved,
  accumulateEditLoc,
  EditLoc,
  EditLocIndex,
  EditOpLike,
  EditTimelineLike,
  FileBaselineLike,
} from './edit-loc-diff';

function uriOp(uri: string, reqId: string, epoch: number, edits: EditOpLike['edits']): EditOpLike {
  return { type: 'textEdit', requestId: reqId, uri: { external: uri }, epoch, edits };
}

function wholeFile(text: string): EditOpLike['edits'] {
  // A whole-file replacement spanning from the start to a far-past-EOF position (apply_patch style).
  return [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1_000_000, endColumn: 1 }, text }];
}

function baseline(uri: string, reqId: string, content: string): [string, FileBaselineLike] {
  return [`${uri}::${reqId}`, { uri: { external: uri }, requestId: reqId, content }];
}

function newIndex(): EditLocIndex {
  return new Map<string, Map<string, EditLoc>>();
}

function addedFor(index: EditLocIndex, reqId: string, uri: string): number | undefined {
  return index.get(reqId)?.get(uri)?.added;
}

function removedFor(index: EditLocIndex, reqId: string, uri: string): number | undefined {
  return index.get(reqId)?.get(uri)?.removed;
}

function totalFor(index: EditLocIndex, uri: string): number {
  let sum = 0;
  for (const fileMap of index.values()) {
    sum += fileMap.get(uri)?.added ?? 0;
  }
  return sum;
}

function totalRemovedFor(index: EditLocIndex, uri: string): number {
  let sum = 0;
  for (const fileMap of index.values()) {
    sum += fileMap.get(uri)?.removed ?? 0;
  }
  return sum;
}

describe('countLines', () => {
  it('returns 0 for empty string', () => {
    expect(countLines('')).toBe(0);
  });

  it('counts a single line without a trailing newline', () => {
    expect(countLines('a')).toBe(1);
  });

  it('counts newline-delimited lines', () => {
    expect(countLines('a\nb\nc')).toBe(3);
  });

  it('does not double-count a trailing newline', () => {
    expect(countLines('a\nb\nc\n')).toBe(3);
  });
});

describe('applyTextEdits', () => {
  it('returns content unchanged when there are no edits', () => {
    expect(applyTextEdits('hello', [])).toBe('hello');
    expect(applyTextEdits('hello', undefined)).toBe('hello');
  });

  it('replaces text within a single line', () => {
    const out = applyTextEdits('line1\nline2\nline3', [
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'LINE1' },
    ]);
    expect(out).toBe('LINE1\nline2\nline3');
  });

  it('replaces a multi-line span', () => {
    const out = applyTextEdits('a\nb\nc\nd', [
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 2 }, text: 'X' },
    ]);
    expect(out).toBe('a\nX\nd');
  });

  it('inserts at a zero-width range', () => {
    const out = applyTextEdits('ac', [
      { range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: 'b' },
    ]);
    expect(out).toBe('abc');
  });

  it('replaces the whole file with an over-extended range', () => {
    const out = applyTextEdits('old1\nold2', wholeFile('new1\nnew2\nnew3'));
    expect(out).toBe('new1\nnew2\nnew3');
  });

  it('applies multiple edits in one op independent of their order', () => {
    const edits = [
      { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 }, text: 'C' },
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'A' },
    ];
    expect(applyTextEdits('a\nb\nc', edits)).toBe('A\nb\nC');
  });

  it('appends edits that have no range', () => {
    const out = applyTextEdits('abc', [{ text: 'def' }]);
    expect(out).toBe('abcdef');
  });

  it('clamps out-of-bounds ranges to the content length', () => {
    const out = applyTextEdits('abc', [
      { range: { startLineNumber: 5, startColumn: 99, endLineNumber: 9, endColumn: 99 }, text: 'X' },
    ]);
    expect(out).toBe('abcX');
  });

  it('deletes a line when the replacement text is empty (apply_patch removal)', () => {
    const out = applyTextEdits('a\nb\nc\nd', [
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '' },
    ]);
    expect(out).toBe('a\nc\nd');
  });

  it('applies a mix of ranged and range-less edits in one op', () => {
    const out = applyTextEdits('a\nb\nc', [
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'A' },
      { text: '\nappended' },
    ]);
    expect(out).toBe('A\nb\nc\nappended');
  });
});

describe('countAddedLines', () => {
  it('returns 0 for identical content', () => {
    expect(countAddedLines('a\nb\nc', 'a\nb\nc')).toBe(0);
  });

  it('counts every line when the previous content is empty', () => {
    expect(countAddedLines('', 'a\nb\nc')).toBe(3);
  });

  it('counts appended lines', () => {
    expect(countAddedLines('a\nb', 'a\nb\nc\nd')).toBe(2);
  });

  it('counts only the changed lines of a whole-file rewrite', () => {
    const prev = 'a\nb\nc\nd\ne';
    const next = 'a\nb\nCHANGED\nd\ne';
    expect(countAddedLines(prev, next)).toBe(1);
  });

  it('treats lines as a multiset when there are duplicates', () => {
    expect(countAddedLines('a\na', 'a\na\na')).toBe(1);
  });

  it('returns 0 for reordered but otherwise identical lines', () => {
    expect(countAddedLines('a\nb\nc', 'c\nb\na')).toBe(0);
  });

  it('counts a replaced line once', () => {
    expect(countAddedLines('old', 'new')).toBe(1);
  });

  it('does not credit deleted lines — a remove-and-add nets the single new line', () => {
    // 'c' removed, 'f' appended: only 'f' is newly produced.
    expect(countAddedLines('a\nb\nc\nd\ne', 'a\nb\nd\ne\nf')).toBe(1);
  });

  it('credits no new lines when a file is fully emptied', () => {
    // Emptying a file produces no new content, and '' has zero logical lines.
    expect(countAddedLines('a\nb\nc', '')).toBe(0);
  });
});

describe('countAddedRemoved', () => {
  it('reports zero added and zero removed for identical content', () => {
    expect(countAddedRemoved('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
  });

  it('reports added lines and zero removed for a pure append', () => {
    expect(countAddedRemoved('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, removed: 0 });
  });

  it('reports removed lines and zero added for a pure deletion', () => {
    expect(countAddedRemoved('a\nb\nc\nd', 'a\nb')).toEqual({ added: 0, removed: 2 });
  });

  it('reports both added and removed for a replacement', () => {
    // 'c' removed, 'f' added.
    expect(countAddedRemoved('a\nb\nc\nd\ne', 'a\nb\nd\ne\nf')).toEqual({ added: 1, removed: 1 });
  });

  it('reports a whole-file rewrite as one changed line each way', () => {
    const prev = 'a\nb\nc\nd\ne';
    const next = 'a\nb\nCHANGED\nd\ne';
    expect(countAddedRemoved(prev, next)).toEqual({ added: 1, removed: 1 });
  });

  it('reports nothing for reordered but otherwise identical lines', () => {
    expect(countAddedRemoved('a\nb\nc', 'c\nb\na')).toEqual({ added: 0, removed: 0 });
  });

  it('treats lines as a multiset with duplicates', () => {
    expect(countAddedRemoved('a\na', 'a\na\na')).toEqual({ added: 1, removed: 0 });
  });

  it('removes a single duplicate when the count drops', () => {
    expect(countAddedRemoved('a\na\na', 'a\na')).toEqual({ added: 0, removed: 1 });
  });

  it('reports zero removed for an empty prev (empty text has no logical lines)', () => {
    // '' has zero logical lines, so a brand-new file adds its lines and removes nothing.
    expect(countAddedRemoved('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });

  it('reports nothing when both sides are empty', () => {
    expect(countAddedRemoved('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('reports zero added and N removed when a file is fully emptied', () => {
    // '' has no logical lines, so nothing is added and all of prev's lines are removed.
    expect(countAddedRemoved('a\nb\nc', '')).toEqual({ added: 0, removed: 3 });
  });

  it('keeps added − removed equal to the change in line count for every example', () => {
    const cases: [string, string][] = [
      ['a\nb\nc', 'a\nb\nc'],
      ['a\nb', 'a\nb\nc\nd'],
      ['a\nb\nc\nd', 'a\nb'],
      ['a\nb\nc\nd\ne', 'a\nb\nd\ne\nf'],
      ['', 'x\ny'],
      ['a\na\na', 'a'],
    ];
    for (const [prev, next] of cases) {
      const { added, removed } = countAddedRemoved(prev, next);
      // Net change tracks logical line count (matching countLines / forEachLineHash).
      expect(added - removed).toBe(countLines(next) - countLines(prev));
    }
  });
});

describe('accumulateEditLoc', () => {
  const URI = 'file:///project/src/app.ts';

  it('counts repeated whole-file snapshots incrementally rather than summing them', () => {
    // One request rewrites the same 10-line file three times, each time adding one line.
    const v1 = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const v2 = v1 + '\nline10';
    const v3 = v2 + '\nline11';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', v1)],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)),
        uriOp(URI, 'r1', 2, wholeFile(v2)),
        uriOp(URI, 'r1', 3, wholeFile(v3)),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    // Baseline already equals v1, so v1 adds 0; v2 adds 1; v3 adds 1. Total 2 — not 30.
    expect(totalFor(index, URI)).toBe(2);
  });

  it('does not count a pre-existing file in full on the first whole-file snapshot', () => {
    const existing = 'a\nb\nc\nd\ne';
    const edited = 'a\nb\nCHANGED\nd\ne';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', existing)],
      operations: [uriOp(URI, 'r1', 1, wholeFile(edited))],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(1);
  });

  it('counts a brand-new file (no baseline) in full', () => {
    const created = 'a\nb\nc';
    const timeline: EditTimelineLike = {
      operations: [uriOp(URI, 'r1', 1, wholeFile(created))],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(3);
  });

  it('seeds from the resolved initial content when the per-request baseline is missing', () => {
    const existing = 'a\nb\nc\nd\ne';
    const edited = 'a\nb\nCHANGED\nd\ne';
    const timeline: EditTimelineLike = {
      operations: [uriOp(URI, 'r1', 1, wholeFile(edited))],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index, uri => (uri === URI ? existing : undefined));
    expect(totalFor(index, URI)).toBe(1);
  });

  it('carries reconstructed state across requests when a later request has no baseline', () => {
    const v1 = 'a\nb\nc';
    const v2 = 'a\nb\nc\nd';
    const timeline: EditTimelineLike = {
      // Only r1 has a baseline; r2 must carry over the state reconstructed after r1.
      fileBaselines: [baseline(URI, 'r1', '')],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)),
        uriOp(URI, 'r2', 2, wholeFile(v2)),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(addedFor(index, 'r1', URI)).toBe(3); // new file, full count
    expect(addedFor(index, 'r2', URI)).toBe(1); // only the added line
  });

  it('attributes lines to the correct request when one file is edited by multiple requests', () => {
    const v1 = 'a\nb';
    const v2 = 'a\nb\nc';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', ''), baseline(URI, 'r2', v1)],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)),
        uriOp(URI, 'r2', 2, wholeFile(v2)),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(addedFor(index, 'r1', URI)).toBe(2);
    expect(addedFor(index, 'r2', URI)).toBe(1);
  });

  it('records each file separately when one request edits several files', () => {
    const uriA = 'file:///a.ts';
    const uriB = 'file:///b.ts';
    const timeline: EditTimelineLike = {
      operations: [
        uriOp(uriA, 'r1', 1, wholeFile('a\nb')),
        uriOp(uriB, 'r1', 2, wholeFile('x\ny\nz')),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(addedFor(index, 'r1', uriA)).toBe(2);
    expect(addedFor(index, 'r1', uriB)).toBe(3);
  });

  it('processes ops in epoch order even when the input is out of order', () => {
    const v1 = 'a\nb\nc';
    const v2 = 'a\nb\nc\nd';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', '')],
      operations: [
        uriOp(URI, 'r1', 2, wholeFile(v2)), // later epoch listed first
        uriOp(URI, 'r1', 1, wholeFile(v1)),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(4); // 3 for v1 + 1 added for v2
  });

  it('ignores non-textEdit operations', () => {
    const timeline: EditTimelineLike = {
      operations: [
        { type: 'create', requestId: 'r1', uri: { external: URI }, epoch: 1 },
        { type: 'delete', requestId: 'r1', uri: { external: URI }, epoch: 2 },
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(index.size).toBe(0);
  });

  it('counts small ranged edits (Anthropic-style) as the number of touched lines', () => {
    const prev = 'a\nb\nc';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }, text: 'B\nB2' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    // 'b' becomes 'B\nB2': one line changed plus one inserted -> 2 new lines.
    expect(totalFor(index, URI)).toBe(2);
  });

  it('credits only newly added lines when a later snapshot also removes lines', () => {
    const v1 = 'a\nb\nc\nd\ne';
    const v2 = 'a\nb\nd\ne\nf'; // removed 'c', appended 'f' -> 1 newly produced line
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', v1)],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)), // equals baseline -> 0
        uriOp(URI, 'r1', 2, wholeFile(v2)), // +1 added, +1 removed
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(1);
    expect(totalRemovedFor(index, URI)).toBe(1);
  });

  it('records removed lines so net output can go negative on a cleanup edit', () => {
    const v1 = 'a\nb\nc\nd\ne';
    const v2 = 'a\nb'; // three lines removed, nothing added
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', v1)],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)), // equals baseline -> 0/0
        uriOp(URI, 'r1', 2, wholeFile(v2)), // 0 added, 3 removed
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(0);
    expect(totalRemovedFor(index, URI)).toBe(3);
    // Net = added - removed = -3.
    expect(totalFor(index, URI) - totalRemovedFor(index, URI)).toBe(-3);
  });

  it('records zero removed for a brand-new file', () => {
    const timeline: EditTimelineLike = {
      operations: [uriOp(URI, 'r1', 1, wholeFile('a\nb\nc'))],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(removedFor(index, 'r1', URI)).toBe(0);
  });

  it('attributes removed lines to the request that deleted them, not the one that added them', () => {
    const v1 = 'a\nb\nc\nd';
    const v2 = 'a\nb'; // r2 deletes 'c' and 'd'
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', ''), baseline(URI, 'r2', v1)],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)), // r1: +4 added, 0 removed
        uriOp(URI, 'r2', 2, wholeFile(v2)), // r2: 0 added, 2 removed
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(addedFor(index, 'r1', URI)).toBe(4);
    expect(removedFor(index, 'r1', URI)).toBe(0);
    expect(addedFor(index, 'r2', URI)).toBe(0);
    expect(removedFor(index, 'r2', URI)).toBe(2);
  });

  it('records removed lines for a ranged (Anthropic-style) deletion', () => {
    const prev = 'a\nb\nc\nd';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        // Delete lines 2-3 ('b' and 'c') by replacing the span with nothing.
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 }, text: '' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(0);
    expect(totalRemovedFor(index, URI)).toBe(2);
  });

  it('counts a mid-line newline insertion without changing surrounding lines', () => {
    const prev = 'one\ntwo three\nfour';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }, text: '\nTWO' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(2);
    expect(totalRemovedFor(index, URI)).toBe(1);
  });

  it('counts a multi-line ranged edit that merges line prefixes and suffixes', () => {
    const prev = 'a\nprefix-middle\nsuffix-tail\nz';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 7, endLineNumber: 3, endColumn: 7 }, text: '' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(1);
    expect(totalRemovedFor(index, URI)).toBe(2);
  });

  it('does not count a trailing newline toggle as a new logical line', () => {
    const prev = 'a\nb';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 2 }, text: '\n' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(index.size).toBe(0);
  });

  it('preserves CRLF hashing behavior for ranged edits', () => {
    const prev = 'a\r\nb';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 }, text: 'B' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(1);
    expect(totalRemovedFor(index, URI)).toBe(1);
  });

  it('falls back for a multi-edit operation while preserving LOC output', () => {
    const prev = 'a\nb\nc';
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', prev)],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'A' },
          { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 }, text: 'C' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(2);
    expect(totalRemovedFor(index, URI)).toBe(2);
  });

  it('falls back for column overshoot while preserving clamped edit behavior', () => {
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', 'abc')],
      operations: [
        uriOp(URI, 'r1', 1, [
          { range: { startLineNumber: 1, startColumn: 99, endLineNumber: 1, endColumn: 99 }, text: 'X' },
        ]),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(totalFor(index, URI)).toBe(1);
    expect(totalRemovedFor(index, URI)).toBe(1);
  });

  it('carries removed state across requests when a later request has no baseline', () => {
    const v1 = 'a\nb\nc\nd';
    const v2 = 'a\nb'; // r2 (no baseline) must diff against r1's reconstructed state
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', '')],
      operations: [
        uriOp(URI, 'r1', 1, wholeFile(v1)),
        uriOp(URI, 'r2', 2, wholeFile(v2)),
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(removedFor(index, 'r2', URI)).toBe(2);
  });

  it('skips operations that are missing a requestId or a uri', () => {
    const timeline: EditTimelineLike = {
      operations: [
        { type: 'textEdit', uri: { external: URI }, epoch: 1, edits: wholeFile('a\nb') }, // no requestId
        { type: 'textEdit', requestId: 'r1', epoch: 2, edits: wholeFile('x\ny') },         // no uri
      ],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(index.size).toBe(0);
  });

  it('contributes nothing (and creates no entry) for an op with no edits', () => {
    const timeline: EditTimelineLike = {
      fileBaselines: [baseline(URI, 'r1', 'a\nb\nc')],
      operations: [uriOp(URI, 'r1', 1, [])],
    };
    const index = newIndex();
    accumulateEditLoc(timeline, index);
    expect(index.size).toBe(0);
  });

  it('does nothing for an empty or missing timeline', () => {
    const index = newIndex();
    accumulateEditLoc(undefined, index);
    accumulateEditLoc({}, index);
    accumulateEditLoc({ operations: [] }, index);
    expect(index.size).toBe(0);
  });
});
