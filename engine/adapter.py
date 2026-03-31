import sys
import numpy as np

# Audio config
SAMPLE_RATE = 16000
CHUNK_SIZE = 1024

try:
    import pyaudio
except ImportError:
    pyaudio = None

try:
    import soundcard as sc
except ImportError:
    sc = None

class AudioAdapter:
    def __init__(self):
        self.is_recording = False

    def get_audio_stream(self):
        """ yields chunks of Int16 audio data """
        raise NotImplementedError

    def start(self):
        self.is_recording = True

    def stop(self):
        self.is_recording = False


class WindowsAdapter(AudioAdapter):
    def __init__(self):
        super().__init__()
        if sc is None:
            raise ImportError("soundcard is not installed")
        self.sc = sc

    def get_audio_stream(self):
        # Grab the default speaker's loopback interface
        try:
            default_speaker = self.sc.default_speaker()
            loopback = self.sc.get_microphone(default_speaker.id, include_loopback=True)
        except Exception:
            # Fallback to general loopback if the above fails
            loopback = self.sc.all_microphones(include_loopback=True)[0]
        
        with loopback.recorder(samplerate=SAMPLE_RATE, channels=1) as mic:
            while self.is_recording:
                data = mic.record(numframes=CHUNK_SIZE)
                # Convert Float32 to Int16
                audio_float = data[:, 0]
                audio_int16 = (audio_float * 32767).astype(np.int16)
                yield audio_int16.tobytes()


class MacAdapter(AudioAdapter):
    def __init__(self):
        super().__init__()
        if pyaudio is None:
            raise ImportError("pyaudio is not installed")
        self.p = pyaudio.PyAudio()

    def get_audio_stream(self):
        stream = self.p.open(format=pyaudio.paInt16,
                             channels=1,
                             rate=SAMPLE_RATE,
                             input=True,
                             frames_per_buffer=CHUNK_SIZE)
        
        while self.is_recording:
            try:
                data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                yield data
            except IOError:
                continue
        
        stream.stop_stream()
        stream.close()


def get_adapter():
    if sys.platform == "win32":
        return WindowsAdapter()
    elif sys.platform == "darwin":
        return MacAdapter()
    else:
        # Fallback to Mac adapter for linux/other
        return MacAdapter()
