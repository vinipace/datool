"""Real Hermes -> OpenAI -> Datool E2E. Run with Hermes's Python environment.

Requires DATOOL_BASE_URL, DATOOL_PROJECT_ID, DATOOL_API_KEY and OPENAI_API_KEY.
Uses a fresh isolated HERMES_HOME and the normal plugin installer/discovery.
"""
import argparse
import importlib.util
from importlib.metadata import version
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from urllib.request import Request, urlopen
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", type=Path, help="Private JSON with base_url, project_id, api_key")
    parser.add_argument("--env-file", type=Path, help="Optional env file containing OPENAI_API_KEY")
    parser.add_argument("--state-dir", type=Path, default=ROOT / ".data/hermes-e2e")
    parser.add_argument("--model", default="gpt-6-luna")
    parser.add_argument("--project-slug", help="Project slug for browser links")
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file, override=False)
    if args.connection:
        for key, value in json.loads(args.connection.read_text()).items():
            os.environ["DATOOL_" + key.upper()] = value
    for key in ("DATOOL_BASE_URL", "DATOOL_PROJECT_ID", "DATOOL_API_KEY", "OPENAI_API_KEY"):
        if not os.environ.get(key):
            parser.error("Missing " + key)
    run = args.state_dir.resolve() / str(uuid.uuid4())
    run.mkdir(parents=True, mode=0o700)
    os.environ["HERMES_HOME"] = str(run / "home")
    os.environ["DATOOL_HERMES_STATE_DIR"] = str(run / "home/datool")
    os.environ["TERMINAL_CWD"] = str(run)
    os.environ["TERMINAL_ENV"] = "local"
    # Isolated test has no client integrations and disables auxiliary LLM reviews.
    os.environ["HERMES_DISABLE_UPDATE_CHECK"] = "1"
    hermes = str(Path(sys.executable).parent / "hermes")
    subprocess.run([sys.executable, str(ROOT / "integrations/hermes/install.py"), "--home", os.environ["HERMES_HOME"], "--hermes", hermes], check=True)
    (run / "numbers.txt").write_text("17\n25\n")
    os.chdir(run)
    from run_agent import AIAgent
    from hermes_cli.plugins import discover_plugins
    discover_plugins()
    session_id = "datool-e2e-" + str(uuid.uuid4())
    agent = AIAgent(
        model=args.model, provider="openai", api_key=os.environ["OPENAI_API_KEY"],
        base_url="https://api.openai.com/v1", api_mode="chat_completions",
        session_id=session_id, platform="cli", enabled_toolsets=["terminal"],
        max_iterations=8, max_tokens=2000, quiet_mode=True, reasoning_config={"enabled": False, "effort": "none"}, request_overrides={"reasoning_effort": "none"},
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        ephemeral_system_prompt="This is a bounded integration test in a disposable directory. Follow the exact requested terminal commands. Do not delegate tasks.",
    )
    first = agent.run_conversation(
        "Test tracing failure and recovery. Use the terminal tool to run `python3 -c 'import sys; print(\"EXPECTED_FAILURE\"); sys.exit(7)'`. "
        "That failure is intentional: continue afterwards. Then use the terminal tool to read numbers.txt, sum its two integers, "
        "and write their sum to result.txt with Python. Finally reply exactly HERMES_DATOOL_OK sum=42."
    )
    assert first["completed"] and not first["failed"], "First Hermes turn failed"
    assert "HERMES_DATOOL_OK" in first["final_response"], "Missing final answer"
    assert (run / "result.txt").read_text().strip() == "42", "Real tool output missing"
    second = agent.run_conversation(
        "Use the terminal tool to read result.txt. Reply exactly HERMES_DATOOL_SECOND sum=42.",
        conversation_history=first["messages"],
    )
    assert second["completed"] and not second["failed"], "Second Hermes turn failed"
    assert "HERMES_DATOOL_SECOND" in second["final_response"], "Missing second final answer"
    # Fresh process drains the same durable outbox, exercising restart/replay.
    subprocess.run([hermes, "datool", "flush", "--timeout", "120"], check=True)
    spec = importlib.util.spec_from_file_location("datool_test_ids", ROOT / "integrations/hermes/__init__.py")
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    datool_session = plugin.stable(os.environ["DATOOL_PROJECT_ID"], "session", session_id)
    base = os.environ["DATOOL_BASE_URL"].rstrip("/")
    def get(path):
        request = Request(base + path, headers={"Authorization": "Bearer " + os.environ["DATOOL_API_KEY"], "x-project-id": os.environ["DATOOL_PROJECT_ID"]})
        with urlopen(request, timeout=30) as response:
            return json.load(response)["data"]
    listing = get("/api/traces?sessionId=" + datool_session)
    rows = listing.get("items", listing.get("traces", [])) if isinstance(listing, dict) else listing
    assert len(rows) == 2, f"Expected two persisted traces; got {len(rows)}"
    traces = [get("/api/traces/" + row["id"]) for row in rows]
    spans = [s for t in traces for s in t["spans"]]
    tools = [s for s in spans if s["kind"] == "tool"]
    llms = [s for s in spans if s["kind"] == "llm"]
    assert all(t["status"] == "completed" for t in traces), "Trace not completed"
    for trace in traces:
        roots = [s for s in trace["spans"] if s["kind"] == "agent" and not s.get("parentId")]
        assert len(roots) == 1 and trace["input"] is not None, "Missing root agent or trace input"
        assert roots[0]["input"] == trace["input"], "Root agent input differs from captured trace input"
    assert any(s["status"] == "errored" and "EXPECTED_FAILURE" in json.dumps(s["output"]) for s in tools), "Failure not preserved"
    assert any(s["status"] == "completed" and "42" in json.dumps(s["output"]) for s in tools), "Recovery not preserved"
    assert all(s["input"] and s["output"] for s in llms), "Model request/response missing"
    expected = {"input_tokens": second["prompt_tokens"], "output_tokens": second["completion_tokens"],
                "total_tokens": second["total_tokens"], "cache_read_tokens": second["cache_read_tokens"],
                "cache_write_tokens": second["cache_write_tokens"], "reasoning_tokens": second["reasoning_tokens"]}
    actual = {key: sum(s["attributes"].get("usage." + key, 0) for s in llms) for key in expected}
    assert actual == expected, f"Usage mismatch: {actual} != {expected}"
    assert sum(t["attributes"]["usage.total_tokens"] for t in traces) == actual["total_tokens"]
    # Another restart must not duplicate anything already saved.
    subprocess.run([hermes, "datool", "flush", "--timeout", "30"], check=True)
    again = get("/api/traces?sessionId=" + datool_session)
    assert again == listing, "Replay changed persisted traces"
    evidence = {"verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": args.model,
                "hermesVersion": version("hermes-agent"), "projectId": os.environ["DATOOL_PROJECT_ID"],
                "sessionId": datool_session, "hermesSessionId": session_id,
                "traceIds": [t["id"] for t in traces], "llmCalls": len(llms), "toolCalls": len(tools),
                "failedTools": sum(s["status"] == "errored" for s in tools),
                "hermesUsage": expected, "datoolUsage": actual,
                "checks": ["real_openai", "real_terminal_failure_and_recovery", "two_turns_one_session", "persisted_trace_read", "root_agent_input", "exact_usage", "restart_no_duplicates"],
                "traceUrls": [base + "/p/" + quote(args.project_slug, safe="") + "/traces?trace=" + t["id"] for t in traces] if args.project_slug else [],
                "traceApiUrls": [base + "/api/traces/" + t["id"] for t in traces]}
    (run / "verification.json").write_text(json.dumps(evidence, indent=2))
    (run / "traces.json").write_text(json.dumps(traces, indent=2))
    (args.state_dir / "latest.json").write_text(json.dumps({"run": str(run), **evidence}, indent=2))
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
