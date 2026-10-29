"""Focused policy and protocol checks for disposable project workers."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import threading
import tempfile
import time
import unittest
from contextlib import asynccontextmanager
from urllib.parse import parse_qs, urlsplit
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broker
import admission_lock as admission_state
import project_worker as worker

# Never let broker unit tests create project tombstones on the live Docker
# admission volume. This per-process path is also the default for tests that
# exercise admission without explicitly configuring a lock path.
_TEST_ADMISSION_STATE = tempfile.TemporaryDirectory(prefix="reamon-broker-tests-")
admission_state.LOCK_PATH = os.path.join(_TEST_ADMISSION_STATE.name, "container-create.lock")


class WorkerResourceConfigurationTests(unittest.TestCase):
    def test_operator_limits_keep_safe_minimums_and_hard_maximums(self):
        for raw, expected in (("1", 256 * 1024**2), (str(64 * 1024**3), 8 * 1024**3), ("bad", 1024**3)):
            with self.subTest(raw=raw), mock.patch.dict(os.environ, {"REAMON_WORKER_MEMORY_BYTES": raw}):
                self.assertEqual(worker._bounded_int_env(
                    "REAMON_WORKER_MEMORY_BYTES", 1024**3, 256 * 1024**2, 8 * 1024**3,
                ), expected)

        self.assertEqual(worker._bounded_int_env("REAMON_WORKER_PIDS", 512, 64, 4096), 512)
        with mock.patch.dict(os.environ, {"REAMON_WORKER_PIDS": "999999"}):
            self.assertEqual(worker._bounded_int_env("REAMON_WORKER_PIDS", 512, 64, 4096), 4096)
        with mock.patch.dict(os.environ, {"REAMON_WORKER_NANO_CPUS": "0"}):
            self.assertEqual(worker._bounded_int_env("REAMON_WORKER_NANO_CPUS", 2_000_000_000, 500_000_000, 16_000_000_000), 500_000_000)
        self.assertEqual(worker._bounded_int_env(
            "REAMON_WORKER_MAX_FILE_BYTES", 1024**3, 16 * 1024**2, 8 * 1024**3,
        ), 1024**3)
        with mock.patch.dict(os.environ, {"REAMON_WORKER_MAX_FILE_BYTES": "999999999999"}):
            self.assertEqual(worker._bounded_int_env(
                "REAMON_WORKER_MAX_FILE_BYTES", 1024**3, 16 * 1024**2, 8 * 1024**3,
            ), 8 * 1024**3)

    def test_concurrency_ceiling_respects_aggregate_cpu_memory_and_pid_budgets(self):
        self.assertEqual(worker._worker_concurrency_limit(64, 1024**3, 512, 2_000_000_000), 8)
        self.assertEqual(worker._worker_concurrency_limit(64, 2 * 1024**3, 512, 2_000_000_000), 4)
        self.assertEqual(worker._worker_concurrency_limit(64, 1024**3, 2048, 2_000_000_000), 2)
        self.assertEqual(worker._worker_concurrency_limit(64, 1024**3, 512, 8_000_000_000), 2)
        self.assertEqual(worker.WORKER_MAX_ACTIVE, 4)


class SharedAdmissionLockTests(unittest.TestCase):
    def test_separate_processes_serialize_on_the_shared_lock_file(self):
        with tempfile.TemporaryDirectory() as directory:
            lock_path = os.path.join(directory, "admission.lock")
            events_path = os.path.join(directory, "events.txt")
            child = "\n".join((
                "import asyncio, sys, time",
                "from admission_lock import admission_lock",
                "async def main():",
                "    name, lock_path, events_path = sys.argv[1:]",
                "    async with admission_lock(lock_path):",
                "        with open(events_path, 'a', encoding='utf-8') as events:",
                "            events.write(name + ':enter\\n'); events.flush()",
                "        time.sleep(0.25)",
                "        with open(events_path, 'a', encoding='utf-8') as events:",
                "            events.write(name + ':leave\\n'); events.flush()",
                "asyncio.run(main())",
            ))
            first = subprocess.Popen(
                [sys.executable, "-c", child, "first", lock_path, events_path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            second = None
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    if os.path.exists(events_path):
                        with open(events_path, encoding="utf-8") as events:
                            if "first:enter\n" in events.read():
                                break
                    if first.poll() is not None:
                        self.fail(f"first lock process exited early: {first.stderr.read()}")
                    time.sleep(0.01)
                else:
                    self.fail("first process did not acquire the shared lock")

                second = subprocess.Popen(
                    [sys.executable, "-c", child, "second", lock_path, events_path],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                first_out, first_err = first.communicate(timeout=10)
                second_out, second_err = second.communicate(timeout=10)
                self.assertEqual(first.returncode, 0, first_err or first_out)
                self.assertEqual(second.returncode, 0, second_err or second_out)
                with open(events_path, encoding="utf-8") as events:
                    self.assertEqual(
                        events.read().splitlines(),
                        ["first:enter", "first:leave", "second:enter", "second:leave"],
                    )
            finally:
                for process in (first, second):
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)


class SharedAdmissionLockCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelling_a_waiter_does_not_leak_the_lock(self):
        import admission_lock as lock_module

        with tempfile.TemporaryDirectory() as directory:
            lock_path = os.path.join(directory, "admission.lock")
            held = asyncio.Event()
            release = asyncio.Event()
            acquire_started = threading.Event()
            acquire = lock_module._acquire

            def observe_acquire(path):
                acquire_started.set()
                return acquire(path)

            async def hold_lock():
                async with lock_module.admission_lock(lock_path):
                    held.set()
                    await release.wait()

            holder = asyncio.create_task(hold_lock())
            await asyncio.wait_for(held.wait(), timeout=2)
            acquire_started.clear()
            with mock.patch.object(lock_module, "_acquire", side_effect=observe_acquire):
                waiter = asyncio.create_task(hold_lock())
                self.assertTrue(await asyncio.to_thread(acquire_started.wait, 2))
                waiter.cancel()
                release.set()
                await holder
                with self.assertRaises(asyncio.CancelledError):
                    await waiter

            async def acquire_once():
                async with lock_module.admission_lock(lock_path):
                    return True

            self.assertTrue(await asyncio.wait_for(acquire_once(), timeout=2))


class CrossProcessWorkerQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def test_global_worker_cap_allows_only_one_concurrent_cross_process_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            socket_path = os.path.join(directory, "docker.sock")
            lock_path = os.path.join(directory, "admission.lock")
            workspace = os.path.join(directory, "workspace")
            os.makedirs(os.path.join(workspace, "project-qa"))
            workers = []
            networks = []

            async def docker_api(reader, writer):
                try:
                    head = await reader.readuntil(b"\r\n\r\n")
                    lines = head.decode("latin1").split("\r\n")
                    method, path, _version = lines[0].split(" ", 2)
                    headers = {}
                    for line in lines[1:]:
                        if ":" in line:
                            key, value = line.split(":", 1)
                            headers[key.lower()] = value.strip()
                    length = int(headers.get("content-length", "0"))
                    body = await reader.readexactly(length) if length else b""
                    status = 200
                    if method == "GET" and path.startswith("/containers/json?"):
                        query = parse_qs(urlsplit(path).query)
                        filters = json.loads(query.get("filters", ["{}"])[0])
                        labels = filters.get("label", [])
                        if "reamon.project-worker=1" in labels:
                            response = workers
                        else:
                            response = []
                    elif method == "GET" and path == "/containers/redamon-agent/json":
                        response = {
                            "Config": {"Labels": {
                                "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
                                "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                            }},
                            "Mounts": [{"Destination": "/workspace", "Source": workspace}],
                        }
                    elif method == "GET" and path.startswith("/images/"):
                        response = {"Id": "sha256:" + "a" * 64}
                    elif method == "POST" and path == "/networks/create":
                        network_id = f"network-{len(networks) + 1}"
                        networks.append(network_id)
                        status = 201
                        response = {"Id": network_id}
                    elif method == "POST" and path.startswith("/containers/create?"):
                        config = json.loads(body)
                        worker_id = f"worker-{len(workers) + 1}"
                        workers.append({"Id": worker_id, "Labels": config.get("Labels", {})})
                        status = 201
                        response = {"Id": worker_id}
                    else:
                        status = 404
                        response = {"message": f"unexpected Docker API request: {method} {path}"}
                    payload = json.dumps(response).encode("utf-8")
                    reason = "Created" if status == 201 else "OK" if status == 200 else "Not Found"
                    writer.write(
                        f"HTTP/1.1 {status} {reason}\r\nContent-Length: {len(payload)}\r\n"
                        "Connection: close\r\nContent-Type: application/json\r\n\r\n".encode("ascii")
                        + payload
                    )
                    await writer.drain()
                finally:
                    writer.close()
                    await writer.wait_closed()

            server = await asyncio.start_unix_server(docker_api, path=socket_path)
            child = "\n".join((
                "import asyncio, json, sys",
                "import broker, project_worker as worker",
                "async def main():",
                "    broker.BROKER_MAX_CONTAINERS = 1",
                "    result = await worker._create_admitted_worker('project-qa', ['/bin/true'], [], 'execute_code')",
                "    print(json.dumps({'status': result[0], 'network': result[1], 'container': result[2], 'error': result[3]}))",
                "asyncio.run(main())",
            ))
            env = os.environ.copy()
            env.update({
                "DOCKER_BROKER_UPSTREAM": socket_path,
                "REAMON_ADMISSION_LOCK_PATH": lock_path,
                "REAMON_WORKSPACE_ROOT": workspace,
                "REAMON_WORKSPACE_HOST_PATH": workspace,
                "PYTHONPATH": os.pathsep.join((os.path.dirname(__file__), os.environ.get("PYTHONPATH", ""))),
            })
            try:
                async with server:
                    processes = [
                        await asyncio.create_subprocess_exec(
                            sys.executable, "-c", child,
                            cwd=os.path.dirname(__file__), env=env,
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                        )
                        for _ in range(2)
                    ]
                    results = []
                    for process in processes:
                        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
                        self.assertEqual(process.returncode, 0, stderr.decode("utf-8", "replace"))
                        results.append(json.loads(stdout.decode("utf-8").strip()))
            finally:
                server.close()
                await server.wait_closed()

            self.assertEqual(sorted(result["status"] for result in results), [200, 429])
            self.assertEqual(len(workers), 1)
            self.assertEqual(len(networks), 1)


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
    async def test_idle_project_scratch_cleanup_removes_only_expired_regular_files(self):
        with tempfile.TemporaryDirectory() as workspace:
            project = os.path.join(workspace, "p1")
            scratch = os.path.join(project, ".reamon-tmp")
            os.makedirs(os.path.join(scratch, "nested"))
            stale = os.path.join(scratch, "stale.bin")
            nested_stale = os.path.join(scratch, "nested", "stale.bin")
            recent = os.path.join(scratch, "recent.bin")
            for path in (stale, nested_stale, recent):
                with open(path, "wb") as output:
                    output.write(b"x" * 8)
            now = time.time()
            os.utime(stale, (now - worker.WORKER_SCRATCH_TTL_SECONDS - 1,) * 2)
            os.utime(nested_stale, (now - worker.WORKER_SCRATCH_TTL_SECONDS - 1,) * 2)
            os.utime(recent, (now, now))

            with mock.patch.object(worker, "WORKSPACE_ROOT", workspace):
                reclaimed = worker._cleanup_stale_project_scratch("p1", now=now)

            self.assertEqual(reclaimed, 16)
            self.assertFalse(os.path.exists(stale))
            self.assertFalse(os.path.exists(nested_stale))
            self.assertTrue(os.path.isfile(recent))

    async def test_scratch_cleanup_does_not_follow_symlinks_or_accept_symlink_root(self):
        with tempfile.TemporaryDirectory() as workspace:
            project = os.path.join(workspace, "p1")
            scratch = os.path.join(project, ".reamon-tmp")
            os.makedirs(scratch)
            external = os.path.join(workspace, "external")
            os.mkdir(external)
            external_file = os.path.join(external, "keep.bin")
            with open(external_file, "wb") as output:
                output.write(b"keep")
            os.utime(external_file, (1, 1))
            try:
                os.symlink(external_file, os.path.join(scratch, "file-link"))
                os.symlink(external, os.path.join(scratch, "directory-link"))
            except OSError as exc:
                self.skipTest(f"symlinks unavailable in Docker test environment: {exc}")

            with mock.patch.object(worker, "WORKSPACE_ROOT", workspace):
                reclaimed = worker._cleanup_stale_project_scratch("p1", now=time.time())
                self.assertEqual(reclaimed, 0)
                self.assertTrue(os.path.islink(os.path.join(scratch, "file-link")))
                self.assertTrue(os.path.islink(os.path.join(scratch, "directory-link")))
                second_project = os.path.join(workspace, "p2")
                os.mkdir(second_project)
                os.symlink(external, os.path.join(second_project, ".reamon-tmp"))
                with self.assertRaisesRegex(worker.DockerAPIError, "must not be a symlink"):
                    worker._cleanup_stale_project_scratch("p2")

            self.assertTrue(os.path.isfile(external_file))

    async def test_cancelled_network_create_preserves_cancellation_when_delete_fails(self):
        calls = []

        async def docker(method, path, *_args, **_kwargs):
            calls.append((method, path))
            if (method, path) == ("POST", "/networks/create"):
                raise asyncio.CancelledError
            return 500, b"private docker details"

        with (
            mock.patch.object(worker, "_docker_request", side_effect=docker),
            mock.patch.object(worker.asyncio, "sleep", new=mock.AsyncMock()),
            mock.patch.object(worker, "_log_cleanup_failure") as log_cleanup,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await worker._create_worker_network("project-cancel")

        deletes = [(method, path) for method, path in calls if method == "DELETE"]
        self.assertEqual(len(deletes), worker.WORKER_CLEANUP_ATTEMPTS)
        self.assertTrue(all(path.startswith("/networks/reamon-w-") for _, path in deletes))
        log_cleanup.assert_called_once_with("network")

    async def test_cancelled_container_create_preserves_cancellation_when_delete_fails(self):
        calls = []

        async def docker(method, path, *_args, **_kwargs):
            calls.append((method, path))
            if method == "POST" and path.startswith("/containers/create?"):
                raise asyncio.CancelledError
            return 500, b"private docker details"

        with (
            mock.patch.object(worker, "_workspace_project_runtime", return_value=([], "sha256:" + "a" * 64)),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
            mock.patch.object(worker.asyncio, "sleep", new=mock.AsyncMock()),
            mock.patch.object(worker, "_log_cleanup_failure") as log_cleanup,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await worker._create_worker_container("p1", "net-1", ["id"], [])

        deletes = [(method, path) for method, path in calls if method == "DELETE"]
        self.assertEqual(len(deletes), worker.WORKER_CLEANUP_ATTEMPTS)
        self.assertTrue(all(path.startswith("/containers/reamon-w-") for _, path in deletes))
        log_cleanup.assert_called_once_with("container")

    async def test_terminal_agent_resolves_generated_compose_container_name(self):
        calls = []
        expected_labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            if path == f"/containers/{worker.TERMINAL_AGENT_CONTAINER}/json":
                return 404, b"{}"
            if path == "/containers/agent-container-id/json":
                return 200, json.dumps({
                    "Id": "agent-container-id",
                    "Config": {"Labels": expected_labels},
                    "State": {"Running": True},
                }).encode()
            if path.startswith("/containers/json?"):
                return 200, json.dumps([{
                    "Id": "agent-container-id",
                    "State": "running",
                    "Labels": expected_labels,
                }]).encode()
            self.fail(f"Unexpected Docker request: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            result = await worker._trusted_agent_container_id()

        self.assertEqual(result, "agent-container-id")
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][1], f"/containers/{worker.TERMINAL_AGENT_CONTAINER}/json")
        self.assertTrue(calls[1][1].startswith("/containers/json?"))
        self.assertEqual(calls[2][1], "/containers/agent-container-id/json")

    async def test_terminal_agent_rejects_ambiguous_compose_matches(self):
        expected_labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }

        async def docker(method, path, body=None, **_kwargs):
            if path.endswith("/json"):
                return 404, b"{}"
            return 200, json.dumps([
                {"Id": "agent-a", "State": "running", "Labels": expected_labels},
                {"Id": "agent-b", "State": "running", "Labels": expected_labels},
            ]).encode()

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            with self.assertRaisesRegex(worker.DockerAPIError, "ambiguous"):
                await worker._trusted_agent_container_id()

    async def test_terminal_agent_rejects_configured_name_with_wrong_compose_identity(self):
        async def docker(method, path, body=None, **_kwargs):
            return 200, json.dumps({
                "Id": "untrusted-container",
                "Config": {"Labels": {
                    "com.docker.compose.project": "other-project",
                    "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                }},
                "State": {"Running": True},
            }).encode()

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            with self.assertRaisesRegex(worker.DockerAPIError, "does not match"):
                await worker._trusted_agent_container_id()

    async def test_terminal_agent_disconnects_before_network_cleanup(self):
        with mock.patch.object(worker, "_docker_request", return_value=(204, b"")) as docker:
            await worker._disconnect_terminal_agent("network-1", "agent-1")

        docker.assert_awaited_once_with(
            "POST", "/networks/network-1/disconnect",
            {"Container": "agent-1", "Force": True},
        )

    async def test_cleanup_detaches_only_compose_agent_attached_to_worker_network(self):
        expected_labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            if path == "/networks/network-1":
                return 200, json.dumps({"Containers": {"agent-id": {"Name": "generated-agent"}}}).encode()
            if path == "/containers/agent-id/json":
                return 200, json.dumps({"Config": {"Labels": expected_labels}}).encode()
            if path == "/networks/network-1/disconnect":
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            await worker._disconnect_compose_agent_if_attached("network-1")

        self.assertEqual([call[0:2] for call in calls], [
            ("GET", "/networks/network-1"),
            ("GET", "/containers/agent-id/json"),
            ("POST", "/networks/network-1/disconnect"),
        ])

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
            if method == "GET" and path == "/networks/network-a":
                return 200, b'{"Containers":{}}'
            if method == "DELETE":
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            result = await worker.reap_orphaned_workers()

        self.assertEqual(result, (2, 1))
        self.assertEqual(sum(method == "DELETE" and path.startswith("/containers/") for method, path in calls), 2)
        self.assertEqual(sum(method == "DELETE" and path.startswith("/networks/") for method, path in calls), 1)

    async def test_startup_reaper_detaches_verified_agent_before_removing_terminal_network(self):
        labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            if method == "GET" and path.startswith("/containers/json?"):
                return 200, b'[{"Id":"broker-id"}]' if "reamon-docker-broker" in path else b"[]"
            if (method, path) == ("GET", "/networks?filters=%7B%22label%22%3A+%5B%22reamon.project-worker%3D1%22%5D%7D"):
                return 200, b'[{"Id":"network-a"}]'
            if (method, path) == ("GET", "/networks/network-a"):
                return 200, b'{"Containers":{"agent-id":{"Name":"generated-agent"}}}'
            if (method, path) == ("GET", "/containers/agent-id/json"):
                return 200, json.dumps({"Config": {"Labels": labels}}).encode()
            if (method, path) == ("POST", "/networks/network-a/disconnect"):
                return 204, b""
            if method == "DELETE":
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            result = await worker.reap_orphaned_workers()

        self.assertEqual(result, (0, 1))
        disconnect_index = next(i for i, call in enumerate(calls) if call[1] == "/networks/network-a/disconnect")
        delete_index = next(i for i, call in enumerate(calls) if call[0] == "DELETE")
        self.assertLess(disconnect_index, delete_index)
        self.assertEqual(calls[disconnect_index][2], {"Container": "agent-id", "Force": True})

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
            await worker._create_worker_network("project-1", terminal=True)

        self.assertEqual([body["Internal"] for body in bodies], [True, False, True])
        self.assertNotIn("reamon.terminal-worker", bodies[0]["Labels"])
        self.assertNotIn("reamon.terminal-worker", bodies[1]["Labels"])
        self.assertEqual(bodies[2]["Labels"]["reamon.terminal-worker"], "1")

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
        self.assertEqual(body["HostConfig"]["Memory"], worker.WORKER_MEMORY)
        self.assertEqual(body["HostConfig"]["Mounts"], mounts)
        self.assertNotIn("find /tmp", " ".join(body["Entrypoint"]))
        self.assertEqual(body["HostConfig"]["PidsLimit"], worker.WORKER_PIDS)
        self.assertEqual(body["HostConfig"]["NanoCpus"], worker.WORKER_NANO_CPUS)
        self.assertIn(
            f"--fsize={worker.WORKER_MAX_FILE_BYTES}:{worker.WORKER_MAX_FILE_BYTES}",
            body["Entrypoint"],
        )
        self.assertEqual(body["Labels"]["reamon.terminal-worker"], "1")
        self.assertEqual(body["Labels"]["reamon.project-scope"], hashlib.sha256(b"project-1").hexdigest())
        self.assertIn("REDAMON_CTX=signed-graph-context", body["Env"])
        self.assertNotIn("SCANNER_API_KEY", " ".join(body["Env"]))

    async def test_terminal_admission_connects_resolved_agent_id(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            return 200, b"{}"

        with (
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network", return_value="net-1") as create_network,
            mock.patch.object(worker, "_trusted_agent_container_id", return_value="agent-id"),
            mock.patch.object(worker, "_create_terminal_container", return_value="terminal-id"),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
        ):
            self.assertEqual(
                await worker._create_admitted_terminal(identity),
                ("net-1", "terminal-id"),
            )

        self.assertEqual(calls[0][0:2], ("POST", "/networks/net-1/connect"))
        self.assertEqual(calls[0][2]["Container"], "agent-id")
        create_network.assert_awaited_once_with("project-1", terminal=True)

    async def test_terminal_start_failure_disconnects_agent_before_network_delete(self):
        identity = {
            "project_id": "project-1", "user_id": "owner-1",
            "session_id": "session-1", "graph_ctx": "signed-graph-context",
        }
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            return 200, b"{}"

        with (
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_create_worker_network", return_value="net-1"),
            mock.patch.object(worker, "_trusted_agent_container_id", return_value="agent-id"),
            mock.patch.object(worker, "_create_terminal_container", side_effect=worker.DockerAPIError("create failed")),
            mock.patch.object(worker, "_docker_request", side_effect=docker),
            mock.patch.object(worker, "_disconnect_terminal_agent") as disconnect,
        ):
            with self.assertRaisesRegex(worker.DockerAPIError, "create failed"):
                await worker._create_admitted_terminal(identity)

        disconnect.assert_awaited_once_with("net-1", "agent-id")
        self.assertEqual(calls[-1][0:2], ("DELETE", "/networks/net-1"))

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
            mock.patch.object(worker, "_disconnect_terminal_agent") as disconnect_agent,
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            await worker.serve_terminal("signed-context", 24, 80, browser_reader, tunnel_writer)

        self.assertEqual(bytes(attach_writer.data), input_bytes)
        resize_calls = [call for call in docker_request.await_args_list if "/resize?" in call.args[1]]
        self.assertTrue(any("h=40&w=120" in call.args[1] for call in resize_calls))
        self.assertTrue(attach_writer.closed)
        self.assertTrue(bytes(tunnel_writer.data).startswith(b"HTTP/1.1 200 OK"))
        self.assertIn(b"O" + len(b"terminal output").to_bytes(4, "big") + b"terminal output", tunnel_writer.data)
        disconnect_agent.assert_awaited_once_with("net-1")
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
            mock.patch.object(worker, "_disconnect_terminal_agent") as disconnect_agent,
            mock.patch.object(worker, "_remove_worker") as cleanup,
        ):
            await worker.serve_terminal("signed-context", 24, 80, browser_reader, tunnel_writer)

        self.assertTrue(tunnel_writer.closed)
        disconnect_agent.assert_awaited_once_with("net-1")
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
                data = {
                    "Config": {"Labels": {
                        "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
                        "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                    }},
                    "Mounts": [{
                        "Destination": "/workspace",
                        "Source": r"C:\REAmon\workspace",
                    }],
                }
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
        self.assertEqual(
            [mount["Target"] for mount in mounts],
            ["/workspace", "/tmp", "/workspace/.reamon-tmp", "/workspace/tool-outputs"],
        )

    async def test_workspace_lookup_finds_compose_agent_with_generated_container_name(self):
        digest = "sha256:" + "d" * 64
        filters_seen = []

        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual(method, "GET")
            if path == "/containers/redamon-agent/json":
                return 404, b"{}"
            if path.startswith("/containers/json?"):
                filters = json.loads(parse_qs(urlsplit(path).query)["filters"][0])
                filters_seen.append(filters)
                return 200, json.dumps([{
                    "Id": "a" * 64,
                    "State": "running",
                    "Labels": {
                        "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
                        "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                    },
                }]).encode()
            if path == "/containers/" + "a" * 64 + "/json":
                data = {
                    "Config": {"Labels": {
                        "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
                        "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                    }},
                    "Mounts": [{
                        "Destination": "/workspace",
                        "Source": r"C:\REAmon\workspace",
                    }],
                }
                return 200, json.dumps(data).encode()
            self.assertEqual(path, "/images/reamon-project-worker%3Alatest/json")
            return 200, json.dumps({"Id": digest}).encode()

        with tempfile.TemporaryDirectory() as workspace_root:
            os.mkdir(os.path.join(workspace_root, "project-1"))
            with (
                mock.patch.object(worker, "WORKSPACE_ROOT", workspace_root),
                mock.patch.object(worker, "WORKSPACE_HOST_PATH", ""),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
            ):
                mounts, image = await worker._workspace_project_runtime("project-1")

        self.assertEqual(filters_seen, [{
            "label": [
                f"com.docker.compose.project={worker.WORKSPACE_COMPOSE_PROJECT}",
                f"com.docker.compose.service={worker.WORKSPACE_COMPOSE_SERVICE}",
            ],
            "status": ["running"],
        }])
        self.assertEqual(image, digest)
        self.assertEqual(mounts[0]["Source"], "/run/desktop/mnt/host/c/REAmon/workspace/project-1")

    async def test_workspace_lookup_fails_closed_when_compose_agent_is_ambiguous(self):
        labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }

        async def docker(method, path, body=None, **_kwargs):
            if path == "/containers/redamon-agent/json":
                return 404, b"{}"
            self.assertTrue(path.startswith("/containers/json?"))
            return 200, json.dumps([
                {"Id": "agent-a", "State": "running", "Labels": labels},
                {"Id": "agent-b", "State": "running", "Labels": labels},
            ]).encode()

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            with self.assertRaisesRegex(worker.DockerAPIError, "ambiguous or unavailable"):
                await worker._workspace_project_runtime("project-1")

    async def test_workspace_host_path_overrides_docker_desktop_shim_path(self):
        digest = "sha256:" + "c" * 64

        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual(method, "GET")
            if path == "/containers/redamon-agent/json":
                data = {
                    "Config": {"Labels": {
                        "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
                        "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
                    }},
                    "Mounts": [{
                        "Destination": "/workspace",
                        "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu-24.04/shim",
                    }],
                }
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
        self.assertNotIn("find /tmp", " ".join(body["Entrypoint"]))
        self.assertEqual(
            body["Labels"]["reamon.project-scope"],
            hashlib.sha256(b"p1").hexdigest(),
        )
        self.assertNotIn("redamon.broker-owned", body["Labels"])
        self.assertNotIn("p1", body["Labels"].values())
        self.assertFalse(body["Tty"])
        self.assertEqual(body["HostConfig"]["LogConfig"]["Config"]["max-size"], "8m")
        self.assertIn(
            f"--fsize={worker.WORKER_MAX_FILE_BYTES}:{worker.WORKER_MAX_FILE_BYTES}",
            body["Entrypoint"],
        )
        self.assertEqual(body["Entrypoint"][-1], "reamon-worker")

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

    async def test_idle_project_scratch_is_collected_under_admission(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=0),
            mock.patch.object(worker, "_active_project_worker_count", return_value=0),
            mock.patch.object(worker, "_collect_idle_project_scratch") as collect,
            mock.patch.object(worker, "_create_worker_network", return_value="net-1"),
            mock.patch.object(worker, "_create_worker_container", return_value="ctr-1"),
            mock.patch.object(worker, "_run_worker", return_value=(0, b"ok", b"", False)),
            mock.patch.object(worker, "_remove_worker"),
        ):
            status, _result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 200)
        collect.assert_called_once_with("p1")

    async def test_scratch_is_not_collected_while_project_has_active_worker(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
            mock.patch.object(broker, "BROKER_MAX_CONTAINERS", 0),
            mock.patch.object(worker, "_active_worker_count", return_value=1),
            mock.patch.object(worker, "_active_project_worker_count", return_value=1),
            mock.patch.object(worker, "_collect_idle_project_scratch") as collect,
            mock.patch.object(worker, "_create_worker_network", return_value="net-1"),
            mock.patch.object(worker, "_create_worker_container", return_value="ctr-1"),
            mock.patch.object(worker, "_run_worker", return_value=(0, b"ok", b"", False)),
            mock.patch.object(worker, "_remove_worker"),
        ):
            status, _result = await worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            })

        self.assertEqual(status, 200)
        collect.assert_not_called()

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

    async def test_cancelled_run_stays_cancelled_when_cleanup_fails(self):
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
            mock.patch.object(worker, "_remove_worker", side_effect=worker.DockerAPIError("cleanup failed")) as cleanup,
            mock.patch.object(worker, "_log_cleanup_failure") as log_cleanup,
        ):
            task = asyncio.create_task(worker.execute({
                "ctx": "signed", "tool": "kali_shell", "argv": ["id"], "timeout": 10,
            }))
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        cleanup.assert_awaited_once_with("ctr-1", "net-1")
        log_cleanup.assert_called_once_with("execution")


class ProjectWorkerCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_transient_delete_failure_retries_and_confirms_both_resources(self):
        calls = []

        async def docker(method, path, *_args, **_kwargs):
            calls.append((method, path))
            if path.startswith("/containers/") and calls.count((method, path)) == 1:
                return 500, b"internal details must not be surfaced"
            return 204, b""

        with (
            mock.patch.object(worker, "_docker_request", side_effect=docker),
            mock.patch.object(worker.asyncio, "sleep", new=mock.AsyncMock()),
        ):
            await worker._remove_worker("worker-1", "network-1")

        self.assertEqual(calls.count(("DELETE", "/containers/worker-1?force=true&v=true")), 2)
        self.assertEqual(calls.count(("DELETE", "/networks/network-1")), 1)

    async def test_persistent_delete_failures_are_reported_after_both_retries(self):
        calls = []

        async def docker(method, path, *_args, **_kwargs):
            calls.append((method, path))
            return 500, b"internal details must not be surfaced"

        with (
            mock.patch.object(worker, "_docker_request", side_effect=docker),
            mock.patch.object(worker.asyncio, "sleep", new=mock.AsyncMock()),
        ):
            with self.assertRaisesRegex(worker.DockerAPIError, "cleanup incomplete"):
                await worker._remove_worker("worker-1", "network-1")

        self.assertEqual(calls.count(("DELETE", "/containers/worker-1?force=true&v=true")), worker.WORKER_CLEANUP_ATTEMPTS)
        self.assertEqual(calls.count(("DELETE", "/networks/network-1")), worker.WORKER_CLEANUP_ATTEMPTS)

    async def test_project_cleanup_detaches_verified_terminal_agent(self):
        project_id = "project-terminal-cleanup"
        scope = worker._project_scope_label(project_id)
        labels = {
            "com.docker.compose.project": worker.WORKSPACE_COMPOSE_PROJECT,
            "com.docker.compose.service": worker.WORKSPACE_COMPOSE_SERVICE,
        }
        network = {"Id": "network-terminal", "Labels": {
            "reamon.project-worker": "1", "reamon.project-scope": scope,
        }}
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path, body))
            if method == "GET" and path.startswith("/containers/json?"):
                return 200, b"[]"
            if method == "GET" and path.startswith("/networks?"):
                return 200, json.dumps([network]).encode()
            if (method, path) == ("GET", "/networks/network-terminal"):
                return 200, b'{"Containers":{"agent-id":{"Name":"generated-agent"}}}'
            if (method, path) == ("GET", "/containers/agent-id/json"):
                return 200, json.dumps({"Config": {"Labels": labels}}).encode()
            if (method, path) == ("POST", "/networks/network-terminal/disconnect"):
                return 204, b""
            if (method, path) == ("DELETE", "/networks/network-terminal"):
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def no_shared_lock():
            yield

        with tempfile.TemporaryDirectory() as state_dir:
            with (
                mock.patch.object(admission_state, "LOCK_PATH", os.path.join(state_dir, "container-create.lock")),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
                mock.patch("admission_lock.admission_lock", no_shared_lock),
            ):
                result = await worker.cleanup_project_workers(project_id)

        self.assertEqual(result, (0, 1))
        disconnect_index = next(i for i, call in enumerate(calls) if call[1] == "/networks/network-terminal/disconnect")
        delete_index = next(i for i, call in enumerate(calls) if call[0] == "DELETE")
        self.assertLess(disconnect_index, delete_index)
        self.assertEqual(calls[disconnect_index][2], {"Container": "agent-id", "Force": True})

    async def test_cleanup_removes_only_workers_and_networks_with_verified_project_scope(self):
        project_id = "project-alpha"
        target_scope = worker._project_scope_label(project_id)
        other_scope = worker._project_scope_label("project-beta")
        resources = {
            "workers": [
                {"Id": "worker-alpha", "Labels": {
                    "reamon.project-worker": "1", "reamon.project-scope": target_scope,
                }},
                {"Id": "worker-beta", "Labels": {
                    "reamon.project-worker": "1", "reamon.project-scope": other_scope,
                }},
            ],
            "networks": [
                {"Id": "network-alpha", "Labels": {
                    "reamon.project-worker": "1", "reamon.project-scope": target_scope,
                }},
                {"Id": "network-beta", "Labels": {
                    "reamon.project-worker": "1", "reamon.project-scope": other_scope,
                }},
            ],
        }
        deleted = []
        inspected = []

        def matching(items, labels):
            return [
                item for item in items
                if all(item["Labels"].get(label.partition("=")[0]) == label.partition("=")[2]
                       for label in labels)
            ]

        async def docker(method, path, body=None, **_kwargs):
            if method == "GET" and path.startswith("/containers/json?"):
                query = parse_qs(urlsplit(path).query)
                labels = json.loads(query["filters"][0]).get("label", [])
                return 200, json.dumps(matching(resources["workers"], labels)).encode()
            if method == "GET" and path.startswith("/networks?"):
                query = parse_qs(urlsplit(path).query)
                labels = json.loads(query["filters"][0]).get("label", [])
                return 200, json.dumps(matching(resources["networks"], labels)).encode()
            if method == "GET" and path == "/containers/worker-alpha/json":
                inspected.append(path)
                return 200, json.dumps({"NetworkSettings": {"Networks": {
                    "current": {"NetworkID": "network-alpha"},
                    "legacy-unlabeled": {"NetworkID": "legacy-network-alpha"},
                }}}).encode()
            if method == "GET" and path in {"/networks/network-alpha", "/networks/legacy-network-alpha"}:
                return 200, b'{"Containers":{}}'
            if method == "DELETE":
                deleted.append(path)
                return 204, b""
            self.fail(f"Unexpected Docker request: {method} {path}")

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def no_shared_lock():
            yield

        with tempfile.TemporaryDirectory() as state_dir:
            with (
                mock.patch.object(admission_state, "LOCK_PATH", os.path.join(state_dir, "container-create.lock")),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
                mock.patch("admission_lock.admission_lock", no_shared_lock),
            ):
                result = await worker.cleanup_project_workers(project_id)

        self.assertEqual(result, (1, 2))
        self.assertEqual(deleted, [
            "/containers/worker-alpha?force=true&v=true",
            "/networks/legacy-network-alpha",
            "/networks/network-alpha",
        ])
        self.assertEqual(inspected, ["/containers/worker-alpha/json"])

    async def test_cleanup_fails_closed_on_unexpected_worker_or_network_labels(self):
        project_id = "project-alpha"
        scope = worker._project_scope_label(project_id)
        foreign_worker = {"Id": "worker-beta", "Labels": {
            "reamon.project-worker": "1",
            "reamon.project-scope": worker._project_scope_label("project-beta"),
        }}
        target_worker = {"Id": "worker-alpha", "Labels": {
            "reamon.project-worker": "1", "reamon.project-scope": scope,
        }}
        foreign_network = {"Id": "network-beta", "Labels": {
            "reamon.project-worker": "1",
            "reamon.project-scope": worker._project_scope_label("project-beta"),
        }}
        calls = []

        async def docker(method, path, body=None, **_kwargs):
            calls.append((method, path))
            if method == "GET" and path.startswith("/containers/json?"):
                return 200, json.dumps([foreign_worker if len(calls) == 1 else target_worker]).encode()
            if method == "GET" and path.startswith("/networks?"):
                return 200, json.dumps([foreign_network]).encode()
            self.fail(f"Cleanup mutated or inspected resources unexpectedly: {method} {path}")

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def no_shared_lock():
            yield

        with tempfile.TemporaryDirectory() as state_dir:
            with (
                mock.patch.object(admission_state, "LOCK_PATH", os.path.join(state_dir, "container-create.lock")),
                mock.patch.object(worker, "_docker_request", side_effect=docker),
                mock.patch("admission_lock.admission_lock", no_shared_lock),
            ):
                with self.assertRaisesRegex(worker.DockerAPIError, "invalid project worker inventory"):
                    await worker.cleanup_project_workers(project_id)
                with self.assertRaisesRegex(worker.DockerAPIError, "invalid project network inventory"):
                    await worker.cleanup_project_workers(project_id)

        self.assertEqual(len(calls), 3)
        self.assertTrue(all(method == "GET" for method, _path in calls))


class ProjectScopeTombstoneTests(unittest.IsolatedAsyncioTestCase):
    async def test_tombstone_persists_beside_the_shared_admission_lock_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as state_dir:
            lock_path = os.path.join(state_dir, "container-create.lock")
            with mock.patch.object(admission_state, "LOCK_PATH", lock_path):
                path = admission_state.project_scope_tombstone_path("project-deleted")
                self.assertEqual(os.path.dirname(os.path.dirname(path)), state_dir)
                self.assertTrue(admission_state.tombstone_project_scope("project-deleted"))
                self.assertTrue(admission_state.tombstone_project_scope("project-deleted"))
                self.assertTrue(admission_state.is_project_scope_tombstoned("project-deleted"))
                self.assertTrue(os.path.isfile(path))

    async def test_terminal_admission_rejects_a_tombstoned_project_with_specific_error(self):
        project_id = "project-deleted-terminal"
        with tempfile.TemporaryDirectory() as state_dir:
            lock_path = os.path.join(state_dir, "container-create.lock")
            from contextlib import asynccontextmanager

            @asynccontextmanager
            async def no_shared_lock():
                yield

            with (
                mock.patch.object(admission_state, "LOCK_PATH", lock_path),
                mock.patch("admission_lock.admission_lock", no_shared_lock),
            ):
                admission_state.tombstone_project_scope(project_id)
                with self.assertRaisesRegex(
                    worker.WorkerAdmissionError,
                    "project scope was deleted; worker admission is closed",
                ) as raised:
                    await worker._create_admitted_terminal({"project_id": project_id})

        self.assertEqual(raised.exception.status_code, 410)

    async def test_preverified_execution_waiting_for_cleanup_lock_is_rejected(self):
        project_id = "project-race"
        with tempfile.TemporaryDirectory() as state_dir:
            lock_path = os.path.join(state_dir, "container-create.lock")
            shared = asyncio.Lock()
            await shared.acquire()
            cleanup_waiting = asyncio.Event()
            execution_waiting = asyncio.Event()

            @asynccontextmanager
            async def shared_admission_lock():
                name = asyncio.current_task().get_name()
                if name == "cleanup":
                    cleanup_waiting.set()
                elif name == "preverified-execution":
                    execution_waiting.set()
                async with shared:
                    yield

            async def empty_inventory(method, path, body=None, **_kwargs):
                if method == "GET" and (path.startswith("/containers/json?") or path.startswith("/networks?")):
                    return 200, b"[]"
                self.fail(f"Tombstoned execution reached Docker: {method} {path}")

            verify_finished = threading.Event()

            def verify_context(_ctx, _tool):
                verify_finished.set()
                return project_id

            cleanup_lock = asyncio.Lock()
            execution_lock = asyncio.Lock()
            with (
                mock.patch.object(admission_state, "LOCK_PATH", lock_path),
                mock.patch("admission_lock.admission_lock", shared_admission_lock),
                mock.patch.object(worker, "_WORKER_ADMISSION_LOCK", cleanup_lock),
                mock.patch.object(worker, "_docker_request", side_effect=empty_inventory),
            ):
                cleanup_task = asyncio.create_task(
                    worker.cleanup_project_workers(project_id), name="cleanup",
                )
                await asyncio.wait_for(cleanup_waiting.wait(), timeout=1)

                # A separate broker process has its own in-process lock, but
                # shares the admission-volume lock and tombstone directory.
                with mock.patch.object(worker, "_WORKER_ADMISSION_LOCK", execution_lock):
                    with (
                        mock.patch.object(worker, "_verify_context_sync", side_effect=verify_context),
                        mock.patch.object(worker, "_active_worker_count", new=mock.AsyncMock()) as active_count,
                        mock.patch.object(worker, "_create_worker_network", new=mock.AsyncMock()) as create_network,
                    ):
                        execution_task = asyncio.create_task(worker.execute({
                            "ctx": "already-verified", "tool": "kali_shell", "argv": ["id"],
                        }), name="preverified-execution")
                        self.assertTrue(await asyncio.to_thread(verify_finished.wait, 1))
                        await asyncio.wait_for(execution_waiting.wait(), timeout=1)
                        shared.release()
                        await cleanup_task
                        status, body = await execution_task

                self.assertEqual(status, 410)
                self.assertIn("project scope was deleted", body["error"])
                active_count.assert_not_awaited()
                create_network.assert_not_awaited()
                self.assertTrue(admission_state.is_project_scope_tombstoned(project_id))


def _make_scanner_scope_token(project_id="project-alpha", user_id="user-alpha", secret="master-secret"):
    now = int(time.time())
    payload = json.dumps({
        "v": 1, "projectId": project_id, "userId": user_id,
        "iat": now - 1, "exp": now + 300,
    }, separators=(",", ":")).encode()
    encoded = base64.urlsafe_b64encode(payload).decode().rstrip("=")
    signature = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest(),
    ).decode().rstrip("=")
    return f"{encoded}.{signature}"


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

    async def request(self, method, path, key="", payload=b"{}", extra_headers=None):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        extra = "".join(f"{name}: {value}\r\n" for name, value in (extra_headers or {}).items())
        writer.write(
            f"{method} {path} HTTP/1.1\r\nHost: localhost\r\n"
            f"X-Internal-Key: {key}\r\n{extra}Content-Length: {len(payload)}\r\n\r\n".encode()
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

    async def test_project_cleanup_verifies_scanner_scope_and_returns_cleanup_counts(self):
        body = {"project_id": "project-alpha", "user_id": "user-alpha"}
        payload = json.dumps(body).encode()
        scope = _make_scanner_scope_token()
        with (
            mock.patch.object(broker, "WORKER_API_KEY", "scanner-secret"),
            mock.patch.object(broker, "SCOPE_SIGNING_KEY", "master-secret"),
            mock.patch.object(worker, "cleanup_project_workers", new=mock.AsyncMock(return_value=(2, 2))) as cleanup,
        ):
            response = await self.request(
                "POST", "/worker/project/cleanup", key="scanner-secret", payload=payload,
                extra_headers={"X-Scanner-Scope": scope},
            )

        self.assertIn(b"200 OK", response)
        self.assertIn(b'{"removed_workers":2,"removed_networks":2}', response)
        cleanup.assert_awaited_once_with("project-alpha")

    async def test_project_cleanup_rejects_scope_that_does_not_match_body(self):
        body = {"project_id": "project-beta", "user_id": "user-alpha"}
        with (
            mock.patch.object(broker, "WORKER_API_KEY", "scanner-secret"),
            mock.patch.object(broker, "SCOPE_SIGNING_KEY", "master-secret"),
            mock.patch.object(worker, "cleanup_project_workers", new=mock.AsyncMock()) as cleanup,
        ):
            response = await self.request(
                "POST", "/worker/project/cleanup", key="scanner-secret",
                payload=json.dumps(body).encode(),
                extra_headers={"X-Scanner-Scope": _make_scanner_scope_token()},
            )

        self.assertIn(b"403 Forbidden", response)
        cleanup.assert_not_awaited()

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
