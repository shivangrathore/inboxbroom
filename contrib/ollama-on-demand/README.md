# Ollama on demand (Linux, systemd user units)

Instead of a permanently running Ollama daemon, these units start `ollama serve` on the first
connection to `localhost:11434` and stop it 3 minutes after the last one. They also set
`OLLAMA_ORIGINS=moz-extension://*,chrome-extension://*` so Firefox extensions may call the API.

```sh
./install.sh
```

How it works: `ollama-proxy.socket` listens on 11434 → `systemd-socket-proxyd` forwards to
`ollama serve` on 11435 → proxy exits when idle → `StopWhenUnneeded` stops the backend.
The model itself is unloaded from VRAM by the extension's `keep_alive` setting (default 1 min).

Do not run the system-wide `ollama.service` at the same time (port clash).

**Not on Linux / no systemd?** Just run Ollama normally with the origin allowed:

```sh
OLLAMA_ORIGINS="moz-extension://*,chrome-extension://*" ollama serve
```
