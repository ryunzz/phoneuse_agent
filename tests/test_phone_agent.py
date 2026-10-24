import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from episodes import EpisodeRecorder, events, export
from phone_agent import PhoneAgent


class Phone:
    def snapshot(self, **kwargs):
        return {'frames': 1, 'source': 'test', 'captured_at': time.time()}, b'jpeg'


class PhoneAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sent = []
        self.phone = Phone()
        self.recorder = EpisodeRecorder(self.phone, Path(self.temp.name),
                                       lambda action, frame: self.sent.append(action))
        self.agent = PhoneAgent(self.phone, self.recorder)
        meta = self.recorder.start('Read Settings', 'test')
        self.agent.folder = self.recorder.active
        self.agent.actions, self.agent.seen_at = 0, None

    def test_requires_observation_before_each_action(self):
        with self.assertRaisesRegex(ValueError, 'screenshot'):
            self.agent.act({'type': 'home'})
        screenshot = self.agent.screenshot()
        self.assertEqual(screenshot['content'][1]['type'], 'image')
        self.agent.act({'type': 'home'})
        with self.assertRaisesRegex(ValueError, 'screenshot'):
            self.agent.act({'type': 'home'})
        self.assertEqual(self.sent, [{'type': 'home'}])
        self.assertEqual(events(self.agent.folder / 'steps.jsonl')[0]['label'], 'unreviewed')

    def test_stop_blocks_all_following_tools(self):
        self.agent.screenshot()
        self.agent.stop()
        with self.assertRaisesRegex(ValueError, 'stopped'):
            self.agent.act({'type': 'home'})
        with self.assertRaisesRegex(ValueError, 'stopped'):
            self.agent.screenshot()
        self.assertEqual(self.sent, [])

    def test_unknown_dispatch_stops_without_retry(self):
        def fail(action, frame):
            self.sent.append(action)
            raise ValueError('connection lost')
        self.recorder.executor = fail
        self.agent.screenshot()
        with self.assertRaisesRegex(ValueError, 'unknown'):
            self.agent.act({'type': 'home'})
        with self.assertRaises(ValueError):
            self.agent.act({'type': 'home'})
        self.assertEqual(len(self.sent), 1)

    def test_stop_during_before_capture_blocks_dispatch(self):
        self.agent.screenshot()
        snapshot = self.phone.snapshot
        def stop_during_capture(**kwargs):
            self.agent.stop()
            return snapshot(**kwargs)
        self.phone.snapshot = stop_during_capture
        with self.assertRaisesRegex(ValueError, 'unknown'):
            self.agent.act({'type': 'home'})
        self.assertEqual(self.sent, [])

    def test_budget_and_stale_observation_do_not_dispatch(self):
        self.agent.screenshot()
        self.agent.seen_at -= 31
        with self.assertRaisesRegex(ValueError, 'screenshot'):
            self.agent.act({'type': 'home'})
        self.agent.actions = 20
        with self.assertRaisesRegex(ValueError, 'limit'):
            self.agent.act({'type': 'home'})
        self.assertEqual(self.sent, [])

    def test_completed_agent_run_is_not_training_success(self):
        with patch.object(self.agent, 'run', new=AsyncMock()):
            self.agent.work('Read Settings')
        self.assertEqual(self.agent.status()['status'], 'completed')
        self.assertIsNone(self.recorder.active)
        self.assertEqual(events(self.agent.folder / 'outcome.jsonl')[0]['outcome'], 'abandoned')
        self.assertEqual(export(self.recorder.root, Path(self.temp.name) / 'export')['train'], 0)

    def test_failure_releases_recorder_and_reports_error(self):
        with patch.object(self.agent, 'run', new=AsyncMock(side_effect=RuntimeError('SDK unavailable'))):
            self.agent.work('Read Settings')
        self.assertEqual(self.agent.status()['status'], 'failed')
        self.assertIsNone(self.recorder.active)
        self.assertIn('SDK unavailable', json.dumps(self.agent.status()))

    @unittest.skipUnless(importlib.util.find_spec('claude_agent_sdk'), 'Optional Claude SDK not installed')
    def test_existing_manual_episode_cannot_be_taken_over(self):
        with patch('shutil.which', return_value='/fake/claude'), self.assertRaisesRegex(ValueError, 'active episode'):
            self.agent.start('New task')

    def test_sdk_uses_only_harness_tools_and_receives_images(self):
        try:
            import claude_agent_sdk as sdk
        except ImportError:
            self.skipTest('Optional Claude SDK not installed')
        captured = {}
        class Client:
            def __init__(self, options):
                captured['options'] = options
            async def __aenter__(self):
                return self
            async def __aexit__(self, *args):
                pass
            async def query(self, instruction):
                captured['instruction'] = instruction
            async def receive_response(self):
                tools = captured['options'].mcp_servers['phone']['tools']
                result = await tools[0].handler({})
                self_outer.assertEqual(result['content'][1]['mimeType'], 'image/jpeg')
                yield sdk.ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1,
                    is_error=False, num_turns=1, session_id='test', result='Observed screen')
        self_outer = self
        with patch.object(sdk, 'ClaudeSDKClient', Client), patch.object(sdk, 'create_sdk_mcp_server',
                side_effect=lambda name, tools: {'tools': tools}):
            asyncio.run(self.agent.run('Read the screen'))
        options = captured['options']
        self.assertEqual(options.tools, [])
        self.assertTrue(options.strict_mcp_config)
        self.assertEqual(options.setting_sources, [])
        self.assertEqual(options.allowed_tools, ['mcp__phone__screenshot', 'mcp__phone__act'])
        self.assertEqual(asyncio.run(options.can_use_tool('Bash', {}, None)).behavior, 'deny')
