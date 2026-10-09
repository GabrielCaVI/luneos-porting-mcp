# Nyx Modules: Module Selection and nyx.conf

How LuneOS picks and configures its nyx modules: NYX_MODULES_REQUIRED per machine, nyx.conf values derived at boot, and the rules for what must be measured.

Nyx is the webOS hardware portability layer: `nyx-lib` defines the API, `nyx-modules`
implements it against sysfs/evdev, and `nyx-modules-hybris` implements the
Android-backed parts via libhybris and binder. Which side provides each module is chosen
per machine in one shared `.inc`; the device-describing values (input nodes, power-supply
paths) are read at runtime from `/etc/nyx.conf`. No per-machine `.cmake` file exists any
more (dropped in meta-webos-ports `70609d4f4`, Sep 2026), and a new machine builds
without adding anything to the nyx recipes.

## The three pieces

| Component | What it is |
|---|---|
| `nyx-lib` | the nyx API that LuneOS services (LunaSysService etc.) call |
| `nyx-modules` | modules built from LuneOS's fork of webOS-OSE nyx-modules: battery, charger, keys, touchpanel, LED, torch, haptics, ALS, deviceinfo, system, … — driven by sysfs paths and evdev nodes |
| `nyx-modules-hybris` | the Android side: device info, haptics, GPS (over the GNSS HAL on hwbinder) and optionally the camera-service torch. It builds a module exactly when `nyx-modules` does not (`if(NOT NYXMOD_OW_<X>)`) |

## Module selection: `nyx-modules-machines.inc`

Both recipes `require recipes-webos-ose/nyx-modules/nyx-modules-machines.inc`
(meta-webos-ports `meta-luneos`), which sets `NYX_MODULES_REQUIRED` per machine
override; both CMake projects parse it, so the two can no longer disagree and ship a
module twice or not at all. The halium default:

```bitbake
NYX_MODULES_REQUIRED:halium = "\
    NYXMOD_OW_BATTERY;\
    NYXMOD_OW_CHARGER;\
    NYXMOD_OW_DISPLAY;\
    NYXMOD_OW_HAPTICS;\
    NYXMOD_OW_KEYS;\
    NYXMOD_OW_LED;\
    NYXMOD_OW_MSMMTP;\
    NYXMOD_OW_OSINFO;\
    NYXMOD_OW_SYSTEM;\
    NYXMOD_OW_TOUCHPANEL;\
"
```

A module listed is built by `nyx-modules`; one absent (here `DEVICEINFO`, `GPS`) is left
to `nyx-modules-hybris`. Any machine carrying the `halium` override is covered without an
entry of its own; a machine that needs a different set adds one line (athene, mako,
mako-halium, onyx, oxygen and sagit use `NYX_MODULES_REQUIRED_HALIUM_NO_HAPTICS`, which
leaves haptics to the hybris side). `NYXMOD_OW_LEDTORCH` is deliberately not listed:
undefined means the sysfs torch in `nyx-modules`; `FALSE` would select the hybris
camera-service torch, which needs droidmedia.

`PACKAGE_ARCH = "${MACHINE_ARCH}"` stays on both recipes: the selection is per machine.

## Device values: `/etc/nyx.conf`

The `nyx-conf` package (meta-luneos `recipes-luneos/nyx-conf`, per-machine copies under
`nyx-conf/<machine>/`, a `halium` one for the shared rootfs) ships `/etc/nyx.conf` with
one section per module:

```ini
[module.keys]
paths=
[module.touchpanel]
path=
[module.battery]
sysfs_path=
extra_sysfs_paths=
full_capacity_mah=
design_capacity_mah=
[module.charger]
usb_sysfs_path=
ac_sysfs_path=
```

On halium every value is shipped empty. `luneos-device-config` rewrites the file at boot
from values it derives (keys from the input devices advertising `KEY_POWER` or a volume
key, the touchscreen from the one `ID_INPUT_TOUCHSCREEN` device, batteries and chargers
from `/sys/class/power_supply`) or from the adaptation's `deviceinfo` keys where they
cannot be derived (see deviceinfo-reference.md § LuneOS runtime keys), and bind-mounts
the result over the shipped file. An empty value means nyx's own detection. Fix a wrong
value on a live device by editing the deviceinfo key, not the generated file.

