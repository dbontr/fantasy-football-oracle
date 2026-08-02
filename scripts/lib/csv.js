"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const zlib = require("node:zlib");

function parseCsvLine(line) {
  const output = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      output.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  output.push(value);
  return output;
}

function createLineReader(filePath) {
  const source = fs.createReadStream(filePath);
  const input = filePath.endsWith(".gz") ? source.pipe(zlib.createGunzip()) : source;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

async function forEachCsvRow(filePath, callback) {
  const lines = createLineReader(filePath);
  let headers = null;
  let rowNumber = 0;
  for await (const line of lines) {
    rowNumber += 1;
    if (!line) continue;
    const values = parseCsvLine(line);
    if (!headers) {
      headers = values;
      continue;
    }
    const row = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = values[index] ?? "";
    }
    await callback(row, rowNumber);
  }
}

module.exports = {
  createLineReader,
  forEachCsvRow,
  parseCsvLine,
};
