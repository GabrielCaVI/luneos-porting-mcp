# LuneOS GSI/GKI Bring-up Debugging Playbook

Stage-by-stage playbook for a LuneOS GSI/GKI port that does not come up, distilled from failures hit and diagnosed on real hardware.

Devices behind it: Pixel 3a (sargo), Pixel 6a (bluejay), Pixel 7 (panther), the MediaTek ports (mindphone, MP01, radon, Titan Pocket, SM-T220), BlackBerry KEY2 (athena) and Galaxy A3 (2015). Every failure mode in the core text was hit on hardware and diagnosed; the fixes named are the ones that shipped. Material from the UBports, Droidian and SFOS porting guides is attributed inline — that is other distros' documented experience, not LuneOS-verified, and SFOS-derived command spellings were extracted from summarized pages, so check the cited source if one fails. Work through the stages in order: each stage's failures are only visible once the previous one is cleared, and several of these bugs hide behind one another. HAL and subsystem detail lives in hal-userspace.md; kernel config and module-loading rules in kernel-porting.md and kmi-crc-matching.md; boot-image construction and the initramfs init patches in boot-images.md.

**The install/boot model these stages assume:** `fastboot flash vbmeta --disable-verity --disable-verification`, our `boot.img` (and `init_boot.img` on A13-launch devices), stock `vendor_boot`/`vendor`/`super` untouched, `rootfs.img` + `android-rootfs.img` (the Halium GSI system image) as files inside an unencrypted ext4 `userdata`. The LuneOS initramfs loop-mounts `rootfs.img` as `/`, and the Android container mounts the GSI at `/android` with the device's real `/vendor` bound in.

## Method

