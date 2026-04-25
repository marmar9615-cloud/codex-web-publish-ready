import test from "node:test";
import assert from "node:assert/strict";

import {
  isAuthErrorMessage,
  shouldSuppressRetryNoise,
} from "../../public/notifications.js";

test("isAuthErrorMessage detects HTTP 401 phrasing", () => {
  assert.equal(isAuthErrorMessage("HTTP 401 Unauthorized"), true);
  assert.equal(isAuthErrorMessage("unauthorized request"), true);
  assert.equal(isAuthErrorMessage("Authentication failed"), true);
  assert.equal(isAuthErrorMessage("token expired"), true);
});

test("isAuthErrorMessage matches the OAuth invalid_token error code", () => {
  // RFC 6750 §3.1 defines `invalid_token` (with an underscore) as the
  // canonical error code returned by Bearer-token resource servers when the
  // access token has been revoked or has expired. The web UI treats auth
  // errors specially (showing a sign-in prompt), so this token form must be
  // recognized.
  assert.equal(isAuthErrorMessage("invalid_token"), true);
  assert.equal(
    isAuthErrorMessage('error="invalid_token", error_description="expired"'),
    true,
  );
});

test("isAuthErrorMessage still matches space- and hyphen-separated forms", () => {
  assert.equal(isAuthErrorMessage("invalid token"), true);
  assert.equal(isAuthErrorMessage("invalid-token"), true);
});

test("isAuthErrorMessage does not match unrelated 'auth*' substrings", () => {
  assert.equal(isAuthErrorMessage("author not found"), false);
  assert.equal(isAuthErrorMessage("authority denied"), false);
  assert.equal(isAuthErrorMessage("authorize this device"), false);
});

test("isAuthErrorMessage tolerates nullish input", () => {
  assert.equal(isAuthErrorMessage(null), false);
  assert.equal(isAuthErrorMessage(undefined), false);
  assert.equal(isAuthErrorMessage(""), false);
});

test("shouldSuppressRetryNoise matches retry phrases", () => {
  assert.equal(shouldSuppressRetryNoise("retrying sampling request"), true);
  assert.equal(shouldSuppressRetryNoise("stream disconnected"), true);
  assert.equal(shouldSuppressRetryNoise("reconnecting in 2s"), true);
  assert.equal(shouldSuppressRetryNoise("something else"), false);
});
