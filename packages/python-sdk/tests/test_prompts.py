import asyncio
import concurrent.futures

import httpx
import pytest

from datool import Datool, DatoolHTTPError


def test_prompt_render_cache_copy_pins_and_async():
    calls = []
    version = 1

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "data": {
                    "id": "prompt-1",
                    "slug": "answer",
                    "version": int(request.url.params.get("version", version)),
                    "model": "openai/gpt-test",
                    "provider": "gateway",
                    "template": "mustache",
                    "messages": [{"role": "user", "content": "{{ user.name }}: {{question}}"}],
                    "metadata": {"label": "original"},
                    "temperature": 0.5,
                    "output": "text",
                }
            },
        )

    client = Datool(
        api_key="key",
        project_id="project",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    prompt = client.prompts.get("answer")
    rendered = prompt.render({"user.name": "<Ada>", "question": "{{unexpanded}}"})
    assert rendered == [{"role": "user", "content": "<Ada>: {{unexpanded}}"}]
    with pytest.raises(ValueError, match="question, user.name"):
        prompt.render()
    with pytest.raises(ValueError, match="strings"):
        prompt.render({"question": 1})
    prompt.metadata["label"] = "changed"
    rendered[0]["content"] = "changed"
    assert client.prompts.get("answer").metadata["label"] == "original"
    assert len(calls) == 1
    version = 2
    assert client.prompts.get("answer", version=2).version == 2
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        assert all(
            p.version == 2
            for p in pool.map(lambda _: client.prompts.get("answer", version=2), range(10))
        )
    assert len(calls) == 2
    assert asyncio.run(client.prompts.aget("answer", version=2)).version == 2
    client.shutdown()


def test_expired_prompt_does_not_fall_back_on_auth_error():
    client = Datool(
        api_key="key",
        project_id="project",
        prompt_cache_ttl=0,
        http_client=httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(401))),
    )
    with pytest.raises(DatoolHTTPError):
        client.prompts.get("answer")
    for slug in ["../secret", "wrong/name", "UPPERCASE"]:
        with pytest.raises(ValueError):
            client.prompts.get(slug)
    for version in [True, 0, -1, 1.5]:
        with pytest.raises(ValueError):
            client.prompts.get("answer", version=version)
    client.shutdown()
