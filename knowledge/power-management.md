# Power Management: Suspend Policy and a Doze-like Idle Mode

How LuneOS decides to suspend (sleepd, luna-displaymanager, activitymanager), what wakes a suspended device, and the proposed Doze-like idle mode that limits how often it is woken.

## The suspend path today

| Component | Bus name | Role in power |
|---|---|---|
| `luna-displaymanager` | `com.palm.display` | Display state machine (`On`, `Dim`, `Off`, `OffSuspended`, …), idle/lock timeouts, power key; votes in sleepd's suspend handshake via `com.palm.SuspendBlocker` |
| `sleepd` | `com.palm.sleep` / `com.webos.service.sleep` | Decides when to suspend; owns RTC wakeups (`timeout/set`, `time/alarmAdd`); power activities and wakelocks (`activityStart`, `setWakeLock`); shutdown |
| `activitymanager` | `com.webos.service.activitymanager` | Schedules app/service activities (intervals, requirements such as `internet`, `wifi`); arms one sleepd timeout per wake class |
| `nyx-modules` system module | — | RTC alarm and the actual suspend write (logind-based) |

**sleepd suspends as soon as it can.** With the display off, `IdleCheck()` runs every `wait_idle_ms` (500 ms) and triggers suspend when no power activity is active and no client vetoes. A suspend the kernel refuses (a wakeup source was active) backs off exponentially up to `max_retry_backoff_ms` (30 s). With `suspend_with_charger = false` (the LuneOS default) it does not suspend on a charger. `enable_idle_check_thread` must be `true` in `/etc/sleepd.conf`: the OSE compiled-in default is `0`, which never suspends at all.

**Two timer kinds.** `timeout/set` with `wakeup: true` is stored with `wakeup=1` and arms the RTC, so it wakes a suspended device. `wakeup: false` fires only while the device is awake, or on the next resume if it expired during suspend. User alarms go through the separate `time/alarmAdd` / `alarmAddCalendar` path.

**activitymanager batches, but wakes by default.** Scheduled activities sit in a wake queue and a no-wake queue, each backed by a single sleepd timeout. `"smart"` intervals round up to 5/10/15/20/30/60/180/360/720 minutes or whole days and align on a per-boot random base, so same-interval jobs run together. But `Schedule::m_wake` defaults to `true`: every scheduled activity is an RTC wakeup unless it sets `"wake": false`.

## What actually drains an idle device

Measure before changing policy. Over an idle night on the device, record:

- the suspend entry count and sleepd's resume types (`pwrevent_activity`, kernel resume, …)
- `/sys/kernel/debug/wakeup_sources` (or `/sys/power/wakeup_event_list`)
- who arms sleepd wakeups (`timeout` table in `SysTimeouts.db`) and how often

If the wakeups come from HAL or kernel wakelocks (modem, Wi-Fi, a Bluetooth HAL lock such as athena's `hal_bluetooth_lock`), timer policy will not help; fix the source. See debugging.md § "Stage 5 — Idle health" for the CPU and flash metrics to collect alongside.

## Proposed: Doze-like idle mode

Android Doze does not make suspend faster; it limits how often a suspended device is woken, and lets deferred work run together in maintenance windows. In LuneOS the natural owner is sleepd: it already knows the display, charger and activity state, and every RTC wakeup goes through it.

**States.** `ACTIVE → LIGHT_IDLE → DEEP_IDLE`.
- Enter LIGHT_IDLE after a few minutes with the display off and no charger.
- Enter DEEP_IDLE after about 30 minutes; ideally also require the device to be stationary (sensorfw is in meta-luneos).
- Exit to ACTIVE on display on, charger connect, significant motion, or an incoming call or SMS.

**Maintenance windows.** The gaps between windows grow (Android: light every few minutes; deep 15 → 30 → 60 min … up to hours) and reset on exit. During a window the device stays up long enough for batched work to run.

**Wakeup deferral.** While dozing, a `wakeup=1` timeout from a non-exempt app that falls before the next window arms the RTC for the window instead. The stored expiry stays unchanged, so leaving doze restores normal timing at once. The deferral sits in `queue_next_wakeup()` / `timeout_get_next_wakeup()`, which already choose the next wakeup with one SQL query.

**Exemptions.** Never defer user alarms (`time/alarmAdd`, `alarmAddCalendar`), `calendar=1` timeouts, telephony, or app ids on a configured allowlist.

**Power activities.** In DEEP_IDLE outside a window, cap how long non-exempt `activityStart` / `setWakeLock` holders keep the device up.

**Bus API.** A subscribable `com/palm/power/dozeStatus` plus a state-change signal, so activitymanager can aim its wake timer at the next window and optionally hold `internet`/`wifi` requirements unmet between windows.

**Radios.** WoWLAN and Wi-Fi power save are already set by meta-webos-ports udev rules (`80-wifi-wowlan.rules`, `luneos-wifi-powersave`). Whether DEEP_IDLE should drop Wi-Fi between windows is per-device: a Pixel 3a's Wi-Fi reconnects raised the very wakeup sources that refused the next suspend.

**Status.** Proposal, October 2026. A prototype is on a local `doze` branch of sleepd (not upstream); nothing has been measured on a device.
- Opt-in: `[doze] enable = false` by default.
- Light idle starts after 5 min: a 30 s window every 5 min.
- Deep idle starts after 30 min: 1 min windows, with gaps of 15 → 30 → 60 min, capped at 2 h.
- Outside a window, deep idle caps `activityStart` at 10 s.
- The schedule runs on `CLOCK_BOOTTIME`, because monotonic time stops while suspended.
- Alarms that `time/alarmAdd` stores (app id `com.palm.sleep`) and `calendar=1` timeouts are never deferred.
