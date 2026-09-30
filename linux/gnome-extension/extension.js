// Coucou companion extension.
//
// Wayland does not let an application place its own windows, keep them above
// the others, or read the pointer outside them. The Shell can, so this
// extension does those things for the Coucou app, over D-Bus on the Shell's own
// bus name. It also puts a small Mochi button in the top bar, next to the clock:
// hovering it peeks at the island, clicking opens or closes it, and its colour
// says what Claude Code is doing. That button replaces the invisible hover
// strip, which used to sit right under the clock and steal its clicks.
// Nothing runs while Coucou is closed: no timers, no polling.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
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
    <method name="SetStatus">
      <arg type="u" direction="in" name="pid"/>
      <arg type="s" direction="in" name="status"/>
    </method>
    <signal name="Activated">
      <arg type="u" name="pid"/>
      <arg type="s" name="what"/>
    </signal>
    <method name="Pointer">
      <arg type="u" direction="in" name="pid"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="d" direction="out" name="x"/>
      <arg type="d" direction="out" name="y"/>
      <arg type="u" direction="out" name="mods"/>
    </method>
  </interface>
</node>`;

// idle | working | attention → body colour of the mini Mochi.
const STATUS_COLOURS = {
    idle: [0.93, 0.93, 0.95],
    working: [0.55, 0.78, 1.0],
    attention: [1.0, 0.72, 0.3],
};
const HOVER_DELAY_MS = 150;

class MochiButton {
    constructor(onActivate) {
        this._status = 'idle';
        this._hoverId = 0;
        this._area = new St.DrawingArea({width: 22, height: 18, y_align: Clutter.ActorAlign.CENTER});
        this._area.connect('repaint', area => this._draw(area));
        this.actor = new St.Button({
            style_class: 'panel-button',
            reactive: true,
            track_hover: true,
            can_focus: true,
            child: this._area,
            accessible_name: 'Coucou',
        });
        this.actor.connect('clicked', () => {
            this._cancelHover();
            onActivate('click');
        });
        this.actor.connect('notify::hover', () => {
            this._cancelHover();
            if (!this.actor.hover)
                return;
            this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY_MS, () => {
                this._hoverId = 0;
                if (this.actor.hover)
                    onActivate('hover');
                return GLib.SOURCE_REMOVE;
            });
        });
        this.actor.hide();
        // Right of the clock, so the date menu keeps the middle of the bar.
        Main.panel._centerBox.add_child(this.actor);
    }

    _cancelHover() {
        if (this._hoverId) {
            GLib.source_remove(this._hoverId);
            this._hoverId = 0;
        }
    }

    setStatus(status) {
        if (!(status in STATUS_COLOURS) || status === this._status)
            return;
        this._status = status;
        this._area.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const [r, g, b] = STATUS_COLOURS[this._status];
        // Soft squircle body.
        const x = 2, y = 1, bw = w - 4, bh = h - 2, rad = 6;
        cr.newSubPath();
        cr.arc(x + bw - rad, y + rad, rad, -Math.PI / 2, 0);
        cr.arc(x + bw - rad, y + bh - rad, rad, 0, Math.PI / 2);
        cr.arc(x + rad, y + bh - rad, rad, Math.PI / 2, Math.PI);
        cr.arc(x + rad, y + rad, rad, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.setSourceRGB(r, g, b);
        cr.fill();
        // Eyes.
        cr.setSourceRGB(0.08, 0.08, 0.1);
        for (const ex of [w / 2 - 4, w / 2 + 4]) {
            cr.newSubPath();
            cr.arc(ex, h / 2, 1.8, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }

    destroy() {
        this._cancelHover();
        this.actor.destroy();
    }
}

class CoucouService {
    constructor() {
        this._ownerPid = 0;
        this._button = new MochiButton(what => {
            if (this._ownerPid)
                this.emit?.('Activated', this._ownerPid, what);
        });
        // pid → MetaWindow of the island, and the last placement asked for, so a
        // window that maps after the request still lands in the right spot.
        this._windows = new Map();
        this._pending = new Map();
        this._createdId = global.display.connect('window-created',
            (_display, win) => this._onWindowCreated(win));
    }

    destroy() {
        global.display.disconnect(this._createdId);
        this._button.destroy();
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
        this._ownerPid = pid;
        this._button.actor.show();
        win.connectObject('unmanaged', () => {
            this._windows.delete(pid);
            if (this._ownerPid === pid) {
                this._ownerPid = 0;
                this._button.actor.hide();
            }
        }, this);
        return win;
    }

    _onWindowCreated(win) {
        if (!this._pending.has(win.get_pid()))
            return;
        // On Wayland the title and the actor only exist once the window maps.
        win.connectObject('shown', () => {
            const pid = win.get_pid();
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

    SetStatus(pid, status) {
        if (pid === this._ownerPid)
            this._button.setStatus(status);
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
        this._service.emit = (name, pid, what) =>
            this._dbus?.emit_signal(name, new GLib.Variant('(us)', [pid, what]));
    }

    disable() {
        this._dbus?.unexport();
        this._dbus = null;
        this._service?.destroy();
        this._service = null;
    }
}
