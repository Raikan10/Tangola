"""Tests for the VAD gate. Run: python3 test_vad.py

Verifies that silence is dropped, speech passes with pre-roll (no clipped
onset) and hangover (no chopped tail), and that the gate is a safe pass-through
when webrtcvad isn't available. Uses only numpy + stdlib.
"""

import sys
import numpy as np

from vad import VADGate, SAMPLE_RATE


def make_chunk(ms, speech):
    n = int(SAMPLE_RATE * ms / 1000)
    if speech:
        t = np.arange(n)
        sig = 8000 * np.sin(2 * np.pi * 200 * t / SAMPLE_RATE)
        sig = sig + np.random.randint(-1500, 1500, n)
        return sig.astype(np.int16).tobytes()
    return np.zeros(n, dtype=np.int16).tobytes()


def passed_seconds(gate, chunks):
    out = b"".join(frame for c in chunks for frame in gate.process(c))
    return len(out) / 2 / SAMPLE_RATE


def main():
    g = VADGate(aggressiveness=2, preroll_ms=300, hangover_ms=600)
    if not g.enabled:
        print("SKIP: webrtcvad not installed (gate degrades to pass-through).")
        return 0

    silence_before = [make_chunk(64, False) for _ in range(16)]  # ~1.0s
    speech = [make_chunk(64, True) for _ in range(16)]           # ~1.0s
    silence_after = [make_chunk(64, False) for _ in range(24)]   # ~1.5s

    s1 = passed_seconds(g, silence_before)
    s2 = passed_seconds(g, speech)
    s3 = passed_seconds(g, silence_after)

    print(f"pre-speech silence passed : {s1:.3f}s")
    print(f"speech passed             : {s2:.3f}s")
    print(f"post-speech silence passed: {s3:.3f}s")

    # Pre-speech silence is dropped (only the pre-roll ring is held, never emitted yet).
    assert s1 == 0.0, f"expected silence dropped, got {s1:.3f}s"
    # Speech passes, plus a little pre-roll; must not be clipped below the real speech.
    assert s2 >= 1.0, f"speech clipped: only {s2:.3f}s passed"
    assert s2 <= 1.5, f"too much passed for 1s speech: {s2:.3f}s"
    # After speech ends, only the hangover tail passes, then silence is dropped.
    assert 0.3 <= s3 <= 0.9, f"unexpected hangover tail: {s3:.3f}s"

    # Pass-through fallback when disabled.
    g2 = VADGate()
    g2.enabled = False
    assert passed_seconds(g2, silence_before) > 0.9, "disabled gate must pass everything"

    print("OK: all VAD gate assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
