const BAG = "A9B2C2D4E12F2G3H2I9J1K1L4M2N6O8P2Q1R6S4T6U4V2W2X1Y2Z1";

// Opponents' initial letters stay in this upper bound because they are private.
export function remainingPool(initialRack: Map<string, number>, publicDraws: Iterable<string>, bagRemaining: number, hiddenInitialTiles: number): Map<string, number> | undefined {
  const pool = new Map(BAG.match(/[A-Z]\d+/g)!.map(s => [s[0], Number(s.slice(1))]));
  for (const [letter, count] of initialRack) {
    if (!Number.isSafeInteger(count) || count < 0 || !pool.has(letter)) return;
    pool.set(letter, pool.get(letter)! - count);
  }
  for (const letter of publicDraws) {
    if (!pool.has(letter)) return;
    pool.set(letter, pool.get(letter)! - 1);
  }
  if ([...pool.values()].some(n => n < 0)) return;
  if ([...pool.values()].reduce((sum, n) => sum + n, 0) !== bagRemaining + hiddenInitialTiles) return;
  return pool;
}
