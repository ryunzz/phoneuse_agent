"""Local speech SDK; no desktop dictation app or cloud API key."""
import io
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import urllib.request
import wave

MODEL_CACHE = Path(__file__).resolve().parent / '.models'


class Speech:
    def __init__(self):
        self.model = None
        self.lock = threading.Lock()

    def load(self, download=False):
        binary = shutil.which('whisper-cli')
        if not binary:
            raise ValueError('whisper.cpp missing. Run brew install whisper-cpp.')
        models = {
            'ggml-base.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
            'ggml-silero-v6.2.0.bin': 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
        }
        MODEL_CACHE.mkdir(exist_ok=True)
        for name, url in models.items():
            path = MODEL_CACHE / name
            if download and not path.is_file():
                partial = path.with_suffix('.partial')
                try:
                    urllib.request.urlretrieve(url, partial)
                    partial.replace(path)
                finally:
                    partial.unlink(missing_ok=True)
            if not path.is_file():
                raise ValueError('Speech model unavailable. Run .venv-voice/bin/python speech.py first.')
        self.model = binary

    def transcribe(self, audio):
        if not audio or len(audio) > 4_000_000:
            raise ValueError('Record 1–30 seconds of audio (at most 4 MB)')
        if not self.lock.acquire(blocking=False):
            raise ValueError('Already transcribing. Wait for the current recording.')
        try:
            if self.model is None:
                self.load()
            try:
                import av
                # Bound decoded samples before inference, including malformed/long compressed input.
                with av.open(io.BytesIO(audio)) as container:
                    duration = container.duration
                    if duration is not None and duration / av.time_base > 31:
                        raise ValueError('Recording is too long; limit it to 30 seconds')
                    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
                    pcm = bytearray()
                    for frame in container.decode(audio=0):
                        for converted in resampler.resample(frame):
                            pcm.extend(converted.to_ndarray().tobytes())
                            if len(pcm) > 31 * 16000 * 2:
                                raise ValueError('Recording is too long; limit it to 30 seconds')
                    for converted in resampler.resample(None):
                        pcm.extend(converted.to_ndarray().tobytes())
                if not 0 < len(pcm) <= 31 * 16000 * 2:
                    raise ValueError('Recording is empty or too long')
                # whisper-cli needs a WAV path. Private temporary audio is deleted on every exit.
                with tempfile.TemporaryDirectory(prefix='harness-voice-') as folder:
                    wav = Path(folder) / 'recording.wav'
                    with wave.open(str(wav), 'wb') as out:
                        out.setnchannels(1)
                        out.setsampwidth(2)
                        out.setframerate(16000)
                        out.writeframes(pcm)
                    subprocess.run([
                        self.model, '-m', str(MODEL_CACHE / 'ggml-base.en.bin'),
                        '-f', str(wav), '-l', 'en', '-t', '4', '-nt', '-np',
                        '--vad', '-vm', str(MODEL_CACHE / 'ggml-silero-v6.2.0.bin'),
                        '-otxt', '-of', str(Path(folder) / 'transcript'),
                    ], capture_output=True, timeout=60, check=True)
                    text = ' '.join((Path(folder) / 'transcript.txt').read_text().split())
            except ValueError:
                raise
            except Exception:
                raise ValueError('Audio could not be transcribed. Record again or type the prompt.') from None
            if not text:
                raise ValueError('No speech detected. Try again closer to the microphone.')
            if len(text) > 200:
                raise ValueError('Transcript too long. Speak one short printer command.')
            return {'text': text, 'engine': 'whisper.cpp', 'model': 'base.en', 'processing': 'local'}
        finally:
            self.lock.release()


if __name__ == '__main__':
    Speech().load(download=True)
    print('Local speech model ready.')
