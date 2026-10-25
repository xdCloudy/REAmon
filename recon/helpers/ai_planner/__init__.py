"""AI-planner helpers that delegate small LLM classification calls to the agent.

D3: these callers must present the internal/scanner key so the agent's now-
guarded ``/llm/*`` endpoints accept the request.
"""

import os


def internal_key_headers() -> dict:
    """Header dict carrying the internal/scanner API key for agent /llm/* calls.

    Prefers the scoped ``SCANNER_API_KEY`` (S3/E6) and falls back to
    ``INTERNAL_API_KEY`` for trusted non-scan callers. Scan containers receive
    only the scanner key; the orchestrator master key is never forwarded.
    """
    key = os.environ.get("SCANNER_API_KEY") or os.environ.get("INTERNAL_API_KEY") or ""
    return {"X-Internal-Key": key}


# One breaker shared by every agent /llm/* hook: they all reach the same agent,
# so a dead agent should stop being called after a few failures rather than
# costing each hook its 20-30s timeout per item. Threshold 3 (INTERNAL): the
# agent fails as a unit. The gate sits AFTER each hook's cache check, so a cache
# hit still answers while the breaker is open; when open, each hook returns its
# own existing fallback (SAFE_FALLBACK / current_tags), never raising.
def agent_llm_gate():
    """A one-shot gate for one agent /llm/* call. `.allowed` is False while the
    shared agent_llm breaker is open; feed the outcome back with `.record`."""
    from recon.helpers import circuit_breaker as cb

    class _Gate:
        def __init__(self):
            self._cb = cb
            self._breaker = cb.get_breaker("agent_llm", label="Agent-LLM",
                                           threshold=cb.INTERNAL_THRESHOLD)
            self.allowed = self._breaker.allow()
            self._epoch = self._breaker.epoch()

        def record(self, resp=None, exc=None):
            try:
                if exc is not None:
                    self._breaker.record(self._cb.Outcome.TRANSIENT, type(exc).__name__,
                                         epoch=self._epoch)
                    return
                outcome = self._cb.classify_http(resp, keyed=True)
                self._breaker.record(outcome, self._cb.http_detail(resp, outcome, keyed=True),
                                     epoch=self._epoch)
            except Exception:  # noqa: BLE001 - recording must never break a scan
                pass

    return _Gate()