## When to flip a module back to the OW implementation

**Precedent (mindphone, 2026-08-26; sargo before it): haptics.** The hybris haptics
module needs the legacy vibrator API (`vibrator_exists()` from libhardware_legacy), which
android-headers 11.0 and newer and the 16.0 GSI no longer provide; the image build failed
until haptics moved to the open-webOS implementation. That is now the halium default.
Rule of thumb: when `nyx-modules-hybris` fails to build against the machine's
android-headers version because an Android API was removed, move that module to the
`nyx-modules` side (`NYXMOD_OW_<X>` in `NYX_MODULES_REQUIRED`) rather than pinning older
headers (the headers version must track the GSI — see device-bringup-yocto.md).

## Wakeup alarms: out of /dev/alarm, out of nyx-modules-hybris, and watched

The hybris system module's RTC-alarm path historically used the legacy Android
`/dev/alarm` device, which many newer vendor kernels simply lack — tissot's
4.9.188 has none while sargo's 4.9.124 still ships it — so every
`android_alarm_*` call became `ioctl(-1, …)` → EBADF ("Could not open rtc
driver. 2" at startup, "Failed to clear alarm" on every RTC watchdog tick).
Ported (12 Sep 2026) on nyx-modules-hybris branch `herrie/alarm-dev-optional`:
`f0f61a2` guards the ioctl paths, then `a1efcfc` moves the whole file to
`timerfd_create(CLOCK_REALTIME_ALARM)` — the alarmtimer-backed replacement AOSP
itself moved to — verified working on both devices. The port also fixed a
latent timezone bug: `android_alarm_read()` used `localtime_r()` while its
caller used `timegm()`, putting "now" one UTC offset in the future and pushing
near-term alarms out by that much.

**Moved into nyx-modules (25 Sep 2026), because after that it was not Android
code at all.** Tofee asked exactly that on webOS-ports/nyx-modules-hybris#15, and
it checks out: the hybris system module's CMake links nothing but glib, gio, pmlog
and nyx-lib, and the only Android left anywhere in it was the `android_` prefix on
the alarm functions. Branches: nyx-modules `herrie/system-alarm`,
nyx-modules-hybris `herrie/drop-system-module`.

What the move involves, and what to check when doing this kind of relocation:

- **Both system modules registered the identical twelve nyx methods**, so they are
  interchangeable at the API boundary and the swap is invisible to callers. Check
  this before assuming two same-named modules are alternatives rather than forks.
- **nyx-modules' `system.c` was the evolved one**: logind-based suspend with the
  direct `/sys/power/state` path kept underneath, where the hybris copy only ever
  had the direct path. Not two platform backends — an old copy and a new one.
- `rtc.c` was the only genuinely forked file (18 hunks). It cost a spin fix
  written twice in one afternoon, which is the concrete argument for not forking.
- `util.c`/`util.h` in the hybris copy were in neither the CMake `SOURCES` nor any
  include — dead files nobody noticed because nothing built them.
- The switch is one line: `NYX_MODULES_REQUIRED:halium` gains `NYXMOD_OW_SYSTEM`.
  The gate in nyx-modules-hybris was already `if(NOT NYXMOD_OW_SYSTEM)`, so that
  repo has always stood down when nyx-modules provides a system module. **Both**
  halium lists need it (`:halium` and `NYX_MODULES_REQUIRED_HALIUM_NO_HAPTICS`,
  used by athene/mako/mako-halium/onyx/oxygen/sagit) before the deletion
  lands, or those devices end up with no system module at all.

**Then watch the timer, do not only arm it.** The timerfd was armed and never
read, so the only thing that could report an expiry was the RTC's own interrupt —
and on a device whose RTC cannot be set, that never happens. `alarm.c` now takes a
callback (`wakeup_alarm_set_callback()`, registered by `rtc.c` with the same
function it gives `rtc_add_watch()`), drains the timer on expiry and delivers it.
Measured on sargo: the alarm callback check failed identically with the moved
module *and* with the pre-move one restored, and passes with the watch. Where the
RTC works, `rtc_clear_alarm()` disarms the timer before reporting its own expiry,
so only one of the two is delivered.

**Who owns time in webOS, which is why none of this touches the RTC.**
LunaSysService is the authority: `NTPClock.cpp` spawns `sntp` itself and
`TimePrefsHandler.cpp` applies the result with `settimeofday()`; `ClockHandler`
tracks sources by tag — `manual`, `micom`, `system`. **nyx has no set-RTC call at
all** (`nyx_system_query_rtc_time` has no write counterpart, and there is no
`NYX_SYSTEM_SET_RTC_*` method), so nothing in this stack was ever meant to write
the hardware clock. meta-luneos also removes `timesyncd`, `timedated`, `networkd`,
`resolved` and `nss-resolve` from systemd's PACKAGECONFIG on purpose — those roles
belong to webOS services, which is also why there is no `timedatectl` on a device.
Do not "fix" a clock problem by adding timesyncd; it fights the design.

The gap that leaves: on a TV the `micom` keeps time while the set is unplugged. A
phone has no micom, so if its RTC cannot be written, **nothing persists time at
all** and the system starts at 1970 until sntp reaches the network. See
device-sargo.md for what that costs and why the kernel cannot fix it there.

### Host tests for this module

`src/system/tests/run-host-tests.sh` — 15 cases, no device and no root. Ten cover
the alarm layer (arming at the absolute expiry, the two-second floor, the same
expiry twice being a no-op, clear, calls before open, the read/timegm round trip in
four timezones, and the three delivery cases) and five cover the RTC watch against
a pipe standing in for `/dev/rtc`. Each group was mutation-checked: restoring the
old `return TRUE`, the old read guard, or removing the two
`_wakeup_alarm_watch()` calls each fails a specific case. `nyx-test-system` drives
the same paths through the real module on a device (`rtc-time`, `next-alarm`,
`set-alarm`, `clear-alarm`, `watch`), and reports who holds `/dev/rtc` when it
cannot open it — which on a running system is always sleepd, exclusively, for its
whole life.

## Copy-paste is fiction until verified on hardware

From the mindphone bring-up: its nyx values (keypad `/dev/input/event1`, touchpanel
`/dev/input/event2`, battery/charger sysfs paths) were a rosy copy-paste from another
machine. Every value copied from another device starts as an unverified guess. Verify
with `evtest` (which node is the keypad, which the touchscreen) and
`ls /sys/class/power_supply/` on the running device, then pin what derivation gets wrong
with the adaptation's `deviceinfo` keys.

A better measuring tool than raw `evtest`: **`evdev_trace -i`** (from mce-tools, used by
SFOS porters — https://sailfishos.wiki/books/hardware/page/hadk-hot) enumerates every
input device *with capability decoding*, so the node identifies itself: the vibrator is
the device advertising `EV_FF`/`FF_RUMBLE`, the headphone jack the one with
`SW_HEADPHONE_INSERT`/`SW_MICROPHONE_INSERT`, and touchscreen/keypad nodes show their
event types instead of you triggering events by hand. Pin touchpanel/keypad values
from that output — measured, not copy-pasted.

Concrete mindphone outcomes of that verification: the keypad really was `mtk-kpd` on
event1, but udev tagged it `ID_INPUT_KEY` only — Qt's evdevkeyboard discovery needs
`ID_INPUT_KEYBOARD`, promoted via a udev rule (a device bring-up fix, not a nyx one, but
found while chasing "nyx keys don't work"-shaped symptoms). The machine conf's display
values were also fiction: 1080x2340 copy-paste vs the real 480x800@~187ppi panel.

## The placeholder rule

Established 2026-08-24 and directly about nyx config:

> Shipped config files are placeholders, not defaults. A generic config may exist in the
> image — the generators need something to bind-mount over — but the device-describing
> values in it must be obviously invalid: zeros, empty lists, `/dev/input/PLACEHOLDER`.
> A plausible constant is worse than a broken one, because it is right often enough that
> the devices where it is wrong never announce themselves.

The incident list includes nyx directly: **`nyx.conf` shipped sargo's key nodes as
"graceful defaults"** (alongside `luna-platform.conf` shipping `DPI=445` that
`50-luna-platform` then read back as a fallback, and `surface-manager.env` shipping
sargo's touchscreen node). Two rules follow:

1. Never read a value back out of the file you generate — it is a placeholder, not a
   source.
2. When a fallback is genuinely needed so an unknown device still boots, put it in the
   generator (where it is visibly a fallback), not in the config (where it reads as a
   measurement).

Values that are not derived at all stay as working values, marked as such in the file —
a placeholder there would break something with nothing to replace it.

## Where nyx config is heading: runtime derivation

The target architecture (`luneos-device-config`, see architecture.md) applies to nyx
config exactly as to display geometry:

- **Tier 0 (derive at runtime)** — the goal for everything: input nodes, battery/charger
  sysfs paths and the like should come off the running device (udev/sysfs enumeration,
  Android props, the vendor's own init rc files) rather than shipping per device.
  `luneos-device-config` resolves `/usr/share/luneos/adaptations/<codename>/` and overlays
  it over `/etc` + `/usr/lib/luneos/device/` via bind-mounts (overlayfs when the kernel
  has it), re-evaluated every boot so the rootfs stays universal.
- **Tier 1 (`deviceinfo`)** — only what cannot be read off a running device.
- **Tier 2 (sparse file overlay)** — last resort; adding a file requires stating why it
  cannot be derived. A per-device `nyx.conf` fragment is Tier 2 debt, to be repaid.

Related runtime-derivation fixes that landed during mindphone bring-up: the
`luneos-device-config` lshal per-call watchdog (lshal hangs forever on an unresponsive
HAL and blocked the whole boot queue), and the panel-size fbdev fallback reading
`/sys/class/graphics/fb0/modes` — **not** `fb0/mode`, which empties once the compositor
owns the panel.

## Charger `online` is not a boolean

The power_supply ABI defines `online` as 0 offline, 1 online (fixed voltage),
2 online (programmable voltage). `core_charger_read_status()` used to accept only
`== 1`, so MediaTek's mt6375 charger (`online=2`, `status=Charging`) read as
unplugged: `chargerStatusQuery` said `Charging:false` with the cable in, and
batteryd's critical-level check (which only runs while nothing charges) could
power the phone off on the charger. Fixed in `nyx-modules` `919ab0c`
(`herrie/fix-charger`): any positive value is online; a missing node reads -1.
Check `cat <supply>/online` whenever charging detection is wrong.

## Checklist: adding nyx support for a new machine

1. Nothing to add for a halium machine: `NYX_MODULES_REQUIRED:halium` covers it. Add a
   line to `nyx-modules-machines.inc` only when the machine needs a different module set.
2. Keep `DEVICEINFO` and `GPS` on the hybris side. If a hybris module cannot build
   against the machine's android-headers, move that one module to the `nyx-modules`
   side (haptics is the known case and is already there for halium).
3. Let `luneos-device-config` derive keys, touchscreen and power supplies; check the
   generated `/etc/nyx.conf` on the device, and pin only what it gets wrong with
   `deviceinfo` keys — by name, not by event number.
4. Do not invent plausible values for hardware you have not probed — obviously-invalid
   placeholders beat plausible constants.

## Samsung devices: rear_flash torch and sec-battery's charge_now (8 Oct 2026)

- **Torch.** Samsung's flash drivers (rt5033 on the Galaxy A3 (2015), sm5701, sm5705, ...) offer the torch
  only as `/sys/class/camera/flash/rear_flash` — write-only, "1" on, "0" off — and register no LED class
  device. nyx's led_torch module has a fourth backend for it (after MediaTek and the LED class): used where
  the LED class has nothing and rear_flash is writable, or where `[module.led] torch_path` names a plain
  file. It reports what it last set and switches off on close. luneos-device-config's 35-torch-app counts
  rear_flash as a torch, so the Flashlight app is not hidden. Fix it in nyx, not per kernel driver.
- **charge_now is not a charge on sec-battery**: `sec_battery.c` returns `battery->charging_mode` (1) for
  POWER_SUPPLY_PROP_CHARGE_NOW, so the battery app showed 0 mAh. nyx treats a charge_now under 1 mAh beside
  a percentage above zero as no reading: stated full capacity times the percentage, else -1.
- **Capacity keys:** `design_capacity_mah` is only taken together with `full_capacity_mah`; for a gauge
  that cannot measure the full charge, give the pack's rating for both (a LineageOS device tree's
  power_profile.xml has it as `battery.capacity`).
