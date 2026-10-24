#!/usr/bin/env python3
"""Local printer command harness. Standard library only; defaults to simulation."""
import argparse
import json
import math
import os
from pathlib import Path
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler

from voice import interpret

ROOT = Path(__file__).resolve().parent
HELP = 'status | temperatures | home [x y z] | jog x 5 | heat nozzle 200 | heat bed 60 | cooldown | pause | resume | cancel'


def parse(text):
    if not isinstance(text, str) or len(text) > 200:
        raise ValueError('Command must be text of at most 200 characters')
    words = text.lower().strip().split()
    if words and words[-1] in ('degrees', 'celsius', 'millimeters', 'mm'):
        words.pop()
    if len(words) == 1 and words[0] in ('status', 'temperatures', 'cooldown', 'pause', 'resume', 'cancel'):
        return {'action': words[0]}
    if words and words[0] == 'home' and all(w in ('x', 'y', 'z') for w in words[1:]):
        return {'action': 'home', 'axes': sorted(set(words[1:] or ['x', 'y', 'z']))}
    if len(words) == 3 and words[0] in ('jog', 'heat'):
        try:
            number = float(words[2])
        except ValueError:
            raise ValueError('Use a numeric value, for example: jog x 5') from None
        if not math.isfinite(number):
            raise ValueError('Value must be finite')
        if words[0] == 'jog' and words[1] in ('x', 'y', 'z') and 0 < abs(number) <= 10:
            return {'action': 'jog', 'axis': words[1], 'mm': number}
        if words[0] == 'heat' and words[1] in ('nozzle', 'bed'):
            maximum = 240 if words[1] == 'nozzle' else 100
            if 0 <= number <= maximum:
                return {'action': 'heat', 'heater': words[1], 'celsius': number}
        raise ValueError('Jog: nonzero +/-10 mm maximum. Nozzle: 0–240 C. Bed: 0–100 C.')
    raise ValueError('Unknown command. ' + HELP)


def operations(command):
    action = command['action']
    if action in ('status', 'temperatures'):
        return [('GET', '/api/printer', None)]
    if action == 'home':
        return [('POST', '/api/printer/printhead', {'command': 'home', 'axes': command['axes']})]
    if action == 'jog':
        return [('POST', '/api/printer/printhead', {'command': 'jog', command['axis']: command['mm'], 'absolute': False, 'speed': 300})]
    if action == 'heat':
        heater = command['heater']
        body = {'command': 'target', 'targets': {'tool0': command['celsius']}} if heater == 'nozzle' else {'command': 'target', 'target': command['celsius']}
        return [('POST', '/api/printer/' + ('tool' if heater == 'nozzle' else 'bed'), body)]
    if action == 'cooldown':
        return operations({'action': 'heat', 'heater': 'nozzle', 'celsius': 0}) + operations({'action': 'heat', 'heater': 'bed', 'celsius': 0})
    body = {'command': 'pause', 'action': action} if action in ('pause', 'resume') else {'command': 'cancel'}
    return [('POST', '/api/job', body)]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Harness:
    def __init__(self, live=False, motion_ready=False, audit=None):
        self.live = live
        self.motion_ready = motion_ready
        self.audit = Path(audit or ROOT / 'events.jsonl')
        self.lock = threading.Lock()
        self.bridge = shlex.split(os.environ.get('PRINTER_BRIDGE', ''))
        self.url = os.environ.get('OCTOPRINT_URL', '').rstrip('/')
        self.key = os.environ.get('OCTOPRINT_API_KEY', '')
        if live and not self.bridge:
            parsed = urlparse(self.url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or not self.key:
                raise ValueError('Live mode requires PRINTER_BRIDGE or OCTOPRINT_URL and OCTOPRINT_API_KEY')

    def request(self, method, path, body):
        req = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={'X-Api-Key': self.key, 'Content-Type': 'application/json'}, method=method)
        try:
            with build_opener(NoRedirect()).open(req, timeout=10) as response:
                data = response.read(1_000_000)
                return json.loads(data) if data else {'accepted': True}
        except HTTPError as error:
            raise ValueError(f'Controller returned HTTP {error.code}; inspect controller state before retrying') from None
        except (URLError, TimeoutError, OSError):
            raise ValueError('Controller connection failed; outcome may be unknown. Check status before retrying.') from None

    def run(self, text, execute=False):
        command = parse(text)
        read_only = command['action'] in ('status', 'temperatures')
        plan = {'command': command, 'mode': 'live' if self.live else 'simulation', 'operations': operations(command)}
        if not read_only and not execute:
            return {**plan, 'outcome': 'preview', 'requires_confirmation': True}
        with self.lock:
            event = {**plan, 'id': secrets.token_hex(8), 'timestamp': time.time()}
            # Write intent before touching hardware; failure to audit blocks dispatch.
            self.log({**event, 'outcome': 'dispatching'})
            try:
                if not self.live:
                    result = {'simulated': True, 'note': 'No printer contacted'}
                elif command['action'] == 'jog' and not self.motion_ready:
                    raise ValueError('Jog disabled. Home and verify clearance on the printer, then launch with --motion-ready.')
                elif self.bridge:
                    # Fixed operator-configured argv, never a shell or model-generated executable.
                    proc = subprocess.run(self.bridge, input=json.dumps(command), text=True, capture_output=True, timeout=20)
                    if proc.returncode:
                        raise ValueError('Bridge failed; inspect controller state before retrying')
                    result = json.loads(proc.stdout)
                    if not isinstance(result, dict) or result.get('ok') is not True:
                        raise ValueError('Bridge must return a JSON object with ok: true')
                else:
                    if command['action'] in ('home', 'jog', 'heat'):
                        state = self.request('GET', '/api/printer', None)
                        flags = state.get('state', {}).get('flags', {})
                        if flags.get('operational') is not True or any(flags.get(k) for k in ('printing', 'paused', 'pausing', 'cancelling', 'error', 'closedOrError')) or flags.get('ready') is not True:
                            raise ValueError('Printer must report ready and idle before motion or heating')
                    result = []
                    for method, path, body in operations(command):
                        result.append(self.request(method, path, body))
                event.update(outcome='simulated' if not self.live else ('observed' if read_only else 'submitted'), result=result)
            except Exception as error:
                event.update(outcome='failed_or_unknown', error=str(error) if isinstance(error, ValueError) else 'Controller/bridge failed; check actual state before retrying')
            self.log(event)
            return event

    def log(self, event):
        with self.audit.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(event) + '\n')
            stream.flush()
            os.fsync(stream.fileno())


