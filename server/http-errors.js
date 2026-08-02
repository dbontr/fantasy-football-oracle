"use strict";

const STATUS_TITLES = Object.freeze({
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
});

function statusForError(error = {}) {
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  if (error.code === "QUEUE_FULL") return 503;
  if (error.code === "NATIVE_REQUIRED" || error.code === "NATIVE_REQUIRED_TASK") return 503;
  if (error.code === "TASK_TIMEOUT") return 504;
  return 500;
}

function titleForStatus(statusCode) {
  return STATUS_TITLES[statusCode]
    || (statusCode >= 500 ? "Server Error" : "Bad Request");
}
function publicErrorPayload(error = {}, statusCode = 500, requestId = null) {
  const clientError = statusCode < 500;
  return {
    error: titleForStatus(statusCode),
    code: error.code || "REQUEST_FAILED",
    message: clientError
      ? (error.message || titleForStatus(statusCode))
      : "The Oracle server could not complete the request.",
    requestId: requestId || null,
  };
}

module.exports = {
  publicErrorPayload,
  statusForError,
  titleForStatus,
};
