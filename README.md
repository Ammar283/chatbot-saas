# Front Desk — multi-tenant AI chatbot + client dashboard

A website chatbot you can resell. One server hosts every client. Each client is
a "workspace" with its own knowledge base, settings, leads and public key.

**Why it's built this way:** retrieval is keyword-first so it costs nothing per
query, answers are cached so repeat questions are free, and the bot refuses to
answer anything not in the knowledge base. A chatbot that invents a price loses
your client a customer and loses you the client.

---

## Run it in five minutes

```bash
npm install
cp .env.example .env      # then edit .env
npm start
```

Open `http://localhost:3000/dashboard.html`, paste your `ADMIN_KEY`, and you're in.

### Signing in

On first run the server reads `OWNER_EMAIL` and `OWNER_PASSWORD` from `.env`
and creates your owner account. Sign in at `/login.html`.

| Role | Sees |
|---|---|
| owner (you) | every workspace, **My clients**, can create logins, delete and restore |
| client | only their own workspaces |

Create a client login from **My clients → Add a client login**, then create
their workspaces. Send them the dashboard address and their password; they can
change it under Settings.

Sessions are signed cookies — change `SESSION_SECRET` to sign everyone out.

### Two kinds of key

| Key | Who holds it | Sees |
|---|---|---|
| `ADMIN_KEY` in `.env` | you | every workspace, can create and delete |
| `ck_...` client key | one client | only that client's workspaces |

API keys still work for scripts and curl (`x-admin-key` header), so nothing you
automate breaks. Every workspace generates a client key. Sites created with **Same client as
current** ticked share one key, so a client with three brands gets one login
showing exactly their three — and nothing belonging to anyone else.

Hand it over from **Settings → Give the client access**. They can add further
sites themselves; those are grouped automatically. Clients can delete their own workspaces — they must type the workspace name,
and the data is archived to `data/_archive/`, not erased. Restore from
**My clients → Archived workspaces**.

### First workspace

Paste your `ADMIN_KEY` into the dashboard sidebar, then **+ New workspace**.
Type the business name — the address is derived from it.

Then **Knowledge → Read a website**, paste the client's URL, hit Read site.
Test at `http://localhost:3000/demo.html?key=pk_...`.

Your own view is `dashboard.html?owner=1`, which adds API cost and cache rate.
Send clients the plain `dashboard.html` address.

---

## Choosing a model

`.env` points at any OpenAI-compatible endpoint. Start with the cheapest model
that passes your own test questions, then only move up if it fails.

| Env var | What to put |
|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1`, … |
| `LLM_MODEL` | the cheap model that handles ~90% of traffic |
| `LLM_MODEL_SMART` | optional; only used for long, multi-part or comparative questions |

Leave `EMBED_*` blank to start. Keyword retrieval alone handles one business's
website well. Add embeddings only when you see real questions failing in the
**Overview → Questions the bot could not answer** list.

### What it actually costs you

A typical 8-turn conversation is roughly 16k input + 1.5k output tokens. At
$0.14/$0.28 per million that's about **$0.0027** — a quarter of a cent. A client
doing 1,000 conversations a month costs you under $3. The cache typically takes
30–50% off that.

The dashboard shows the running cost per workspace so you always know your margin.

---

## Deploying

Anything that runs Node works. Railway, Render, Fly and a $5 VPS are all fine.

```bash
# on a VPS
npm install --omit=dev
node server.js        # behind nginx or caddy for TLS
```

Two things to get right in production:

1. **Persist `./data`.** It's your entire database. Mount a volume; back it up.
   Free-tier containers with ephemeral disks will silently lose client data.
2. **Set a real `ADMIN_KEY`.** It's the only thing between the internet and
   every client's leads.

---

## How the pieces fit

```
public/widget.js      one-line embed, Shadow DOM, works on any site
public/dashboard.html what the client logs into
public/demo.html      your sales demo page
server.js             routes, rate limits, spend caps
lib/prompt.js         grounding rules + lead capture  <- the product's quality
lib/retrieve.js       BM25, optional vectors, answer cache
lib/ingest.js         website crawler + chunker
lib/store.js          flat-file persistence per tenant
data/<tenant>.json    one client's entire state
```

---

## Operating notes

**Onboarding a client (about 30 minutes)**
1. Create the workspace, crawl their site.
2. Ask the owner for the six things customers always ask, plus prices and hours.
   Paste into **Settings → What the bot should know**. This is the single
   highest-leverage step; the website almost never has the real answers.
3. Set bot name, greeting and accent colour to match their brand.
4. Send them the install snippet from Settings.

**Weekly, per client (about 10 minutes)**
Open **Overview**, read the unanswered questions, add the missing facts. Doing
this is what makes month six better than month one, and it's what justifies a
recurring fee rather than a one-off build.

**Limits to know before you sell**
- Flat-file storage is comfortable to roughly 5,000 passages per client and a
  few hundred conversations a day. Move to Postgres + pgvector past that.
- The crawler reads server-rendered HTML. Sites that render entirely in
  JavaScript need the content pasted in manually.
- WhatsApp and Instagram aren't wired up yet — the Meta Cloud API webhook is
  the next piece to build, and it's where most local demand is.

---

## Next things worth building, in order

1. **WhatsApp channel.** Meta Cloud API webhook posting into the same
   `/api/chat` logic. Biggest revenue unlock in Pakistan and the Gulf.
2. **Email the owner on every lead.** Sixty lines of code, and it's the feature
   that stops churn — the client feels the product working.
3. **Human handoff.** When `handoff` is true, ping a WhatsApp number so a real
   person can jump in.
4. **Self-serve signup + billing.** Only after you have 10 paying clients you
   onboarded by hand. Not before.
