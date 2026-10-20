# Device: goyavewifi (Samsung Galaxy Tab 3 Lite 7.0 Wi-Fi, SM-T113)

Samsung Galaxy Tab 3 Lite 7.0 Wi-Fi SM-T113 (`goyavewifi`, Spreadtrum SC7730S), 32-bit, Tier B on the halium_arm 16.0 GSI through a Samsung `sboot` that ignores the boot-image command line. The container and the graphics HALs run and the UI draws; the rest of the hardware is untested.

Nobody who works on it owns the tablet. A tester flashes one kit per round with Odin and sends logs; every round is a log analysis, a fix and a small update zip (debugging.md § Remote bring-up through a tester).

## Status (as of 19 Oct 2026)

Hardware-verified by a tester on an SM-T113 unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Install, boot to systemd, LuneOS services | works | Odin to partition `KERNEL`; `/data` formatted |
| Android container (LXC) | works | init, servicemanager, hwservicemanager, vold, keymaster, audio/bluetooth/wifi/usb HAL services run |
| Graphics HALs | work | `vendor.gralloc-2-0` and `vendor.hwcomposer-2-1` load and stay up from the v14 vendor (12 Oct); surface-manager runs with `-platform hwcomposer` |
| Display | draws | 16 Oct: the UI is upright in portrait with compositor rotation r270 (r90 is upside down); needs `deviceinfo_hwc_no_hw_fb` and `deviceinfo_fb_kick` (§ Subsystem notes). Not yet re-run on a build of our own with both |
| Touch | works | taps land where drawn under r270, with no `deviceinfo_touch_rotate` (16 Oct) |
| Audio | untested | there was no droid card until the vendor got the legacy `audio_policy.conf` (§ Subsystem notes) |
| Wi-Fi, BT, sensors, camera | untested | |

## Platform facts

- SoC SC7730S (`sc8830`), 4x Cortex-A7, Mali-400, 1 GiB RAM, 1024x600 MIPI DSI (~169 ppi), BCM4343 Wi-Fi/BT, eMMC (`sprd-sdhci.3`).
- The panel is native landscape, but the tablet is held in portrait: Android runs it as 600x1024 with `ro.sf.hwrotation=270`. The MELFAS MMS449 touchscreen reports portrait coordinates (X 0..600, Y 0..1024).
- Stock Android 4.4.4, kernel 3.10.17. The kernel partition is called **`KERNEL`**, not `boot`.
- No modem, no GPS.

## Kernel

Community Spreadtrum tree (samsung-sc8830, branch hybris-14.1, 3.10.103) with a LuneOS delta, branch `goyavewifi/3.10/hybris-14.1` in shr-distribution/linux. What this tree lacked, in the order the logs showed it (each one a tester round; the generic list is kernel-porting.md § Legacy 3.x kernels):

| Missing | Symptom | Fix |
|---|---|---|
| `seccomp` (383), `getrandom` (384) syscalls | container init exits 127 | wire/backport (code was in the tree) |
| 64-bit binder ABI (`ANDROID_BINDER_IPC_32BIT` promptless and on), then `get_user()` of 8-byte types | `Binder driver protocol(7) does not match user space protocol(8)` | make the option selectable, turn it off, backport ARM 8091/2 |
| ambient capabilities | init: "capabilities requested but the kernel does not support ambient capabilities"; apexd-bootstrap fails on loop devices (EACCES), `reboot_on_failure` | backport |
| `O_TMPFILE` (3.11) | `tombstoned` exits 1: `openat(".", O_TMPFILE) = -EISDIR` | backport series + ext3/ext4 `->tmpfile()` |
| `memfd_create` + sealing | bionic's libc calls it | copy from the A3 (2015) 3.10 tree |

All five were present in a sibling port's tree (a3-2015-halium 3.10.108, sm-t520 3.4, hammerhead).

## Boot image

v0 header, page 2048, plus a trailing Spreadtrum device-tree table (`"SPRD"`, one DTB per board revision 2, 3, 4), built with a custom `mksprdboot.py`; the stock image rebuilds bit-identical from its parts. The command line is in § Device-specific traps.

## Vendor and GSI

LineageOS 16.0 (Android 9, VNDK 28) built from the sc8830-Bringup trees in a Halium 9.0 tree, converted by halium-legacy-vendor, on the 32-bit `halium_arm` 16.0 GSI. The 15.1 (Android 8.1) vendor was dropped: the GSI's VNDK v27 APEX is empty and that build has no composer HAL.

Device-tree edits the 16.0 userspace needed (all in the shared Halium tree, so keep them as patches):

- `fstab.sc8830`: drop `encryptable=footer` from `/data`; Android 16's libfstab rejects FDE and vold then loads no fstab at all.
- `init.sc8830.rc`: remove the `persdata` wait/mount (the device does not exist; the `wait` stalls init), and `stop media.swcodec` (it aborts every 5 s with "gralloc-mapper is missing").
- `hidl.mk`: add `android.hardware.graphics.{allocator@2.0,composer@2.1}-service`; the vendor had only the `-impl` libraries.

