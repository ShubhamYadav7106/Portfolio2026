# Ask Shubham AI — local Groq backend

This is a separate local Express application. It uses Groq's official JavaScript
SDK and binds to `127.0.0.1` only. No Cloudflare, GitHub Pages, Violet AI service,
or deployment configuration is involved.

## Start locally

Use Node 22.12 or newer for the portfolio build and local backend. From the
portfolio root, install dependencies if needed:

```sh
npm ci
npm ci --prefix server
```

On a fresh checkout, copy `server/.env.example` to `server/.env` only if the file
does not exist. Preserve an existing local key.
Edit **server/.env**, supplying:

```dotenv
GROQ_API_KEY=your_groq_key_here
GROQ_MODEL=openai/gpt-oss-20b
```

Do not put the key in a Vue file, root/frontend environment file, a `VITE_*`
variable, browser request, or Git. `.env` files are ignored; `.env.example` contains
placeholders only. The backend loads the fixed `server/.env` path regardless of
the working directory. Existing environment variables take precedence.

Start two terminals from the portfolio root:

```sh
npm run dev:server
```

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` to
**http://127.0.0.1:3001**. The frontend always uses relative `/api/chat`; it never
contacts Groq directly. `GET /api/health` reports configuration presence and the
model, never credentials. A missing key gives a clear configuration error for
provider questions and never triggers mock responses. Approved factual Recruiter
lookups can run locally without a key.

The default `openai/gpt-oss-20b` is listed in
[Groq's production models](https://console.groq.com/docs/models). The model is
configurable; choose an account-enabled chat model supporting streaming and JSON
Object Mode. GPT-OSS requests exclude reasoning output and use low reasoning
effort. No automatic model fallback or provider retry is enabled. A real key and
account model access are needed for an authenticated smoke test.

## Mode separation and grounding

Recruiter Mode loads the **existing** modular knowledge through `knowledge/load.js`
for every request, fails closed on validation errors, and applies the shared
verified/public/current eligibility rule. After the owner-approved consolidation
there are 185 records: 152 verified, 33 pending and 148 eligible public facts.
Review deadlines continue to expire facts
automatically. Neuro TEN and all pending/private/outdated facts remain excluded.
Knowledge files and approval metadata are not copied or modified.

Simple factual Recruiter questions use the trusted conversational formatter
directly, without calling Groq. This includes course, location, availability,
skills, contact information and projects. Missing or pending details get an
honest local fallback; this is verified retrieval, not a mock response. The
stream protocol identifies these replies as `provider: knowledge`.

Nuanced questions can use Groq to select facts. It receives only relevant eligible
IDs, categories, semantic kinds, opaque grouping keys and approved values: at most
12 facts normally or 48 on explicit detailed requests. Unknown topics never send
the entire knowledge base. Explicit questions omit old chat history; ambiguous
follow-ups include only the previous user question when needed. Groq selects
relevant fact IDs using a streamed JSON object.
The server validates the entire selection before composing conversational sentences
through a shared, deterministic formatter. This keeps personal claims tied to
approved values while avoiding raw database labels. Unknown questions receive a
short honest fallback; malformed selections, unknown IDs, truncation, and extra
prose fail safely. Internal labels, source/status footers, approval metadata, paths,
and raw source documents never appear in replies. Client assistant messages are
not accepted as recruiter evidence; only prior user questions provide context.

Education retrieval distinguishes school/board/Class 10–12 from the higher
education course. It scopes the provider context and allowed selection IDs to the
requested eligible facts instead of sending the entire knowledge base for these
questions. Course summaries use three approved facts, and schooling uses five
owner-approved school/board/score/stream facts. A university is never substituted
for a school. Short follow-ups such as “where?”, “when?”, and “and 12th?” resolve
the topic from prior user questions, never from assistant-authored claims.

An in-memory LRU cache holds at most 128 public answer selections for five
minutes. It stores only fact IDs under hashed keys, not user text, raw facts or
model prose. Knowledge is validated and filtered on every request, and the cache
key includes a fingerprint of the current eligible knowledge and UTC date.
Changes to approvals, values, visibility or freshness invalidate reuse. Groq
selections are also revalidated after the network request. Unknown replies and
failed, truncated or canceled requests are never cached. Identical concurrent
provider requests share one call; canceling one subscriber does not interrupt
another, while canceling all subscribers aborts the upstream request.

General AI Mode streams normal model text for programming and general questions.
It never loads or injects the personal knowledge base and gets only its own bounded
conversation. Its system instructions prohibit inventing personal background or
claiming browsing, code execution, or tests. No tools, browsing, uploads, or code
execution are enabled.

Both modes default to short, natural replies: one or two sentences for simple
questions and two to four sentences, about 40–70 words, for explanations. Longer
answers require an explicit request. General Mode adds code only when useful;
headings, lists, introductions, repetition, and unrelated detail are discouraged.
Recruiter replies answer the requested aspect, such as joining date or internship
location, without adding unrelated background.

Text streams in complete sentence units, and code fences are held until complete.
The server can stop verbose output at a complete sentence without exposing a
clipped tail. Provider truncation produces a retryable error rather than a false
completion. General Mode keeps its 1024-token default cap and uses the configured
maximum for detailed requests. Recruiter selection uses a 768-token default cap
or 1536 for explicit detail, within `MAX_COMPLETION_TOKENS`. These budgets leave reasoning headroom while
the response formatter controls visible length. Internal record metadata is
rejected before it reaches a text delta.

The browser sends `POST /api/chat` JSON with `mode`, `message`, and `history`.
The response is newline-delimited JSON: `start`, `delta`, optional `sources`, and
`done`, or a safe `error`. The client requires an explicit completion event before
marking a reply complete. Streamed partial replies remain visibly in progress;
stop or failure keeps them incomplete, and retry replaces the partial reply
without duplicating the question. Interrupted replies never enter future model
history. Switching modes, clearing, and component disposal cancel pending work.
Both modes' histories and drafts remain separate and session-only.

## Recruiter quota routing

Recruiter Mode checks real Groq token-limit/remaining/reset headers before the
next provider call. `GROQ_RECRUITER_TPM_THRESHOLD_PERCENT=85` means a reported
8000-token limit has a 6800-token safety threshold; 8000 is an example, never an
assumed quota. The admission estimate includes the incoming request, full output
allowance and outstanding/concurrent token reservations. Headers are reconciled
with actual usage when available; ambiguous overlap is counted conservatively.
Crossing the threshold latches Gemini routing until the reported reset. Active
responses keep their provider, and no background quota-check requests are made.

Without fresh complete quota headers, at most one real user request probes Groq
at a time, with `GROQ_RECRUITER_QUOTA_PROBE_MS=60000` between unknown-quota probes.
Other new requests route to Gemini. This is a probe policy, not an invented Groq
window or token allowance. `GROQ_RECRUITER_QUOTA_MAX_AGE_MS=15000` bounds header age;
a known reset permits a new serialized probe. A Groq HTTP 429 rejected before
streaming is the only reactive fallback; partial responses are never regenerated
by another provider. Retry-After remains authoritative and Gemini has a separate
cooldown. Cached/local answers remain available during cooldowns.

Set `GEMINI_RECRUITER_API_KEY` and `GEMINI_RECRUITER_MODEL` in `server/.env`.
Existing `GEMINI_API_KEY` / `GEMINI_MODEL` settings are also accepted. No Gemini
model or quota is guessed when configuration is absent: quota-unsafe requests
fail safely instead of sending more Groq traffic. Gemini uses Google's fixed
OpenAI-compatible endpoint through the existing transport, with retries disabled.
It receives the same scoped approved context and grounding validation as Groq.
The client streaming protocol identifies Gemini honestly. General Mode retains
its existing separate Groq key and routing. This meter is process-local and
requires shared state if the backend is ever replicated.

## Local controls

`server/.env.example` lists all settings. Defaults:

| Setting | Default |
| --- | --- |
| `PORT` | `3001` (loopback only) |
| `ALLOWED_ORIGINS` | Exact localhost / 127.0.0.1 origins on port 5173 |
| `REQUEST_TIMEOUT_MS` | 60000 |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | 60000 / 20, per direct client IP |
| `MAX_CONCURRENT_REQUESTS` | 4 total |
| `MAX_COMPLETION_TOKENS` | 2048 |

Changing the backend port also requires setting `ASK_SHUBHAM_API_PROXY` when
starting Vite, for example `ASK_SHUBHAM_API_PROXY=http://127.0.0.1:3002 npm run dev`.
This variable is read by Vite's Node config and contains no credential. CORS allows
only explicitly configured local origins. Requests with other origins or Host
headers are rejected, proxy headers are not trusted, cookies are not used, and
there is no public static-file route.

