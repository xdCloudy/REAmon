"""Focused policy and protocol checks for disposable project workers."""
import asyncio
import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broker
import project_worker as worker


def log_frame(stream: int, data: bytes) -> bytes:
    return bytes([stream, 0, 0, 0]) + len(data).to_bytes(4, "big") + data


class ProjectWorkerLogsTests(unittest.TestCase):
    def test_demultiplexes_stdout_and_stderr(self):
        stdout, stderr = worker._decode_worker_logs(
            log_frame(1, b"compiled\n") + log_frame(2, b"warning\n")
        )
        self.assertEqual(stdout, b"compiled\n")
        self.assertEqual(stderr, b"warning\n")

    def test_rejects_malformed_frames(self):
        with self.assertRaises(worker.DockerAPIError):
            worker._decode_worker_logs(b"short")
        with self.assertRaises(worker.DockerAPIError):
            worker._decode_worker_logs(bytes([3, 0, 0, 0]) + (0).to_bytes(4, "big"))

    def test_caps_each_stream_independently(self):
        with mock.patch.object(worker, "WORKER_OUTPUT_LIMIT", 3):
            stdout, stderr = worker._decode_worker_logs(
                log_frame(1, b"abcd") + log_frame(2, b"1234")
            )
        self.assertEqual(stdout, b"abc\n[output truncated after 2 MiB]")
        self.assertEqual(stderr, b"123\n[output truncated after 2 MiB]")

class ProjectWorkerRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_network_create_deletes_by_unique_name(self):
        started = asyncio.Event()
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path))
            if method == "POST":
                started.set()
                await asyncio.Event().wait()
            return 204, b""

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            task = asyncio.create_task(worker._create_worker_network("project-1"))
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], "DELETE")
        self.assertRegex(calls[1][1], r"^/networks/reamon-w-[a-f0-9]{10}-[a-f0-9]{8}$")

    async def test_cancelled_container_create_removes_by_unique_name(self):
        started = asyncio.Event()
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path))
            if method == "POST":
                started.set()
                await asyncio.Event().wait()
            return 204, b""

        with (
            mock.patch.object(worker, "_workspace_project_runtime", return_value=([], "sha256:" + "a" * 64)),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
        ):
            task = asyncio.create_task(worker._create_worker_container(
                "project-1", "network-1", ["id"], [], "execute_code",
            ))
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], "DELETE")
        self.assertRegex(calls[1][1], r"^/containers/reamon-w-[a-f0-9]{20}\?force=true&v=true$")

    async def test_startup_reaper_removes_workers_and_networks_when_single_broker_is_verified(self):
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path))
            if method == "GET" and path.startswith("/containers/json?"):
                if "reamon-docker-broker" in path:
                    return 200, b'[{"Id":"broker-id"}]'
                return 200, b'[{"Id":"worker-a"},{"Id":"worker-b"}]'
            if method == "GET" and path.startswith("/networks?"):
                return 200, b'[{"Id":"network-a"}]'
            if method == "DELETE":
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            result = await worker.reap_orphaned_workers()

        self.assertEqual(result, (2, 1))
        self.assertEqual(sum(method == "DELETE" and path.startswith("/containers/") for method, path in calls), 2)
        self.assertEqual(sum(method == "DELETE" and path.startswith("/networks/") for method, path in calls), 1)

    async def test_startup_reaper_leaves_workers_alone_when_multiple_brokers_exist(self):
        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual(method, "GET")
            self.assertTrue(path.startswith("/containers/json?"))
            return 200, b'[{"Id":"broker-a"},{"Id":"broker-b"}]'

        with mock.patch.object(worker, "_docker_request", side_effect=docker) as request:
            result = await worker.reap_orphaned_workers()

        self.assertIsNone(result)
        request.assert_awaited_once()

    async def test_startup_reaper_fails_closed_when_container_inventory_is_unavailable(self):
        with mock.patch.object(worker, "_docker_request", return_value=(503, b"")) as request:
            result = await worker.reap_orphaned_workers()

        self.assertIsNone(result)
        request.assert_awaited_once()

    async def test_startup_reaper_preflights_networks_before_removing_any_worker(self):
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path))
            if method == "GET" and path.startswith("/containers/json?"):
                if "reamon-docker-broker" in path:
                    return 200, b'[{"Id":"broker-id"}]'
                return 200, b'[{"Id":"worker-id"}]'
            if method == "GET" and path.startswith("/networks?"):
                return 503, b""
            self.fail(f"Unexpected Docker mutation after failed inventory: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            result = await worker.reap_orphaned_workers()

        self.assertIsNone(result)
        self.assertFalse(any(method == "DELETE" for method, _path in calls))

    async def test_networks_are_internal_unless_a_pentest_tool_needs_egress(self):
        bodies = []

        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual((method, path), ("POST", "/networks/create"))
            bodies.append(body)
            return 201, b'{"Id":"network-id"}'

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            await worker._create_worker_network("project-1")
            await worker._create_worker_network("project-1", allow_egress=True)

        self.assertEqual([body["Internal"] for body in bodies], [True, False])

    async def test_worker_environment_allows_only_signed_proxy_context(self):
        env = worker._worker_environment({
            "REDAMON_AGENT_URL": "http://agent:8080",
            "REDAMON_CTX": "opaque-signed-context",
        })
        self.assertIn("REDAMON_CTX=opaque-signed-context", env)
        with self.assertRaisesRegex(ValueError, "not allowed"):
            worker._worker_environment({"INTERNAL_API_KEY": "master-secret"})

    async def test_terminal_context_requires_agent_resolved_identity_and_graph_scope(self):
        payload = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return json.dumps(payload).encode()

        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.urllib.request, "urlopen", return_value=Response()) as urlopen,
        ):
            result = worker._verify_terminal_context_sync("signed-terminal-context")

        self.assertEqual(result, payload)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, worker.AGENT_SCOPE_URL)
        self.assertEqual(request.get_header("X-internal-key"), "scanner-key")
        self.assertEqual(json.loads(request.data), {
            "ctx": "signed-terminal-context", "tool": "kali_terminal",
        })

    async def test_terminal_context_rejects_incomplete_scope(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return b'{"project_id":"project-1","user_id":"owner-1"}'

        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.urllib.request, "urlopen", return_value=Response()),
        ):
            with self.assertRaisesRegex(PermissionError, "rejected"):
                worker._verify_terminal_context_sync("signed-terminal-context")

    async def test_terminal_container_uses_project_mounts_and_interactive_limits(self):
        digest = "sha256:" + "c" * 64
        mounts = [{"Type": "bind", "Source": "/projects/project-1", "Target": "/workspace", "ReadOnly": True}]
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            return 201, b'{"Id":"terminal-worker"}'

        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        with (
            mock.patch.object(worker, "_workspace_project_runtime", return_value=(mounts, digest)),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
        ):
            result = await worker._create_terminal_container(identity, "terminal-network")

        self.assertEqual(result, "terminal-worker")
        body = calls[0][2]
        self.assertEqual(body["Image"], digest)
        self.assertEqual(body["User"], "65534:65534")
        self.assertTrue(body["Tty"])
        self.assertTrue(body["OpenStdin"])
        self.assertTrue(body["StdinOnce"])
        self.assertTrue(body["HostConfig"]["ReadonlyRootfs"])
        self.assertEqual(body["HostConfig"]["Mounts"], mounts)
        self.assertEqual(body["HostConfig"]["PidsLimit"], worker.WORKER_PIDS)
        self.assertEqual(body["HostConfig"]["NanoCpus"], worker.WORKER_NANO_CPUS)
        self.assertEqual(body["Labels"]["reamon.terminal-worker"], "1")
        self.assertEqual(body["Labels"]["reamon.project-scope"], hashlib.sha256(b"project-1").hexdigest())
        self.assertIn("REDAMON_CTX=signed-graph-context", body["Env"])
        self.assertNotIn("SCANNER_API_KEY", " ".join(body["Env"]))

    async def test_terminal_admission_denies_full_project_before_network_creation(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        with (
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=1),
            mock.patch.object(worker, "_active_project_worker_count", return_value=worker.WORKER_MAX_ACTIVE_PER_PROJECT),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            with self.assertRaisesRegex(worker.WorkerAdmissionError, "project has reached") as raised:
                await worker._create_admitted_terminal(identity)
        self.assertEqual(raised.exception.status_code, 429)
        create_network.assert_not_awaited()

    async def test_terminal_admission_denies_full_global_cap(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        with (
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=worker.WORKER_MAX_ACTIVE),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            with self.assertRaisesRegex(worker.WorkerAdmissionError, "worker capacity is full") as raised:
                await worker._create_admitted_terminal(identity)
        self.assertEqual(raised.exception.status_code, 429)
        create_network.assert_not_awaited()

    async def test_terminal_capacity_denial_returns_retryable_http_status(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }

        class Writer:
            def __init__(self):
                self.data = bytearray()

            def is_closing(self):
                return False

            def write(self, data):
                self.data.extend(data)

            async def drain(self):
                return None

        writer = Writer()
        with (
            mock.patch.object(worker.asyncio, "to_thread", return_value=identity),
            mock.patch.object(
                worker, "_create_admitted_terminal",
                side_effect=worker.WorkerAdmissionError(429, "worker capacity is full"),
            ),
        ):
            await worker.serve_terminal("signed-context", 24, 80, None, writer)

        self.assertTrue(bytes(writer.data).startswith(b"HTTP/1.1 429 Too Many Requests"))

    async def test_terminal_stream_relays_input_output_and_cleans_up(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        browser_reader = asyncio.StreamReader()
        input_bytes = b"id\n"
        resize_bytes = json.dumps({"rows": 40, "cols": 120}).encode()
        browser_reader.feed_data(
            b"D" + len(input_bytes).to_bytes(4, "big") + input_bytes
            + b"R" + len(resize_bytes).to_bytes(4, "big") + resize_bytes
        )
        attach_reader = asyncio.StreamReader()
        attach_reader.feed_data(b"terminal output")
        attach_reader.feed_eof()

        class Writer:
            def __init__(self):
                self.data = bytearray()

            def is_closing(self):
                return False

            def write(self, data):
                self.data.extend(data)

            async def drain(self):
                return None

        class AttachWriter:
            def __init__(self):
                self.data = bytearray()
                self.closed = False

            def write(self, data):
                self.data.extend(data)

            async def drain(self):
                return None

            def close(self):
                self.closed = True

            async def wait_closed(self):
                return None

        tunnel_writer = Writer()
        attach_writer = AttachWriter()
        with (
            mock.patch.object(worker.asyncio, "to_thread", return_value=identity),
            mock.patch.object(worker, "_create_admitted_terminal", return_value=("net-1", "ctr-1")),
            mock.patch.object(worker, "_open_terminal_attach", return_value=(attach_reader, attach_writer)),
            mock.patch.object(worker, "_docker_request", return_value=(204, b"")) as docker_request,
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            await worker.serve_terminal("signed-context", 24, 80, browser_reader, tunnel_writer)

        self.assertEqual(bytes(attach_writer.data), input_bytes)
        resize_calls = [call for call in docker_request.await_args_list if "/resize?" in call.args[1]]
        self.assertTrue(any("h=40&w=120" in call.args[1] for call in resize_calls))
        self.assertTrue(attach_writer.closed)
        self.assertTrue(bytes(tunnel_writer.data).startswith(b"HTTP/1.1 200 OK"))
        self.assertIn(b"O" + len(b"terminal output").to_bytes(4, "big") + b"terminal output", tunnel_writer.data)
        cleanup.assert_awaited_once_with("ctr-1", "net-1")

    async def _assert_terminal_deadline_cleans_up(self, idle_timeout, session_timeout):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        browser_reader = asyncio.StreamReader()
        attach_reader = asyncio.StreamReader()

        class Writer:
            def __init__(self):
                self.data = bytearray()
                self.closed = False

            def is_closing(self):
                return self.closed

            def write(self, data):
                self.data.extend(data)

            async def drain(self):
                return None

            def close(self):
                self.closed = True

            async def wait_closed(self):
                return None

        tunnel_writer = Writer()

        class AttachWriter:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

            async def wait_closed(self):
                return None

        attach_writer = AttachWriter()
        with (
            mock.patch.object(worker, "TERMINAL_IDLE_TIMEOUT_SECONDS", idle_timeout),
            mock.patch.object(worker, "TERMINAL_MAX_SESSION_SECONDS", session_timeout),
            mock.patch.object(worker.asyncio, "to_thread", return_value=identity),
            mock.patch.object(worker, "_create_admitted_terminal", return_value=("net-1", "ctr-1")),
            mock.patch.object(worker, "_open_terminal_attach", return_value=(attach_reader, attach_writer)),
            mock.patch.object(worker, "_docker_request", return_value=(204, b"")),
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            await worker.serve_terminal("signed-context", 24, 80, browser_reader, tunnel_writer)

        self.assertTrue(tunnel_writer.closed)
        cleanup.assert_awaited_once_with("ctr-1", "net-1")
        self.assertTrue(attach_writer.closed)

    async def test_idle_terminal_session_is_closed_and_worker_removed(self):
        await self._assert_terminal_deadline_cleans_up(idle_timeout=0.01, session_timeout=1)

    async def test_terminal_absolute_lifetime_is_closed_and_worker_removed(self):
        await self._assert_terminal_deadline_cleans_up(idle_timeout=1, session_timeout=0.01)

    async def test_worker_preserves_exit_code_and_separate_streams(self):
        frames = log_frame(1, b"out") + log_frame(2, b"err")
        with mock.patch.object(
            worker,
            "_docker_request",
            side_effect=[(204, b""), (200, b'{"StatusCode":7}'), (200, frames)],
        ) as docker:
            result = await worker._run_worker("container-id", 10)
        self.assertEqual(result, (7, b"out", b"err", False))
        self.assertEqual(docker.await_count, 3)

    async def test_worker_timeout_kills_container_and_returns_partial_output(self):
        frames = log_frame(1, b"partial") + log_frame(2, b"warning")
        with mock.patch.object(
            worker,
            "_docker_request",
            side_effect=[(204, b""), TimeoutError(), (204, b""), (200, frames)],
        ) as docker:
            result = await worker._run_worker("container-id", 10)
        self.assertEqual(result, (124, b"partial", b"warning\n[ERROR] worker command timed out", True))
        self.assertIn("/kill?signal=SIGKILL", docker.await_args_list[2].args[1])

    async def test_workspace_mounts_are_project_only_and_image_is_pinned(self):
        digest = "sha256:" + "a" * 64
        paths = []

        async def docker(method, path, body=None, **_kwargs):
            paths.append(path)
            self.assertEqual(method, "GET")
            if path == "/containers/redamon-agent/json":
                data = {"Mounts": [{
                    "Destination": "/workspace",
                    "Source": r"C:\REAmon\workspace",
                }]}
            else:
                self.assertEqual(path, "/images/reamon-project-worker%3Alatest/json")
                data = {"Id": digest}
            return 200, json.dumps(data).encode()

        with tempfile.TemporaryDirectory() as workspace_root:
            os.mkdir(os.path.join(workspace_root, "project-1"))
            with (
                mock.patch.object(worker, "WORKSPACE_ROOT", workspace_root),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
            ):
                mounts, image = await worker._workspace_project_runtime("project-1")
            for name in (".reamon-tmp", "tool-outputs"):
                path = os.path.join(workspace_root, "project-1", name)
                self.assertTrue(os.path.isdir(path))
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o770)

        self.assertEqual(paths, [
            "/containers/redamon-agent/json",
            "/images/reamon-project-worker%3Alatest/json",
        ])
        self.assertEqual(image, digest)
        self.assertEqual(mounts[0]["Target"], "/workspace")
        self.assertEqual(mounts[0]["Source"], "/run/desktop/mnt/host/c/REAmon/workspace/project-1")
        self.assertTrue(mounts[0]["ReadOnly"])
        self.assertEqual(mounts[1]["Target"], "/tmp")
        self.assertFalse(mounts[1]["ReadOnly"])
        self.assertEqual(mounts[2]["Target"], "/workspace/.reamon-tmp")
        self.assertEqual(mounts[3]["Target"], "/workspace/tool-outputs")

    async def test_workspace_host_path_overrides_docker_desktop_shim_path(self):
        digest = "sha256:" + "c" * 64

        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual(method, "GET")
            if path == "/containers/redamon-agent/json":
                data = {"Mounts": [{
                    "Destination": "/workspace",
                    "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/shim",
                }]}
            else:
                data = {"Id": digest}
            return 200, json.dumps(data).encode()

        with tempfile.TemporaryDirectory() as workspace_root:
            os.mkdir(os.path.join(workspace_root, "project-1"))
            with (
                mock.patch.object(worker, "WORKSPACE_ROOT", workspace_root),
                mock.patch.object(worker, "WORKSPACE_HOST_PATH", r"C:\REAmon\workspace"),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
            ):
                mounts, _ = await worker._workspace_project_runtime("project-1")

        self.assertEqual(
            mounts[0]["Source"],
            "/run/desktop/mnt/host/c/REAmon/workspace/project-1",
        )

    async def test_worker_image_selection_keeps_pentest_tools_separate(self):
        with (
            mock.patch.object(worker, "PROJECT_WORKER_IMAGE", "reamon-project-worker:unit"),
            mock.patch.object(worker, "PENTEST_WORKER_IMAGE", "reamon-kali-sandbox:unit"),
        ):
            self.assertEqual(worker._worker_image_for_tool("execute_code"), "reamon-project-worker:unit")
            self.assertEqual(worker._worker_image_for_tool("kali_shell"), "reamon-kali-sandbox:unit")
            self.assertEqual(worker._worker_image_for_tool("execute_playwright"), "reamon-kali-sandbox:unit")
            self.assertEqual(worker._worker_image_for_tool("proxy_brain"), "reamon-kali-sandbox:unit")

    async def test_project_worker_count_uses_hashed_project_label(self):
        calls = []

        async def docker(method, path, **_kwargs):
            calls.append((method, path))
            filters = json.loads(parse_qs(urlsplit(path).query)["filters"][0])
            self.assertIn("reamon.project-worker=1", filters["label"])
            self.assertIn(
                "reamon.project-scope=" + hashlib.sha256(b"p1").hexdigest(),
                filters["label"],
            )
            self.assertIn("running", filters["status"])
            return 200, b'[{"Id":"worker"}]'

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            count = await worker._active_project_worker_count("p1")

        self.assertEqual(count, 1)
        self.assertEqual(calls[0][0], "GET")

    async def test_create_uses_pinned_image_and_restrictive_container_profile(self):
        digest = "sha256:" + "b" * 64
        mounts = [{"Type": "bind", "Source": "/projects/p1", "Target": "/workspace", "ReadOnly": True}]
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            return 201, b'{"Id":"worker-id"}'

        with (
            mock.patch.object(worker, "_workspace_project_runtime", return_value=(mounts, digest)),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
        ):
            result = await worker._create_worker_container("p1", "network-id", ["id"], ["PATH=/bin"])

        self.assertEqual(result, "worker-id")
        body = calls[0][2]
        self.assertEqual(body["Image"], digest)
        self.assertEqual(body["User"], "65534:65534")
        self.assertEqual(body["HostConfig"]["CapDrop"], ["ALL"])
        self.assertEqual(body["HostConfig"]["CapAdd"], [])
        self.assertTrue(body["HostConfig"]["ReadonlyRootfs"])
        self.assertEqual(body["HostConfig"]["Mounts"], mounts)
        self.assertEqual(
            body["Labels"]["reamon.project-scope"],
            hashlib.sha256(b"p1").hexdigest(),
        )
        self.assertNotIn("redamon.broker-owned", body["Labels"])
        self.assertNotIn("p1", body["Labels"].values())
        self.assertFalse(body["Tty"])
        self.assertEqual(body["HostConfig"]["LogConfig"]["Config"]["max-size"], "8m")

    async def test_only_kali_shell_worker_receives_raw_socket_capability(self):
        mounts = [{"Type": "bind", "Source": "/projects/p1", "Target": "/workspace", "ReadOnly": True}]
        calls = []

        async def docker(_method, _path, body=None, **_kwargs):
            calls.append(body)
            return 201, b'{"Id":"worker-id"}'

        with (
            mock.patch.object(worker, "_workspace_project_runtime", return_value=(mounts, "sha256:" + "b" * 64)),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
        ):
            await worker._create_worker_container("p1", "net", ["id"], [], "kali_shell")

        self.assertEqual(calls[0]["HostConfig"]["CapAdd"], ["NET_RAW"])

    async def test_project_workers_are_included_in_shared_host_capacity(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 1),
            mock.patch.object(broker, "_count_broker_owned_active", return_value=1),
            mock.patch.object(worker, "_active_worker_count") as active_workers,
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 429)
        self.assertIn("host container capacity is full", result["error"])
        active_workers.assert_not_awaited()
        create_network.assert_not_awaited()

    async def test_fails_closed_when_shared_host_capacity_is_unavailable(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 1),
            mock.patch.object(broker, "_count_broker_owned_active", return_value=-1),
            mock.patch.object(worker, "_active_worker_count") as active_workers,
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 503)
        self.assertIn("host container capacity is unavailable", result["error"])
        active_workers.assert_not_awaited()
        create_network.assert_not_awaited()

    async def test_worker_admission_waits_for_generic_container_creation_lock(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 2),
            mock.patch.object(broker, "_count_broker_owned_active", return_value=0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network", return_value="net-1") as create_network,
            mock.patch.object(worker, "_create_worker_container", return_value="ctr-1"),
            mock.patch.object(worker, "_run_worker", return_value=(0, b"ok", b"", False)),
            mock.patch.object(worker, "_remove_worker"),
        ):
            await broker._CREATE_COUNT_LOCK.acquire()
            try:
                pending = asyncio.create_task(worker.execute({
                    "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
                }))
                await asyncio.sleep(0)
                create_network.assert_not_awaited()
            finally:
                broker._CREATE_COUNT_LOCK.release()
            status, _result = await pending

        self.assertEqual(status, 200)
        create_network.assert_awaited_once()

    async def test_fails_closed_when_worker_capacity_cannot_be_read(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=None),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 503)
        self.assertIn("capacity", result["error"])
        create_network.assert_not_awaited()

    async def test_fails_closed_when_worker_cap_is_full(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=worker.WORKER_MAX_ACTIVE),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 429)
        self.assertIn("capacity is full", result["error"])
        create_network.assert_not_awaited()

    async def test_project_cap_preserves_global_capacity_for_other_projects(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker, "WORKER_MAX_ACTIVE_PER_PROJECT", 2),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=3),
            mock.patch.object(worker, "_active_project_worker_count", return_value=2),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 429)
        self.assertIn("project has reached", result["error"])
        create_network.assert_not_awaited()

    async def test_fails_closed_when_project_worker_count_cannot_be_read(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=None),
            mock.patch.object(worker, "_create_worker_network") as create_network,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 503)
        self.assertIn("capacity is unavailable", result["error"])
        create_network.assert_not_awaited()

    async def test_successful_run_always_cleans_up_container_and_network(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network", return_value="net-1"),
            mock.patch.object(worker, "_create_worker_container", return_value="ctr-1"),
            mock.patch.object(worker, "_run_worker", return_value=(0, b"ok", b"", False)),
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            status, result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(result["stdout_b64"]), b"ok")
        cleanup.assert_awaited_once_with("ctr-1", "net-1")

    async def test_cancelled_run_removes_worker_and_network(self):
        started = asyncio.Event()

        async def wait_for_cancel(_container_id, _timeout):
            started.set()
            await asyncio.Event().wait()

        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network", return_value="net-1"),
            mock.patch.object(worker, "_create_worker_container", return_value="ctr-1"),
            mock.patch.object(worker, "_run_worker", side_effect=wait_for_cancel),
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            task = asyncio.create_task(worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            }))
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        cleanup.assert_awaited_once_with("ctr-1", "net-1")


class BrokerWorkerEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = await asyncio.start_server(broker.handle_worker_client, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.server_task = asyncio.create_task(self.server.serve_forever())

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.server_task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await self.server_task

    async def request(self, method, path, key="", payload=b"{}"):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(
            f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
            f"X-Internal-Key: {key}\r\nContent-Length: {len(payload)}\r\n\r\n".encode()
            + payload
        )
        await writer.drain()
        response = await reader.read()
        writer.close()
        await writer.wait_closed()
        return response

    async def test_worker_endpoint_rejects_missing_transport_key(self):
        with mock.patch.object(broker, "WORKER_API_KEY", "secret"):
            response = await self.request("POST", "/worker/execute")
        self.assertIn(b"403 Forbidden", response)
        self.assertIn(b"worker authorization failed", response)

    async def test_terminal_endpoint_rejects_missing_transport_key(self):
        with mock.patch.object(broker, "WORKER_API_KEY", "secret"):
            response = await self.request("POST", "/worker/terminal")
        self.assertIn(b"403 Forbidden", response)
        self.assertIn(b"worker authorization failed", response)

    async def test_tcp_endpoint_never_exposes_docker_api(self):
        with mock.patch.object(broker, "WORKER_API_KEY", "secret"):
            response = await self.request("GET", "/containers/json", key="secret")
        self.assertIn(b"404 Not Found", response)

    async def test_worker_disconnect_cancels_execution(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def wait_for_disconnect(_body):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        payload = json.dumps({"ctx": "signed", "tool": "kali_shell", "argv": ["id"]}).encode()
        with (
            mock.patch.object(broker, "WORKER_API_KEY", "secret"),
            mock.patch.object(worker, "execute", side_effect=wait_for_disconnect),
        ):
            reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
            writer.write(
                f"POST /worker/execute HTTP/1.1\r\nHost: localhost\r\n"
                f"X-Internal-Key: secret\r\nContent-Length: {len(payload)}\r\n\r\n".encode()
                + payload
            )
            await writer.drain()
            await asyncio.wait_for(started.wait(), timeout=1)
            writer.close()
            await writer.wait_closed()
            await asyncio.wait_for(cancelled.wait(), timeout=1)

    async def test_completed_worker_request_returns_response_without_cancelling(self):
        result = {
            "exit_code": 0,
            "stdout_b64": base64.b64encode(b"done").decode(),
            "stderr_b64": "",
            "timed_out": False,
        }
        with (
            mock.patch.object(broker, "WORKER_API_KEY", "secret"),
            mock.patch.object(worker, "execute", new=mock.AsyncMock(return_value=(200, result))) as execute,
        ):
            response = await self.request(
                "POST", "/worker/execute", key="secret",
                payload=json.dumps({"ctx": "signed"}).encode(),
            )

        self.assertIn(b"200 OK", response)
        self.assertIn(b'"exit_code":0', response)
        execute.assert_awaited_once_with({"ctx": "signed"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
