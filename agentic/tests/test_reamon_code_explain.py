from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
for path in (str(REPO_ROOT), str(REPO_ROOT / 'agentic')):
    if path not in sys.path:
        sys.path.insert(0, path)


@pytest.fixture(scope='module')
def api():
    @asynccontextmanager
    async def fake_lifespan(_app):
        yield

    with patch('api.lifespan', fake_lifespan):
        import api as api_module
    return api_module


class _Answer:
    content = '<think>private reasoning</think>\nThis method reads the current state and returns it.'


class _Llm:
    messages = None

    async def ainvoke(self, messages):
        self.messages = messages
        return _Answer()


def test_code_explanation_uses_the_exact_saved_provider(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)
    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    llm = _Llm()
    with patch.object(api, 'fetch_user_providers', return_value=[provider]) as fetch, \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=llm) as setup:
        response = TestClient(api.app).post('/reamon/code/explain', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'MainActivity.onCreate',
            'language': 'Java', 'source_code': 'return state.value;', 'question': 'What is returned?',
        })

    assert response.status_code == 200, response.text
    assert response.json() == {
        'explanation': 'This method reads the current state and returns it.',
        'source_truncated': False,
        'model_used': 'custom/provider-1',
    }
    fetch.assert_called_once_with('user-1')
    assert setup.call_args.kwargs['custom_llm_config'] == provider
    assert 'DECOMPILED_SOURCE' in llm.messages[1].content
    assert 'USER_QUESTION' in llm.messages[1].content


def test_code_explanation_rejects_oversized_source_before_loading_provider(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)
    with patch.object(api, 'fetch_user_providers') as fetch:
        response = TestClient(api.app).post('/reamon/code/explain', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'LargeUnit',
            'source_code': 'x' * (64 * 1024 + 1),
        })

    assert response.status_code == 413
    fetch.assert_not_called()