def serve(harness, port, iphone=False):
    from speech import Speech
    from phone_stream import PhoneStream
    from episodes import EpisodeRecorder
    from phone_agent import PhoneAgent
    from review import ReviewDashboard
    speech = Speech()
    phone = PhoneStream()
    episodes = EpisodeRecorder(phone)
    agent = PhoneAgent(phone, episodes)
    reviews = ReviewDashboard(episodes.root)
    if iphone:
        phone.start()
    token = secrets.token_urlsafe(32)
    pending = {}
    pending_lock = threading.Lock()
    origin = f'http://127.0.0.1:{port}'

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, code, payload, content_type='application/json'):
            data = payload if isinstance(payload, bytes) else payload.encode() if isinstance(payload, str) else json.dumps(payload).encode()
            self.send_response(code)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.headers.get('Host') != f'127.0.0.1:{port}':
                return self.reply(404, {'error': 'Not found'})
            path = urlparse(self.path).path
            if path.startswith('/admin/api/'):
                if self.headers.get('X-Harness-Token') != token:
                    return self.reply(403, {'error': 'Local console authentication required'})
                try:
                    query = parse_qs(urlparse(self.path).query)
                    episode_id = query.get('episode', [''])[0]
                    if path == '/admin/api/summary':
                        return self.reply(200, reviews.summary())
                    if path == '/admin/api/episode':
                        return self.reply(200, reviews.episode(episode_id))
                    if path == '/admin/api/image':
                        return self.reply(200, reviews.image(episode_id, query.get('name', [''])[0]), 'image/jpeg')
                    return self.reply(404, {'error': 'Not found'})
                except (ValueError, KeyError, TypeError, OSError):
                    return self.reply(400, {'error': 'Episode data unavailable or invalid'})
            if path == '/agent/status':
                return self.reply(200, agent.status())
            if path == '/iphone/episode':
                return self.reply(200, episodes.status())
            if path == '/iphone/status':
                return self.reply(200, phone.status())
            if path == '/iphone/frame.jpg':
                try:
                    return self.reply(200, phone.frame(), 'image/jpeg')
                except ValueError as error:
                    return self.reply(503, {'error': str(error)})
            if path == '/admin':
                return self.reply(200, (ROOT / 'admin.html').read_text().replace('__TOKEN__', token), 'text/html; charset=utf-8')
            if path not in ('/', '/controller'):
                return self.reply(404, {'error': 'Not found'})
            self.reply(200, (ROOT / 'console.html').read_text().replace('__TOKEN__', token), 'text/html; charset=utf-8')

        def do_POST(self):
            if self.headers.get('Host') != f'127.0.0.1:{port}' or self.headers.get('Origin') != origin or self.headers.get('X-Harness-Token') != token:
                return self.reply(403, {'error': 'Local console authentication required'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self.path == '/transcribe':
                    if not 0 < size <= 4_000_000:
                        raise ValueError('Recording must be at most 4 MB')
                    if self.headers.get('Content-Type', '').split(';')[0] not in ('audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'):
                        raise ValueError('Unsupported recording format')
                    return self.reply(200, speech.transcribe(self.rfile.read(size)))
                if not 0 < size <= (16384 if self.path == '/agent/start' else 4096):
                    raise ValueError('Invalid request size')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError('Expected JSON object')
                if self.path == '/admin/api/review':
                    return self.reply(200, reviews.label(body.get('episode_id'), body.get('step'),
                                                        body.get('label'), body.get('reviewer'), body.get('note', '')))
                if self.path == '/agent/start':
                    return self.reply(200, agent.start(body.get('instruction')))
                if self.path == '/agent/stop':
                    return self.reply(200, agent.stop())
                if self.path.startswith('/iphone/episode/'):
                    with agent.lock:
                        if agent.status()['running']:
                            raise ValueError('Stop the Claude task before using manual controls')
                        if self.path == '/iphone/episode/start':
                            return self.reply(200, episodes.start(body.get('instruction'), body.get('group'), body.get('split', 'train')))
                        if self.path == '/iphone/episode/action':
                            return self.reply(200, episodes.step(body.get('action'), body.get('label', 'unreviewed'), body.get('note', ''), body.get('settle_seconds', 0.7)))
                        if self.path == '/iphone/episode/finish':
                            return self.reply(200, episodes.finish(body.get('outcome'), body.get('note', '')))
                if self.path in ('/preview', '/prompt'):
                    command = interpret(body.get('prompt')) if self.path == '/prompt' else body.get('command')
                    plan = harness.run(command)
                    if self.path == '/prompt':
                        plan.update(prompt=body['prompt'], interpreted_command=command)
                    if plan.get('requires_confirmation'):
                        confirmation = secrets.token_urlsafe(24)
                        with pending_lock:
                            pending.clear()
                            pending[confirmation] = (command, time.monotonic() + 30)
                        plan['confirmation'] = confirmation
                    return self.reply(200, plan)
                if self.path == '/execute':
                    with pending_lock:
                        item = pending.pop(body.get('confirmation', ''), None)
                    if not item or time.monotonic() > item[1]:
                        raise ValueError('Preview expired or already used; preview again')
                    return self.reply(200, harness.run(item[0], execute=True))
                self.reply(404, {'error': 'Not found'})
            except (ValueError, TypeError, OSError, ImportError) as error:
                self.reply(400, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    print(f'Printer console: {origin} ({"LIVE" if harness.live else "SIMULATION"})', flush=True)
    try:
        server.serve_forever()
    finally:
        agent.stop()
        if agent.thread:
            agent.thread.join(timeout=20)
        phone.stop()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=HELP)
    parser.add_argument('--live', action='store_true', help='Enable configured hardware transport')
    parser.add_argument('--motion-ready', action='store_true', help='Operator has verified homing and clearance; enable bounded jogs')
    parser.add_argument('--execute', action='store_true', help='Explicitly dispatch a mutating command')
    parser.add_argument('--serve', action='store_true', help='Open local command/voice console server')
    parser.add_argument('--iphone', action='store_true', help='Capture iPhone Mirroring screen at approximately 2 fps (requires macOS screen capture permission)')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--agent', action='store_true', help='Read JSON lines: {"command":"status","execute":false}')
    parser.add_argument('--prompt', action='store_true', help='Interpret a spoken-style prompt before validation')
    parser.add_argument('command', nargs='*')
    args = parser.parse_args()
    voice_venv = ROOT / '.venv-voice'
    voice_python = voice_venv / 'bin' / 'python'
    if args.serve and voice_python.is_file() and Path(sys.prefix).resolve() != voice_venv.resolve():
        os.execv(str(voice_python), [str(voice_python), str(Path(__file__).resolve()), *sys.argv[1:]])
    try:
        harness = Harness(args.live, args.motion_ready)
        if args.serve:
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            serve(harness, args.port, args.iphone)
        elif args.agent:
            for line in sys.stdin:
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict) or not isinstance(request.get('execute', False), bool):
                        raise ValueError('Expected object with command and boolean execute')
                    if 'prompt' in request and 'command' in request:
                        raise ValueError('Provide prompt or command, not both')
                    command = interpret(request['prompt']) if 'prompt' in request else request.get('command')
                    result = harness.run(command, request.get('execute', False))
                    if 'prompt' in request:
                        result.update(prompt=request['prompt'], interpreted_command=command)
                except (ValueError, TypeError) as error:
                    result = {'error': str(error)}
                print(json.dumps(result), flush=True)
        else:
            command = ' '.join(args.command) or 'status'
            result = harness.run(interpret(command) if args.prompt else command, args.execute)
            print(json.dumps(result, indent=2))
            if result.get('outcome') == 'failed_or_unknown':
                return 1
    except KeyboardInterrupt:
        return 0
    except (ValueError, OSError) as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
