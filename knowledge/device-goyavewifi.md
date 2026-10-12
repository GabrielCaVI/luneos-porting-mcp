# Device: goyavewifi (Samsung Galaxy Tab 3 Lite 7.0 Wi-Fi, SM-T113)

Samsung Galaxy Tab 3 Lite 7.0 Wi-Fi SM-T113 (`goyavewifi`, Spreadtrum SC7730S), 32-bit, Tier B on the halium_arm 16.0 GSI through a Samsung `sboot` that ignores the boot-image command line: container, binder and most HALs run; the allocator/composer HALs were the blocker at the last log (fix built, not yet booted).

Nobody who works on it owns the tablet. A tester flashes one kit per round with Odin and sends logs; every round is a log analysis, a fix and a small update zip. That shaped the method more than the hardware did (§ Method).

## Status (as of 12 Oct 2026)

Hardware-verified by a tester on an SM-T113 unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Install, boot to systemd, LuneOS services | works | Odin to partition `KERNEL`; `/data` formatted |
| Android container (LXC) | works | init, servicemanager, hwservicemanager, vold, keymaster, audio/bluetooth/wifi/usb HAL services run |
| Display | not working yet | `vendor.gralloc-2-0` and `vendor.hwcomposer-2-1` exited 1 at every start (libft2.so); fix built in the vendor image, not booted |
| Touch, Wi-Fi, BT, audio, sensors, camera | untested | |
| Screen content | unknown | testers have not been asked in a way that produced an answer |

## Platform facts

- SoC SC7730S (`sc8830`), 4x Cortex-A7, Mali-400, 1 GiB RAM, 1024x600 MIPI DSI (~169 ppi), BCM4343 Wi-Fi/BT, eMMC (`sprd-sdhci.3`).
- Stock Android 4.4.4, kernel 3.10.17. The kernel partition is called **`KERNEL`**, not `boot`.
- Boot image: v0 header, page 2048, plus a trailing Spreadtrum device-tree table (`"SPRD"`, one DTB per board revision 2, 3, 4). Built with a custom `mksprdboot.py`; the stock image rebuilds bit-identical from its parts.

## Kernel

Community Spreadtrum tree (samsung-sc8830, branch hybris-14.1, 3.10.103) with a LuneOS delta, branch `goyavewifi/3.10/hybris-14.1` in shr-distribution/linux. See kernel-porting.md § Legacy 3.x kernels for the method; what this tree lacked, in the order the logs showed it (each one a tester round):

| Missing | Symptom | Fix |
|---|---|---|
| `seccomp` (383), `getrandom` (384) syscalls | container init exits 127 | wire/backport (code was in the tree) |
| 64-bit binder ABI (`ANDROID_BINDER_IPC_32BIT` promptless and on), then `get_user()` of 8-byte types | `Binder driver protocol(7) does not match user space protocol(8)` | make the option selectable, turn it off, backport ARM 8091/2 |
| ambient capabilities | init: "capabilities requested but the kernel does not support ambient capabilities"; apexd-bootstrap fails on loop devices (EACCES), `reboot_on_failure` | backport |
| `O_TMPFILE` (3.11) | `tombstoned` exits 1: `openat(".", O_TMPFILE) = -EISDIR` | backport series + ext3/ext4 `->tmpfile()` |
| `memfd_create` + sealing | bionic's libc calls it | copy from the A3 (2015) 3.10 tree |

All five were present in a sibling port's tree (a3-2015-halium 3.10.108, sm-t520 3.4, hammerhead): see § Method.

## Boot image and the command line

Samsung's `sboot` **builds its own kernel command line and drops the boot image's**; only the kernel's `CONFIG_CMDLINE` reaches the kernel. Everything the kernel or LuneOS needs from the command line (`androidboot.hardware=sc8830`, `androidboot.selinux=permissive`, `enable_adb` for the debug image) goes into `CONFIG_CMDLINE`. This was measured from `/proc/cmdline` in the recovery, not assumed.

A kit round re-uses the previous ramdisk with the new kernel and the same three DTBs, so the kernel is the only variable.

## Vendor and GSI

