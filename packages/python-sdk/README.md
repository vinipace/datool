# Datool Python SDK

Python 3.10+ tracing, OpenTelemetry export, published prompts, and authenticated
API access. The package name and import are `datool`.

This is the first release candidate; it has not been published to PyPI. From a
checkout, install `pip install ./packages/python-sdk`, or build a wheel with
`uv build --project packages/python-sdk` and install that wheel.

Maintainers: [release setup and publishing](../../docs/package-releases.md).
The release workflow publishes to PyPI only when manually dispatched from `main`
after its package and persistence checks pass.

## Quickstart

Set `DATOOL_BASE_URL`, `DATOOL_PROJECT_ID`, and `DATOOL_API_KEY`. Use an
organization API key with `traces:write`; prompts require `prompts:read`.

```python
from datool import get_client, observe, propagate_attributes

datool = get_client()


@observe(as_type="tool")
def weather(city: str):
    return {"city": city, "temperature": 22}


session = datool.request("/api/sessions", "POST", {"name": "Weather chat"})
with propagate_attributes(session_id=session["id"], user_id="user-42"):
    with datool.start_as_current_observation(
        name="weather-assistant",
        as_type="agent",
        group={"type": "agent", "name": "weather-assistant", "version": "v1"},
        input={"city": "São Paulo"},
    ) as agent:
        result = weather("São Paulo")
        with datool.start_as_current_observation(
            name="answer", as_type="generation", model="my-model"
        ) as generation:
            generation.update(
                output="It is 22°C.",
                usage_details={"input": 20, "output": 8},
                cost_details={"total": 0.0001},
            )
        agent.update(output=result)

datool.shutdown()  # Flushes and closes the client's export thread.
```

## Instrumentation

Instrument Python code with `get_client()`, `@observe`,
`start_as_current_observation`, `start_observation`,
`update_current_observation`, `propagate_attributes`, and `flush`.
The SDK sends observations to Datool's native API.

- `@observe` and `@observe(...)` capture function inputs, outputs, timings, and
  exception types. `@datool.observe(...)` binds an explicit client. `self` and
  `cls` are excluded. Set `capture_input=False` or `capture_output=False` to opt out.
- Coroutines retain task-local nesting. Generators and async generators remain
  lazy and forward send/throw/close, including generator return values. Context
  is active only during production of a chunk. Close partially consumed streams
  (`close()` / `aclose()`) to record cancellation; unconsumed streams emit nothing.
  String chunks are concatenated up to the capture limit; other chunks retain
  the last value. Automatic capture does not parse provider-specific chunks.
- `start_as_current_observation(...)` automatically ends the observation and
  records errors/cancellation. It works inside both sync and async functions
  with an ordinary `with` statement. `start_observation(...)` leaves the active
  context unchanged and requires `.end()`. Both support nested child creation
  from an `Observation` object.
- Types: `span`, `generation`, `embedding`, `agent`, `task`, `tool`, `chain`, `retriever`,
  `evaluator`, `guardrail`, and `workflow`. These map to Datool operation kinds.
  Groups are explicit, fixed at creation, and never inherited by children.
- `propagate_attributes(session_id=..., user_id=..., metadata=...)` applies to
  observations started inside the scope. Sessions must already exist: create one
  with `request("/api/sessions", "POST", {"name": "Chat"})` and reuse its returned
  `id` across requests. Threads need ordinary OTel context
  propagation; the SDK does not monkey-patch thread creation.
- `Observation.id` is the OTel span ID; `.trace_id` is the Datool trace ID. A root
  non-generation observation is the trace container and has no separate span row.
- `usage_details` accepts `input`, `output`, `total`, `cache_read`, `cache_write`,
  and `reasoning` token counts. `cost_details` accepts `input`, `output`, and
  `total` USD. Costs are supplied by the caller; no pricing catalog is queried.
  Missing usage/cost stays missing. Trace and wrapper totals count LLM spans once.

## Configuration and lifecycle

```python
from datool import Datool

with Datool(
    base_url="http://127.0.0.1:3000",
    project_id="your-project",
    api_key="your-key",
    timeout=10,
    retries=3,
    max_queue_size=10_000,
    max_io_characters=20_000,
    mask=lambda value: value,  # Replace with application-specific I/O redaction.
) as datool:
    with datool.start_as_current_observation(name="request") as observation:
        observation.update(output={"ok": True})
```