The API validates exact request keys, allowed roles, mode consistency, message
length (600 characters), at most 16 history messages, history character limits,
and a 32 KB JSON body limit. Client history is also bounded by byte size. Rate
limits and concurrency caps are in-memory controls for this local instance;
they are not a distributed/public-hosting design. Upstream requests are canceled
on client disconnect or server timeout. The client accepts a bounded pending frame before content and aligns its deadline
with `REQUEST_TIMEOUT_MS` plus 10 seconds of transport grace. The default server
deadline is 60 seconds; it remains configurable from 1 to 120 seconds. The client
uses a bounded 135-second fallback when no pending frame arrives. Token arrivals
do not extend the deadline. Thinking is shown only until the first visible content;
Stop remains available throughout the request. Logs include only safe error codes, mode, elapsed time, HTTP status and
optional retry delay. Recruiter metrics additionally include local/cache/provider
origin, fact/history counts, numeric rate-limit counters and actual prompt,
completion, reasoning and total token usage when returned. Missing usage remains
unknown, not zero. Prompts, conversations, provider payloads, personal facts and
credentials are excluded. Statistics are internal; no public metrics route exists.

Provider rate limits use `PROVIDER_RATE_LIMIT`, distinct from the local message
limit (`RATE_LIMIT`), concurrent response cap (`BUSY`) and timeout (`TIMEOUT`).
The backend honors Groq's `Retry-After` header, returns a sanitized numeric delay,
and prevents further Recruiter provider calls during its cooldown. Local/cache
answers remain available; Recruiter cooldowns do not add a block to General Mode.
There are no automatic retries or mock fallbacks. Recruiter limits distinguish
RPM, TPM, daily requests (RPD) and daily tokens (TPD), using explicit provider
limit descriptions or documented counters. Unknown limits remain unknown. Groq's
request header is a daily counter, not RPM. Missing retry delays use the relevant
reset header, otherwise 60 seconds for minute/unknown limits or one day for daily
exhaustion. Explicit Retry-After values are not shortened. SDK connection timeouts and upstream HTTP 408/504 responses
are classified as timeouts and release the request slot. Errors after streaming
starts stay incomplete and carry the same safe retry information.

