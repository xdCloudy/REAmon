#!/usr/bin/env python3
"""Self-contained plumbing test for the Docker broker (V4).

Runs the broker against a MOCK upstream (no real Docker, no background process),
sends raw Docker-API requests through the broker, and asserts:
  * an allowed `create` is FORWARDED to upstream and the response relayed,
  * a denied `create` (host escape) is BLOCKED with 403 and never reaches upstream,
  * a non-create request is forwarded transparently,
  * a denied request does not leak to upstream (the core safety property).

Run: cd docker_broker && python3 test_plumbing.py
"""
import asyncio
import json
import os
import sys
import tempfile
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broker  # noqa: E402

TMP = tempfile.mkdtemp(prefix="broker-plumb-")
MOCK_SOCK = os.path.join(TMP, "upstream.sock")
BROKER_SOCK = os.path.join(TMP, "broker.sock")

received = []  # requests the mock upstream actually saw
hold_create_response = None
create_request_received = None
PASS = 0
FAIL = 0


def check(desc, cond):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  PASS {desc}")
    else:
        FAIL += 1; print(f"  FAIL {desc}")


async def mock_upstream(reader, writer):
    # read whatever the broker forwards, record it, reply 200
    try:
        data = await asyncio.wait_for(reader.read(65536), timeout=2)
    except asyncio.TimeoutError:
        data = b""
    received.append(data)
    if hold_create_response is not None and b"/containers/create" in data:
        create_request_received.set()
        await hold_create_response.wait()
    body = b"[]" if b"GET /containers/json?" in data else b'{"Id":"deadbeef"}'
    writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                 b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                 b"Connection: close\r\n\r\n" + body)
    try:
        await writer.drain()
    except Exception:
        pass
    writer.close()


def make_request(method, path, body_obj=None):
    body = b"" if body_obj is None else json.dumps(body_obj).encode()
    head = (f"{method} {path} HTTP/1.1\r\n"
            f"Host: docker\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n\r\n").encode()
    return head + body


async def send(raw):
    r, w = await asyncio.open_unix_connection(BROKER_SOCK)
    w.write(raw)
    await w.drain()
    resp = b""
    try:
        while True:
            chunk = await asyncio.wait_for(r.read(4096), timeout=2)
            if not chunk:
                break
            resp += chunk
    except asyncio.TimeoutError:
        pass
    w.close()
    return resp


