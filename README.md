# Token Saver Translator

This app turns a source prompt or PDF into the shortest practical language or compact format while trying to preserve the prompt's core meaning, streams the comparison live, and auto-routes each prompt to the cheapest suitable model.

## What it does

- Accepts a prompt in a ChatGPT-style web UI
- Accepts a PDF upload and extracts its text before optimization
- Compares multiple target languages and compact formats such as Mandarin, Japanese, English, JSON, and shorthand candidates
- Chooses the cheapest faithful option and also shows runner-up options
- Streams the rewrite live into the UI
- Scores prompt difficulty and auto-routes to the cheapest suggested model
- Shows estimated token savings, input-cost savings, latency savings, route details, and per-model example costs
- Keeps a neat per-prompt session history
- Runs in two modes:
  - `OPENAI_API_KEY` present: live multilingual optimization through the OpenAI Responses API
  - no key present: local fallback preview for offline demos and smoke tests

## Run locally

```bash
npm start
```

The app starts on [http://localhost:3000](http://localhost:3000).

Then open `http://localhost:3000` in your browser.

You can either:

- paste a prompt directly
- upload a PDF
- do both, which combines your typed instruction with extracted PDF text

## Enable live OpenAI mode

Set environment variables before starting the server, or place them in `.env.local`:

```bash
export OPENAI_API_KEY="your_key_here"
export OPENAI_MODEL="gpt-5.5"
```

Optional estimate tuning:

```bash
export INPUT_PRICE_PER_MILLION="1.25"
export BASE_LATENCY_MS="450"
export MS_PER_TOKEN="3.5"
```

The model router currently uses official pricing from the OpenAI API pricing page for `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.4-nano`, and treats `gpt-5.5` as the latest flagship model for the hardest prompts.

PDF extraction uses the local Python runtime plus `pypdf` and `pdfplumber` when available.

## Test

```bash
npm test
```

## Put it on the web

The easiest production path for this specific app is a Docker-based web service, because the PDF feature needs Python plus `pypdf` and `pdfplumber`.

### Recommended: Render

This repo now includes:

- `Dockerfile`
- `requirements.txt`
- `render.yaml`

Steps:

1. Push this repo to GitHub.
2. Create a Render account.
3. In Render, create a new Blueprint or Web Service from the repo.
4. Set `OPENAI_API_KEY` as an environment variable.
5. Deploy.

Render will give you an `onrender.com` URL first. After that, connect your real domain in the Render dashboard.

### Custom domain

After deploy:

1. Add your domain in Render.
2. Update DNS at your registrar.
3. Verify the domain in Render.

Render handles TLS certificates automatically.
