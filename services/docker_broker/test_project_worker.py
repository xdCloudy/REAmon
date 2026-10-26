"""Focused policy and protocol checks for disposable project workers."""
import asyncio
import base64
import hashlib
import json
import os
import sys
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
    async def test_worker_environment_allows_only_signed_proxy_context(self):
        env = worker._worker_environment({
            "REDAMON_AGENT_URL": "http://agent:8080",
            "REDAMON_CTX": "opaque-signed-context",
        })
        self.assertIn("REDAMON_CTX=opaque-signed-context", env)
        with self.assertRaisesRegex(ValueError, "not allowed"):
            worker._worker_environment({"INTERNAL_API_KEY": "master-secret"})

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

        async def docker(method, path, body=None, **_kwargs):
            self.assertEqual((method, path), ("GET", "/containers/redamon-kali/json"))
            data = {
                "Image": digest,
                "Mounts": [{
                    "Destination": "/workspace",
                    "Source": r"C:\REAmon\workspace",
                }],
            }
            return 200, json.dumps(data).encode()

        with mock.patch.object(worker, "_docker_request", side_effect=docker):
            mounts, image = await worker._workspace_project_runtime("project-1")

        self.assertEqual(image, digest)
        self.assertEqual(mounts[0]["Target"], "/workspace")
        self.assertEqual(mounts[0]["Source"], r"C:\REAmon\workspace\project-1")
        self.assertTrue(mounts[0]["ReadOnly"])
        self.assertEqual(mounts[1]["Target"], "/tmp")
        self.assertFalse(mounts[1]["ReadOnly"])
        self.assertEqual(mounts[2]["Target"], "/workspace/.reamon-tmp")
        self.assertEqual(mounts[3]["Target"], "/workspace/tool-outputs")

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
        self.assertEqual(body["HostConfig"]["CapAdd"], ["NET_RAW"])
        self.assertTrue(body["HostConfig"]["ReadonlyRootfs"])
        self.assertEqual(body["HostConfig"]["Mounts"], mounts)
        self.assertEqual(
            body["Labels"]["reamon.project-scope"],
            hashlib.sha256(b"p1").hexdigest(),
        )
        self.assertNotIn("p1", body["Labels"].values())
        self.assertFalse(body["Tty"])
        self.assertEqual(body["HostConfig"]["LogConfig"]["Config"]["max-size"], "8m")

    async def test_fails_closed_when_worker_capacity_cannot_be_read(self):
        with (
            mock.patch.object(worker, "SCANNER_API_KEY", "scanner-key"),
            mock.patch.object(worker.asyncio, "to_thread", return_value="p1"),
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

    async def test_tcp_endpoint_never_exposes_docker_api(self):
        with mock.patch.object(broker, "WORKER_API_KEY", "secret"):
            response = await self.request("GET", "/containers/json", key="secret")
        self.assertIn(b"404 Not Found", response)


if __name__ == "__main__":
    unittest.main(verbosity=2)
