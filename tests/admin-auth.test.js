"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  authorizeAdmin,
  constantTimeEqual,
} = require("../server/api.js");

function request({ authorization = "", remoteAddress = "127.0.0.1", headers = {} } = {}) {
  return {
    headers: { ...headers, authorization },
    raw: { socket: { remoteAddress } },
    socket: { remoteAddress },
  };
}

test("admin token comparison handles equal and unequal values", () => {
  assert.equal(constantTimeEqual("correct", "correct"), true);
  assert.equal(constantTimeEqual("correct", "incorrect"), false);
  assert.equal(constantTimeEqual("short", "much-longer-secret"), false);
});

test("admin authorization accepts a case-insensitive bearer scheme", () => {
  assert.doesNotThrow(() => authorizeAdmin(
    request({ authorization: "bEaReR test-secret" }),
    { adminToken: "test-secret", trustProxy: true },
  ));
});
test("proxied admin requests require a token even from loopback", () => {
  assert.throws(
    () => authorizeAdmin(request({
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "127.0.0.1" },
    }), { adminToken: "", trustProxy: false }),
    { code: "ADMIN_TOKEN_REQUIRED", statusCode: 401 },
  );
});

test("direct loopback admin requests remain available without a token", () => {
  assert.doesNotThrow(() => authorizeAdmin(
    request({ remoteAddress: "::ffff:127.0.0.1" }),
    { adminToken: "", trustProxy: false },
  ));
});

test("non-loopback admin requests are forbidden without a token", () => {
  assert.throws(
    () => authorizeAdmin(
      request({ remoteAddress: "192.168.1.55" }),
      { adminToken: "", trustProxy: false },
    ),
    { code: "REFRESH_FORBIDDEN", statusCode: 403 },
  );
});
