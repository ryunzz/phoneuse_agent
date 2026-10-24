import hashlib
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from episodes import EpisodeRecorder, action_payload, annotate, events, export


class FakePhone:
    def __init__(self):
        self.count = 0
        self.fail_after = False

    def snapshot(self, after=None, timeout=5):
        if after is not None and self.fail_after:
            raise ValueError('capture stopped')
        self.count += 1
        return ({'frames': self.count, 'captured_at': time.time(), 'capture_started_at': time.time(),
                 'width': 400, 'height': 800, 'source': 'test'}, f'frame-{self.count}'.encode())


class EpisodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'episodes'
        self.phone = FakePhone()
        self.sent = []
        self.recorder = EpisodeRecorder(self.phone, self.root, self.dispatch)

    def dispatch(self, action, frame):
        # Evidence must be durable before any interaction is dispatched.
        folder = self.recorder.active
        self.assertEqual(events(folder / 'steps.jsonl')[-1]['event'], 'intent')
        self.assertTrue((folder / frame['image']).exists())
        self.sent.append(action)
        return {'status': 'events_posted'}

    def start(self, group='display', split='train'):
        return self.recorder.start('Find brightness', group, split)

    def step(self, label='correct'):
        return self.recorder.step({'type': 'tap', 'x': .2, 'y': .3}, label, settle_seconds=0)

    def test_complete_pair_and_export_no_future_leak(self):
        meta = self.start()
        step = self.step()
        self.assertNotEqual(step['before']['frames'], step['result']['after']['frames'])
        self.assertEqual(step['result']['status'], 'complete')
        self.recorder.finish('success')
        output = Path(self.temp.name) / 'export'
        self.assertEqual(export(self.root, output), {'train': 1, 'eval': 0})
        row = json.loads((output / 'train.jsonl').read_text())
        self.assertEqual(row['episode_id'], meta['episode_id'])
        self.assertEqual(row['history'], [])
        self.assertNotIn('after', row)
        self.assertNotIn('outcome', row)
        self.assertNotIn('note', row)

    def test_failure_after_dispatch_is_unknown_and_not_exported(self):
        self.start()
        self.phone.fail_after = True
        result = self.step()
        self.assertEqual(result['result']['status'], 'failed_or_unknown')
        self.assertEqual(len(self.sent), 1)
        self.recorder.finish('success')
        self.assertEqual(export(self.root, Path(self.temp.name) / 'out')['train'], 0)

    def test_stale_before_never_dispatches(self):
        self.start()
        self.phone.snapshot = lambda **kwargs: (_ for _ in ()).throw(ValueError('stale'))
        with self.assertRaises(ValueError):
            self.step()
        self.assertEqual(self.sent, [])

    def test_reviews_do_not_modify_trace_and_bad_actions_are_not_targets(self):
        self.start()
        self.step('unreviewed')
        self.step('mistake')
        self.step('recovery')
        folder = self.recorder.active
        original = (folder / 'steps.jsonl').read_bytes()
        annotate(folder, 1, 'correct', 'reviewer', boxes=[{'label': 'Settings', 'x1': .1, 'y1': .1, 'x2': .2, 'y2': .2}])
        self.assertEqual((folder / 'steps.jsonl').read_bytes(), original)
        self.recorder.finish('success')
        output = Path(self.temp.name) / 'out'
        self.assertEqual(export(self.root, output)['train'], 2)
        rows = events(output / 'train.jsonl')
        self.assertEqual([r['step'] for r in rows], [1, 3])
        self.assertEqual(len(rows[1]['history']), 2)
        self.assertNotIn('label', rows[1]['history'][0])

    def test_group_leakage_rejected(self):
        self.start()
        self.recorder.finish('success')
        self.start(split='eval')
        self.recorder.finish('success')
        with self.assertRaisesRegex(ValueError, 'appears in train and eval'):
            export(self.root, Path(self.temp.name) / 'out')

    def test_interruption_and_unfinished_episodes_excluded(self):
        self.start()
        self.step()
        self.assertEqual(export(self.root, Path(self.temp.name) / 'out')['train'], 0)
        append_path = self.recorder.active / 'steps.jsonl'
        with append_path.open('a') as out:
            out.write(json.dumps({'event': 'intent', 'step': 2}) + '\n' + '{broken')
        self.recorder.finish('success')
        self.assertEqual(export(self.root, Path(self.temp.name) / 'out')['train'], 0)

    def test_image_tampering_rejected(self):
        self.start()
        self.step()
        (self.recorder.active / '00001-before.jpg').write_bytes(b'changed')
        self.recorder.finish('success')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            export(self.root, Path(self.temp.name) / 'out')

    def test_invalid_inputs(self):
        for action in ({'type': 'tap', 'x': float('nan'), 'y': 0}, {'type': 'wait', 'seconds': -1},
                       {'type': 'tap', 'x': True, 'y': .5}, {'type': 'home', 'extra': 1}):
            with self.assertRaises(ValueError):
                action_payload(action)

    def test_concurrent_steps_are_serialized(self):
        self.start()
        errors = []
        def run():
            try:
                self.step()
            except Exception as error:
                errors.append(error)
        threads = [threading.Thread(target=run) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        log = events(self.recorder.active / 'steps.jsonl')
        self.assertEqual([(r['event'], r['step']) for r in log],
                         [('intent', 1), ('result', 1), ('intent', 2), ('result', 2), ('intent', 3), ('result', 3)])
