# model-xray

**X-ray your LLM endpoints. One command, one report.**

`model-xray` is an open CLI that audits OpenAI-compatible LLM endpoints for **fake or watered-down models** — relabeled models, quietly shortened context, padded token billing, inflated latency. It never asks you to trust a vendor's word: it probes the endpoint empirically and produces a shareable red/green report.

[English](#english) | [中文](#中文)

---

## English

### Quick start (from source, ~5 min)

Requires **Node.js ≥ 22** (`node --version` to check).

```bash
git clone https://github.com/OpenLlamas/model-xray.git
cd model-xray
npm install
npm run build
npm link          # optional but recommended: gives you the short `model-xray` command
```

Set your API key once — both `test` and `guard` read it; the key never enters the command line or shell history:

```powershell
# PowerShell
$env:MODEL_XRAY_KEY = 'sk-your-key'
```

```bash
# bash / zsh
export MODEL_XRAY_KEY='sk-your-key'
```

Run a one-shot audit:

```bash
model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --model gpt-4o \
  --yes
```

If you skipped `npm link` (or npm refused due to permissions), replace `model-xray` with `node dist/src/cli.js` everywhere.

Prefer a guided flow? Run `npm run ask` (Windows): an interactive terminal wizard asks for the endpoint / model / key, previews with a dry-run, confirms, then runs and prints the report path. Or run `npm run ui` for the local web console (loopback only) — fill in everything in the page, watch the live log, and aggregate channels with live usage/anomaly monitoring; the `guard` always-on proxy is CLI-only. See "Web console" below.

The report lands in `reports/` as three files named `report-<model>-<YYYY-MM-DD_HH-mm-ss>` (local time): `report-<model>-<…>.md` (read this one), `report-<model>-<…>.html` (open in a browser), `report-<model>-<…>.json` (raw evidence). Exit code: `0` pass/warn · `1` fail · `2` usage error or inconclusive run (no scorable conclusion).

### Common tasks

**1) Audit a station once** — the command above. Add whatever you know about the station; unknown extras are simply skipped:

| You know | Add to the command |
|---|---|
| advertised context window (e.g. 128000) | `--claimed-context 128000` — enables the needle test |
| advertised capabilities | `--expect vision,tool,thinking` (default `vision,tool`; use `--expect none` if none claimed) |
| advertised price per 1M tokens | `--price-input 0.2 --price-output 0.7` — enables the measured-rate probe |

Preview without spending: add `--dry-run` (it prints the planned requests and token estimate, sends nothing). A full run typically costs a cent or two — ours measured ≈ $0.015 per run at $0.2/$0.7 per 1M tokens.

**2) Re-audit later, or catch a silent model swap** — keep the `baseline-<model>-<YYYY-MM-DD_HH-mm-ss>.json` written by the first run and pass it back:

```bash
model-xray test --base-url https://your-relay.example.com/v1 --model gpt-4o --yes \
  --baseline reports/baseline-gpt-4o-2026-10-11_10-09-23.json
```

**3) Always-on monitoring (`guard`, CLI-only)** — a local transparent proxy that watches your real client traffic and scores it live (the console no longer starts or stops it):

```powershell
# 1) key via environment variable only (guard has no --key flag by design)
$env:MODEL_XRAY_KEY = 'sk-your-key'
# 2) start the proxy (listens on 127.0.0.1:8621 by default)
model-xray guard --base-url https://your-relay.example.com/v1 `
  --price-input 0.2 --price-output 0.7 --reconcile-minutes 15