**Collect evidence before changing anything** (SFOS hadk-hot, <https://sailfishos.wiki/books/hardware/page/hadk-hot>). `dmesg -w` live; boot with `audit=0` (kills audit spam) and `printk.devkmsg=on` (unthrottled userspace → kmsg — the stock bluejay cmdline already carries it); `journalctl -b-1` reads the previous boot once the journal is persistent (tooling appendix); logcat output differs run as root vs user.

**Diff your built `.config` against the vendor's before adding a single debugging aid.** If the vendor publishes a working config — a stock defconfig, `/proc/config.gz`, a factory image's `merged/.config` — this costs two minutes, needs no hardware, and is the highest information-per-effort step on a port that fails to boot:

```sh
grep -v '^#' built.config    | grep -v '^$' | LC_ALL=C sort > ours.cfg
grep -v '^#' stock_defconfig | grep -v '^$' | LC_ALL=C sort > stock.cfg
LC_ALL=C comm -23 ours.cfg stock.cfg     # what we added
LC_ALL=C comm -13 ours.cfg stock.cfg     # what we changed or dropped
```

Anything in the first list that touches **early boot** — console drivers, netconsole built in rather than modular, memory parameters, LSM or cgroup changes — is a boot-failure suspect before any of your porting work is. A splash hang with no console, gadget, pstore or initramfs trace came down to two lines of an eight-line diff, `CONFIG_FRAMEBUFFER_CONSOLE=y` and a built-in `CONFIG_NETCONSOLE=y`, both added as bring-up instrumentation (found on radon; see device-radon.md).

**Instrumentation is a change to the thing under test.** That fbcon/netconsole block made the first boot fail, then made the failure unobservable: no adb even in an `enable_adb` image, empty pstore despite `PSTORE_CONSOLE=y`, nothing from the initramfs trace — one symptom, misread as evidence about userspace. Prefer instrumentation that does not alter the kernel, such as `initrd_log_fail` (Stage 0).

**Substitute in both directions, and hold the cmdline fixed.** Hybrid boot images split kernel from ramdisk, but one direction is not a result:

| test | reading |
|---|---|
| vendor kernel + your ramdisk → hangs | "the ramdisk is at fault" — **wrong on its own** |
| your kernel + vendor ramdisk → hangs | both hang ⇒ the common factor is *your* kernel |

The cheapest kernel-vs-userspace separator is to take the stock (or LineageOS recovery) boot image and replace only the kernel. That is **not** a single-variable test: the donor brings its own command line, load addresses and page size. **Diff the two `Kernel command line:` lines before concluding anything.** A swap once "proved the kernel fine" only because the donor's cmdline lacked the `selinux=0` that was the whole bug (found on athena; see device-athena.md, and kernel-porting.md § selinux=0: do not pass it on a Halium port). Caveats:

- A passing swap shows only that the kernel is not *unconditionally* broken under the donor's cmdline; only a failing swap is conclusive on its own.
- Strip cmdline tokens fatal to your kernel version (`swiotlb=1` is harmless on a 4.4 stock kernel and hangs a 4.19 before any console exists).
- A recovery that never comes up is inconclusive, not a result.
- The kernel's SELinux state is visible to the mount path: keep the donor's SELinux tokens, or change them as a separate variable.
- Check the logs you already have first — the experiment may already be in a log archive.

**Slice a multi-boot journal by boot before you count anything.** A journal from a bring-up session spans every boot since the last wipe; whole-file `grep -c` mostly counts the first, longest, most broken boot. Hundreds of compositor and keymaster crashes all turned out to sit in boots 1 and 4 and were already fixed, while the one live defect fired once per boot in all thirteen and was invisible in the totals (found on athena; see device-athena.md).

```sh
grep -an "Booting Linux on physical CPU" journal.txt | cut -d: -f1   # boundaries
LAST=$(grep -an "Booting Linux on physical CPU" journal.txt | tail -1 | cut -d: -f1)
tail -n +$LAST journal.txt > lastboot.txt                            # then grep this
```

A defect that appears once in every boot is stable, reproducible and usually the one worth chasing; a huge count confined to one boot is usually already fixed. Co-occurrence inside the boot where everything was broken is not evidence of causation. A freshly flashed device's RTC starts wrong, so one boot can carry several timestamp bases — slice by the boot marker, never by timestamp.

**A kernel `dev_err` is not a failure — read the return path.** Drivers log optional and non-fatal conditions at error level. Grep the exact string, open the driver and check whether that path sets a non-zero `ret`. `nq-nci`'s `nfc_ldo_config: regulator entry not present` returns 0 by design, and `nfcc_hw_check: - NFCC HW not Supported` is the `default:` arm of a switch on a chip ID *read back from the part* — positive evidence the chip answered; the real failure is `NFCC HW not available`/`-ENXIO` (found on athena; see device-athena.md).

**Check every measurement against uptime.** On a device that may reset under you, run `cut -d. -f1 /proc/uptime` in the *same* command as any measurement; a low uptime invalidates the sample. A suspiciously empty `journalctl -b` usually means the device rebooted, not that nothing happened.

## Stage 0 — Does the kernel even boot?

Nothing on the screen, no adb, device reboots or sits dead.

### Ramoops / pstore console

On a kernel panic the console log survives the reboot in pstore (`/sys/fs/pstore/`). The bluejay MCT clock panic — the `deferred probe timeout` wall and `Kernel panic: exynos4_timer_resources: unable to determine tick clock rate` — was read from the ramoops dump. If the device panics and resets, pull pstore before touching anything else. Not every kernel has it: athena's defconfig and DT carry no ramoops at all, so a panic before the initramfs is invisible there.

**A reset at the same second of every boot is a subsystem crash, not power.** A modem that lost its EFS (rmt_storage) with restart level SYSTEM reset the SoC ~10 s after "Brought out of reset". Read the battery before suspecting it: a RAM-booted initramfs holding a telnet shell showed 99 % (found on a3-2015-halium; see device-a3-2015-halium.md).

### MediaTek: `expdb` when there is no pstore and no gadget

MediaTek kernels frequently ship **no pstore console**, and if the USB controller is a vendor module (1.8) there is no debug gadget either — a failing device can be completely mute, nothing on `lsusb` but the preloader flashing past on each reset. `expdb` is the way in: a partition holding preloader/lk logs, AP watchdog status and the kernel's `RAM_CONSOLE` (kmsg from before the reset), readable over the preloader connection that still enumerates (mtkclient usage: tools.md). On the MP01 it showed our init running and the debug shell coming up, then:

```
RAM_CONSOLE detect abnormal boot wdt_status:0x6, aee_exp_type:1
```

**Read `wdt_status`.** Non-zero means the hardware watchdog reset the SoC rather than the kernel panicking — a different problem (next section).

**expdb can come back empty where it matters.** lk may log `kedump add: SYS_PSTORE_RAW ... kedump mini done` on every reset while the kedump region reads back as zeros; lk's own log then shows only `lk boot reason = 4` (`androidboot.bootreason=kernel_panic`, `exp_type 0x2` = kernel exception) — *that* it panicked, not *why* (found on titanpocket; see device-titanpocket.md). Read DRAM instead.

### MediaTek: read ramoops straight out of DRAM over the preloader

MediaTek lk passes ramoops on the command line (lk's log in expdb shows `ramoops.mem_address=… ramoops.mem_size=… ramoops.console_size=… ramoops.pmsg_size=…`), runs with `kedump: ddr reserve mode enabled`, and a panic reset is a *warm* reset — so DRAM still holds the dying kernel's log when the preloader comes past on the next loop, and mtkclient's DA can read it:

```
mtk da peek 0x54410000 0xe0000 --filename pstore.bin    # address/size from lk's cmdline
```

- the kernel needs `CONFIG_PSTORE_RAM=y` (stock MTK defconfigs have it);
- **catch the preloader while it is bootlooping.** Holding Power to switch off, or the Volume-Down BROM route from a powered-off phone, loses DRAM. Read DRAM first; do expdb and other partitions in a second session;
- the region is a set of `persistent_ram_buffer` zones, each starting with `DBGC` (0x43474244 LE), then `u32 start`, `u32 size` and a ring buffer. `start == size` means the zone never wrapped; otherwise `size` is the capacity and the oldest byte is at `start`. Look for the console zone and the pmsg zone (Android userspace logging); most others are empty dmesg-dump slots;
- `loglevel=` does not hide the panic: oops and panic lines are emitted at emergency level.

On the Titan Pocket this gave the whole answer after five flash rounds of initramfs instrumentation had shown nothing: a force-loaded `wlan_drv_gen3` crashing on a struct-layout mismatch 22 s into boot, with pmsg showing the container already up (see device-titanpocket.md; the rule is kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe). A staging-kit `dump-expdb.sh` that does DRAM first, then `mtk r expdb,cache`, and decodes everything is the convenient shape.

### MediaTek: the hardware watchdog

The preloader arms a **hardware watchdog** before handing off; stock Android's init feeds it, ours does not. `CONFIG_WATCHDOG_HANDLE_BOOT_ENABLED=y` makes the kernel watchdog core pet it until userspace takes over — but only once the driver is loaded, and on MediaTek `mtk_wdt.ko` is a vendor module. Until modules load nothing feeds it, and the SoC resets after ~20–30 s — happily killing a working debug shell (1.9).

Later in boot the same watchdog shows up as a reset every ~90–120 s with **no panic and no oops**:

```
mtk-wdt 10007000.watchdog: Watchdog enabled (timeout=31 sec, nowayout=0)
[wdtk] kick watchdog
[wdtk] kick watchdog        <- then silence, and the journal simply ends
```

Tells: `wdt_status` non-zero in expdb; a suspiciously regular reset interval; `kick watchdog` intervals against the declared timeout. The journal's last timestamp is the last flush, not the reset.

**Disable it for a debug session** with the standard magic close, first thing every boot (it lasts one boot; verified on MT6789, where uptime went from resetting at ~90–104 s to climbing past 180 s):

```sh
printf 'V' > /dev/watchdog
```

This is MediaTek-specific in practice: on the Qualcomm and Tensor ports the watchdog driver (`msm_watchdog`/`qcom_wdt`) is built in. Check `CONFIG_<vendor>_WATCHDOG` in the stock config before assuming.

### Recording the initramfs to a spare partition: `initrd_log_fail`

`initramfs-scripts-halium` (meta-android) can write its own dmesg to flash, for devices where nothing else survives:

- `initrd_log_fail` on the kernel command line turns it on. A background loop writes dmesg, mounts and the current stage every 3 s, and `panic()` writes a failure record. With it set, a failing initramfs **holds** (gadget and adbd up) instead of returning, so the device stops rebooting and the record stays the last thing written. Without the hold, `/bin/sh` with no console returns at once, init exits, and the kernel panics into another loop.
- default targets are `init_boot_a` (failure) and `init_boot_b` (progress), spare on the MT6789. **`initrd_log_part=<partname>`** names one partition instead: progress at 0 MiB, failure at 64 MiB. `cache` works where LuneOS bind-mounts over it from userdata (stock Android reformats it if it ever boots again).
- with `initrd_log_part=` the logger starts right after `/proc`, `/sys` and devtmpfs, retrying for 10 s until the partition appears — which only works with built-in storage. Without it, logging starts after module load and mdev, and a boot that dies earlier writes nothing.
- the boot-image header command line is the cheap way to set it on MediaTek: lk prints the cmdline it hands the kernel, so expdb confirms the flags arrived. Repacking the header needs no kernel rebuild, but a boot image with an AVB footer needs a fresh footer (meta-android `lib/halium/avb.py`).

Absence is informative: if the image demonstrably booted (lk shows the flags) and the partition holds no record, the boot died before the logger started or somewhere the initramfs never sees — e.g. the Android container's module loading after switch_root.

## Debug channels

### The debug boot image (`fastboot boot`, no flashing)

Every device kit ships a `boot-<device>-luneos-debug.img`: the same kernel + initramfs with `enable_adb` on the cmdline (construction: boot-images.md § Debug images). With `enable_adb`, init panics into the initramfs adbd debug shell and the device enumerates as **"Halium initrd — Failed to boot"**:

```
adb shell
cat /dev/kmsg        # live kernel log, includes every initramfs message
```

The same shell appears without the debug image when the initramfs itself fails (e.g. `rootfs.img` not found). If you get the gadget, kernel and initramfs core are fine. "luneos initramfs failed:" with an empty reason is not a failure: `panic()` doubles as the debug-mode entry point and the reason is the *next* kmsg line (`Initramfs Debug Mode`).

**A debug image cannot observe a full boot.** The drop-to-shell is unconditional, so it never reaches systemd and can never show a userspace problem, and you cannot finish the boot by hand (`switch_root` requires PID 1). The normal image often has no network (the gadget is set up inside `panic()`), so the loop is: boot normal → let it run → `fastboot boot` the debug image → mount the data partition → read the journal the normal boot left behind. That only works if journald was syncing (tooling appendix).

### The telnet / USB-networking ladder

The Halium-family initramfs exposes a telnet path that works when adb doesn't, and the gadget tells you how far boot got (UBports: <https://docs.halium.org/en/latest/porting/debug-build/early-init.html>, <https://docs.ubports.com/en/latest/porting/build_and_boot/Boot_debug.html>; SFOS: <https://github.com/mer-hybris/hybris-boot>):

- **Watch the boot stage from the host** via the iSerial string:

  ```
  while : ; do lsusb -v 2>/dev/null | grep -Ee 'iSerial +[0-9]+ +[^ ]' ; done | uniq
  ```

  In hybris-boot: `"Mer Debug setting up (DONE_SWITCH=no)"` → `"Mer Debug telnet on port 23 on usb0 192.168.2.15"` (failed in the initrd) or `"GNU/Linux device on rndis0 10.15.19.82"` (booted).
- **telnet `192.168.2.15`:** port 23 = still in the initrd; port 2323 = post-switch_root debug in the hybris-boot scheme. Host side: take `192.168.2.1`, and give the interface a MAC if it shows `00:00:00:00:00:00`. First commands: `cat diagnosis.log` and check `/init.log`.
- **Reading the silence:** no USB device at all = kernel or initramfs never ran (unpack and inspect the flashed image; on A8–A10 Tier B suspect `skip_initramfs`, 1.6); port 23 answering = kernel + initrd fine, the rootfs transition failed.
- **Halting boot deliberately:** hybris-boot honours `init_enter_debug`/`init_enter_debug2` marker files and `fastboot boot boot.img -c bootmode=debug`; UBports' recovery flow waits until `echo continue > /init-ctl/stdin`. LuneOS has no halt-boot flag file; `enable_adb` is the analogue.

**LuneOS's own initramfs** starts `telnetd` at **`192.168.2.15` port 23** alongside the adbd gadget on its panic/debug path, with `udhcpd` serving the host `192.168.2.20–90` (no host-side configuration), and announces itself in iSerial (`LuneOS initrd telnet 192.168.2.15: <reason>`). The network function is auto-selected: it tries `rndis.usb0` and `ecm.usb0` and links whichever the kernel supports — **stock GKI 6.1 (bluejay/panther) ships ECM only; MTK 4.14 (mindphone) and athena's 4.19 RNDIS only**. Fixed gadget MACs (`FA:75:7F:BB:F4:E6`/`:E7`, first byte even) avoid the all-zeros-MAC refusal. ECM has no native Windows driver: use a Linux or macOS host on GKI Pixels (adb comes up alongside). All tools are busybox applets already in the initramfs. Two more channels ride along:

- **ACM serial console** — `acm.usb0` with a shell on `/dev/ttyGS0`; host `screen /dev/ttyACM0 115200`. Needs `CONFIG_USB_CONFIGFS_ACM=y` (stock GKI 6.1 and mindphone's 4.14 have it; athena's defconfig does not, and the function silently doesn't appear).
- **netconsole** — after the debug network is up, init attaches a dynamic netconsole target streaming kmsg to UDP broadcast port 6666 (`nc -ul 6666` on the host); it **survives switch_root into the full boot**. Init then **replays the early printk buffer** into it (`dmesg` re-injected into `/dev/kmsg`, prefixed `replay:`), since dynamic targets don't get `CON_PRINTBUFFER`; that needs `printk.devkmsg=on`. Requires `CONFIG_NETCONSOLE=y` + `CONFIG_NETCONSOLE_DYNAMIC=y`, which is **never safe on Tier A (KMI-poison) and on Tier B only where no prebuilt vendor network module loads** — NETPOLL/`NET_POLL_CONTROLLER` shift `struct net_device`/`net_device_ops` (kmi-crc-matching.md § NETCONSOLE and NET_POLL_CONTROLLER). The athena and mindphone fragments carry it; mindphone also force-loads the stock WMT modules, so it needs the struct-layout check (kmi-crc-matching.md § Struct layouts) rather than counting as evidence the combination is safe.

**Cmdline netconsole (`netconsole=...@/usb0,...`) is mainline-only and harmful on configfs-gadget kernels.** `netpoll_setup()` aborts with `-ENODEV` when the interface doesn't exist at init, and `init_netconsole()` then unwinds *everything*, including the dynamic configfs interface (verified in the athena 4.19 source). Tenderloin can use it (`netconsole=6665@172.16.42.2/usb0,6666@172.16.42.1/` in `CONFIG_CMDLINE`) only because its mainline kernel sets `CONFIG_USB_ETH=y`, so `g_ether` creates `usb0` before userspace; on an Android-style kernel `g_ether` would claim the UDC and cost the configfs gadget.

### The debug gadget is not necessarily adb

`USB_FUNCTIONS="adb rndis ecm acm"` gives whatever the kernel supports, which on a vendor kernel may not include adb: a gadget can come up as ECM + ACM with `adb devices` empty and the device perfectly reachable. Check all of these before concluding the device is dead:

```sh
adb devices
ls /dev/ttyACM*                  # screen /dev/ttyACM0 115200
ip -br link | grep -E "usb|enx"  # then: telnet 192.168.2.15
lsusb | grep -iE "18d1|0e8d"     # raw enumeration
```

### Two UDCs: never bind the gadget to `$(ls /sys/class/udc)`

Both `android-gadget-setup` (meta-android, `write $GADGET_DIR/g1/UDC "$(ls /sys/class/udc)"`) and the initramfs (`ls /sys/class/udc | grep -v dummy | head -1`) assumed exactly one USB device controller. A stock config with `CONFIG_USB_DUMMY_HCD=y` registers a fake `dummy_udc.0` beside the real one (MP01: `musb-hdrc`). The first script wrote both names into `UDC`, the kernel rejected it and the normal image had **no adb at all**; the only trace is easy to read past:

```
android-gadget-setup: === Writing dummy_udc.0
musb-hdrc into /sys/kernel/config/usb_gadget/g1/UDC
```

The second failed because busybox `ls` emits `dummy_udc.0  musb-hdrc` as **one line** into a pipe, so `grep -v dummy` discarded both. `dummy_udc.0` is no help even alone: it accepts the bind and does nothing. Fix both with:

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

and grep the tree for the other copy (`grep -rn "class/udc" <layers>`). Single-UDC devices only ever got lucky; check `CONFIG_USB_DUMMY_HCD` in a new device's stock config.

### RNDIS + SSH past the initramfs (Droidian)

Our `enable_adb` shell ends when the initramfs hands over; Droidian's primary channel is RNDIS + SSH into the booted rootfs (<https://docs.droidian.org/porting-guide/debugging-tips/>):

- Kernel needs `CONFIG_USB_CONFIGFS_RNDIS=y` ("stuck at the glowing logo and RNDIS is not working → check CONFIG_USB_CONFIGFS_RNDIS").
- Device at `10.15.19.82`, host `10.15.19.100/24`, then `ssh <user>@10.15.19.82`. Nothing on screen ≠ boot failure.
- Forward internet over the USB link:

  ```sh
  sudo sysctl net.ipv4.ip_forward=1
  sudo iptables -t nat -A POSTROUTING -o $INTERNET -j MASQUERADE
  sudo iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  sudo iptables -A FORWARD -i $USB -o $INTERNET -j ACCEPT
  # on device:  ip route add default via 10.15.19.100 ; nameserver 8.8.8.8
  ```

- UBports' flag files `/userdata/.force-ssh` and `/userdata/.force-adb` enable SSH/ADB at boot regardless of config (<https://docs.ubports.com/en/latest/porting/configure_test_fix/USBModed.html>) — writable from recovery or fastboot when nothing else is.

### Logging a boot that dies before adb

Start a loop from the initramfs (chrooted into the rootfs, before switch_root) that the next boot can read: `while :; do dmesg > F.new && mv F.new F; sync; sleep 0.5; done`. Keep slow commands such as `logcat -d` out of it (it blocks until logd is up) and remove it afterwards — the half-second sync makes the UI sluggish.

### The device does not charge while you debug it

Neither fastboot nor the initramfs runs a charging policy (`get_charger_charging_current: ... failed: -95`). Hours of reflash cycles flatten the battery, and "rebooted to a battery symbol after some minutes" looks exactly like a crash or watchdog reset. Charge it powered-off on a real charger.

## Stage 1 — Initramfs failures

The init fixes below are described in full in boot-images.md § Init patch history; this stage is how to recognise them.

### 1.1 Module load order — `modules.load` is not dependency-ordered

On GKI devices the vendor's early modules (from `vendor_boot` or `vendor_kernel_boot`) land in `lib/modules` of the merged initramfs, and our init must load them (fatal where even UFS is a module). `modules.load` is a list, not an order: stock init resolves `modules.dep` per entry. One-pass insmod in list order left `clk_exynos_gs` (line 15) without its exporter `cmupmucal` (line 45) → no clocks → power domains deferred → `deferred probe timeout` wall → MCT timer panic at 11.5 s (bluejay). Check any device's set host-side with `module-order.py` (tools.md). Never silence insmod errors with `2>/dev/null` — that hid the `Unknown symbol cal_clk_* (err -2)` diagnosis.

### 1.2 Module cmdline parameters are not passed to loadable modules

`ufs-pixel-fips140: Invalid module params: first_lba=0 last_lba=0` → `Kernel panic: FMP self test failed` at 2.3 s: **`module.param=` cmdline options apply only to built-ins**; modprobe parses `/proc/cmdline` for loadables, plain `insmod` does not. The init's `module_cmdline_args()` passes them, treating `-` and `_` as equivalent in the module name.

### 1.3 Async storage probe and userdata

- UFS probes asynchronously and `mountroot` has no retry: init polls sysfs `PARTNAME` for `userdata*` for up to 10 s after module load.
- **userdata never grows on UFS** if the resize computes the size from the device path: `readlink -f` yields `/dev/sd*`, matching neither `mmcblk*` nor `disk*` (boot-images.md § The userdata-resize-on-UFS bug). Harmless after `fastboot format:ext4 userdata`; fatal to the shipped-userdata-image flow.
- **mdev creates kernel names, not partition names.** `mountroot`'s `find /dev -name userdata` finds nothing when mdev only made `/dev/sdc59` → "Couldn't find data partition" although the partition mounts fine by hand. Synthesise the by-name links from sysfs:

  ```sh
  for blk in /sys/class/block/*; do
      pn=$(sed -n 's/^PARTNAME=//p' "$blk/uevent" 2>/dev/null)
      [ -n "$pn" ] || continue
      [ -e "/dev/$pn" ] || ln -sf "/dev/${blk##*/}" "/dev/$pn"
  done
  ```

### 1.4 Missing tools, file layout, hotplug

- The initramfs lacked `udevadm` and `dumpe2fs` (`halium-boot.sh` calls both): settle is skipped and the resize check degrades — add them to `initramfs-android-image`.
- **`android-rootfs.img` must sit next to `rootfs.img` on userdata** (`halium-boot.sh` checks `/tmpmnt/android-rootfs.img`). `0001-halium-find-the-Android-image-instead-of-assuming-whe.patch` fixes the "userdata image with only rootfs.img in it does not boot" case.
- mdev hotplug writes `/sys/kernel/uevent_helper`, which needs `CONFIG_UEVENT_HELPER=y` — not in stock GKI configs (added to the LuneOS fragment; KMI-safe). Empty by-partlabel links are the symptom.
- Hardcoded `mmcblk0p*` numbers in old forked `machine.conf` files are stale (the initramfs discovers partitions by name); delete them.

### 1.5 Cmdline-level fixes (Droidian)

| Symptom | Fix |
|---|---|
| Device reboots immediately after flashing boot | remove a stale `systempart=` from the cmdline |
| Initramfs stuck / can't find data | add `datapart=/dev/disk/by-partlabel/userdata` |
| Initramfs refuses to exec `/init` | replace `console=ttyMSM0,115200n8` with `console=tty0` |

A serial console on a dead UART can hang init's stdio; Droidian appends `console=tty0` as standard (<https://docs.droidian.org/porting-guide/debugging-tips/>).

### 1.6 Your init never ran: `skip_initramfs`

On many A8–A10 vendor kernels the bootloader passes `skip_initramfs` and the kernel bypasses the packed ramdisk — a repacked boot.img flashes fine and your init never executes (no gadget, no logs, stock-looking behaviour). First suspect when a Tier B device ignores a repacked ramdisk; fix in kernel source (boot-images.md § The `skip_initramfs` trap).

### 1.7 Recovery as a debug environment (Droidian)

On devices with TWRP/recovery the rootfs can be inspected and repaired without booting it:

```sh
mkdir /tmp/mpoint
mount /data/rootfs.img /tmp/mpoint
chroot /tmp/mpoint /bin/bash
export PATH=/usr/bin:/usr/sbin
```

Grow it offline with `e2fsck -fy /data/rootfs.img && resize2fs -f /data/rootfs.img 8G`. Recovery is also where you read `/sys/fs/pstore/` after a panic and mask broken units before the next attempt.

### 1.8 The vendor modules may not be in the merged ramdisk at all

1.1 assumes the bootloader concatenated `vendor_boot`'s ramdisk with ours, as AOSP specifies. Verify it: when it does not happen, `load_kernel_modules()` returns silently (`[ -f /lib/modules/modules.load ] || return 0`), and a device whose storage *and* USB are modules cannot find its root filesystem and cannot tell you so.

The fix is to ship a **minimal** set of the vendor's modules (storage, USB, watchdog)
inside the LuneOS initramfs, not the whole set:

```
ANDROID_EXTRA_INITRAMFS_IMAGE_INSTALL = "<machine>-vendor-modules"
IMAGE_ROOTFS_SIZE:pn-initramfs-android-image = "65536"   # default 8 MB is too small
```

with a recipe installing the extracted `.ko` plus `modules.load`/`.dep`/`.softdep` to
`/lib/modules`. Keep the boot image near stock size: embedding all 180 MP01 modules
(+5.5 MB) made MediaTek lk stop starting our init at all, silently (found on mp01; see
device-mp01.md). If the concatenation does happen, the same files land in the same
place. Use `install`, not `cp -a`, in `do_install`, or `do_package` dies with
`KeyError: 'getpwuid(): uid not found: 1000'`.

### 1.9 Debug mode must come *after* module loading

An init that checks `enable_adb` and panics into the debug shell before `load_kernel_modules` is fine where UFS and the gadget are `=y`, and fatal where USB, storage or the watchdog are vendor modules: the shell has no block devices, and on MediaTek no `mtk_wdt.ko`, so the watchdog shoots a perfectly working debug mode within seconds ("the debug image bootloops"). `load_kernel_modules` + `start_mdev` now run before the `enable_adb` check; the loader is bounded and returns at once when `modules.load` is absent.

### 1.10 Ramdisk compression must match across the concatenation

The kernel unpacks `vendor_boot`'s ramdisk and ours as one stream, and AOSP requires the **same compression** (GKI: lz4). With a gzip ramdisk behind an lz4 vendor ramdisk ours was never unpacked, the vendor's `/init` symlink survived, Android's init ran and the device landed in **Android Recovery** ("Try again / Factory data reset") — which reads like a userdata problem and is not (found on mp01).

```sh
xxd -l 4 ramdisk     # 02 21 4c 18 = LZ4 *legacy*, 1f 8b = gzip
```

`GKI_RAMDISK_COMPRESSION = "lz4-legacy"` in the machine conf repacks it. It must be **legacy** lz4 (`lz4 -l`), not the frame format (`04 22 4d 18`) — `lib/decompress_unlz4.c` only knows the legacy magic.

### 1.11 Vermagic: match it rather than force it

Stock storage/USB modules in the ramdisk refuse to load while every CRC check passes: the
initramfs has only busybox `insmod` (no `--force-vermagic`), so the vermagic must match
exactly, down to a trailing `+`. Recipe (LOCALVERSION, empty `.scmversion`, SUBLEVEL) in
kmi-crc-matching.md § Step 0.

## Stage 2 — Android container failures

The rootfs is up, systemd runs, but HALs / display / radio are dead.

### 2.1 Init "stuck" vs "curtailed" — look for `wait_for_prop` first

Halium patches Android init so the framework never starts, and `on nonencrypted` is dead on a GSI (no fstab, so `mount_all` never runs). It is tempting to conclude init stopping after `post-fs-data` is by design; **it usually isn't**. On sargo, `init.<board>.rc` gates `post-fs-data` on `wait_for_prop vendor.qcom.time.set true`, set by Android's `time_daemon`, which Halium doesn't run. `wait_for_prop` blocks init's state machine outright — `early-boot`, `boot`, every `class_start` and every `chown`/`chmod` the HALs need is never reached. Setting that one property brought up the modem subsystem (`per_mgr`, `per_proxy`, `pd_mapper`, `qcrild`), fixed the vibrator restart loop, zeroed the sensors' QMI errors and cut EACCES failures from 50 to 1.

`start-android-hals.sh` generalises this: parse every `wait_for_prop` from the container's rc files, grant a grace period, force only the stragglers, and replay `class_start`/`chown` as a safety net (hal-userspace.md § Derive, don't ship). SFOS mitigates from the other end by disabling `time_daemon`/`vendor.time_daemon` via a `disabled_services.rc` in the container's init dirs (stops "RTC initialization failed" loops).

### 2.2 The quoted-property trap

mt6739's vendor rc writes `wait_for_prop hwservicemanager.ready "true"` — quotes that init's parser strips. The awk harvest kept them, so the gate never looked satisfied, and after the grace period the script forced the literal `"true"` (quotes included) — **wedging every libhidl `WaitForProperty`, i.e. every HIDL `getService`, on host and container**. It was the root cause of the mindphone boot-splash hang under several real-but-secondary bugs; fixed with a gsub in the awk. sargo's gates carry no quotes — "works on device A" proves nothing about the parser.

### 2.3 Container init dies with no trace

Inside the LXC container init often has no usable `/dev/kmsg`, so KernelLogger discards every line; init is built with `REBOOT_BOOTLOADER_ON_PANIC`, so a fatal signal becomes a handled `reboot()` that a pid namespace delivers as SIGHUP. All the container manager says is `Child <pid> ended on signal Hangup(1)`. Two AOSP init patches (the halium16 init-logging patches, tools.md) close the hole: **tee every log line to `/dev/socket/init.log`** (bind-mounted from the host, so it outlives the container) and **breadcrumbs before `InitKernelLogging`** at `FirstStageMain` entry and after `/dev` setup. That is how the Android 16 GSI's PropertyInit failure was found: `prop_area::map_prop_area_rw` with the host's **4M `/dev` tmpfs out of pages** while mapping one 128K `prop_area` per property context (~557 on a 16 GSI).

### 2.4 Read the container's logcat, not just journalctl — the ashmem case

`systemctl is-system-running = running`, 0 failed units, 32 audio sinks, working nyx/ofono — and the bootloader splash forever, with nothing in journalctl. Only the **container's logcat** showed it: from Android 12, libcutils opens `/dev/ashmem<boot_id>`, not `/dev/ashmem`; the container's init creates that node inside the container, but hybris runs on the host, so every `ashmem_create_region()` failed, libfmq could not allocate, the HIDL composer's command queue was never created and the compositor sent no display commands. Fix: create `/dev/ashmem<boot_id>` on the host (`mount-android.sh`). Applies to any A12+ GSI.

### 2.5 The property service: enabled, but not running

`setprop` from a host process failing (`libc: Unable to set property "vendor.debug.sf.hwc_pid" ... connection failed`) looked like a permissions problem; `android-property-service` was simply `inactive` with **no journal entries at all** — enabled, `After=android-system.service`, never started. Reads keep working (the property area is mapped read-only), which is what makes it confusing. MediaTek's hwcomposer sets properties during init, so this is not cosmetic. The unit being *enabled* is not evidence it ran: `systemctl is-active` plus an empty `journalctl -u <unit> -b` is the tell.

### 2.6 Other container-side failure modes

| Failure | Cause / fix |
|---|---|
| vndservicemanager aborted, every vendor HAL blocks on `/dev/vndbinder` | A stock vndservicemanager aborts without selinuxfs — preload `libselinux_stubs` (halium device-tree patch; on 32-bit the GSI preloaded it from a hardcoded `/system/lib64/` path and died — fixed in `device/halium/halium_arm`) |
| Boot queue hangs on one bad HAL | `lshal` hangs forever on an unresponsive HAL — `luneos-device-config` runs it under a per-call watchdog |
| Dynamic-partition mounts racy/missing nodes | dmsetup/udev race — `dmsetup mknodes` in `mount-android.sh` |
| Binder calls fail on host | Host needs `/dev/{binder,hwbinder,vndbinder}` symlinks into binderfs |
| `.capex` APEXes silently skipped on a 16 GSI | `mount-apexes.py` cannot mount compressed APEXes — `PRODUCT_COMPRESSED_APEX := false` |
| `/init` aborts instantly on a 4.9 kernel | `MADV_WIPEONFORK` needs Linux ≥ 4.14 — made non-fatal in hybris-patches |
| getprop/setprop TLS abort on the Android 16 GSI | Needs the Android 16 libhybris adaptation (hal-userspace.md § libhybris fixes) |
| Container "service not found" for zygote/netd/update_verifier | By design — the Halium GSI strips them |
| `init: Processed ctl.start for 'X' from pid: 0` for a "disabled" service | `start-android-hals.sh` starts everything init skipped; exclude with `deviceinfo_android_skip_services` |
| "add_service Permission denied" / "Unknown class service_manager" | SELinux config files must be real files, not symlinks; "Unknown class" in permissive wants stub services. dmesg shows `SELinux: Disabled at boot` (hybris ≤16) vs `SELinux: Initializing` (≥17) (SFOS hadk-hot) |
| `libandroidicu.so not found` (libicui18n/libicuuc) | Symlink from the runtime APEX, e.g. `/odm/lib64/libandroidicu.so → /apex/com.android.runtime/lib64/…` (SFOS hadk-hot) |
| apexd/loop-device failures | `loop.max_part=7`, the loop block-size patch, or the "linkerconfig: switch no-updatable-apex" hybris-patch; check `/proc/device-tree/firmware/android/fstab/` for early-mounted partitions (SFOS hadk-hot) |
| Early crash-loop on Exynos 9810/9820 | `systemd-journald` crashes the device — mask it; on broken-namespace kernels mask `systemd-resolved` and `systemd-timesyncd` too (Droidian) |
| A setting in a unit's `EnvironmentFile=` has no effect | `export VAR=…` lines are ignored (`Ignoring invalid environment assignment 'export …'`); confirm with `tr '\0' '\n' < /proc/<pid>/environ` |

### 2.7 Working the container by hand

- `lxc-checkconfig` checks the running kernel for every namespace/cgroup option LXC needs; `lxc-ls --fancy` shows container state.
- Start the container manually with full logging: `lxc-start -n android --logfile=/tmp/lxclog --logpriority=DEBUG`. To debug the host side alone, override the service with `ExecStart=/bin/true` (Droidian).
- Logs from inside: `lxc-attach -n android -- /system/bin/logcat` (`-b radio` for RIL). `logcat -b all -c` right before a restart you want to observe when one tag floods the buffer.
- **The container's init cannot be started twice** (SFOS hadk-hot): a second start fails on leftover state, so a restart-looping container init hides the *first* failure. No logcat before Android init is up ≠ broken logging.
- **Native backtraces of a hung HAL:** `lxc-attach -n android -- /system/bin/debuggerd -b <container pid>` (the container has its own pid namespace; take the pid from logcat or `lxc-attach ... pidof`).
- **strace a vendor daemon** by editing its rc service line: `mkdir -m777 /data/strace`, then `service tad /usr/bin/strace -ff -o /data/strace/tad.strace /vendor/bin/tad …` (SFOS hadk-hot).
- **Do not `nsenter` into the container's mount namespace on a 3.x kernel**: copying a vendor dir through `/proc/<pid>/root` and bind-mounting it hung the phone twice. Fix the image instead.

### 2.8 Userspace resets that are not crashes

A device going down every few minutes with a *clean* shutdown in `journalctl -b -1` ("Reached target System Power Off") is being shut down on purpose; `journalctl --list-boots` shows the rhythm. Suspects: `sleepd` (mask it during bring-up) and batteryd's critical-percent check fed by a gauge reporting `capacity=-1` (`CHG_LOGIC: Battery at -1%, at or below the critical level of 2%`).

## Stage 3 — Display and UI

Two black-screen shapes:
- **Stuck on the bootloader splash** with a healthy system underneath → the compositor never sent display commands: ashmem/composer (2.4), init gates (2.1), or DRM master (below).
- **Screen dark but everything runs** → check the backlight first: on mindphone nothing drove `/sys/class/leds/lcd-backlight` and the panel booted at 0 (`echo 200 >` from a compositor drop-in as a bring-up hack; the real fix belongs in the display service). Many Qualcomm panels take a max of **2047**, not 255 (Droidian).

### The display smoke-test ladder (SFOS HADK/hadk-hot)

Isolate layers bottom-up with the libhybris test binaries, compositor stopped first (<https://github.com/mer-hybris/hadk-faq>):

1. `EGL_PLATFORM=hwcomposer test_hwcomposer` (as root). A spinning rectangle = EGL + gralloc + composer blobs work under the hybris linker. Segfault → `strace` or `gdb test_hwcomposer` → `bt full`. Runs-but-black → gralloc/copybit.
2. `EGL_PLATFORM=hwcomposer qmlscene -platform hwcomposer main.qml` adds the Qt QPA hwcomposer plugin. Tuning: `QPA_HWC_IDLE_TIME=5`, `QPA_HWC_BUFFER_COUNT=3`; black backgrounds inside working apps → `QT_OPENGL_NO_BGRA=1`.
3. Only then the full compositor.

**surfaceflinger as a bisect oracle:** run the GSI's own `/system/bin/surfaceflinger` (A11+: also `ANDROID_ROOT="/system" /system/bin/bootanimation`). If it renders, kernel + blobs + gralloc/composer are good and the fault is in hybris/QPA; if not, fix the Android side first.

### Other display/UI failure modes

| Symptom | Cause / fix |
|---|---|
| Compositor blocks forever before starting | `product.env` DRM probe loops on DRM-less devices — guard the probe |
| Wrong/unknown panel geometry | Read `/sys/class/graphics/fb0/modes`, **not `mode`**, which empties once the compositor owns the panel; never trust copy-pasted display constants (mindphone's conf claimed 1080x2340 for a 480x800 panel) |
| Every `eglCreateContext` → `EGL_BAD_ALLOC`, webapps never render | GPU node permissions: `/dev/pvr_sync` and `/dev/ion` needed 0666 (the vendor ueventd.rc values) for the WAM user — a udev rule; hal-userspace.md § udev rules from the container's own ueventd files derives these |
| QML apps die with "Failed to create wl_display" | XDG_RUNTIME_DIR split — hal-userspace.md § Wayland socket |
| Compositor races the vendor HAL | Wait for `IComposer` to register on hwbinder; Droidian's `ExecStartPre=sleep 5` drop-in is the weaker version |
| Compositor spins on "failed to get drm master" | Device booted in charger mode (below), or the HWC was opened twice (`deviceinfo_force_hwc2`) |
| Hardware keys ignored by Qt | udev tags the keypad `ID_INPUT_KEY` only; Qt evdevkeyboard needs `ID_INPUT_KEYBOARD` — promote with a udev rule (mindphone `mtk-kpd`) |
| Compositor picks `Writeback1`, hangs ~90 s and restarts forever (MediaTek) | MediaTek DRM reports its writeback connectors as permanently connected; exclude `Writeback` connectors in `product.env` as well as `Virtual` (device-radon.md) |
| Healthy LuneOS behind a foreign boot logo | A vendor/distro initramfs started plymouthd, which survives `switch_root` holding the framebuffer; boot with `plymouth.enable=0` (device-radon.md) |
| `library "libpq_cust.so" not found` from MTK HWC | Benign — the vendor ships `libpq_cust_base.so` and the HAL falls back |

**Charger-mode boots and DRM master.** A MediaTek device that is never truly off boots with `androidboot.bootreason=usb` whenever a cable is attached; `init.halium.rc` then starts `/system/bin/charger`, which takes DRM master and never gives it back (`lsof | grep card0`). `start-android-hals.sh` stops it via `DISPLAY_CONFLICT_MATCH` — but there are two copies of that script (`meta-android` and `meta-luneos`; the `meta-luneos` one ships). Diff the deployed file against both before assuming a fix is in.

**Wrong-sized or cropped window: measure client and compositor separately.** Client (web apps): WebAppMgr runs Chromium with `--remote-debugging-port=9998`; `adb forward tcp:9998 tcp:9998`, list pages at `http://127.0.0.1:9998/json` and evaluate `screen`, `innerWidth/Height`, `outerWidth/Height`, `devicePixelRatio`, `visualViewport.scale` and `document.hidden` via `Runtime.evaluate` (measure the page with `hidden:false`). Compositor: a temporary `qWarning` in `WebOSSurfaceItem` on `QWaylandSurface::bufferSizeChanged/destinationSizeChanged/sourceGeometryChanged/bufferScaleChanged` and the item's size shows what the client committed against the item; build it from a worktree at the deployed `SRCREV` via a temporary `externalsrc`, push only `libWebOSCoreCompositor.so` from `packages-split/`, and remove the `externalsrc` before building an image. If the compositor side is consistent, the crop is inside Chromium (found on mp01; see device-mp01.md). Screenshots: `luna-send -n 1 luna://com.webos.surfacemanager/captureCompositorOutput '{"output":"/tmp/x.png","format":"PNG"}'` or `/media/internal/screencaptures/`, both in panel orientation.

## Stage 4 — Subsystems

### First question for any subsystem: is the HAL registered at all?

```
binder-list -d /dev/hwbinder | grep IRadio      # modem
binder-list -d /dev/hwbinder | grep ISensors    # sensors
```

If the interface is absent, middleware config is irrelevant — go back to Stage 2. If `binder-list -d /dev/binder` shows **nothing at all**, or AIDL HALs the vendor publishes are "missing", check libgbinder's `ApiLevel` first (hal-userspace.md § Before blaming AIDL); ofono-binder-plugin, bluebinder, sensorfw and nfcd all sit on libgbinder. libhybris' smoke binaries (`test_egl`, `test_hwcomposer`, `test_vibrator`, `test_gps`, `test_audio`; `test_sensors` is legacy-HAL only) answer "does the blob respond at all?" before any middleware exists (SFOS hadk-faq).

**Is the subsystem's module even loaded?** Compare against the vendor's list:

```sh
M=/android/vendor_dlkm/lib/modules; L=$(lsmod | cut -d" " -f1 | tr - _)
while read m; do b=$(basename $m .ko | tr - _); echo "$L" | grep -qx "$b" || echo "$m"; done < $M/modules.load
```

A whole subsystem missing (camera, audio) points at module loading, not the HAL — hal-userspace.md § Vendor kernel modules.

### Wifi

- A `wifi-module-load.service` modprobing a module that doesn't exist on this device (copy-paste from another port) restart-loops every 2 s — check whether the driver is built in (`CONFIG_MTK_COMBO=y`).
- MediaTek WMT combo: force-loaded stock vendor modules, firmware path, `/dev/wmtWifi` power-on — hal-userspace.md § MediaTek connectivity. Force-loading is only safe with stock struct layouts (kmi-crc-matching.md § Force-loading prebuilt modules, and when it is safe).
- Module-load errors (Halium, <https://docs.halium.org/en/latest/porting/debug-build/wifi.html>): `"Required key not found"` = signature enforcement — disable `CONFIG_MODULE_SIG*` (Tier B; stock GKI leaves `MODULE_SIG_FORCE` unset). `"Invalid module format"` = version/config mismatch. Vendor modules that never load on a rebuilt GKI kernel although the CRC check passes: `CONFIG_MODULE_SIG_PROTECT` (kmi-crc-matching.md § A failure class invisible to CRC checks: MODULE_SIG_PROTECT). Broadcom `bcmdhd` is best `=m` (picks up the MAC as a module). Legacy Qualcomm (pre-2016): `echo 1 > /dev/wcnss_wlan`, `echo sta > /sys/module/wlan/parameters/fwpath` (and see hal-userspace.md § WCNSS).

#### Regulatory domain: `country 00` and no 5 GHz

Install **`wireless-regdb-static`** and the **`cfg80211-regdb-reload`** service (meta-luneos/recipes-connectivity, gated on the `wifi` MACHINE_FEATURE in `packagegroup-luneos-extended`). oe-core only wires `wireless-regdb` into `packagegroup-base-wifi` (`00c5a665b4`), which LuneOS images (built from `packagegroup-luneos-*`) never install, and connman does not reference it, so without these every phone sits in the world domain. That goes unnoticed because **country 00 is a fully usable 2.4 GHz radio**: channels 1–11 work and every 5 GHz band is passive-scan-only, so 5 GHz APs are simply never found.

```
country 00:
  (2402 - 2472 @ 40), (6, 20), (N/A)          <- no PASSIVE-SCAN, normal
  (5170 - 5250 @ 80), ... PASSIVE-SCAN
  (5250 - 5330 @ 80), ... DFS, PASSIVE-SCAN
  (5490 - 5730 @ 160), ... DFS, PASSIVE-SCAN
  (5735 - 5835 @ 80), ... PASSIVE-SCAN
```

**Shipping the file is only half the fix.** cfg80211 is built in, so it requests `regulatory.db` during its own initcalls, before any rootfs exists:

```
platform regulatory.0: Direct firmware load for regulatory.db failed, error -2
platform regulatory.0: Falling back to syfs fallback for: regulatory.db
ueventd: firmware: could not find firmware for regulatory.db
cfg80211: failed to load regulatory.db
```

On Halium the sysfs fallback is answered by the **container's ueventd**, which never searches the LuneOS root. The failure is then **latched** (`regdb_fw_cb()` sets `regdb = ERR_PTR(-ENODATA)`), so the db sits on disk unread and `iw reg set XX` returns 0 while changing nothing. Only `NL80211_CMD_RELOAD_REGDB` (`iw reg reload`) clears it:

```sh
iw reg get | head -1                     # "country 00" => broken
ls -l /lib/firmware/regulatory.db        # missing => package not installed
journalctl -k -b | grep -iE "regulatory|regdb"
iw reg reload && iw reg set NL && iw reg get | head -1
```

Old kernels: upstream signs the db with the **wens** key since 2023, and `CONFIG_CFG80211_USE_KERNEL_REGDB_KEYS=y` trusts only `net/wireless/certs/*.hex` — check `wens.hex` is there (FuriLabs' 4.19 has both wens and sforshee).

#### Never gate a unit on `/sys/module/<driver>`

A built-in driver has **no `/sys/module` entry**, so `ConditionPathExistsGlob=/sys/module/wlan*` silently excludes machines where it is compiled in (`ConditionResult=no`, no error). The same assumption in *driver detection* is worse because the unit appears to work: `wlan-suspend-mode`'s `driver_layout()` looked for `/sys/module/wlan_drv_gen4m*`, chose the Qualcomm private-ioctl struct with gen4m built in, and `SETSUSPENDMODE` failed with `EINVAL` (found on radon; see device-radon.md). Gate on something that exists either way — the character devices (`/dev/wmtWifi`, `/dev/conninfra_dev`, `/dev/stpbt`) or the interface itself — and bound any wait, exiting with a status in `RestartPreventExitStatus` so a machine without WLAN does not spin.

#### "Wi-Fi associates, ping works, but TCP hangs"

Establish **where** the loss is before touching the port. Consumer routers accelerate TCP/UDP in hardware and leave ICMP on the slow path, so ping is no evidence for TCP; a router bridging badly between its 2.4 and 5 GHz radios kills only flows that cross bands (found on radon; see device-radon.md). Run this matrix:

| test | what it isolates |
|---|---|
| `ping -c5 -M do -s 1472 <peer>` | L2/L3 path and MTU, both directions |
| device `wget` a few MB from the internet | device↔AP leg only — fast means radio and driver are fine |
| device connects **out** to a listener on the peer | device-initiated TCP |
| peer connects **in** to a listener on the device | peer-initiated TCP |
| same tests with peer on the **same band** | isolates cross-band bridging |

Read `ss -ti` on the *sending* side: `bytes_acked:1` with climbing `bytes_retrans` means the receiver never got the data. Use a plain socket listener, not sshd.

### Modem

- **Pick the right fstab.** `mount-android.sh` once took `fstab.enableswap` because it glob-sorts before `fstab.mt6739`, so the MTK NV partitions (`nvcfg`/`nvdata`/`protect1`/`protect2` — calibration + IMEI) never mounted: `md1.status = "exception"`, RIL daemon stopped. Fix: prefer `fstab.$(getprop ro.hardware)`, skip `*.enableswap`. Generic to any multi-fstab device (found on mindphone, where dual-SIM then came up; see device-mindphone.md). Read *every* fstab the vendor ships — some split them by purpose.
- MTK exposes NV partitions under `/dev/disk/by-partlabel` only (no by-name) — `find_partition_path` must cover that.
- Qualcomm variant (SFOS hadk-faq): the RIL stack needs Android's exact `/dev/block/bootdevice/by-name/` structure. Symptom: SIM never detected, sometimes a bootloop. `ls -lR /dev/block` on Android and replicate it with udev rules.
- Protocol and slot configuration: hal-userspace.md § Modem.

### Bluetooth

Node ownership, MAC address, restart order and controller quirks: hal-userspace.md § Bluetooth. The diagnostic that finds controller quirks lives here:

**`hci0` exists but stays DOWN, "No default controller available":** check `rfkill list` first (webOS BT off = soft-blocked), then `hciconfig hci0 up`. `Invalid request code (56)` is `EBADRQC`, which `bt_to_errno()` maps from HCI status **0x01 "Unknown HCI Command"**: the controller refused something it had *advertised*. Find which with `btmon`:

```sh
(btmon -i hci0 > /tmp/bt.log 2>&1 &); sleep 1; hciconfig hci0 up; sleep 2; pkill btmon
grep -B2 -A6 "Unknown HCI Command" /tmp/bt.log
```

Look up what gates that command in `hci_core.c` (`hci_init*_req`) and mask the bit bluebinder passes through (`BLUEBINDER_LOCAL_EXT_FEATURES_PAGE_2_MASK`, `BLUEBINDER_LOCAL_FEATURES_MASK`) or add missing ones (`BLUEBINDER_LOCAL_COMMANDS_SET`). Test by writing the value to `/var/lib/environment/bluebinder/<x>.conf` and restarting the stack in order. A `dut_mode ... already present` debugfs warning means a second `hci0` was registered over a stale vhci left by a killed bluebinder — restart the stack in order before debugging further. A kernel reset 57 s into every boot with `BUG_ON(!sk)` in `bt_sock_reclassify_lock` is a vendor tree that stubbed `hci_sock_create()` (kernel-porting.md § Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung)).

### Audio

- Wrong rather than absent (pitched, tempo-shifted, dead volume keys, silent calls): pulseaudio-modules-droid quirk arguments — hal-userspace.md § Audio.
- **A deferred ASoC card:** `cat /sys/kernel/debug/devices_deferred` names the card, `/sys/kernel/debug/asoc/components` lists what registered. Pull `/proc/device-tree` with `adb pull`, read the machine node's phandle properties with `od -An -tx1` on the host, and find the node whose `phandle` matches — that names the missing component, and its compatible names the module.
- **PulseAudio dies ~1 s after "Daemon startup complete", status 9/KILL**, no log, no core: trace the kernel's signal generation (tooling appendix). `code=128` (SI_KERNEL) from the sink thread itself was `RLIMIT_RTTIME` expiring on a `SCHED_RR` thread (found on sm-t220).
- **Testing audio with nobody listening:** read the headset jack switch state (`EVIOCGSW` from `python3`; `evtest` is not on the image) and refuse speaker tests unless it reads empty; compare full `amixer contents` dumps during real HAL playback and a manual setup *on the host* (BusyBox `diff` printed nothing for files that differed); `dmesg` lines such as `mtk_pcm_I2S0dl1_prepare` show which PCM the HAL really opened. A microphone loopback gave digital zero — do not rely on it. When a person listens, label each timed variant with a wall-clock time.
- Web-app audio silent with nothing reaching PulseAudio: umediaserver — hal-userspace.md § webOS media server.

### Misc

- **Network-time toggle fails:** LunaSysService's `enableNetworkTimeSync()` runs `timedatectl set-ntp`, and there is no `timedatectl` on a device — meta-luneos removes `timedated` and `timesyncd` on purpose, since LunaSysService's own sntp path owns time (nyx-modules.md). Do not add them back.
- **Waydroid stops the host's nfcd:** upstream `container_manager.py` runs `systemctl stop nfcd` on container start and only restarts it on stop, so a failed start leaves NFC dead until reboot (meta-luneos waydroid patch 0010 removes both calls). A fresh userdata has no `/var/lib/waydroid/waydroid.cfg`, so the session units skip until `waydroid init` has downloaded its ~1 GB of images. When it genuinely fails, `/var/lib/waydroid/waydroid.log` has the `lxc-start` output; `lxc_spawn: ... Failed to clone a new set of namespaces` means the kernel lacks `CONFIG_IPC_NS`/`CONFIG_USER_NS` and Waydroid's generated config, unlike the Android container's, has no `lxc.namespace.keep = ipc user`. `waydroid-luneos-prepare` adds it for whichever is missing from `/proc/self/ns`, after `waydroid upgrade -o` regenerates the config (found on mp01).
- **`appinstalld2`: `Failed to execute child process "ar"`** — the standard image has no `ar`. Installer failures are explained in the journal: `LunaAppManager`, `appinstalld` and `ApplicationInstallerUtility` log the exact `opkg` command line.

## Stage 5 — Idle health: the port "works" but burns CPU, flash or battery

**Metrics to collect on any idle device:** per-process *cumulative* CPU vs uptime (`ps -o time` against `uptime` — 2 h used in 10 h is 20% of a core however calm it looks now), journal *and* container-logcat lines/s, GB/h whole-disk flash writes, `SUnreclaim` slope over **at least a day** (minutes cannot separate a slow leak from churn), and the suspend entry count (check it before trusting wake-from-suspend). Four proven patterns, from the sargo/tissot idle triage:

1. **A bypassed vendor helper daemon busy-spins.** tissot's `wcnss_filter` sat at 96% of a core logging ~62,000 lines/s (and `logd` another 36% absorbing it): libbt-vendor `ctl.start`s the filter, but LuneOS reaches BT via bluebinder/vhci and never uses it, so its SoC open fails and `handle_soc_events()` spins on a dead fd. BT works fully without it. Fix shape: stop it plus a periodic guard (it gets `ctl.start`ed again on some BT power-on paths — recipe `tissot-wcnss-filter-fixup`, 30 s guard). Sort processes by cumulative CPU and measure the container log rate on every "working" port.
2. **Zero-interval GTimerSource spin.** A `GTimerSource` with `interval_ms == 0` expires the instant it is dispatched and re-arms without reaching poll: `sleepd` at 25% of a core, ~40,000 wakeups/s (fixed in sleepd `herrie/fix-zero-interval-timer`). Signature: a constant fraction of a core, enormous wakeup count, no I/O.
3. **pulseaudio pinned by an uncorked stream.** A GStreamer pipeline left PLAYING after EOS (the Qt 6 EOS bug, device-sargo.md) keeps an uncorked sink input, so `module-suspend-on-idle` never suspends the sink. Diagnose with `pactl list sink-inputs` (`Corked: no` long after the sound ended); prove the cost with `pactl suspend-sink <sink> 1`.
4. **Kernel debug spam wears flash.** sargo's `qpnp_smb2` ships `debug_mask=31`, nearly doubling idle writes (0.19 vs 0.10 GB/h). Silence it via module parameters in a `tmpfiles.d` rule — **not** via the device-config sparse overlay, which has no ordering against `systemd-tmpfiles-setup.service`.

## Symptom → likely cause → where to look

| Symptom | Likely cause | Where to look |
|---|---|---|
| Hangs at bootloader splash, no console/gadget/pstore | A debug aid in your config broke early boot (fbcon, built-in netconsole) | Method: diff `.config` vs stock |
| Device resets, nothing visible | Kernel panic | pstore/ramoops (Stage 0) |
| Reset at the same second of every boot | A subsystem crash with restart level SYSTEM (e.g. modem lost EFS) | dmesg before the reset; battery reading |
| MediaTek: silent reset ~20–30 s in, `wdt_status` non-zero in expdb | Hardware watchdog unfed (mtk_wdt is a module) | Stage 0 watchdog; 1.9 |
| MediaTek: reset every ~90–120 s, no panic, journal just ends | 31 s SoC watchdog | `kick watchdog` intervals; `printf 'V' > /dev/watchdog` |
| MediaTek: reboots ~20–30 s in, lk says `boot reason = 4` / `kernel_panic`, expdb has no kernel log | Panic after userspace started; often a force-loaded vendor module on a struct-layout mismatch | ramoops out of DRAM with `mtk da peek`; kmi-crc-matching.md § Struct layouts |
| Faillog image booted, partition holds no record | Died before the logger, or after switch_root | `initrd_log_part=`; read DRAM |
| No USB gadget at all after flash | Kernel/initramfs never ran | unpack the flashed image; 1.6 `skip_initramfs` on A8–A10 Tier B |
| Repacked image flashes fine, our init never executes | `skip_initramfs` honoured by the vendor kernel | 1.6 |
| Device enumerates but `adb devices` is empty | Gadget came up as ECM/ACM/RNDIS without adb | Debug channels: try ACM/telnet |
| No adb on the normal image; log shows two names written to `UDC` | Two UDCs (`dummy_udc.0`), unparsed `ls /sys/class/udc` | `first_real_udc()` |
| USB gadget "Halium initrd — Failed to boot" | initramfs couldn't finish (often rootfs.img not found) | `adb shell`, `cat /dev/kmsg` |
| "luneos initramfs failed:" with empty reason | Debug mode entry, not a failure | next kmsg line |
| Debug image bootloops on MediaTek | Watchdog kills the shell before modules load | 1.9 |
| Debug image never shows the userspace bug | It cannot boot past the initramfs | boot normal, then read its journal |
| Telnet port 23 answers | Kernel + initrd fine; rootfs transition failed | `cat diagnosis.log`, `/init.log` |
| Device lands in Android Recovery ("Try again / Factory data reset") | Ramdisk compression mismatch; vendor `/init` ran | 1.10 |
| `deferred probe timeout` wall, then timer/clock panic | `modules.load` isn't topological | 1.1; `module-order.py` |
| Driver panics on unset params (e.g. FMP self test) | `<module>.param=` not passed to insmod | 1.2 |
| Panics to adb only sometimes | Async UFS probe, no mountroot retry | 1.3 |
| "Couldn't find data partition", partition mounts by hand | mdev made kernel names only | 1.3 by-name links |
| First boot ok, disk full soon after | userdata never resized (`/dev/sd*`) | 1.3; boot-images.md |
| by-partlabel links empty | mdev hotplug needs `CONFIG_UEVENT_HELPER` | 1.4 |
| Root fs never found, storage + USB are modules | Vendor modules not in the merged ramdisk | 1.8 |
| Stock modules refuse to load from the initramfs (vermagic) | Release string differs, often by a trailing `+` | 1.11 |
| Boot dies with a serial console on the cmdline | init's stdio hung on a dead UART | `console=tty0` (1.5) |
| Init "stops" after post-fs-data; HALs missing, EACCES everywhere | `wait_for_prop` gate | 2.1 |
| Every HIDL getService blocks, host + container | Property gate forced with a quoted literal | 2.2 |
| "Child ended on signal Hangup(1)", container dead, no logs | Container init died pre-logging | 2.3 |
| 0 failed units, audio up, stuck on boot splash | Host-side ashmem → libfmq → composer queue | **container logcat**; 2.4 |
| `setprop` "connection failed" from the host; getprop works | `android-property-service` never started | 2.5 |
| All vendor HALs block on vndbinder | vndservicemanager aborted (selinuxfs) | 2.6 |
| Boot queue hangs at HAL enumeration | lshal hung on one HAL | 2.6 |
| A "disabled" Android service runs anyway | `start-android-hals.sh` started it | `deviceinfo_android_skip_services` |
| `add_service Permission denied` | selinux config files are symlinks, or stubs missing | 2.6 |
| Container init restart-loops | Second start fails on leftover state | find the *first* failure (2.7) |
| Setting in `EnvironmentFile=` has no effect (e.g. `QT_QPA_FORCE_HWC2`) | `export ` prefix — systemd ignores the line | `/proc/<pid>/environ` |
| Clean shutdown every few minutes | Userspace policy: sleepd, or batteryd on `capacity=-1` | 2.8 |
| Device powers off within a minute while charging | batteryd critical-percent check on a gauge reporting `capacity=-1` | 2.8 |
| batteryd reports `Charging:false` on the cable | Charger `online` is `2`; nyx accepted only `1` | nyx-modules.md |
| "Rebooted to a battery symbol" during long sessions | Battery flat — nothing charges during debugging | charge powered-off |
| Screen dark, system healthy | Backlight at 0 | `/sys/class/leds/lcd-backlight` |
| Compositor never starts on DRM-less device | DRM probe loop | product.env guard |
| Compositor spins on "failed to get drm master" | Android `charger` holds it (charger-mode boot), or HWC opened twice | Stage 3; `lsof \| grep card0` |
| Apps: "Failed to create wl_display" | XDG_RUNTIME_DIR split | hal-userspace.md § Wayland socket |
| EGL_BAD_ALLOC everywhere | GPU node perms (ion/pvr_sync) | vendor ueventd.rc → udev rule |
| Compositor SIGSEGV ~1 s in, `si_addr` is ASCII text (Mali) | Clobbered thread pointer: TLS hook missing / Mali quirks compiled out | hal-userspace.md § Mali |
| test_hwcomposer segfaults / runs but black | Blob/linker fault, or gralloc/copybit | smoke-test ladder (Stage 3) |
| Hardware keys ignored by Qt | Input node lacks `ID_INPUT_KEYBOARD` | udev rule (Stage 3) |
| Web app drawn too small / cropped | Client vs compositor size disagreement | Stage 3 window measurement |
| Nothing from ofono/sensorfw/nfcd despite config | HAL never registered, or wrong gbinder `ApiLevel` | `binder-list`; hal-userspace.md § Before blaming AIDL |
| AIDL HAL "missing" on an A15+ vendor | `ApiLevel` from a dated `ro.board.api_level`, or a HIDL-only daemon | hal-userspace.md |
| Audio, camera or other subsystems dead; modules not loaded (GKI) | Container's `/vendor_dlkm` is an empty bind | module list check (Stage 4); hal-userspace.md § Vendor kernel modules |
| Wifi service restart-looping | modprobing a nonexistent module | is the driver built in? |
| No wifi on MTK; `wmt_loader` errors | WMT modules not loaded, nodes not exposed, power-on not retried | hal-userspace.md § MediaTek connectivity |
| A unit never runs on one machine, nothing in the journal | Gated on `/sys/module/...` with a built-in driver | Stage 4 wifi |
| Wi-Fi works but no 5 GHz networks; `iw reg get` says country 00 | No regulatory.db, or the latched early load | `iw reg reload` (Stage 4) |
| Ping works, TCP hangs | Path problem (often the router's band bridging) | Stage 4 test matrix |
| `Required key not found` on modprobe | Module signature enforcement (Tier B) | disable `CONFIG_MODULE_SIG*` |
| Vendor modules never load on a rebuilt GKI kernel though the CRC check passes | `CONFIG_MODULE_SIG_PROTECT` must be off | kmi-crc-matching.md § A failure class invisible to CRC checks: MODULE_SIG_PROTECT |
| MTK modem "exception", RIL dead | Wrong fstab → NV partitions unmounted | Stage 4 modem |
| SIM never detected (Qualcomm) | `/dev/block/bootdevice/by-name` structure missing | Stage 4 modem |
| BT HAL can't open its node | Container ueventd ownership vs vendor ueventd.rc | hal-userspace.md § Bluetooth |
| `hci0` DOWN, "Invalid request code (56)" | Controller rejects a command it advertised | `btmon` (Stage 4) |
| BT scans but won't connect; BlueZ on a different `hci` than bluebinder | Adapter index mismatch and/or rfkill restored blocked | hal-userspace.md § Bluetooth |
| Reset 57 s in, `BUG_ON(!sk)` in `bt_sock_reclassify_lock` | Vendor stubbed `hci_sock_create()` | kernel-porting.md § Vendor trees that stub out `net/bluetooth/hci_sock.c` (Samsung) |
| Audio pitched / tempo-shifted | pa-droid sample-rate quirk | hal-userspace.md § Audio |
| pulseaudio SIGSEGV after "cannot locate symbol ... referenced by /vendor/..." | Vendor HAL needs its VNDK | `HYBRIS_PREFER_VNDK` (hal-userspace.md § Audio) |
| PulseAudio killed ~1 s after startup, status 9 | `RLIMIT_RTTIME` on SCHED_RR sink threads | `signal_generate` trace |
| Speakers silent, headphones fine, HAL "undefined in AudioParamOptions" | Vendor lib assumes zeroed `malloc` | hal-userspace.md § Vendor libraries that assume Android's zeroed malloc |
| Sound card never registers (`-517`) | A deferred ASoC component's module not loaded | Stage 4 audio |
| Web-app audio silent, nothing reaches PulseAudio | umediaserver: `waitid(P_PIDFD)`, pipeline binary, resource table | hal-userspace.md § webOS media server |
| `nfcd` stopped a few minutes after boot | Waydroid's container start stops it | Stage 4 misc |
| Waydroid: "Failed to clone a new set of namespaces" | Kernel lacks IPC_NS/USER_NS; config has no namespace keep | Stage 4 misc |
| Network-time toggle errors | No `timedatectl` by design | Stage 4 misc |
| `appinstalld2`: `Failed to execute child process "ar"` | No `ar` on the image | installer journal |
| Daemon at a fixed % of a core, ~40k wakeups/s, no I/O | Zero-interval GTimerSource | Stage 5 §2 |
| Vendor helper at ~100% of a core, massive logcat rate | Daemon bypassed by the LuneOS stack spinning on a dead fd | Stage 5 §1 |
| pulseaudio busy while silent; sink RUNNING forever | Uncorked stream (Qt EOS bug) | Stage 5 §3 |
| Idle flash writes high | Kernel driver debug_mask / log spam | Stage 5 §4 |
| Journal of a crashed boot ends after a few seconds | journald flushes every 5 min by default | tooling appendix |

## Tooling appendix

**Make the journal survive a forced power-off.** `Storage=auto` with the default `SyncIntervalSec=5m` means a capture often holds only the first seconds of a boot that ran for minutes — it reads exactly like an early crash. Before debugging anything slower than a few seconds:

```
# /etc/systemd/journald.conf
Storage=persistent
SyncIntervalSec=1s
```

Check *where* the journal lives: on a Halium rootfs `/var` is commonly bind-mounted from the data partition, so `rootfs.img`'s `/var/log/journal/` is empty and the real one is in `<data>/luneos-data/var/log/journal/<machine-id>/`. Boot-time kernel lines rotate out of the dmesg ring and the journal's kernel part within minutes on a chatty MTK kernel — read them right after boot or capture `journalctl -k -b` early.

**`sh -x` as ExecStart for a unit that logs nothing.** A `Type=notify` unit that times out with no output has usually died before its first log statement:

```
# /etc/systemd/system/<unit>.service.d/99-debug.conf
[Service]
ExecStart=
ExecStart=/bin/sh -x /usr/bin/<the-script>
```

`exec` at the end of the script keeps the PID, so `Type=notify` still works.

**Test an environment variable without writing a file:** `systemctl set-environment VAR=1; systemctl restart <unit>; systemctl unset-environment VAR`.

**Who sent the SIGKILL?** For a process "killed, status=9/KILL" with no log and no core, trace the kernel's signal generation:

```sh
T=/sys/kernel/tracing                     # tracefs is mounted on Halium images
echo 0 > $T/tracing_on; echo > $T/trace
echo "sig==9" > $T/events/signal/signal_generate/filter
echo 1 > $T/events/signal/signal_generate/enable; echo 1 > $T/tracing_on
# ... reproduce ...
echo 0 > $T/tracing_on; grep signal_generate $T/trace
```

The line names the *sending* thread; `code=128` (SI_KERNEL) in hard-IRQ context (`d.h`) means the kernel killed it itself. A sender of `init` or `systemd` is a different problem.

**strace a service under its real environment.** Running a daemon from a shell changes its environment enough to hide the bug; run it as a transient unit with the unit's own environment file: `systemd-run --unit=x -p EnvironmentFile=-/etc/default/foo /tmp/strace -f -e trace=openat,newfstatat -s 160 -o /tmp/x.log /usr/bin/foo ...`. There is no `strace` on the image; take the aarch64 one from the build's `tmp/deploy/ipk/aarch64-halium/strace_*.ipk` (`ar p ... data.tar.zst | zstd -dc | tar -x`) and pipe it over ssh into `/tmp` (same for `alsa-utils-amixer`/`-aplay`). To watch a running daemon, attach with `-f -p $(pidof daemon)` *before* triggering the action.

**Reading an aarch64 core with no gdb and no debuginfo.** Host `gdb` dies on aarch64 cores and the rootfs carries no debugger:

1. `eu-stack --core <core>` — raw frame addresses.
2. Parse `NT_FILE` from `readelf -n <core>` to map each address to its library; subtract the library's lowest mapped address for a file offset.
3. `readelf -sW <lib>` — the enclosing `FUNC` symbol.
4. Parse `NT_SIGINFO` **by hand** for `si_addr` (offset 16 in the descriptor on aarch64; `readelf` prints only the header). ASCII text there means a clobbered thread pointer, not a null deref.

The core's mapping list is a ground-truth inventory of which vendor blobs really loaded, and Android's property pages are mapped into it, so `strings core | grep ...` recovers live property values from a dead process.

**busybox is not GNU.** `ls` column-formats into a pipe (`dummy_udc.0  musb-hdrc` on one line) — iterate the directory instead; `head` wants `-n N`; there is no `timeout` (`cmd & p=$!; (sleep N; kill $p) & wait $p`); `dd` has no `conv=fsync` and prints its usage while writing nothing; `od`, `head -c` and `diff` are too limited for binary or file comparison — do that on the host; `ls -l a b 2>&1` interleaves differently.

**Writing files on the device.** Prefer `adb push` from a local copy over `adb shell "cat > file <<EOF ... EOF"` (on the MP01 several bootloops followed heredoc writes — a correlation only, unproven). Keep backups outside scanned directories: a `.orig` plugin next to the real one gets loaded too.

**Never `pkill -f`/`pgrep -f` a pattern that also appears in your own adb shell command line**; select by `/proc/<pid>/cmdline`.

**Reboot reliably from adb:** `systemd-run --on-active=2 /bin/systemctl --force reboot --reboot-argument=normal`. A backgrounded command dies with the adb session, and a plain reboot can land a Samsung device in charger mode.

**opkg can run other packages' pending postinsts.** Installing one ipk once configured a long-pending `android-kernel-bootimg` postinst that dd'd a kernel over lk2nd. Dry-run with `opkg install --noaction` and check `/var/lib/opkg/status` for unpacked packages first.

**`luna-send`:** `luna://com.webos.service.applicationmanager/launch` and `close` print a reply without `-i`; `-i` into a pipe printed nothing.