LineageOS 16.0 (Android 9, VNDK 28) built from the sc8830-Bringup trees in a Halium 9.0 tree, converted by halium-legacy-vendor, on the 32-bit `halium_arm` 16.0 GSI. The 15.1 (Android 8.1) vendor was dropped: the GSI's VNDK v27 APEX is empty and that build has no composer HAL.

Device-tree edits the 16.0 userspace needed (all in the shared Halium tree, so keep them as patches):

- `fstab.sc8830`: drop `encryptable=footer` from `/data`; Android 16's libfstab rejects FDE and vold then loads no fstab at all.
- `init.sc8830.rc`: remove the `persdata` wait/mount (the device does not exist; the `wait` stalls init), and `stop media.swcodec` (it aborts every 5 s with "gralloc-mapper is missing").
- `hidl.mk`: add `android.hardware.graphics.{allocator@2.0,composer@2.1}-service`; the vendor had only the `-impl` libraries.

Converter-side, `libft2.so` (gsi-building.md § Before deriving, item 5): gralloc -> libdither -> libandroid_runtime -> libpdfium -> libft2.

## Stubbed services

Stubbed with `stubbed-services.d/<codename>` (pre-start.d/50-stub-services): `lmkd` (Android 16's links libmemevents, whose static constructor needs BPF; `critical`, restarted every 5 s with a crash dump), `gpsd` (no GPS; exits 1), the memtrack HAL (exits 1, cause not found). An APEX service cannot be stubbed this way (the container's apexd mounts its own copy): stop it from the vendor `init.sc8830.rc` instead.

## Method: lessons that apply to the next remote port

1. **Audit the siblings before the first round, not after each log.** Five kernel rounds in a row each added one missing feature. A single pass would have found all five: (a) list every syscall number the GSI's arm32 `libc.so` issues (`mov r7,#N ... svc`) and diff against `arch/arm/kernel/calls.S` of the target and of the nearest working port; (b) a feature matrix over the sibling kernel trees (O_TMPFILE, ambient caps, memfd, binder ABI, `PR_SET_VMA`, binder SG...). Copy from the sibling with the same base version rather than re-porting from older trees.
2. **Read the sibling recipes' `HALIUM_LEGACY_*` lines.** The libft2.so trap was already documented three times in other recipes.
3. **Collect the container's logcat from the first round.** `lxc-attach -n android -- logcat -d -b all`. The HAL services log through logd and say nothing in dmesg or the journal; several rounds were spent guessing at a silent exit 1 that the logcat explained in one line.
4. **A collector must never wait on something that can legitimately stay alive.** An `strace -p` of a service that stops crashing hangs the tester's script. Bound every wait by time.
5. **Check where the tester's tools look.** Two rounds were lost because the update script looked in `/data/luneos-data` while the installed rootfs is `/data/luneos`; have a collector list the real paths first and print a result block the tester can paste.
6. **BusyBox in the recovery is not GNU**: no `ls --full-time`, `head -N`, `timeout`, `sha256sum` may be missing. Test scripts against it.
7. **Debug patches in the kernel recipe, not on the branch**, with a message that says remove-me, and a kernel that is otherwise identical so the next round is comparable. Both debug patches here printed nothing in the end; that was itself an answer (not a binder or epoll error).

## Open issues

- Display: composer/allocator with the corrected vendor image; screen state unknown.
- `tombstoned` should now work with O_TMPFILE; unconfirmed on the device.
- vold's binder `BINDER_WRITE_READ` returned EFAULT once in three boots on the ambient-caps kernel and not since; cause unknown, possibly a race.
- No cgroup v2 hierarchy under `/sys/fs/cgroup/system`; init continues without process groups.
- vendor `libskia.so` is not provided (camera.sc8830.so); the camera is not attempted.

## Sources

- https://github.com/samsung-sc8830/android_kernel_samsung_sc8830 (branch `hybris-14.1`)
- https://github.com/mertsan2007/android_kernel_samsung_sc8830 (`lineage-15.1`, config)
- https://github.com/sc8830-Bringup (device, vendor and hardware trees, `lineage-16.0`)
- https://github.com/shr-distribution/linux (branch `goyavewifi/3.10/hybris-14.1`)
- https://github.com/shr-distribution/meta-smartphone (`meta-samsung`, `goyavewifi-STATUS.md` has the round-by-round log findings)
