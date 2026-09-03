import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const BASE_URL = 'http://localhost:11434';
const POLL_SECONDS = 5;
const MAX_MODELS_IN_MENU = 5;
const SYSTEMD_BUS = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_IFACE = 'org.freedesktop.systemd1.Manager';
const ICON_URI = 'resource:///io/github/karol-stelmaczonek/ollama-monitor/icons/ollama-symbolic.svg';

export default class OllamaMonitorExtension extends Extension {
    enable() {
        this._lastModel = null;
        this._lastState = null;
        this._modelsKey = '';
        this._modelsCache = null;
        this._loadedModel = null;
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
        this._resource = Gio.Resource.load(GLib.build_filenamev([this.path, 'ollama-monitor.gresource']));
        Gio.resources_register(this._resource);

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(ICON_URI),
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);
        this._indicator.add_child(box);

        const menu = this._indicator.menu;
        this._modelItem = new PopupMenu.PopupMenuItem('No model loaded', {reactive: false});
        menu.addMenuItem(this._modelItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._loadSubMenu = new PopupMenu.PopupSubMenuMenuItem('Load model', true);
        menu.addMenuItem(this._loadSubMenu);

        this._unloadItem = new PopupMenu.PopupMenuItem('Unload model');
        this._unloadItem.connect('activate', () => this._unloadModel());
        menu.addMenuItem(this._unloadItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._startItem = new PopupMenu.PopupMenuItem('Start Ollama');
        this._startItem.connect('activate', () => this._systemctl('StartUnit'));
        menu.addMenuItem(this._startItem);
        this._stopItem = new PopupMenu.PopupMenuItem('Stop Ollama');
        this._stopItem.connect('activate', () => this._systemctl('StopUnit'));
        menu.addMenuItem(this._stopItem);

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session?.abort();
        this._session = null;
        if (this._resource) {
            Gio.resources_unregister(this._resource);
            this._resource = null;
        }
        this._modelsCache = null;
        this._icon?.destroy();
        this._icon = null;
        this._modelItem?.destroy();
        this._modelItem = null;
        this._loadSubMenu?.destroy();
        this._loadSubMenu = null;
        this._unloadItem?.destroy();
        this._unloadItem = null;
        this._startItem?.destroy();
        this._startItem = null;
        this._stopItem?.destroy();
        this._stopItem = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _http(method, path, body, onDone) {
        const msg = Soup.Message.new(method, `${BASE_URL}${path}`);
        if (!msg) {
            onDone(null);
            return;
        }
        if (body)
            msg.set_request_body_from_bytes('application/json', new GLib.Bytes(body));
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    onDone(bytes ? new TextDecoder().decode(bytes) : null);
                } catch {
                    onDone(null);
                }
            });
    }

    _systemdCall(method, args, onDone) {
        Gio.DBus.system.call(SYSTEMD_BUS, SYSTEMD_PATH, SYSTEMD_IFACE, method, args,
            null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (bus, res) => {
                try {
                    onDone(bus.call_finish(res));
                } catch {
                    onDone(null);
                }
            });
    }

    _systemctl(action) {
        this._systemdCall(action, new GLib.Variant('(ss)', ['ollama.service', 'replace']), result => {
            if (result === null)
                Main.notify('Ollama Monitor', `Failed to ${action} ollama.service`);
        });
    }

    _isServiceActive(onDone) {
        this._systemdCall('GetUnit', new GLib.Variant('(s)', ['ollama.service']), unit => {
            if (unit === null) {
                onDone(false);
                return;
            }
            const unitPath = unit.deepUnpack()[0];
            Gio.DBus.system.call(SYSTEMD_BUS, unitPath, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.systemd1.Unit', 'ActiveState']),
                null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (bus, res) => {
                    try {
                        const state = bus.call_finish(res).deepUnpack()[0].unpack();
                        onDone(state === 'active');
                    } catch {
                        onDone(false);
                    }
                });
        });
    }

    _refresh() {
        this._http('GET', '/api/ps', null, out => {
            if (out === null) {
                this._isServiceActive(isActive =>
                    this._setState(isActive ? 'idle' : 'stopped', null));
                return;
            }
            try {
                const data = JSON.parse(out);
                const models = data.models ?? [];
                this._setState(models.length > 0 ? 'loaded' : 'idle',
                    models.length > 0 ? models[0].name : null);
            } catch {
                this._setState('idle', null);
            }
        });

        this._http('GET', '/api/tags', null, out => {
            if (out === null)
                return;
            try {
                const data = JSON.parse(out);
                const models = (data.models ?? [])
                    .slice()
                    .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
                const key = models.map(m => m.name).join('|');
                if (key !== this._modelsKey) {
                    this._modelsKey = key;
                    this._modelsCache = models;
                    this._rebuildModelList(models);
                }
            } catch {}
        });
    }

    _rebuildModelList(models) {
        this._loadSubMenu.menu.removeAll();

        if (models.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No models installed', {reactive: false});
            this._loadSubMenu.menu.addMenuItem(item);
            return;
        }

        const shown = models.slice(0, MAX_MODELS_IN_MENU);
        for (const m of shown) {
            const isLoaded = this._loadedModel === m.name;
            const sizeGb = (m.size / 1024 ** 3).toFixed(1);
            const item = new PopupMenu.PopupMenuItem(
                `${isLoaded ? '⬤' : '  '} ${m.name}  (${sizeGb} GB)`);
            item.connect('activate', () => this._loadModel(m.name));
            this._loadSubMenu.menu.addMenuItem(item);
        }
        if (models.length > MAX_MODELS_IN_MENU) {
            const more = models.length - MAX_MODELS_IN_MENU;
            const item = new PopupMenu.PopupMenuItem(
                `…and ${more} more (see: ollama list)`, {reactive: false});
            this._loadSubMenu.menu.addMenuItem(item);
        }
    }

    _setState(state, model) {
        if (state === this._lastState && model === this._lastModel)
            return;

        if (state === 'loaded' && model !== this._lastModel && this._lastState !== 'loaded')
            Main.notify('Ollama', `Model loaded: ${model}`);
        if (state !== 'loaded' && this._lastState === 'loaded' && this._lastModel)
            Main.notify('Ollama', `Model unloaded: ${this._lastModel}`);

        this._lastState = state;
        this._lastModel = model;
        this._loadedModel = state === 'loaded' ? model : null;

        if (state === 'loaded') {
            this._icon.opacity = 255;
            this._modelItem.label.text = `Loaded: ${model}`;
        } else if (state === 'idle') {
            this._icon.opacity = 180;
            this._modelItem.label.text = 'Service running, no model loaded';
        } else {
            this._icon.opacity = 100;
            this._modelItem.label.text = 'Service not running';
        }
        this._unloadItem.visible = state === 'loaded';
        this._loadSubMenu.visible = state !== 'stopped';
        this._startItem.visible = state === 'stopped';
        this._stopItem.visible = state !== 'stopped';

        if (this._modelsCache)
            this._rebuildModelList(this._modelsCache);
    }

    _loadModel(name) {
        if (this._loadedModel === name)
            return;
        Main.notify('Ollama Monitor', `Loading ${name}… (may take a moment)`);
        this._http('POST', '/api/generate',
            JSON.stringify({model: name, keep_alive: '30m'}), out => {
                if (out === null)
                    Main.notify('Ollama Monitor', `Failed to load ${name}`);
            });
    }

    _unloadModel() {
        if (!this._loadedModel)
            return;
        this._http('POST', '/api/generate',
            JSON.stringify({model: this._loadedModel, keep_alive: 0}), () => {});
    }
}
