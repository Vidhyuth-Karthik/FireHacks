---
title: Hackathon Starter Kit API
emoji: 🚀
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# Hackathon Starter Kit - API

FastAPI backend, deployed here as its own Docker Space. The frontend
lives in a separate Static Space - see the `client` folder.

## Required Space secrets

Set these in this Space's **Settings > Variables and secrets**:

- `TURSO_DATABASE_URL` - from your Turso database
- `TURSO_AUTH_TOKEN` - from your Turso database
- `CORS_ORIGINS` - the client Space's URL, e.g.
  `https://your-username-your-client-space.hf.space`

## Local development

```
cd api
pip install -r requirements.txt
cp .env.example .env   # then fill in your Turso URL + auth token
uvicorn main:app --reload
```
