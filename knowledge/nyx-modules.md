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

**Precedent: haptics (found on sargo and mindphone).** The hybris haptics
module needs the legacy vibrator API (`vibrator_exists()` from libhardware_legacy), which
android-headers 11.0 and newer and the 16.0 GSI no longer provide; the image build failed
until haptics moved to the open-webOS implementation. That is now the halium default.
Rule of thumb: when `nyx-modules-hybris` fails to build against the machine's
android-headers version because an Android API was removed, move that module to the
`nyx-modules` side (`NYXMOD_OW_<X>` in `NYX_MODULES_REQUIRED`) rather than pinning older
headers (the headers version must track the GSI — see device-bringup-yocto.md).

## Wakeup alarms: timerfd, in nyx-modules, and watched

The legacy Android `/dev/alarm` device is missing from many vendor kernels (tissot's
4.9.188 has none; sargo's 4.9.124 still has it), so an RTC-alarm path built on it turns
every call into `ioctl(-1, …)` → EBADF ("Could not open rtc driver. 2" at startup,
"Failed to clear alarm" on every RTC watchdog tick). The alarm code therefore uses
`timerfd_create(CLOCK_REALTIME_ALARM)`, the alarmtimer-backed replacement AOSP itself
moved to. The port also fixed a latent timezone bug: the alarm read used `localtime_r()`
while its caller used `timegm()`, putting "now" one UTC offset in the future.

The system module (alarm, RTC, suspend) lives in **nyx-modules**, not nyx-modules-hybris:
the hybris copy linked nothing but glib, gio, pmlog and nyx-lib, and the only Android
left in it was an `android_` prefix (webOS-ports/nyx-modules-hybris#15). Lessons from the
move that apply to any such relocation:

- **Both system modules registered the identical twelve nyx methods**, so they were
  interchangeable at the API boundary. Check this before assuming two same-named modules
  are alternatives rather than forks.
- **nyx-modules' `system.c` was the evolved one** (logind-based suspend with the direct
  `/sys/power/state` path underneath); the hybris copy only had the direct path — an old
  copy and a new one, not two platform backends.
- `rtc.c` was the only genuinely forked file (18 hunks), and it cost a spin fix written
  twice: the concrete argument for not forking.
- The switch is `NYXMOD_OW_SYSTEM` in `NYX_MODULES_REQUIRED`; nyx-modules-hybris stands
  down by itself (`if(NOT NYXMOD_OW_SYSTEM)`). **Every** halium list needs it (`:halium`
  and `NYX_MODULES_REQUIRED_HALIUM_NO_HAPTICS`), or those machines have no system module.

**Then watch the timer, do not only arm it.** The timerfd was armed and never
read, so the only thing that could report an expiry was the RTC's own interrupt —
and on a device whose RTC cannot be set, that never happens. `alarm.c` now takes a
callback (`wakeup_alarm_set_callback()`, registered by `rtc.c` with the same
function it gives `rtc_add_watch()`), drains the timer on expiry and delivers it.
(Verified on sargo.) Where the
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

udev may tag a hardware keypad `ID_INPUT_KEY` only; Qt's evdevkeyboard discovery needs
`ID_INPUT_KEYBOARD`, so promote it with a udev rule (found on mindphone; see
device-mindphone.md). It looks like "nyx keys don't work" but is a device bring-up fix.

## Placeholders and runtime derivation

Shipped nyx config follows the placeholder rule and the adaptation tiers in
architecture.md: `nyx.conf` once shipped sargo's key nodes as "graceful defaults", which
is exactly the plausible constant the rule forbids. A per-device `nyx.conf` fragment is
Tier 2 debt. Two `luneos-device-config` details found during the mindphone bring-up:
`lshal` needs a per-call watchdog (it hangs forever on an unresponsive HAL and blocked
the whole boot queue), and the fbdev panel-size fallback must read
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

## Torch backends and battery readings that are not what they say

- **`rear_flash` torch.** Samsung flash drivers (rt5033, sm5701, sm5705, ...) offer the
  torch only as `/sys/class/camera/flash/rear_flash` — write-only, "1" on, "0" off — and
  register no LED class device. nyx's led_torch module has a backend for it (after
  MediaTek and the LED class): used where the LED class has nothing and rear_flash is
  writable, or where `[module.led] torch_path` names a plain file. It reports what it
  last set and switches off on close; luneos-device-config's 35-torch-app counts
  rear_flash as a torch. Fix torches in nyx, not per kernel driver.
- **`charge_now` may not be a charge**: Samsung's `sec_battery.c` returns
  `battery->charging_mode` (1) for POWER_SUPPLY_PROP_CHARGE_NOW. nyx treats a charge_now
  under 1 mAh beside a percentage above zero as no reading: stated full capacity times
  the percentage, else -1.
- **Capacity keys:** `design_capacity_mah` is only taken together with
  `full_capacity_mah`; for a gauge that cannot measure the full charge, give the pack's
  rating for both (a LineageOS device tree's power_profile.xml has it as
  `battery.capacity`).

(Found on the Galaxy A3 (2015); see device-a3-2015-halium.md.)
