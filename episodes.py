"""Local demonstration storage and model-neutral JSONL export."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent


def append(path, item):
    with path.open('a', encoding='utf-8') as out:
        out.write(json.dumps(item, ensure_ascii=False, allow_nan=False) + '\n')
        out.flush()
        os.fsync(out.fileno())


def text(value, name, limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{name} must be nonempty text, at most {limit} characters')
    return value.strip()


def number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'Expected number between {low} and {high}')
    return value


def action_payload(value):
    if not isinstance(value, dict):
        raise ValueError('Expected action object')
    kind = value.get('type')
    fields = {'tap': {'x', 'y'}, 'scroll': {'x', 'y', 'dy'}, 'type': {'text'}, 'wait': {'seconds'}, 'home': set()}
    if kind not in fields or set(value) != fields[kind] | {'type'}:
        raise ValueError('Invalid action type or fields')
    result = dict(value)
    if kind in ('tap', 'scroll'):
        for key in ('x', 'y'):
            result[key] = number(value[key], 0, 1)
    if kind == 'scroll':
        result['dy'] = number(value['dy'], -1000, 1000)
    if kind == 'type':
        result['text'] = text(value['text'], 'Typed text', 500)
    if kind == 'wait':
        result['seconds'] = number(value['seconds'], 0, 30)
    return result


def dispatch(action, frame):
    if action['type'] == 'wait':
        time.sleep(action['seconds'])
        return {'status': 'wait_completed'}
    if frame.get('source') != 'iPhone Mirroring window':
        raise ValueError('Camera actions need a calibrated phone-screen mapping and action adapter')
    binary = ROOT / '.build' / 'phone-action'
    if not binary.exists():
        raise ValueError('Build PhoneAction.swift before recording phone actions')
    try:
        result = subprocess.run([str(binary)], input=json.dumps({'action': action, 'frame': frame}),
                                text=True, capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise ValueError('Phone action timed out; outcome unknown; do not retry automatically') from None
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'Phone dispatch failed or outcome unknown')
    return json.loads(result.stdout)


class EpisodeRecorder:
    def __init__(self, phone, folder=None, executor=dispatch):
        self.phone = phone
        self.root = Path(folder or ROOT / 'demonstrations')
        self.executor = executor
        self.lock = threading.Lock()
        self.active = None
        self.sequence = 0

    def start(self, instruction, group, split='train'):
        instruction = text(instruction, 'Instruction')
        group = text(group, 'Task family / evaluation group', 200)
        if split not in ('train', 'eval'):
            raise ValueError('Split must be train or eval')
        with self.lock:
            if self.active:
                raise ValueError('Finish the active episode first')
            # Explicit episode start is the operator assertion that the actual phone is visible.
            self.phone.snapshot(timeout=1)
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            episode = uuid.uuid4().hex
            folder = self.root / episode
            folder.mkdir(mode=0o700)
            metadata = {'schema_version': 1, 'episode_id': episode, 'instruction': instruction,
                        'group': group, 'split': split, 'started_at': time.time()}
            (folder / 'episode.json').write_text(json.dumps(metadata, indent=2))
            self.active, self.sequence = folder, 0
            return metadata

    def status(self):
        with self.lock:
            return {'episode_id': self.active.name if self.active else None, 'steps': self.sequence}

    def image(self, folder, step, phase, snapshot):
        metadata, data = snapshot
        name = f'{step:05d}-{phase}.jpg'
        (folder / name).write_bytes(data)
        return dict(metadata, image=name, sha256=hashlib.sha256(data).hexdigest())

    def step(self, action, label='unreviewed', note='', settle_seconds=0.7, before_dispatch=None):
        action = action_payload(action)
        if label not in ('unreviewed', 'correct', 'mistake', 'recovery'):
            raise ValueError('Invalid step label')
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError('Note must be text up to 2000 characters')
        settle_seconds = number(settle_seconds, 0, 10)
        with self.lock:
            if not self.active:
                raise ValueError('Start an episode first')
            self.sequence += 1
            folder, step = self.active, self.sequence
            before = self.image(folder, step, 'before', self.phone.snapshot(timeout=1))
            intent = {'event': 'intent', 'step': step, 'action': action, 'before': before,
                      'label': label, 'note': note, 'dispatched_at': time.time()}
            append(folder / 'steps.jsonl', intent)
            try:
                if before_dispatch:
                    before_dispatch()
                receipt = self.executor(action, before)
                ended = time.time()
                time.sleep(settle_seconds)
                after = self.image(folder, step, 'after', self.phone.snapshot(after=ended + settle_seconds))
                result = {'event': 'result', 'step': step, 'status': 'complete', 'receipt': receipt,
                          'dispatch_ended_at': ended, 'after': after, 'recorded_at': time.time()}
            except Exception as error:
                result = {'event': 'result', 'step': step, 'status': 'failed_or_unknown',
                          'error': str(error), 'recorded_at': time.time()}
            append(folder / 'steps.jsonl', result)
            return dict(intent, result=result)

    def finish(self, outcome, note=''):
        if outcome not in ('success', 'failed', 'abandoned'):
            raise ValueError('Invalid episode outcome')
        if not isinstance(note, str) or len(note) > 2000:
            raise ValueError('Note must be text up to 2000 characters')
        with self.lock:
            if not self.active:
                raise ValueError('No active episode')
            result = {'outcome': outcome, 'note': note, 'finished_at': time.time()}
            append(self.active / 'outcome.jsonl', result)
            result['episode_id'] = self.active.name
            self.active = None
            return result


def events(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            # A crash can leave a truncated final line. Never export past it.
            break
    return rows


def annotate(folder, step, label, reviewer, note='', boxes=None):
    folder = Path(folder)
    if not (folder / 'episode.json').exists():
        raise ValueError('Episode not found')
    if label not in ('correct', 'mistake', 'recovery', 'unreviewed'):
        raise ValueError('Invalid step label')
    if not isinstance(step, int) or isinstance(step, bool) or step < 1:
        raise ValueError('Invalid step number')
    if not any(row.get('step') == step and row.get('event') == 'intent' for row in events(folder / 'steps.jsonl')):
        raise ValueError('Step not found')
    boxes = boxes or []
    if not isinstance(boxes, list) or len(boxes) > 100:
        raise ValueError('Expected up to 100 bounding boxes')
    for box in boxes:
        text(box.get('label'), 'Box label', 200)
        for key in ('x1', 'y1', 'x2', 'y2'):
            number(box.get(key), 0, 1)
        if box['x1'] >= box['x2'] or box['y1'] >= box['y2']:
            raise ValueError('Bounding box must have positive area')
    if not isinstance(note, str) or len(note) > 2000:
        raise ValueError('Invalid annotation note')
    row = {'step': step, 'label': label, 'reviewer': text(reviewer, 'Reviewer', 200),
           'note': note, 'boxes': boxes, 'coordinate_space': 'before_image_normalized', 'at': time.time()}
    append(folder / 'annotations.jsonl', row)
    return row


def export(root, destination, history_limit=4):
    root, destination = Path(root).resolve(), Path(destination)
    episodes, groups = [], {}
    for folder in sorted(root.iterdir()):
        if not (folder / 'episode.json').exists():
            continue
        meta = json.loads((folder / 'episode.json').read_text())
        group, split = meta['group'], meta['split']
        if group in groups and groups[group] != split:
            raise ValueError(f'Task group {group!r} appears in train and eval; assign the entire group to one split')
        groups[group] = split
        episodes.append((folder, meta))
    rows = {'train': [], 'eval': []}
    for folder, meta in episodes:
        outcomes = events(folder / 'outcome.jsonl')
        if not outcomes or outcomes[-1]['outcome'] != 'success':
            continue
        log = events(folder / 'steps.jsonl')
        intents = {r['step']: r for r in log if r['event'] == 'intent'}
        results = {r['step']: r for r in log if r['event'] == 'result'}
        if any(s not in results or results[s]['status'] != 'complete' for s in intents):
            continue
        labels = {r['step']: r for r in events(folder / 'annotations.jsonl')}
        history = []
        for step, intent in intents.items():
            label = labels.get(step, intent)['label']
            before = intent['before']
            image_path = folder / before['image']
            after = results[step]['after']
            for frame in (before, after):
                image = folder / frame['image']
                if hashlib.sha256(image.read_bytes()).hexdigest() != frame['sha256']:
                    raise ValueError(f'Image integrity failed: {image}')
            if label in ('correct', 'recovery'):
                rows[meta['split']].append({'episode_id': meta['episode_id'], 'step': step,
                    'instruction': meta['instruction'], 'image': str(image_path),
                    'history': history[-history_limit:], 'target_action': intent['action'],
                    'label': label})
            history.append({'action': intent['action']})
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    for split, values in rows.items():
        target = destination / f'{split}.jsonl'
        temporary = target.with_suffix('.tmp')
        temporary.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in values))
        temporary.replace(target)
    return {key: len(value) for key, value in rows.items()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    exp = sub.add_parser('export')
    exp.add_argument('--root', default=str(ROOT / 'demonstrations'))
    exp.add_argument('--output', required=True)
    lab = sub.add_parser('label')
    lab.add_argument('episode')
    lab.add_argument('step', type=int)
    lab.add_argument('label', choices=['correct', 'mistake', 'recovery', 'unreviewed'])
    lab.add_argument('--reviewer', required=True)
    lab.add_argument('--note', default='')
    lab.add_argument('--boxes', help='JSON file containing normalized before-image bounding boxes')
    args = parser.parse_args()
    if args.command == 'export':
        print(json.dumps(export(args.root, args.output)))
    else:
        print(json.dumps(annotate(args.episode, args.step, args.label, args.reviewer, args.note,
                                 json.loads(Path(args.boxes).read_text()) if args.boxes else [])))
