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


def test_code_deobfuscation_returns_complete_source_and_uses_exact_provider(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class TransformAnswer:
        content = '<think>private reasoning</think>\n```java\nclass Example { String read() { return accountName; } }\n```'
        response_metadata = {'finish_reason': 'stop'}

    class TransformLlm:
        messages = None

        async def ainvoke(self, messages):
            self.messages = messages
            return TransformAnswer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    llm = TransformLlm()
    with patch.object(api, 'fetch_user_providers', return_value=[provider]) as fetch, \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=llm) as setup:
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'Example',
            'language': 'Java', 'source_code': 'class Example { String read() { return a; } }',
        })

    assert response.status_code == 200, response.text
    assert response.json() == {'source_code': 'class Example { String read() { return accountName; } }', 'syntax_validated': True, 'model_used': 'custom/provider-1'}
    fetch.assert_called_once_with('user-1')
    assert setup.call_args.kwargs['custom_llm_config'] == provider
    assert 'preserve' in llm.messages[0].content.lower()
    assert 'DECOMPILED_SOURCE' in llm.messages[1].content
    assert 'never output these files' in llm.messages[1].content


def test_code_deobfuscation_retries_without_context_after_a_different_java_type(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class WrongTypeLlm:
        messages = []

        async def ainvoke(self, _messages):
            self.messages.append(_messages)
            class Answer:
                content = ('class RelatedHttpResponse { void close() {} }'
                           if len(self.messages) == 1
                           else 'package zc; public interface p { a0 intercept(o value); }')
                response_metadata = {'finish_reason': 'stop'}
            return Answer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    llm = WrongTypeLlm()
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=llm):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'zc.p',
            'language': 'Java', 'source_code': 'package zc; public interface p { a0 intercept(o value); }',
            'context_sources': [{'unit_name': 'zc.a0', 'language': 'Java', 'source_code': 'class a0 {}'}],
        })

    assert response.status_code == 200
    assert response.json()['source_code'] == 'package zc; public interface p { a0 intercept(o value); }'
    assert len(llm.messages) == 2
    assert 'RELATED_DECOMPILED_SOURCE' not in llm.messages[1][1].content


def test_code_deobfuscation_retries_without_optional_context_when_local_model_context_is_too_small(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class Answer:
        content = 'class Example { String read() { return a; } }'
        response_metadata = {'finish_reason': 'stop'}

    class ContextLimitedLlm:
        messages = []

        async def ainvoke(self, messages):
            self.messages.append(messages)
            if len(self.messages) == 1:
                raise RuntimeError('request exceeds the available context size (8192 tokens)')
            return Answer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    llm = ContextLimitedLlm()
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=llm):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'Example',
            'language': 'Java', 'source_code': 'class Example { String read() { return a; } }',
            'context_sources': [{'unit_name': 'ExampleState', 'language': 'Java', 'source_code': 'class ExampleState { String a; }'}],
            'disassembly_source': 'invoke-virtual {v1}, Ljava/lang/String;->length()I',
        })

    assert response.status_code == 200, response.text
    assert response.json()['source_code'] == Answer.content
    assert len(llm.messages) == 2
    assert 'RELATED_DECOMPILED_SOURCE' in llm.messages[0][1].content
    assert 'BYTECODE_EVIDENCE' in llm.messages[0][1].content
    assert 'RELATED_DECOMPILED_SOURCE' not in llm.messages[1][1].content
    assert 'BYTECODE_EVIDENCE' not in llm.messages[1][1].content
    assert 'DECOMPILED_SOURCE' in llm.messages[1][1].content


def test_code_deobfuscation_reports_when_selected_source_alone_exceeds_model_context(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class ContextLimitedLlm:
        async def ainvoke(self, _messages):
            raise RuntimeError('request exceeds the available context size (8192 tokens)')

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=ContextLimitedLlm()):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'Example',
            'language': 'Java', 'source_code': 'class Example { String read() { return a; } }',
            'context_sources': [{'unit_name': 'ExampleState', 'language': 'Java', 'source_code': 'class ExampleState { String a; }'}],
        })

    assert response.status_code == 413
    assert response.json()['code'] == 'context_exceeded'


def test_code_deobfuscation_rejects_a_different_java_type_after_fallback(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class WrongTypeAnswer:
        content = 'class RelatedHttpResponse { void close() {} }'
        response_metadata = {'finish_reason': 'stop'}

    class WrongTypeLlm:
        async def ainvoke(self, _messages):
            return WrongTypeAnswer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=WrongTypeLlm()):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'zc.p',
            'language': 'Java', 'source_code': 'package zc; public interface p { a0 intercept(o value); }',
        })

    assert response.status_code == 422
    assert response.json()['code'] == 'wrong_target'


def test_code_deobfuscation_rejects_model_output_that_does_not_parse(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class InvalidAnswer:
        content = 'class Example { String read() { return accountName;'
        response_metadata = {'finish_reason': 'stop'}

    class InvalidLlm:
        async def ainvoke(self, _messages):
            return InvalidAnswer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=InvalidLlm()):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'Example',
            'language': 'Java', 'source_code': 'class Example { String read() { return a; } }',
        })

    assert response.status_code == 422
    assert response.json()['code'] == 'invalid_source'


def test_code_deobfuscation_rejects_model_token_limit(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)

    class IncompleteAnswer:
        content = 'class Example {'
        response_metadata = {'finish_reason': 'length'}

    class IncompleteLlm:
        async def ainvoke(self, _messages):
            return IncompleteAnswer()

    provider = {'id': 'provider-1', 'providerType': 'openai_compatible', 'modelIdentifier': 'Qwen3.5-0.8B'}
    with patch.object(api, 'fetch_user_providers', return_value=[provider]), \
         patch('orchestrator_helpers.llm_setup.setup_llm', return_value=IncompleteLlm()):
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'Example',
            'language': 'Java', 'source_code': 'class Example {}',
        })

    assert response.status_code == 422
    assert response.json()['code'] == 'incomplete_source'


def test_openai_compatible_none_reasoning_mode_is_forwarded_for_local_endpoints():
    from orchestrator_helpers.llm_setup import _resolve_reasoning_effort

    assert _resolve_reasoning_effort({'reasoningEnabled': True, 'reasoningEffort': 'none'}) == 'none'
    assert _resolve_reasoning_effort({'reasoningEnabled': False, 'reasoningEffort': 'none'}) is None


def test_code_deobfuscation_rejects_oversized_source_before_loading_provider(api, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv('INTERNAL_API_KEY', raising=False)
    monkeypatch.delenv('SCANNER_API_KEY', raising=False)
    with patch.object(api, 'fetch_user_providers') as fetch:
        response = TestClient(api.app).post('/reamon/code/deobfuscate', json={
            'model': 'custom/provider-1', 'user_id': 'user-1', 'unit_name': 'LargeUnit',
            'source_code': 'x' * (64 * 1024 + 1),
        })

    assert response.status_code == 413
    fetch.assert_not_called()