## Controlled Recruiter audit (2026-11-11)

The baseline skills question sent 105 facts with no history and consumed 4,178
prompt tokens and 101 completion tokens, including 52 reasoning tokens (4,279
total). Actual headers reported an 8,000 TPM limit, 3,636 tokens remaining and 987
daily requests remaining out of 1,000. A second prompt of that size would exceed
the remaining minute allowance unless enough tokens replenished. Historical
errors logged only generic provider 429 codes, so their exact subtype cannot be
proven retrospectively; the measured payload demonstrates avoidable TPM pressure.
There was no automatic retry loop or duplicate normal client submission.

After the change, ten controlled local HTTP requests completed with one real
Groq call and zero 429s: five local answers, three cache hits and two simultaneous
nuanced requests sharing one call. The original factual skills question used
zero provider calls/tokens. The scoped nuanced call sent two facts, no history,
and used 413 prompt + 39 completion tokens, including 17 reasoning tokens (452
total). Its headers reported 7,494 TPM tokens and 994 daily requests remaining.
Reasoning tokens are part of completion tokens, not an additional total.
This audit made only two real calls: one baseline and one optimized call.
Provider quotas can still limit future uncached nuanced questions; ordinary
verified lookups no longer depend on them. The Groq model was unchanged.

## Explicit development mock option

```sh
VITE_CHAT_MOCK=true npm run dev
```

The widget then displays **Mock** and states that messages stay local. This mode
does not call the API. The flag is honored only by Vite's development server;
production builds always use the local API. Default/live mode never falls back
to mocks on errors. Production assistant chunks exclude the mock responder and
knowledge JSON, while the portfolio's existing public content remains unchanged.

## Verification

```sh
npm run validate:knowledge
npm test
npm run build
npm run test:browser
git diff --check
```

`npm test` runs frontend/state/knowledge tests and the local Express integration
tests. Loopback API tests need permission to bind local ports. Browser checks use
the production frontend, real Express routing and streaming protocol, and an
explicitly labeled **test-only Groq transport**; they make no paid/external AI
requests and need no real key. The fixture is never imported by `server/index.js`.
Tests cover concise responses, question relevance, factual accuracy, hidden
metadata, complete sentences/code fences, grounding, privacy, request rejection,
CORS, rate limiting, safe errors, timeouts, disconnect cancellation, partial
streams, stop/retry, separate histories, themes, and mobile behavior.

After configuring a key, ask one recruiter question and one general question,
then stop a stream and retry it. The static production build does not host this backend;
Vite's proxy is for local development only. Deployment remains a separate task.

