import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownInitialTiles, type InitialObservation } from './experiment-known-initial.js';

test('later awards preserve the initial letters required by earlier words', () => {
  const events: InitialObservation[] = [
    { at: 1n, botId: 'a', kind: 'word', word: 'AA' },
    ...[2n, 3n, 4n].map(at => ({ at, botId: 'a', kind: 'award' as const, letter: 'A' })),
  ];
  assert.equal(knownInitialTiles(events, ['a'], 1n)!.get('a')!.get('A'), 2);
  assert.equal(knownInitialTiles(events, ['a'], 4n)!.get('a')!.get('A'), 2);
});

test('timestamp ties apply awards before words, regardless of input order', () => {
  const events: InitialObservation[] = [
    { at: 1n, botId: 'a', kind: 'word', word: 'AT' },
    { at: 1n, botId: 'a', kind: 'award', letter: 'A' },
  ];
  const before = structuredClone(events);
  assert.deepEqual([...knownInitialTiles(events, ['a'], 1n)!.get('a')!], [['T', 1]]);
  assert.deepEqual(events, before);
});

test('future events and other players cannot supply prefix knowledge', () => {
  const events: InitialObservation[] = [
    { at: 1n, botId: 'b', kind: 'word', word: 'QUIZ' },
    { at: 3n, botId: 'a', kind: 'word', word: 'AX' },
  ];
  assert.equal(knownInitialTiles(events, ['a'], 2n)!.get('a')!.size, 0);
  assert.equal(knownInitialTiles(events, ['a'], 3n)!.get('a')!.get('X'), 1);
});

test('each opponent stays within five initial tiles; inconsistent prefixes fall back', () => {
  const valid: InitialObservation[] = [
    { at: 1n, botId: 'a', kind: 'word', word: 'ABCDE' },
    { at: 1n, botId: 'b', kind: 'word', word: 'FGHIJ' },
  ];
  for (const known of knownInitialTiles(valid, ['a', 'b'], 1n)!.values()) assert.equal([...known.values()].reduce((a, b) => a + b, 0), 5);
  assert.equal(knownInitialTiles([...valid, { at: 2n, botId: 'a', kind: 'word', word: 'KL' }], ['a', 'b'], 2n), undefined);
  assert.equal(knownInitialTiles([{ at: 1n, botId: 'a', kind: 'word', word: 'A!' }], ['a'], 1n), undefined);
});
