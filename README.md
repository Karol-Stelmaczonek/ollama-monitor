# Ollama Monitor — GNOME Shell Extension

A minimal top-bar indicator for [Ollama](https://ollama.com) on GNOME (Fedora Workstation, GNOME 45+).

Shows the currently loaded model right in the top bar, next to the network/power widgets, with quick controls and desktop notifications when models load or unload.

## Features

- **Top-bar icon** (GNOME symbolic llama glyph, follows theme color):
  - full opacity — model loaded in VRAM
  - dimmed — service running, no model loaded
  - heavily dimmed — service stopped
- **Dropdown** shows the full state: loaded model name, model list with sizes, and all actions
- **Menu actions**:
  - *Unload model* — frees VRAM instantly (sends `keep_alive: 0`)
  - *Start / Stop Ollama* — passwordless via a polkit rule (see below)
- **Notifications** when a model loads or unloads — useful to see when a background agent (OpenCode, etc.) pulls a model into VRAM
- Polls `http://localhost:11434/api/ps` every 5 s (negligible overhead)

## Install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/ollama-monitor@localhost
cp extension.js metadata.json ollama-monitor.gresource \
    ~/.local/share/gnome-shell/extensions/ollama-monitor@localhost/
gsettings set org.gnome.shell disable-user-extensions false
gnome-extensions enable ollama-monitor@localhost
```

To rebuild the bundled GResource after changing the icon: `npm run build`
(requires `glib2-devel`).

On Wayland, a freshly installed extension is only discovered after logging out and back in.

## Passwordless start/stop (optional)

The menu's Start/Stop uses `systemctl start/stop ollama`, which normally prompts for a password. To allow it silently for wheel-group users, drop this into `/etc/polkit-1/rules.d/49-ollama-user.rules`:

```javascript
polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        subject.isInGroup("wheel") &&
        action.lookup("unit") == "ollama.service") {
        return polkit.Result.YES;
    }
});
```

## Requirements

- GNOME Shell 45+ (tested on GNOME 50, Fedora 44)
- Ollama listening on `localhost:11434`
- `curl` available in PATH (used for polling; no Python/Node dependency)

## Uninstall

```bash
gnome-extensions disable ollama-monitor@localhost
rm -rf ~/.local/share/gnome-shell/extensions/ollama-monitor@localhost
```

## Icon

`ollama-symbolic.svg` is an original llama-head glyph drawn for this extension in the
GNOME symbolic icon style, bundled as a GResource (`ollama-monitor.gresource`) so the
extension is fully self-contained and the icon recolors with the theme. It is **not**
the official Ollama logo; no affiliation with or endorsement by Ollama is implied.

## License

MIT

## Publishing

Distributed on GitHub. The namespace `karol-stelmaczonek.github.io` refers to the author's
GitHub account, per the extensions.gnome.org review guidelines for extension UUIDs.
