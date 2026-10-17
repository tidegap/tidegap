---
id: install
label: Install
---

<!-- source: apps/web/public/install.md, QUICKSTART.md -->
Tidegap is an MCP server that runs your agent's non-urgent tasks at the cleanest grid hour before a deadline. Pick your host, copy one command, and restart the host.

<!-- embed:install-picker -->

Agents can read the same steps as plain text at [/install.md](/install.md).

### Run the tick daemon {#tick}

The MCP server queues tasks but runs no clock. The CLI's tick sends due tasks to the provider. Install it once:

```bash
npm install -g @tidegap/cli
tidegap install --laptop   # launchd job plus wake events (macOS)
tidegap install --server   # launchd job only
```

Without the daemon, tasks wait in the queue. Run one pass by hand with `tidegap tick --once`.

### Confirm it worked {#confirm}

Ask the agent to call `schedule_task` with `dry_run: true`. The reply shows a chosen window and an estimated carbon figure, and nothing is saved.

```json
{
  "tool": "schedule_task",
  "args": { "prompt": "ping", "deadline": "<24h from now in ISO-8601>", "dry_run": true }
}
```

### Libraries {#libraries}

Call the scheduler from your own code instead of an agent host:

```bash
npm install @tidegap/core
pip install tidegap   # Python 3.11 or later, library only
```
