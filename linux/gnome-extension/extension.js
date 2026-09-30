// Coucou companion extension.
//
// Wayland does not let an application place its own windows, keep them above
// the others, or read the pointer outside them. The Shell can, so this
// extension does exactly those three things for the Coucou app, over D-Bus on
// the Shell's own bus name. Nothing runs while Coucou is closed: every method
// is a direct call, there are no timers and no polling here.

import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OBJECT_PATH = '/io/github/ryanthemechanic/Coucou';
const ISLAND_TITLE = 'Coucou';

const IFACE = `
<node>
  <interface name="io.github.ryanthemechanic.Coucou">
    <method name="Display">
      <arg type="s" direction="in" name="pref"/>
      <arg type="d" direction="out" name="x"/>
      <arg type="d" direction="out" name="y"/>
      <arg type="d" direction="out" name="width"/>
      <arg type="d" direction="out" name="height"/>
      <arg type="d" direction="out" name="scale"/>
    </method>
    <method name="Place">
      <arg type="u" direction="in" name="pid"/>
      <arg type="d" direction="in" name="width"/>
      <arg type="d" direction="in" name="height"/>
      <arg type="s" direction="in" name="pref"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="Activate">
      <arg type="u" direction="in" name="pid"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="Pointer">
      <arg type="u" direction="in" name="pid"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="d" direction="out" name="x"/>
      <arg type="d" direction="out" name="y"/>
      <arg type="u" direction="out" name="mods"/>
    </method>
  </interface>
</node>`;

class CoucouService {
    constructor() {
        // pid → MetaWindow of the island, and the last placement asked for, so a
        // window that maps after the request still lands in the right spot.
        this._windows = new Map();
        this._pending = new Map();
        this._createdId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));
    }

    destroy() {
        global.display.disconnect(this._createdId);
        for (const actor of global.get_window_actors()) {
            actor.disconnectObject(this);
            actor.meta_window?.disconnectObject(this);
        }
        this._windows.clear();
        this._pending.clear();
    }

    _monitorIndex(pref) {
        return pref === 'cursor'
            ? global.display.get_current_monitor()
            : Main.layoutManager.primaryIndex;
    }

    _isIsland(win, pid) {
        return win && win.get_pid() === pid && win.get_title() === ISLAND_TITLE;
    }

    _find(pid) {
        const cached = this._windows.get(pid);
        if (cached && this._isIsland(cached, pid))
            return cached;
        const win = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(w => this._isIsland(w, pid));
        if (!win)
            return null;
        this._windows.set(pid, win);
        win.connectObject('unmanaged', () => this._windows.delete(pid), this);
        return win;
    }

    _onWindowCreated(win) {
        const pid = win.get_pid();
        if (!this._pending.has(pid))
            return;
        // Title and size arrive with the first frame on Wayland.
        const actor = win.get_compositor_private();
        if (!actor)
            return;
        actor.connectObject('first-frame', () => {
            const want = this._pending.get(pid);
            if (want && this._isIsland(win, pid))
                this._apply(win, want);
        }, this);
    }

    _apply(win, {width, height, pref}) {
        const index = this._monitorIndex(pref);
        // The work area already leaves the top bar alone: Mochi hangs just below it.
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        const x = Math.round(area.x + (area.width - width) / 2);
        const y = area.y;
        win.move_frame(false, x, y);
        if (!win.is_above())
            win.make_above();
        if (!win.is_on_all_workspaces())
            win.stick();
    }

    Display(pref) {
        const index = this._monitorIndex(pref);
        const g = global.display.get_monitor_geometry(index);
        return [g.x, g.y, g.width, g.height, global.display.get_monitor_scale(index)];
    }

    Place(pid, width, height, pref) {
        const want = {width, height, pref};
        this._pending.set(pid, want);
        const win = this._find(pid);
        if (!win)
            return false;
        this._apply(win, want);
        return true;
    }

    Activate(pid) {
        const win = this._find(pid);
        if (!win)
            return false;
        Main.activateWindow(win);
        return true;
    }

    Pointer(pid) {
        const win = this._find(pid);
        if (!win)
            return [false, 0, 0, 0];
        const [px, py, mods] = global.get_pointer();
        const r = win.get_frame_rect();
        return [true, px - r.x, py - r.y, mods];
    }
}

export default class CoucouExtension extends Extension {
    enable() {
        this._service = new CoucouService();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(IFACE, this._service);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._service?.destroy();
        this._service = null;
    }
}
