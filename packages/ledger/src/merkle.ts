import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Binary Merkle root over entry hashes. Odd levels duplicate the final node.
 *
 * Leaves and internal nodes are domain-separated with 0x00/0x01 prefixes.
 * Without that, an attacker who controls a leaf value could supply a value
 * that is itself an internal node's preimage and present a forged proof for a
 * tree of different shape — the classic second-preimage attack on Merkle trees.
 */
export function merkleRoot(entryHashes: readonly string[]): string {
  if (entryHashes.length === 0) throw new RangeError("merkleRoot: empty range");

  let level = entryHashes.map((h) => sha256("00" + h));

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate last on odd count
      next.push(sha256("01" + left + right));
    }
    level = next;
  }

  return level[0]!;
}
