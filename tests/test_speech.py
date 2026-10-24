import unittest
from speech import Speech


class SpeechBoundaryTests(unittest.TestCase):
    def test_empty_or_oversized_input_does_not_load_model(self):
        speech = Speech()
        for audio in (b'', b'x' * 4_000_001):
            with self.assertRaises(ValueError):
                speech.transcribe(audio)
        self.assertIsNone(speech.model)

    def test_concurrent_recording_rejected_without_loading(self):
        speech = Speech()
        speech.lock.acquire()
        try:
            with self.assertRaisesRegex(ValueError, 'Already transcribing'):
                speech.transcribe(b'audio')
            self.assertIsNone(speech.model)
        finally:
            speech.lock.release()


class WhisperCppTests(unittest.TestCase):
    @staticmethod
    def audio(seconds=1):
        import io
        import wave
        out = io.BytesIO()
        with wave.open(out, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b'\x00\x00' * int(16000 * seconds))
        return out.getvalue()

    def test_cpp_receives_bounded_wav_and_temporary_files_are_removed(self):
        from pathlib import Path
        from unittest.mock import patch
        speech = Speech()
        speech.model = '/test/whisper-cli'
        paths = []

        def transcribe(args, **kwargs):
            wav = Path(args[args.index('-f') + 1])
            paths.append(wav)
            self.assertTrue(wav.is_file())
            self.assertIn('--vad', args)
            self.assertEqual(kwargs['timeout'], 60)
            self.assertNotIn('shell', kwargs)
            Path(args[args.index('-of') + 1] + '.txt').write_text(' Move the x axis by five millimeters.\n')

        with patch('speech.subprocess.run', side_effect=transcribe):
            result = speech.transcribe(self.audio())
        self.assertEqual(result['engine'], 'whisper.cpp')
        self.assertEqual(result['text'], 'Move the x axis by five millimeters.')
        self.assertFalse(paths[0].parent.exists())

    def test_failures_and_silence_release_lock_and_delete_audio(self):
        from pathlib import Path
        from unittest.mock import patch
        import subprocess
        speech = Speech()
        speech.model = '/test/whisper-cli'
        for failure in (False, True):
            paths = []

            def transcribe(args, **kwargs):
                paths.append(Path(args[args.index('-f') + 1]))
                if failure:
                    raise subprocess.TimeoutExpired(args, 60)
                Path(args[args.index('-of') + 1] + '.txt').write_text('')

            with patch('speech.subprocess.run', side_effect=transcribe):
                with self.assertRaisesRegex(ValueError, 'could not be transcribed' if failure else 'No speech'):
                    speech.transcribe(self.audio())
            self.assertFalse(speech.lock.locked())
            self.assertFalse(paths[0].parent.exists())

    def test_malformed_and_long_recordings_never_reach_inference(self):
        from unittest.mock import patch
        speech = Speech()
        speech.model = '/test/whisper-cli'
        with patch('speech.subprocess.run') as run:
            for audio in (b'not audio', self.audio(32)):
                with self.assertRaises(ValueError):
                    speech.transcribe(audio)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
