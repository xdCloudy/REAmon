"""Live PostgreSQL acceptance for conversation recovery across agent restart."""

import os
from unittest.mock import patch
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage, HumanMessage

import orchestrator as orchestrator_module
from orchestrator import AgentOrchestrator
from orchestrator_helpers.config import create_config


pytestmark = pytest.mark.integration


def _new_orchestrator():
    instance = AgentOrchestrator.__new__(AgentOrchestrator)
    instance.neo4j_uri = "bolt://unused"
    instance.neo4j_user = "unused"
    instance.neo4j_password = None
    instance.llm = None
    instance.tool_executor = None
    instance._streaming_callbacks = {}
    instance._guidance_queues = {}
    instance._graph_view_cyphers = {}
    instance._checkpoint_pool = None
    return instance


@pytest.mark.asyncio
async def test_conversation_messages_survive_new_orchestrator_and_postgres_pool():
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("DATABASE_URL is not configured")

    thread_id = f"checkpoint-restart-test:{uuid4()}"
    config = create_config("checkpoint-test", "checkpoint-test", thread_id)
    seen_messages = []

    async def fake_initialize(*_args, **_kwargs):
        return {}

    async def fake_think(state, *_args, **_kwargs):
        seen_messages.append([message.content for message in state.get("messages", [])])
        return {
            "messages": [AIMessage(content=f"ack-{len(seen_messages)}")],
            "task_complete": True,
            "completion_reason": "deterministic checkpoint acceptance",
        }

    async def fake_response(*_args, **_kwargs):
        return {"messages": [AIMessage(content="conversation turn completed")]}

    def setting(name, default=None):
        if name == "PERSISTENT_CHECKPOINTER":
            return True
        if name == "CHECKPOINT_POOL_MAX_SIZE":
            return 5
        return default

    with patch.object(orchestrator_module, "get_setting", side_effect=setting), \
            patch.object(orchestrator_module, "initialize_node", fake_initialize), \
            patch.object(orchestrator_module, "think_node", fake_think), \
            patch.object(orchestrator_module, "generate_response_node", fake_response), \
            patch.object(orchestrator_module, "build_fireteam_member_graph", return_value=None):
        first = _new_orchestrator()
        second = _new_orchestrator()
        first_saver = None
        second_saver = None
        try:
            await first._setup_checkpointer()
            first_saver = orchestrator_module.checkpointer
            first._build_graph()
            await first.graph.ainvoke(
                {"messages": [HumanMessage(content="first durable turn")]}, config
            )
            assert seen_messages[-1] == ["first durable turn"]

            # Closing the pool models process shutdown. The second instance has
            # no in-memory graph or saver state to inherit from the first.
            await first.close()
            await second._setup_checkpointer()
            second_saver = orchestrator_module.checkpointer
            second._build_graph()

            recovered = await second.graph.aget_state(config)
            recovered_messages = [message.content for message in recovered.values["messages"]]
            assert "first durable turn" in recovered_messages
            assert "ack-1" in recovered_messages
            assert "conversation turn completed" in recovered_messages

            await second.graph.ainvoke(
                {"messages": [HumanMessage(content="second durable turn")]}, config
            )
            assert seen_messages[-1] == [
                "first durable turn",
                "ack-1",
                "conversation turn completed",
                "second durable turn",
            ]
        finally:
            cleanup_saver = second_saver or first_saver
            if cleanup_saver is not None and (
                second._checkpoint_pool is not None
                or first._checkpoint_pool is not None
            ):
                await cleanup_saver.adelete_thread(config["configurable"]["thread_id"])
            if first._checkpoint_pool is not None:
                await first.close()
            if second._checkpoint_pool is not None:
                await second.close()
