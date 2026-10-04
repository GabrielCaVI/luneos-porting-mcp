# LuneOS GSI/GKI Bring-up Debugging Playbook

A stage-by-stage playbook for "the device doesn't come up", distilled from real bring-ups: Pixel 3a (sargo, Halium 9→14/16 GSI), Pixel 6a (bluejay, GKI Tier A), Pixel 7 (panther), and a MediaTek MT6739 32-bit device (mindphone). Every failure mode in the core text was hit on hardware and diagnosed; the fixes named are the ones that shipped. The playbook also folds in cross-checked material from the UBports, Droidian and SFOS porting guides (attributed inline with sources) — that material is other distros' documented experience, not LuneOS-verified; SFOS-derived command spellings in particular were extracted from summarized pages, so verify against the cited source if one fails. Work through the stages in order — each stage's failures are only visible once the previous stage is cleared, and several of these bugs hide behind one another.

**Log-collection discipline** (SFOS hadk-hot, <https://sailfishos.wiki/books/hardware/page/hadk-hot>): collect evidence before changing anything. `dmesg -w` live; boot with `audit=0` (kills audit spam) and `printk.devkmsg=on` (unthrottled userspace → kmsg — the stock bluejay cmdline already carries it); `journalctl -b-1` reads the previous boot once the persistent journal is enabled; logcat output differs run as root vs user.

**The install/boot model these stages assume:** `fastboot flash vbmeta --disable-verity --disable-verification`, our `boot.img` (and `init_boot.img` on A13-launch devices), stock `vendor_boot`/`vendor`/`super` untouched, `rootfs.img` + `android-rootfs.img` (the Halium GSI system image) as files inside an unencrypted ext4 `userdata`. The LuneOS initramfs loop-mounts `rootfs.img` as `/`, and the Android container mounts the GSI at `/android` with the device's real `/vendor` bound in.

---


## 0. Before anything else: diff your .config against the vendor's

If the device's vendor publishes a working kernel config — a stock defconfig, a
`/proc/config.gz`, a factory image's `merged/.config` — then **diff your built
`.config` against it before adding a single debugging aid**. It costs two
minutes, needs no hardware, and on a port that fails to boot it is the highest
information-per-effort step available.

```sh
grep -v '^#' built.config    | grep -v '^$' | LC_ALL=C sort > ours.cfg
grep -v '^#' stock_defconfig | grep -v '^$' | LC_ALL=C sort > stock.cfg
LC_ALL=C comm -23 ours.cfg stock.cfg     # what we added
LC_ALL=C comm -13 ours.cfg stock.cfg     # what we changed or dropped
```

Anything in the first list that touches **early boot** — console drivers,
netconsole built in rather than modular, memory parameters, LSM or cgroup
changes — is a boot-failure suspect before any of your porting work is.

**radon (FuriPhone FLX1s), 23 Sep 2026** is the case that motivates this. The
device hung at the bootloader splash with no console, no USB gadget, no pstore
and no initramfs trace. The diff was eight lines, of which two were the cause:
`CONFIG_FRAMEBUFFER_CONSOLE=y` and `CONFIG_NETCONSOLE=y` (stock had it `=m`).
Both had been added *by the porter* as bring-up instrumentation. Reaching that
diff took a trace harness, two hybrid boot images and several device
round-trips; running it first would have cost two minutes.

### Corollary: instrumentation is a change to the thing under test

The fbcon/netconsole block existed to make a first boot observable. It made the
first boot fail — and then made the failure unobservable, because the kernel
died while bringing up the console. Every downstream observation (no adb even in
an `enable_adb` image, empty pstore despite `PSTORE_CONSOLE=y`, nothing written
by the initramfs trace) was the same symptom, misread as evidence about
userspace.

Prefer instrumentation that does **not** alter the kernel: an initramfs trace
written to an unused flash partition (see `device-radon` / `tools.md`) needs no
config change at all.

### Corollary: substitute in BOTH directions

Hybrid boot images are the right tool for splitting kernel from ramdisk, but one
direction is not a result:

| test | reading |
|---|---|
| vendor kernel + your ramdisk → hangs | "the ramdisk is at fault" — **wrong on its own** |
| your kernel + vendor ramdisk → hangs | both hang ⇒ the common factor is *your* kernel |

Run the second before concluding anything from the first.

## Stage 0 — Does the kernel even boot?

Nothing on the screen, no adb, device reboots or sits dead. Two tools before anything else:

### Ramoops / pstore console

On a kernel panic the console log survives the reboot in pstore. This is how the bluejay MCT clock panic was diagnosed — the whole `deferred probe timeout` wall and the final
`Kernel panic: exynos4_timer_resources: unable to determine tick clock rate`
were read from the ramoops console dump after the device rebooted. If the device panics and resets, pull the pstore console before touching anything else.

### MediaTek: `expdb` when there is no pstore and no gadget

Qualcomm and Exynos ports lean on ramoops (above). MediaTek kernels frequently
ship **no pstore console at all**, and if the USB controller is a vendor module
(see 1.9) there is no debug gadget either — so a failing MediaTek device can be
completely mute: no screen, no adb, no telnet, nothing on `lsusb` but the
preloader flashing past on each reset.

`expdb` is the way in. It is a MediaTek partition holding preloader/lk logs, AP
watchdog status and the kernel's `RAM_CONSOLE` (the kmsg from before the reset),
and it is readable over the preloader connection that *is* still enumerating.
See tools.md for mtkclient; `dump-expdb.sh` in the MP01 port directory wraps it.

What it looks like when it works — this is the MP01, and it settled a question
three rounds of guessing had not:

```
[    0.422636][    T1] Run /init as init process
[    0.458973][    T1] ======= LuneOS/Halium ===========
[    0.461627][    T1] initrd: luneos initramfs failed:
[    0.461688][    T1] initrd: Initramfs Debug Mode
[    1.541216][    T1] initrd: debug: telnet ready on usb0, 192.168.2.15 port 23
RAM_CONSOLE detect abnormal boot wdt_status:0x6, aee_exp_type:1
```

i.e. our init *was* running, the debug shell *was* coming up, and the watchdog
was killing it — none of which was visible from outside.

**Read `wdt_status` in that dump.** A non-zero value means the hardware watchdog
reset the SoC rather than the kernel panicking, which is a completely different
problem (1.10).

**expdb can also come back empty where it matters.** On the Titan Pocket (MT6771,
UFS) lk logs `kedump add: SYS_PSTORE_RAW ... kedump mini done` on every reset,
yet the first 17 MiB of expdb, where that kedump goes, read back as zeros over
mtkclient, twice. lk's own log in the same partition was intact: it showed lk
jumping to the kernel and then `lk boot reason = 4`
(`androidboot.bootreason=kernel_panic`, `exp_type 0x2` = kernel exception), so it
told us *that* the kernel panicked and nothing about *why*. Do not wait for the
crash record in expdb; read DRAM instead (next section).

### MediaTek: read ramoops straight out of DRAM over the preloader

The kernel's own console, panic included, is usually still in RAM. MediaTek lk
passes ramoops on the command line (look in lk's log in expdb for the
`cmdline:` lines, e.g. `ramoops.mem_address=0x54410000 ramoops.mem_size=0xe0000
ramoops.console_size=0x40000 ramoops.pmsg_size=0x10000`), runs with
`kedump: ddr reserve mode enabled`, and the panic reset is a *warm* reset. So
DRAM still holds the dying kernel's log when the preloader comes past on the
next loop, and mtkclient's DA can read memory:

```
mtk da peek 0x54410000 0xe0000 --filename pstore.bin    # address/size from lk's cmdline
```

Requirements and traps, all measured on the Titan Pocket (2 Oct 2026):

- the kernel needs `CONFIG_PSTORE_RAM=y` (stock MTK defconfigs have it),
- **catch the preloader while it is bootlooping.** Holding Power to switch off,
  or the Volume-Down BROM route from a powered-off phone, loses DRAM. Catching
  the preloader on the warm reset kept it. Read DRAM first and do expdb and the
  other partitions in a second session,
- the region is a set of `persistent_ram_buffer` zones, each starting with
  `DBGC` (0x43474244 LE), then `u32 start`, `u32 size` and a ring buffer. A zone
  with `start == size` never wrapped; otherwise `size` is the capacity and the
  oldest byte is at `start`. On the Pocket the console zone was at +0x4f000 and
  pmsg (Android userspace logging) at +0xd0000. The other ~80 4 KiB zones are
  empty dmesg-dump slots.
- `loglevel=` does not hide the panic: oops and panic lines are emitted at
  emergency level.

That read gave the whole answer in one go, after five flash rounds of
instrumenting the initramfs had shown nothing:

```
[22.059503] mtk_wmtd_worker: Unable to handle kernel paging request at 0055aa8d704b2800
[22.060725] pc : 0x55aa8d704b2800   lr : __dev_xdp_attached+0x48/0xa0
 rtnl_fill_ifinfo <- register_netdevice <- register_netdev
 <- [wlan_drv_gen3] <- wmt_lib_init [wmt_drv]    Tainted: GFS W O
```

i.e. a force-loaded vendor module crashing on a struct-layout mismatch, the
Tier B KMI problem described in kernel-porting.md ("Stock vendor modules on a
rebuilt Tier B kernel"). The pmsg zone showed userspace too: the Android
container up and surface-manager loading the vendor hwcomposer. So the port was
otherwise healthy, and the 22 s timing meant the initramfs was long done.

The staging kit's `dump-expdb.sh` (titanpocket-staging) does both passes: DRAM
first, then `mtk r expdb,cache` in one session, and decodes everything.

### Recording the initramfs to a spare partition: `initrd_log_fail`

`initramfs-scripts-halium` (meta-android) can write its own dmesg to flash, for
devices where nothing else survives:

- `initrd_log_fail` on the kernel command line turns it on. A background loop
  writes dmesg, mounts and the current stage every 3 s, and `panic()` writes a
  failure record. With it set, a failing initramfs **holds** (gadget and adbd
  up) instead of returning, so the device stops rebooting and the record stays
  the last thing written. Without the hold, `/bin/sh` with no console returns at
  once, init eventually exits, and the kernel panics into another loop.
- the default targets are `init_boot_a` (failure) and `init_boot_b` (progress),
  spare on the MT6789. **`initrd_log_part=<partname>`** names one partition
  instead: progress at 0 MiB, failure at 64 MiB. The Titan Pocket uses `cache`,
  which LuneOS bind-mounts over from userdata, so it is free (stock Android
  reformats it if it ever boots again).
- with `initrd_log_part=` the logger starts right after `/proc`, `/sys` and
  devtmpfs, retrying for 10 s until the partition appears. That only works with
  built-in storage. Without it, logging starts after module load and mdev, and
  a boot that dies earlier writes nothing. That is how the Pocket's first
  `cache.bin` came back as an untouched ext4 filesystem.
- the boot-image header command line is the cheap way to set it on MediaTek: lk
  prints the cmdline it hands the kernel, so you can confirm in expdb that the
  flags arrived. Repacking the header needs no kernel rebuild, but a boot image
  with an AVB footer needs a fresh footer (meta-android `lib/halium/avb.py`).

Absence is informative too. If the faillog image demonstrably booted (lk shows
the flags) and the partition holds no record, the boot died before the logger
started, or somewhere the initramfs never sees. On the Pocket that turned out
to be the latter: the panic came from the Android container's module loading,
after switch_root.

### The debug boot image (`fastboot boot`, no flashing)

Every device kit ships a `boot-<device>-luneos-debug.img`: the same kernel + initramfs with `enable_adb` on the cmdline. `fastboot boot` runs it without flashing (on Pixels this works even for images that would normally live in `init_boot` — the debug image is deliberately self-contained, kernel + ramdisk in one image). With `enable_adb`, init panics into the initramfs adbd debug shell: the device enumerates as a USB gadget named **"Halium initrd — Failed to boot"**. Then:

```
adb shell
cat /dev/kmsg        # live kernel log, includes every initramfs message
```

The same shell appears automatically (without the debug image) when the initramfs itself fails to boot — e.g. `rootfs.img` not found on userdata. If you get the gadget, the kernel and initramfs core are fine; read kmsg to see where boot stopped.

### The telnet / USB-networking ladder (UBports/Halium, SFOS hybris-boot)

The Halium-family initramfs also exposes a telnet path that works when adb doesn't, and the USB gadget itself tells you how far boot got. (UBports: <https://docs.halium.org/en/latest/porting/debug-build/early-init.html>, <https://docs.ubports.com/en/latest/porting/build_and_boot/Boot_debug.html>; SFOS: <https://github.com/mer-hybris/hybris-boot>)

- **Watch the boot stage from the host** via the gadget's iSerial string:

  ```
  while : ; do lsusb -v 2>/dev/null | grep -Ee 'iSerial +[0-9]+ +[^ ]' ; done | uniq
  ```

  The stages announce themselves: `"Mer Debug setting up (DONE_SWITCH=no)"` → `"Mer Debug telnet on port 23 on usb0 192.168.2.15"` (boot failed in the initrd) or `"GNU/Linux device on rndis0 10.15.19.82"` (booted).
- **Initramfs failure → telnet:** `telnet 192.168.2.15` (**port 23** = still in the initrd, pre-switch_root; **port 2323** = post-switch_root debug in the hybris-boot scheme). Host side: configure yourself as `192.168.2.1`, and give the interface a MAC if it shows `00:00:00:00:00:00`. First commands: `cat diagnosis.log` (the initramfs writes its failure reason there) and check `/init.log`.
- **Reading the silence:** no USB device at all = the kernel or initramfs never ran (unpack and inspect the flashed image); port 23 answering = kernel + initrd fine, the rootfs transition failed.
- **Halt boot deliberately:** hybris-boot honours marker files (`init_enter_debug` before switch_root, `init_enter_debug2` after) and `fastboot boot boot.img -c bootmode=debug`; the UBports recovery flow waits with a shell until `echo continue > /init-ctl/stdin`. These are the telnet-world analogs of our `enable_adb` debug image.

**The LuneOS initramfs now has this too (2026-09-06).** The panic/debug path in `initramfs-scripts-halium` `init.sh` (meta-smartphone/meta-android) starts `telnetd` at **`192.168.2.15` port 23** alongside the adbd gadget, with `udhcpd` serving the host `192.168.2.20–90` so no host-side configuration is needed, and announces itself in the gadget's iSerial string (`LuneOS initrd telnet 192.168.2.15: <reason>`). The gadget network function is auto-selected per kernel: it tries `rndis.usb0` and `ecm.usb0` and links whichever the kernel supports — **stock GKI 6.1 (bluejay/panther) ships ECM only, MTK 4.14 (mindphone) RNDIS only, athena's 4.19 (SDM660) RNDIS only**. Fixed gadget MACs (`FA:75:7F:BB:F4:E6`/`:E7`, first byte even) avoid the all-zeros-MAC refusal and give the host a stable connection. One caveat: ECM has no native Windows driver, so on GKI Pixels use a Linux or macOS host (or adb, which still works — both channels come up together). All tools are busybox applets already in the initramfs (`FEATURE_TELNETD_STANDALONE`, `UDHCPD`, `ip`, `getty` verified in the shipped build). Two more channels ride along:

- **ACM serial console** — an `acm.usb0` gadget function with a shell on `/dev/ttyGS0`; on the host just `screen /dev/ttyACM0 115200`, no networking involved. `CONFIG_USB_CONFIGFS_ACM=y` in stock GKI 6.1 and mindphone's 4.14 (athena's defconfig lacks it — the function silently doesn't appear there).
- **netconsole (Tier B only)** — after the debug network is up, init attaches a dynamic netconsole target streaming kmsg to UDP broadcast port 6666; the host listens with `nc -ul 6666`, and the stream **survives switch_root into the full boot**. Right after attaching, init **replays the early printk buffer** into the stream (`dmesg` re-injected line-by-line into `/dev/kmsg`, prefixed `replay:`), so the host gets history from power-on — boot-param netconsole targets get this via `CON_PRINTBUFFER`, dynamic ones don't. The replay needs `printk.devkmsg=on` on the cmdline (athena's `ANDROID_BOOTIMG_CMDLINE` now carries it; stock bluejay already does). Requires `CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y`, now in the athena and mindphone fragments. **Do not add it to a Tier A GKI fragment: NETCONSOLE selects NETPOLL, which adds a field to `struct net_device` — KMI-poison of the SYSVIPC class.** **Nor to a Tier B fragment where the container force-loads vendor network modules.** NETPOLL also turns on `NET_POLL_CONTROLLER`, which inserts three pointers into the middle of `struct net_device_ops`. On the Titan Pocket the stock-built `wlan_drv_gen3.ko` then had `register_netdev()` call `ndo_bpf` through the shifted table, and the kernel panicked 22 s into every boot (see Stage 0, "read ramoops straight out of DRAM"). Only use netconsole where no prebuilt network driver loads, or where you build those drivers yourself.

  **Cmdline netconsole (`netconsole=...@/usb0,...`) is mainline-only — and actively harmful on configfs-gadget devices.** Verified in the athena 4.19 source: `netpoll_setup()` aborts with `-ENODEV` when the target interface doesn't exist at init, and `init_netconsole()` then unwinds *everything* — including the dynamic configfs interface — so a cmdline entry naming a not-yet-existing `usb0` silently kills dynamic netconsole too. Tenderloin can use it (`netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` in `CONFIG_CMDLINE`, webOS-heritage `172.16.42.x` addressing) only because its mainline kernel sets `CONFIG_USB_ETH=y` — the built-in `g_ether` gadget creates `usb0` before userspace. Enabling `g_ether` on an Android-style kernel would claim the UDC and cost the configfs gadget (adb + everything else) — not worth it. Note also: athena has **no pstore/ramoops at all** (nothing in the defconfig, no DT node), so a panic before the initramfs is currently invisible there; a ramoops DT node + `PSTORE_RAM` would be the fix but needs a carefully chosen reserved-memory region.

### RNDIS + SSH — a debug channel that survives past the initramfs (Droidian)

Our `enable_adb` shell ends when the initramfs hands over; Droidian's primary channel is RNDIS + SSH into the booted (or half-booted) rootfs (<https://docs.droidian.org/porting-guide/debugging-tips/>):

- Kernel needs `CONFIG_USB_CONFIGFS_RNDIS=y`. Their symptom mapping: "stuck at the glowing logo and RNDIS is not working → check CONFIG_USB_CONFIGFS_RNDIS".
- Device comes up at `10.15.19.82`; host takes `10.15.19.100/24`, then `ssh <user>@10.15.19.82`. "Nothing on screen ≠ boot failure" — remote access determines actual status.
- Forward internet from the host over the USB link:

  ```sh
  sudo sysctl net.ipv4.ip_forward=1
  sudo iptables -t nat -A POSTROUTING -o $INTERNET -j MASQUERADE
  sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  sudo iptables -A FORWARD -i $USB -o $INTERNET -j ACCEPT
  # on device:  ip route add default via 10.15.19.100 ; nameserver 8.8.8.8
  ```

- UBports adds an emergency mechanism worth stealing: flag files `/userdata/.force-ssh` and `/userdata/.force-adb` enable SSH/ADB at boot regardless of config (<https://docs.ubports.com/en/latest/porting/configure_test_fix/USBModed.html>) — a flag file on userdata is writable from recovery or fastboot when nothing else is.

---

## Stage 1 — Initramfs failures

Known failure classes, all hit on hardware:

### 1.1 Module load order — `modules.load` is NOT dependency-ordered

On GKI devices the vendor's early modules (from the `vendor_boot` DLKM fragment or `vendor_kernel_boot`) land in `lib/modules` of the merged initramfs, and our init must load them — the stock LuneOS initramfs loads no early modules at all (fine on sargo where storage is built-in, fatal on GKI devices where even UFS is a module).

**Never assume `modules.load` order is topological.** It is a list, not an order: stock init feeds it to libmodprobe, which resolves `modules.dep` per entry. Measured with `tools/module-order.py`: bluejay has **335 hard-dependency pairs listed backwards** across 99 of 203 modules; panther 332 across 107 of 204. On bluejay, `clk_exynos_gs.ko` sits at line 15 while its symbol exporter `cmupmucal.ko` sits at line 45 — one-pass insmod-in-list-order left the clock driver unloaded, so no clocks → power domains deferred → `deferred probe timeout` wall → MCT timer panic at 11.5 s.

Fix history, worth knowing because the intermediate fix was a trap:
- **v2 (fixpoint loader):** repeated insmod passes until a pass makes no progress. Worked (88/203, 37/115, 26/78 per pass) but treats a symptom — and **`softdep pre:` edges are invisible to a retry loop** (insmod of the dependent *succeeds*, it just probes in the wrong order; `exynos-drm` after `phy-exynos-mipi` and `exynos_pd` after `clk_exynos_gs` are in that set, i.e. display and power-domain ordering).
- **v4 (shipped):** resolve the order up front the way modprobe does, in ~40 lines of busybox awk over `modules.dep` (each line holds the module's full dependency closure, deepest last — emit the line reversed, then `softdep pre:` entries, then the module). Fixpoint loop kept behind it as a safety net for deps that ship in `vendor_dlkm` (loaded later). This lives in `initramfs-scripts-halium` `init.sh` now.
- **Diagnostic lesson:** the original init silenced insmod errors with `2>/dev/null`, which hid the `Unknown symbol cal_clk_* (err -2)` failures completely. Log per-pass progress to kmsg and print a WARNING naming any module that never loaded.

Check any device's module set host-side, no hardware needed:

```
python3 gsigki/tools/module-order.py <lib/modules dir>
```

### 1.2 Module cmdline parameters — the kernel does not pass them to loadable modules

Second bluejay panic, at 2.3 s: `ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `Kernel panic: FMP self test failed` (the driver hard-fails when its LBA params are unset).

Root cause: **`module.param=` cmdline options only apply to built-ins.** modprobe/libmodprobe parse `/proc/cmdline` and pass them at load time; plain `insmod` does not. The device cmdline carries `ufs_pixel_fips140.fips_first_lba=30086` etc. (and `exynos_drm.panel_name=…`, which the display needs later).

Fix (init v3, shipped in v4): `module_cmdline_args()` collects matching `<module>.*=` tokens from `/proc/cmdline` for each module and passes them to insmod, **treating `-` and `_` as equivalent in the module name** (modprobe semantics — the file is `ufs-pixel-fips140.ko`, the cmdline says `ufs_pixel_fips140.`).

### 1.3 Async storage probe — poll for userdata

UFS (`ufs-exynos-gs.ko`) probes asynchronously, and `mountroot` has no retry — if storage is late it panics straight to the adb shell. The init patch polls sysfs `PARTNAME` for `userdata*` up to 10 s after module load before proceeding.

### 1.4 userdata never grows on UFS devices

`resize_userdata_if_needed()` in `halium-boot.sh` computed the partition size with a `case $path in /dev/mmcblk*) … /dev/disk*) …` over `/proc/partitions` — but `mountroot` sets `path=$(readlink -f $part)`, which on UFS resolves to **`/dev/sd*`**: neither case matches, the size stays empty, and the filesystem is silently left at its image size. Harmless if you `fastboot format:ext4 userdata` and push files; **fatal to the shipped-userdata-image flow**, which relies on a ~3.6 GB image growing to the ~100 GB partition. Fixed generically: read `/sys/class/block/<dev>/size` (512-byte sectors, present for every block device including partitions), keep the old greps as fallback, warn to kmsg if neither yields a size.

### 1.5 Missing tools, file layout, hotplug

- The initramfs lacked `udevadm` and `dumpe2fs` (`halium-boot.sh` calls both). Boot survives, but settle is skipped and the resize check degrades — add them to `initramfs-android-image`.
- **`android-rootfs.img` must sit NEXT TO `rootfs.img` on userdata** (halium file layout) — not only inside the rootfs. The name matters: `halium-boot.sh` checks `/tmpmnt/android-rootfs.img`. Also note `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` fixes the "userdata image with only rootfs.img in it does not boot" case.
- mdev hotplug writes `/sys/kernel/uevent_helper`, which needs `CONFIG_UEVENT_HELPER=y` — not in stock GKI configs. Without it, late hotplug events are lost; if by-partlabel links come up empty, this is why. (Added to the LuneOS kernel fragment; KMI-safe.)
- Old forked `machine.conf` files with hardcoded `mmcblk0p*` partition numbers: the modern initramfs discovers partitions by name — stale copy-pasted numbers are mostly harmless (panic path only) but should be deleted.

### 1.6 Cmdline-level fixes (Droidian porting guide)

Three documented failure → cmdline fixes (<https://docs.droidian.org/porting-guide/debugging-tips/>):

| Symptom | Fix |
|---|---|
| Device reboots immediately after flashing boot | remove a stale `systempart=` from the cmdline |
| Initramfs stuck / can't find data | add `datapart=/dev/disk/by-partlabel/userdata` |
| Initramfs refuses to exec `/init` | replace `console=ttyMSM0,115200n8` with `console=tty0` |

The `console=` one is worth remembering: a serial console on a dead UART can hang init's stdio — Droidian appends `console=tty0` as standard practice.

### 1.7 The `skip_initramfs` trap — your init never ran at all (SFOS hadk-hot)

On many Android 8–10 vendor kernels the bootloader passes `skip_initramfs` for normal boot and the kernel **bypasses the packed ramdisk entirely** — a repacked boot.img flashes fine but your init simply never executes (no gadget, no logs, stock-looking behaviour). Fix is in kernel source: revert the "Add skip_initramfs command line option" patches or force `do_skip_initramfs = 0` (details belong to the Tier B kernel work; <https://sailfishos.wiki/books/hardware/page/hadk-hot>). We have not hit this yet (mindphone is A11), but it is the first suspect when a Tier B device ignores a repacked ramdisk.

### 1.8 Recovery as a debug environment (Droidian)

On devices with TWRP/recovery, the shipped rootfs can be inspected and repaired without booting it (<https://docs.droidian.org/porting-guide/debugging-tips/>):

```sh
mkdir /tmp/mpoint
mount /data/rootfs.img /tmp/mpoint
chroot /tmp/mpoint /bin/bash
export PATH=/usr/bin:/usr/sbin
```

Grow it offline with `e2fsck -fy /data/rootfs.img && resize2fs -f /data/rootfs.img 8G` (complementary to the first-boot `resize_userdata_if_needed`). Recovery is also where you read `/sys/fs/pstore/` after a panic and mask broken systemd units before the next boot attempt.

---

### 1.9 The vendor modules may not be in the merged ramdisk at all

1.1 assumes the vendor's early modules are at `/lib/modules` because the
bootloader concatenates `vendor_boot`'s ramdisk with ours. That is what AOSP
specifies and what stock Android relies on — but **verify it rather than assume
it**, because when it does not happen `load_kernel_modules()` returns silently:

```sh
[ -f /lib/modules/modules.load ] || return 0
```

No error, no kmsg line, and on a device whose storage *and* USB are modules the
result is a machine that cannot find its root filesystem and cannot tell you so.

The robust fix is to stop depending on the bootloader: ship the vendor's modules
**inside the LuneOS initramfs**. `initramfs-android-image` has a hook for it:

```
ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "<machine>-vendor-modules"
IMAGE_ROOTFS_SIZE:pn-initramfs-android-image = "65536"   # default 8 MB is too small
```

with a recipe that installs the extracted `.ko` plus `modules.load`/`.dep`/
`.softdep` to `/lib/modules` (see `meta-minimal/recipes-bsp/mp01-vendor-modules`).
On the MP01 that is 180 modules, 25 MB unpacked, **5.5 MB compressed** — against
a 64 MiB boot partition holding a 16 MB kernel. The budget is not close, and if
the concatenation *does* happen these are the same files landing in the same
place, so it is safe either way.

Use `install`, not `cp -a`, in `do_install`: `cp -a` preserves the uid of
whoever extracted the factory image and `do_package` then dies with
`KeyError: 'getpwuid(): uid not found: 1000'`.

### 1.10 The watchdog reset trap (MediaTek)

MediaTek's preloader arms a **hardware watchdog** before handing off. Stock
Android's init feeds it; our initramfs does not. `CONFIG_WATCHDOG_HANDLE_BOOT_ENABLED=y`
makes the kernel watchdog core keep petting it until userspace takes over — but
only once the watchdog *driver* is loaded, and on MediaTek `mtk_wdt.ko` is one
of the vendor modules. So if module loading has not happened yet, nothing feeds
it and the SoC resets after ~20–30 s.

From outside this is indistinguishable from a boot loop, and it will happily
reset *a working debug shell* out from under you. Two tells:
- `wdt_status` non-zero in `expdb` (Stage 0)
- the reset interval is suspiciously regular

**This is MediaTek-specific in practice.** On Qualcomm the watchdog driver
(`msm_watchdog`/`qcom_wdt`) is built into the kernel on every port we have —
athena (Key2) builds its own complete kernel from `athena-perf_defconfig` and
carries only `CONFIG_QCA_CLD_WLAN=m`, so it has no module-load dependency for
boot at all and cannot hit this. Tensor devices likewise. Check
`CONFIG_<vendor>_WATCHDOG` in the stock config before assuming.

### 1.11 Debug mode must come *after* module loading

`init.sh` historically did this:

```sh
cat /proc/cmdline | grep enable_adb
if [ $? -ne 1 ] ; then
    panic "Initramfs Debug Mode"      # <-- stops here
fi
...
load_kernel_modules                    # <-- never reached
```

Fine on Tensor, where UFS and the gadget are `=y`. **Fatal on any device whose
USB, storage or watchdog are vendor modules**: the debug shell comes up with no
block devices to inspect, and on MediaTek no `mtk_wdt.ko` either, so the
watchdog kills it within seconds. What you observe is "the debug image
bootloops", when in fact debug mode is working perfectly and being shot.

`load_kernel_modules` + `start_mdev` now run *before* the `enable_adb` check.
Costs nothing where it is not needed (the loader returns immediately when
`/lib/modules/modules.load` is absent) and the loader is bounded, so it cannot
itself hang the debug path.

Related, and worth internalising: **"luneos initramfs failed:" with an empty
reason is not a failure.** `panic()` is reused as the debug-mode entry point;
the reason is the *next* kmsg line, and for the debug image it reads
`Initramfs Debug Mode`.

### 1.12 The debug gadget is not necessarily adb

`USB_FUNCTIONS="adb rndis ecm acm"` — whichever the kernel supports is what you
get, and on a vendor kernel that may be **none of them being adb**. On the MP01
the gadget came up as ECM + ACM: `adb devices` stayed empty while the device was
perfectly reachable. Check all of these before concluding the device is dead:

```sh
adb devices
ls /dev/ttyACM*                  # screen /dev/ttyACM0 115200
ip -br link | grep -E "usb|enx"  # then: telnet 192.168.2.15
lsusb | grep -iE "18d1|0e8d"     # raw enumeration
```

### 1.13 Ramdisk compression must match across the concatenation

The bootloader concatenates `vendor_boot`'s ramdisk with ours and hands the
kernel one stream. AOSP requires the two to use the **same compression** ("a
device that is GKI-compliant must use an lz4-compressed vendor ramdisk", since
the generic ramdisk is lz4). `initramfs-android-image` produces `cpio.gz`.

On the MP01 the mismatch was not benign: with a gzip ramdisk behind an lz4
vendor ramdisk, ours was never unpacked, the vendor's `/init` symlink survived,
Android's init ran instead of ours and the device landed in **Android Recovery**
("Try again / Factory data reset") — which reads like a userdata problem and is
not.

Check the stock images and match them:

```sh
xxd -l 4 ramdisk     # 02 21 4c 18 = LZ4 *legacy*, 1f 8b = gzip
```

`GKI_RAMDISK_COMPRESSION = "lz4-legacy"` in the machine conf repacks it. It must
be **legacy** lz4 (`lz4 -l`), not the modern frame format (`04 22 4d 18`) —
`lib/decompress_unlz4.c` only knows the legacy magic.

### 1.14 Vermagic: match it rather than force it

To insmod stock vendor modules the vermagic must match, and the initramfs has
only **busybox** `insmod`, which cannot pass `MODULE_INIT_IGNORE_VERMAGIC` —
and `CONFIG_MODULE_FORCE_LOAD` is usually unset in the stock config anyway. So
`--force-vermagic` is not available where you need it most.

Make the string match instead. Vermagic is
`<kernel release> SMP preempt mod_unload modversions aarch64`; everything after
the release comes from config options you already inherit, so only the release
differs:

```
sed -i 's/^SUBLEVEL = .*/SUBLEVEL = 233/' Makefile
CONFIG_LOCALVERSION="-android12-9-gdeb4d30d3489"
# CONFIG_LOCALVERSION_AUTO is not set
: > .scmversion          # or setlocalversion appends "+" and the match fails
```

That last line is not optional and cost a full rebuild to find: patching the
Makefile dirties the tree, and `scripts/setlocalversion` ends with
`res="$res${scm:++}"` whenever the tree is not on a clean annotated tag. One
character, and nothing loads.

Deploy `include/config/kernel.release` from the kernel recipe so the string is
checkable before flashing — on a device this mute, an unverifiable assumption
costs a whole debug cycle.

Faking the sublevel is defensible **only because the ABI is separately
verified**: `check-kmi.sh` must report 0 of N stock modules failing against the
real exported-symbol CRCs. Without that measurement this is just a lie in
`uname -r`.

## Stage 2 — Android container failures

The rootfs is up, systemd runs, but HALs / display / radio are dead. This stage has the deepest traps.

### 2.1 Init "stuck" vs "curtailed" — always look for `wait_for_prop` first

Halium patches Android init so the framework never starts, and `on nonencrypted` is dead on a GSI (no fstab → `mount_all` never runs). It is tempting to conclude init stopping after `post-fs-data` is by design. **It usually isn't — look for a `wait_for_prop` gate before concluding anything.**

On sargo, `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`; that property is set by Android's `time_daemon`, which Halium doesn't run. `wait_for_prop` blocks init's state machine outright — everything after it (`early-boot`, `boot`, every `class_start`, every `chown`/`chmod` the vendor HALs depend on) is simply never reached. Setting that **one property** on a running device brought up the whole modem subsystem (`per_mgr`, `per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI errors, and cut EACCES failures in a boot from 50 to 1.

The shipped mechanism (`start-android-hals.sh`) generalizes this: parse every `wait_for_prop` out of the container's rc files, grant a grace period, then force only the stragglers — and keep a `class_start`/`chown` replay as a safety net.

Cross-reference: SFOS hits the same time_daemon conflict and mitigates from the other end — disabling `time_daemon`/`vendor.time_daemon` outright via a `disabled_services.rc` dropped into the container's init dirs (stops "RTC initialization failed" loops). A port seeing time_daemon crash-loop should know both mitigations. (<https://sailfishos.wiki/books/hardware/page/hadk-hot>)

### 2.2 The quoted-property trap

mt6739's vendor rc writes `wait_for_prop hwservicemanager.ready "true"` — **with quotes**, which init's own parser strips. `start-android-hals.sh` harvested gates with awk, which kept the quotes, so the gate never looked satisfied, and after the grace period the script "forced" the literal value `"true"` (quotes included) over the correct one — **wedging every libhidl `WaitForProperty`, i.e. every HIDL `getService`, on host and container**. This was the one true root cause under the mindphone boot-splash hang, hiding beneath several real-but-secondary bugs. Fixed with a gsub in the awk. sargo never triggered it (its vendor gates carry no quotes) — a reminder that "works on device A" proves nothing about the parser.

### 2.3 Container init dies with no trace — the logging black hole

Inside the LXC container, init often has no usable `/dev/kmsg` (the host owns `/dev`; first stage's mknod can fail), so KernelLogger discards every line. Worse, init is built with `REBOOT_BOOTLOADER_ON_PANIC`, so a fatal signal becomes a handled `reboot()` — the kernel records nothing — and a pid namespace delivers that as SIGHUP. All the container manager can say is:

```
Child <pid> ended on signal Hangup(1)
```

Two init patches (in `gsigki/halium16-init-logging-patches/`) close the hole:
1. **Tee every log line to `/dev/socket/init.log`** — the container config bind-mounts `/dev/socket` from the host, so the log outlives the container and is readable from outside after init is gone.
2. **Breadcrumbs before `InitKernelLogging`** — two plain `write()` markers at `FirstStageMain` entry and after the `/dev` setup block, so a death in that window is distinguishable from init never having been exec'd. No-ops outside a Halium container.

This is how the Android 16 GSI's PropertyInit failure was found: the tee captured init's `InitFatalReboot` backtrace naming `prop_area::map_prop_area_rw` — the host's **4M `/dev` tmpfs running out of pages** while mapping one 128K `prop_area` per SELinux property context, of which a 16 GSI has ~557.

### 2.4 Read the container's logcat, not just journalctl

The `/dev/ashmem` case: system booted to `systemctl is-system-running = running`, **0 failed units**, 32 audio sinks, working nyx/ofono — and sat on the bootloader splash forever. Nothing in journalctl. The evidence was **only in the container's logcat**: from Android 12, libcutils opens `/dev/ashmem<boot_id>`, not `/dev/ashmem`; the container's init creates that node inside the container, but hybris runs on the host — every `ashmem_create_region()` failed, so libfmq couldn't allocate, so the HIDL composer's command queue was never created and the compositor sent no display commands at all. Fix: create `/dev/ashmem<boot_id>` on the host (`mount-android.sh`). When the host side looks perfect, go read logcat.

### 2.5 Other container-side failure modes (all real)

| Failure | Cause / fix |
|---|---|
| vndservicemanager aborted, every vendor HAL blocks on `/dev/vndbinder` | A stock vendor's vndservicemanager aborts without selinuxfs — preload `libselinux_stubs` into vndservicemanager (halium device-tree patch; on 32-bit the GSI preloaded it from a hardcoded `/system/lib64/` path and died — fixed in `device/halium/halium_arm`) |
| Boot queue hangs on one bad HAL | `lshal` hangs forever on an unresponsive HAL — `luneos-device-config` runs lshal under a per-call watchdog |
| Dynamic-partition mounts racy/missing nodes | dmsetup/udev race — run `dmsetup mknodes` in `mount-android.sh` |
| Binder calls fail on host | Host needs `/dev/{binder,hwbinder,vndbinder}` symlinks into binderfs |
| `.capex` APEXes silently skipped (conscrypt, media) on a 16 GSI | `mount-apexes.py` cannot mount compressed APEXes — build the GSI with `PRODUCT_COMPRESSED_APEX := false` |
| `/init` aborts instantly on an old (4.9) kernel | `MADV_WIPEONFORK` needs Linux ≥ 4.14 — hybris-patches makes it non-fatal |
| getprop/setprop TLS abort on Android 16 GSI | Needs the Android 16 libhybris adaptation (`Herrie82/libhybris` `herrie/android16-tls`) |
| GPU driver not found | `/vendor/lib{,64}/egl` must be on the linker's default LD paths (same libhybris branch) |
| Container "service not found" for zygote/netd/update_verifier | By design — the Halium GSI strips them. Not a bug. |
| "add_service Permission denied" / "Unknown class service_manager" | SELinux-family (SFOS hadk-hot): the selinux config files must be real files, **not symlinks**; "Unknown class" in permissive mode wants stub services. Check what the base expects first — dmesg shows `SELinux: Disabled at boot` (hybris ≤16) vs `SELinux: Initializing` (≥17) |
| `libandroidicu.so not found` (and libicui18n/libicuuc) | Straggler libs live in the runtime APEX — symlink them in, e.g. `/odm/lib64/libandroidicu.so → /apex/com.android.runtime/lib64/…` (SFOS hadk-hot) |
| apexd/loop-device failures | `loop.max_part=7` on the cmdline, loop block-size patch, or the "linkerconfig: switch no-updatable-apex" hybris-patch; also check `/proc/device-tree/firmware/android/fstab/` for partitions the DT expects early-mounted (SFOS hadk-hot) |
| Early crash-loop on Exynos 9810/9820 | `systemd-journald` crashes the device — mask it (from recovery if needed). On kernels with broken namespace support, mask `systemd-resolved` and `systemd-timesyncd` too (Droidian) |

### 2.6 Working the container by hand (UBports/Halium, Droidian, SFOS)

- `lxc-checkconfig` — one-shot check that the running kernel has every namespace/cgroup option LXC needs (everything except User namespace should be enabled). `lxc-ls --fancy` shows container state at a glance.
- When `android-system` fails silently, start the container manually with full logging: `lxc-start -n android --logfile=/tmp/lxclog --logpriority=DEBUG`. To debug the host side alone, temporarily neuter the container: override the service with `ExecStart=/bin/true`. (<https://docs.droidian.org/porting-guide/debugging-tips/>)
- Get logs from inside: `lxc-attach -n android -- /system/bin/logcat` (and `logcat -b radio` for RIL).
- **The container's init cannot be started twice** (SFOS hadk-hot): a second start fails on leftover state, not on the original bug — so a restart-looping container init is a misleading symptom; find the *first* failure. And logcat only exists once Android init is up — absence of logcat ≠ broken logging.
- **strace a proprietary vendor daemon** by editing its rc service line (works in the LXC container too): `mkdir -m777 /data/strace`, then `service tad /usr/bin/strace -ff -o /data/strace/tad.strace /vendor/bin/tad …`. Often the only window into a closed daemon. (SFOS hadk-hot)

---

## Stage 3 — Display and UI

First, distinguish the two black-screen shapes:
- **Stuck on the bootloader splash** with a healthy system underneath → compositor never sent display commands; think ashmem/composer (§2.4), or init gates (§2.1).
- **Screen dark but everything runs** → check the backlight before anything else: on mindphone nothing drives `/sys/class/leds/lcd-backlight` and the panel boots at brightness 0. `echo 200 >` it from a compositor drop-in as a bring-up hack; the real fix belongs in the display service. Qualcomm gotcha (Droidian): many QC panels take a max of **2047**, not 255 — a "correct-looking" low absolute value can still leave the panel visually dark.

### The display smoke-test ladder (SFOS HADK/hadk-hot)

When the compositor shows nothing, don't debug it top-down — isolate layers bottom-up with the libhybris test binaries, compositor masked first (SFOS masks `user@100000`; LuneOS analog: stop/mask luna-surfacemanager). (<https://github.com/mer-hybris/hadk-faq>, <https://sailfishos.wiki/books/hardware/page/hadk-hot>)

1. `EGL_PLATFORM=hwcomposer test_hwcomposer` (as root). Success = a spinning colored rectangle: EGL + gralloc + composer blobs work under the hybris linker. Segfault → `EGL_PLATFORM=hwcomposer strace test_hwcomposer`, or `gdb test_hwcomposer` → `run` → `bt full`. Runs-but-black → suspect the gralloc/copybit module.
2. "minimer": `EGL_PLATFORM=hwcomposer qmlscene -platform hwcomposer main.qml` — adds the Qt QPA hwcomposer plugin on top (LuneOS analog: qt6 qmlscene with qt6-qpa-hwcomposer-plugin). Tuning when it misbehaves: `QPA_HWC_IDLE_TIME=5`, `QPA_HWC_BUFFER_COUNT=3`; black backgrounds/images inside otherwise-working apps → `QT_OPENGL_NO_BGRA=1`.
3. Only then the full compositor.

**surfaceflinger as a bisect oracle:** run the Android stack's *own* compositor from the container/GSI — `/system/bin/surfaceflinger` (Android 11+: also `ANDROID_ROOT="/system" /system/bin/bootanimation`). If it renders, kernel + vendor blobs + gralloc/composer are proven good and the fault is in the hybris/QPA layer; if it doesn't, stop debugging libhybris and fix the Android side first.

Other verified display/UI failure modes:

| Symptom | Cause / fix |
|---|---|
| Compositor blocks forever before starting | `product.env` DRM probe loops forever on DRM-less devices — guard the probe (needs a luna-surfacemanager patch) |
| Wrong/unknown panel geometry | Fallback must read `/sys/class/graphics/fb0/modes` — **NOT `mode`**, which empties once the compositor owns the panel. (mindphone's machine conf claimed 1080x2340; the real panel is 480x800@~187ppi — never trust copy-pasted display constants) |
| Every `eglCreateContext` → `EGL_BAD_ALLOC`, webapps never render | GPU node permissions: `/dev/pvr_sync` and `/dev/ion` needed 0666 (the vendor's own ueventd.rc values) for the WAM user — ship a udev rule |
| QML apps die with "Failed to create wl_display"; webapp-mgr/maliit can't reach wayland | XDG_RUNTIME_DIR mismatch: compositor keeps its socket in `/tmp/luna-session` (surface-manager.env) while apps inherit `/tmp/xdg` from DefaultEnvironment — and `/tmp/xdg` is pulseaudio's dir (different perm domain, can't merge). Durable fix: a tiny always-on watcher `wayland-xdg-link.service` (Type=simple, Restart=always) re-linking `/tmp/xdg/wayland-0 → /tmp/luna-session/wayland-0` every 2 s. **Not** a systemd .path unit — PathExists stays true, a oneshot loops into its start limit |
| Compositor races the vendor HAL at boot | Don't sleep — wait for `IComposer` to actually register on hwbinder. (Even Droidian ships an `ExecStartPre=sleep 5` drop-in for Phosh here; the wait-for-registration pattern is strictly better) |

---

## Stage 4 — Subsystems (wifi, modem, BT, misc)

### First question for any subsystem: is the HAL registered at all?

Before debugging ofono/sensorfw/bluebinder configuration, verify the vendor HAL is actually up on the binder bus — LuneOS ships libgbinder, so `binder-list` is available (SFOS hadk-hot, <https://github.com/mer-hybris/libgbinder>):

```
binder-list -d /dev/hwbinder | grep IRadio      # modem
binder-list -d /dev/hwbinder | grep ISensors    # sensors
```

If the interface is absent, the middleware config is irrelevant — go back to Stage 2 (the HAL never started). If `binder-list -d /dev/binder` shows **nothing at all**, the gbinder **API level** may be wrong for this Android base — set it in `/etc/gbinder.conf` (valid levels: see `gbinder_config.c` in mer-hybris/libgbinder). ofono-binder-plugin, bluebinder and sensorfw all sit on libgbinder, so a wrong API level breaks all of them at once.

libhybris also ships per-subsystem smoke binaries usable before any middleware exists: `test_egl`, `test_hwcomposer`, `test_vibrator`, `test_gps`, `test_audio` (`test_sensors` is legacy-HAL-era, Android ≤7 — use binder-list on binderized bases). Cheap first answer to "does the blob respond at all?" (SFOS hadk-faq)

### Wifi
- A `wifi-module-load.service` modprobing a module that doesn't exist on this device (copy-paste from another port) produces a 2 s restart loop — check whether the driver is built-in (`CONFIG_MTK_COMBO=y` on mindphone: no module to load).
- MTK combo (WMT) pattern: the real drivers are the **stock vendor modules** (`/vendor/lib/modules`: wmt_drv, wmt_chrdev_wifi, wlan_drv_gen2, bt_drv, gps_drv). Their CRCs disagree with a reconfigured kernel (module_layout) — `CONFIG_MODULE_FORCE_LOAD=y` + `modprobe --force` proved safe in practice. Set the firmware path (`firmware_class.path` → `/android/vendor/firmware`) before loading, and stage the modules in a private tree under `/run`, **not** `/lib/modules/$(uname -r)` — udev coldplug autoloads from there and bootloops the device on the next boot (kernel-porting.md).
- The container's `wmt_loader` needs the MTK connectivity `/dev` nodes exposed to the container; then power-on is `echo 1 > /dev/wmtWifi` **retried until wlan0 exists** (the container wmt daemons patch CONSYS firmware first).
- This is generalized in `meta-android/recipes-core/mtk-connectivity`: three condition-gated units keyed on `ConditionPathExists |wmt_drv.ko |conninfra.ko`, driven by the connectivity subset of the vendor's `modules.load` (grep `wmt|wlan|conn|bt_drv|gps|fmradio`) — no hardcoded module list, inert on non-MTK.
- Module-load error decoding (Halium docs, <https://docs.halium.org/en/latest/porting/debug-build/wifi.html>): `"Required key not found"` = module signature enforcement — disable `CONFIG_MODULE_SIG*` (Tier B only; stock GKI leaves MODULE_SIG_FORCE unset anyway, per bluejay). `"Invalid module format"` = kernel/module version-config mismatch — the non-GKI cousin of our CRC story. Broadcom `bcmdhd` is best built `=m`, not `=y` — as a module it picks up the device MAC address; built-in it doesn't. Legacy Qualcomm (pre-2016 SoCs): `echo 1 > /dev/wcnss_wlan`, `echo sta > /sys/module/wlan/parameters/fwpath`.

#### Regulatory domain: `country 00`, and no 5 GHz on any device

Until Sep 2026 **nothing in the LuneOS tree installed `wireless-regdb`** except
one accidental edge — `linux-firmware-pine64`'s RDEPENDS — so pinephone,
pinephonepro and pinetab2 had `/lib/firmware/regulatory.db` and all seventeen
other machines, every phone, did not. It was never dropped: oe-core only ever
wires it into `packagegroup-base-wifi` (added 2019-06-19, `00c5a665b4`), and
LuneOS builds its images from `packagegroup-luneos-*`, so `packagegroup-base`
is never installed. `git log -S wireless-regdb` over meta-webos-ports returns
zero commits, and connman does not reference it either.

It went unnoticed for years because **the world domain is a fully usable
2.4 GHz radio** and only cripples 5 GHz:

```
country 00:
  (2402 - 2472 @ 40), (6, 20), (N/A)          <- no PASSIVE-SCAN, normal
  (5170 - 5250 @ 80), ... PASSIVE-SCAN
  (5250 - 5330 @ 80), ... DFS, PASSIVE-SCAN
  (5490 - 5730 @ 160), ... DFS, PASSIVE-SCAN
  (5735 - 5835 @ 80), ... PASSIVE-SCAN
```

Channels 1-11 work; every 5 GHz band is passive-scan-only, so 5 GHz APs are
simply never found. On a phone that just presents as "Wi-Fi works".

**Shipping the file is only half the fix.** cfg80211 is built in on these
kernels, so it requests `regulatory.db` during its own initcalls, before any
rootfs exists. Boot log from radon (MT6877, 4.19):

```
cfg80211: Loaded X.509 cert 'sforshee: ...'
cfg80211: Loaded X.509 cert 'wens: ...'
platform regulatory.0: Direct firmware load for regulatory.db failed, error -2
platform regulatory.0: Falling back to syfs fallback for: regulatory.db
ueventd: firmware: could not find firmware for regulatory.db
ueventd: firmware: attempted /vendor/firmware/regulatory.db, open failed
cfg80211: failed to load regulatory.db
```

On Halium the process answering the sysfs firmware fallback is the **Android
container's ueventd**, which searches `/etc/firmware`, `/odm/firmware`,
`/vendor/firmware` and `/firmware/image` — never the LuneOS root — so it always
answers "not found". The failure is then **latched**: `regdb_fw_cb()` sets
`regdb = ERR_PTR(-ENODATA)` and `query_regdb()` returns that for the rest of the
uptime without ever issuing another `request_firmware()`. So the db sits on disk
unread, and `iw reg set XX` returns 0 while changing nothing — a very
convincing dead end.

`NL80211_CMD_RELOAD_REGDB` (`iw reg reload`) is the only thing that clears it.

Diagnosis, in order:

```sh
iw reg get | head -1                     # "country 00" => broken
ls -l /lib/firmware/regulatory.db        # missing => package not installed
journalctl -k -b | grep -iE "regulatory|regdb"
iw reg reload && iw reg set NL && iw reg get | head -1
```

In tree: `wireless-regdb-static` plus the `cfg80211-regdb-reload` service
(meta-luneos/recipes-connectivity), both gated on the `wifi` MACHINE_FEATURE in
`packagegroup-luneos-extended`. Signing caveat for old kernels: upstream signs
the db with the **wens** key since 2023, and
`CONFIG_CFG80211_USE_KERNEL_REGDB_KEYS=y` trusts only `net/wireless/certs/*.hex`
— check `wens.hex` is there before assuming it will verify (FuriLabs' 4.19 has
both wens and sforshee).

#### Never gate a unit on `/sys/module/<driver>` — it assumes a module

A built-in driver has **no `/sys/module` entry at all**, so every
`ConditionPathExistsGlob=/sys/module/wlan*` silently excludes the machines where
the driver is compiled in, and systemd reports `ConditionResult=no` rather than
an error. This has now bitten three separate units on radon
(`CONFIG_MTK_COMBO=y`): the mtk-connectivity BT unit (`.ko` globs only),
`mtk-connectivity-wifi`, and `wlan-suspend-mode`, which had **never run once**.

The same assumption hides in *driver detection*, which is worse because the unit
appears to work. `wlan-suspend-mode`'s `driver_layout()` chose its private-ioctl
struct by looking for `/sys/module/wlan_drv_gen4m*`, so with gen4m built in it
returned `qcom` and sent the wrong layout. Measured on radon:

```
SETSUSPENDMODE 0   layout=qcom -> FAIL [Errno 22] Invalid argument
SETSUSPENDMODE 0   layout=mtk  -> OK
```

Gate on something that exists either way: the character devices
(`/dev/wmtWifi`, `/dev/conninfra_dev`, `/dev/stpbt` for MTK combo), or the
network interface itself — and where you must wait for an interface, bound the
wait and exit with a status in `RestartPreventExitStatus` so a machine with no
WLAN does not spin forever.

#### "Wi-Fi associates, ping works, but TCP hangs"

Establish **where** the loss is before touching the port. This exact symptom on
radon — SSH emitting a banner and then dying — cost days across sshd, entropy,
host keys, socket activation, MTU, DSCP, CPU starvation and power save, all of
which were wrong. It was the *router*, bridging between its 2.4 GHz and 5 GHz
radios: the phone was on 2.4 GHz, the dev host on 5 GHz, and only flows crossing
between the two radios died. Consumer routers accelerate TCP/UDP in hardware and
leave ICMP on the slow path, so ping is not evidence that TCP will work.

Run this matrix; it takes two minutes and answers it outright:

| test | what it isolates |
|---|---|
| `ping -c5 -M do -s 1472 <peer>` | L2/L3 path and MTU, both directions |
| device `wget` a few MB from the internet | device↔AP leg only — if this is fast, the radio and driver are fine |
| device connects **out** to a listener on the peer | device-initiated TCP |
| peer connects **in** to a listener on the device | peer-initiated TCP |
| same tests with peer on the **same band** | isolates cross-band bridging |

Read `ss -ti` on the *sending* side, not the application's symptoms.
`bytes_acked:1` with a climbing `bytes_retrans` means your data was never
acknowledged — the receiver never got it — which is a completely different
problem from "the far end is not replying". Use a plain socket listener, not
sshd, so the application is out of the picture.


### Modem
- mindphone: `md1.status = "exception"`, RIL daemon stopped. Root cause was **fstab selection**: `mount-android.sh` picked `fstab.enableswap` (sorts before `fstab.mt6739` under the glob), so the modem NV partitions (nvcfg/nvdata/protect1/protect2 — MTK calibration + IMEI) never mounted. Fix: prefer `fstab.$(getprop ro.hardware)`, skip `*.enableswap`. Generic to any multi-fstab MTK device. After the fix: `md1.status=ready`, IRadio em1/em2 registered, ofono `/ril_0` + `/ril_1` both Powered (dual-SIM).
- MTK exposes NV partitions under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` must cover that.
- The Qualcomm variant of the same disease (SFOS hadk-faq): the RIL stack needs the exact `/dev/block/bootdevice/by-name/` symlink structure Android has. Symptom is SIM never detected, in bad cases a bootloop. `ls -lR /dev/block` on Android (or in the container), replicate the structure via udev rules.

### Bluetooth
- Node ownership: the **vendor's** ueventd.rc says `/dev/stpbt` is `bluetooth:bluetooth`; the container's ueventd made it `system:system` → HAL can't open it. Chown in the container, then start the BT HAL (after android-system).
- BT MAC: `bluebinder_post.sh` knows no MTK source; the MAC lives in `/mnt/vendor/nvdata/APCFG/APRDEB/BT_Addr` (first 6 bytes) → write once to `/var/lib/bluetooth/board-address`.
- **`hci0` exists but stays DOWN, `bluetoothctl` says "No default controller available":** check `rfkill list` first (webOS BT off = soft-blocked), then `hciconfig hci0 up`. `Invalid request code (56)` is `EBADRQC`, which `bt_to_errno()` maps from HCI status **0x01 "Unknown HCI Command"**: the controller refused something the kernel sent during init because the controller *advertised* it. Find which with `btmon`, which LuneOS ships:

  ```sh
  (btmon -i hci0 > /tmp/bt.log 2>&1 &); sleep 1; hciconfig hci0 up; sleep 2; pkill btmon
  grep -B2 -A6 "Unknown HCI Command" /tmp/bt.log
  ```

  Then look up what gates that command in `hci_core.c` (`hci_init*_req`) and mask the bit bluebinder passes through (`BLUEBINDER_LOCAL_EXT_FEATURES_PAGE_2_MASK`, `BLUEBINDER_LOCAL_FEATURES_MASK`) or add missing ones (`BLUEBINDER_LOCAL_COMMANDS_SET`). MP01: Read Synchronization Train Parameters → page 2 byte 0 bit 2 → mask `0x0400000000000000`. Test by writing the value to `/var/lib/environment/bluebinder/<x>.conf` and restarting bluetooth → bluebinder → bluetooth in that order.
- A `dut_mode ... already present` debugfs warning means a second `hci0` was registered over a stale vhci — a killed bluebinder left it behind. Restart the stack in order before debugging further.

### Misc
- Audio wrong rather than absent: pulseaudio-modules-droid has documented quirk arguments — pitched/tempo-shifted audio → `rate=48000` (or 44100); volume keys dead → `hw_volume=false`; crash or silence in voice calls → `use_legacy_stream_set_parameters=true`. Full table and the `audio.hidl_compat.default.so` binder workaround live in the hal-userspace topic. (UBports docs)
- Time-sync UI dead: LunaSysService calls `timedatectl`, which isn't installed until systemd-timedated ships.
- HW keypad ignored by Qt: udev tags it `ID_INPUT_KEY` only; Qt evdevkeyboard discovery needs `ID_INPUT_KEYBOARD` — promote with a udev rule.
- `library "libpq_cust.so" not found` from MTK HWC is benign — the vendor ships `libpq_cust_base.so` and the HAL falls back.

---

## Stage 5 — Idle health: the port "works" but burns CPU, flash or battery

A port that boots and runs can still be quietly wasteful. From the sargo/tissot idle triage (12 Sep 2026, `LuneOS/memoryusage/findings-2026-09-12.md`): both devices "healthy", yet four separate things were burning a core or flash for nothing. **Metrics to collect on any idle device:** per-process *cumulative* CPU vs uptime (`ps -o time` against `uptime` — a daemon that has used 2 h in 10 h is 20% of a core however calm it looks now), journal *and* container-logcat lines/s, GB/h whole-disk flash writes, `SUnreclaim` slope over **at least a day** (18 minutes cannot separate a slow leak from churn), and the suspend entry count (neither triage device had suspended once — check before trusting wake-from-suspend).

Four proven failure patterns, generalized:

1. **A bypassed vendor helper daemon busy-spins.** tissot's `wcnss_filter` sat at 96% of a core logging **~62,000 lines/s** (2.34 billion entries / 262 GB into the host log buffer since boot; `logd` burned another 36% of a core absorbing it). Cause: libbt-vendor `ctl.start`s the filter, but the BT HAL already holds the SMD channels — LuneOS reaches BT via bluebinder/vhci and never uses the filter — so its SoC open fails and `handle_soc_events()` spins on a dead fd. BT verified fully working without it. Fix shape: stop the daemon plus a periodic guard (it gets `ctl.start`ed again on some BT power-on paths — recipe `tissot-wcnss-filter-fixup`, 30 s guard). **Generic lesson: on any "working" port, sort processes by cumulative CPU and measure the container log rate** — a vendor helper made redundant by the LuneOS stack can burn a core silently. Related: restarting a vendor BT HAL requires restarting bluebinder too — it holds the HIDL binding and does not re-bind by itself.
2. **Zero-interval GTimerSource spin.** `sleepd` at 25% of a core, ~40,000 wakeups/s: a `GTimerSource` with `interval_ms == 0` expires the instant it is dispatched (prepare TRUE → check TRUE → callback → re-arm, never reaching poll). Two callers passed 0 to mean "fire now". Fixed in sleepd branch `herrie/fix-zero-interval-timer` (separate fire-now from repeat-every-0; floor intervals). Signature: a daemon pinned at a constant fraction of a core with an enormous wakeup count and no I/O.
3. **pulseaudio pinned by an uncorked stream.** `playbackState` says Stopped but the GStreamer pipeline is still PLAYING (the Qt 6 EOS bug — full story in device-sargo); `module-suspend-on-idle` cannot suspend a sink that has uncorked inputs, so the sink renders silence forever. Diagnose: `pactl list sink-inputs` showing `Corked: no` long after the sound ended; prove the cost with `pactl suspend-sink <sink> 1` and watch pulseaudio's CPU collapse.
4. **Kernel debug spam wears flash.** sargo's `qpnp_smb2` ships `debug_mask=31`, nearly doubling idle flash writes (0.19 vs 0.10 GB/h). Measure GB/h writes and kernel-journal lines/s at idle; silence via module parameters — a `tmpfiles.d` rule works, but **not via the device-config sparse overlay** (no ordering against `systemd-tmpfiles-setup.service`, the rule can arrive after tmpfiles already ran).

---

## Quick checklist: symptom → likely cause → where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Device resets, nothing visible | Kernel panic | pstore/ramoops console dump |
| MediaTek: reboots ~20-30 s in, lk says `boot reason = 4` / `kernel_panic`, expdb has no kernel log | Panic after userspace started; often a force-loaded vendor module on a struct-layout mismatch | ramoops out of DRAM with `mtk da peek` while it loops; then diff struct-affecting config vs stock ikconfig (kernel-porting.md) |
| USB gadget "Halium initrd — Failed to boot" | initramfs couldn't finish (often rootfs.img not found) | `adb shell`, `cat /dev/kmsg` |
| `deferred probe timeout` wall, then timer/clock panic | Module load order — `modules.load` isn't topological | init v4 loader; `tools/module-order.py` |
| Driver panics on unset params (e.g. FMP self test) | `<module>.param=` cmdline not passed to insmod | init `module_cmdline_args()`; compare `/proc/cmdline` |
| Panics to adb only sometimes (storage race) | Async UFS probe, no mountroot retry | PARTNAME poll in init |
| First boot ok, disk full soon after | userdata never resized (`/dev/sd*` case miss) | `halium-boot.sh` resize; `/sys/class/block/<dev>/size` |
| Init "stops" after post-fs-data; HALs missing, EACCES everywhere | `wait_for_prop` gate blocking init's state machine | vendor rc files; `start-android-hals.sh` |
| Every HIDL getService blocks, host + container | Property gate forced with wrong literal (quoted-value trap) | gate values vs `getprop`; the awk harvest |
| "Child ended on signal Hangup(1)", container dead, no logs | Container init died pre-logging | `/dev/socket/init.log` tee + breadcrumb patches |
| 0 failed units, audio up, stuck on boot splash | Host-side ashmem → libfmq → composer queue | **container logcat**, `/dev/ashmem<boot_id>` on host |
| All vendor HALs block on vndbinder | vndservicemanager aborted (selinuxfs) | libselinux_stubs preload patch |
| Boot queue hangs at HAL enumeration | lshal hung on one HAL | per-call watchdog in luneos-device-config |
| Screen dark, system healthy | Backlight at 0 | `/sys/class/leds/lcd-backlight` |
| Compositor never starts on DRM-less device | DRM probe loop | product.env guard |
| Apps: "Failed to create wl_display" | XDG_RUNTIME_DIR split | wayland-0 symlink watcher |
| EGL_BAD_ALLOC everywhere | GPU node perms (ion/pvr_sync) | vendor ueventd.rc values → udev rule |
| Wifi service restart-looping | modprobing a nonexistent module | is the driver built-in? which modules does *this* vendor ship? |
| MTK modem "exception" | Wrong fstab chosen → NV partitions unmounted | `mount-android.sh` fstab selection |
| BT HAL can't open its node | Container ueventd ownership vs vendor ueventd.rc | chown in container |
| by-partlabel links empty | mdev hotplug needs CONFIG_UEVENT_HELPER | kernel fragment |
| No USB gadget at all after flash | Kernel/initramfs never ran | unpack + inspect the flashed image; §1.7 skip_initramfs on A8–A10 Tier B |
| Telnet port 23 answers | Kernel + initrd fine; rootfs transition failed | `cat diagnosis.log`, `/init.log` |
| Repacked image flashes fine, our init never executes (Tier B) | `skip_initramfs` honoured by the vendor kernel | §1.7; revert the skip_initramfs patches |
| Boot dies with a serial console on the cmdline | init's stdio hung on a dead UART | `console=tty0` (§1.6) |
| Container init restart-loops | Second start fails on leftover state — not the original bug | find the *first* failure (§2.6) |
| `add_service Permission denied` | selinux config files are symlinks, or stubs missing | §2.5 SELinux row |
| SIM never detected (Qualcomm) | `/dev/block/bootdevice/by-name` structure missing | replicate via udev (§ modem) |
| `Required key not found` on modprobe | Module signature enforcement (Tier B) | disable CONFIG_MODULE_SIG* |
| Audio pitched / tempo-shifted | pa-droid sample-rate quirk | `rate=48000` (hal-userspace) |
| test_hwcomposer segfaults | Blob/linker fault below the compositor | strace/gdb it; smoke-test ladder (§3) |
| test_hwcomposer runs but screen black | gralloc/copybit module | smoke-test ladder (§3) |
| Nothing from ofono/sensorfw despite config | HAL never registered, or wrong gbinder API level | `binder-list -d /dev/hwbinder`; `/etc/gbinder.conf` |
| Daemon at a fixed % of a core, ~40k wakeups/s, no I/O | Zero-interval GTimerSource re-arming instantly | Stage 5 §2; sleepd `herrie/fix-zero-interval-timer` |
| Vendor filter/helper at ~100% of a core, massive logcat rate | Daemon bypassed by the LuneOS stack spinning on a dead fd | Stage 5 §1; stop it + guard service |
| pulseaudio busy while silent; sink RUNNING forever | Uncorked stream (Qt EOS bug) | `pactl list sink-inputs`; Stage 5 §3, device-sargo |
| Idle flash writes high (GB/h at rest) | Kernel driver debug_mask / log spam | Stage 5 §4; module param via tmpfiles.d |
| Wifi/BT vendor modules never load on a rebuilt GKI kernel though kmi-crc-check passes | `CONFIG_MODULE_SIG_PROTECT` must be off | kernel-porting.md (bluejay 12 Sep) |

## Techniques from the MP01 bring-up (15 Sep 2026)

### journald loses the interesting part by default

`Storage=auto` + the default `SyncIntervalSec=5m` means journald buffers and
flushes periodically. Every debug cycle on a phone ends in a forced power-off,
so the last flush is all you get — two captures in a row ended early here, the
second holding only the **first six seconds** of a boot that ran for minutes.
It reads exactly like an early crash and is not one.

Before debugging anything that takes more than a few seconds to fail:

```
# /etc/systemd/journald.conf
Storage=persistent
SyncIntervalSec=1s
```

Also check *where* the journal actually lives. On a Halium rootfs `/var` is
commonly bind-mounted from the data partition, so `rootfs.img`'s own
`/var/log/journal/` is empty while the real journal sits in
`<data>/luneos-data/var/log/journal/<machine-id>/`.

### `sh -x` as ExecStart, for a unit that logs nothing

A `Type=notify` unit that times out with **no output at all** has usually died
before its first log statement. Do not guess which line — trace it, without
touching the script:

```
# /etc/systemd/system/<unit>.service.d/99-debug.conf
[Service]
ExecStart=
ExecStart=/bin/sh -x /usr/bin/<the-script>
```

`exec` at the end of the script keeps the PID, so `Type=notify` still works.
This is what pinned a 90s compositor timeout to `PmLogCtl def surface-manager`,
the very first command in the file.

### Reading an aarch64 core with no gdb and no debuginfo

Host `gdb` dies with an internal error on an aarch64 core, and phone rootfses
carry no debugger. This works instead:

1. `eu-stack --core <core>` — raw frame addresses.
2. Parse `NT_FILE` from `readelf -n <core>` to map each address to its library
   and subtract the library's lowest mapped address for a file offset.
3. `readelf -sW <lib>` — find the enclosing `FUNC` symbol for that offset.
4. Parse `NT_SIGINFO` **by hand** for `si_addr`. `readelf` prints the note
   header but not its contents, and `si_addr` is frequently the whole answer:
   here it was ASCII text, which says "clobbered thread pointer", not "null
   pointer". On aarch64 `si_addr` is at offset 16 in the note descriptor.

Two more things a core gives you for free on Halium:

- **The mapping list is a ground-truth inventory** of which vendor blobs really
  loaded — far better evidence than reading config files and guessing.
- **Android's property pages are mapped into the core**, so
  `strings core | grep ...` recovers live property values and driver paths from
  a dead process, with no running system.

### busybox `ls` column-formats into a pipe

```
ls /sys/class/udc | grep -v dummy | head -1
```

busybox `ls` emits `dummy_udc.0  musb-hdrc` as **one line**, so `grep -v dummy`
discards both and the script concludes there is no UDC. This cost hours of
chasing imaginary USB-controller problems. Iterate the directory instead:

```sh
for u in /sys/class/udc/*; do
    n=${u##*/}; case "$n" in *dummy*) continue;; esac
    echo "$n"; break
done
```

Related busybox traps in the same family: `head -5` is not valid (`head -n 5`),
and `ls -l a b 2>&1` interleaves differently than coreutils.

### mdev creates kernel names, not partition names

Halium's `mountroot` looks for the data partition with
`find /dev -name userdata`, but mdev only creates `/dev/sdc59`. The partition is
present and mounts fine by hand, yet the initramfs panics with "Couldn't find
data partition". Synthesise the by-name links from sysfs rather than patching
mountroot:

```sh
for blk in /sys/class/block/*; do
    pn=$(sed -n 's/^PARTNAME=//p' "$blk/uevent" 2>/dev/null)
    [ -n "$pn" ] || continue
    [ -e "/dev/$pn" ] || ln -sf "/dev/${blk##*/}" "/dev/$pn"
done
```

### Debug boot images cannot observe a full boot

If the debug image's cmdline triggers an unconditional drop-to-shell (Halium's
`enable_adb` → `panic "Initramfs Debug Mode"`), that image **never reaches
systemd**, so it can never show you a userspace problem. Only the normal image
boots through. And you cannot finish the boot by hand from the debug shell —
`switch_root` requires PID 1.

Consequence for the workflow: the normal image often has no network at all (the
USB gadget is set up inside `panic()`), so the loop is: boot normal → let it
run → reflash debug → mount the data partition → read the journal that the
normal boot left behind. Which is only possible if journald was syncing (above).

### This class of device does not charge while you debug it

Neither fastboot nor the initramfs runs any charging policy, and the kernel log
says so (`get_charger_charging_current: ... failed: -95`). Hours of reflash
cycles flatten the battery, and the symptom — "rebooted to a battery symbol
after some minutes" — looks exactly like a crash or watchdog reset. Charge it
powered-off on a real charger, and budget for it in long sessions.

## Two UDCs: `"$(ls /sys/class/udc)"` is a latent bug on every port

`android-gadget-setup` (meta-android) bound the gadget with

```sh
write $GADGET_DIR/g1/UDC "$(ls /sys/class/udc)"
```

which silently assumes the device has exactly one USB device controller. The
MP01 has two, because its **stock** kernel config sets `CONFIG_USB_DUMMY_HCD=y`,
registering a fake `dummy_udc.0` beside the real `musb-hdrc`. The write became
both names with whitespace between them, the kernel rejected it, the gadget
never bound, and the device had **no adb at all** on the normal image. The only
trace is this, and it is easy to read straight past:

```
android-gadget-setup: === Writing dummy_udc.0
musb-hdrc into /sys/kernel/config/usb_gadget/g1/UDC
```

`dummy_udc.0` is no help even when it parses alone: it accepts the bind and
does nothing.

This is the *same* bug as the initramfs one (`ls /sys/class/udc | grep -v dummy |
head -1`, where busybox `ls` column-formats into a pipe). Two different scripts,
one layer apart, same wrong assumption - so when you fix one, grep the tree for
the other:

```
grep -rn "class/udc" <layers>
```

Fix in both places is the same:

```sh
first_real_udc() {
    for _u in /sys/class/udc/*; do
        [ -e "$_u" ] || continue
        _n=${_u##*/}
        case "$_n" in *dummy*) continue ;; esac
        echo "$_n"; return 0
    done
    return 1
}
```

Why no other port hit it: sargo, tissot, mido and mindphone each expose a single
UDC, so the unparsed `ls` output happened to be one valid name. It was never
correct, only lucky. Check `CONFIG_USB_DUMMY_HCD` in a new device's stock config
to know in advance.

## The reboot that is not a crash: MediaTek's 31s watchdog

A device resetting every ~90-120s with **no panic and no oops** in the journal
is probably the SoC watchdog, not a crash:

```
mtk-wdt 10007000.watchdog: Watchdog enabled (timeout=31 sec, nowayout=0)
[wdtk] kick watchdog
[wdtk] kick watchdog
[wdtk] kick watchdog        <- then silence, and the journal simply ends
```

Grep for `kick watchdog` and look at the interval between kicks against the
declared timeout. The journal's last timestamp is *not* the reset time - it is
the last flush before it - so expect the gap. Nothing in the log says "reboot",
which is exactly what makes it look mysterious.

## Disabling the MediaTek watchdog while debugging

A device that resets every ~90s makes measurement almost impossible - half the
samples come back from a machine that rebooted mid-command. On MT6789 the
watchdog can be turned off at runtime with the standard magic close:

```sh
printf 'V' > /dev/watchdog
```

Verified on the MP01: uptime went from resetting at ~90-104s to passing 180s and
climbing. It lasts for that boot only, so do it as the first command of every
debug session, and remember that a suspiciously empty `journalctl -b` usually
means the device rebooted rather than that nothing happened.

Check `cut -d. -f1 /proc/uptime` in the *same* command as any measurement. A
reading with a low uptime invalidates everything else in that sample.

## Android property service: enabled, but not running

`setprop` failing from a host process looks like a permissions or socket
problem. On the MP01 it was simply that the service was dead:

```
$ systemctl is-active android-property-service
inactive
$ journalctl -u android-property-service -b
-- No entries --
```

Enabled, `After=android-system.service`, never started, and *no journal entries
at all* - so it had not failed, it had never been asked to run.

Reading properties still works, which is what makes this confusing:
`getprop ro.hardware` returns `mt6789` because the property area is mapped
read-only. Only writes need the service:

```
libc: Unable to set property "vendor.debug.sf.hwc_pid" to "20896": connection failed
```

MediaTek's hwcomposer sets properties during init, so this is not cosmetic.
Starting the unit by hand fixes writes immediately (`setprop debug.test 1` then
`getprop debug.test` returns 1).

Worth checking on any Halium port: the unit being *enabled* is not evidence it
ran. `systemctl is-active` plus an empty `journalctl -u <unit> -b` is the tell.

## Techniques from the MP01 bring-up (16-17 Sep 2026)

### A clean-shutdown reboot loop is a userspace policy, not a crash

A device that goes down every ~3.5-4 min with a *clean* systemd shutdown in
`journalctl -b -1` ("Reached target System Power Off") is being shut down on
purpose. Candidates seen on the MP01, in order: `sleepd` (masked during
bring-up), and batteryd's critical-percent check fed by a fuel gauge that
reports `capacity=-1` (`CHG_LOGIC: Battery at -1%, at or below the critical
level of 2%`). `journalctl --list-boots` shows the rhythm at a glance.

### Charger-mode boots and DRM master

A MediaTek device that is never truly off (holding Power just resets it) boots
with `androidboot.bootreason=usb` whenever a cable is attached, and Android's
`init.halium.rc` starts `/system/bin/charger`, which takes DRM master and never
gives it back. `lsof | grep card0` shows who holds it. `start-android-hals.sh`
stops it via `DISPLAY_CONFLICT_MATCH` - but there are **two copies** of that
script (`meta-android` and `meta-luneos`), and the `meta-luneos` one is what
ships. Diff the deployed file against both before assuming a fix is in.

### systemd ignores `export ` lines in `EnvironmentFile=`

`Ignoring invalid environment assignment 'export QT_QPA_FORCE_HWC2=1'` is easy to
scroll past. The fix looked present in the file and never reached the process.
Always confirm with `tr '\0' '\n' < /proc/<pid>/environ`.

### Client or compositor? Measure both sides of a wrong-sized window

For "the app is drawn too small / cropped" there are two independent views:

- **Client (web apps):** WebAppMgr runs Chromium with
  `--remote-debugging-port=9998`. `adb forward tcp:9998 tcp:9998`, list pages at
  `http://127.0.0.1:9998/json`, and evaluate `screen`, `innerWidth/Height`,
  `outerWidth/Height`, `devicePixelRatio`, `visualViewport.scale` and
  `document.hidden` over the page's websocket (`Runtime.evaluate`). Hidden pages
  are not what is on screen - measure the one with `hidden:false`.
- **Compositor:** a temporary `qWarning` in `WebOSSurfaceItem`, connected to
  `QWaylandSurface::bufferSizeChanged/destinationSizeChanged/sourceGeometryChanged/
  bufferScaleChanged` and the item's width/height, prints what the client
  actually committed against the item it is drawn into. Build it from a git
  worktree at the deployed `SRCREV` through a temporary `externalsrc` entry, and
  push only `libWebOSCoreCompositor.so` from `packages-split/` (the stripped one).
  Remove the `externalsrc` before building an image.

On the MP01 portrait the compositor side was all consistent (600x657 buffer,
destination, source and item), so the crop is inside Chromium, which reports
`screen` as the *unrotated* 800x600 `landscape-primary`. Screenshots:
`luna-send -n 1 luna://com.webos.surfacemanager/captureCompositorOutput
'{"output":"/tmp/x.png","format":"PNG"}'` or the shell's own
`/media/internal/screencaptures/`; both are in panel orientation, so rotate
before measuring.

### Resolving a deferred ASoC card

`cat /sys/kernel/debug/devices_deferred` names the card;
`/sys/kernel/debug/asoc/components` lists what registered. Pull
`/proc/device-tree` with `adb pull`, read the machine node's phandle properties
with `od -An -tx1`, and find the node whose `phandle` matches. That names the
missing component; its compatible string names the module. busybox `od` and
`head -c` are too limited for this on the device - do it on the host.

### Is this subsystem's module even loaded? Compare with the vendor's list

```sh
M=/android/vendor_dlkm/lib/modules; L=$(lsmod | cut -d" " -f1 | tr - _)
while read m; do b=$(basename $m .ko | tr - _); echo "$L" | grep -qx "$b" || echo "$m"; done < $M/modules.load
```

A whole subsystem missing from that output (camera, audio) points at module
loading, not at the HAL. See hal-userspace.md on letting the vendor's init load
them.

### Two ways to write a file on the device

Files placed with `adb push` from a local copy behaved every time. Several
bootloops in this bring-up followed writes done as `adb shell "cat > file
<<EOF ... EOF"`; the correlation is strong but not proven (the device also had
independent reset causes). Prefer `adb push`, keep backups outside directories
that are scanned (a `.orig` plugin next to the real one gets loaded too).

### Test a service environment variable without writing a file

`systemctl set-environment VAR=1; systemctl restart <unit>; systemctl
unset-environment VAR` applies it to one start and leaves nothing behind. That is
how `HYBRIS_PREFER_VNDK` was proven on the MP01 before being made permanent.

### Waydroid stops the host's nfcd

Upstream Waydroid's `container_manager.py` runs `systemctl stop nfcd` when the
container starts and only starts it again when the container stops; a failed
container start therefore leaves NFC dead until reboot. LuneOS keeps NFC on the
host (meta-luneos waydroid patch 0010 removes both calls). A fresh userdata has
no `/var/lib/waydroid/waydroid.cfg`, so the session units skip themselves until
`waydroid init` has downloaded its ~1 GB of images - "does not start" right
after a reflash is usually just that.

When it genuinely does not start, `/var/lib/waydroid/waydroid.log` has the
`lxc-start` output. On the MP01 it was `lxc_spawn: Invalid argument - Failed to
clone a new set of namespaces`: the kernel has no `CONFIG_IPC_NS` /
`CONFIG_USER_NS` (MediaTek GKI KMI-poison options), and LXC clones every
namespace type unless told to keep the host's. The Android container already
had `lxc.namespace.keep = ipc user`; Waydroid's generated config did not.
`waydroid-luneos-prepare` now adds it for whichever of the two is missing from
`/proc/self/ns`, after `waydroid upgrade -o` has regenerated the config (a hand
edit to the config is overwritten on the next session start).

## Swap the kernel under a known-good ramdisk to split kernel from userspace

When a port fails at something as basic as mounting, the first question is
whether the kernel or the userspace is at fault, and almost every other
experiment confounds the two. The cheap separator:

**Take the stock (or LineageOS recovery) boot image for the device and replace
only the kernel with yours.** Their ramdisk, their cmdline, their load
addresses, their page size - which sounds like one variable and is not. Read
the warning below before trusting the result.

On athena, our 4.19 kernel under LineageOS's recovery ramdisk mounted the exact
partition that failed for us:

```
[5.472028] EXT4-fs (mmcblk0p77): mounted filesystem with ordered data mode
```

and Android init reached `enforcing=1`.

**This is not the single-variable test it looks like, and that cost two wrong
diagnoses on athena.** You swap the kernel, but the donor image brings its own
**command line** with it. On athena the donor's cmdline lacked `selinux=0`,
which is what our failing boot's cmdline had - and `selinux=0` turned out to be
the whole bug. The swap "proved the kernel was fine" only because it had
quietly changed a second variable.

**So: diff the two `Kernel command line:` lines before drawing any conclusion
from a swap.** It is one grep, and here it was the entire answer sitting in the
logs through two wrong theories.

Read a passing swap narrowly even after that: it shows the kernel is not
*unconditionally* broken under the donor's cmdline. Only a swap that *fails* is
conclusive on its own.

Caveats worth stating before you run it:

- **Strip cmdline tokens that are fatal to your kernel version.** athena's stock
  cmdline carries `swiotlb=1` — harmless on their 4.4, hangs our 4.19 before any
  console exists. Copying it verbatim produces a black screen that tells you
  nothing.
- **A recovery that never comes up is inconclusive, not a result.** Say so in
  advance so nobody over-reads it. If Android's init bails because your kernel
  defaults SELinux off, adding `selinux=1 androidboot.selinux=permissive`
  changes nothing the mount path can see.
- **Check the logs you already have first.** On athena this experiment had
  already been run and was sitting in the log archive the porter had sent;
  an image was built to re-run it anyway.

## Slice a multi-boot journal by boot before you grep totals

A journal collected over a bring-up session spans every boot since the last
wipe, including all the ones from before the bugs were fixed. A `grep -c` over
the whole file mostly counts the *first* boot, which is usually the longest and
the most broken.

This produced three wrong conclusions in one day on athena. Whole-file totals
said `surface-manager` had crashed 954 times and `keymaster-3-0` 281 times, both
of which read as live crash loops. Per-boot:

```
boot  keymaster SIGABRT   surface-manager coredump   nfcd regFN fail
   1                281                        923                 1
   4                  0                         31                 1
2,3,5..13             0                          0                 1
```

Every keymaster crash was in boot 1. Every compositor crash was in boots 1 and
4, and both had been fixed by a vendor swap several boots earlier. Meanwhile the
one genuinely live defect - a daemon failing a binder registration - fired
exactly once per boot in **all thirteen**, and was invisible in the totals
because 1 does not stand out next to 281.

**The method:**

```sh
grep -an "Booting Linux on physical CPU" journal.txt | cut -d: -f1   # boundaries
LAST=$(grep -an "Booting Linux on physical CPU" journal.txt | tail -1 | cut -d: -f1)
tail -n +$LAST journal.txt > lastboot.txt                            # then grep this
```

Then, for anything that looks like a crash loop, count it **per boot** before
believing it. A defect that appears once per boot in every boot is stable and
reproducible and is almost always the one worth chasing; a defect with a huge
count confined to one boot is usually already fixed. Two things co-occurring
inside boot 1 is not evidence that one causes the other - the boot where
everything was broken is exactly where every pair of symptoms correlates.

Note also that the RTC on a freshly flashed device starts wrong, so one boot can
carry several unrelated timestamp bases (`Aug 05` → `Jan 01` → the real date).
Sort and slice by the boot marker, never by timestamp.

## A kernel `dev_err` is not a failure - read the return path

Kernel drivers log optional and non-fatal conditions at error level all the
time. Two in athena's NFC driver both look fatal and both return success:

```
nq-nci 6-0028: nfc_ldo_config: regulator entry not present
nq-nci 6-0028: nfcc_hw_check: - NFCC HW not Supported
```

- `nfc_ldo_config()` logs that with `dev_err` and then `return 0`, with the
  comment *"return success as it's optional to configure LDO"*.
- `nfcc_hw_check()`'s message is the `default:` arm of a switch on the chip ID
  **read back from the part**; it logs, breaks, then falls into
  `ret = 0; goto done`. The genuine failure is a different label and a different
  string - `err_nfcc_hw_check`, *"NFCC HW not available"*, `-ENXIO`.

Reaching that switch at all proved the chip had answered NCI RESET over i2c -
so the message that read as "no NFC hardware" was in fact positive evidence that
the hardware was alive, powered and addressable. A device-tree change was being
prepared on the strength of the opposite reading.

**Before acting on a kernel error message, open the driver and follow the
return value to the caller.** Grep the exact string, then check whether that
path sets a non-zero `ret`. It takes two minutes and it is the difference
between debugging the hardware and debugging nothing.

## Techniques from the Galaxy A3 (2015) bring-up (7-8 Oct 2026)

- **A reset at the same second of every boot is a subsystem crash, not power.** Here the modem lost its EFS
  (rmt_storage) and restart level SYSTEM reset the SoC ~10 s after "Brought out of reset". Read the
  battery before suspecting it: a RAM-booted initramfs that holds with a telnet shell showed 99 %.
- **Log a boot that dies before adb:** start `while :; do dmesg > F.new && mv F.new F; sync; sleep 0.5; done`
  from the initramfs (chrooted into the rootfs, before switch_root); the next boot reads the file. Keep
  slow things such as `logcat -d` out of that loop (it blocks until logd is up) and remove the loop
  afterwards: the half-second sync made the UI sluggish.
- **Busybox on the rootfs differs from GNU:** no `timeout` (use `cmd & p=$!; (sleep N; kill $p) & wait $p`),
  `dd` has no `conv=fsync` (prints its usage and writes nothing — a restore script "verified" six times
  without writing), `head` wants `-n N`.
- **Never `pkill -f`/`pgrep -f` a pattern that also appears in your own adb shell command line**; select
  by `/proc/<pid>/cmdline` instead.
- **Do not `nsenter` into the container's mount namespace on a 3.x kernel**: copying a vendor dir through
  `/proc/<pid>/root` and bind-mounting in the container hung the phone twice. Fix the image instead.
- **Native backtraces of a hung HAL:** `lxc-attach -n android -- /system/bin/debuggerd -b <container pid>`
  (the container has its own pid namespace; take the pid from logcat or `lxc-attach ... pidof`).
- **Reboot reliably from adb:** `systemd-run --on-active=2 /bin/systemctl --force reboot
  --reboot-argument=normal`; a backgrounded command dies with the adb session, and a plain reboot can
  land a Samsung device in charger mode.
- **opkg install can run other packages' pending postinsts.** Installing one ipk configured a long-pending
  android-kernel-bootimg postinst, which dd'd a kernel over lk2nd. Dry-run first:
  `opkg install --noaction`, and check for unpacked packages in /var/lib/opkg/status.


## Techniques from the SM-T220 bring-up (3-4 Oct 2026)

**A process "killed, status=9/KILL" with no log and no core.** Do not look for a
sender in userspace. Trace the kernel's signal generation, filtered to SIGKILL:

    T=/sys/kernel/tracing                     # tracefs is mounted on Halium images
    echo 0 > $T/tracing_on; echo > $T/trace
    echo "sig==9" > $T/events/signal/signal_generate/filter
    echo 1 > $T/events/signal/signal_generate/enable; echo 1 > $T/tracing_on
    ... reproduce ...; echo 0 > $T/tracing_on; grep signal_generate $T/trace

The line names the *sending* thread. `comm=droid-sink-deep ... code=128` (SI_KERNEL,
hard-IRQ context, `d.h` flags) means the kernel killed it itself: here
`RLIMIT_RTTIME` expiring on a `SCHED_RR` thread. A sender that is `init` or
`systemd` is a different problem.

**strace a service that only fails under its real environment.** Running the
daemon from a shell (or `su`) changes the environment enough to hide the bug. Run
it as a transient unit instead, wrapped in `strace`, with the unit's own
environment file: `systemd-run --unit=x -p EnvironmentFile=-/etc/default/foo
/tmp/strace -f -e trace=openat,newfstatat -s 160 -o /tmp/x.log /usr/bin/foo ...`.
There is no `strace` on the image, but the build's deploy directory has an aarch64
one (`tmp/deploy/ipk/aarch64-halium/strace_*.ipk`): `ar p ... data.tar.zst | zstd -dc
| tar -x`, then pipe the binary over ssh into `/tmp`. The same works for
`alsa-utils-amixer`/`-aplay`. To watch a long-running daemon do its work attach
with `-f -p $(pidof daemon)` first and *then* trigger the action; an attach that
starts after the action sees nothing.

**Audio with nobody listening.** Facts that were worth more than ears:
`Headphone Plugged In`, the headset jack as an input device (read the switch state
with an `EVIOCGSW` ioctl in `python3`; `evtest` is not on the image) so every
speaker test can refuse to run unless the jack reads empty; a full
`amixer contents` dump during real HAL playback compared with one during a manual
setup, parsed on the host (BusyBox `diff` on the device printed nothing for files
that differed); and `dmesg` lines such as `mtk_pcm_I2S0dl1_prepare` to see which PCM
the HAL really opened. A microphone loopback was tried and gave digital zero:
do not rely on it. Ask the person at the device which of two timed variants they
heard, and label each variant with a wall-clock time.

**Boot-time kernel messages are gone by the time you ssh in.** The dmesg ring and
the journal's kernel part rotate within minutes on a chatty MTK kernel. If you need
the audio/accdet/i2c probe lines, reboot and read them immediately, or capture
`journalctl -k -b` before the first boot's chatter wraps it.

**`logcat` is flooded by one tag** (here `AudioALSAPlaybackHandlerNormal`, 35,000
lines) so early HAL init lines are overwritten. `logcat -b all -c` right before the
restart you want to observe, and filter the tag out when reading.

**Other `luna-send` facts:** `luna://com.webos.service.applicationmanager/launch`
and `close` print a reply without `-i`; `-i` with a pipe printed nothing. Call
results are also in the journal (`LunaAppManager`, `appinstalld`,
`ApplicationInstallerUtility` log the exact `opkg` command line they run, which is
how an install failure turned out to be a dependency-database problem).

| Symptom | Cause found on SM-T220 | Where |
|---|---|---|
| PulseAudio dies about 1 s after "Daemon startup complete", status 9 | `RLIMIT_RTTIME` on the SCHED_RR sink threads | `signal_generate` trace |
| Speakers silent, headphones fine, HAL says "undefined in AudioParamOptions" | vendor parser builds its path in an uncleared `malloc` buffer | `strace`, path with stray bytes |
| Web-app audio silent, nothing reaches PulseAudio | `waitid(P_PIDFD)` missing; then `reference-media-pipeline` ENOENT; then too few VDEC/ADEC | `umediaserver` journal, `strace -f -p` |
| Reset 57 s into every boot, `BUG_ON(!sk)` in `bt_sock_reclassify_lock` | Samsung stubbed `hci_sock_create()` | pstore ramoops |
| `init: Processed ctl.start for 'X' from pid: 0` for a "disabled" service | `start-android-hals.sh` starts everything init skipped | `deviceinfo_android_skip_services` |
| `appinstalld2`: `Failed to execute child process "ar"` | standard image has no `ar` | its journal |
