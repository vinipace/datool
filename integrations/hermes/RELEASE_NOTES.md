Automatically send Hermes conversation turns, model requests, token usage, and
tool calls to Datool. Requires Hermes 0.21.3 or later.

Download the `datool-hermes-<version>.zip` asset and its `.sha256` checksum from
this release. Extract the ZIP, open the `datool-hermes` folder, and run:

```sh
python3 install.py
```

Enter your Datool HTTPS URL, project ID, and an API key with `traces:write`.
Restart your Hermes CLI or gateway, then open Traces in your Datool project.
Inspect delivery with `hermes datool status`; retry with `hermes datool flush`.

The ZIP contains only the standalone plugin source and installer. Credentials
and pending traces stay in your private Hermes profile. Prompts and tool content
are captured by default; the bundled README describes content controls and
coverage limits.

Plugin publication and deployment of Datool's web interface are separate releases.
