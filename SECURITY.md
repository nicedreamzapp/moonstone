# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub: go to the **Security** tab of this repo and click **Report a vulnerability** ([direct link](https://github.com/nicedreamzapp/moonstone/security/advisories/new)). Only the maintainer sees the report.

Helpful details: what you found, how to reproduce it, which version or commit, your OS and Node version, and whether peers or a reverse proxy were involved.

I aim to reply within 3 days and to ship a fix or a clear plan within 30 days, depending on severity. You will be credited in the advisory unless you ask not to be.

## Supported versions

Fixes go into the latest version on `main`. `updater.js` keeps a git-clone install current, so please update before reporting if you are on an older commit.

## What matters most here

The parts where a mistake could hurt someone:

- the HTTP server in `server.js`, which listens on `127.0.0.1:8899` and starts Claude Code sessions, local models and shell commands, guarded by the loopback bind, the Host check, the `X-Dock` header and the Origin check
- permission prompts, which `server.js` answers through `--permission-prompt-tool stdio` and must never auto-approve
- API keys named by `keyEnv` and read from the environment or an `envFile`, and file uploads saved to `uploads/`
- peer machines reached over SSH tunnels, and messages between chats in `tools/chat-send.js` and the `tools/moonstone-peers.py` hook
- `updater.js`, which pulls new code and restarts the server, and the macOS helper in `mac/` that holds the Accessibility permission
