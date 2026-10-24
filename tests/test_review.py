import json
from pathlib import Path
import tempfile
import unittest

from episodes import append, events
from review import ReviewDashboard


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dashboard = ReviewDashboard(self.root)
        self.id = 'a' * 32
        self.folder = self.root / self.id
        self.folder.mkdir()
        (self.folder / 'episode.json').write_text(json.dumps({
            'instruction': 'Change text size', 'group': 'display', 'split': 'train', 'started_at': 1}))
        append(self.folder / 'steps.jsonl', {'event': 'intent', 'step': 1,
               'action': {'type': 'home'}, 'label': 'unreviewed'})
        append(self.folder / 'steps.jsonl', {'event': 'result', 'step': 1, 'status': 'complete'})

    def test_review_stats_and_original_trace_preserved(self):
        before = (self.folder / 'steps.jsonl').read_bytes()
        with self.assertRaisesRegex(ValueError, 'Finish'):
            self.dashboard.label(self.id, 1, 'correct', 'Sam')
        append(self.folder / 'outcome.jsonl', {'outcome': 'success'})
        self.assertEqual(self.dashboard.summary()['stats']['pending_steps'], 1)
        self.dashboard.label(self.id, 1, 'correct', 'Sam', 'Verified')
        stats = self.dashboard.summary()['stats']
        self.assertEqual(stats['pending_steps'], 0)
        self.assertEqual(stats['reviewed_steps'], 1)
        self.assertEqual(stats['reported_success'], 1)
        self.assertEqual(self.dashboard.episode(self.id)['steps'][0]['reviewer'], 'Sam')
        self.assertEqual((self.folder / 'steps.jsonl').read_bytes(), before)
        self.dashboard.label(self.id, 1, 'unreviewed', 'Sam')
        self.assertEqual(self.dashboard.summary()['stats']['pending_steps'], 1)
        self.assertEqual(len(events(self.folder / 'annotations.jsonl')), 2)

    def test_incomplete_and_corrupt_episodes_are_visible(self):
        append(self.folder / 'steps.jsonl', {'event': 'intent', 'step': 2,
               'action': {'type': 'home'}, 'label': 'unreviewed'})
        broken = self.root / ('b' * 32)
        broken.mkdir()
        (broken / 'episode.json').write_text('{')
        result = self.dashboard.summary()
        self.assertEqual(result['stats']['incomplete_steps'], 1)
        self.assertEqual(result['stats']['unfinished'], 1)
        self.assertEqual(result['unreadable'], ['b' * 32])

    def test_invalid_paths_and_symlinks_rejected(self):
        for episode in ('../outside', '', None):
            with self.assertRaises(ValueError):
                self.dashboard.episode(episode)
        for name in ('../../README.md', 'episode.json', None):
            with self.assertRaises(ValueError):
                self.dashboard.image(self.id, name)
        (self.folder / '00001-before.jpg').symlink_to(self.folder / 'episode.json')
        with self.assertRaises(ValueError):
            self.dashboard.image(self.id, '00001-before.jpg')
        linked = self.root / ('c' * 32)
        linked.symlink_to(self.folder, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.dashboard.episode(linked.name)

    def test_review_requires_valid_step_label_and_reviewer(self):
        append(self.folder / 'outcome.jsonl', {'outcome': 'success'})
        for step, label, reviewer in ((99, 'correct', 'Sam'), (True, 'correct', 'Sam'),
                                      (1, 'approved', 'Sam'), (1, 'correct', '')):
            with self.assertRaises(ValueError):
                self.dashboard.label(self.id, step, label, reviewer)


if __name__ == '__main__':
    unittest.main()
