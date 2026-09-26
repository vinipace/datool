#!/usr/bin/env python3
"""Best-effort CI notifications: one deployment message, status in its thread."""

import argparse
import json
import os
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen


def escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def post(token, channel, text, thread_ts=None):
    body = {"channel": channel, "text": text, "unfurl_links": False, "unfurl_media": False}
    if thread_ts:
        body.update(thread_ts=thread_ts, reply_broadcast=False)
    request = Request("https://slack.com/api/chat.postMessage", data=json.dumps(body).encode(),
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    with urlopen(request, timeout=5) as response:
        result = json.load(response)
    if not result.get("ok") or result.get("channel") != channel or not result.get("ts"):
        raise RuntimeError("Slack delivery failed")
    return result["ts"]


def save(path, state):
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as handle:
        json.dump(state, handle)
    os.replace(temporary, path)


def notify(args, send=post):
    token, channel = os.environ.get("SLACK_BOT_TOKEN"), os.environ.get("SLACK_DEPLOYMENTS_CHANNEL")
    if not channel:
        print("Deployment Slack notifications disabled")
        return
    if not token or not channel or not re.fullmatch(r"[CG][A-Z0-9]+", channel):
        raise ValueError("Incomplete Slack configuration")
    path = Path(args.state_file)
    state = json.loads(path.read_text()) if path.exists() else {}
    identity = {"deployment_id": args.deployment_id, "channel": channel}
    if state and any(state.get(key) != value for key, value in identity.items()):
        raise ValueError("Use a separate state file for each deployment")
    if not state:
        state = {**identity, "started_at": time.time(), "sent": []}
    if args.status in state["sent"]:
        return
    # The runner must announce start before running the deployment. If Slack's
    # acknowledgement was lost, do not create another top-level message later.
    if args.status == "started":
        if state.get("parent_attempted"):
            raise RuntimeError("Parent delivery is uncertain; inspect Slack before retrying")
        state["parent_attempted"] = True
        save(path, state)
        message = (f":rocket: *{escape(args.app)} · {escape(args.environment)} deployment started*\n"
                   f"Revision: {escape(args.commit[:12])}\n"
                   f"Deployment: {escape(args.deployment_id)}\n<{escape(args.url)}|View deployment>")
        state["thread_ts"] = send(token, channel, message)
    else:
        if not state.get("thread_ts"):
            raise RuntimeError("No acknowledged parent message; status was not posted")
        elapsed = max(0, int(time.time() - state["started_at"]))
        icon = ":white_check_mark:" if args.status == "succeeded" else ":x:"
        message = f"{icon} *Deployment {args.status}* · {elapsed // 60}m {elapsed % 60}s\n<{escape(args.url)}|View deployment>"
        send(token, channel, message, state["thread_ts"])
    state["sent"].append(args.status)
    save(path, state)
    print(f"Deployment Slack status: {args.status}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("status", choices=["started", "succeeded", "failed"])
    for name in ("app", "environment", "deployment-id", "commit", "url", "state-file"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"https://[^\s<>|]+", args.url):
            raise ValueError("Expected an HTTPS deployment URL")
        notify(args)
    except Exception:
        # Notifications cannot change a deployment's result. Never print token,
        # request headers or provider responses (including HTTP exception text).
        print(f"deployment_notification_failed status={args.status}", flush=True)


if __name__ == "__main__":
    main()
