# Errori classificati e log — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ogni errore dell'applicazione porta una classe che dice cosa fare dopo, gli errori di trasporto vengono ritentati invece di uccidere la corsa, e ogni corsa lascia due log: uno curato per chi traduce e uno diagnostico completo.

**Architecture:** Un solo `BabelError` nel core con un `fault` fra otto classi; la classificazione avviene ai bordi (SDK, filesystem) e non nel core. Il ritentativo è un decoratore `LlmBackend` montato accanto a `countingBackend`, così tutte e tre le fasi che parlano al modello lo ereditano. Il logging è una porta `LogSink` sorella di `ProgressSink`: le righe `info+` finiscono in `run_event` e quindi nel Registro, tutte finiscono in un NDJSON per corsa nel workspace.

**Tech Stack:** TypeScript ESM con import `.ts`, Node 24.18.x, Vitest 4, Electron 43, Angular 22 + Transloco, XState 5, `node:sqlite`, AI SDK 7.

**Spec:** `docs/superpowers/specs/2026-09-01-errori-classificati-e-log-design.md`

## Global Constraints

- **Node 24.18.x.** Prima di ogni comando: `export PATH="$HOME/.local/share/fnm/node-versions/v24.18.0/installation/bin:$PATH"`
- **Il core è ESM con import `.ts` e solo sintassi cancellabile**: niente `enum`, niente `namespace`, niente parameter properties. Un `enum` non compila nella pipeline di `app/`.
- **Il core non importa Electron, `node:sqlite`, né alcun SDK.** Dichiara interfacce e riceve implementazioni (`core/ports.ts`).
- **Codice e commenti in inglese. Documenti, messaggi di commit e stringhe di catalogo in italiano** (con l'inglese in `en.json`).
- **Tipizzazione stretta** su proprietà, argomenti e ritorni. Niente `any`.
- **I controller non restituiscono mai entità**: vale qui come «l'IPC non restituisce mai un `Error`, sempre un `IpcFailure`».
- **La chiave API non deve mai comparire** in un `detail`, in un `LogRecord`, in un file di log o in un messaggio verso la finestra. `detail` è una lista permessa, mai l'errore grezzo.
- **Nessuna migrazione del database.** `run_event.severity` è `TEXT` senza `CHECK`; `project_state.info_json` esiste già.
- Comandi di prova, dalla radice del repository:
  - core: `npx vitest run core/test/<file>.test.ts`
  - main/engine: `npx vitest run app/test/<file>.test.ts`
  - renderer: `cd app && npx ng test --include renderer/src/app/<percorso>.spec.ts`
  - tutto: `npm test`
  - tipi: `npm run typecheck`
- Un commit per task, in italiano, nello stile del repository (`feat(run): …`, `fix(engine): …`).

---

## Struttura dei file

**Nuovi**

| file | responsabilità |
|---|---|
| `core/errors.ts` | `Fault`, `BabelError`, `RETRIES_ON`, `PAUSES_ON`. La sola definizione della tassonomia. |
| `core/translate/retry.ts` | `retryingBackend`: il decoratore che ritenta. Non sa cosa sia un 429. |
| `app/engine/backends/classify.ts` | L'unico modulo che legge gli errori dell'AI SDK. |
| `app/main/failure.ts` | L'unico modulo che legge gli errori di `node:fs` e `node:sqlite`. |
| `app/main/run/diagnostics.ts` | Lo scrittore NDJSON, la rotazione, la lettura unita dei due file. |
| `app/renderer/src/app/core/failure.ts` | `tell()`: da `IpcFailure` a corpo, suggerimento e codice. |

**Modificati**

| file | perché |
|---|---|
| `core/epub/errors.ts` | rimosso; i suoi tipi diventano casi di `BabelError` |
| `core/ports.ts` | `LogRecord`, `LogSink`, `nullSink` |
| `core/translate/usage.ts` | inoltra `structured` (difetto 2A) |
| `core/translate/engine.ts` | `inParallel` con abort condiviso (2B); il sink |
| `core/analyze/candidates.ts`, `core/analyze/code.ts` | il sink |
| `core/workflow/project.machine.ts` | `PAUSE` con `reason` |
| `app/shared/dto.ts` | `IpcFailure`/`packFailure` con `fault` e `retryAfterMs` |
| `app/shared/run.ts` | `EngineMessage.failed` arricchito |
| `app/shared/channels.ts` | `run.diagnostics` |
| `app/engine/main.ts` | il classificatore al posto di `failureCode` |
| `app/main/run/orchestrator.ts` | il montaggio di `retryingBackend` e del sink |
| `app/main/run/runtime.ts` | il tavolo `PAUSES_ON`, `release()`, `send` prima di `leaveState` |
| `app/main/run/log.ts` | `SEVERITIES` conosce `warn` |
| `app/main/compose.ts` | codici propri al posto di `Error` nudi |
| `app/main/ipc.ts` | il gestore `run.diagnostics` |
| `app/locales/it.json`, `en.json` | `faults.*`, `codes.*`, `alerts.paused` |
| `app/renderer/src/app/project/side/side.ts`, `side.html`, `side.css` | i due cartellini, `phrase()` con parametri, la vista grezza |
| `app/renderer/src/app/settings/providers.ts`, `glossaries.ts`, `preferences.ts` | il corpo da `tell()` |

**Ordine.** I task 1-4 costruiscono il vocabolario e non cambiano alcun comportamento. I task 5-6 sono due correzioni indipendenti che si possono rilasciare da sole. I task 7-10 aggiungono ritentativo e log. I task 11-13 portano la classe fino allo stato del progetto. I task 14-18 sono l'interfaccia. Il task 19 è la prova dal vivo.

---

## Task 1: La tassonomia nel core

**Files:**
- Create: `core/errors.ts`
- Delete: `core/epub/errors.ts`
- Modify: `core/epub/index.ts`, e ogni file che importa da `./errors.ts`
- Test: `core/test/errors.test.ts`

**Interfaces:**
- Consumes: nulla.
- Produces: `Fault`, `BabelError`, `isBabelError(error: unknown): error is BabelError`, `RETRIES_ON: Record<Fault, boolean>`, `PAUSES_ON: Record<Fault, boolean>`, e gli alias `EpubError`, `EpubReadError`, `EpubWriteError`, `ScanError`.

- [ ] **Step 1: Trova chi importa il vecchio modulo**

```bash
grep -rn "epub/errors" --include=*.ts . | grep -v node_modules
```

Annota l'elenco: ogni riga va aggiornata allo Step 5.

- [ ] **Step 2: Scrivi il test che fallisce**

`core/test/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BabelError, isBabelError, PAUSES_ON, RETRIES_ON, type Fault,
} from "../errors.ts";

const ALL: Fault[] = [
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
];

describe("the fault taxonomy", () => {
  /**
   * The two tables are the specification. A fault missing from either one
   * would be read as `undefined`, which is falsy, which is to say the run
   * would silently stop retrying and silently choose `failed` — the two
   * decisions this type exists to make.
   */
  it("answers both questions for every fault", () => {
    for (const fault of ALL) {
      expect(typeof RETRIES_ON[fault]).toBe("boolean");
      expect(typeof PAUSES_ON[fault]).toBe("boolean");
    }
    expect(Object.keys(RETRIES_ON).sort()).toEqual([...ALL].sort());
    expect(Object.keys(PAUSES_ON).sort()).toEqual([...ALL].sort());
  });

  it("retries exactly the two faults a retry can help", () => {
    expect(ALL.filter((fault) => RETRIES_ON[fault])).toEqual(["transient", "throttled"]);
  });

  /** `failed` means "resuming would not fix it", and only three faults qualify. */
  it("ends in failed only where resuming would not fix it", () => {
    expect(ALL.filter((fault) => !PAUSES_ON[fault])).toEqual(["input", "refused", "defect"]);
  });
});

describe("a BabelError", () => {
  it("carries its code, its fault and its detail", () => {
    const error = new BabelError("rate limited", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    });

    expect(error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(error.fault).toBe("throttled");
    expect(error.detail).toEqual({ status: 429 });
    expect(error.retryAfterMs).toBe(4000);
    expect(error.name).toBe("BabelError");
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps the error it was built from, without exposing it", () => {
    const cause = new Error("socket hang up");
    const error = new BabelError("unreachable", {
      code: "PROVIDER_UNREACHABLE", fault: "transient", cause,
    });
    expect(error.cause).toBe(cause);
    expect(error.detail).toEqual({});
  });

  /**
   * Recognised across a process boundary, where `instanceof` cannot be
   * trusted: the engine runs in its own process and the error it throws is
   * structurally cloned, not carried.
   */
  it("is recognised structurally, not by prototype", () => {
    expect(isBabelError(new BabelError("x", { code: "X", fault: "defect" }))).toBe(true);
    expect(isBabelError({ code: "X", fault: "defect", detail: {} })).toBe(true);
    expect(isBabelError({ code: "X", fault: "invented" })).toBe(false);
    expect(isBabelError(new Error("plain"))).toBe(false);
    expect(isBabelError(null)).toBe(false);
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/errors.test.ts`
Expected: FAIL — `Cannot find module '../errors.ts'`

- [ ] **Step 4: Scrivi `core/errors.ts`**

```ts
/**
 * What went wrong, and what that authorises.
 *
 * The core never produces a sentence for a reader: an error carries a stable
 * `code` and the interface composes the wording from it, in its own language.
 * The `fault` is the second half of that idea. It does not describe the
 * failure — it answers the only question a caller actually has, which is what
 * to do next, and it answers it the same way every time.
 */
export type Fault =
  /** Retrying helps, and at once: a socket closed, a timeout, a 5xx. */
  | "transient"
  /** Retrying helps, but at the hour the provider named. */
  | "throttled"
  /** Retrying today does not help: the credit or the daily quota is gone. */
  | "exhausted"
  /** Somebody has to change a setting before this can work at all. */
  | "config"
  /** The book itself: undecodable, malformed, not an EPUB. */
  | "input"
  /** The gate refused what we composed. Composing it again unchanged would not help. */
  | "refused"
  /** An invariant of ours broke. This is what the diagnostic file is for. */
  | "defect"
  /** A pause or a cancellation. Not a failure, but it travels the same `catch`. */
  | "cancelled";

/**
 * The two tables, and the only two readings of a fault that are allowed.
 *
 * An `if` on the fault written anywhere else is a second table, and it is the
 * second table that drifts. Both are exhaustive by their type: a fault added
 * without an answer here stops compiling, which is the point.
 */
export const RETRIES_ON: Record<Fault, boolean> = {
  transient: true,
  throttled: true,
  exhausted: false,
  config: false,
  input: false,
  refused: false,
  defect: false,
  cancelled: false,
};

/** True where the project stops in `paused`, false where it stops in `failed`. */
export const PAUSES_ON: Record<Fault, boolean> = {
  transient: true,
  throttled: true,
  exhausted: true,
  config: true,
  input: false,
  refused: false,
  defect: false,
  cancelled: true,
};

const FAULTS = new Set<string>(Object.keys(RETRIES_ON));

export interface BabelErrorInit {
  code: string;
  fault: Fault;
  /**
   * An allow-list, never the raw error.
   *
   * A provider's error object holds the request that caused it, headers
   * included, which is to say the API key. Copying one wholesale into a detail
   * or a log line is exactly how the promise that the key never leaves the
   * main process breaks without anybody noticing. Whoever classifies names the
   * fields it wants and drops the rest.
   */
  detail?: Record<string, string | number | boolean>;
  /** Only on `throttled`, and only when the provider actually said so. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class BabelError extends Error {
  readonly code: string;
  readonly fault: Fault;
  readonly detail: Record<string, string | number | boolean>;
  readonly retryAfterMs?: number;

  constructor(message: string, init: BabelErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "BabelError";
    this.code = init.code;
    this.fault = init.fault;
    this.detail = init.detail ?? {};
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

/**
 * Recognised by shape, not by prototype.
 *
 * The engine runs in its own process: what arrives on the other side of the
 * port was structurally cloned, and `instanceof` there is always false.
 */
export function isBabelError(error: unknown): error is BabelError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; fault?: unknown };
  return typeof candidate.code === "string"
    && typeof candidate.fault === "string"
    && FAULTS.has(candidate.fault);
}

/**
 * The EPUB layer's own errors, kept as names because they read well at the
 * throw site. They are `BabelError`s now, and they are all `input`: a book
 * that will not open does not open on the second attempt either.
 */
export class EpubError extends BabelError {
  constructor(message: string, code: string, fault: Fault = "input") {
    super(message, { code, fault });
    this.name = new.target.name;
  }
}

export class EpubReadError extends EpubError {}
export class EpubWriteError extends EpubError {}
export class ScanError extends EpubError {}
```

- [ ] **Step 5: Rimuovi il vecchio modulo e reindirizza gli import**

```bash
rm core/epub/errors.ts
```

In ogni file trovato allo Step 1, sostituisci `from "./errors.ts"` / `from "../errors.ts"` con il percorso di `core/errors.ts` (per esempio, da `core/epub/scan.ts`: `from "../errors.ts"`). In `core/epub/index.ts`, la riga `export * from "./errors.ts";` diventa:

```ts
export { EpubError, EpubReadError, EpubWriteError, ScanError } from "../errors.ts";
```

- [ ] **Step 6: Esegui i test e i tipi**

Run: `npx vitest run core/test/errors.test.ts && npm test -w core && npm run typecheck`
Expected: PASS, e nessun errore di tipo. Se un test del core asseriva `instanceof EpubReadError`, continua a passare: la catena di prototipi è intatta.

- [ ] **Step 7: Commit**

```bash
git add core/errors.ts core/epub/ core/test/errors.test.ts
git commit -m "feat(core): un errore porta la classe che dice cosa fare dopo"
```

---

## Task 2: La classe attraversa il ponte IPC

**Files:**
- Modify: `app/shared/dto.ts:519-556`
- Test: `app/test/schema.test.ts` (aggiunta) oppure un nuovo `app/test/failure-wire.test.ts`

**Interfaces:**
- Consumes: `Fault` da `core/errors.ts` (Task 1).
- Produces: `IpcFailure` con `code: string`, `fault: Fault`, `message?: string`, `retryAfterMs?: number`; `packFailure(error: unknown): string`; `unpackFailure(error: unknown): IpcFailure`.

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/failure-wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { packFailure, unpackFailure } from "../shared/dto.ts";

/** What `ipcMain.handle` does to a rejection, so the test crosses the same bridge. */
const overTheBridge = (error: unknown): Error => new Error(packFailure(error));

describe("a failure crossing the bridge", () => {
  it("carries the code and the fault", () => {
    const failure = unpackFailure(overTheBridge(new BabelError("rate limited", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    })));

    expect(failure.code).toBe("PROVIDER_RATE_LIMITED");
    expect(failure.fault).toBe("throttled");
    expect(failure.retryAfterMs).toBe(4000);
    expect(failure["status"]).toBe(429);
  });

  /**
   * An error nobody classified is a defect, not an unknown: the window can
   * still say something true about it, and the diagnostic file has the rest.
   */
  it("calls an unclassified error a defect", () => {
    const failure = unpackFailure(overTheBridge(new Error("something broke")));
    expect(failure.code).toBe("UNKNOWN");
    expect(failure.fault).toBe("defect");
  });

  it("survives a message that is not one of ours", () => {
    expect(unpackFailure(new Error("plain")).fault).toBe("defect");
    expect(unpackFailure(null).fault).toBe("defect");
  });

  /**
   * The rule of the whole design, asserted where it would break: a provider's
   * error object holds the request that caused it. Nothing that is not named
   * gets to cross.
   */
  it("never carries a key, whatever the error was holding", () => {
    const leaky = Object.assign(new Error("401 from provider"), {
      apiKey: "sk-secret-key",
      requestBodyValues: { headers: { authorization: "Bearer sk-secret-key" } },
    });

    const packed = packFailure(new BabelError("unauthorized", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", detail: { status: 401 }, cause: leaky,
    }));

    expect(packed).not.toContain("sk-secret-key");
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/failure-wire.test.ts`
Expected: FAIL — `expected undefined to be 'throttled'`

- [ ] **Step 3: Modifica `app/shared/dto.ts`**

Sostituisci il blocco `IpcFailure` / `packFailure` / `unpackFailure` (righe 519-556) con:

```ts
import { isBabelError, type Fault } from "../../core/errors.ts";

/**
 * A failure as the window receives it.
 *
 * `code` names the thing that happened; `fault` says what to do about it, and
 * is what lets a screen answer even for a code nobody catalogued.
 */
export interface IpcFailure {
  code: string;
  fault: Fault;
  message?: string;
  retryAfterMs?: number;
  [detail: string]: unknown;
}

const MARKER = "babelbook-failure:";

/**
 * Only what was named crosses.
 *
 * The own-enumerable scan below is the second net under the allow-list rule
 * that `BabelError.detail` states: even if a classifier were careless, only
 * scalars on the error's own surface can travel, and never `cause`, which is
 * where a provider keeps the request it failed on.
 */
export function packFailure(error: unknown): string {
  const classified = isBabelError(error);
  const failure = error as { code?: unknown; message?: unknown; detail?: unknown };

  const details: Record<string, unknown> = {};
  if (classified && typeof failure.detail === "object" && failure.detail !== null) {
    for (const [key, value] of Object.entries(failure.detail)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
  } else {
    for (const [key, value] of Object.entries(error as object)) {
      if (key !== "code" && key !== "fault" && key !== "stack" && key !== "cause"
        && (typeof value === "string" || typeof value === "number")) {
        details[key] = value;
      }
    }
  }

  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;

  return MARKER + JSON.stringify({
    code: classified ? (failure.code as string) : "UNKNOWN",
    // Unclassified is a defect, not an unknown: the window can still say
    // something true, and the diagnostic file holds what this drops.
    fault: classified ? (error as { fault: Fault }).fault : "defect",
    message: typeof failure.message === "string" ? failure.message : String(error),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
    ...details,
  });
}

export function unpackFailure(error: unknown): IpcFailure {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return { code: "UNKNOWN", fault: "defect" };

  const at = message.indexOf(MARKER);
  if (at === -1) return { code: "UNKNOWN", fault: "defect", message };

  try {
    const parsed = JSON.parse(message.slice(at + MARKER.length)) as IpcFailure;
    return { ...parsed, fault: parsed.fault ?? "defect" };
  } catch {
    return { code: "UNKNOWN", fault: "defect", message };
  }
}
```

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run app/test/failure-wire.test.ts && npx vitest run app/test && npm run typecheck`
Expected: PASS. Se un test esistente asseriva `{ code: "UNKNOWN" }` con `toEqual`, aggiornalo a includere `fault: "defect"`.

- [ ] **Step 5: Commit**

```bash
git add app/shared/dto.ts app/test/failure-wire.test.ts
git commit -m "feat(ipc): un errore attraversa il ponte con la sua classe"
```

---

## Task 3: Il classificatore degli errori del provider

**Files:**
- Create: `app/engine/backends/classify.ts`
- Test: `app/test/classify.test.ts`

**Interfaces:**
- Consumes: `BabelError`, `Fault` da `core/errors.ts`.
- Produces: `classifyProviderError(error: unknown): BabelError`.

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/classify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { APICallError, LoadAPIKeyError, NoSuchModelError, TypeValidationError } from "@ai-sdk/provider";
import { classifyProviderError } from "../engine/backends/classify.ts";

/** An SDK error as a provider really builds one, key and all. */
function apiError(init: {
  statusCode?: number; headers?: Record<string, string>; body?: string; retryable?: boolean;
}): APICallError {
  return new APICallError({
    message: `provider said ${init.statusCode ?? "nothing"}`,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: { headers: { authorization: "Bearer sk-secret-key" } },
    ...(init.statusCode === undefined ? {} : { statusCode: init.statusCode }),
    ...(init.headers === undefined ? {} : { responseHeaders: init.headers }),
    ...(init.body === undefined ? {} : { responseBody: init.body }),
    ...(init.retryable === undefined ? {} : { isRetryable: init.retryable }),
  });
}

describe("classifying what a provider answered", () => {
  it("calls a 429 with a wait a throttling, and honours the wait", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 429, headers: { "retry-after": "7" },
    }));
    expect(classified.code).toBe("PROVIDER_RATE_LIMITED");
    expect(classified.fault).toBe("throttled");
    expect(classified.retryAfterMs).toBe(7000);
  });

  it("reads a retry-after given as a date", () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const classified = classifyProviderError(apiError({ statusCode: 429, headers: { "retry-after": when } }));
    expect(classified.retryAfterMs).toBeGreaterThan(20_000);
    expect(classified.retryAfterMs).toBeLessThanOrEqual(31_000);
  });

  /**
   * The distinction the whole taxonomy exists for. Both are 429; one is a
   * pause of seconds and the other is a pause until somebody pays.
   */
  it("separates a rate limit from credit that has run out", () => {
    const broke = classifyProviderError(apiError({
      statusCode: 429, body: '{"error":{"message":"You have insufficient credits"}}',
    }));
    expect(broke.code).toBe("PROVIDER_OUT_OF_CREDIT");
    expect(broke.fault).toBe("exhausted");
    expect(broke.retryAfterMs).toBeUndefined();
  });

  it("calls a 402 an exhausted account too", () => {
    expect(classifyProviderError(apiError({ statusCode: 402 })).fault).toBe("exhausted");
  });

  it.each([401, 403])("calls a %i a matter of configuration", (statusCode) => {
    const classified = classifyProviderError(apiError({ statusCode }));
    expect(classified.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(classified.fault).toBe("config");
  });

  it.each([500, 502, 503, 529])("calls a %i transient", (statusCode) => {
    const classified = classifyProviderError(apiError({ statusCode }));
    expect(classified.code).toBe("PROVIDER_SERVER_ERROR");
    expect(classified.fault).toBe("transient");
  });

  it("calls a 404 a model that is not there", () => {
    const classified = classifyProviderError(apiError({ statusCode: 404 }));
    expect(classified.code).toBe("MODEL_NOT_FOUND");
    expect(classified.fault).toBe("config");
  });

  it("calls a request too large for the window a matter of configuration", () => {
    const classified = classifyProviderError(apiError({
      statusCode: 400, body: '{"error":{"message":"maximum context length is 8192 tokens"}}',
    }));
    expect(classified.code).toBe("CONTEXT_EXCEEDED");
    expect(classified.fault).toBe("config");
  });

  it("calls a socket that went away transient", () => {
    const classified = classifyProviderError(
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
    );
    expect(classified.code).toBe("PROVIDER_UNREACHABLE");
    expect(classified.fault).toBe("transient");
  });

  it("calls a timeout transient", () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    expect(classifyProviderError(timeout).code).toBe("PROVIDER_TIMEOUT");
    expect(classifyProviderError(timeout).fault).toBe("transient");
  });

  /** An abort is the person's own hand. It must never look like a failure. */
  it("calls an abort a cancellation", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyProviderError(abort).fault).toBe("cancelled");
  });

  it("calls a missing key a matter of configuration", () => {
    const classified = classifyProviderError(new LoadAPIKeyError({ message: "no key" }));
    expect(classified.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(classified.fault).toBe("config");
  });

  it("calls an unknown model a matter of configuration", () => {
    const classified = classifyProviderError(
      new NoSuchModelError({ modelId: "nope", modelType: "languageModel" }),
    );
    expect(classified.code).toBe("MODEL_NOT_FOUND");
  });

  /** The schema contract's own failure: the answer came, and it was not usable. */
  it("calls an answer that did not fit the schema unusable", () => {
    const classified = classifyProviderError(
      new TypeValidationError({ value: { nope: true }, cause: new Error("bad shape") }),
    );
    expect(classified.code).toBe("RESPONSE_UNUSABLE");
    expect(classified.fault).toBe("transient");
  });

  it("calls anything it does not recognise a defect, and keeps the cause", () => {
    const cause = new Error("who knows");
    const classified = classifyProviderError(cause);
    expect(classified.code).toBe("PROVIDER_UNKNOWN");
    expect(classified.fault).toBe("defect");
    expect(classified.cause).toBe(cause);
  });

  /** The rule of the design, asserted at the one place that reads a raw error. */
  it("never lets the key into the detail", () => {
    const classified = classifyProviderError(apiError({ statusCode: 401 }));
    expect(JSON.stringify(classified.detail)).not.toContain("sk-secret-key");
    expect(Object.keys(classified.detail)).toEqual(["status"]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/classify.test.ts`
Expected: FAIL — `Cannot find module '../engine/backends/classify.ts'`

- [ ] **Step 3: Scrivi `app/engine/backends/classify.ts`**

```ts
import {
  APICallError, LoadAPIKeyError, NoSuchModelError, TypeValidationError,
} from "@ai-sdk/provider";
import { BabelError } from "../../../core/errors.ts";

/**
 * The one module that reads what a provider actually threw.
 *
 * It lives here and not in the core for the same reason the SDK does: the core
 * does not know what a 429 is, and if it did it would stop being the core.
 *
 * Everything it returns is built field by field. An SDK error holds the
 * request that caused it — `requestBodyValues`, and with it the headers, and
 * with them the API key. Copying one wholesale is how the promise that the key
 * never leaves this process breaks silently, so nothing is copied: the fields
 * below are named, and the rest is dropped.
 */

/** Phrases providers use for the one 429 that waiting will not fix. */
const OUT_OF_CREDIT = /insufficient (credit|quota|balance)|out of credit|billing|payment required/i;
const CONTEXT_TOO_LONG = /context length|context window|too many tokens|maximum.*tokens|prompt is too long/i;
const UNREACHABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET",
]);

/** `Retry-After` is seconds or an HTTP date; both become milliseconds, or nothing. */
function retryAfterOf(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

function nameOf(error: unknown): string {
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function systemCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const cause = (error as { cause?: unknown }).cause;
  const nested = (cause as { code?: unknown } | undefined)?.code;
  return typeof nested === "string" ? nested : "";
}

function apiCallError(error: APICallError): BabelError {
  const status = error.statusCode;
  const body = typeof error.responseBody === "string" ? error.responseBody : "";
  const detail: Record<string, string | number | boolean> =
    status === undefined ? {} : { status };

  if (status === 402 || (status === 429 && OUT_OF_CREDIT.test(body))) {
    return new BabelError("the account has nothing left to spend", {
      code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted", detail, cause: error,
    });
  }

  if (status === 429) {
    const retryAfterMs = retryAfterOf(error.responseHeaders);
    return new BabelError("the provider asked us to slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", detail,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      cause: error,
    });
  }

  if (status === 401 || status === 403) {
    return new BabelError("the provider did not accept the key", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", detail, cause: error,
    });
  }

  if (status === 404) {
    return new BabelError("the provider does not know that model", {
      code: "MODEL_NOT_FOUND", fault: "config", detail, cause: error,
    });
  }

  if (CONTEXT_TOO_LONG.test(body) || CONTEXT_TOO_LONG.test(error.message)) {
    return new BabelError("the request did not fit the model's window", {
      code: "CONTEXT_EXCEEDED", fault: "config", detail, cause: error,
    });
  }

  // `isRetryable` is the SDK's own verdict and it is worth honouring where we
  // have nothing better: a provider it knows says so about statuses we do not
  // enumerate.
  if ((status !== undefined && status >= 500) || error.isRetryable) {
    return new BabelError("the provider answered with an error of its own", {
      code: "PROVIDER_SERVER_ERROR", fault: "transient", detail, cause: error,
    });
  }

  return new BabelError("the provider refused the request", {
    code: "PROVIDER_UNKNOWN", fault: "defect", detail, cause: error,
  });
}

export function classifyProviderError(error: unknown): BabelError {
  // Already ours: a classifier that reclassified would turn a considered
  // verdict into a guess.
  if (error instanceof BabelError) return error;

  const name = nameOf(error);
  if (name === "AbortError" || name === "TimeoutError") {
    return name === "AbortError"
      ? new BabelError("the run was stopped", { code: "CANCELLED", fault: "cancelled", cause: error })
      : new BabelError("the provider did not answer in time", {
        code: "PROVIDER_TIMEOUT", fault: "transient", cause: error,
      });
  }

  if (APICallError.isInstance(error)) return apiCallError(error);

  if (LoadAPIKeyError.isInstance(error)) {
    return new BabelError("no key was configured for this provider", {
      code: "PROVIDER_UNAUTHORIZED", fault: "config", cause: error,
    });
  }

  if (NoSuchModelError.isInstance(error)) {
    return new BabelError("the provider does not know that model", {
      code: "MODEL_NOT_FOUND", fault: "config", cause: error,
    });
  }

  // The schema contract's own failure: something came back, and it was not
  // usable. Transient because the next sample may well be, and the engine's
  // own attempts are what will find out.
  if (TypeValidationError.isInstance(error)) {
    return new BabelError("the answer did not fit the schema", {
      code: "RESPONSE_UNUSABLE", fault: "transient", cause: error,
    });
  }

  const systemCode = systemCodeOf(error);
  if (UNREACHABLE.has(systemCode)) {
    return new BabelError("the provider could not be reached", {
      code: "PROVIDER_UNREACHABLE", fault: "transient", detail: { errno: systemCode }, cause: error,
    });
  }

  return new BabelError("the provider failed in a way nobody has named", {
    code: "PROVIDER_UNKNOWN", fault: "defect", cause: error,
  });
}
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run app/test/classify.test.ts`
Expected: PASS, tutti.

- [ ] **Step 5: Commit**

```bash
git add app/engine/backends/classify.ts app/test/classify.test.ts
git commit -m "feat(engine): l'errore di un provider prende un nome e una classe"
```

---

## Task 4: Il classificatore degli errori di sistema

**Files:**
- Create: `app/main/failure.ts`
- Test: `app/test/failure.test.ts`

**Interfaces:**
- Consumes: `BabelError` da `core/errors.ts`.
- Produces: `classifySystemError(error: unknown, context?: { path?: string }): BabelError`.

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/failure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BabelError } from "../../core/errors.ts";
import { classifySystemError } from "../main/failure.ts";

const errno = (code: string): Error => Object.assign(new Error(code), { code });

describe("classifying what the machine answered", () => {
  it("calls a missing file an input problem, and says which", () => {
    const classified = classifySystemError(errno("ENOENT"), { path: "/w/source.epub" });
    expect(classified.code).toBe("SOURCE_MISSING");
    expect(classified.fault).toBe("input");
    expect(classified.detail["path"]).toBe("/w/source.epub");
  });

  /** A full disk is nobody's bug and no retry fixes it: somebody has to act. */
  it("calls a full disk a matter of configuration", () => {
    const classified = classifySystemError(errno("ENOSPC"));
    expect(classified.code).toBe("DISK_FULL");
    expect(classified.fault).toBe("config");
  });

  it.each(["EACCES", "EPERM"])("calls %s a matter of configuration", (code) => {
    expect(classifySystemError(errno(code)).code).toBe("PATH_NOT_WRITABLE");
    expect(classifySystemError(errno(code)).fault).toBe("config");
  });

  it("calls a locked database transient, because it is", () => {
    const classified = classifySystemError(new Error("database is locked"));
    expect(classified.code).toBe("DATABASE_BUSY");
    expect(classified.fault).toBe("transient");
  });

  it("passes one of ours through untouched", () => {
    const mine = new BabelError("x", { code: "GATE_REFUSED", fault: "refused" });
    expect(classifySystemError(mine)).toBe(mine);
  });

  it("calls anything else a defect", () => {
    expect(classifySystemError(new Error("who knows")).fault).toBe("defect");
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/failure.test.ts`
Expected: FAIL — `Cannot find module '../main/failure.ts'`

- [ ] **Step 3: Scrivi `app/main/failure.ts`**

```ts
import { BabelError } from "../../core/errors.ts";

/**
 * The one module that reads what `node:fs` and `node:sqlite` threw.
 *
 * Same rule as `classify.ts` on the engine side, for the same reason: an errno
 * means nothing to a reader and everything to the decision about what happens
 * next.
 */

interface Context {
  /** The path being read or written, when the caller knows it. */
  path?: string;
}

const CONFIG: Record<string, string> = {
  ENOSPC: "DISK_FULL",
  EACCES: "PATH_NOT_WRITABLE",
  EPERM: "PATH_NOT_WRITABLE",
  EROFS: "PATH_NOT_WRITABLE",
};

export function classifySystemError(error: unknown, context: Context = {}): BabelError {
  if (error instanceof BabelError) return error;

  const detail: Record<string, string | number | boolean> =
    context.path === undefined ? {} : { path: context.path };
  const code = (error as { code?: unknown }).code;
  const errno = typeof code === "string" ? code : "";

  if (errno === "ENOENT") {
    return new BabelError("the file is not where it was", {
      code: "SOURCE_MISSING", fault: "input", detail, cause: error,
    });
  }

  const configured = CONFIG[errno];
  if (configured !== undefined) {
    return new BabelError("the machine would not let us write", {
      code: configured, fault: "config", detail: { ...detail, errno }, cause: error,
    });
  }

  // SQLite says this in words rather than in an errno, and it is the one
  // database failure that passes on its own.
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && /database is locked|database is busy/i.test(message)) {
    return new BabelError("the database was busy", {
      code: "DATABASE_BUSY", fault: "transient", detail, cause: error,
    });
  }

  return new BabelError("something failed in a way nobody has named", {
    code: "UNKNOWN", fault: "defect", detail, cause: error,
  });
}
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run app/test/failure.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/main/failure.ts app/test/failure.test.ts
git commit -m "feat(main): un errore di sistema prende un nome e una classe"
```

---

## Task 5: `countingBackend` smette di spegnere il contratto a schema

Difetto 2A della spec. È indipendente da tutto il resto e vale da solo.

**Files:**
- Modify: `core/translate/usage.ts:20-32`
- Test: `core/test/usage.test.ts`

**Interfaces:**
- Produces: `countingBackend` che inoltra `structured`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in fondo a `core/test/usage.test.ts`, dentro `describe("the counting backend", …)`:

```ts
  /**
   * A decorator that drops `structured` does not merely lose a property: it
   * silently changes the contract the whole run translates under. This one is
   * mounted in `runProject` around the backend every phase shares, so for as
   * long as it dropped the flag no run anywhere used the schema contract —
   * not even the models that support it, and not even when the flag had
   * already gone into the cache key.
   */
  it("keeps the answer's shape imposable", async () => {
    const structured = countingBackend({ ...backend(0), structured: true }, () => {});
    expect(structured.structured).toBe(true);

    const plain = countingBackend(backend(0), () => {});
    expect(plain.structured).toBeUndefined();
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/usage.test.ts`
Expected: FAIL — `expected undefined to be true`

- [ ] **Step 3: Inoltra la proprietà**

In `core/translate/usage.ts`, sostituisci il corpo di ritorno di `countingBackend`:

```ts
  return {
    // Forwarded, not re-declared. This decorator is mounted around the backend
    // every phase shares, so a flag dropped here is a contract changed for the
    // whole run — and changed invisibly, because the text contract answers
    // too, just worse.
    ...(inner.structured === undefined ? {} : { structured: inner.structured }),

    async call(input) {
      const result = await inner.call(input);
      total.tokensIn += result.tokensIn;
      total.tokensOut += result.tokensOut;
      total.reasoningTokens += result.reasoningTokens;
      onUsage({ ...total });
      return result;
    },
  };
```

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run core/test/usage.test.ts && npm test -w core`
Expected: PASS. Verifica anche `npx vitest run app/test/orchestrator.test.ts`: un test che asseriva il contratto testuale su un backend `structured` ora vede quello a schema, ed è la correzione, non una regressione — aggiornalo.

- [ ] **Step 5: Commit**

```bash
git add core/translate/usage.ts core/test/usage.test.ts
git commit -m "fix(core): il conteggio spegneva il contratto a schema di ogni corsa"
```

---

## Task 6: Un errore ferma davvero tutti i lavoratori

Difetto 2B della spec: lo «stato non definito».

**Files:**
- Modify: `core/translate/engine.ts:200-212`
- Test: `core/test/engine.test.ts`

**Interfaces:**
- Produces: `inParallel` invariato nella firma; cambia solo il comportamento all'errore.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi a `core/test/engine.test.ts` un blocco nuovo. `inParallel` non è esportata, quindi si prova attraverso `translateUnits`, che è il modo in cui il difetto si manifesta davvero:

```ts
import { translateUnits } from "../translate/engine.ts";

/**
 * The failure that used to leave the run in a state nobody could describe.
 *
 * `Promise.all` rejects on the first throw, but the workers behind it keep
 * taking chunks off the queue. What they wrote landed after the run had been
 * declared failed: translations for a run that was over, tokens after the last
 * usage message, a `run_event` on a closed run. Whoever pressed resume then
 * started from a state that was still moving.
 */
describe("a run whose backend fails", () => {
  it("stops every worker, and writes nothing after the failure", async () => {
    const units = Array.from({ length: 40 }, (_, at) => ({
      id: `u${at}`, doc: "c1.xhtml", ordinal: at, state: "translate" as const,
      source: `sentence number ${at}`, raw: `<p>sentence number ${at}</p>`,
    }));

    let calls = 0;
    const backend = {
      call: async () => {
        calls++;
        if (calls === 2) throw new Error("the provider went away");
        await new Promise((resume) => setTimeout(resume, 5));
        return {
          text: "", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
        };
      },
    };

    const written: string[] = [];
    const store = fakeStore({ onPutTranslation: (unitId: string) => written.push(unitId) });

    await expect(translateUnits({
      units, store, backend, concurrency: 4,
      progress: { report: () => {} },
      cacheKey: "k", sourceLanguage: "en", targetLanguage: "it",
    })).rejects.toThrow("the provider went away");

    const afterTheThrow = written.length;
    await new Promise((resume) => setTimeout(resume, 60));
    expect(written.length).toBe(afterTheThrow);
  });
});
```

> `fakeStore` è il doppio già presente in `core/test/fake/store.ts`. Se non
> accetta ancora `onPutTranslation`, aggiungi il gancio lì: è un doppio di
> test, non codice di produzione, e serve a osservare le scritture.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/engine.test.ts -t "stops every worker"`
Expected: FAIL — `written.length` cresce dopo il rilancio.

- [ ] **Step 3: Correggi `inParallel`**

In `core/translate/engine.ts`, sostituisci `inParallel`:

```ts
/**
 * Runs `worker` over `items`, `limit` at a time, in order — and stops when one
 * of them fails.
 *
 * `Promise.all` alone rejects on the first throw and leaves the other workers
 * running: they keep taking chunks off the queue and keep writing, on a run
 * the caller has already declared over. `allSettled` is what makes the
 * rejection mean the work has actually stopped, and the shared controller is
 * what makes it stop soon rather than at the end of the queue.
 */
async function inParallel<T>(
  items: T[],
  limit: number,
  worker: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const stop = new AbortController();
  const failures: unknown[] = [];

  const running = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (stop.signal.aborted) return;
        try {
          await worker(next, stop.signal);
        } catch (error) {
          failures.push(error);
          stop.abort();
          return;
        }
      }
    },
  );

  await Promise.allSettled(running);

  // A cancellation is what the other workers report once the first failure has
  // aborted them; the first real failure is the one worth telling.
  const real = failures.find((error) => (error as { name?: string }).name !== "AbortError");
  if (real !== undefined) throw real;
  if (failures.length > 0) throw failures[0];
}
```

- [ ] **Step 4: Collega il segnale al lavoratore**

In `translateUnits`, la chiamata a `inParallel` passa il segnale al chunk, unito a quello che il chiamante può già avere:

```ts
  await inParallel(chunks, input.concurrency ?? 2, async (chunk, stopping) => {
    const signal = input.signal === undefined
      ? stopping
      : AbortSignal.any([input.signal, stopping]);

    const outcome = await translateChunk({ chunk, terms, backend: input.backend, signal });
```

Il resto del corpo resta identico. `AbortSignal.any` è in Node dalla 20 ed è disponibile su 24.

- [ ] **Step 5: Esegui i test**

Run: `npx vitest run core/test/engine.test.ts && npm test -w core`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add core/translate/engine.ts core/test/engine.test.ts core/test/fake/store.ts
git commit -m "fix(core): un errore fermava un lavoratore e lasciava correre gli altri"
```

---

## Task 7: La porta del log

**Files:**
- Modify: `core/ports.ts`
- Test: `core/test/ports.test.ts`

**Interfaces:**
- Produces: `LogLevel`, `LogRecord`, `LogSink`, `nullSink: LogSink`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi a `core/test/ports.test.ts`:

```ts
import { nullSink, type LogRecord, type LogSink } from "../ports.ts";

describe("the log sink", () => {
  /**
   * The default has to be silent and total: every phase takes one optionally,
   * and a default that threw would turn a missing wire into a failed run.
   */
  it("has a mute default that swallows anything", () => {
    expect(() => nullSink.record({ level: "debug", code: "x" })).not.toThrow();
  });

  it("hands the record through as it was written", () => {
    const seen: LogRecord[] = [];
    const sink: LogSink = { record: (entry) => seen.push(entry) };
    sink.record({ level: "warn", code: "provider-retry", detail: { attempt: 2 } });
    expect(seen).toEqual([{ level: "warn", code: "provider-retry", detail: { attempt: 2 } }]);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/ports.test.ts`
Expected: FAIL — `nullSink` non è esportato.

- [ ] **Step 3: Aggiungi la porta a `core/ports.ts`**

In fondo al file, accanto a `ProgressSink`:

```ts
/**
 * How loud a line is, and by consequence where it goes.
 *
 * One axis, not two. `debug` goes to the diagnostic file only; `info`, `warn`
 * and `error` go there and to the reader's log as well. A second field saying
 * "this one is public" would be the same decision written twice.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Something that happened, in the same stable vocabulary as `RunEvent`.
 *
 * `code` is machine-readable and the interface composes the sentence from it,
 * in its own language — the rule the whole core follows. `detail` is scalars
 * only, and is an allow-list for the same reason `BabelError.detail` is: a
 * provider's error holds the request it failed on, key included.
 */
export interface LogRecord {
  level: LogLevel;
  code: string;
  detail?: Record<string, string | number | boolean>;
}

/**
 * The narrative of a run, beside `ProjectStore.event`, which is its verdicts.
 *
 * They are not the same thing and are deliberately not merged: a `degradation`
 * lowers a book to `incomplete` and belongs to the report; a log line says
 * what happened and belongs to the story. Both end up in `run_event`, and the
 * severity column tells them apart.
 */
export interface LogSink {
  record(entry: LogRecord): void;
}

/**
 * The default every phase gets when nobody wired one.
 *
 * Silent and total on purpose: a sink is an observation, and an observation
 * that can fail a run is worse than no observation.
 */
export const nullSink: LogSink = { record: () => {} };
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run core/test/ports.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add core/ports.ts core/test/ports.test.ts
git commit -m "feat(core): una porta per la cronaca, accanto a quella del progresso"
```

---

## Task 8: Il decoratore che ritenta

**Files:**
- Create: `core/translate/retry.ts`
- Test: `core/test/retry.test.ts`

**Interfaces:**
- Consumes: `LlmBackend` (`core/ports.ts`), `BabelError`, `RETRIES_ON` (`core/errors.ts`), `LogSink`, `nullSink` (Task 7).
- Produces: `RetryPolicy`, `DEFAULT_POLICY`, `SLOW_CALL_MS`, `retryingBackend(inner, deps): LlmBackend`.

- [ ] **Step 1: Scrivi il test che fallisce**

`core/test/retry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { BabelError } from "../errors.ts";
import type { LlmBackend, LogRecord } from "../ports.ts";
import { retryingBackend, type RetryPolicy } from "../translate/retry.ts";

const answer = {
  text: "ok", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
};

/** A backend that throws the given things in order, then answers. */
function flaky(...throws: unknown[]): LlmBackend & { calls: number } {
  let at = 0;
  const backend = {
    calls: 0,
    async call() {
      backend.calls++;
      const next = throws[at++];
      if (next !== undefined) throw next;
      return answer;
    },
  };
  return backend;
}

function harness(inner: LlmBackend, policy?: Partial<RetryPolicy>) {
  const waits: number[] = [];
  const logged: LogRecord[] = [];
  const wrapped = retryingBackend(inner, {
    classify: (error) => error as BabelError,
    log: { record: (entry) => logged.push(entry) },
    sleep: async (ms) => { waits.push(ms); },
    ...(policy === undefined ? {} : { policy }),
  });
  return { wrapped, waits, logged };
}

const transient = () => new BabelError("gone", { code: "PROVIDER_UNREACHABLE", fault: "transient" });

describe("the retrying backend", () => {
  it("answers without waiting when nothing went wrong", async () => {
    const { wrapped, waits } = harness(flaky());
    expect((await wrapped.call({ prompt: "one" })).text).toBe("ok");
    expect(waits).toEqual([]);
  });

  it("retries a transient failure and reports the answer that came", async () => {
    const inner = flaky(transient(), transient());
    const { wrapped, waits } = harness(inner);

    expect((await wrapped.call({ prompt: "one" })).text).toBe("ok");
    expect(inner.calls).toBe(3);
    expect(waits.length).toBe(2);
  });

  /** Exponential, and each wait strictly longer than the one before it. */
  it("backs off exponentially, under the ceiling", async () => {
    const inner = flaky(...Array.from({ length: 4 }, transient));
    const { wrapped, waits } = harness(inner, { baseMs: 1000, maxMs: 4000, maxAttempts: 5 });

    await wrapped.call({ prompt: "one" });
    expect(waits.length).toBe(4);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(2000);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    for (const wait of waits) expect(wait).toBeLessThanOrEqual(4000);
  });

  /** When the provider named an hour, we do not guess a different one. */
  it("waits exactly as long as the provider asked", async () => {
    const throttled = new BabelError("slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", retryAfterMs: 7000,
    });
    const { wrapped, waits } = harness(flaky(throttled));

    await wrapped.call({ prompt: "one" });
    expect(waits).toEqual([7000]);
  });

  it("does not let the provider's hour exceed the ceiling", async () => {
    const throttled = new BabelError("slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled", retryAfterMs: 900_000,
    });
    const { wrapped, waits } = harness(flaky(throttled), { maxMs: 60_000 });

    await wrapped.call({ prompt: "one" });
    expect(waits).toEqual([60_000]);
  });

  it("gives up after the budget, and throws the last classified failure", async () => {
    const inner = flaky(...Array.from({ length: 9 }, transient));
    const { wrapped } = harness(inner, { maxAttempts: 5 });

    await expect(wrapped.call({ prompt: "one" })).rejects.toMatchObject({
      code: "PROVIDER_UNREACHABLE", fault: "transient",
    });
    expect(inner.calls).toBe(5);
  });

  it.each([
    ["config", "PROVIDER_UNAUTHORIZED"],
    ["exhausted", "PROVIDER_OUT_OF_CREDIT"],
    ["defect", "PROVIDER_UNKNOWN"],
  ])("does not retry a %s failure", async (fault, code) => {
    const inner = flaky(new BabelError("no", { code, fault: fault as never }));
    const { wrapped, waits } = harness(inner);

    await expect(wrapped.call({ prompt: "one" })).rejects.toMatchObject({ code });
    expect(inner.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  /**
   * A pause must not wait out sixty seconds to be felt. The signal is read
   * before the call and again during the wait.
   */
  it("stops waiting the moment the run is stopped", async () => {
    const stop = new AbortController();
    const inner = flaky(...Array.from({ length: 4 }, transient));
    const wrapped = retryingBackend(inner, {
      classify: (error) => error as BabelError,
      log: { record: () => {} },
      sleep: async (_ms, signal) => {
        stop.abort();
        signal?.throwIfAborted();
      },
    });

    await expect(wrapped.call({ prompt: "one", signal: stop.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(inner.calls).toBe(1);
  });

  it("refuses to start once the run is stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const inner = flaky();
    const { wrapped } = harness(inner);

    await expect(wrapped.call({ prompt: "one", signal: stop.signal })).rejects.toThrow();
    expect(inner.calls).toBe(0);
  });

  /** The line the Registro was missing: that we are retrying, and why. */
  it("says it is retrying, and says when it stopped having to", async () => {
    const { wrapped, logged } = harness(flaky(transient(), transient()));
    await wrapped.call({ prompt: "one" });

    const retries = logged.filter((entry) => entry.code === "provider-retry");
    expect(retries.length).toBe(2);
    expect(retries[0]!.level).toBe("warn");
    expect(retries[0]!.detail).toMatchObject({
      attempt: 1, max: 5, reason: "PROVIDER_UNREACHABLE",
    });
    expect(typeof retries[0]!.detail!["waitMs"]).toBe("number");

    const recovered = logged.filter((entry) => entry.code === "provider-recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0]!.detail).toMatchObject({ attempts: 3 });
  });

  it("says nothing about recovery when nothing went wrong", async () => {
    const { wrapped, logged } = harness(flaky());
    await wrapped.call({ prompt: "one" });
    expect(logged.filter((entry) => entry.code === "provider-recovered")).toEqual([]);
  });

  /** Not broken, only slow — which is the case nobody could see before. */
  it("says when a call took longer than the slow mark", async () => {
    vi.useFakeTimers();
    try {
      const logged: LogRecord[] = [];
      const wrapped = retryingBackend({
        call: async () => { vi.advanceTimersByTime(45_000); return answer; },
      }, {
        classify: (error) => error as BabelError,
        log: { record: (entry) => logged.push(entry) },
        sleep: async () => {},
      });

      await wrapped.call({ prompt: "one" });
      const slow = logged.find((entry) => entry.code === "provider-slow");
      expect(slow?.level).toBe("info");
      expect(slow?.detail).toMatchObject({ elapsedMs: 45_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same trap `countingBackend` fell into: a decorator that drops this
   * changes the contract the whole run translates under, invisibly.
   */
  it("keeps the answer's shape imposable", () => {
    const { wrapped } = harness({ call: async () => answer, structured: true });
    expect(wrapped.structured).toBe(true);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run core/test/retry.test.ts`
Expected: FAIL — `Cannot find module '../translate/retry.ts'`

- [ ] **Step 3: Scrivi `core/translate/retry.ts`**

```ts
import { RETRIES_ON, type BabelError } from "../errors.ts";
import { nullSink, type LlmBackend, type LlmCall, type LlmResult, type LogSink } from "../ports.ts";

/**
 * How many times a call that never produced an answer may be asked again.
 *
 * This is not the engine's retry and does not multiply with it. The engine's
 * three attempts count answers *rejected by validation*; these count calls
 * that produced no answer at all. `sdk.ts` forbids a retry hidden under the
 * engine because it would multiply with that budget invisibly — here the
 * product is stated: 3 × 5 = 15 calls per chunk, worst case, and a number that
 * can be said in advance is the thing that prohibition protected.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 1_000,
  maxMs: 60_000,
};

/** Above this, a call is worth mentioning even though nothing went wrong. */
export const SLOW_CALL_MS = 30_000;

export interface RetryDeps {
  /**
   * Whatever was thrown, as one of ours.
   *
   * Injected because the core does not know what a 429 is, and if it did it
   * would stop being the core. The engine passes `classifyProviderError`.
   */
  classify(error: unknown): BabelError;
  log?: LogSink;
  /** Injected so the tests do not actually wait five minutes. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  policy?: Partial<RetryPolicy>;
}

/** Exponential, with jitter so a hundred chunks do not all come back at once. */
function backoffFor(attempt: number, policy: RetryPolicy): number {
  const flat = Math.min(policy.baseMs * 2 ** (attempt - 1), policy.maxMs);
  return Math.min(policy.maxMs, Math.round(flat * (1 + Math.random() * 0.5)));
}

/**
 * A backend that asks again when nothing came back.
 *
 * A decorator rather than a parameter on each phase, and for the same reason
 * `countingBackend` is one: mounted once around the backend every phase
 * shares, it does not have to be remembered again. Before it existed, a single
 * 429 halfway through a book ended the whole run — `sdkBackend` does no retry
 * by design, and the engine's own attempts only ever counted answers it had
 * received and rejected.
 */
export function retryingBackend(inner: LlmBackend, deps: RetryDeps): LlmBackend {
  const policy: RetryPolicy = { ...DEFAULT_POLICY, ...deps.policy };
  const log = deps.log ?? nullSink;

  return {
    // Forwarded for the same reason `countingBackend` must forward it: this is
    // mounted around the backend the whole run shares.
    ...(inner.structured === undefined ? {} : { structured: inner.structured }),

    async call(input: LlmCall): Promise<LlmResult> {
      let attempt = 0;

      for (;;) {
        input.signal?.throwIfAborted();
        attempt++;

        const began = Date.now();
        try {
          const result = await inner.call(input);

          const elapsedMs = Date.now() - began;
          if (elapsedMs >= SLOW_CALL_MS) {
            log.record({ level: "info", code: "provider-slow", detail: { elapsedMs } });
          }
          // Said once, and only when there was something to recover from:
          // otherwise the story of a retry is left hanging on the last "we
          // are trying again", which reads like it never came back.
          if (attempt > 1) {
            log.record({ level: "info", code: "provider-recovered", detail: { attempts: attempt } });
          }
          return result;
        } catch (error) {
          const classified = deps.classify(error);

          // A cancellation is the person's own hand and is never retried: it
          // travels this `catch` only because a pause and a failure share it.
          if (classified.fault === "cancelled") throw error;
          if (!RETRIES_ON[classified.fault] || attempt >= policy.maxAttempts) throw classified;

          const waitMs = classified.retryAfterMs === undefined
            ? backoffFor(attempt, policy)
            // Honoured rather than guessed at, but never beyond the ceiling: a
            // provider that answers "come back in an hour" must not hold a run
            // open for an hour.
            : Math.min(classified.retryAfterMs, policy.maxMs);

          log.record({
            level: "warn",
            code: "provider-retry",
            detail: {
              attempt, max: policy.maxAttempts, waitMs, reason: classified.code,
              fault: classified.fault,
            },
          });

          await deps.sleep(waitMs, input.signal);
        }
      }
    },
  };
}
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run core/test/retry.test.ts && npm test -w core`
Expected: PASS, tutti.

- [ ] **Step 5: Commit**

```bash
git add core/translate/retry.ts core/test/retry.test.ts
git commit -m "feat(core): una chiamata che non ha risposto viene richiesta"
```

---

## Task 9: Il file diagnostico

**Files:**
- Create: `app/main/run/diagnostics.ts`
- Test: `app/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `LogRecord`, `LogSink` (Task 7).
- Produces:
  - `diagnosticsDir(workspaceRoot: string): string`
  - `fileSink(input: { dir: string; process: "main" | "engine"; runId: string; projectId: string; phase?: () => string | null }): LogSink & { close(): void }`
  - `readDiagnostics(dir: string, runId: string, limit?: number): Promise<{ lines: string[]; path: string }>`
  - `pruneDiagnostics(dir: string, keep?: number): Promise<void>`
  - `appSink(userDataDir: string): LogSink`

- [ ] **Step 1: Scrivi il test che fallisce**

`app/test/diagnostics.test.ts`:

```ts
import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appSink, diagnosticsDir, fileSink, pruneDiagnostics, readDiagnostics,
} from "../main/run/diagnostics.ts";

const workspace = () => mkdtemp(join(tmpdir(), "babelbook-diag-"));

describe("the diagnostic file", () => {
  it("writes one JSON object per line, with the run's own facts", async () => {
    const dir = diagnosticsDir(await workspace());
    const sink = fileSink({ dir, process: "engine", runId: "r1", projectId: "p1", phase: () => "translate" });

    sink.record({ level: "warn", code: "provider-retry", detail: { attempt: 2, waitMs: 4000 } });
    sink.record({ level: "debug", code: "call-finished", detail: { tokensOut: 120 } });
    sink.close();

    const written = await readFile(join(dir, "run-r1.engine.ndjson"), "utf8");
    const lines = written.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: "warn", code: "provider-retry", process: "engine",
      runId: "r1", projectId: "p1", phase: "translate", attempt: 2, waitMs: 4000,
    });
    expect(typeof lines[0].at).toBe("string");
  });

  /**
   * Two processes, two files, one story: the same merge `runLog` already does
   * with its two sources, for the same reason — neither can be told to wait
   * for the other, and a timestamp is the only order both agree on.
   */
  it("reads the two processes back as one sequence", async () => {
    const dir = diagnosticsDir(await workspace());
    await writeFile(join(dir, "run-r1.engine.ndjson"),
      `{"at":"2026-09-01T10:00:02.000Z","code":"b"}\n{"at":"2026-09-01T10:00:04.000Z","code":"d"}\n`);
    await writeFile(join(dir, "run-r1.main.ndjson"),
      `{"at":"2026-09-01T10:00:01.000Z","code":"a"}\n{"at":"2026-09-01T10:00:03.000Z","code":"c"}\n`);

    const { lines } = await readDiagnostics(dir, "r1");
    expect(lines.map((line) => JSON.parse(line).code)).toEqual(["a", "b", "c", "d"]);
  });

  it("answers with the last lines when there are more than asked for", async () => {
    const dir = diagnosticsDir(await workspace());
    const sink = fileSink({ dir, process: "main", runId: "r1", projectId: "p1" });
    for (let at = 0; at < 50; at++) sink.record({ level: "debug", code: `n${at}` });
    sink.close();

    const { lines } = await readDiagnostics(dir, "r1", 10);
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[9]!).code).toBe("n49");
  });

  it("answers with nothing rather than throwing when no run wrote anything", async () => {
    const dir = diagnosticsDir(await workspace());
    const { lines, path } = await readDiagnostics(dir, "never-ran");
    expect(lines).toEqual([]);
    expect(path).toBe(dir);
  });

  it("keeps the last five runs and forgets the rest", async () => {
    const dir = diagnosticsDir(await workspace());
    for (const runId of ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]) {
      const sink = fileSink({ dir, process: "main", runId, projectId: "p1" });
      sink.record({ level: "info", code: "x" });
      sink.close();
      await new Promise((resume) => setTimeout(resume, 5));
    }

    await pruneDiagnostics(dir, 5);

    expect((await readDiagnostics(dir, "r1")).lines).toEqual([]);
    expect((await readDiagnostics(dir, "r2")).lines).toEqual([]);
    expect((await readDiagnostics(dir, "r7")).lines).toHaveLength(1);
  });

  /** A sink that can fail a run is worse than a sink nobody reads. */
  /**
   * Verifying a provider, refreshing the catalogue, opening the database at
   * start-up: none of them has a run, and `run_event` demands one. They go to
   * one application-wide file instead, and to no Registro — a Registro belongs
   * to a book, and none of those belongs to any book.
   */
  it("writes what happens outside a run to one application file", async () => {
    const userData = await workspace();
    const sink = appSink(userData);
    sink.record({ level: "error", code: "PROVIDER_UNAUTHORIZED", detail: { screen: "providers" } });

    const written = await readFile(join(userData, "logs", "app.ndjson"), "utf8");
    expect(JSON.parse(written.trim())).toMatchObject({
      level: "error", code: "PROVIDER_UNAUTHORIZED", screen: "providers", process: "main",
    });
  });

  it("rotates the application file once it grows past its bound", async () => {
    const userData = await workspace();
    const sink = appSink(userData);
    const wide = "x".repeat(4096);
    for (let at = 0; at < 700; at++) sink.record({ level: "info", code: "n", detail: { wide } });

    const dir = join(userData, "logs");
    expect(await readdir(dir)).toEqual(expect.arrayContaining(["app.ndjson", "app.1.ndjson"]));
    expect((await stat(join(dir, "app.ndjson"))).size).toBeLessThan(2 * 1024 * 1024);
  });

  it("swallows a directory it cannot write to", async () => {
    const sink = fileSink({
      dir: "/proc/nowhere/babelbook", process: "main", runId: "r1", projectId: "p1",
    });
    expect(() => sink.record({ level: "error", code: "x" })).not.toThrow();
    expect(() => sink.close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/diagnostics.test.ts`
Expected: FAIL — `Cannot find module '../main/run/diagnostics.ts'`

- [ ] **Step 3: Scrivi `app/main/run/diagnostics.ts`**

```ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LogRecord, LogSink } from "../../../core/ports.ts";

/**
 * The whole story of a run, on disk, in the language nobody has to translate.
 *
 * The reader's Registro is curated: it holds what a person translating a book
 * needs to know. This holds everything, so that the run that went wrong can be
 * understood afterwards rather than reproduced. `debug` exists only here.
 *
 * Two processes write, so two files: the engine cannot be told to wait for the
 * main process and interleaved appends from two writers are not guaranteed to
 * stay whole. They are merged when read, by timestamp — which is the same
 * merge `runLog` already does with its own two sources.
 */

const RUN_FILE = /^run-(.+)\.(main|engine)\.ndjson$/;
const DEFAULT_LIMIT = 2000;
const DEFAULT_KEEP = 5;

export function diagnosticsDir(workspaceRoot: string): string {
  const dir = join(workspaceRoot, "logs");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Reported by the sink's own silence, not by throwing here: a diagnostic
    // that can stop a run is worse than one nobody reads.
  }
  return dir;
}

export interface FileSinkInput {
  dir: string;
  process: "main" | "engine";
  runId: string;
  projectId: string;
  /** Read at write time, because a run walks through several. */
  phase?: () => string | null;
}

/**
 * A sink that appends, synchronously and without a queue.
 *
 * Synchronous on purpose: the engine process can be killed at the end of a
 * run, and a buffered writer would lose exactly the last lines — the ones
 * that say why it ended.
 */
export function fileSink(input: FileSinkInput): LogSink & { close(): void } {
  const path = join(input.dir, `run-${input.runId}.${input.process}.ndjson`);
  let broken = false;

  return {
    record(entry: LogRecord): void {
      if (broken) return;
      try {
        const phase = input.phase?.() ?? null;
        appendFileSync(path, `${JSON.stringify({
          at: new Date().toISOString(),
          level: entry.level,
          code: entry.code,
          process: input.process,
          projectId: input.projectId,
          runId: input.runId,
          ...(phase === null ? {} : { phase }),
          ...entry.detail,
        })}\n`, "utf8");
      } catch {
        // Once is enough to know the directory is not writable; trying on
        // every line would turn one broken path into thousands of syscalls.
        broken = true;
      }
    },

    close(): void {
      broken = true;
    },
  };
}

/** The two files of one run, as one sequence, tail first trimmed to `limit`. */
export async function readDiagnostics(
  dir: string,
  runId: string,
  limit = DEFAULT_LIMIT,
): Promise<{ lines: string[]; path: string }> {
  const lines: Array<{ at: string; raw: string }> = [];

  for (const process of ["main", "engine"] as const) {
    let content: string;
    try {
      content = await readFile(join(dir, `run-${runId}.${process}.ndjson`), "utf8");
    } catch {
      continue;
    }
    for (const raw of content.split("\n")) {
      if (raw.trim() === "") continue;
      let at = "";
      try {
        at = String((JSON.parse(raw) as { at?: unknown }).at ?? "");
      } catch {
        // A half-written last line is still worth showing; it sorts first,
        // which is where an unreadable line does least harm.
      }
      lines.push({ at, raw });
    }
  }

  lines.sort((one, other) => one.at.localeCompare(other.at));
  return { lines: lines.slice(-limit).map((line) => line.raw), path: dir };
}

/** Past this the application file is rolled over; one spare is kept. */
const APP_LOG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The one file for what happens outside any run.
 *
 * Verifying a provider, refreshing the catalogue, opening the database: none
 * of them has a `runId` or a workspace, and `run_event` demands both. None of
 * them belongs to a book either, so none of them reaches a Registro — the
 * screen that failed says so itself, with `tell()`. This is only for
 * afterwards.
 */
export function appSink(userDataDir: string): LogSink {
  const dir = join(userDataDir, "logs");
  const path = join(dir, "app.ndjson");
  let broken = false;

  return {
    record(entry: LogRecord): void {
      if (broken) return;
      try {
        mkdirSync(dir, { recursive: true });
        // Rolled by size rather than by date: this file has no run to belong
        // to, so nothing else bounds it.
        try {
          if (statSync(path).size >= APP_LOG_MAX_BYTES) renameSync(path, join(dir, "app.1.ndjson"));
        } catch {
          // No file yet, which is the ordinary case on the first line.
        }
        appendFileSync(path, `${JSON.stringify({
          at: new Date().toISOString(),
          level: entry.level,
          code: entry.code,
          process: "main",
          ...entry.detail,
        })}\n`, "utf8");
      } catch {
        broken = true;
      }
    },
  };
}

/** Keeps the newest `keep` runs. Called when a run starts, not when it ends. */
export async function pruneDiagnostics(dir: string, keep = DEFAULT_KEEP): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  const newest = new Map<string, number>();
  for (const name of names) {
    const match = RUN_FILE.exec(name);
    if (match === null) continue;
    try {
      const when = (await stat(join(dir, name))).mtimeMs;
      newest.set(match[1]!, Math.max(newest.get(match[1]!) ?? 0, when));
    } catch {
      continue;
    }
  }

  const doomed = [...newest.entries()]
    .sort((one, other) => other[1] - one[1])
    .slice(keep)
    .map(([runId]) => runId);

  for (const runId of doomed) {
    for (const process of ["main", "engine"] as const) {
      await rm(join(dir, `run-${runId}.${process}.ndjson`), { force: true });
    }
  }
}
```

- [ ] **Step 4: Esegui il test**

Run: `npx vitest run app/test/diagnostics.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/main/run/diagnostics.ts app/test/diagnostics.test.ts
git commit -m "feat(run): ogni corsa lascia il proprio diario diagnostico"
```

---

## Task 10: Il montaggio — ritentativo e cronaca dentro la corsa

**Files:**
- Modify: `app/main/run/orchestrator.ts:80-95`, `app/engine/main.ts`, `app/shared/run.ts`
- Modify: `core/translate/engine.ts` (il sink dentro `translateChunk` e `translateUnits`)
- Test: `app/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: `retryingBackend` (Task 8), `classifyProviderError` (Task 3), `LogSink` (Task 7), `fileSink`/`diagnosticsDir` (Task 9).
- Produces: `RunProjectDeps` con `log?: LogSink`; `EngineRunnerInput` con `workspaceRoot: string` e `runId: string`; `RunInput`/`ChunkInput` con `log?: LogSink`.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi a `app/test/orchestrator.test.ts`:

```ts
import { BabelError } from "../../core/errors.ts";
import type { LogRecord } from "../../core/ports.ts";

/**
 * Mounted once, around the backend every phase shares — the same argument that
 * put `countingBackend` there. A retry wired into the translation alone would
 * leave `candidates` and `code-index` dying on the first 429, and those are
 * the two phases that run before a single line is translated.
 */
describe("a run whose provider stumbles", () => {
  it("retries in every phase, not only in the translation", async () => {
    const logged: LogRecord[] = [];
    let calls = 0;
    const backend = {
      call: async () => {
        calls++;
        if (calls === 1) {
          throw new BabelError("gone", { code: "PROVIDER_UNREACHABLE", fault: "transient" });
        }
        return {
          text: "", tokensIn: 1, tokensOut: 1, reasoningTokens: 0, finishReason: "stop" as const,
        };
      },
    };

    await runProject({
      store: fakeStore(),
      backend,
      config: baseConfig(),
      emit: () => {},
      signal: new AbortController().signal,
      log: { record: (entry) => logged.push(entry) },
      sleep: async () => {},
    });

    expect(logged.filter((entry) => entry.code === "provider-retry")).toHaveLength(1);
  });
});
```

> `fakeStore()` e `baseConfig()` sono gli aiutanti già presenti nel file. Se
> `baseConfig()` non esiste, riusa l'oggetto `RunConfig` che gli altri test del
> file costruiscono.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/orchestrator.test.ts -t "retries in every phase"`
Expected: FAIL — `runProject` non accetta `log` né `sleep`, e il ritentativo non esiste.

- [ ] **Step 3: Monta i due decoratori in `runProject`**

In `app/main/run/orchestrator.ts`, aggiungi gli import e i due campi a `RunProjectDeps`:

```ts
import { nullSink, type LogSink } from "../../../core/ports.ts";
import { retryingBackend } from "../../../core/translate/retry.ts";
import { classifyProviderError } from "../../engine/backends/classify.ts";

export interface RunProjectDeps {
  store: ProjectStore;
  backend: LlmBackend;
  config: RunConfig;
  machineSnapshot?: unknown;
  emit(message: EngineMessage): void;
  signal: AbortSignal;
  /** The run's chronicle. Silent by default: an observation must not fail a run. */
  log?: LogSink;
  /** Injected so the tests do not wait out a real backoff. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
```

Poi sostituisci il montaggio (riga 87) con:

```ts
  const log = deps.log ?? nullSink;
  // A wait that a pause can cut short. Without the listener, stopping a run
  // during a sixty-second backoff would take sixty seconds to be felt.
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resume, refuse) => {
    const stop = (): void => {
      clearTimeout(timer);
      refuse(signal?.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resume();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  }));

  const spent: Usage = { tokensIn: 0, tokensOut: 0, reasoningTokens: 0 };
  // Counting innermost, retrying outermost: the counter must see the calls the
  // provider actually answered, and the three phases that speak to a model
  // inherit the retry without any of them having to remember it.
  const backend = retryingBackend(
    countingBackend(deps.backend, (total) => {
      spent.tokensIn = total.tokensIn;
      spent.tokensOut = total.tokensOut;
      spent.reasoningTokens = total.reasoningTokens;
      emit({ type: "usage", ...total });
    }),
    { classify: classifyProviderError, log, sleep },
  );
```

Infine passa `log` alle tre fasi: aggiungi `log` all'oggetto passato a `extractCandidates`, a `indexCodeBlocks` e a `translateUnits`.

- [ ] **Step 4: Accetta il sink nel core**

In `core/translate/engine.ts`:

- aggiungi `log?: LogSink` a `ChunkInput` e a `RunInput`, importando `nullSink` e `LogSink` da `../ports.ts`;
- in `translateChunk`, dopo il calcolo di `validation`, registra ogni rifiuto:

```ts
    // Visible at the first rejection instead of at the third. The engine has
    // always built this diagnosis and only ever kept it for `unit-fell-back`,
    // which is to say for the moment when it is already too late.
    for (const rejection of validation.rejections) {
      log.record({
        level: "debug",
        code: "unit-rejected",
        detail: {
          attempt: attempts,
          ...(rejection.unitId === null ? {} : { unitId: rejection.unitId }),
          reason: rejection.code,
          finishReason: result.finishReason,
          reasoningTokens: result.reasoningTokens,
          excerpt: result.text.slice(0, EXCERPT_CHARS),
        },
      });
    }
```

con `const log = input.log ?? nullSink;` in cima alla funzione;

- in `translateUnits`, `const log = input.log ?? nullSink;` e passa `log` a `translateChunk`; quando un chunk finisce con delle unità cadute, aggiungi accanto allo `store.event` esistente:

```ts
      log.record({
        level: "warn",
        code: "chunk-failed",
        detail: { units: outcome.fellBack.length, attempts: outcome.attempts },
      });
```

posto **una volta per chunk**, fuori dal ciclo su `outcome.fellBack` e solo se `outcome.fellBack.length > 0`.

In `core/analyze/candidates.ts` e `core/analyze/code.ts`, aggiungi lo stesso
campo — `log?: LogSink`, `const log = input.log ?? nullSink;` — e registra ogni
lotto attorno alla chiamata al backend, con la stessa forma in entrambi:

```ts
    const began = Date.now();
    const result = await backend.call({ prompt, system });
    log.record({
      level: "debug",
      code: "batch-finished",
      detail: {
        phase: "code-index",              // "candidates" nell'altro file
        batch: at,
        of: batches.length,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        reasoningTokens: result.reasoningTokens,
        finishReason: result.finishReason,
        elapsedMs: Date.now() - began,
      },
    });
```

È la riga che risponde a «cosa sta succedendo in questa fase»: prima di questa,
il `code-index` di un libro vero faceva centinaia di chiamate in fila senza
dire niente a nessuno.

- [ ] **Step 5: Costruisci il sink nel processo motore**

In `app/shared/run.ts`, `EngineCommand.start` guadagna i due dati che il file richiede:

```ts
  | {
    type: "start";
    projectId: string;
    runId: string;
    workspaceRoot: string;
    config: RunConfig;
    backend: BackendSpec;
    machineSnapshot?: unknown;
  }
```

e `isEngineCommand` in `app/engine/main.ts` verifica `typeof command.runId === "string" && typeof command.workspaceRoot === "string"`.

In `app/engine/main.ts`, `EngineRunnerInput` guadagna `runId: string` e `workspaceRoot: string`, e `productionRunner` costruisce il sink:

```ts
const productionRunner: EngineRunner = async (input) => {
  const backend = await backendFromSpec(input.backendSpec);
  const sink = fileSink({
    dir: diagnosticsDir(input.workspaceRoot),
    process: "engine",
    runId: input.runId,
    projectId: input.projectId,
  });

  try {
    const summary = await runProject({
      store: input.store,
      backend,
      config: input.config,
      ...(input.machineSnapshot === undefined ? {} : { machineSnapshot: input.machineSnapshot }),
      emit: input.emit,
      signal: input.signal,
      log: sink,
    });
    input.emit({ type: "done", summary });
  } finally {
    sink.close();
  }
};
```

In `startEngineRuntime`, passa `runId` e `workspaceRoot` dal comando al runner.

In `app/main/run/runtime.ts`, `launch()` aggiunge i due campi al comando `start`, e chiama `void pruneDiagnostics(diagnosticsDir(row.workspace_path))` subito dopo aver inserito la riga `run`.

- [ ] **Step 6: Esegui i test**

Run: `npx vitest run app/test/orchestrator.test.ts && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add core/ app/main/run/orchestrator.ts app/engine/main.ts app/shared/run.ts app/main/run/runtime.ts app/test/orchestrator.test.ts
git commit -m "feat(run): il ritentativo e la cronaca valgono per tutte le fasi"
```

---

## Task 11: La classe arriva fino allo stato del progetto

**Files:**
- Modify: `core/workflow/project.machine.ts` (`PAUSE` con `reason`), `app/shared/run.ts` (`EngineMessage.failed`), `app/engine/main.ts:41` (`failureCode`)
- Test: `core/test/machine.test.ts`, `app/test/engine-host.test.ts`

**Interfaces:**
- Produces: `ProjectEvent` con `{ type: "PAUSE"; reason?: string }`; `EngineMessage` con `{ type: "failed"; code: string; fault: Fault; retryAfterMs?: number; detail?: Record<string, string | number | boolean> }`; `toEngineFailure(error: unknown): Extract<EngineMessage, { type: "failed" }>`.

- [ ] **Step 1: Scrivi i test che falliscono**

In `core/test/machine.test.ts`:

```ts
  /**
   * A pause the machine did not choose still deserves a reason. The reason
   * does not enter the context — `project_state.info` already keeps it, and
   * two places remembering one thing are two places that can disagree.
   */
  it("accepts a pause that says why", () => {
    const actor = createProjectActor({ hasLanguage: true }).start();
    actor.send({ type: "START" });
    actor.send({ type: "PAUSE", reason: "PROVIDER_OUT_OF_CREDIT" });
    expect(actor.getSnapshot().value).toBe("paused");
  });
```

In `app/test/engine-host.test.ts`:

```ts
import { BabelError } from "../../core/errors.ts";
import { toEngineFailure } from "../engine/main.ts";

describe("what the engine says when it dies", () => {
  it("carries the class, not only a word", () => {
    expect(toEngineFailure(new BabelError("slow down", {
      code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    }))).toEqual({
      type: "failed", code: "PROVIDER_RATE_LIMITED", fault: "throttled",
      detail: { status: 429 }, retryAfterMs: 4000,
    });
  });

  /**
   * The line this replaces read `error.code` — which SDK errors do not have,
   * so every failure in the history of this application arrived as
   * ENGINE_FAILED, and the window looked up a catalogue entry that was never
   * written and printed the bare word.
   */
  it("classifies an SDK error instead of calling everything ENGINE_FAILED", () => {
    const failure = toEngineFailure(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
    expect(failure.code).toBe("PROVIDER_UNREACHABLE");
    expect(failure.fault).toBe("transient");
  });

  it("calls what it cannot classify a defect", () => {
    expect(toEngineFailure(new Error("who knows")).fault).toBe("defect");
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run core/test/machine.test.ts app/test/engine-host.test.ts`
Expected: FAIL — `toEngineFailure` non esiste; l'evento `PAUSE` non accetta `reason`.

- [ ] **Step 3: La macchina**

In `core/workflow/project.machine.ts`, sostituisci nella union `ProjectEvent`:

```ts
  // The reason travels with the event and is written by the host into
  // `project_state.info`, beside the one a `FAIL` already writes. It stays out
  // of the context deliberately: the machine says what is lawful, not what
  // happened, and a second memory of one fact is a second thing to keep true.
  | { type: "PAUSE"; reason?: string }
```

Nessuna transizione cambia.

- [ ] **Step 4: Il messaggio del motore**

In `app/shared/run.ts`, importa `Fault` e sostituisci il ramo:

```ts
  | {
    type: "failed";
    code: string;
    /** What the main process reads to choose between `paused` and `failed`. */
    fault: Fault;
    detail?: Record<string, string | number | boolean>;
    retryAfterMs?: number;
  }
```

In `app/engine/main.ts`, sostituisci `failureCode` con:

```ts
/**
 * Whatever was thrown, as the message the main process can act on.
 *
 * What stood here read `error.code` and fell back to `ENGINE_FAILED`. SDK
 * errors have no `.code`, so the fallback was not a fallback: it was the
 * answer, every time, and with it went the status, the cause and the phase.
 */
export function toEngineFailure(error: unknown): Extract<EngineMessage, { type: "failed" }> {
  const classified = classifyProviderError(error);
  return {
    type: "failed",
    code: classified.code,
    fault: classified.fault,
    ...(Object.keys(classified.detail).length === 0 ? {} : { detail: classified.detail }),
    ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
  };
}
```

e nel `catch` di `startEngineRuntime`:

```ts
    }).catch((error) => {
      // An abort is the person's own hand, and stays swallowed here.
      if (!signal.aborted) port.postMessage(toEngineFailure(error) satisfies EngineMessage);
    });
```

L'errore ingoiato va scritto **dentro `productionRunner`**, che è l'unico posto
in cui il sink esiste: la chiusura di `startEngineRuntime` non ne ha uno, e
scriverlo lì significherebbe passarne uno per un solo caso. In
`productionRunner`, il corpo già avvolto dal `try/finally` del Task 10 guadagna
un `catch`:

```ts
  try {
    const summary = await runProject({ … });
    input.emit({ type: "done", summary });
  } catch (error) {
    // An error that merely raced an abort used to disappear without trace: the
    // outer catch swallows anything once the signal is aborted, which is right
    // for a pause and wrong for everything else that happened to arrive with
    // one.
    sink.record({
      level: input.signal.aborted ? "debug" : "error",
      code: "run-ended-badly",
      detail: {
        aborted: input.signal.aborted,
        message: String((error as { message?: unknown }).message ?? error),
      },
    });
    throw error;
  } finally {
    sink.close();
  }
```

Aggiorna anche i due `postMessage` letterali di `RUNNER_UNAVAILABLE` e `ENGINE_PORT_MISSING` con `fault: "defect"`.

- [ ] **Step 5: Esegui i test**

Run: `npx vitest run core/test/machine.test.ts app/test/engine-host.test.ts && npm run typecheck`
Expected: PASS. Il typecheck segnalerà `runtime.ts`, che il Task 12 sistema; per chiudere questo task aggiungi lì il minimo che compila (`message.fault` ignorato) e completalo subito dopo.

- [ ] **Step 6: Commit**

```bash
git add core/workflow/project.machine.ts app/shared/run.ts app/engine/main.ts core/test/machine.test.ts app/test/engine-host.test.ts
git commit -m "feat(engine): il motore dice di che classe è l'errore che lo ha fermato"
```

---

## Task 12: Il runtime sceglie la pausa o il fallimento

**Files:**
- Modify: `app/main/run/runtime.ts`
- Test: `app/test/run-runtime.test.ts`

**Interfaces:**
- Consumes: `PAUSES_ON` (Task 1), `EngineMessage.failed` arricchito (Task 11).
- Produces: nessuna interfaccia nuova; cambia il comportamento di `onEngineMessage`, `pause`, `onCrash`.

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/run-runtime.test.ts`:

```ts
describe("a run that stops", () => {
  /**
   * The cut the taxonomy exists for. Credit that ran out is not a rejected
   * book: resuming tomorrow finishes it, and the badge must not say
   * "Rifiutato" of a book nobody rejected.
   */
  it("pauses when resuming would fix it", async () => {
    const { runtime, db, feed } = harness();
    await runtime.start("p1");

    feed({ type: "failed", code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });

    expect(stateOf(db, "p1")).toBe("paused");
    const phase = lastPhase(db, "p1");
    expect(phase.outcome).toBe("paused");
    expect(phase.info).toMatchObject({ code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });
  });

  it("fails when resuming would not", async () => {
    const { runtime, db, feed } = harness();
    await runtime.start("p1");

    feed({ type: "failed", code: "GATE_REFUSED", fault: "refused" });

    expect(stateOf(db, "p1")).toBe("failed");
    expect(lastPhase(db, "p1").info).toMatchObject({ fault: "refused" });
  });

  /** Three variables that mean "who owns the engine" must go blank together. */
  it("lets go of the engine on every ending", async () => {
    const { runtime, feed } = harness();
    await runtime.start("p1");
    feed({ type: "failed", code: "PROVIDER_UNREACHABLE", fault: "transient" });

    expect(runtime.active).toBeNull();
    await expect(runtime.start("p2")).resolves.toBeUndefined();
  });

  /**
   * A project already paused refuses another PAUSE, and writing the state
   * anyway records something the machine never lived through.
   */
  it("does not write a pause the machine refused", async () => {
    const { runtime, db } = harness();
    await runtime.start("p1");
    await runtime.pause("p1");
    const first = lastPhase(db, "p1");

    await runtime.pause("p1");

    expect(lastPhase(db, "p1")).toEqual(first);
  });
});
```

> `harness()`, `stateOf()`, `lastPhase()` e `feed()` sono gli aiutanti del
> file. Se `feed()` non esiste ancora, aggiungilo: espone il listener che
> `engine.on(onEngineMessage)` registra, così il test può parlare al runtime
> come farebbe il motore.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/run-runtime.test.ts`
Expected: FAIL — lo stato è `failed` dove ci si aspetta `paused`.

- [ ] **Step 3: Il tavolo di traduzione**

In `app/main/run/runtime.ts`, importa `PAUSES_ON` da `../../../core/errors.ts` e sostituisci il ramo `failed` di `onEngineMessage`:

```ts
    if (message.type === "failed") {
      const projectId = activeId;
      // The taxonomy's table, read here and nowhere else. `failed` means
      // "resuming would not fix it", and only three faults qualify: a network
      // that went away is a pause, and used to be a rejection.
      const ending = PAUSES_ON[message.fault] ? "paused" : "failed";
      const info = {
        code: message.code, fault: message.fault, ...(message.detail ?? {}),
      };

      const host = machineHost(projectId);
      const accepted = host.send(ending === "paused"
        ? { type: "PAUSE", reason: message.code }
        : { type: "FAIL", reason: message.code });
      // Written only if the machine lived through it: a state recorded that
      // the machine refused is a history that did not happen.
      if (accepted) leaveState(db, { projectId, kind: "phase", outcome: ending, info });

      release();
      changed(projectId);
      return;
    }
```

- [ ] **Step 4: `release()`**

Dichiara accanto alle tre variabili:

```ts
  /**
   * Lets go of the engine, all at once.
   *
   * These three say one thing — who owns the engine now — and each ending used
   * to blank a different subset of them. Nothing visible broke, because
   * `onEngineMessage` leaves early on a null `activeId`; but three variables
   * for one fact stay true only if they are set together.
   */
  const release = (): void => {
    activeId = null;
    activeRunId = null;
    activeComposition = null;
  };
```

Sostituisci con `release()` ogni azzeramento a mano: nel ramo `done` (dopo aver salvato `const finished = activeId`), in `compose()` (i due rami e il `catch`), in `onCrash()`, in `pause()`, e nel `finally` di `recompose()`.

- [ ] **Step 5: `send` prima di `leaveState`**

In `pause()`:

```ts
      db.exec("SAVEPOINT babelbook_pause_run");
      try {
        const accepted = machineHost(projectId).send({ type: "PAUSE" });
        if (accepted) leaveState(db, { projectId, kind: "phase", outcome: "paused" });
        db.exec("RELEASE SAVEPOINT babelbook_pause_run");
      } catch (error) { … }
```

e la stessa forma in `onCrash()`.

- [ ] **Step 6: `RunRefusedError` prende la sua classe**

Ha già il codice; senza il `fault` la schermata che lo riceve ricade su
`defect` e consiglia di leggere il diario grezzo per una lingua che manca.
Sostituisci la classe (`runtime.ts:78`) con:

```ts
/**
 * A refusal the interface can name, because it was foreseen.
 *
 * All of these are `config`: something has to change before pressing the
 * button again can work, and now the screen can say what.
 */
class RunRefusedError extends BabelError {
  constructor(code: string) {
    super(code, { code, fault: "config" });
    this.name = "RunRefusedError";
  }
}
```

I punti di lancio non cambiano: `new RunRefusedError("ENGINE_BUSY")` e simili
continuano a compilare. Aggiungi il test:

```ts
  it("refuses with a class the screen can act on", async () => {
    const { runtime } = harness();
    await runtime.start("p1");
    await expect(runtime.start("p2")).rejects.toMatchObject({
      code: "ENGINE_BUSY", fault: "config",
    });
  });
```

- [ ] **Step 7: Esegui i test**

Run: `npx vitest run app/test/run-runtime.test.ts && npm test && npm run typecheck`
Expected: PASS. Alcuni test esistenti asserivano `failed` dopo un errore: dove il `fault` è ora di pausa, l'aspettativa va aggiornata a `paused` — è la correzione, e va commentata come tale.

- [ ] **Step 8: Commit**

```bash
git add app/main/run/runtime.ts app/test/run-runtime.test.ts
git commit -m "feat(run): una corsa fermata dalla rete si mette in pausa, non fallisce"
```

---

## Task 13: La composizione dice cosa è capitato davvero

**Files:**
- Modify: `app/main/compose.ts`, `app/main/run/runtime.ts` (il `catch` di `compose()`)
- Test: `app/test/compose.test.ts`

**Interfaces:**
- Consumes: `BabelError` (Task 1), `classifySystemError` (Task 4).
- Produces: `composeEpub` che lancia `BabelError`; `ComposeResult` invariata.

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/compose.test.ts`:

```ts
import { BabelError } from "../../core/errors.ts";

/**
 * Four causes used to arrive under one word. `COMPOSE_FAILED` was what the
 * reader saw whether the package was missing, the cache key was never written,
 * the disk was full, or the workspace had moved — and none of those four is
 * fixed the way the others are.
 */
describe("a composition that cannot finish", () => {
  it("says the package is missing, and that the book is the problem", async () => {
    const workspace = await workspaceWithoutPackage();
    await expect(composeEpub({ ...baseInput(), workspace }))
      .rejects.toMatchObject({ code: "COMPOSE_NO_PACKAGE", fault: "input" });
  });

  it("says the source is not where it was", async () => {
    const workspace = { ...(await emptyWorkspace()), source: "/nowhere/source.epub" };
    const thrown = await composeEpub({ ...baseInput(), workspace }).catch((error) => error);
    expect(thrown).toBeInstanceOf(BabelError);
    expect(thrown.code).toBe("SOURCE_MISSING");
    expect(thrown.fault).toBe("input");
  });

  it("says the disk is full, and that somebody has to act", async () => {
    const workspace = { ...(await workspaceWithBook()), outputDir: "/proc/nowhere" };
    const thrown = await composeEpub({ ...baseInput(), workspace }).catch((error) => error);
    expect(thrown.fault).toBe("config");
  });
});
```

> `workspaceWithoutPackage()`, `emptyWorkspace()`, `workspaceWithBook()` e
> `baseInput()` seguono gli aiutanti già presenti nel file. Riusa il corpus di
> `core/test/corpus/build.ts` come fanno gli altri test.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/compose.test.ts`
Expected: FAIL — arriva un `Error` nudo senza `fault`.

- [ ] **Step 3: Dai un codice a ogni causa**

In `app/main/compose.ts`, importa `BabelError` e `classifySystemError`, e:

```ts
  const archive = await readEpub(await readFile(workspace.source).catch((error: unknown) => {
    // The workspace copy is the book: without it there is nothing to compose,
    // and no retry produces one.
    throw classifySystemError(error, { path: workspace.source });
  }));
```

```ts
  if (opfIndex === -1) {
    throw new BabelError("the archive has no package document", {
      code: "COMPOSE_NO_PACKAGE", fault: "input", detail: { path: opfPath },
    });
  }
```

```ts
  const outputPath = join(workspace.outputDir, fileName(title, targetLanguage));
  try {
    await writeFile(outputPath, await writeEpub(entries));
  } catch (error) {
    throw classifySystemError(error, { path: outputPath });
  }
```

In `app/main/run/runtime.ts`, la stessa cosa per la chiave di cache:

```ts
      if (row.cache_key === null) {
        throw new BabelError("this project has never run under a key", {
          code: "COMPOSE_NO_CACHE_KEY", fault: "defect",
        });
      }
```

e nel `catch` di `compose()`, sostituisci la lettura di `.code`:

```ts
    } catch (error) {
      if (activeComposition !== operation || activeId !== projectId || activeRunId !== runId) return;
      const classified = classifySystemError(error);
      const ending = PAUSES_ON[classified.fault] ? "paused" : "failed";
      const current = machineHost(projectId);
      if (current.state === "composing") {
        const accepted = current.send(ending === "paused"
          ? { type: "PAUSE", reason: classified.code }
          : { type: "FAIL", reason: classified.code });
        if (accepted) {
          leaveState(db, {
            projectId, kind: "phase", outcome: ending,
            info: { code: classified.code, fault: classified.fault, ...classified.detail },
          });
        }
      }
      release();
      changed(projectId);
    }
```

Il ramo `GATE_REFUSED` diventa `info: { code: "GATE_REFUSED", fault: "refused" }`, e resta un `FAIL`.

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run app/test/compose.test.ts app/test/run-runtime.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/main/compose.ts app/main/run/runtime.ts app/test/compose.test.ts
git commit -m "fix(compose): quattro cause diverse non arrivano piu' sotto una parola sola"
```

---

## Task 14: Il canale che serve il log grezzo

**Files:**
- Modify: `app/shared/channels.ts`, `app/main/ipc.ts`, `app/main/run/log.ts`
- Test: `app/test/ipc.test.ts`, `app/test/run-log.test.ts`

**Interfaces:**
- Produces: `"run.diagnostics": { req: { projectId: string }; res: { lines: string[]; path: string } }`.

- [ ] **Step 1: Scrivi i test che falliscono**

In `app/test/run-log.test.ts`:

```ts
  /** A `warn` from the new sink must read as a warning, not fall through to info. */
  it("reads the sink's own levels", () => {
    insertEvent(db, { code: "provider-retry", severity: "warn" });
    const line = runLog(db, "p1").find((entry) => entry.code === "provider-retry");
    expect(line?.severity).toBe("warning");
  });
```

In `app/test/ipc.test.ts`:

```ts
  it("serves the raw log of the last run", async () => {
    const handlers = buildHandlers(deps);
    const answer = await handlers["run.diagnostics"]({ projectId: "p1" });
    expect(Array.isArray(answer.lines)).toBe(true);
    expect(typeof answer.path).toBe("string");
  });

  /** A project that never ran answers with nothing, not with a rejection. */
  it("answers with nothing when no run ever wrote a line", async () => {
    const handlers = buildHandlers(deps);
    expect((await handlers["run.diagnostics"]({ projectId: "never-ran" })).lines).toEqual([]);
  });

  /** A failure on a channel belongs to no book, so it belongs to the app file. */
  it("writes down a failure that reaches no Registro", async () => {
    const logged: LogRecord[] = [];
    const ipcMain = fakeIpcMain();
    registerIpc(ipcMain, { ...deps, log: { record: (entry) => logged.push(entry) } });

    await expect(ipcMain.call("provider.verify", { id: "nope" })).rejects.toThrow();
    expect(logged[0]).toMatchObject({ level: "error", detail: { channel: "provider.verify" } });
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npx vitest run app/test/ipc.test.ts app/test/run-log.test.ts`
Expected: FAIL — il canale non esiste; `warn` diventa `info`.

- [ ] **Step 3: Il canale**

In `app/shared/channels.ts`, dentro `Invocations`, accanto a `"run.events"`:

```ts
  /** The last run's raw chronicle: both processes' NDJSON, merged, tail first trimmed. */
  "run.diagnostics": { req: { projectId: string }; res: { lines: string[]; path: string } };
```

e `"run.diagnostics"` nell'array `INVOCATIONS`, subito dopo `"run.events"`.

In `app/main/ipc.ts`, accanto al gestore di `run.events`:

```ts
    "run.diagnostics": async ({ projectId }) => {
      const row = deps.db.prepare(`
        SELECT p.workspace_path AS workspace,
               (SELECT id FROM run WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1) AS run_id
          FROM project p WHERE p.id = ?
      `).get(projectId) as { workspace: string; run_id: string | null } | undefined;

      // A project that never ran has nothing to show, and saying so is an
      // answer: refusing would make an empty panel look like a broken one.
      if (row === undefined || row.run_id === null) return { lines: [], path: "" };
      return readDiagnostics(diagnosticsDir(row.workspace), row.run_id);
    },
```

E il `catch` di `registerIpc` (`app/main/ipc.ts:589`) smette di perdere ciò che
non riguarda nessun libro:

```ts
      } catch (error) {
        // Repacked, not rethrown: the class and its fields do not cross, and a
        // code the window cannot read is a code that does not exist. Written
        // down as well, because a failure outside a run belongs to no
        // Registro and used to leave no trace at all.
        const classified = classifySystemError(error);
        deps.log?.record({
          level: "error",
          code: classified.code,
          detail: { channel, fault: classified.fault, ...classified.detail },
        });
        throw new Error(packFailure(classified));
      }
```

`IpcDeps` guadagna `log?: LogSink`, e `app/main/main.ts` lo costruisce una
volta con `appSink(app.getPath("userData"))`.

In `app/main/run/log.ts`, la mappa:

```ts
const SEVERITIES: Record<string, LogLine["severity"]> = {
  degradation: "warning",
  // The sink's own levels, beside the verdicts a degradation records.
  warn: "warning",
  warning: "warning",
  error: "error",
};
```

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run app/test/ipc.test.ts app/test/run-log.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/shared/channels.ts app/main/ipc.ts app/main/run/log.ts app/test/
git commit -m "feat(ipc): la finestra puo' chiedere il diario grezzo dell'ultima corsa"
```

---

## Task 15: Il catalogo delle frasi

**Files:**
- Modify: `app/locales/it.json`, `app/locales/en.json`
- Test: `app/test/locales.test.ts`

**Interfaces:**
- Produces: le chiavi `faults.<fault>.body`, `faults.<fault>.hint`, `alerts.paused`, `codes.<CODE>`, e i sei codici di log.

- [ ] **Step 1: Scrivi il test che fallisce**

In `app/test/locales.test.ts`:

```ts
const FAULTS = [
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
];

const CODES = [
  "PROVIDER_UNREACHABLE", "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED",
  "PROVIDER_OUT_OF_CREDIT", "PROVIDER_UNAUTHORIZED", "PROVIDER_SERVER_ERROR",
  "PROVIDER_UNKNOWN", "MODEL_NOT_FOUND", "CONTEXT_EXCEEDED", "RESPONSE_UNUSABLE",
  "SOURCE_MISSING", "DISK_FULL", "PATH_NOT_WRITABLE", "DATABASE_BUSY",
  "COMPOSE_NO_PACKAGE", "COMPOSE_NO_CACHE_KEY", "GATE_REFUSED",
  "ENGINE_BUSY", "GATE_OPEN", "NO_LANGUAGE", "SOURCE_CHANGED",
];

const LOG_CODES = [
  "provider-retry", "provider-recovered", "provider-slow",
  "run-paused", "chunk-failed", "unit-fell-back",
];

import italiano from "../locales/it.json";
import english from "../locales/en.json";

describe.each([["it", italiano], ["en", english]])("the %s catalogue", (_language, catalogue) => {
  /**
   * The floor under every unnamed code. If a fault had no sentence, an error
   * nobody catalogued would print its bare identifier in the middle of an
   * Italian paragraph — which is what it did before.
   */
  it("has a sentence and an advice for every fault", () => {
    for (const fault of FAULTS) {
      expect(catalogue.faults?.[fault]?.body, fault).toBeTruthy();
      expect(catalogue.faults?.[fault]?.hint, fault).toBeTruthy();
    }
  });

  it("names every code the classifiers can produce", () => {
    for (const code of CODES) expect(catalogue.codes?.[code], code).toBeTruthy();
  });

  it("names every line the log can write", () => {
    for (const code of LOG_CODES) expect(catalogue.codes?.[code], code).toBeTruthy();
  });

  it("has a title for a run that paused as well as one that failed", () => {
    expect(catalogue.alerts?.paused).toBeTruthy();
    expect(catalogue.alerts?.failed).toBeTruthy();
  });

  /** The Registro's retry line is useless without its numbers. */
  it("interpolates the retry line", () => {
    for (const token of ["{{attempt}}", "{{max}}", "{{seconds}}"]) {
      expect(catalogue.codes["provider-retry"]).toContain(token);
    }
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `npx vitest run app/test/locales.test.ts`
Expected: FAIL — `faults` non esiste.

- [ ] **Step 3: Scrivi le voci italiane**

In `app/locales/it.json`, aggiungi la sezione `faults` e le voci in `codes` e `alerts`:

```json
"faults": {
  "transient": {
    "body": "Il provider non ha risposto.",
    "hint": "Di solito passa da sé: riprendi fra qualche minuto."
  },
  "throttled": {
    "body": "Il provider ha chiesto di rallentare.",
    "hint": "Ha imposto un'attesa. Riprendi più tardi, o riduci le richieste in parallelo nelle impostazioni."
  },
  "exhausted": {
    "body": "Il credito del provider è finito.",
    "hint": "Ricarica il credito o attendi il rinnovo della quota, poi riprendi: ciò che è già tradotto resta."
  },
  "config": {
    "body": "Qualcosa nella configurazione impedisce di procedere.",
    "hint": "Controlla il provider e il modello del progetto in Impostazioni, poi riprendi."
  },
  "input": {
    "body": "Il libro non si presta a essere lavorato.",
    "hint": "Il file di partenza va sostituito: riprendere non cambierebbe l'esito."
  },
  "refused": {
    "body": "Il controllo finale ha rifiutato il libro composto.",
    "hint": "Apri il report: dice quale verifica non è stata superata."
  },
  "defect": {
    "body": "Si è rotto qualcosa dentro babelBook.",
    "hint": "Il registro grezzo contiene il dettaglio: copialo se vuoi segnalare il problema."
  },
  "cancelled": {
    "body": "La corsa è stata interrotta.",
    "hint": "Riprendi quando vuoi: nulla di ciò che era stato tradotto è andato perso."
  }
},
```

In `alerts`: `"paused": "La corsa si è messa in pausa"`.

In `codes`, aggiungi:

```json
"PROVIDER_UNREACHABLE": "Non si è riusciti a raggiungere il provider.",
"PROVIDER_TIMEOUT": "Il provider non ha risposto in tempo.",
"PROVIDER_RATE_LIMITED": "Il provider ha imposto un limite di frequenza.",
"PROVIDER_OUT_OF_CREDIT": "Il credito del provider è esaurito.",
"PROVIDER_UNAUTHORIZED": "La chiave non è stata accettata.",
"PROVIDER_SERVER_ERROR": "Il provider ha risposto con un errore proprio.",
"PROVIDER_UNKNOWN": "Il provider ha rifiutato la richiesta senza spiegarsi.",
"MODEL_NOT_FOUND": "Il provider non conosce questo modello.",
"CONTEXT_EXCEEDED": "La richiesta non entra nella finestra del modello.",
"RESPONSE_UNUSABLE": "La risposta non aveva la forma richiesta.",
"SOURCE_MISSING": "Il file di partenza non è più dove era.",
"DISK_FULL": "Il disco è pieno.",
"PATH_NOT_WRITABLE": "Non si può scrivere in quella cartella.",
"DATABASE_BUSY": "Il database era occupato.",
"COMPOSE_NO_PACKAGE": "L'archivio non contiene il documento di pacchetto.",
"COMPOSE_NO_CACHE_KEY": "Questo progetto non ha ancora una chiave di lavoro.",
"GATE_REFUSED": "Il controllo finale ha rifiutato il libro.",
"ENGINE_BUSY": "Un altro libro sta occupando il motore.",
"GATE_OPEN": "C'è una decisione in sospeso da prendere prima.",
"NO_LANGUAGE": "Manca la lingua di destinazione.",
"SOURCE_CHANGED": "Il file di partenza è cambiato dopo l'analisi.",
"provider-retry": "Tentativo {{attempt}} di {{max}} fra {{seconds}} s — {{reason}}",
"provider-recovered": "Il provider ha ripreso a rispondere dopo {{attempts}} tentativi.",
"provider-slow": "Una richiesta ha impiegato {{seconds}} s.",
"run-paused": "La corsa si è messa in pausa: {{reason}}",
"chunk-failed": "Un gruppo di {{units}} unità non è stato tradotto."
```

- [ ] **Step 4: Scrivi le voci inglesi**

Le stesse chiavi in `app/locales/en.json`, tradotte. `"provider-retry": "Attempt {{attempt}} of {{max}} in {{seconds}}s — {{reason}}"`.

- [ ] **Step 5: Esegui il test**

Run: `npx vitest run app/test/locales.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/locales/
git commit -m "feat(i18n): ogni classe di errore ha una frase e un consiglio"
```

---

## Task 16: `tell()` — da un errore a una frase

**Files:**
- Create: `app/renderer/src/app/core/failure.ts`, `app/renderer/src/app/core/failure.spec.ts`

**Interfaces:**
- Consumes: `IpcFailure` (Task 2), il catalogo (Task 15).
- Produces: `Told { body: string; hint: string | null; code: string }`, `tell(transloco: TranslocoService, failure: unknown): Told`.

- [ ] **Step 1: Scrivi il test che fallisce**

`app/renderer/src/app/core/failure.spec.ts`:

```ts
import { TestBed } from "@angular/core/testing";
import { TranslocoService } from "@jsverse/transloco";
import { provideI18n } from "./i18n";
import { tell } from "./failure";

describe("telling a failure", () => {
  let transloco: TranslocoService;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideI18n("it")] });
    transloco = TestBed.inject(TranslocoService);
    await transloco.load("it").toPromise();
    transloco.setActiveLang("it");
  });

  it("prefers the sentence written for the code", () => {
    const told = tell(transloco, { code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" });
    expect(told.body).toBe("Il credito del provider è esaurito.");
    expect(told.hint).toContain("Ricarica");
    expect(told.code).toBe("PROVIDER_OUT_OF_CREDIT");
  });

  /**
   * The floor the fault exists for. A code nobody catalogued used to print
   * itself, bare, in the middle of an Italian sentence; now the class still
   * has something true to say and the identifier goes in the small print.
   */
  it("falls back to the fault when the code is not catalogued", () => {
    const told = tell(transloco, { code: "PROVIDER_INVENTED_TOMORROW", fault: "transient" });
    expect(told.body).toBe("Il provider non ha risposto.");
    expect(told.hint).toContain("riprendi");
    expect(told.code).toBe("PROVIDER_INVENTED_TOMORROW");
  });

  it("says something even for a shape it does not recognise", () => {
    const told = tell(transloco, { unexpected: true });
    expect(told.body).toBeTruthy();
    expect(told.body).not.toContain("faults.");
  });

  it("never returns a bare catalogue key", () => {
    for (const failure of [{ code: "X", fault: "defect" }, null, undefined, "a string"]) {
      const told = tell(transloco, failure);
      expect(told.body.startsWith("codes.")).toBe(false);
      expect(told.body.startsWith("faults.")).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd app && npx ng test --include renderer/src/app/core/failure.spec.ts`
Expected: FAIL — `Cannot find module './failure'`

- [ ] **Step 3: Scrivi `app/renderer/src/app/core/failure.ts`**

```ts
import type { TranslocoService } from "@jsverse/transloco";
import type { IpcFailure } from "../../../../shared/dto.js";

/**
 * A failure as a reader can use it.
 *
 * The title is deliberately not here. Every screen already has one that is
 * right for itself — `alerts.failed`, `providers.findFailed` — and replacing
 * them with one generic sentence would be a loss dressed as consistency. What
 * was missing is the rest: what happened, what to do, and the identifier to
 * quote when reporting it.
 */
export interface Told {
  body: string;
  hint: string | null;
  code: string;
}

const FAULTS = new Set([
  "transient", "throttled", "exhausted", "config",
  "input", "refused", "defect", "cancelled",
]);

/** Transloco answers with the key itself when it has no entry for it. */
function sentence(transloco: TranslocoService, key: string): string | null {
  const found = transloco.translate(key);
  return found === key || found === "" ? null : found;
}

function failureOf(value: unknown): IpcFailure {
  if (typeof value !== "object" || value === null) return { code: "UNKNOWN", fault: "defect" };
  const candidate = value as { code?: unknown; fault?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN",
    fault: typeof candidate.fault === "string" && FAULTS.has(candidate.fault)
      ? (candidate.fault as IpcFailure["fault"])
      : "defect",
  };
}

/**
 * Two lookups, and the second is the reason the fault exists.
 *
 * The specific code first, because it says the most. The class second, because
 * it always says something: a code nobody catalogued used to be printed bare
 * in the middle of an Italian paragraph, and the class turns that hole into a
 * floor. It is what makes the taxonomy useful for the failures nobody
 * anticipated — which are the ones that matter.
 */
export function tell(transloco: TranslocoService, value: unknown): Told {
  const failure = failureOf(value);

  return {
    body: sentence(transloco, `codes.${failure.code}`)
      ?? sentence(transloco, `faults.${failure.fault}.body`)
      ?? sentence(transloco, "faults.defect.body")
      ?? "",
    hint: sentence(transloco, `faults.${failure.fault}.hint`),
    code: failure.code,
  };
}
```

- [ ] **Step 4: Esegui il test**

Run: `cd app && npx ng test --include renderer/src/app/core/failure.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/core/failure.ts app/renderer/src/app/core/failure.spec.ts
git commit -m "feat(ui): un errore diventa una frase, e la classe fa da pavimento"
```

---

## Task 17: La colonna dice cosa è successo, e mostra il grezzo

**Files:**
- Modify: `app/renderer/src/app/project/side/side.ts`, `side.html`, `side.css`
- Test: `app/renderer/src/app/project/side/side.spec.ts`

**Interfaces:**
- Consumes: `tell()` (Task 16), `run.diagnostics` (Task 14).
- Produces: `AlertCard` con `kind: "stopped"`; `view: signal<"log" | "raw">`; `raw: signal<string[]>`.

- [ ] **Step 1: Scrivi i test che falliscono**

In `side.spec.ts`:

```ts
  /** A pause with a reason is a card of its own, and warning-coloured. */
  it("shows why a paused run stopped", async () => {
    const fixture = mount({
      state: "paused",
      phases: [phase("translate", "paused", { code: "PROVIDER_OUT_OF_CREDIT", fault: "exhausted" })],
    });

    const card = fixture.nativeElement.querySelector("[data-testid=alert-stopped]");
    expect(card.textContent).toContain("Il credito del provider è esaurito.");
    expect(card.textContent).toContain("Ricarica");
    expect(card.className).toContain("warning");
  });

  it("shows a failed run in the danger tone", () => {
    const fixture = mount({
      state: "failed",
      phases: [phase("compose", "failed", { code: "GATE_REFUSED", fault: "refused" })],
    });
    expect(fixture.nativeElement.querySelector("[data-testid=alert-stopped]").className)
      .toContain("danger");
  });

  /**
   * The retry line was the one the Registro was missing. It is useless without
   * its numbers, and `phrase()` used to translate without passing any.
   */
  it("fills in the numbers of a retry line", () => {
    const fixture = mount({ state: "running" });
    const spoken = fixture.componentInstance.phrase({
      at: new Date().toISOString(), kind: "event", code: "provider-retry", severity: "warning",
      info: { attempt: 2, max: 5, seconds: 4, reason: "PROVIDER_RATE_LIMITED" },
    });

    expect(spoken).toContain("2");
    expect(spoken).toContain("5");
    expect(spoken).not.toContain("{{");
  });

  it("offers the raw log beside the curated one, and asks for it only when shown", async () => {
    const fixture = mount({ state: "done" });
    fixture.componentInstance.panel.set("log");
    fixture.detectChanges();

    expect(ipc.invoked).not.toContain("run.diagnostics");

    fixture.nativeElement.querySelector("[data-testid=side-view-raw]").click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(ipc.invoked).toContain("run.diagnostics");
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]")).toBeTruthy();
  });

  it("hides debug lines until asked", async () => {
    ipc.answer("run.diagnostics", {
      lines: [
        JSON.stringify({ at: "2026-09-01T10:00:00Z", level: "debug", code: "call-finished" }),
        JSON.stringify({ at: "2026-09-01T10:00:01Z", level: "warn", code: "provider-retry" }),
      ],
      path: "/w/logs",
    });

    const fixture = await mountShowingRaw();
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]").textContent)
      .not.toContain("call-finished");

    fixture.nativeElement.querySelector("[data-testid=side-raw-level-debug]").click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector("[data-testid=side-raw]").textContent)
      .toContain("call-finished");
  });
```

> `mount()`, `phase()`, `ipc` e `mountShowingRaw()` seguono gli aiutanti già
> presenti nello spec del componente.

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `cd app && npx ng test --include renderer/src/app/project/side/side.spec.ts`
Expected: FAIL — `alert-stopped` non esiste.

- [ ] **Step 3: Il cartellino**

In `side.ts`, sostituisci il ramo `failed` di `alerts` e i due metodi che lo servono:

```ts
  readonly alerts = computed<AlertCard[]>(() => {
    const found = this.project();
    const cards: AlertCard[] = [];

    // Two endings now, not one. `failed` means resuming would not fix it;
    // `paused` with a reason is a run waiting for something outside itself,
    // and calling it "Rifiutato" was telling the reader the wrong thing.
    if (found.state === "failed" || (found.state === "paused" && this.#stopped() !== null)) {
      cards.push({
        kind: "stopped",
        testid: "alert-stopped",
        tone: found.state === "failed" ? "danger" : "warning",
      });
    }
    if (found.layout !== "reflowable") cards.push({ kind: "layout", testid: "alert-layout", tone: "warning" });
    if (found.hasOverlays) cards.push({ kind: "overlays", testid: "alert-overlays", tone: "warning" });
    if (found.description === null) {
      cards.push({ kind: "description", testid: "alert-description", tone: "muted" });
    }
    return cards;
  });

  /** The classified reason of the last phase that carried one, whatever its outcome. */
  #stopped(): IpcFailure | null {
    for (const entry of [...this.project().phases].reverse()) {
      const code = entry.info?.["code"];
      if (typeof code !== "string") continue;
      const fault = entry.info?.["fault"];
      return { code, fault: (typeof fault === "string" ? fault : "defect") as IpcFailure["fault"] };
    }
    return null;
  }

  titleOf(card: AlertCard): string {
    if (card.kind !== "stopped") return ALERT_TITLES[card.kind];
    return this.project().state === "failed" ? "alerts.failed" : "alerts.paused";
  }

  bodyOf(card: AlertCard): string | null {
    if (card.kind === "layout") return this.#transloco.translate("project.fixedLayout");
    if (card.kind === "overlays") return this.#transloco.translate("overlays.warning");
    if (card.kind === "description") return this.#transloco.translate("project.noDescription");
    const failure = this.#stopped();
    return failure === null ? null : tell(this.#transloco, failure).body;
  }

  /** What to do next, which is the whole point of classifying. */
  hintOf(card: AlertCard): string | null {
    if (card.kind !== "stopped") return null;
    const failure = this.#stopped();
    return failure === null ? null : tell(this.#transloco, failure).hint;
  }

  /** True where the fix is in Settings rather than in pressing Resume. */
  settingsHelp(): boolean {
    const fault = this.#stopped()?.fault;
    return fault === "config" || fault === "exhausted";
  }
```

Aggiorna `AlertCard["kind"]` a `"stopped" | "layout" | "overlays" | "description"` e togli `failed` da `ALERT_TITLES`.

- [ ] **Step 4: `phrase()` interpola**

```ts
  phrase(line: LogLine): string {
    if (line.kind === "event") {
      // The parameters were never passed, so a catalogue entry with
      // placeholders showed its `{{ }}` to the reader. The retry line is
      // nothing but its numbers.
      return this.#sentence(`codes.${line.code}`, line.code, line.info ?? {});
    }
    const [, subject, outcome = "left"] = line.code.split(".");
    if (line.code.startsWith("phase.")) {
      const seconds = line.info?.["durationSeconds"];
      return this.#transloco.translate(`project.log.phase.${outcome}`, {
        phase: this.#sentence(`phase.${subject}`, subject),
        duration: typeof seconds === "number" ? spell(this.#transloco, seconds) : "—",
      });
    }
    return this.#sentence(`state.${subject}`, subject);
  }

  #sentence(key: string, fallback: string, params: Record<string, unknown> = {}): string {
    const sentence = this.#transloco.translate(key, params);
    return sentence === key ? fallback : sentence;
  }
```

Il sink scrive `waitMs`, il catalogo chiede `{{seconds}}`. La conversione sta
qui e non in `runLog`, perché è una scelta di lingua e non di dato: il registro
conserva i millisecondi che ha misurato. Prima della `translate`:

```ts
      const info = { ...(line.info ?? {}) };
      if (typeof info["waitMs"] === "number") info["seconds"] = Math.round(info["waitMs"] / 1000);
      if (typeof info["elapsedMs"] === "number") info["seconds"] = Math.round(info["elapsedMs"] / 1000);
```

e passa `info` invece di `line.info ?? {}`.

- [ ] **Step 5: La vista grezza**

In `side.ts`:

```ts
  readonly view = signal<"log" | "raw">("log");
  readonly raw = signal<string[]>([]);
  readonly rawPath = signal<string>("");
  readonly showDebug = signal(false);

  /** The raw lines the filter lets through, newest last, as they were written. */
  readonly rawLines = computed(() => this.raw().filter((line) => {
    if (this.showDebug()) return true;
    try {
      return (JSON.parse(line) as { level?: string }).level !== "debug";
    } catch {
      return true;
    }
  }));

  async #loadRaw(): Promise<void> {
    const answer = await this.#ipc.invoke("run.diagnostics", { projectId: this.project().id });
    this.raw.set(answer.lines);
    this.rawPath.set(answer.path);
  }

  showRaw(): void {
    this.view.set("raw");
    void this.#loadRaw();
  }

  copyRaw(): void {
    void navigator.clipboard.writeText(this.rawLines().join("\n"));
  }

  revealRaw(): void {
    if (this.rawPath() !== "") void this.#ipc.invoke("file.reveal", { path: this.rawPath() });
  }
```

In `side.html`, dentro `@else { <div class="side__panel-body" data-testid="side-panel-log"> }`, sopra il registro:

```html
<div class="side__log-views" role="group">
  <button type="button" class="side__log-view" [class.side__log-view--active]="view() === 'log'"
          data-testid="side-view-log" (click)="view.set('log')">{{ t('project.panel.log') }}</button>
  <button type="button" class="side__log-view" [class.side__log-view--active]="view() === 'raw'"
          data-testid="side-view-raw" (click)="showRaw()">{{ t('project.panel.raw') }}</button>
</div>

@if (view() === "raw") {
  <div class="side__raw-tools">
    <label class="side__raw-toggle">
      <input type="checkbox" data-testid="side-raw-level-debug"
             [checked]="showDebug()" (change)="showDebug.set(!showDebug())" />
      {{ t('project.log.showDebug') }}
    </label>
    <button type="button" class="btn btn-xs" (click)="copyRaw()">{{ t('project.log.copy') }}</button>
    <button type="button" class="btn btn-xs" (click)="revealRaw()">{{ t('project.log.reveal') }}</button>
  </div>
  <pre class="side__raw" data-testid="side-raw">@for (line of rawLines(); track $index) {{{ line }}
}</pre>
}
```

e avvolgi il registro esistente in `@if (view() === "log") { … }`.

Nel cartellino, aggiungi il suggerimento e il pulsante:

```html
<p class="side__alert-body">{{ body }}</p>
@if (hintOf(card); as hint) {
  <p class="side__alert-hint">{{ hint }}</p>
}
@if (card.kind === "stopped" && settingsHelp()) {
  <button type="button" class="btn btn-xs" data-testid="alert-settings"
          (click)="editOpen.set(true)">{{ t('project.edit') }}</button>
}
```

Aggiungi in `it.json`/`en.json`: `project.panel.raw`, `project.log.showDebug`, `project.log.copy`, `project.log.reveal`. In `side.css`, le classi `side__log-views`, `side__log-view`, `side__raw-tools`, `side__raw` (monospaziato, `overflow-x: auto`, `max-height` con scorrimento) e `side__alert-hint`.

- [ ] **Step 6: Esegui i test**

Run: `cd app && npx ng test --include renderer/src/app/project/side/side.spec.ts && cd .. && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/renderer/src/app/project/side/ app/locales/
git commit -m "feat(ui): la colonna dice perche' si e' fermata e mostra il diario grezzo"
```

---

## Task 18: Le schermate che fallivano in silenzio

**Files:**
- Modify: `app/renderer/src/app/settings/providers.ts`, `glossaries.ts`, `preferences.ts` e i rispettivi `.html`
- Test: `providers.spec.ts`, `glossaries.spec.ts`, `preferences.spec.ts`

**Interfaces:**
- Consumes: `tell()` (Task 16).
- Produces: su ciascun componente, `failureBody: signal<string | null>` e `failureHint: signal<string | null>`.

- [ ] **Step 1: Scrivi il test che fallisce**

In `providers.spec.ts`:

```ts
  /**
   * The first place a network failure ever reaches, and the one where it costs
   * nothing yet. "Non è stato possibile chiedere l'elenco dei modelli" is the
   * same sentence for a wrong key and for an endpoint that is down, and those
   * are two very different afternoons.
   */
  it("says why the model list could not be asked for", async () => {
    ipc.reject("catalog.models", { code: "PROVIDER_UNAUTHORIZED", fault: "config" });

    const fixture = mount();
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    const text = fixture.nativeElement.querySelector("[data-testid=providers-failure]").textContent;
    expect(text).toContain("La chiave non è stata accettata.");
    expect(text).toContain("Impostazioni");
  });

  it("says something even for a code nobody catalogued", async () => {
    ipc.reject("catalog.models", { code: "SOMETHING_NEW", fault: "transient" });

    const fixture = mount();
    await fixture.componentInstance.findModels();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=providers-failure]").textContent)
      .toContain("Il provider non ha risposto.");
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd app && npx ng test --include renderer/src/app/settings/providers.spec.ts`
Expected: FAIL — `providers-failure` non esiste.

- [ ] **Step 3: Applica lo stesso schema ai tre componenti**

In ciascuno, dove oggi c'è un `catch` che alza una bandiera booleana:

```ts
  readonly failureBody = signal<string | null>(null);
  readonly failureHint = signal<string | null>(null);

  /** The title stays each screen's own; only the explanation is shared. */
  #explain(error: unknown): void {
    const told = tell(this.#transloco, error);
    this.failureBody.set(told.body);
    this.failureHint.set(told.hint);
  }
```

e nel `catch`: `this.#explain(error);` accanto alla bandiera esistente. Nel template, sotto il titolo che c'è già:

```html
@if (failureBody(); as body) {
  <div class="alert alert-error" data-testid="providers-failure">
    <div>
      <p>{{ t('providers.findFailed') }}</p>
      <p class="text-sm">{{ body }}</p>
      @if (failureHint(); as hint) { <p class="text-sm opacity-70">{{ hint }}</p> }
    </div>
  </div>
}
```

I `data-testid` sono `providers-failure`, `glossaries-failure`, `prefs-failure`; il titolo è la chiave che ogni schermata già usa (`providers.findFailed`, `providers.failed`, `glossaries.failed`, `prefs.failed`, `providers.catalogRefreshFailed`).

- [ ] **Step 4: Esegui i test**

Run: `cd app && npx ng test && cd .. && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/renderer/src/app/settings/
git commit -m "feat(ui): le impostazioni dicono perche' non hanno potuto"
```

---

## Task 19: La prova dal vivo

**Files:**
- Modify: `app/engine/fake.ts`
- Create: `app/e2e/resilience.spec.ts`
- Test: la prova stessa

**Interfaces:**
- Consumes: tutto quanto sopra.
- Produces: `fakeBackend` che può fallire su comando, guidato da `BABELBOOK_FAKE_FAILURES`.

- [ ] **Step 1: Insegna al doppio a fallire**

In `app/engine/fake.ts`, in cima a `fakeBackend`:

```ts
/**
 * How the deterministic backend is told to stumble.
 *
 * `BABELBOOK_FAKE_FAILURES=429x2` throws a rate limit on the first two calls
 * and answers after that; `429` alone throws for ever. It exists so the
 * end-to-end suite can prove the retry without a provider and without a
 * network — which is to say, so it can prove it at all.
 */
function plannedFailures(): { status: number; times: number } | null {
  const plan = process.env["BABELBOOK_FAKE_FAILURES"];
  if (plan === undefined || plan === "") return null;
  const [status, times] = plan.split("x");
  return {
    status: Number(status),
    times: times === undefined ? Number.POSITIVE_INFINITY : Number(times),
  };
}
```

e dentro `call`, come prima cosa:

```ts
      const planned = plannedFailures();
      if (planned !== null && failures < planned.times) {
        failures++;
        throw new APICallError({
          message: `fake ${planned.status}`,
          url: "https://fake.invalid/v1",
          requestBodyValues: {},
          statusCode: planned.status,
          responseHeaders: { "retry-after": "1" },
        });
      }
```

con `let failures = 0;` nella chiusura di `fakeBackend`.

- [ ] **Step 2: Scrivi la prova**

`app/e2e/resilience.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { launch, newProject, openProject } from "./helpers";

/**
 * The failure that used to end a book. One 429 halfway through cost the whole
 * run: `sdkBackend` retries nothing by design, and the engine's own attempts
 * only ever counted answers it had received and rejected.
 */
test("a provider that stumbles twice does not cost the book", async () => {
  const app = await launch({ env: { BABELBOOK_FAKE_FAILURES: "429x2" } });
  try {
    const window = await app.firstWindow();
    await newProject(window, { file: "corpus/small.epub", targetLanguage: "it" });
    await openProject(window);

    await window.getByTestId("project-start").click();
    await expect(window.getByTestId("side-status")).toHaveText(/Completato|Incompleto/, {
      timeout: 120_000,
    });

    await window.getByTestId("side-tab-log").click();
    const log = window.getByTestId("side-panel-log");
    await expect(log).toContainText("Tentativo 1 di 5");
    await expect(log).toContainText("ha ripreso a rispondere");
  } finally {
    await app.close();
  }
});

/** And when it never comes back: paused with a reason, not a rejected book. */
test("a provider that never comes back leaves the book paused, and says why", async () => {
  const app = await launch({ env: { BABELBOOK_FAKE_FAILURES: "402" } });
  try {
    const window = await app.firstWindow();
    await newProject(window, { file: "corpus/small.epub", targetLanguage: "it" });
    await openProject(window);

    await window.getByTestId("project-start").click();

    const card = window.getByTestId("alert-stopped");
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText("Il credito del provider è esaurito.");
    await expect(card).toContainText("Ricarica");
    await expect(window.getByTestId("side-status")).toHaveText("In pausa");

    // The raw chronicle is there, and it holds what the curated one leaves out.
    await window.getByTestId("side-tab-log").click();
    await window.getByTestId("side-view-raw").click();
    await expect(window.getByTestId("side-raw")).toContainText("PROVIDER_OUT_OF_CREDIT");
  } finally {
    await app.close();
  }
});
```

> `launch`, `newProject` e `openProject` seguono gli aiutanti di `app/e2e/`. Se
> `launch` non accetta ancora `env`, aggiungi il passaggio a
> `electron.launch({ env: { ...process.env, ...input.env } })`.

- [ ] **Step 3: Esegui la prova**

Run: `npm run test:e2e -w app -- e2e/resilience.spec.ts`
Expected: PASS, entrambe.

- [ ] **Step 4: Esegui tutto**

Run: `npm test && npm run typecheck && npm run test:e2e -w app`
Expected: verde. Aggiorna `docs/superpowers/STATO.md`: una riga nella tabella dei piani, e il conteggio dei test.

- [ ] **Step 5: Commit**

```bash
git add app/engine/fake.ts app/e2e/resilience.spec.ts docs/superpowers/STATO.md
git commit -m "test(e2e): un provider che inciampa non costa piu' il libro"
```

---

## Copertura della spec

| sezione della spec | task |
|---|---|
| 1 — tassonomia, `RETRIES_ON`/`PAUSES_ON`, lista permessa | 1, 2 |
| 1 — classificazione ai bordi | 3, 4 |
| 2 — `retryingBackend`, montaggio, 5 tentativi | 8, 10 |
| 2A — `countingBackend` perde `structured` | 5 |
| 2B — `inParallel` non ferma i lavoratori | 6 |
| 3 — `LogSink`, i due log, la rotazione | 7, 9, 10, 14 |
| 3 — il file d'applicazione fuori da una corsa | 9, 14 |
| 3 — il sink nelle cinque funzioni del core | 10 |
| 4 — `PAUSE` con `reason`, `EngineMessage` arricchito | 11 |
| 4A/4B — `failureCode`, l'errore ingoiato dall'abort | 11 |
| 4C — la composizione | 13 |
| 4D — `RunRefusedError` con la classe | 12 (via `packFailure`), 15 (le frasi) |
| 4E — `release()`, `send` prima di `leaveState` | 12 |
| 5 — `tell()` e il ripiego sul `fault` | 16 |
| 5 — i due cartellini, `phrase()`, la vista grezza | 17 |
| 5 — le schermate delle impostazioni | 18 |
| «Come si prova» della spec | in ogni task, e 19 per la prova dal vivo |
