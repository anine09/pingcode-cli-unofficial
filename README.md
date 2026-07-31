# pingcode-cli

A command-line client for the [PingCode Open API](https://open.pingcode.com/), plus a single
`pingcode` skill that teaches AI agents how to drive it.

> Work in progress. See `.trellis/tasks/07-31-pingcode-cli-mvp/` for requirements, design and plan.

## Requirements

- Node.js >= 20

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/bin/pingcode.js --help
```

## Security note

A PingCode `client_credentials` token carries **organisation-wide system-administrator authority**
and travels in the URL query string when it is issued. This CLI stores credentials in
`~/.pingcode/config.json` with mode `0600` (a no-op on Windows), redacts secrets from every printed
URL, and only persists credentials when you pass `--save`.