Network export runs in a background thread. `flush(timeout=60)` waits for all
events queued before the call and their PostgreSQL receipt, not just HTTP 202.
It raises `DatoolError` for failed persistence, timeout, capture failure, or queue
overflow. Transient HTTP failures use bounded retries with stable event IDs;
unsent events stay in memory and the next `flush()` retries them. A failed
`shutdown()` keeps the client open for recovery. Pending events do not survive
process termination. Always flush/shut down short-lived processes; create a new
client in each worker process after a fork. End observations before shutdown.

`await datool.aflush()`, `await datool.ashutdown()`, and `async with Datool()`
perform blocking network waits off the event loop. HTTP errors expose a status
code but never echo response bodies, credentials, or server exceptions. Automatic
error capture records the exception type, not message/stacktrace. The `mask`
callback applies to native input/output capture, not arbitrary metadata or spans
created by third-party instrumentation.

## Existing OpenTelemetry instrumentation

```python
from opentelemetry.sdk.trace import TracerProvider
from datool import DatoolSpanProcessor

provider = TracerProvider(shutdown_on_exit=False)
processor = DatoolSpanProcessor()
provider.add_span_processor(processor)

with provider.get_tracer("my-app").start_as_current_span("request"):
    pass
processor.force_flush()  # Raises if durable delivery fails.
provider.shutdown()
```

Alternatively pass `tracer_provider=provider` to `Datool` to share a provider
with your installed provider/framework instrumentation. Datool never replaces
the global provider or shuts down a caller-owned provider. Install one Datool
processor per provider. GenAI OTel model, token, input/output, and tool-call
attributes are recognized. OpenAI client wrappers and connected evaluation
runners are not included in this first Python release.

## Automatic LangChain and LangGraph tracing

Install the optional integration from a checkout:

```sh
pip install './packages/python-sdk[langchain]' langgraph
```

Add the handler to your existing graph or LangChain runnable:

```python
from datool import get_client
from datool.langchain import CallbackHandler

datool = get_client()
handler = CallbackHandler()  # Or CallbackHandler(client=datool) for an explicit client.

result = graph.invoke(
    {"messages": [{"role": "user", "content": "What is the weather?"}]},
    config={"callbacks": [handler]},
)
datool.flush()
print(handler.last_trace_id)
```

No Datool decorators are needed on graph nodes. The handler records chains,
graph nodes, chat/text model calls, tools, and retrievers, with their input/output,
timing, and errors. Messages, documents, and LangGraph `Command`/`Send` state updates retain their
structured contents;
model responses provide model names and token usage, including cache/reasoning
counts when supplied. Costs are not estimated. The client's `mask` applies to
callback input/output; metadata and tags must already be safe to record. Serialized
model constructor arguments and exception messages are not captured.

Span kinds follow the callback evidence: generic LangGraph roots are `workflow`,
graph steps are `task`, and agent runs identified by `create_agent`/Deep Agents
metadata or serialized agent classes are `agent`. The legacy ReAct `agent` node
is also `agent`. Helpers such as `Prompt` and `RunnableSequence` remain `function`;
model calls are `llm` and tool calls are `tool`. Inherited graph metadata does not
reclassify helpers. Unknown chains fall back to `function`. Classification does
not create an Agents/Workflows group; group membership is still explicit.

The same `config` works with `ainvoke`, `stream`, and `astream`. Consume or explicitly
close streams before `flush()` / `await aflush()`. Model streams record the assembled
response and usage at completion, rather than exporting an event per token.
LangGraph state streams record the graph's final state. Callback recording failures
do not replace application exceptions; the client's flush reports them.

Handlers can be reused across concurrent requests. Run IDs establish parent/child
relationships, and completed runs are released. `last_trace_id` is only a convenience
for sequential calls; use a handler per invocation when you need its trace ID after
concurrent calls. Metadata and tags passed through the runnable config are captured.
Existing `propagate_attributes` scopes apply, and a graph invoked inside a Datool
observation joins that trace. Callbacks leave the active OpenTelemetry context
unchanged: manual observations created inside a node inherit the surrounding manual
context, not the callback node. On Python 3.10, pass the runnable `config` explicitly
to async child calls, as required by LangChain's context propagation.

Run the [LangGraph weather example](./examples/README.md):

```sh
uv run --project packages/python-sdk --group langgraph python \
  packages/python-sdk/examples/langgraph_weather.py --mode async
```

It supports `sync`, `async`, `stream`, and `async-stream` modes with parallel nodes
and nested LangChain tools. It uses the real LangGraph library with deterministic
weather data and no model provider call. The tests also exercise real LangChain
model lifecycles with a deterministic provider fixture. The installed-wheel
acceptance test verifies callback traces, nested tools/models, messages, token
usage, concurrency, and errors in PostgreSQL.

## ReAct agents and Deep Agents

