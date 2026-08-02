"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  publicErrorPayload,
  statusForError,
} = require("../server/http-errors.js");

test("known operational errors map to appropriate status codes", () => {
  assert.equal(statusForError({ code: "QUEUE_FULL" }), 503);
  assert.equal(statusForError({ code: "TASK_TIMEOUT" }), 504);
  assert.equal(statusForError({ code: "NATIVE_REQUIRED_TASK" }), 503);
  assert.equal(statusForError({ statusCode: 429 }), 429);
  assert.equal(statusForError({}), 500);
});

test("server errors do not expose internal messages", () => {
  const payload = publicErrorPayload(
    { code: "INTERNAL_FAILURE", message: "C:\\secret\\model.json failed" },
    500,
    "request-123",
  );
  assert.equal(payload.error, "Server Error");
  assert.equal(payload.message, "The Oracle server could not complete the request.");
  assert.equal(payload.code, "INTERNAL_FAILURE");
  assert.equal(payload.requestId, "request-123");
  assert.equal(JSON.stringify(payload).includes("secret"), false);
});
test("client errors preserve actionable messages and titles", () => {
  const unauthorized = publicErrorPayload(
    { code: "ADMIN_TOKEN_REQUIRED", message: "A valid token is required" },
    401,
    "request-401",
  );
  assert.deepEqual(unauthorized, {
    error: "Unauthorized",
    code: "ADMIN_TOKEN_REQUIRED",
    message: "A valid token is required",
    requestId: "request-401",
  });

  const limited = publicErrorPayload(
    { code: "FST_ERR_RATE_LIMIT", message: "Rate limit exceeded" },
    429,
    "request-429",
  );
  assert.equal(limited.error, "Too Many Requests");
  assert.equal(limited.message, "Rate limit exceeded");
});
