"""Supervise local iPhone Mirroring screenshots; retain only the latest frame."""
import json
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent


class PhoneStream:
    def __init__(self, folder=None):
        self.folder = Path(folder or ROOT / '.phone-stream')
        self.process = None
        self.message = {'state': 'stopped', 'message': 'Start the harness with --iphone to capture iPhone Mirroring.'}

    def start(self):
        binary = ROOT / '.build' / 'phone-capture'
        if not binary.exists():
            raise ValueError('Build iPhone capture first: mkdir -p .build && swiftc -parse-as-library PhoneCapture.swift -o .build/phone-capture')
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        for filename in ('latest.jpg', 'latest.json'):
            (self.folder / filename).unlink(missing_ok=True)
        self.message = {'state': 'starting', 'message': 'Waiting for macOS screen capture permission and iPhone Mirroring.'}
        self.process = subprocess.Popen([str(binary), str(self.folder)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        threading.Thread(target=self.read_status, daemon=True).start()

    def read_status(self):
        for line in self.process.stdout:
            try:
                self.message = json.loads(line)
            except ValueError:
                pass

    def status(self):
        result = dict(self.message)
        try:
            metadata = json.loads((self.folder / 'latest.json').read_text())
            age = max(0, time.time() - metadata['captured_at'])
            result.update(metadata, age_s=round(age, 2), fresh=age < 3)
        except (OSError, ValueError, KeyError):
            result.update(fresh=False, frames=0)
        result['running'] = self.process is not None and self.process.poll() is None
        if not result['running']:
            result['fresh'] = False
            if self.process is not None:
                result.update(state='stopped', message='Capture process exited; restart the harness to reconnect.')
        return result

    def snapshot(self, after=None, timeout=5):
        """Read immutable image bytes named by metadata, never a mismatched latest.jpg."""
        deadline = time.monotonic() + timeout
        while True:
            metadata = self.status()
            if metadata['fresh'] and (after is None or metadata.get('capture_started_at', 0) > after):
                name = metadata.get('image')
                if not isinstance(name, str) or Path(name).name != name:
                    raise ValueError('Rebuild and restart phone capture to enable paired snapshots')
                try:
                    return metadata, (self.folder / name).read_bytes()
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise ValueError('No fresh paired iPhone frame; check capture and Mirroring')
            time.sleep(0.05)

    def frame(self):
        if not self.status()['fresh']:
            raise ValueError('No fresh iPhone Mirroring frame')
        try:
            return (self.folder / 'latest.jpg').read_bytes()
        except OSError:
            raise ValueError('Frame unavailable') from None

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
