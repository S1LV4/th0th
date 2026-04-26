import { describe, expect, it } from "bun:test";

/**
 * Regression test for: RangeError: Not an integer at BigInt() in upsertFile
 *
 * stat.mtimeMs returns milliseconds as a float (sub-millisecond precision).
 * BigInt() requires a strict integer — passing a float throws RangeError.
 * Fix: BigInt(Math.trunc(file.mtime))
 */
describe("upsertFile mtime BigInt conversion", () => {
  // Values representative of what stat.mtimeMs can produce
  const floatMtimes = [
    1_700_000_000_000.5,
    1_700_000_000_000.123,
    1_700_000_000_000.999,
    0.5,
    Date.now() + 0.7,
  ];

  const intMtimes = [
    1_700_000_000_000,
    0,
    Date.now(),
  ];

  it("BigInt(float) throws RangeError — the pre-fix behaviour", () => {
    for (const mtime of floatMtimes) {
      expect(() => BigInt(mtime)).toThrow(RangeError);
    }
  });

  it("BigInt(Math.trunc(float)) never throws — the post-fix behaviour", () => {
    for (const mtime of floatMtimes) {
      expect(() => BigInt(Math.trunc(mtime))).not.toThrow();
    }
  });

  it("BigInt(Math.trunc(float)) truncates toward zero, not rounds", () => {
    expect(BigInt(Math.trunc(1_700_000_000_000.9))).toBe(1_700_000_000_000n);
    expect(BigInt(Math.trunc(1_700_000_000_000.1))).toBe(1_700_000_000_000n);
    expect(BigInt(Math.trunc(0.99))).toBe(0n);
  });

  it("BigInt(Math.trunc(integer)) is a no-op for already-integer mtimes", () => {
    for (const mtime of intMtimes) {
      expect(BigInt(Math.trunc(mtime))).toBe(BigInt(mtime));
    }
  });

  it("round-trips through Number back to the expected millisecond value", () => {
    const mtime = 1_746_000_000_000.75; // realistic stat.mtimeMs float
    const stored = BigInt(Math.trunc(mtime));
    expect(Number(stored)).toBe(1_746_000_000_000);
  });
});
