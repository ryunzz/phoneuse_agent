"""Read-only episode summaries and append-only human step reviews."""
import json
import re
import threading
from pathlib import Path

from episodes import annotate, events


class ReviewDashboard:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.Lock()

    def folder(self, episode_id):
        if not isinstance(episode_id, str) or not re.fullmatch(r'[a-f0-9]{32}', episode_id):
            raise ValueError('Invalid episode ID')
        folder = self.root / episode_id
        if folder.is_symlink() or not (folder / 'episode.json').is_file():
            raise ValueError('Episode not found')
        return folder

    def episode(self, episode_id):
        folder = self.folder(episode_id)
        meta = json.loads((folder / 'episode.json').read_text())
        log = events(folder / 'steps.jsonl')
        results = {row['step']: row for row in log if row.get('event') == 'result'}
        labels = {row['step']: row for row in events(folder / 'annotations.jsonl')}
        steps = []
        for intent in log:
            if intent.get('event') != 'intent':
                continue
            result = results.get(intent['step'], {})
            review = labels.get(intent['step'], {})
            steps.append({'step': intent['step'], 'action': intent['action'],
                          'before': intent.get('before'), 'after': result.get('after'),
                          'status': result.get('status', 'incomplete'),
                          'label': review.get('label', intent.get('label', 'unreviewed')),
                          'reviewer': review.get('reviewer', ''), 'note': review.get('note', ''),
                          'error': result.get('error', '')})
        outcomes = events(folder / 'outcome.jsonl')
        return {**meta, 'episode_id': episode_id, 'outcome': outcomes[-1] if outcomes else None,
                'steps': steps}

    def summary(self):
        episodes, errors = [], []
        for folder in sorted(self.root.iterdir()) if self.root.exists() else []:
            if not re.fullmatch(r'[a-f0-9]{32}', folder.name):
                continue
            try:
                episode = self.episode(folder.name)
                steps = episode.pop('steps')
                episode.update(step_count=len(steps),
                               pending=sum(s['label'] == 'unreviewed' for s in steps),
                               incomplete=sum(s['status'] != 'complete' for s in steps),
                               labels={label: sum(s['label'] == label for s in steps)
                                       for label in ('correct', 'mistake', 'recovery', 'unreviewed')})
                episodes.append(episode)
            except (ValueError, KeyError, TypeError, OSError):
                errors.append(folder.name)
        episodes.sort(key=lambda e: e.get('started_at', 0), reverse=True)
        total_steps = sum(e['step_count'] for e in episodes)
        pending = sum(e['pending'] for e in episodes)
        return {'episodes': episodes, 'unreadable': errors,
                'stats': {'episodes': len(episodes), 'steps': total_steps,
                          'pending_steps': pending, 'reviewed_steps': total_steps - pending,
                          'incomplete_steps': sum(e['incomplete'] for e in episodes),
                          'reported_success': sum((e['outcome'] or {}).get('outcome') == 'success' for e in episodes),
                          'unfinished': sum(e['outcome'] is None for e in episodes)}}

    def label(self, episode_id, step, label, reviewer, note=''):
        with self.lock:
            folder = self.folder(episode_id)
            if not events(folder / 'outcome.jsonl'):
                raise ValueError('Finish the episode before reviewing it')
            return annotate(folder, step, label, reviewer, note)

    def image(self, episode_id, name):
        folder = self.folder(episode_id)
        if not isinstance(name, str) or not re.fullmatch(r'\d{5,}-(before|after)\.jpg', name):
            raise ValueError('Invalid image name')
        path = folder / name
        if path.is_symlink():
            raise ValueError('Invalid image path')
        return path.read_bytes()
