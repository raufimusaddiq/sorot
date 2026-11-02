# Contract: `llm` AI Provider Connection (US2 scope)

US2 makes **no change** to this contract. It is documented here so implementers can see exactly
what "the general provider form" means on the wire, and confirm the skip/choice affordance stays
purely a client-side (UI/CLI) decision in front of it.

Full reference: `docs/api-spec.md` §"GET /api/settings", §"PUT /api/settings/{llm|jev|tebar}",
§"POST /api/settings/{kind}/test".

## `GET /api/settings` (excerpt, `llm` key)

```jsonc
{
  "llm": {
    "active": false,                 // computed: true only once enabled + baseUrl + model + apiKey resolve to a usable client
    "enabled": true,
    "baseUrl": "",                   // "" when unset — this is the "unset" mode (data-model.md)
    "model": "",
    "apiKeySet": false,
    "apiKey": "",                    // masked ("••••xxxx") when apiKeySet is true; never the real key
    "director": false,
    "vision": false,
    "visionModel": "",
    "genMaxTokens": 32000,
    "saved": []                      // which fields are saved in the app (win over .env)
  }
}
```

## `PUT /api/settings/llm`

Request body: any subset of `{ enabled, baseUrl, model, apiKey, director, vision, visionModel,
genMaxTokens }`. A value saves it; `null` clears it back to the env default. Unknown field → 400.

**This is the entire "general provider" contract.** Reaching it never requires any Kenari-shaped
field — a client (UI or CLI) MAY call this with only `{ baseUrl, model, apiKey }` and nothing
Kenari-related at all, exactly as it can today. FR-012 is satisfied purely by *when* the UI/CLI
choose to call this endpoint (immediately, on "skip"), not by any new parameter on it.

Response: the same shape as the `GET /api/settings` excerpt above.

## `POST /api/settings/llm/test`

Unchanged: `{ "ok": true, "ms": 412, "model": "…", "detail": "…" }` or
`{ "ok": false, "ms": 3, "error": "Not configured: set a base URL and a model" }`. Used by both
the Kenari path (US1, out of scope) and the general-provider path (US2) identically — it only
exercises whatever `baseUrl`/`model`/`apiKey` are currently saved, regardless of their origin.

## Non-goals for US2

- No `llm.provider` or `llm.mode` field is added to this contract (see `research.md` §1, §3).
- No new endpoint (e.g. a Kenari-specific `/api/settings/llm/kenari`) is introduced by this plan;
  if US1 needs one for key validation or model-catalog fetching, it is defined in that story's
  own plan, not here.
