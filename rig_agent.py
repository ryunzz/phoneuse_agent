#!/usr/bin/env python3
"""Connect this Mac's phone rig to the hosted Phone Use gateway. Standard library only.

The rig dials out (HTTP long poll), so nothing on this machine is exposed to the Internet.
Every action from the gateway is validated with the same schema as the episode recorder.
"""
import argparse
import json
import os
import re
from pathlib import Path
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from episodes import action_payload

ROOT = Path(__file__).resolve().parent
SIM_SCREENS = {'home': 'iphone-home-after-test.png', 'settings': 'iphone-settings-test.png', 'text': 'iphone-text-entry-test.png'}


class SimBackend:
    """Fake phone for testing the pipeline without hardware. Taps open Settings; Home returns."""
    name = 'sim'

    def __init__(self):
        self.screens = {key: (ROOT / filename).read_bytes() for key, filename in SIM_SCREENS.items()}
        self.current = 'home'

    def frame(self):
        return self.screens[self.current]

    def execute(self, action):
        if action['type'] == 'wait':
            time.sleep(action['seconds'])
        elif action['type'] == 'home':
            self.current = 'home'
        elif action['type'] == 'tap':
            self.current = 'settings' if self.current == 'home' else self.current
        elif action['type'] == 'type':
            self.current = 'text'
        return {'simulated': True, 'screen': self.current}

    def stop(self):
        pass


def mirroring_screen(device=None):
    from phone_stream import PhoneStream
    return PhoneStream()


def camera_screen(device=None):
    from camera_stream import CameraStream
    return CameraStream(device=device)


SCREENS = {'mirroring': mirroring_screen, 'camera': camera_screen}


def mirroring_actuator():
    """Mac input events into the iPhone Mirroring window (PhoneAction.swift)."""
    from episodes import dispatch

    def act(action, frame):
        # Dispatch against the exact frame metadata so taps map to the window that was captured.
        return dispatch(action, frame)
    return act


def stylus_actuator():
    """Printer-driven stylus. Hardware workstream: stylus.py with dispatch(action, frame=metadata) -> receipt."""
    try:
        import stylus
    except ImportError:
        raise ValueError('Stylus backend needs stylus.py with dispatch(action, frame=metadata) -> receipt (see docs/PLAN.md)') from None

    def act(action, frame):
        return stylus.dispatch(action, frame=frame)
    return act


def view_only_actuator():
    def act(action, frame):
        raise ValueError('view-only camera; no actuator')
    act.needs_frame = False
    return act


ACTUATORS = {'mirroring': mirroring_actuator, 'stylus': stylus_actuator, 'none': view_only_actuator}
DEFAULT_SCREEN = {'mirroring': 'mirroring', 'stylus': 'mirroring', 'none': 'camera'}


class RigBackend:
    """A screen source (Mirroring window or camera) paired with an actuator."""

    def __init__(self, name, screen, act):
        self.name, self.screen, self.act = name, screen, act

    def frame(self):
        return self.screen.frame()

    def execute(self, action):
        metadata = self.screen.snapshot(timeout=2)[0] if getattr(self.act, 'needs_frame', True) else None
        return self.act(action, metadata)

    def stop(self):
        self.screen.stop()


def build_backend(backend, screen=None, camera_device=None, screens=SCREENS, actuators=ACTUATORS):
    """Validate the backend/screen combination before starting any capture process."""
    if backend == 'sim':
        if screen or camera_device:
            raise ValueError('The sim backend uses bundled frames; omit --screen and --camera-device')
        return SimBackend()
    if backend not in actuators:
        raise ValueError(f'Unknown backend {backend}')
    screen = screen or DEFAULT_SCREEN[backend]
    if screen not in screens:
        raise ValueError(f'Unknown screen {screen}')
    if backend == 'mirroring' and screen != 'mirroring':
        raise ValueError('Mirroring actions map to the Mirroring window; they cannot act on camera frames. '
                         'Use --backend stylus (calibrated) or --backend none with --screen camera')
    if camera_device and screen != 'camera':
        raise ValueError('--camera-device needs --screen camera')
    act = actuators[backend]()
    source = screens[screen](camera_device)
    source.start()
    return RigBackend(f'{backend}+{screen}', source, act)


