"""Voice-activity gate.

Feeds raw 16 kHz / Int16 / mono PCM through WebRTC VAD and only lets *speech*
through. Silence is dropped before it ever leaves the engine, so we never pay
Sarvam to transcribe dead air (Sarvam bills per second of audio sent).

Two details keep the gating from mangling speech:
  - pre-roll: we keep the last few frames buffered so the *onset* of a word
    isn't clipped while VAD is still deciding it's speech.
  - hangover: once speaking, we keep streaming through brief pauses so words
    aren't chopped mid-sentence; only a sustained pause closes the gate.

If `webrtcvad` isn't importable for any reason, the gate degrades to a no-op
pass-through (every frame forwarded) so capture never breaks.
"""

import array
import collections
import logging

logger = logging.getLogger(__name__)

try:
    import webrtcvad
    _vad_available = True
except ImportError:  # pragma: no cover - depends on bundled wheel
    webrtcvad = None
    _vad_available = False
    logger.warning("webrtcvad not installed — silence gating disabled (streaming all audio).")

SAMPLE_RATE = 16000
FRAME_MS = 20  # webrtcvad accepts 10/20/30 ms frames only
FRAME_BYTES = int(SAMPLE_RATE * FRAME_MS / 1000) * 2  # 320 samples * 2 bytes = 640


class VADGate:
    """Stateful gate. Feed arbitrary-length PCM via `process()`; it yields the
    PCM bytes that should be streamed (speech only, with pre-roll + hangover)."""

    def __init__(self, aggressiveness=1, preroll_ms=300, hangover_ms=800):
        self.enabled = _vad_available
        if self.enabled:
            # 0 = least aggressive at filtering non-speech, 3 = most. We default
            # to 1 (permissive) so real/quiet speech is never dropped; the cost
            # win comes from cutting the long fully-silent stretches, and erring
            # toward sending a little extra silence beats clipping words.
            self.vad = webrtcvad.Vad(aggressiveness)
        self._buf = bytearray()
        self._preroll = collections.deque(maxlen=max(1, preroll_ms // FRAME_MS))
        self._hangover_frames = max(1, hangover_ms // FRAME_MS)
        self._silence_run = 0
        self._speaking = False
        # Pass-rate + amplitude stats (logged periodically). Amplitude tells a
        # silent mic (peak ~0, e.g. missing macOS permission) apart from VAD
        # wrongly rejecting real audio (peak high but pass-rate low).
        self._stat_total = 0
        self._stat_passed = 0
        self._stat_peak = 0
        self._stat_window = 500  # ~10s of input at 20ms/frame

    def _log_stats(self):
        if self._stat_total >= self._stat_window:
            pct = 100.0 * self._stat_passed / self._stat_total
            logger.info("VAD pass-rate: %.0f%% of last %.1fs | mic peak=%d/32768",
                        pct, self._stat_total * FRAME_MS / 1000.0, self._stat_peak)
            self._stat_total = 0
            self._stat_passed = 0
            self._stat_peak = 0

    def process(self, pcm_bytes):
        """Yield PCM byte-frames (20 ms each) that should be streamed. Drops
        silence. When VAD is unavailable, forwards the input unchanged."""
        if not self.enabled:
            yield pcm_bytes
            return

        self._buf.extend(pcm_bytes)
        while len(self._buf) >= FRAME_BYTES:
            frame = bytes(self._buf[:FRAME_BYTES])
            del self._buf[:FRAME_BYTES]
            self._stat_total += 1
            samples = array.array('h', frame)
            peak = max((abs(s) for s in samples), default=0)
            if peak > self._stat_peak:
                self._stat_peak = peak
            try:
                voiced = self.vad.is_speech(frame, SAMPLE_RATE)
            except Exception:
                voiced = True  # fail open — never silently swallow audio on error

            if self._speaking:
                self._silence_run = 0 if voiced else self._silence_run + 1
                self._stat_passed += 1
                yield frame  # keep streaming through the hangover window
                if not voiced and self._silence_run >= self._hangover_frames:
                    # Sustained pause: close the gate. Subsequent silent frames
                    # fall through to the pre-roll buffer below.
                    self._speaking = False
                    self._silence_run = 0
            else:
                self._preroll.append(frame)
                if voiced:
                    # Onset: flush the pre-roll so we don't clip the first word.
                    self._speaking = True
                    self._silence_run = 0
                    while self._preroll:
                        self._stat_passed += 1
                        yield self._preroll.popleft()
            self._log_stats()

    def reset(self):
        """Drop all buffered state (call when recording stops/restarts)."""
        self._buf.clear()
        self._preroll.clear()
        self._silence_run = 0
        self._speaking = False
