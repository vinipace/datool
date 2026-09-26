# Image creation playground

This workflow generates one JPEG with OpenAI and returns `{ image: { url, alt }, model }`. Datool previews that image in the run output. The scorer sends `output.image.url` as vision input and grades prompt adherence and visual quality.

1. Set `OPENAI_API_KEY` in the listener's environment and on the Datool server (the server runs the scorer). Image generation and grading use the paid OpenAI API.
2. Create a scorer using `scorer.json` through `POST /api/scorers`, or enter the same rubric in Scorers with **Images** set to `output.image.url` and a vision-capable model.
3. Optionally set `DATOOL_IMAGE_SCORER_ID` to the returned ID to preselect it for everyone connecting this manifest.
4. From the Datool checkout run `bun --no-env-file bin/datool.ts connect examples/image-playground/datool.config.ts` with your usual Datool URL, project, and API key configured.
5. Open **Playground → Image creation**, choose the scorer, edit the prompt, and run. Selected scorers execute automatically after successful generation; their results, explanations, and execution spans remain attached to the run.

Scorer choices are preserved in the playground URL. An explicit empty selection disables scoring for that run; otherwise manifest defaults apply. The API accepts a comma-separated `scorers` query parameter on `POST /api/apps/:id/runs`; the body remains the workflow's input. Scorer access and model configuration are checked before generation, and versions are pinned for the run. Scoring runs in the existing background evaluation service; server restarts can interrupt it, as with other background evaluations.

The example defaults to `gpt-image-1.5`, low quality, 1024×1024, and compressed JPEG. Set `OPENAI_IMAGE_MODEL` to use another compatible image model. For a standalone app, copy the manifest and import `defineApps` from `@datool/cli`.

Provider references: [image generation](https://developers.openai.com/api/docs/guides/image-generation) and [vision inputs](https://developers.openai.com/api/docs/guides/images-vision).
