# Contributing

Thanks for taking a look. Moonstone runs across Macs and Windows PCs with different terminals,
models and Claude Code versions, so a bug report from your setup is useful even if you never send
code.

## Reporting a problem

Open an [issue](https://github.com/nicedreamzapp/moonstone/issues/new/choose). The things that
make it quick to fix:

- your OS and version, Node version and Claude Code version
- the browser, or `Moonstone.app`, you had the page open in
- whether the session was a dock session, a terminal session, or a local model (`pipe` or `api`
  launcher), and whether it was on a peer machine over a tunnel
- for voice problems, which path it took: OS dictation, browser speech recognition or local Whisper
- the server output around the time it went wrong, and your `config.json` with keys and paths
  trimmed

## Running it locally

You need Node 18 or newer and Claude Code installed.

```bash
git clone https://github.com/nicedreamzapp/moonstone.git
cd moonstone
cp config.example.json config.json   # edit launchers and peers, or start with {}
node server.js
```

Open http://localhost:8899. Set `DOCK_PORT` to use another port. To try the UI with made-up
sessions, run `node tools/demo-server.js` and open http://localhost:8890.

## Tests

There are no automated tests. Before sending a change, run `node --check server.js`, then start
the server and check by hand: the session list loads, a chat sends and answers, and a permission
prompt shows up as a card. For UI changes, `node tools/demo-server.js` is the quickest way to look.

## Pull requests

Small and focused is easiest to review. For big changes, open an issue first so we can talk it
through. Say which OS and machines you tested on. Moonstone has no npm dependencies, so please
keep it that way. Changes near the security checks in `server.js` (loopback bind, Host check,
`X-Dock` header, Origin check) need a clear note on why they are safe.

Please follow the [code of conduct](CODE_OF_CONDUCT.md).