Converter-side: `libft2.so` (gsi-building.md § Before deriving, item 5), reached here as gralloc -> libdither -> libandroid_runtime -> libpdfium -> libft2; and shims for the framework copies the vendor brings (libgui, libmedia, libandroid_runtime and what they pull in), whose missing bionic symbols surfaced one per round until the scan was made version-aware.

## Yocto

Layer `meta-smartphone/meta-samsung`, `MACHINE=goyavewifi`; status file `meta-samsung/conf/machine/goyavewifi-STATUS.md`, the round-by-round log findings. Kernel `linux-samsung-goyavewifi`, Android side `android-system-image-goyavewifi`, adaptation `goyavewifi-deviceinfo` (luneos-device-config). The Android-side changes of 14-19 Oct are on meta-smartphone `herrie/20261019` (shr-distribution/meta-smartphone#200, open as of 20 Oct 2026).

## Install

Odin the LineageOS recovery, format `/data`, `adb sideload` the `luneos-dev-package` zip (a recovery package like hammerhead's and tenderloin's). The boot image and the `enable_adb` debug image go to `KERNEL` with Odin. A round's kit re-uses the previous ramdisk with the new kernel and the same three DTBs, so the kernel is the only variable.

## Subsystem notes

**Display: two Spreadtrum switches.** `deviceinfo_hwc_no_hw_fb=1` makes libhybris' hwcomposer window leave out `GRALLOC_USAGE_HW_FB`: on this gralloc0 vendor the framebuffer-backed buffers have no dma-buf fd and cannot be passed over hwbinder, and the Mali Utgard EGL overruns a `malloc(0)` sized from the framebuffer count, so every `eglSwapBuffers` failed with `EGL_BAD_SURFACE` (needs libhybris `0004-hwcomposer-window-allow-leaving-out-GRALLOC_USAGE_HW_FB.patch`). `deviceinfo_fb_kick=1` runs `luneos-fb-kick` once the compositor is up: `sprdfb` keeps scanning out the Samsung logo until the framebuffer is panned, and the SPRD composer HAL never pans; the kick pans to 0,0 twice, because sprdfb swallows the first pan after boot. Both are in meta-webos-ports (luneos-device-config, luna-surfacemanager).

**Audio.** The LineageOS 16 build keeps its policy in the legacy `/system/etc/audio_policy.conf`, which the plain GSI does not have; without a copy (`HALIUM_LEGACY_COPY_FILES`) there was no droid card.

**Stubbed services.** `stubbed-services.d/<codename>` (pre-start.d/50-stub-services): `lmkd` (Android 16's links libmemevents, whose static constructor needs BPF; `critical`, restarted every 5 s with a crash dump), `gpsd` (no GPS; exits 1), the memtrack HAL (exits 1, cause not found).

**Wi-Fi and Bluetooth stay on the host.** `vendor.wifi_hal_legacy` and `vendor.bluetooth-1-0` are skipped (`deviceinfo_android_skip_services`), as on the SM-T520 and the A3 (2015).

## Open issues

- Display with both switches on a build of our own; then Wi-Fi, Bluetooth, audio and sensors.
- `tombstoned` should now work with O_TMPFILE; unconfirmed on the device.
- vold's binder `BINDER_WRITE_READ` returned EFAULT once in three boots on the ambient-caps kernel and not since; cause unknown, possibly a race.
- No cgroup v2 hierarchy under `/sys/fs/cgroup/system`; init continues without process groups.
- vendor `libskia.so` is not provided (camera.sc8830.so); the camera is not attempted.

## Device-specific traps

- **`sboot` builds its own kernel command line and drops the boot image's**; only the kernel's `CONFIG_CMDLINE` reaches the kernel. Everything the kernel or LuneOS needs from it (`androidboot.hardware=sc8830`, `androidboot.selinux=permissive`, `enable_adb` for the debug image) goes into `CONFIG_CMDLINE`. Measured from `/proc/cmdline` in the recovery, not assumed.
- The kernel partition is `KERNEL`, not `boot`.
- An APEX service cannot be stubbed with `stubbed-services.d` (the container's apexd mounts its own copy): stop it from the vendor `init.sc8830.rc` instead.

## Sources

- https://github.com/samsung-sc8830/android_kernel_samsung_sc8830 (branch `hybris-14.1`)
- https://github.com/mertsan2007/android_kernel_samsung_sc8830 (`lineage-15.1`, config)
- https://github.com/sc8830-Bringup (device, vendor and hardware trees, `lineage-16.0`)
- https://github.com/shr-distribution/linux (branch `goyavewifi/3.10/hybris-14.1`)
- https://github.com/shr-distribution/meta-smartphone (`meta-samsung`, `goyavewifi-STATUS.md`)
