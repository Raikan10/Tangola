import sys
import numpy as np
import logging

logger = logging.getLogger(__name__)

# Audio config
SAMPLE_RATE = 16000
CHUNK_SIZE = 1024

try:
    import pyaudio
    _pyaudio_available = True
except ImportError:
    pyaudio = None
    _pyaudio_available = False
    logger.warning("pyaudio not installed — Mac microphone capture unavailable.")

try:
    import soundcard as sc
    _soundcard_available = True
except ImportError:
    sc = None
    _soundcard_available = False
    logger.warning("soundcard not installed — Windows WASAPI loopback unavailable.")


class AudioAdapter:
    def __init__(self):
        self.is_recording = False

    def get_audio_stream(self):
        """Yields chunks of Int16 PCM audio bytes."""
        raise NotImplementedError

    def start(self):
        self.is_recording = True

    def stop(self):
        self.is_recording = False


class WindowsAdapter(AudioAdapter):
    """Captures system audio via WASAPI loopback (records what the speakers play)."""

    def __init__(self):
        super().__init__()
        if not _soundcard_available:
            raise RuntimeError(
                "soundcard is not installed. Run: pip install soundcard\n"
                "On Windows you may also need to install the VC++ redistributable."
            )
        try:
            # Early check for audio devices
            speakers = sc.all_speakers()
            if not speakers:
                logger.warning("[WindowsAdapter] No speakers detected.")
        except Exception as e:
            logger.error(f"[WindowsAdapter] Failed to query audio devices: {e}")

    def get_audio_stream(self):
        try:
            default_speaker = sc.default_speaker()
            loopback = sc.get_microphone(default_speaker.id, include_loopback=True)
            logger.info(f"[WindowsAdapter] Using WASAPI loopback: {default_speaker.name}")
        except Exception as e:
            logger.warning(f"[WindowsAdapter] Could not get default speaker loopback ({e}), trying first available.")
            try:
                loopback_devices = sc.all_microphones(include_loopback=True)
                if not loopback_devices:
                    raise RuntimeError("No WASAPI loopback device found. Ensure 'Stereo Mix' or similar is enabled in Windows Sound settings.")
                loopback = loopback_devices[0]
                logger.info(f"[WindowsAdapter] Using fallback loopback: {loopback.name}")
            except Exception as e2:
                raise RuntimeError(f"Failed to find any loopback device: {e2}")

        try:
            recorder = loopback.recorder(samplerate=SAMPLE_RATE, channels=1)
        except Exception as e:
            raise RuntimeError(f"Failed to open recorder on device {loopback.name}: {e}")

        with recorder as mic:
            while self.is_recording:
                data = mic.record(numframes=CHUNK_SIZE)
                # soundcard returns float32 in range [-1, 1]; convert to Int16
                audio_float = data[:, 0]
                audio_int16 = (np.clip(audio_float, -1.0, 1.0) * 32767).astype(np.int16)
                yield audio_int16.tobytes()


class WindowsMicrophoneAdapter(AudioAdapter):
    """Captures microphone input via pyaudio (DirectSound/MME on Windows)."""

    def __init__(self):
        super().__init__()
        if not _pyaudio_available:
            raise RuntimeError(
                "pyaudio is not installed. Run: pip install pyaudio\n"
                "On Windows you may also need the VC++ redistributable or a specific wheel."
            )
        self._pa = pyaudio.PyAudio()
        logger.info(f"[WindowsMicrophoneAdapter] pyaudio initialized. Default input: {self._get_default_device_name()}")

    def _get_default_device_name(self):
        try:
            info = self._pa.get_default_input_device_info()
            return info.get('name', 'Unknown')
        except Exception:
            return 'Unknown'

    def get_audio_stream(self):
        try:
            stream = self._pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=SAMPLE_RATE,
                input=True,
                frames_per_buffer=CHUNK_SIZE,
            )
            logger.info("[WindowsMicrophoneAdapter] Audio stream opened, recording...")
        except Exception as e:
            raise RuntimeError(f"Failed to open microphone: {e}")

        try:
            while self.is_recording:
                try:
                    data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                    yield data
                except IOError as e:
                    logger.warning(f"[WindowsMicrophoneAdapter] IOError during read: {e}")
                    continue
        finally:
            stream.stop_stream()
            stream.close()
            logger.info("[WindowsMicrophoneAdapter] Audio stream closed.")

    def __del__(self):
        try:
            self._pa.terminate()
        except Exception:
            pass


