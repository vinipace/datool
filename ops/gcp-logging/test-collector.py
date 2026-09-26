#!/usr/bin/env python3
"""Exercise the real Fluent Bit parser/Lua/cursors with synthetic local logs."""
import datetime
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

SOURCE = Path(__file__).resolve().parent
IMAGE = "cr.fluentbit.io/fluent/fluent-bit:4.2.8"


def records(path):
    found = []
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            # stdout json_lines includes the record with a timestamp key.
            if isinstance(item, dict) and "message" in item:
                found.append(item)
    return found


def run_collector(work, pass_number, expected):
    name = "datool-logging-test-" + uuid.uuid4().hex[:10]
    output = work / f"output-{pass_number}.jsonl"
    command = ["docker", "run", "--rm", "--name", name, "--network", "none",
               "--mount", f"type=bind,source={SOURCE},target=/etc/datool-logging,readonly",
               "--mount", f"type=bind,source={work},target=/test",
               IMAGE, "-c", "/test/test.conf"]
    with output.open("w") as handle:
        process = subprocess.Popen(command, stdout=handle, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if len(records(output)) >= expected:
                    break
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read())
                time.sleep(0.2)
            else:
                raise AssertionError(f"Timed out waiting for {expected} records; got {records(output)}")
        finally:
            subprocess.run(["docker", "stop", "--time", "2", name], capture_output=True)
            _, stderr = process.communicate(timeout=10)
    if process.returncode != 0:
        raise RuntimeError(stderr)
    return records(output)


def main():
    with tempfile.TemporaryDirectory(prefix="datool-logging-test-") as directory:
        work = Path(directory)
        (work / "containers").mkdir()
        container_path = work / "containers" / ("datool.web.1." + "a" * 64 + ".log")
        now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        with container_path.open("w") as handle:
            handle.write(json.dumps({"log": 'first postgres://user:dbsecret@db:5432/app token=toksecret Bearer bearer-secret /api/auth/callback?code=oauthsecret\n',
                                     "stream": "stderr", "time": now}) + "\n")
        (work / "journal.log").write_text(json.dumps({"MESSAGE": "journal-canary", "PRIORITY": "4",
                                                      "_SYSTEMD_UNIT": "logrotate.service",
                                                      "UNEXPECTED_SECRET_FIELD": "must-not-export"}) + "\n")
        (work / "nginx.log").write_text('GET /sign-in?token=nginxsecret HTTP/1.1 200\n')
        conf = """[SERVICE]
    Flush 0.2
    Grace 1
    Log_Level error
    Parsers_File /etc/datool-logging/parsers.conf
    Parsers_File /test/parsers.conf
"""
        for name, path, parser in [("container", "/test/containers/*.log", "docker"),
                                    ("host", "/test/journal.log", "plain_json"),
                                    ("nginx", "/test/nginx.log", None)]:
            conf += f"""
[INPUT]
    Name tail
    Tag datool.{name}
    Path {path}
    Path_Key source_file
    DB /test/{name}.db
    DB.Compare_Filename On
    Read_From_Head On
    Refresh_Interval 1
"""
            if parser:
                conf += f"    Parser {parser}\n"
        conf += """
[FILTER]
    Name lua
    Match datool.*
    Script /etc/datool-logging/normalize.lua
    Call normalize
    Time_As_Table On
[OUTPUT]
    Name stdout
    Match *
    Format json_lines
"""
        (work / "test.conf").write_text(conf)
        (work / "parsers.conf").write_text("[PARSER]\n    Name plain_json\n    Format json\n")
        first = run_collector(work, 1, 3)
        assert len(first) == 3, first
        combined = json.dumps(first)
        for secret in ("dbsecret", "toksecret", "bearer-secret", "oauthsecret", "nginxsecret", "must-not-export"):
            assert secret not in combined, f"Unredacted synthetic secret: {secret}"
        by_stream = {entry["logging.googleapis.com/logName"]: entry for entry in first}
        assert by_stream["datool.container"]["severity"] == "ERROR"
        assert by_stream["datool.container"]["logging.googleapis.com/labels"]["container"] == "datool.web.1"
        assert by_stream["datool.host"]["severity"] == "WARNING"
        assert by_stream["datool.host"]["logging.googleapis.com/labels"]["unit"] == "logrotate.service"
        with container_path.open("a") as handle:
            handle.write(json.dumps({"log": "second-marker\n", "stream": "stdout", "time": now}) + "\n")
        second = run_collector(work, 2, 1)
        assert len(second) == 1 and second[0]["message"].strip() == "second-marker", second
        print("PASS: real Fluent Bit parsing, secret redaction, source/severity labels, and restart cursor resume")


if __name__ == "__main__":
    main()
