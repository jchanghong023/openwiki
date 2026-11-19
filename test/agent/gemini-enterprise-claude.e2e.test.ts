// @vitest-environment jsdom

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createModel } from "../../src/agent/index.ts";

// Regression for issue #3: exercise the real Anthropic Vertex SDK's browser
// guard in a browser-like host instead of assuming the option is honored.
//
// Suppressing the ADC unhandled rejection: AnthropicVertex's constructor eagerly
// runs `new GoogleAuth().getClient()` and does not await the promise (it is only
// awaited later, on the first request). In an unauthenticated CI environment that
// promise rejects with "Could not load the default credentials" AFTER this test
// resolves, so Vitest reports an unhandled rejection and fails the run even
// though every test passes. Mocking google-auth-library does not help here:
// @anthropic-ai/vertex-sdk is externalized CommonJS, so its internal
// `require("google-auth-library")` never routes through Vitest's mock registry.
// Instead we point GOOGLE_APPLICATION_CREDENTIALS at a throwaway `authorized_user`
// credentials file so the eager lookup resolves offline: those creds build a
// UserRefreshClient with no network call, and this test never triggers a token
// refresh. The real GoogleAuth still runs, keeping the test genuinely end-to-end.
const PROJECT_KEY = "GOOGLE_CLOUD_PROJECT";
const LOCATION_KEY = "GOOGLE_CLOUD_LOCATION";
const ADC_KEY = "GOOGLE_APPLICATION_CREDENTIALS";

// Obviously-fake placeholder ADC. No real tokens, no private key; written to an
// OS temp dir per test and removed in afterEach, never committed.
const FAKE_AUTHORIZED_USER_ADC = JSON.stringify({
  type: "authorized_user",
  client_id: "test-client-id.apps.googleusercontent.com",
  client_secret: "test-secret",
  refresh_token: "test-refresh-token",
});

describe("gemini-enterprise Claude surface (real SDK, issue #3)", () => {
  let saved: Record<string, string | undefined> = {};
  let credsDir: string | undefined;

  beforeEach(async () => {
    saved = {
      [PROJECT_KEY]: process.env[PROJECT_KEY],
      [LOCATION_KEY]: process.env[LOCATION_KEY],
      [ADC_KEY]: process.env[ADC_KEY],
    };
    process.env[PROJECT_KEY] = "test-project";
    process.env[LOCATION_KEY] = "global";

    credsDir = await mkdtemp(path.join(tmpdir(), "openwiki-vertex-adc-"));
    const credsPath = path.join(
      credsDir,
      "application_default_credentials.json",
    );
    await writeFile(credsPath, FAKE_AUTHORIZED_USER_ADC, "utf8");
    process.env[ADC_KEY] = credsPath;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (credsDir !== undefined) {
      await rm(credsDir, { force: true, recursive: true });
      credsDir = undefined;
    }
  });

  test("constructs the Vertex Claude client with DOM globals present", () => {
    const model = createModel(
      "gemini-enterprise",
      "publishers/anthropic/models/claude-opus-4-8",
      0,
    );

    // Must NOT throw "It looks like you're running in a browser-like environment".
    const client = (model as { createClient: () => unknown }).createClient();
    expect(client).toBeDefined();
  });
});