Use the same callback for LangGraph's `create_react_agent`, LangChain's
`create_agent`, and Deep Agents' `create_deep_agent`:

```python
from datool import get_client
from datool.langchain import CallbackHandler

# agent is returned by create_agent, create_react_agent, or create_deep_agent.
handler = CallbackHandler()
result = agent.invoke(
    {"messages": [{"role": "user", "content": "What is the weather in São Paulo?"}]},
    config={"callbacks": [handler]},
)
get_client().flush()
```

Modern agent factories identify themselves automatically, including named Deep
Agents subagents. Legacy `create_react_agent` exposes its root as a generic graph;
use `CallbackHandler(root_type="agent")` to label that root as an agent too. This
optional hint applies only to root chain callbacks, never to their children or
model/tool callbacks. `root_type="workflow"` and `root_type="chain"` are also
available for custom entry points that lack identifying framework metadata.

This records model/tool loops and preserves delegated agents beneath their parent
`task` tool. Deep Agents planning tools return structured state updates, which are
captured along with their tool messages. No callback needs to be attached separately
to each delegated agent. These are local Python agents; remote agent services need
instrumentation within the remote process.

Runnable examples use a deterministic local model so no provider key is needed:

```sh
# Current LangChain ReAct agent API (create_agent).
uv run --project packages/python-sdk --python 3.12 --group agents python \
  packages/python-sdk/examples/react_agent.py --mode async

# LangGraph's older create_react_agent API.
uv run --project packages/python-sdk --group agents python \
  packages/python-sdk/examples/react_agent.py --legacy

# Deep Agent with a plan and a delegated weather specialist (Python 3.11+).
uv run --project packages/python-sdk --python 3.12 --group agents python \
  packages/python-sdk/examples/deep_agent.py --mode async-stream
```

Both examples support `sync`, `async`, `stream`, and `async-stream`. The models
execute actual library tool/delegation loops, but the offline model does not consume
or fabricate token/cost usage. Pass `--model provider:model-name` and install that
provider's LangChain package to use a real model. Deep Agents 0.7.18 requires Python
3.11+. With the tested LangChain 1.4.2 / LangGraph 1.2.12, modern `create_agent`
async calls also need Python 3.11+ for model callback propagation; the example rejects
that combination on 3.10. The SDK, legacy ReAct API, and synchronous modern agents
still support Python 3.10. `create_react_agent`
is deprecated upstream in favor of `create_agent`; the legacy example intentionally
checks compatibility. See [agent example details](./examples/README.md#react-agents-and-deep-agents).

## Published prompts and API access

```python
prompt = datool.prompts.get("answer", version=2)  # Omit version for latest published.
messages = prompt.render({"question": "What is Datool?"})
print(prompt.model, prompt.provider, prompt.settings)

# REST response `data` is returned as Python dictionaries/lists.
page = datool.request("/api/traces?limit=10")
```

`RuntimePrompt` exposes `id`, `slug`, `version`, `model`, `provider`, `messages`,
`metadata`, and `settings`. Render uses Datool's named `{{variables}}` syntax;
dotted names are literal keys, missing variables raise, values must be strings,
and inserted values are not interpolated again. No HTML escaping occurs.
`template="none"` leaves messages unchanged. Provider invocation stays in your app.

`prompts.aget(...)` and `arequest(...)` provide async network access. Latest
prompt definitions cache for 30 seconds; pinned versions cache until LRU eviction.
Configure `prompt_cache_ttl` (0–300 seconds) and `prompt_cache_size` (1–10,000).
Caches are private to each client and results are copied. Cached definitions can
outlive key revocation; create a new client to immediately discard them. Datool's
server prompt cache can add up to 60 seconds of staleness after missed invalidation.

`request(path, method="GET", body=None)` supports Datool `/api/` paths and returns
one response page; pagination is explicit. GET retries are safe; resource
mutations are not automatically retried. This escape hatch uses direct API
requests; tracing always uses the durable ingestion protocol.

## Development

```sh
uv sync --project packages/python-sdk --locked
uv run --project packages/python-sdk --group langgraph --group agents pytest
uv run --project packages/python-sdk ruff check packages/python-sdk
uv run --project packages/python-sdk mypy --config-file packages/python-sdk/pyproject.toml packages/python-sdk/src/datool
uv build --project packages/python-sdk
bun run test:python:integration
```

The integration test builds and installs a wheel in a fresh environment, starts
disposable PostgreSQL/Redis services, invokes the actual authenticated API handlers
and ingestion worker, and checks persisted traces/spans/receipts. It never uses
production credentials or databases.

Licensed under [Apache-2.0](./LICENSE).
