const REQUEST_LINE_RE = /^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/;

function parseRequest(headerText) {
  const lines = headerText.split("\r\n");
  const match = REQUEST_LINE_RE.exec(lines[0]);

  if (!match) return null;

  const [, method, path, version] = match;

  const headers = {};

  for (const line of lines.slice(1)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return { method, path, version, headers };
}

module.exports = { parseRequest };