async def main():
    global hold_create_response, create_request_received
    broker.UPSTREAM_SOCK = MOCK_SOCK
    broker.ALLOWED_BIND_PREFIXES = ["/tmp/redamon"]

    up = await asyncio.start_unix_server(mock_upstream, path=MOCK_SOCK)
    br = await asyncio.start_unix_server(broker.handle_client, path=BROKER_SOCK)

    async with up, br:
        received.clear()
        active_count = await broker._count_broker_owned_active()
        decoded_query = urllib.parse.unquote(received[0].decode("latin1")) if received else ""
        check("container cap counts active states, including created workers",
              active_count == 0 and all(
                  f'"{state}"' in decoded_query
                  for state in ("created", "restarting", "running", "paused")
              ))

        # An enabled resource cap must reject a create if Docker cannot report
        # the current count; otherwise transient daemon errors disable the cap.
        original_max = broker.BROKER_MAX_CONTAINERS
        original_count = broker._count_broker_owned_active

        async def unknown_running_count():
            return -1

        broker.BROKER_MAX_CONTAINERS = 1
        broker._count_broker_owned_active = unknown_running_count
        received.clear()
        resp = await send(make_request(
            "POST", "/v1.43/containers/create", {"Image": "projectdiscovery/naabu:latest"}
        ))
        check("enabled count cap denies create when count is unavailable", b"403" in resp)
        check("unverified count cap denies without contacting Docker", not received)

        # Hold the first Docker create response while a second request arrives.
        # The admission lock must keep the second count check behind the first
        # create, so a burst cannot exceed the configured cap.
        count_calls = 0

        async def count_one_then_full():
            nonlocal count_calls
            count_calls += 1
            return 0 if count_calls == 1 else 1

        hold_create_response = asyncio.Event()
        create_request_received = asyncio.Event()
        broker._count_broker_owned_active = count_one_then_full
        received.clear()
        first = asyncio.create_task(send(make_request(
            "POST", "/v1.43/containers/create", {"Image": "projectdiscovery/naabu:latest"}
        )))
        second = None
        try:
            await asyncio.wait_for(create_request_received.wait(), timeout=2)
            second = asyncio.create_task(send(make_request(
                "POST", "/v1.43/containers/create", {"Image": "projectdiscovery/naabu:latest"}
            )))
            await asyncio.sleep(0.05)
            serialized_admission = count_calls == 1
            hold_create_response.set()
            first_response, second_response = await asyncio.gather(first, second)
        finally:
            hold_create_response.set()
            if second is None:
                await asyncio.gather(first, return_exceptions=True)
            else:
                await asyncio.gather(first, second, return_exceptions=True)
            hold_create_response = None
            create_request_received = None

        check("concurrent create waits for the prior capped create", serialized_admission)
        check("count cap admits only one concurrent create",
              b"200 OK" in first_response and b"403 Forbidden" in second_response
              and len(received) == 1)
        broker.BROKER_MAX_CONTAINERS = original_max
        broker._count_broker_owned_active = original_count

        # 1. allowed create -> forwarded, response relayed
        received.clear()
        resp = await send(make_request("POST", "/v1.43/containers/create",
                                       {"Image": "projectdiscovery/naabu:latest"}))
        check("allowed create -> 200 relayed", b"200 OK" in resp and b"deadbeef" in resp)
        check("allowed create -> reached upstream", len(received) == 1 and b"create" in received[0])

        # 2. denied create (host root) -> 403, NEVER reaches upstream (the safety property)
        received.clear()
        resp = await send(make_request("POST", "/v1.43/containers/create",
                                       {"Image": "projectdiscovery/naabu:latest",
                                        "HostConfig": {"Binds": ["/:/host"]}}))
        check("denied create -> 403", b"403" in resp and b"denied by docker-broker" in resp)
        check("denied create -> did NOT reach upstream", len(received) == 0)

        # 3. denied privileged -> blocked, not forwarded
        received.clear()
        resp = await send(make_request("POST", "/v1.43/containers/create",
                                       {"Image": "projectdiscovery/naabu:latest",
                                        "HostConfig": {"Privileged": True}}))
        check("denied privileged -> 403", b"403" in resp)
        check("denied privileged -> not forwarded", len(received) == 0)

        # 4. non-create request -> forwarded transparently
        received.clear()
        resp = await send(make_request("GET", "/v1.43/info"))
        check("non-create (GET /info) -> forwarded", len(received) == 1 and b"/info" in received[0])
        check("non-create -> response relayed", b"200 OK" in resp)

        # 5. denied pull -> blocked
        received.clear()
        resp = await send(make_request("POST", "/v1.43/images/create?fromImage=attacker/evil&tag=latest"))
        check("denied pull (bad image) -> 403", b"403" in resp and len(received) == 0)

        # 6. BYPASS: create-path variations must NOT smuggle an unvalidated create
        #    (trailing slash / double slash) with a malicious body to upstream.
        evil = {"Image": "projectdiscovery/naabu:latest", "HostConfig": {"Binds": ["/:/host"]}}
        for variant in ("/v1.43/containers/create/", "/v1.43//containers/create",
                        "//containers/create", "/containers/create/"):
            received.clear()
            resp = await send(make_request("POST", variant, evil))
            check(f"path-variant create '{variant}' blocked + not forwarded",
                  b"403" in resp and len(received) == 0)

    print()
    print(f"RESULT: PASS={PASS} FAIL={FAIL}")
    # cleanup
    for s in (MOCK_SOCK, BROKER_SOCK):
        try:
            os.unlink(s)
        except Exception:
            pass
    return 0 if FAIL == 0 else 1


def test_main_all_checks_pass():
    """pytest entrypoint: main() returns non-zero if any check failed."""
    import asyncio
    assert asyncio.run(main()) == 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
