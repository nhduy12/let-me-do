# let-me-do — marketplace

This repository is a Claude Code [plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces) that ships a single plugin: **`lmd`** (autopilot pipeline that drives a task from intake to commit).

## Install

```bash
# 1. Add this marketplace
claude plugin marketplace add nhduy12/let-me-do

# 2. Install the plugin
claude plugin install lmd@let-me-do --scope project
```

After install Claude Code prompts for three config values:

- `database_uri` (sensitive) — Postgres connection string for the brain DB. Format: `postgresql://ai_agent:<pwd>@<host>:5432/<db_name>`
- `statement_timeout_ms` (default `5000`)
- `max_rows` (default `500`)

## Layout

```
let-me-do/                                 # marketplace root (git repo root)
├── .claude-plugin/
│   └── marketplace.json                  # marketplace manifest — lists `lmd` plugin
├── plugins/
│   └── lmd/                              # the plugin itself
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .mcp.json
│       ├── agents/                       # scouter, code-planner, plan-reviewer, developer, tester, reviewer, committer
│       ├── skills/                       # 12 user-invokable skills
│       ├── brain/                        # MCP server (Node, stdio) + Postgres schema
│       └── README.md                     # full plugin documentation
├── .gitignore
├── LICENSE                                # MIT
└── README.md                              # this file
```

Full plugin documentation: [`plugins/lmd/README.md`](./plugins/lmd/README.md).

## Updating

When the marketplace is updated:

```bash
claude plugin marketplace update let-me-do
claude plugin install lmd@let-me-do --scope project --upgrade
```

## License

MIT. See [LICENSE](./LICENSE).
