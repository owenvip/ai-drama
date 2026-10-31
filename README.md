# AI Drama

An AI short-drama production studio. Paste a novel chapter, and the system rewrites it into a screenplay, extracts and designs the cast/scenes/props, breaks the script into shots, generates reference images and Seedance video clips, then stitches the episode together with ffmpeg.

## Features

- **Novel → screenplay**: an LLM agent rewrites raw prose into a formatted screenplay (scenes, dialogue, action).
- **Asset extraction with de-duplication**: characters, scenes and props are extracted per episode and merged into the drama-wide asset library.
- **Prompt design**: dedicated agents produce model-ready prompts — character turnarounds, fixed-angle scene plates, white-background props, and per-shot video prompts.
- **Image generation**: OpenAI / Gemini / VolcEngine adapters, with per-drama model locking and style presets.
- **Storyboard breakdown**: the script is split into 10–15s shots, each bound to specific scenes, characters and props.
- **Video generation**: Seedance 2.0 multimodal reference (up to 9 images, 3 videos, 3 audios per shot) with `@scene` / `@character` mention syntax in prompts.
- **Episode merge**: shot clips are concatenated into a single episode MP4, with merge history kept.
- **Runtime-configurable AI**: providers, base URLs, API keys, models, agent instructions and skills are all edited in the Settings UI and stored in MySQL — no redeploy needed.
- **Editable agent skills**: each agent's behaviour is driven by Markdown `SKILL.md` files that can be edited online.

## Architecture

```
frontend/ (Nuxt 3 SPA, port 3013)
        │  REST /api/v1  +  /static
        ▼
backend/ (Hono + Mastra, port 5679, tsx runtime)
        ├── routes/     REST API
        ├── agents/     4 Mastra agents + tools (skills injected per request)
        ├── services/   generation, extraction, ffmpeg merge, provider adapters
        └── db/         Drizzle ORM + runtime idempotent DDL
        ▼
MySQL 8.4  +  data/static (generated media)
```

**Pipeline stages** (exposed per episode via `/api/v1/episodes/:id/pipeline-status`):

```
script_rewrite → extract_characters/scenes/props → generate_images
               → generate_video_prompts → generate_videos → merge_episode
```

## Tech stack

| Layer | Stack |
|---|---|
| Frontend | Nuxt 3 (SPA, `srcDir: app/`), Vue 3, `lucide-vue-next`, `vue-sonner` |
| Backend | Node 20, TypeScript, Hono, Mastra agents, Vercel AI SDK (`@ai-sdk/openai`, `@ai-sdk/google`) |
| Data | MySQL 8.4, Drizzle ORM (`mysql2`), Pino logging |
| Media | `fluent-ffmpeg` + `ffmpeg-static` / `ffprobe-static`, `sharp` |
| Runtime | `tsx` (TypeScript executed directly, no build step) |

AI providers are pluggable by `service_type`:

- **text**: `openai` · `gemini` · `volcengine`
- **image**: `openai` (`gpt-image-2`) · `gemini` (`gemini-3-pro-image`) · `volcengine` (`doubao-seedream-5-0`)
- **video**: `volcengine` Seedance 2.0 (`doubao-seedance-2-0-fast` by default)

## Quick start (Docker)

```bash
git clone <repo-url>
cd ai-drama
docker compose up -d --build
```

Open <http://localhost:5679>. MySQL data lives in the `mysql-data` volume; generated media is written to `./data` and editable skills to `./backend/workspace`.

## Local development

Requirements: Node.js 20+, MySQL 8.4 (or Docker).

```bash
# 1. Start MySQL only
docker compose up -d mysql

# 2. Backend
cd backend
cp .env.example .env      # adjust MYSQL_* / DATABASE_URL
npm install
npm run dev               # http://localhost:5679

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev               # http://localhost:3013, proxies /api and /static to 5679
```

The database schema is created/upgraded automatically at boot (idempotent DDL, 10 retries × 3s), so no migration step is required.

From the repository root you can also use:

```bash
npm run dev:backend     # cd backend && npm run dev
npm run dev:frontend    # cd frontend && npm run dev
npm run build:frontend  # cd frontend && npm run generate
```

## Configuration

### Environment variables (backend)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5679` | HTTP port of the API + static server |
| `DATABASE_URL` | — | Full MySQL URL; takes precedence over `MYSQL_*` |
| `MYSQL_HOST` | `127.0.0.1` | MySQL host |
| `MYSQL_PORT` | `3306` | MySQL port |password |
| `MYSQL_DATABASE` | `ai` | Database name |
| `MYSQL_CONNECTION_LIMIT` | `10` | Connection pool size |
| `STORAGE_PATH` | `<repo>/data/static` | Where generated media is stored and served from |
| `PUBLIC_BASE_URL` | — | Public URL of this backend; required to pass locally uploaded reference videos/audio to Seedance |