References: [streaming chat](https://console.groq.com/docs/text-chat),
[JSON mode](https://console.groq.com/docs/structured-outputs),
[rate-limit header semantics](https://console.groq.com/docs/rate-limits),
[key security](https://console.groq.com/docs/production-readiness/security-onboarding).


## Pre-deployment audit — 2026-11-12

The application passes local production-build checks. It is **not yet ready for
public production deployment** because this backend intentionally accepts only
loopback hosts and local origins. The existing GitHub Pages workflow serves static
files and cannot host Express. No deployment, Git push, Cloudflare configuration,
public origin or public server binding was added by this audit.

### Confirmed fixes

- Shared, bounded intent-word normalization handles common typos, synonyms and
  Roman-script Hinglish. It never fuzzy-matches personal names, IDs or approvals.
- Retrieval and formatting share one user-question context resolver. Employer,
  project and education follow-ups keep their topic; explicit topic changes reset
  it. Assistant-authored claims cannot supply facts. Cache keys use that same
  normalized context and the current eligible-knowledge fingerprint.
- Specific language/backend/frontend skill queries use relevant approved skill
  records. C is not treated as C++; Java is not treated as JavaScript. Unknown
  skills still receive an honest fallback.
- Approved public city and resume-link queries now work. Opportunity answers no
  longer concatenate target roles and career-goal prose. Company URLs and project
  years are no longer classified as technologies. Internship wording avoids a
  duplicated article before The Entrepreneurship Network.
- The explicit development mock now receives Recruiter conversation history too.
- Patched Vue 3.5.45, Vite 7.3.8 and compatible Vue plugin 6.0.11 replace vulnerable
  versions; targeted vulnerable transitive dependencies were patched. Both root
  and backend npm audits report zero known vulnerabilities. Vite 7 retains the
  existing build approach; no Vite 8/Rolldown migration was introduced.
- Dynamic image URLs were made explicit enough for the patched build tool to
  include all existing portfolio images. Portfolio content, component templates
  and styles were preserved; the widget only received accurate processing/loading
  copy. No redesign was performed.

### Verification and measured behavior

- 113 automated tests passed (51 frontend/state/knowledge, 62 backend/quality).
- 21 production browser checks passed using Chrome/CDP: image decoding, real
  local HTTP streaming, separate histories, stop/retry, clear, keyboard modes,
  320/360/390px phones, 768px portrait and 1024px landscape tablets, 1440px desktop,
  light/dark themes, reduced motion, focus restoration/trapping, accessible names,
  and 4.5:1 contrast of primary chat text/color tokens. This is targeted automated
  accessibility coverage, not a claim of a complete assistive-technology audit.
  Physical devices and Safari/Firefox were not exercised in this audit.
- Production build, knowledge validation, dependency-tree checks and diff checks
  passed. No lint command is configured.
- Current knowledge: 185 records, 152 verified, 33 pending, 148 public/current.
  Private, pending, modified-since-approval and expired facts stay ineligible.
- Controlled live smoke test: seven Recruiter requests, one real Groq call, one
  cache hit and zero 429s. The provider received two facts and no history: 413 prompt
  tokens + 70 completion tokens, including 48 reasoning tokens (483 total).
  Response headers reported an 8,000 TPM limit with 7,344 tokens remaining and
  992 daily requests remaining out of 1,000. The model was unchanged. Other
  automated/browser tests used synthetic transport and consumed no provider quota.
- The configured key remains server-side; server/.env is gitignored (mode 600).
  No key was found in tracked environment files, source scans or build artifacts. The assistant
  bundle contains no approval metadata or raw knowledge archive. The API has no
  static route for credentials, knowledge JSON or server source.
- CORS/host rejection, exact request validation, body/history limits, no cookie
  credentials, shared provider concurrency limits, direct-IP message limiting,
  disconnect/timeout cancellation and safe errors passed. RPM/TPM/daily quota
  classification and Retry-After cooldown tests passed; ordinary factual replies
  stay available locally during provider cooldown.
- No exact duplicate source/test/knowledge files were found. Frozen migration
  snapshots/import archives and their historical report were retained intentionally.
  No important files were deleted or knowledge records modified during this audit.

Dependency review used npm's current advisory database and the upstream
[Vue XSS advisory](https://github.com/vuejs/core/security/advisories/GHSA-g2v6-rqmx-r4w6)
and [Vite path-traversal advisory](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9).
The existing uncommitted lockfile was updated in place for the targeted fixes;
other direct portfolio dependency versions were preserved.

### Remaining production work

Choose and approve a backend host and public domain first. Public deployment then
needs HTTPS termination, exact public-origin/Host configuration, secure environment
injection, a deliberate reverse-proxy/IP trust policy and abuse/cost controls suited
to that host. Current rate limits, cache, concurrency and cooldown state are local
in-memory controls and are not a distributed public-hosting design. Use Node 22.12+
for the documented build/runtime setup; restart existing local development processes
after dependency updates. The GitHub Pages workflow remains unchanged.

The 33 pending knowledge records (29 unknown placeholders plus four unresolved
qualifications/metric claims) remain excluded and documented in ../knowledge/README.md.
They do not justify inventing missing answers. Bounded typo/Hinglish support is not
unrestricted multilingual understanding; ambiguous or unsupported queries may still
return the honest fallback. Uncached nuanced questions remain subject to Groq quotas.
