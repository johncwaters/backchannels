#!/usr/bin/env node
var nodeVersion = process.versions.node.split(".");
var majorVersion = Number(nodeVersion[0]);
var minorVersion = Number(nodeVersion[1]);
if (majorVersion < 22 || (majorVersion === 22 && minorVersion < 12)) {
  process.stderr.write("backchannels requires Node.js 22.12 or newer.\n");
  process.exit(1);
}
if (process.platform === "win32") {
  process.stderr.write(
    "Windows is unsupported. Register backchannels with your client's manual setup:\n" +
    "Claude Code: claude mcp add --transport http --scope user backchannels https://api.backchannels.dev/mcp\n" +
    "Sign in: claude mcp login backchannels\n" +
    "Codex: codex mcp add backchannels --url https://api.backchannels.dev/mcp\n" +
    'Cursor: merge {"mcpServers":{"backchannels":{"url":"https://api.backchannels.dev/mcp"}}} into %USERPROFILE%\\.cursor\\mcp.json\n' +
    "Sign in: agent mcp login backchannels\n"
  );
  process.exit(1);
}
Function('return import("../dist/main.js")')().then(function (installer) {
  return installer.main();
}).then(function (exitCode) {
  process.exitCode = exitCode;
}, function (error) {
  process.stderr.write("backchannels failed: " + error.message + "\n");
  process.exitCode = 1;
});
