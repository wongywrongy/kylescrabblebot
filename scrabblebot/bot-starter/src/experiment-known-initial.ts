export type InitialObservation =
  | { at: bigint; botId: string; kind: 'award'; letter: string }
  | { at: bigint; botId: string; kind: 'word'; word: string };

// Public play can prove an initial letter; later purchases cannot erase that proof.
export function knownInitialTiles(observations: readonly InitialObservation[], opponentIds: readonly string[], cutoff: bigint): Map<string, Map<string, number>> | undefined {
  const players = new Map(opponentIds.map(id => [id, {
    bought: new Map<string, number>(), used: new Map<string, number>(), known: new Map<string, number>(),
  }]));
  const prefix = observations.filter(e => e.at <= cutoff && players.has(e.botId)).sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === b.kind ? 0 : a.kind === 'award' ? -1 : 1);
  for (const event of prefix) {
    const p = players.get(event.botId)!;
    if (event.kind === 'award') {
      if (!/^[A-Z]$/.test(event.letter)) return;
      p.bought.set(event.letter, (p.bought.get(event.letter) ?? 0) + 1);
    } else {
      if (!/^[A-Z]{2,}$/.test(event.word)) return;
      for (const c of event.word) p.used.set(c, (p.used.get(c) ?? 0) + 1);
      for (const [c, used] of p.used) {
        const minimum = Math.max(p.known.get(c) ?? 0, used - (p.bought.get(c) ?? 0));
        if (minimum > 0) p.known.set(c, minimum);
      }
      // Incomplete history cannot safely remove more than the five dealt tiles.
      if ([...p.known.values()].reduce((sum, n) => sum + n, 0) > 5) return;
    }
  }
  return new Map([...players].map(([id, p]) => [id, p.known]));
}