BACKENDS = ('sim', 'mirroring', 'stylus', 'none')


class Gateway:
    def __init__(self, url, token):
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise ValueError('GATEWAY_URL must be an http(s) URL')
        if parsed.scheme == 'http' and parsed.hostname not in ('127.0.0.1', 'localhost'):
            raise ValueError('Use https for a non-local gateway; the rig token would be sent in clear text')
        if not re.fullmatch(r'rig_[A-Za-z0-9_-]{16,100}', token):
            raise ValueError('RIG_TOKEN must be a single rig token (rig_...), as printed by create-rig')
        self.url = url.rstrip('/')
        self.token = token

    def call(self, method, path, body=None, content_type='application/json', timeout=10):
        data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
        req = Request(self.url + path, data=data, method=method,
                      headers={'Authorization': f'Bearer {self.token}', 'Content-Type': content_type})
        with urlopen(req, timeout=timeout) as response:
            payload = response.read(1_000_000)
            return response.status, json.loads(payload) if payload else None


def log(message, **fields):
    print(json.dumps({'t': round(time.time(), 3), 'msg': message, **fields}), flush=True)


def push_frames(gateway, backend, stop, interval):
    last_error = None
    while not stop.is_set():
        try:
            gateway.call('POST', '/rig/v1/frames', backend.frame(), 'image/jpeg')
            last_error = None
        except (HTTPError, URLError, OSError, ValueError) as error:
            # Report each distinct failure once instead of flooding the log at 2 fps.
            if str(error) != last_error:
                last_error = str(error)
                log('frame upload failed', error=last_error)
        stop.wait(interval)


def handle(gateway, backend, command):
    command_id = command.get('id')
    try:
        action = action_payload(command.get('action'))
        log('action', id=command_id, action=action)
        result = {'id': command_id, 'ok': True, 'receipt': backend.execute(action)}
    except Exception as error:  # Report every failure; the gateway never retries automatically.
        result = {'id': command_id, 'ok': False, 'error': str(error)[:2000] or 'Action failed; outcome unknown'}
    log('result', id=command_id, ok=result['ok'], error=result.get('error'))
    gateway.call('POST', '/rig/v1/results', result)


def run(gateway, backend, fps=2.0):
    stop = threading.Event()
    threading.Thread(target=push_frames, args=(gateway, backend, stop, 1 / fps), daemon=True).start()
    backoff = 1
    log('rig online', backend=backend.name, gateway=gateway.url)
    try:
        while True:
            try:
                status, command = gateway.call('GET', '/rig/v1/commands?wait=25', timeout=35)
                backoff = 1
                if status == 200 and command:
                    handle(gateway, backend, command)
            except HTTPError as error:
                if error.code == 401:
                    raise ValueError('Gateway rejected RIG_TOKEN') from None
                log('poll failed', status=error.code)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
            except (URLError, OSError) as error:
                log('gateway unreachable', error=str(error))
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
    finally:
        stop.set()
        backend.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=BACKENDS, default='sim',
                        help='Actuator: sim (fake phone), mirroring, stylus, or none (view-only)')
    parser.add_argument('--screen', choices=sorted(SCREENS),
                        help='Frame source: mirroring (default for mirroring/stylus) or camera (default for none)')
    parser.add_argument('--camera-device', help='Camera uniqueID or name substring (see .build/camera-capture --list)')
    parser.add_argument('--gateway', default=os.environ.get('GATEWAY_URL', 'http://127.0.0.1:8787'))
    parser.add_argument('--fps', type=float, default=2.0)
    args = parser.parse_args()
    try:
        gateway = Gateway(args.gateway, os.environ.get('RIG_TOKEN', ''))
        if not 0.2 <= args.fps <= 10:
            raise ValueError('--fps must be between 0.2 and 10')
        run(gateway, build_backend(args.backend, args.screen, args.camera_device), args.fps)
    except KeyboardInterrupt:
        return 0
    except ValueError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