# 3) point your client at http://127.0.0.1:8621/v1
#    with the client's API key set to the SAME value as MODEL_XRAY_KEY
```

Keep using your client normally: every 20 forwarded requests prints a live scorecard (availability / accounting / identity / latency / cost; rolling window = last 100 requests), anomalies alert immediately, and everything lands in `reports/guard/guard-YYYYMMDD.jsonl` (metadata only). `Ctrl+C` settles the final window before exit.

**4) Do it all from the local web console** (nothing leaves your machine):

```bash
npm run ui     # opens http://127.0.0.1:8620 automatically (loopback only)
```

### How to read the result

- **Verdict** (also the exit code): 通过 pass (0) · 可疑 warn (0) · 不通过 fail (1) · usage error / 未得出结论 (2).
- Dimensions without enough evidence are marked `N/A` and excluded from scoring — never counted as 0.
- **Scoring**: a weighted geometric credibility total (0–100): billing 25 / quality 25 / identity 15 / context 15 / capability 10; TTFT is observation-only and never scored. Any dimension at `fail`, or a credibility total < 40 → overall fail. Billing / capability / context / quality below 40 hit a **hard red line** (credibility total capped at 45); a falsified capability (advertised capability measured wrong or explicitly refused) caps the credibility total at 60. Credibility total < 75 or any warn dimension → 可疑 (warn).
- **Quality caliber (probeset v0.2.2+, metricVersion pass1)**: the primary metric is **pass@1** (first-answer accuracy) — a resample at temperature 0.7 is kept as evidence only ("main" = pass@1, "main_recovered" = two chances). A `fail` verdict additionally requires that the resample did NOT recover to the 0.6 line (first-answer collapse + resample still broken is solid evidence; a one-off first-answer miss is not). A whitewash pattern — first answer below 0.6 but rescued by the resample — is reported as warn with score capped at 80. Baseline carries `metricVersion: 'pass1'`; comparing against an older-caliber baseline skips the quality delta with a note (other dimensions still compare) — regenerate old baselines before comparing.
- Every finding carries its evidence: per-request findings link the exact `evidenceIds`; aggregate verdict findings link all contributing sample `evidenceIds`.

### What it checks

| Check | What it does |
|---|---|
| Identity & fingerprint | 5 self-ID questions (8 in `--deep`, incl. 1 exact model-name-and-version question) + behavioral fingerprints catch relabeled/guardrail-swapped models (e.g.自称 Claude 却答 "我是 GLM"); a "brand name + assistant" persona in self-description (e.g. "I am NovaRelay assistant") → warn with score capped at 80; same family but a different variant suffix (claimed `glm-5.3`, self-reports `glm-5.3-flash`) → variant conflict, warn capped at 80; different family → fail 0 |
| Context length (needle test) | Bursts needles at claim-depth to verify the advertised window is real, not truncated silently; endpoint-reported `prompt_tokens` is cross-checked against the actually-sent volume, and a pass whose usage cannot be calibrated is downgraded to undetermined. Depths run from deepest to shallowest; when the 90% tier gets ≥2 valid needle samples, all hit, usage calibrates and the tier is clean, shallower depths are early-stopped and disclosed (not counted as missing). With `--context-samples ≥2` this saves ~75% of the needle volume |
| Token counting | Runs a within-run linearity regression of endpoint-reported `prompt_tokens` against a conservative local estimate (not an official tokenizer) and checks `completion_tokens` for hard contradictions (non-empty body reported as 0, or a count above the request's `max_tokens`). The output side is additionally cross-checked in total: Σ(visible completion = completion − reasoning_tokens, `finish=stop` only) ÷ Σ(local estimate of the body) above 1.35 → suspected output-token inflation, warn capped at 70; below 0.6 → informational only. A nonzero constant offset in the regression (finite r²≥0.9, intercept above 120 tokens) is also suspected inflation → warn. Linear shape alone is **not** a pass: without an absolute cross-check (`--token-reference` or the measured-rate check) the dimension is reported as *undetermined* — no score, no total — because uniform rescaling or a constant offset is invisible to the regression. Partial/failed samples, potentially-billed retries (not gateway-rejected 429/503, which never entered inference and are usually not billed), and completion anomalies cap the score at 70 instead of passing |
| Measured rate (balance delta) | Snapshots the billing balance before/after the billing series. Both snapshots are **stabilized** — re-reads until two consecutive readings agree — and the pre-series snapshot must be stable on the **first comparison**: unsettled charges from before the window would land inside Δ and smear an honest station into a false overcharge verdict, so a still-moving pre-snapshot voids the ratio (non-attributable, info — never a fail). new-api style stations are supported: `GET /api/usage/token` (Bearer; key-level `total_used`/`total_available`) for the balance and `GET /api/status` (`quota_per_unit`) to calibrate the unit — calibration that is unreachable does not count for or against the score; a `baseUrl` ending in `/v1` is stripped automatically for console APIs. one-api style `/api/user/self` (user-level quota) is also calibrated to USD when `/api/status` is reachable, but a **user-level source can never produce a fail verdict** — other keys of the same user share the balance, so >1.5× readings are reported as warn with the underlying fail recorded in `metrics.ratio_masked_verdict` (definitive fails require a key-level source). Δspend ÷ expected cost (claimed price × self-reported usage) reveals the real multiplier behind "cheap" sticker prices. Rate > 1.5 → fail; (1.1, 1.5] or [0.5, 0.8) → warn; [0.8, 1.1] → consistent. A spend or Δ below 3× the balance's smallest step is N/A — when the expected cost alone is below that floor, the audit **auto-tops-up** with up to 8 extra large-prompt samples (budget-capped at 3× the target cost, skipped entirely if even 8 samples cannot reach the floor, stopped on the first unattributable event) to lift Δ into the measurable range instead of giving up. A ratio >10 cannot be attributed to this window (shared-account traffic/unit mismatch) and is reported as unverifiable, not a fail. Any potentially-billed retry (408/409/5xx/timeout after the first attempt — gateway-rejected 429/503 retries are exempt) or failed request inside the window voids the ratio |
| Token-count reference (`--token-reference`) | Compares per-tier prompt_tokens against a prior audit report of the SAME model (same probeset version): ratio > 1.25 → fail (score capped 30); 1.1–1.25 or < 0.8 → warn (capped 70); 0.8–1.1 → ok — the only check that catches uniform usage rescaling (invisible to the regression). Limitations: prompt_tokens only; trust of the reference report is on you; fetching official token counts automatically is still missing (TODO) |
| Fingerprint baseline | Saves/compares a versioned baseline (model family, quality, capability, billing slopes) across runs to catch silent model swaps |
| Capability gates | vision / tool-calling / thinking flags actually exercised, not just advertised |
| Fixed question bank | A versioned, reproducible set scored against reference answers for quality drift; reports disclose a 95% Wilson confidence interval for accuracy (informational only, thresholds unchanged) |
| Streaming first-token latency | p50/p95 TTFT sampled under load, useful for spotting "queue-stretched" relays |

### Key options

| Flag | Meaning |
|---|---|
| `--key <key>` | API key; alternatively set `MODEL_XRAY_KEY` / `OPENAI_API_KEY` (recommended: keeps the key out of shell history; guard only supports the env var) |
| `--claimed-context <n>` | Advertised context window; enables the needle test |
| `--context-samples <n>` | Needle samples per depth, 1–5 (default 1; `--deep` 5). Use 3 for statistical confirmation resampling |
| `--context-budget-usd <n>` | Soft spending cap (USD estimate) for the context probe; requires `--price-input/--price-output`. Requests are skipped once the running estimate would exceed the cap, the tail echo is marked `budget-stopped`, and a pass proven only before the cap is downgraded to undetermined with the estimated spend disclosed. The estimate covers planned needle volume, not retries/stream fallbacks |
| `--expect <list>` | Claimed capabilities from `vision,tool,thinking` (or `none`; default `vision,tool`) |
| `--price-input <n>` / `--price-output <n>` | Claimed price per 1M tokens, must appear as a pair; enables the measured-rate probe |
| `--price-cached-read <n>` | Optional cached-input price per 1M tokens (≥0; defaults to the input price) |
| `--price-threshold <n>` / `--price-input2 <n>` / `--price-output2 <n>` | Optional long-context tier: above this prompt-token threshold the whole request is billed at tier-2 prices (all three required together) |
| `--price-cached-read2 <n>` | Optional tier-2 cached-input price (≥0; defaults to the tier-2 input price; requires the tier group) |
| `--baseline <path>` | Compare fingerprints against a baseline file; its seed is reused unless `--seed` is explicit |
| `--baseline-out <path>` | Write this run's baseline file (defaults to `reports/baseline-<model>-<YYYY-MM-DD_HH-mm-ss>.json`) |
| `--token-reference <path>` | Compare per-tier prompt token counts against a prior audit report of the same model and probeset version — catches uniform usage inflation; model/version mismatch skips the comparison with a note |
| `--yes` | Skip the interactive token-cost confirmation on remote endpoints (required in scripts / non-TTY) |
| `--dry-run` | Print the planned requests and token estimate, then exit without sending anything |
| `--deep` | More samples per probe (slower, costs more) |
| `--http-retries <n>` | Per-request retries on gateway-rejected 429/503 responses (integer in [0, 6], default 2) — separate from `--retries` (200-empty-body retries). Such requests never entered inference and are usually not billed, so they do **not** contaminate billing evidence; other retryable statuses (408/409/500/502/504/timeout/network) still count as potentially-billed contamination and invalidate the measured rate. A run-level retry budget (24) bounds retry amplification when the endpoint is globally overloaded |
| `--out <dir>` | Report output directory (default `reports`) |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `exit 2` / a cost confirmation appears | add `--yes` (required in scripts, CI, non-TTY terminals) |
| guard: client receives `401` | the client's API key must EXACTLY equal `MODEL_XRAY_KEY`; mismatched requests are rejected locally, never forwarded |
| guard: port already in use | `--port 8622` (default 8621) |
| cost dimension shows `N/A` / `skipped` | the station has no one-api style balance endpoint, or no `--price-input/--price-output` was given — reconciliation degrades to token-only stats, which is normal |
| a capability item fails but the station never claimed it | only put capabilities the station actually advertises into `--expect` (default `vision,tool`); drop the rest or use `--expect none` |
| the endpoint answers 400 mentioning `temperature` | some gateways/models reject the parameter; the client automatically re-sends once without it and discloses `temperatureDropped` in the evidence — the audit proceeds normally and the param-validation rejection is not billed, so it never contaminates billing evidence |
| several dimensions *undetermined* with a headline mentioning "端点/网关拒绝" (endpoint/gateway rejected) | the endpoint was overloaded or rate-limited at that moment (e.g. HTTP 503 system cpu overloaded) — requests never entered inference; the report notes aggregate the failure share. Re-run at a quieter time; the tool does not disguise endpoint failures as model problems |
| want a cheaper / faster run | omit `--price-*` and `--claimed-context`; try `--dry-run` first |
| `cmd.exe` rejects a command copied from the web shell | web-shell commands use single quotes — run them in PowerShell or bash |
| build fails / `node` not found | install Node.js ≥ 22 from https://nodejs.org |

### Boundaries & caveats

- **USD readings & precision floor.** The one-shot measured-rate check requires balance readings in USD (quota or other units void it with a note — the tool never converts units); a spend or Δspend below 3× the reading's smallest step is treated as precision noise and voided as well. A ratio above 10× cannot be attributed to the audit window (shared-account traffic, recharge/refund, or a unit mismatch): it is reported as unverifiable with the raw ratio and a masked fail for review, not as a fail.
- **No concurrent traffic.** During the measured-rate window, keep the audited key idle — parallel requests inflate Δspend and bias the ratio upward. (Under `guard`, all traffic through the proxy is accounted per request, so the caveat shrinks to: don't use the same key outside the proxy.)
- **Recharge interference.** A top-up between the two balance reads voids the measurement (Δ<0 is discarded); a recharge concurrent with spend remains undetectable — cross-check the station's billing log manually when in doubt.
- **Same-origin assumption.** The two balance reads assume the relay routes them to the same backend and returns fresh (non-cached) values; multi-backend gateways or cached balances can distort Δ.
- **Billing verifies self-reported usage.** The billing dimension judges the endpoint's *self-reported* token counts: linearity across input lengths (EN + ZH regression), internal consistency (`total = prompt + completion`, no negative values), output-side checks (`completion_tokens` vs the response body / requested `max_tokens`), an output-side total cross-check (visible completion ≈ local estimate of the body: above 1.35 → warn capped at 70, below 0.6 → informational only), a nonzero constant offset in the regression (intercept above 120 tokens with r²≥0.9 → warn), and constant-usage detection. When all of these pass with no absolute reconciliation available (no `--token-reference`, no claimed price + usable balance endpoint), billing reports **pass at 85**: no evidence of usage falsification was found, but a uniform rescaling (e.g. ×1.3), a constant offset, or inflated *charges* cannot be excluded by shape evidence alone — the headline and findings disclose this explicitly (`evidence_level: shape-only`). Absolute reconciliation that passes raises the score to 100; contradicting evidence (non-linear counts, constant usage, measured ratio >1.5, reference drift) still fails the dimension.
- **Heuristic thresholds.** Drift thresholds (quality 15%/30%, billing slope 0.05/20%, rate 0.8–1.1–1.5) are versioned heuristic initial values so reports stay comparable across versions.
- **Baseline seed reuse.** `--baseline` reuses the baseline's seed to keep the question set fixed — a relay could theoretically special-case seeded probes; the trade-off is disclosed by design.
- **Baseline format.** Baseline files are `version: 1` only; mismatched versions/models/probeset versions skip comparison with a note. A baseline holds aggregate fingerprints only (model families, accuracy, capability flags, billing slopes, seed) — never API keys, prompts, or balance values. Quality carries `metricVersion`: comparing against an older (non-pass@1) baseline skips the quality delta with a rebuild note; other dimensions still compare.

### Principles

- **Platform-agnostic.** The tool has no "our own station" to favor. If you operate an endpoint, publish your own reports and let others verify — the credibility comes from third parties running the same command, not from shipped rankings.
- **No leaderboard.** Maintainers publish reports, not rankings, to keep the tool out of "hit piece" territory.
- **Evidence over verdicts.** Every finding carries `evidenceIds` into the raw request/response transcripts in the report (aggregate verdict findings link every contributing sample).
- **Versioned test sets.** Question banks and needles carry versions so a report is reproducible.

### Guard: local always-on monitor (P2)

`guard` runs a transparent local forwarding proxy that watches **real traffic** instead of firing one-shot probes (startup commands are under "Common tasks" above). What it watches per request:

- **Model consistency** — request `model` vs the model the endpoint actually answers with; a mismatch alerts immediately (`model_mismatch`). Ids are compared after canonicalization (lowercase, separators `. _ - /` removed), because relays commonly re-spell the same id (`glm-5.3-flash` → `glm-5-3-flash`); a different family or version still alerts.
- **Token accounting** — SSE/JSON responses are parsed for `usage` (bytes pass through untouched); negative or inconsistent token counts raise `usage_invalid`. Reported `cached_tokens` / `reasoning_tokens` details are captured when present.
- **Rolling billing reconciliation** — with claimed prices given, the balance is sampled at window boundaries: Δspend ÷ expected cost = measured rate. Rate > 1.5 alerts as fail; outside the drift band (|ratio−1| > 0.05 and > 0.2) warns; a top-up during the window (`Δ<0`) voids the window (`skipped_recharge`) instead of producing a bogus ratio.
- **JSONL audit log** — one line per request plus reconcile/anomaly/fingerprint/score events under `--out` (default `reports/guard`), rotated daily. **Metadata only**: no conversation content, no credentials, no upstream error bodies, no query strings — verified by dedicated redaction tests.
- **Truncation / disconnects** — `finish_reason=length` is recorded; client disconnects mid-stream mark the request `aborted`.
- **Live scorecard** — every 20 forwarded requests a one-line multi-dimension score is printed (availability / accounting / identity / latency / cost), plus a final card on exit; rolling window = last 100 forwarded requests (locally rejected 401/403 never enter the window); the `观测` (observed) counters — truncation rate / missing usage / aborts — are informational and never affect the grade; with tiny windows a single request can pull the overall grade red, which is normal jitter.

Optional: `--fingerprint-minutes 60` re-runs the identity-family probe periodically and alerts when the model-family fingerprint drifts (the probe sends real requests and costs real money — off by default).

Boundaries: only `chat/completions`, `completions`, and `embeddings` get deep inspection; other paths are forwarded untouched with a basic log line. HTTP/1.1 only; upstream responses are requested with `Accept-Encoding: identity` on deep-inspected endpoints (the only byte-level rewrite besides credential replacement). The balance probe polls the one-api style usage endpoint (its `total_usage` must be an integer number of cents and is read as ÷100); non-integer/unknown schemas are rejected, non-USD readings (e.g. `quota`) skip rather than being converted, and stations without a usable endpoint degrade reconciliation to token-only stats with a `skipped` note. Local auth uses a constant-time comparison; `Ctrl+C` (or closing stdin) stops guard and settles the final window before flush.

### Common relay tricks: faking & hidden rate markups (audit via the web console)

Two problems dominate the relay market, and both are designed to be invisible:

- **Faking (model swap / lighter variant)** — the relay serves a lighter sibling from the same family in place of the flagship: e.g. `glm-5.3-flash` standing in for `glm-5.3`. The docs, the self-reported model name, and everyday answers all look right, so it is nearly impossible to notice in normal use; only probes that compare the requested model against the endpoint's self-described identity / answer fingerprints catch it.
- **Hidden rate markup** — sticker prices look normal while the billing backend quietly applies a modest multiplier (e.g. 1.5×): no single bill looks alarming, so eyeballing statements never catches it; only an absolute check — measured spend ÷ (claimed price × self-reported usage) — produces a verdict.

Prefer the local web console (`npm run ui`) over a bare CLI run: the page lets you tick the claimed capabilities (vision / tool calls / reasoning), enter the claimed context window and claimed prices (input/output per 1M tokens, optional cached-read rate and long-context second tier), pin a seed for reproducible re-tests, and add enhanced samples — **the more you declare, the deeper the probes run**. Cost verification only turns on once you enter the claimed prices; catching a rate markup requires them.

Real case (scorecard below, from `reports/report-glm-5.3-2026-10-20_03-25-22`): a relay served `glm-5.3-flash` in place of `glm-5.3` and set the rate to 1.5×. One "Start test" run caught it: all 6 identity probes echoed back a different model (requested `glm-5.3`, upstream echoed `glm-5.3-flash` — suspected swap/channel change), the measured rate came out 1.5 > 1.5 claimed (fail, capped at 30), plus 32/62 empty non-streaming bodies as further evidence — final score 45 · fail (billing hard red line caps the total). The sticker prices on the page looked perfectly normal; without entering them and actually measuring, nothing would have surfaced.

![Case: `glm-5.3-flash` standing in for `glm-5.3` with a 1.5× markup — score 45/100, fail](docs/audit-case-glm-5.3.png)

### Web console (local, executable)

`npm run ui` starts a local server on <http://127.0.0.1:8620> (loopback only; auto-opens the browser) and turns the page into a real detection entry point with two tabs (the API aggregation tab is temporarily hidden — pending a later iteration; see below):

1. **One-shot test** — set every parameter in the page (endpoint / model / claimed context / expected capabilities / seed / baseline …), enter your API key in the key bar inside this tab (kept in the server's memory only, never echoed; typing it and hitting start is enough), then click start: the CLI runs locally and its log streams into the page; when it finishes the scorecard renders in place with links to the md/html/json artifacts. Model detection is on by default (identity / quality / capability / context / TTFT); cost reconciliation is optional and only enabled when you enter the station's claimed prices.
2. **API aggregation & live monitoring — temporarily disabled in this version (pending a later iteration)** — the tab is hidden and every console `/api/gateway/*` endpoint returns 503; the implementation stays in place behind a feature flag. Designed behavior for when it ships: start a local multi-channel gateway in four steps: ① configure channels (name / protocol — Unified relay, OpenAI-compatible, or Anthropic Messages — / base URL / API key) and build each channel's model list by one-click probing the upstream `/models` endpoint (the request is made by the local server; the key never leaves your machine) or adding model rows manually (upstream model + optional public alias); optionally attach per-model prices (input/output per million tokens, optional cached-read rate, optional >threshold second tier) to track per-model cost; ② click **Start local API** to get the access address and the page-issued virtual client key; ③ watch every channel's live usage (requests, prompt/completion/cached tokens, cost) and anomaly alerts; ④ point your client at the address with the virtual key. Channel configuration lives in the console process, so it survives gateway stops/starts and can be prepared before starting (still lost if the console process itself exits). Data plane: OpenAI-compatible channels serve `chat/completions` + `responses` + `models`; Anthropic-compatible channels serve `messages` + `messages/count_tokens` (auth via `x-api-key` or Bearer); Unified-relay channels accept all of the above and forward each request in the format the client used — ideal for relays that speak both OpenAI and Anthropic formats, no need to distinguish them. One alias routes to exactly one channel with no retry/fallback/failover; a 3xx upstream response is rejected, and channel keys never touch disk or logs. Every forwarded request is recorded in a local ledger (`reports/gateway-ledger.db`, metadata only) and the console shows live usage plus anomaly alerts (model self-ID mismatch / error rate / truncation / usage anomalies / high TTFT) — see "API gateway: observability & data guarantees" below.
3. **Historical reports** — list everything under `reports/`, render any `report-*.json` scorecard in-page, open md/html in a new tab.

Notes:

- The `guard` transparent proxy is CLI-only (see "Guard" above): it requires the client key to equal `MODEL_XRAY_KEY` exactly and keeps running outside the console; the console no longer starts or stops it. It is also the only live-monitoring path for now: API aggregation (and the in-console live usage/alert panels) is temporarily disabled in this version.
- The server binds to 127.0.0.1 only; every mutating API call requires a per-session token injected into the page. Report files are served from `reports/` with an extension whitelist and path-traversal protection.
- The key lives in the local server process (or your env `MODEL_XRAY_KEY`); it is never written to logs (secrets are masked) and never appears in any command preview. The key bar lives in the one-shot-test tab only.
- The old purely-static shell is gone; the page still degrades to a read-only notice (with a copyable command preview) if opened without the local server.

### API gateway: observability & data guarantees

The local API gateway (Web console tab 2) records every forwarded request into a local SQLite ledger and watches channels for anomalies in real time. **It is temporarily disabled in this version** — the tab is hidden and all console `/api/gateway/*` endpoints return 503. The guarantees below describe the implemented behavior that ships when the feature is re-enabled; the verification scripts remain runnable because they exercise the gateway modules directly:

- **Ledger** — `reports/gateway-ledger.db`: structure metadata only (origin / channel / alias / status / tokens / cost / TTFT — no message content; channel keys are never written). Runtime data, gitignored.
- **Retention** — nothing is cleaned up automatically in this version: archive or delete the whole file when needed. Don't delete single rows — that breaks the hash chain by design; archiving means moving/renaming the whole database.
- **Hash chain** — every ledger row carries `row_hash = sha256(prev row_hash + canonical row JSON)`, chained per table (`requests`, `settlements`); `verifyChain()` reports the first broken row and counts rows predating the chain as legacy. It detects partial tampering (accidental edits, single-row rewrites); it is not keyed, so it cannot stop someone who rewrites the whole file.
- **Crash recovery** — on gateway start, requests without a settlement are closed as `interrupted` / `error_source=gateway` (the gateway restarted — never blamed on the relay); repeated recovery is idempotent.
- **Degraded, never blocking** — if a ledger write fails, forwarding continues unchanged; the observation gap is disclosed (console banner + `status().degraded`), never silently absorbed.
- **Anomaly alerts** — per-channel rolling window of the last 100 observations: model-name mismatch ≥ 2, error rate > 50% (n ≥ 5), any truncated response (n ≥ 3),  malformed `usage` > 30% (n ≥ 10), TTFT too high (uncontaminated samples n ≥ 20 and p95 ≥ 300 ms — an absolute floor, not a history comparison).  The same (channel, kind) alerts at most once per 30 min (suppressed repeats are counted and disclosed via `status().alertSuppressed`); all alerts stay silent  for the first 5 min after gateway start (`status().alertSilenceRemainingMs`; sticky `alertSilenceWasActive` discloses that the silence window was in effect).  Each event carries up to 10 evidence request ids to drill into via the ledger.
- **TTFT dual gauge + contamination guard** — each settlement carries two independent clocks:  `ttft_upstream_ms` (request sent → first content frame from upstream; for **non-streaming** responses there is no intermediate frame, so the clock measures to full-body arrival — compare TTFT only between same-mode samples) and `ttft_client_ms` (request accepted → first byte written to the client;  recorded for error relays too, NULL only when nothing was ever written — never a fake 0).  An event-loop delay ≥ 50 ms during a sample window marks the upstream sample contaminated: still recorded in the ledger (`ttft_contaminated = 1`, raw value kept)  but excluded from p50/p95, so a stalled machine cannot pollute the latency stats.
- **Console endpoints (token required)** — `GET /api/gateway/status`, `GET /api/gateway/usage`, `GET /api/gateway/events`, channel CRUD under `/api/gateway/channels`, and `POST /api/gateway/probe-models` (one-click upstream model-list probe) exist on the console port (8620) only; the data plane (8621) exposes no management endpoints.
- **Verification scripts** — each guarantee above maps to a runnable check (`npm run <script>`):
  `verify:sse` (byte-sliced SSE replay + UTF-8 boundary + usage rejection), `verify:usage` (usage validation matrix: the four rejection reasons of the usage validator),
  `verify:ledger` (hash chain + tamper detection + idempotent settle/recover), `verify:crash` (real SIGKILL crash recovery), `verify:leak` (canary key never in ledger/logs),
  `verify:ttft` (role-only fake first chunk excluded), `verify:tz` (epoch-ms timestamps), `verify:looplag` (contaminated sample eviction keeps conservation),
  `verify:alerts` (alert thresholds incl. `ttft_high` boundaries), `verify:degraded` (ledger failure → fail-open + disclosure). These cover the implemented slices;
  `verify:sched` / `verify:delta` / `verify:ports` / `verify:retry` belong to the not-yet-built M4–M6 slices and are intentionally absent.

### Status

v0.2.0 — `test` and the P2 `guard` proxy (CLI-only) are functional, and in-repo you also get the executable web console (`npm run ui`) with two tabs: one-shot test and historical reports. The local API gateway (multi-channel model-alias routing, no retry/fallback yet; OpenAI-compatible + Anthropic Messages + Unified-relay protocols incl. the OpenAI Responses format; optional per-model prices with cost stats; the local ledger, live usage stats and anomaly alerts from S1–S3) is implemented but **temporarily disabled in this version** (console tab hidden, `/api/gateway/*` returns 503) — it will return in a later iteration. Not yet published to npm: run from source (see Quick start); after publishing, `npx model-xray` works out of the box. This repository hosts the CLI and the versioned test assets; audit reports are generated locally under `reports/` and stay out of git (runtime data, .gitignore).

## 中文

`model-xray` 是一个开源 CLI，用实证手段检测兼容 OpenAI 协议的 LLM 接入点是否存在**模型真伪 / 掺水**问题（换壳、降智、截断上下文、虚标 token 计数等中转站常见套路）。它不要求你相信任何厂商的话：直接探测端点行为，产出可分享的红绿报告。

### 快速开始（从源码，约 5 分钟）

需要 **Node.js ≥ 22**（用 `node --version` 确认）。

```bash
git clone https://github.com/OpenLlamas/model-xray.git
cd model-xray
npm install
npm run build
npm link          # 可选但推荐：此后可用短命令 model-xray（npm 报权限错误则跳过）
```

设置 API key（`test` 与 `guard` 都读它；key 不进命令行、不进 shell 历史）：

```powershell
# PowerShell
$env:MODEL_XRAY_KEY = 'sk-你的key'
```

```bash
# bash / zsh
export MODEL_XRAY_KEY='sk-你的key'
```

跑一轮审计：

```bash
model-xray test \
  --base-url https://your-relay.example.com/v1 \
  --model gpt-4o \
  --yes
```

（跳过 `npm link` 的话，把命令里的 `model-xray` 换成 `node dist/src/cli.js` 即可。）

不想记参数？运行 `npm run ask`（Windows）：交互式终端向导逐项询问端点/模型/key，可先 dry-run 预估，确认后执行并输出报告路径。或运行 `npm run ui`（本地 Web 控制台，仅回环）：参数与 key 全部在网页录入，实时查看日志（「API 聚合实时监控」本版暂未上线，后需迭代，控制台入口已隐藏）。`guard` 常驻代理仅命令行可用。详见下文「Web 控制台」。

报告落盘到 `reports/`，文件名主干为 `report-<模型名>-<YYYY-MM-DD_HH-mm-ss>`（本地时间）三份：`report-<模型名>-<…>.md`（看这份）、`report-<模型名>-<…>.html`（浏览器打开）、`report-<模型名>-<…>.json`（原始证据）。退出码：`0` 通过/可疑 · `1` 不通过 · `2` 用法错误或未得出结论。

### 常用场景（照抄即可）

**1）只审计一次** —— 就是上面的命令。知道什么就补什么，不知道的项自动跳过：

| 你知道 | 加上 |
|---|---|
| 标称上下文窗口（如 128000） | `--claimed-context 128000` —— 启用 needle 实测 |
| 宣称能力 | `--expect vision,tool,thinking`（默认 `vision,tool`；都没宣称用 `--expect none`） |
| 标称价格（每百万 tokens） | `--price-input 0.2 --price-output 0.7` —— 启用实测倍率 |

想先看会发什么请求、大约花多少：加 `--dry-run`（不发任何请求）。一整轮通常只花几分钱——实测 53 样本 ≈ $0.015（按 $0.2/$0.7 每 M tokens）。

**2）过段时间复测 / 抓偷换模型** —— 保留第一次产出的 `baseline-<模型名>-<YYYY-MM-DD_HH-mm-ss>.json`，复测时带上：

```bash
model-xray test --base-url https://your-relay.example.com/v1 --model gpt-4o --yes \
  --baseline reports/baseline-gpt-4o-2026-10-11_10-09-23.json
```

**3）常驻监控（`guard`，仅命令行）** —— 本地透明代理，盯真实客户端流量并实时打分（控制台不再提供启停入口）：

```powershell
# ① key 只走环境变量（guard 没有 --key 旗标，key 不进命令行历史）
$env:MODEL_XRAY_KEY = 'sk-你的key'
# ② 启动代理（默认监听 127.0.0.1:8621）
model-xray guard --base-url https://your-relay.example.com/v1 `
  --price-input 0.2 --price-output 0.7 --reconcile-minutes 15
# ③ 把客户端 base-url 指向 http://127.0.0.1:8621/v1，
#    并把客户端 key 设为与 MODEL_XRAY_KEY 相同的值
```

之后正常用你的客户端：每 20 个已转发请求打印一次实时评分卡（可用性/计量/身份/时延/成本；滚动窗口 = 最近 100 个请求），异常立即告警，全部写入 `reports/guard/guard-YYYYMMDD.jsonl`（只记元数据）。`Ctrl+C` 退出前会先结算最后一个窗口。

**4）本地 Web 控制台一站式操作**（数据不出本机）：

```bash
npm run ui     # 自动打开 http://127.0.0.1:8620（仅本机回环）
```

### 结果怎么读

- **判定**（同退出码）：通过（0）· 可疑（0）· 不通过（1）· 用法错误/未得出结论（2）。
- 证据不足的维度标 `N/A` 并排除在计分之外——绝不按 0 分算。
- **计分**：加权几何合成 0–100 可信度总分：计量 25 / 质量 25 / 身份 15 / 上下文 15 / 能力 10（TTFT 仅观测，不计分）。任一维度 fail 或可信度总分 < 40 → 不通过；计量/能力/上下文/质量 低于 40 触发**硬红线**（可信度总分封顶 45）；能力被证伪（标称能力实测答错/被明确拒绝）→ 可信度总分封顶 60；可信度总分 < 75 或有 warn 维度 → 可疑。
- **质量口径（题集版本 v0.2.2，metricVersion pass1 起）**：主指标为 **pass@1**（首答正确率）——temperature 0.7 复采样仅作证据保留（`main`=pass@1、`main_recovered`=两次机会）。`fail` 判定额外要求复采样未恢复至 0.6 线（首答崩 + 复采仍崩才是定论级证据；首答偶发未中不算）。首答 <0.6 但被复采样救回的「复采洗白」形态判可疑并封顶 80 分。基线带 `metricVersion: 'pass1'`；与旧口径基线混比时跳过质量对比并提示（其余维度照常对比）——旧基线需重新生成后对比。
- 每条结论都附原始请求/响应证据，可回查。

### 检测项

| 检测项 | 做法 |
|---|---|
| 身份与指纹 | 自我身份问答（5 次自述，`--deep` 8 次，含 1 道完整模型名称与精确版本自述题）+ 行为指纹，识破换标签/换护栏的"套皮"模型（如自称 Claude 却答"我是 GLM"）；检测到「品牌名 + assistant/助手」形态的人格自述（如 "I am NovaRelay assistant"）→ warn 并分数封顶 80；同族但变体后缀不符（宣称 `glm-5.3`、自述 `glm-5.3-flash`）→ 变体冲突 warn 封顶 80；跨族 → fail 0 分 |
| 上下文长度实测 | 在标称深度埋 needle，验证标称窗口是真实的，而非静默截断；同时核对端点自报 `prompt_tokens` 与实际发送量，未通过校准的「通过」降为无法判定。深度档自深到浅执行；90% 档取得 ≥2 发有效 needle 全中、usage 校准可信且该档干净时，更浅各档**早停**并如实披露（不计入缺失深度）；`--context-samples ≥2` 时可省约 75% 的 needle 发送量 |
  | Token 计数对比 | 对端点自报 `prompt_tokens` 与本地保守估算（非官方 tokenizer）做同轮线性回归，暴露非线性/硬编码计数；并检查 `completion_tokens` 的硬矛盾（非空正文却报 0、或超过请求 `max_tokens`）。输出侧另有合计比对：Σ(可见 completion = completion − reasoning_tokens，仅 `finish=stop`) ÷ Σ(正文本地估算) > 1.35 → 疑似输出 token 灌水，warn 封顶 70；< 0.6 → 仅提示。回归存在非零常量偏移（finite r²≥0.9 且截距超 120 tokens）同样按疑似灌水 warn。形状/一致性/输出侧全过即判定「usage 未发现造假证据」：无绝对对账（`--token-reference` 或实测倍率）时该项 85 分并通过，headline 与 findings 如实披露「扣费金额真实性未验证」（全量等比缩放/常量偏移在回归中不可见）；绝对对账成立则 100 分。缺 usage 的样本、请求失败、可能已计费的重试（网关层 429/503 拒绝例外——未进入推理、通常不计费）、completion 异常一律封顶 70 而非通过 |
| 实测倍率（余额差值法） | 计费序列前后各查一次余额，两个快照都做**稳定化轮询**——连续两次读数一致才认稳定；且序列前的 pre 快照必须**首比即稳**：窗口前未结算的旧账会在 pre 之后入账混入 Δ，把诚实站点诬陷成虚高倍率（post 侧误差方向是漏计、pre 侧是诬告，不对称从严），pre 仍在动的窗口直接作废倍率（不可归因 info，绝不判 fail）。支持 new-api 风格站点：余额取 `GET /api/usage/token`（Bearer；key 级 `total_used`/`total_available`），`GET /api/status`（`quota_per_unit`）校准单位——校准不可达时不加分也不扣分；控制台 API 调用会自动剥掉 `baseUrl` 结尾的 `/v1`。one-api 风格 `/api/user/self`（用户级 quota）在 `/api/status` 可达时同样换算为 USD，但**用户级口径永不产出 fail**：同一用户全部 key 共享该余额，其他 key 的并发消费可把倍率推入 (1.5,10]，>1.5 只降为 warn 并把底层档位记入 `metrics.ratio_masked_verdict`（定论级指控只认 key 级来源）。Δ扣费 ÷（宣称价格 × 端点自报 usage）的应缴金额，揭示"低价"背后的真实倍率。倍率 > 1.5 → fail；(1.1, 1.5] 或 [0.5, 0.8) → warn（低报可能意味着 usage 少计或单位错配）；[0.8, 1.1] → 与宣称价格一致。应缴金额或 Δ 低于余额最小刻度 3 倍时判 N/A——若应缴金额本身低于该门槛，审计会**自动补采**最多 8 笔大 prompt 样本抬升 Δ 至可测区间（预算封顶 3× 目标额、预估不可达则整段跳过、出现首个不可归因事件立即停），而不是直接放弃；>10 倍的差值无法归因到本次窗口（账户级并发/单位错配），只报不可验证并保留原始倍率，不判 fail；窗口内出现可能已计费的重试（408/409/5xx/超时后重试——网关层 429/503 重试豁免）或失败请求时倍率作废 |
| Token 计数参照对比（`--token-reference`） | 与同名模型历史报告的逐档 prompt_tokens 对比（同题集版本才生效）：比值 > 1.25 → fail（分数封顶 30）；1.1–1.25 或 < 0.8 → warn（封顶 70）；0.8–1.1 → ok——唯一能识别"全量等比缩放"型计数虚增的手段（回归对此不可见）。限制如实声明：仅对比 prompt_tokens；参考报告须用户自行确认为可信来源；自动获取官方计费计数的能力暂缺（TODO） |
| 指纹基线对比 | 保存/对比版本化指纹基线（模型族、质量、能力、计费斜率），识别两次检测之间模型被偷换 |
| 能力校验 | vision / tool calling / thinking 标称能力逐项实测，而非只看宣称 |
| 固定题集质量打分 | 版本化可复现题集，对照参考答案量化质量（降智检测）；报告附准确率 95% Wilson 置信区间（仅披露，不改变判定阈值） |
| 流式首字延迟 | 采样 p50/p95 TTFT，识别"排队拉长"型中转 |

### 关键参数

| 参数 | 说明 |
|---|---|
| `--key <key>` | API key；也可改用环境变量 `MODEL_XRAY_KEY` / `OPENAI_API_KEY`（推荐：key 不进 shell 历史；guard 只能用环境变量） |
| `--claimed-context <n>` | 标称上下文窗口；启用 needle 实测 |
| `--context-samples <n>` | 每档 needle 样本数，1–5（默认 1；`--deep` 5）；3 = 统计定论档（自动复采） |
| `--context-budget-usd <n>` | 上下文探针的美元口径**软**预算（估算值）；必须与 `--price-input/--price-output` 成对提供。运行估算超过上限即停发后续请求，结尾回显标记 `budget-stopped`，若「通过」结论只建立在停发前的证据上则降为无法判定并披露估算花费。估算只覆盖计划内 needle 发送量，不含重试/流式回退的实际计费 |
| `--expect <list>` | 宣称能力，取值 `vision,tool,thinking`（或 `none`；默认 `vision,tool`） |
| `--price-input <n>` / `--price-output <n>` | 每百万 tokens 的宣称价格，必须成对出现；启用实测倍率探针 |
| `--price-cached-read <n>` | 可选的缓存读单价（$/百万 tokens，≥0；缺省按输入价） |
| `--price-threshold <n>` / `--price-input2 <n>` / `--price-output2 <n>` | 可选长上下文二档：prompt tokens 超过阈值时整单按二档价（三项必须同时提供） |
| `--price-cached-read2 <n>` | 可选的二档缓存读单价（≥0；缺省按二档输入价；须配合阶梯组） |
| `--baseline <path>` | 与基线文件做指纹对比；未显式给 `--seed` 时沿用基线 seed |
| `--baseline-out <path>` | 落盘本轮基线（缺省写到 `reports/baseline-<模型名>-<YYYY-MM-DD_HH-mm-ss>.json`） |
| `--token-reference <path>` | 与同名模型历史报告对比逐档 prompt token 计数（同题集版本才生效）——识别全量等比虚增；模型/题集版本不符时跳过并提示 |
| `--yes` | 跳过远程端点的交互式成本确认（脚本/非 TTY 环境必需） |
| `--dry-run` | 只打印计划请求量与 token 预估，不发任何请求 |
| `--deep` | 每项探针更多样本（更慢、更贵） |
| `--http-retries <n>` | 端点/网关层 429/503 拒绝时的每请求重试次数（整数 [0, 6]，默认 2）——与 `--retries`（200 空正文重试）分开计预算。此类请求未进入推理、通常不计费，因此**不污染**计费证据；其余可重试状态（408/409/500/502/504/超时/网络错误）仍按「可能已计费」判污染并作废实测倍率。运行级重试总预算（24）限制端点整体过载时的重试放大 |
| `--out <dir>` | 报告输出目录（缺省 `reports`） |

### 出错了怎么办

| 现象 | 处理 |
|---|---|
| `exit 2` / 提示成本确认 | 加 `--yes`（脚本、CI、非交互终端必需） |
| guard：客户端收到 `401` | 客户端 key 必须与 `MODEL_XRAY_KEY` **完全一致**；不一致的请求本地即拒、绝不转发 |
| guard：端口被占用 | `--port 8622`（默认 8621） |
| 成本维度 `N/A` / `skipped` | 站点没有 one-api 风格余额接口，或没给 `--price-input/--price-output`——对账降级为纯 token 统计，属正常 |
| 能力项 fail 但站方从没宣称过 | 只把站方确实宣称的能力放进 `--expect`（默认 `vision,tool`），其余去掉或用 `--expect none` |
| 端点对请求报 400 且错误信息含 `temperature` | 部分网关/模型拒绝该参数；客户端会自动去参重发一次并在证据中披露 `temperatureDropped`，审计照常进行——参数校验失败不进入推理、不计费，不构成计费污染 |
| 多个维度「未判定」且标题提示「端点/网关拒绝」 | 端点当时过载/限流（如 HTTP 503 system cpu overloaded），请求没进入推理。报告 notes 会汇总失败占比；建议错峰重测——工具不会把端点故障伪装成模型问题 |
| 想跑得更省更快 | 不传 `--price-*` 与 `--claimed-context`；先 `--dry-run` 预估 |
| cmd.exe 执行 web 壳生成的命令报错 | 该命令用单引号，请改用 PowerShell 或 bash（表单也有 cmd.exe 引号模式） |
| 构建失败 / 找不到 node | 安装 Node.js ≥ 22（https://nodejs.org） |

### 边界与注意

- **美元口径 + 精度要求。** 一次性审计的实测倍率要求余额读数为美元口径（quota 等非美元读数直接作废该项并提示，工具不换算单位）；余额差值 Δ 或本次应缴金额低于读数最小刻度 3 倍时视为精度噪声，同样作废。>10 倍的差值无法归因到本次窗口（账户级并发、充值/退款或单位错配），报告为不可验证并保留原始倍率，不判 fail。
- **勿有并发流量。** `test` 实测倍率窗口内，被测 key 不要跑其他请求——并发消费会抬高 Δ扣费、使倍率偏高估。（`guard` 模式下经代理的流量逐请求入账，只需注意别让同一 key 在代理之外并发使用。）
- **充值干扰。** 两次余额查询之间发生充值会使测量作废（Δ<0 直接判无效）；充值与消费叠加的情况难以识别，存疑时请人工核对该站账单流水。
- **同源假设。** 两次余额读数假定中转站路由到同一后端且返回非缓存值；多后端网关或余额缓存可能使 Δ失真。
- **计费维度核验的是端点自报 usage。** 判据：自报 `prompt_tokens` 与输入长度线性（英文+中文双轨回归）、内部一致（`total = prompt + completion`、无负值）、输出侧无矛盾（`completion_tokens` 与正文/请求 `max_tokens`）、输出侧合计比对（可见 completion ≈ 正文本地估算：>1.35 warn 封顶 70、<0.6 仅提示）、回归非零常量偏移（截距超 120 tokens 且 r²≥0.9 warn）、usage 恒定检测。全部通过且无绝对对账（既无 `--token-reference`、也没有可用余额对账窗口）时，计费维度判**通过（85 分）**：未发现 usage 造假证据，但全量等比缩放（如 ×1.3）、常量偏移与虚高扣费无法被形状证据排除——headline 与 findings 如实披露（`evidence_level: shape-only`）。绝对对账成立升为 100 分；有矛盾证据（非线性、恒定 usage、实测倍率 >1.5、参考漂移）仍判 fail。
- **阈值为启发式初值。** 漂移阈值（质量 15%/30%、计费斜率 0.05/20%、倍率 0.8–1.1–1.5）随题集版本化管理，保证跨版本报告可比。
- **基线沿用 seed。** `--baseline` 会沿用基线 seed 固定题集——端点理论上可对固定 seed 特判，该权衡在此明示。
- **基线格式。** 基线文件仅支持 `version: 1`；版本/模型/题集版本不符时跳过对比并给出提示。基线只含聚合指纹字段（模型族、正确率、能力布尔、计费斜率、seed）——不含 API key、提示词原文或余额数值。质量口径带 `metricVersion`：与旧口径（非 pass@1）基线混比时跳过质量对比并提示重建基线，其余维度照常对比。

### 原则

- **对所有平台一视同仁。** 工具自身没有"自营站点"立场。若你是接入点运营方，请发布自己的检测报告并接受任何人复测——公信力来自第三方跑同一条命令，而不是自带榜单。
- **不做排行榜。** 官方只发布报告不排名次，避免黑稿嫌疑。
- **证据优先。** 每条结论都附证据 id 链接原始请求/响应记录（单请求结论链接该请求证据；聚合结论链接全部相关样本证据）。
- **题集版本化。** 题库与 needle 均带版本号，报告可复现可追溯。

### Guard：本地常驻监控（P2）

`guard` 启动一个本地透明转发代理，盯**真实流量**而不是一次性探测（启动命令见「常用场景 3」）。逐请求盯什么：

- **模型一致性** —— 请求的 `model` 与端点实际应答的模型不一致，立即告警（`model_mismatch`）。比较前先归一（小写、去掉 `. _ - /` 分隔符），因为中转站常把同一 id 改写（`glm-5.3-flash` → `glm-5-3-flash`）；族名或版本号不同仍然照报。
- **Token 记账** —— 解析 SSE/JSON 响应里的 `usage`（字节原样透传）；token 为负或分项对不上报 `usage_invalid`。响应里带 `cached_tokens` / `reasoning_tokens` 明细时会一并捕获入账。
- **滚动对账** —— 提供宣称价格后，窗口首尾各查一次余额：Δ扣费 ÷ 应缴金额 = 实测倍率。倍率 > 1.5 按 fail 告警；超出漂移带宽（|ratio−1| > 0.05 且 > 0.2）按 warn 告警；窗口内充值（Δ<0）作废该窗口（`skipped_recharge`），不出假倍率。
- **JSONL 审计日志** —— 每请求一行，外加 reconcile/anomaly/fingerprint/score 事件，写入 `--out`（默认 `reports/guard`）并按日轮转。**只记元数据**：无对话内容、无凭证、无上游错误体、无 query——有专门的脱敏测试钉死这条红线。
- **截断与断连** —— `finish_reason=length` 记录在案；客户端流中断开标记 `aborted`。
- **实时评分卡** —— 每 20 个已转发请求输出一次多维单行评分（可用性/计量/身份/时延/成本），退出时无论计数再输出一张终卡；滚动窗口为最近 100 个已转发请求（本地 401/403 拒绝的请求不转发、不入窗）；「观测」项（截断率/缺用量/中止）仅记录不计总评；小样本（窗口内请求很少时）单笔异常即可拉红总评，属正常抖动。

可选：`--fingerprint-minutes 60` 周期性复跑身份族指纹探针，模型族漂移即告警（探针发真实请求、产生真实计费——默认关闭）。

边界：只有 `chat/completions`、`completions`、`embeddings` 做深检，其余路径原样转发并记基础行；仅支持 HTTP/1.1；深检端点会强制 `Accept-Encoding: identity`（除凭证替换外唯一的字节级改写）。余额探针按 one-api 风格 usage 接口读取（`total_usage` 必须是整数美分，按 ÷100 折算）；非整数/未知 schema 一律拒绝，quota 等非美元读数直接跳过（不换算），站点没有可用接口时对账降级为纯 token 统计并出 `skipped` 提示。本地鉴权用常量时间比较；`Ctrl+C`（或关闭 stdin）停止时先结算最后一个对账窗口再落盘。

### 中转站常见坑：掺假与偷调倍率（推荐用 Web 控制台实测）

市面上的中转站，两类问题最常见，而且都刻意做得「看不出来」：

- **掺假（换壳 / 轻量版冒充）**：用同家族的轻量版顶替旗舰模型——例如拿 `glm-5.3-flash` 冒充 `glm-5.3`。文档、模型自述、日常问答看起来都正常，常规使用极难察觉；只有对照「请求的模型名 vs 端点自述身份 / 应答指纹」的探针才抓得住。
- **偷调倍率**：标价看着正常，后台却悄悄设一个不太夸张的倍率（如 1.5×）——单笔账单金额不大、倍率「不离谱」，靠肉眼对账单几乎发现不了；只有绝对对账——实测扣费 ÷（宣称价格 × 自报 usage）——才能定论。

建议优先用 Web 控制台（`npm run ui`）而不是裸命令行：页面里可以勾选宣称能力（视觉 / 工具调用 / 推理）、填宣称上下文窗口、录入宣称价格（输入/输出单价，可选缓存读与长上下文二档阶梯价）、固定 seed 复测、加增强样本——**你声明得越全，探针跑得越彻底**。计费核价只在录入宣称价格后启用，想抓倍率就必须填价格。

真实案例（见下图，取自 `reports/report-glm-5.3-2026-10-20_03-25-22`）：某中转站拿 `glm-5.3-flash` 冒充 `glm-5.3`，并把倍率设到 1.5×。一次「开始检测」即被抓：identity 6 次身份探针全部回显不符（请求 `glm-5.3`，上游回显 `glm-5.3-flash`，疑似换壳/换通道），billing 实测倍率 1.5 > 1.5 → fail（封顶 30），另有 32/62 笔非流式空正文佐证——最终可信度总分 45 · 不通过（计费硬红线触发总分封顶）。页面上录入的标价完全正常；不录价格、不实测，这些问题根本不会浮出水面。

![案例：`glm-5.3-flash` 冒充 `glm-5.3` 且倍率 1.5×——总分 45/100，不通过](docs/audit-case-glm-5.3.png)

### Web 控制台（本地、可执行）

`npm run ui` 在 <http://127.0.0.1:8620>（默认端口，仅回环；自动打开浏览器）启动本地服务，把网页变成可执行的检测入口，两个标签页（「API 聚合」标签本版临时隐藏 · 后需迭代上线，见下）：

1. **一次性检测** —— 页面内设置全部参数（端点/模型/标称上下文/宣称能力/seed/基线…），在本页 key 栏录入 API key（仅存本地服务进程内存、绝不回显；录入后直接点开始检测即生效），点开始即在本机真实运行 CLI，日志实时流式滚动；结束后评分卡原位渲染，并附 md/html/json 报告链接。模型检测默认开启（身份/质量/能力/上下文/时延）；计费核价为可选，录入站点宣称价格后才启用（支持缓存读单价与超过阈值的二档阶梯价，二档可分别设置输入/输出/缓存读）。
2. **API 聚合与实时监控 —— 本版暂未上线（后需迭代）** —— 该标签已隐藏，控制台 `/api/gateway/*` 端点一律回 503；实现保留在功能开关之后。以下为上线后的设计行为：页面内按四步启动本地多渠道网关：① 配置渠道（名称 / 协议 —— 统一中转站、OpenAI 兼容或 Anthropic Messages —— / Base URL / API Key）并建立模型清单（「一键获取」由本机服务端请求上游 `/models` 列表 —— Key 不出本机 —— 或手动逐行添加：上游模型名 + 可选对外别名），可选为每个模型配置价格（输入/输出单价，$/百万 tokens；可选缓存读单价；可选超过阈值的长上下文二档价）以统计各模型费用；② 点「启动本地 API」生成接入地址与页面下发的虚拟客户端 Key；③ 实时监控每个渠道的用量（请求数、prompt/completion/缓存 token、费用）与异常告警；④ 让客户端指向该地址并使用虚拟 Key。渠道配置挂在控制台进程上：跨网关启停保留、启动前即可配置（控制台进程退出仍会丢失）。数据面：OpenAI 兼容渠道提供 `chat/completions`、`responses` 与 `models`；Anthropic 兼容渠道提供 `messages` 与 `messages/count_tokens`（认证走 `x-api-key` 或 Bearer）；统一中转站渠道接受以上全部请求，按客户端实际使用的格式原样转发 —— 适合同时支持 OpenAI 与 Anthropic 两种格式的中转站，无需区分。一个别名固定路由到一个渠道，不重试/不回退/不熔断；上游 3xx 一律拒绝；渠道 key 绝不落盘、绝不进日志。每个已转发请求记入本地账本（`reports/gateway-ledger.db`，仅元数据），控制台实时展示用量与异常告警（模型自述不符/错误率/截断/usage 异常/TTFT 偏高）——详见下文「API 网关：观测与数据保证」。
3. **历史报告** —— 列出 `reports/` 下全部报告，任意 `report-*.json` 页内渲染评分卡，md/html 新标签打开。

注意：

- `guard` 透明代理仅命令行可用（启动方式见「常用场景 3」）：它要求客户端 key 与 `MODEL_XRAY_KEY` 完全一致，适合长期盯真实流量，也是当前唯一的长期监控路径（控制台内的实时用量/告警面板随「API 聚合」一并暂未上线，后需迭代）；控制台不托管 guard 进程。
- 服务只绑定 127.0.0.1；所有写操作 API 都要求携带注入页面的会话 token。报告文件仅从 `reports/` 提供，带扩展名白名单与路径穿越防护。
- key 只存于本地服务进程（或环境变量 `MODEL_XRAY_KEY`）；key 栏仅位于「模型检测」页；绝不写日志（敏感串脱敏）、绝不出现在命令预览里。
- 旧的纯静态轻壳已移除；若页面脱离本地服务直接打开，会降级为只读提示（仍可预览可复制命令）。

### API 网关：观测与数据保证

本地 API 网关（Web 控制台第 2 页）把每个已转发请求记入本地 SQLite 账本，并实时监控渠道异常。**本版暂未上线**——该标签已隐藏、控制台 `/api/gateway/*` 端点回 503；下文为该功能上线后的已实现行为（验收脚本直接跑网关模块，仍可执行）：

- **账本** —— `reports/gateway-ledger.db`：只含结构元数据（origin/渠道/别名/状态/token/费用/TTFT，无任何正文；渠道 key 绝不写入）。属运行时数据、已 gitignore。
- **保留策略** —— 本版不自动清理：需要时整库归档或删除——不要手删单行（会按设计触发断链报告）；归档即整体移动/改名数据库文件。
- **hash 链** —— 每行带 `row_hash = sha256(上一行 row_hash + 规范化行 JSON)`，两表（`requests`/`settlements`）各自成链；`verifyChain()` 报告首个断点，上链前的旧行按 legacy 计数。可检出局部篡改（误改、单行重写）；链未加钥，无法阻止整体重写文件的人。
- **崩溃恢复** —— 网关启动时为无结算的请求补记 `interrupted` / `error_source=gateway`（是网关重启，绝不冤枉中转站）；重复恢复幂等。
- **降级不阻断** —— 账本写失败时转发照常；观测缺口显式披露（控制台横幅 + `status().degraded`），绝不静默吞掉。
- **异常告警** —— 按渠道滚动窗口（最近 100 条观测）：模型名不一致 ≥2；错误率 >50%（n≥5）；出现截断（n≥3）；usage 畸形 >30%（n≥10）；TTFT 偏高（未污染样本 n≥20 且 p95≥300ms——绝对下限，不与历史比较）。  同一 (渠道, 类别) 30 分钟内至多告警一次（重复触发的压制次数经 `status().alertSuppressed` 如实披露）；网关启动后前 5 分钟全体静默（`status().alertSilenceRemainingMs`；`alertSilenceWasActive` 粘性披露静默期曾生效）。每条事件附最多 10 条证据请求 id，可到账本下钻核对。
- **TTFT 双口径 + 污染防护** —— 每笔结算两个独立时钟：ttft_upstream_ms（请求发出 → 上游首个内容帧）与 ttft_client_ms（请求进网关 → 向客户端写出首个字节；错误体转发同样打点，全程无写入才为 NULL——绝不写 0 冒充）。  样本窗口内事件循环延迟 ≥ 50ms 时该上游样本标记污染：照实入账（`ttft_contaminated=1`，原始值保留）但不进 p50/p95，机器卡顿不会污染时延统计。
- **控制台端点（须 token）** —— `GET /api/gateway/status`、`GET /api/gateway/usage`、`GET /api/gateway/events`、`/api/gateway/channels` 下的渠道 CRUD、`POST /api/gateway/probe-models`（一键探测上游模型列表）仅存在于控制台端口（8620）；数据面（8621）不暴露任何管理端点。
- **验收脚本** —— 上文每条保证都对应一条可运行检查（`npm run <脚本>`）：
  verify:sse（逐字节切割 SSE 回放 + UTF-8 边界 + usage 拒收）· verify:usage（usage 校验矩阵：四类拒收口径）· verify:ledger（hash 链 + 篡改检出 + 幂等结算/恢复）·
  verify:crash（真实 SIGKILL 崩溃恢复）· verify:leak（金丝雀 key 绝不入账本/日志）· verify:ttft（仅角色假首帧剔除）· verify:tz（时间戳 epoch 毫秒口径）·
  verify:looplag（污染剔除守恒不变式）· verify:alerts（告警阈值含 ttft_high 边界）· verify:degraded（账本故障 → fail-open + 披露）。
  以上覆盖已实现切片；verify:sched / verify:delta / verify:ports / verify:retry 属尚未实施的 M4–M6 切片，故意不设。

### 状态

v0.2.0 —— `test` 与 `guard`（P2，仅命令行）均已可用；仓库内还提供可执行 Web 控制台（`npm run ui`，两个标签页：一次性检测 / 历史报告）。本地 API 聚合网关（多渠道模型别名路由，暂不重试/不回退；支持 OpenAI 兼容、Anthropic Messages 与统一中转站三种协议，含 OpenAI Responses 格式；已含本地账本、实时用量、可选模型价格与费用统计、异常告警）**已实现但本版临时停用**（「API 聚合」标签隐藏、`/api/gateway/*` 端点回 503）——后需迭代上线。尚未发布到 npm：请按「快速开始」从源码运行（发布后 `npx model-xray` 开箱即用）。本仓库承载 CLI 与版本化测试资产；检测报告生成在本机 `reports/`（已 gitignore，属运行数据，不入库）。

## License

MIT