class WindowsHybridAdapter(AudioAdapter):
    """Captures BOTH system audio (Loopback) and Microphone simultaneously."""

    def __init__(self):
        super().__init__()
        self.mic = WindowsMicrophoneAdapter()
        self.loopback_adapter = WindowsAdapter()

    def get_audio_stream(self):
        """Yields mixed chunks of loopback and microphone PCM data."""
        self.mic.is_recording = True
        self.loopback_adapter.is_recording = True

        mic_gen = self.mic.get_audio_stream()
        loop_gen = self.loopback_adapter.get_audio_stream()

        logger.info("[WindowsHybridAdapter] Streaming merged audio (Mic + System Output)...")

        while self.is_recording:
            try:
                # Get one chunk from each
                # This is a bit tricky since generators block. 
                # We expect them to yield roughly at the same speed.
                mic_chunk = next(mic_gen)
                loop_chunk = next(loop_gen)

                # Convert to numpy for mixing
                mic_pcm = np.frombuffer(mic_chunk, dtype=np.int16).astype(np.int32)
                loop_pcm = np.frombuffer(loop_chunk, dtype=np.int16).astype(np.int32)

                # Simple additive mix with clipping protection
                mixed_pcm = np.clip(mic_pcm + loop_pcm, -32768, 32767).astype(np.int16)
                yield mixed_pcm.tobytes()

            except (StopIteration, Exception) as e:
                logger.error(f"[WindowsHybridAdapter] Merging interrupted: {e}")
                break

        self.mic.stop()
        self.loopback_adapter.stop()


class MacAdapter(AudioAdapter):
# ... (rest of file remains same)
    """Captures microphone input via pyaudio (CoreAudio on macOS)."""

    def __init__(self):
        super().__init__()
        if not _pyaudio_available:
            raise RuntimeError(
                "pyaudio is not installed. Run: pip install pyaudio\n"
                "On macOS you may also need: brew install portaudio"
            )
        self._pa = pyaudio.PyAudio()
        logger.info(f"[MacAdapter] pyaudio initialized. Default input: {self._get_default_device_name()}")

    def _get_default_device_name(self):
        try:
            info = self._pa.get_default_input_device_info()
            return info.get('name', 'Unknown')
        except Exception:
            return 'Unknown'

    def get_audio_stream(self):
        stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=SAMPLE_RATE,
            input=True,
            frames_per_buffer=CHUNK_SIZE,
        )
        logger.info("[MacAdapter] Audio stream opened, recording...")
        try:
            while self.is_recording:
                try:
                    data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                    yield data
                except IOError as e:
                    logger.warning(f"[MacAdapter] IOError during read (skipping chunk): {e}")
                    continue
        finally:
            stream.stop_stream()
            stream.close()
            logger.info("[MacAdapter] Audio stream closed.")

    def __del__(self):
        try:
            self._pa.terminate()
        except Exception:
            pass


def get_adapter() -> AudioAdapter:
    """Returns the correct audio adapter for the current OS."""
    if sys.platform == 'win32':
        logger.info("Platform: Windows — using WindowsMicrophoneAdapter (Microphone)")
        # We default to Microphone to ensure the OS registers the app for permission
        # and to capture in-person meetings. 
        return WindowsMicrophoneAdapter()
    elif sys.platform == 'darwin':
        logger.info("Platform: macOS — using MacAdapter (microphone)")
        return MacAdapter()
    else:
        logger.info(f"Platform: {sys.platform} — falling back to MacAdapter")
        return MacAdapter()