### AI credentials

API keys, base URLs and model lists are **not** read from env. Configure them once in **Settings → AI 服务** (`/api/v1/ai-configs`); the active config per service type is chosen by `is_active` + highest `priority`. Settings also hosts style presets, agent instructions and the skills editor.

## Project structure

```
.
├── backend/
│   ├── src/
│   │   ├── index.ts            # Hono app, route mounting, static serving
│   │   ├── routes/             # REST endpoints (dramas, episodes, storyboards, tasks, …)
│   │   ├── agents/             # mastra agents, tools, skills injection
│   │   ├── services/           # generation, extraction, ffmpeg merge, provider adapters
│   │   ├── mastra/             # Mastra instance registry
│   │   └── db/                 # Drizzle schema + runtime DDL
│   ├── workspace/skills/       # editable SKILL.md prompt specs per agent
│   └── tests/                  # node:test structural tests
├── frontend/
│   ├── app/
│   │   ├── pages/              # launcher, settings, drama detail, episode workbench
│   │   ├── components/         # MentionTextarea, ModelSelect, dialogs
│   │   └── composables/        # useApi, useAgent
│   └── tests/                  # node:test structural tests
├── data/                       # generated media (mounted volume)
├── docker/init.sql             # initial SQL helper
├── docker-compose.yml          # app + MySQL 8.4
└── Dockerfile                  # 3-stage build: frontend → native deps → runtime
```

## UI walkthrough

1. **Project launcher** (`/`) — stats, search, status/sort filters, drama cards.
2. **Drama detail** (`/drama/:id`) — episodes tab and asset library (characters / scenes / props).
3. **Episode workbench** (`/drama/:id/episode/:n`) — two panels: *script* (rewrite steps) and *production* (assets, storyboards, image/video generation, merge), each with a model picker.
4. **Settings** (`/settings`) — AI services and endpoint tests, style presets, agent configs, skills editor.

## API overview

All routes are prefixed with `/api/v1`.

| Group | Key endpoints |
|---|---|
| Health | `GET /health` |
| Dramas | `GET/POST /dramas`, `GET /dramas/stats`, `GET/PUT/DELETE /dramas/:id`, `PUT /dramas/:id/{characters,episodes}` |
| Episodes | `POST /episodes`, `PUT/DELETE /episodes/:id`, `POST /episodes/:id/extract`, `GET /episodes/:id/extract-status`, `POST /episodes/:id/generate-video-prompts`, `GET /episodes/:id/pipeline-status`, `GET /episodes/:id/generation-tasks` |
| Storyboards | `GET /episodes/:episode_id/storyboards`, `POST /storyboards`, `PUT/DELETE /storyboards/:id` |
| Assets | `POST /characters|scenes|props`, `POST /:resource/:id/generate-prompt`, `POST /:resource/:id/generate-image`, `POST /characters/batch-generate-images` |
| Tasks | `POST /tasks`, `GET /tasks/:id`, `GET /tasks?type=&storyboard_id=&drama_id=`, `DELETE /tasks/:id` |
| Merge | `POST /merge/episodes/:id/merge`, `GET /merge/episodes/:id/merge`, `GET /merge/episodes/:id/merges` |
| Upload | `POST /upload/image` (≤20MB), `/upload/video` (≤50MB), `/upload/audio` (≤20MB) |
| Config | `GET/POST/PUT/DELETE /ai-configs`, `POST /ai-configs/test`, `GET /ai-providers`, `/style-presets`, `/agent-configs` |
| Agents | `POST /agent/:type/chat` (`script_rewriter`, `extractor`, `storyboard_breaker`, `prompt_generator`) |
| Skills | `GET/POST /skills`, `GET/PUT/DELETE /skills/*` |

`GET /static/*` serves generated media from `STORAGE_PATH`; in production the same server also serves the built SPA.

## Testing

Tests use Node's built-in test runner and assert structural invariants over the source files.

```bash
cd backend  && node --test tests/
cd frontend && node --test tests/
```

## Notes and limitations

- Timestamps are stored as ISO strings (`VARCHAR`) and most deletes are soft (`deleted_at`).
- Text-to-speech and subtitle burn-in are intentionally not implemented; audio comes from the video model's own `generate_audio` flag.
- `configs/config.example.yaml` is a legacy reference template and is not read by the code — environment variables plus the database are the source of truth.
- The root `package.json` still contains `dev:desktop` / `dist` scripts, but no `desktop/` workspace exists yet.

## License

No repository-wide `LICENSE` file is included. The backend package declares ISC in `backend/package.json`.
