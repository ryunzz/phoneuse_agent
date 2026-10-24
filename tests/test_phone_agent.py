import asyncio
import importlib.util
import json
import unittest
from unittest.mock import AsyncMock, patch

from phone_agent import ALLOWED_TOOLS, PhoneAgent, gateway_config

ENV = {'GATEWAY_URL': 'https://gw.example/', 'PHONEUSE_API_KEY': 'pu_test'}
HAS_SDK = importlib.util.find_spec('claude_agent_sdk') is not None


class GatewayConfigTests(unittest.TestCase):
    def test_points_at_gateway_mcp_with_bearer_key(self):
        self.assertEqual(gateway_config(ENV), {'type': 'http', 'url': 'https://gw.example/mcp',
                                               'headers': {'Authorization': 'Bearer pu_test'}})

    def test_rejects_missing_key_and_bad_url(self):
        with self.assertRaisesRegex(ValueError, 'PHONEUSE_API_KEY'):
            gateway_config({'GATEWAY_URL': 'https://gw.example'})
        with self.assertRaisesRegex(ValueError, 'GATEWAY_URL'):
            gateway_config({'GATEWAY_URL': 'file:///etc', 'PHONEUSE_API_KEY': 'pu_x'})

    def test_allowed_tools_are_only_gateway_phone_tools(self):
        self.assertTrue(all(name.startswith('mcp__phoneuse__') for name in ALLOWED_TOOLS))
        self.assertIn('mcp__phoneuse__phone_tap', ALLOWED_TOOLS)
        self.assertNotIn('mcp__phoneuse__usage_get', ALLOWED_TOOLS)


class PhoneAgentTests(unittest.TestCase):
    def setUp(self):
        self.agent = PhoneAgent(ENV)

    def test_start_validates_before_running(self):
        with self.assertRaisesRegex(ValueError, 'Phone task'):
            self.agent.start('   ')
        with self.assertRaisesRegex(ValueError, 'PHONEUSE_API_KEY'):
            PhoneAgent({}).start('Open Settings')
        self.assertFalse(self.agent.status()['running'])

    def test_completed_run_reports_status(self):
        with patch.object(self.agent, 'run', new=AsyncMock()):
            self.agent.work('Read Settings', gateway_config(ENV))
        self.assertEqual(self.agent.status()['status'], 'completed')
        self.assertFalse(self.agent.status()['running'])

    def test_failure_is_reported_not_raised(self):
        with patch.object(self.agent, 'run', new=AsyncMock(side_effect=RuntimeError('SDK unavailable'))):
            self.agent.work('Read Settings', gateway_config(ENV))
        self.assertEqual(self.agent.status()['status'], 'failed')
        self.assertIn('SDK unavailable', json.dumps(self.agent.status()))

    def test_stop_marks_run_stopped(self):
        async def blocked(*args):
            self.agent.stop()
            raise RuntimeError('interrupted')
        with patch.object(self.agent, 'run', new=blocked):
            self.agent.work('Read Settings', gateway_config(ENV))
        self.assertEqual(self.agent.status()['status'], 'stopped')

    @unittest.skipUnless(HAS_SDK, 'Optional Claude SDK not installed')
    def test_sdk_is_locked_to_gateway_tools(self):
        import claude_agent_sdk as sdk
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

            async def interrupt(self):
                pass

            async def receive_response(self):
                yield sdk.ResultMessage(subtype='success', duration_ms=1, duration_api_ms=1, is_error=False,
                                        num_turns=1, session_id='test', result='Observed screen')

        with patch.object(sdk, 'ClaudeSDKClient', Client), patch('shutil.which', return_value='/fake/claude'):
            asyncio.run(self.agent.run('Read the screen', gateway_config(ENV)))
        options = captured['options']
        self.assertEqual(captured['instruction'], 'Read the screen')
        self.assertEqual(options.mcp_servers, {'phoneuse': gateway_config(ENV)})
        self.assertEqual(options.tools, [])
        self.assertTrue(options.strict_mcp_config)
        self.assertEqual(options.setting_sources, [])
        self.assertEqual(options.allowed_tools, ALLOWED_TOOLS)
        self.assertEqual(options.max_budget_usd, 2.0)
        self.assertEqual(asyncio.run(options.can_use_tool('Bash', {}, None)).behavior, 'deny')
        self.assertEqual(self.agent.status()['events'][-1]['text'], 'Observed screen')


if __name__ == '__main__':
    unittest.main()
