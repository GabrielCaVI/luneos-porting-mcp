# Device: radon (FuriPhone FLX1s, MT6877)

FuriLabs FuriPhone FLX1s (`radon`), MediaTek Dimensity 900 (MT6877), Tier B on FuriLabs' Android 12L vendor and the Halium 16 GSI: UI, audio, Wi-Fi, camera work.

A pre-GKI 4.19 port with none of the usual Tier B pain: FuriLabs ship FuriOS (Debian, systemd, libhybris, an LXC Android container) on this exact kernel and publish the kernel tree, adaptation and vendor image, so the LuneOS config delta is one option. It is the tree's only kit flashed over the MediaTek BROM/preloader link instead of fastboot (installing.md § MediaTek BROM/preloader), and it boots with FuriOS' own initramfs, not LuneOS'.

## Status (as of 27 Sep 2026)

Hardware-verified on an FLX1s unless marked otherwise.

| Area | State | Notes |
|---|---|---|
| Boot | works | our kernel + FuriOS' bootman initramfs, `plymouth.enable=0` (§ Boot image) |
| Display / UI | works | writeback connectors excluded, `ro.hardware.egl=meow`, `force_hwc2` (§ Subsystem notes) |
| Touch | works | FocalTech FT8057S, built in, derived |
| Audio | works | after the GSI bump that ships `com.android.vndk.v31` (§ Vendor and GSI) |
| Wi-Fi | works | needs `firmware_class.path=/vendor/firmware` on the cmdline |
| Bluetooth | unknown | the kernel recipe credits the same firmware-path fix; no separate hardware record |
| Camera | works | rear + front, camera app (radon.conf) |
| Privacy switches | works | camera and cellular switches via `kpd_customkey` after three driver fixes; `killswitch` feature |
| Modem | unknown | dual SIM declared in the adaptation (`slot1 slot2`, radio 1.4); end to end not recorded |
| USB debug | works | rndis + adb gadget (`radon-usb-debug`) |
| NFC, fingerprint, eSIM | n/a | not present in hardware (radon.conf) |
| GPS, sensors, suspend, charging | untested | |

## Platform facts

From FuriLabs' repositories, their shipping flash package (`flx1s-furios-stable.tar.gz`, build dated 23 Jul 2026) and the device.

| Fact | Value | Source |
|---|---|---|
| Codename / name | `radon`; FuriPhone **FLX1s**; `FLASH_INFO_DEVICE_IDS = k6877v1_64` | FuriLabs packaging |
| SoC | **MT6877 = Dimensity 900**; 2× Cortex-A78 2.4 GHz + 6× Cortex-A55 2.0 GHz, Mali-G68 MC4 | `FLASH_INFO_CPU`, spec sheet |
| RAM / storage | 8 GB LPDDR4X / 128 GB **UFS** (three LUNs, `/dev/sda:/dev/sdb:/dev/sdc`) | `bootman-ignore-partition` |
| Display | 6.7" **720×1600**, 90 Hz, DSI video-mode panel `DRM_PANEL_TRULY_FT8756_VDO=y` (built in); 262 ppi; upright (`MTK_LCM_PHYSICAL_ROTATION="0"`, `ORIENTATION_0`) | kernel config, vendor build.prop |
| Touch | FocalTech FT8057S (`TOUCHSCREEN_FTS_FT8057S=y`); the "goodix" dmesg noise is GT9886 touch, not a sensor | kernel config |
| Vendor | FuriLabs' own **Android 12L** build (`radon-vendor-32`): `ro.vndk.version=32`, `ro.vendor.build.version.sdk=32`, `ro.board.first_api_level=30`, `ro.board.platform=mt6877`, `ro.hardware.hwcomposer=mtk_common`, `ro.sf.lcd_density=320` (a bucket) | vendor build.prop from `super.img` |
| Adaptation key | `ro.product.vendor.device=radon` (`ro.product.vendor.model=FLX1s`, manufacturer FuriLabs) | vendor build.prop |
| Partitions | **A/B** and **dynamic** (`super`, 7168 MiB, holds FuriLabs' vendor); `boot_a`/`boot_b` 40 MiB; `userdata` scatter-declared 3072 MiB (nominal; FuriLabs ship a 6.4 GiB image); `preloader` 1 MiB; `vendor_boot_a` is FuriOS' persist store (`furios-persist`) | scatter, FuriLabs packaging |
| Connectivity | 2G-5G, dual SIM (`ro.telephony.sim.count=2`, `persist.radio.multisim.config=dsds`), Wi-Fi 6, `MTK_COMBO_CHIP="CONSYS_6877"` built in (`MTK_COMBO=y`) | vendor, kernel config |
| Keys | power/volume plus an assistant button (KEY_PROG1, keycode 112); camera (GPIO 51), cellular (GPIO 52) and microphone hardware switches | FuriLabs adaptation, kernel |
| Battery | 5000 mAh | spec sheet |
| Debug channels | no exposed UART (lk sets `console=ttyS0,921600n1`); `PSTORE_RAM=y`/`PSTORE_CONSOLE=y` with lk reserving ramoops at `0x48090000`; `expdb` | lk log, kernel config |

## Kernel

`github.com/furilabs/linux-furiphone-radon`, branch `forky` (FuriLabs' release-branch name), SRCREV `5144e9240df3126e011c114e50f0b18e6d54b64d` ("defconfig: bump CMA to 64"), **4.19.325**, `k6877v1_64_k419_defconfig` (`MTK_PLATFORM="mt6853"`: the MT6877 shares that platform directory on 4.19). The vendor's own maintained tree, with live `feature/forky/CVE-*` branches. Recipe `linux-furilabs-radon_git.bb`, modelled on sunfish's: `kernel.bbclass` + `kernel_android`, toolchain swapped through `KERNEL_CC`/`KERNEL_LD`/`KERNEL_OBJCOPY`/`KERNEL_STRIP`.

**Toolchain:** Google's prebuilt Android Clang **r416183b**, the release FuriLabs pin in `debian/kernel-info.mk` (`BUILD_CC = clang`, `BUILD_LLVM = 1`) and the one sunfish, q25, mp01 and bramble use; set `GKI_CLANG_DIR:radon` in `local.conf` (`do_check_toolchain` fails early without it). `EXTRA_OEMAKE` adds `CLANG_TRIPLE=aarch64-linux-gnu- LLVM_IAS=1`, the llvm binutils, and `CROSS_COMPILE_COMPAT=arm-linux-gnueabi-` (`COMPAT_VDSO=y`); no `PYTHON=python3` (that is a 5.10 `link-vmlinux.sh` problem). `DEBUG_PREFIX_MAP` is filtered of `-fcanon-prefix-map`, a GCC 12+ option clang 12 rejects. Host tools need `BUILD_CFLAGS:append = " -std=gnu17"` (`unifdef.c`). Stock `LTO_CLANG=y` is kept; `LTO_CLANG_THIN` does not exist in this tree. Built banner: `Android (7284624, based on r416183b) clang version 12.0.5`, identical to FuriLabs' apart from suffix and host.

**Config:** all 64 symbols the LuneOS/Halium/Waydroid stack needs (the union of athena's and mindphone's fragments) are already correct in the stock defconfig, `STATIC_USERMODEHELPER` is already unset and `ANDROID_BINDER_DEVICES` already lists the anbox nodes. `luneos.cfg` sets only `CONFIG_CUSE=y` (stock `=m`). Deliberately left at stock: `DUMMY=y`, `FW_LOADER_USER_HELPER`, `KALLSYMS_ALL=y`, `IKHEADERS=m`, `MODULE_SIG` unset, and the list-valued `TOUCHSCREEN_MTK_TOUCH` / `CUSTOM_KERNEL_IMGSENSOR` (they name source subdirectories; edit one and the directory must exist).

**No modules.** UFS, dm, panel, USB controller and the combo connectivity drivers are built in; `lsmod` shows three modules, all from this tree, and neither our initramfs nor FuriOS' carries device modules. Nothing to match (kmi-crc-matching.md § Step −1).

**Patches** (against FuriLabs' branch, `kpd_customkey.c`, the ODM driver behind the privacy switches; built in, exports nothing, `Module.symvers` identical across the rebuild):

- 0001 leaked wakeup source: the release was guarded on a global shared by every key and skipped when the last edge left the GPIO low, so one flip pinned the device awake while dmesg claimed release.
- 0002 the handler slept in hard IRQ context (`cancel_delayed_work_sync`, `mutex_lock` under `devm_request_irq`); now a threaded IRQ.
- 0003 switch state reported at probe; before, the first flip after boot produced no event and `EVIOCGKEY` disagreed with sysfs. The killswitch daemon still polls sysfs (no `sysfs_notify()`).

**`CMDLINE` is set in the recipe** to the stock `root=/dev/ram vmalloc=496M slub_max_order=0 slub_debug=O console=tty0`: meta-oe's `linux.inc` unconditionally writes `CONFIG_CMDLINE="${CMDLINE} ${CMDLINE_DEBUG}"`, so with `CMDLINE` unset the first build came out `" loglevel=3 systemd.unified_cgroup_hierarchy=0 ..."` with MediaTek's string gone. Any machine requiring `linux.inc` without setting `CMDLINE` has the same loss.

### Rejected paths

- **Bring-up instrumentation broke the boot.** `luneos.cfg` once added `FRAMEBUFFER_CONSOLE` (+`DETECT_PRIMARY`, a font) and promoted `NETCONSOLE`/`NETPOLL` to `=y`. The device showed lk's splash then a watchdog reset, with no gadget even in the `enable_adb` image, no pstore record and no initramfs trace. Substitution settled it — ours+ours, FuriLabs' kernel+ours and ours+FuriLabs' ramdisk all hung, so the common factor was our kernel — and the built-`.config`-vs-stock diff was eight lines, two of them the cause (debugging.md § Method). Do not re-enable them here; the panel is DRM with fbdev emulation and lk has already painted the splash.
- **A GCC build with `LTO_NONE`.** Wrong for this tree: build it as the vendor validates it.

## Boot image

All values derived from FuriLabs' `debian/kernel-info.mk` (mkbootimg offsets against base `0x40078000`) and confirmed against the shipping `boot.img`:

| Field | Value |
|---|---|
| header / page | v2 / 2048 (header_size 1660) |
| kernel | `0x40080000` |
| ramdisk | `0x51100000` |
| tags, dtb | `0x47c80000` |
| second | `0x00000000` (`0x40078000 + 0xbff88000` is exactly 2³²; `android_bootimg_v2()` packs `"<I"`) |
| os_version | `0x18000199` (12.0.0 / 2025-09, FuriLabs' stamp; never write a lower value) |
| dtb | bare FDT `mediatek/mt6877.dtb` via `KERNEL_DEVICETREE` (171,885 B, SHA-256 identical to FuriLabs'); not a dt_table |
| dtbo | not folded in; `dtbo_a`/`dtbo_b` keep the stock 42,816-byte overlay (md5 `40ea5ad4f03eb69862c1198fa890f239`) |
| cmdline | `bootopt=64S3,32N2,64N2 plymouth.enable=0 printk.devkmsg=on firmware_class.path=/vendor/firmware`, appended to the built-in line (`CMDLINE_EXTEND=y`) |

- **Window:** `0x51100000 - 0x40080000` = 272 MiB; nothing is trimmed for size. The boot image fits `boot_a` (40 MiB) with room; FuriLabs' own is 38.0 MiB.
- **The cmdline reaches the kernel intact.** lk's log shows the string it passes; there is no MT6789-style 20-character loss on this bootloader. `enable_adb` is still built into `CONFIG_CMDLINE` (`LUNEOS_ENABLE_ADB=1`).
- **`id` is not verified by MTK lk**: FuriLabs' shipping image has an `id` that matches no v0/v1/v2 scheme and boots. Ours is computed correctly.
- **Ramdisk = FuriOS' bootman initramfs**, fetched prebuilt by `furios-bootman-initramfs` from the UBports FLX1 port (UBports SRCREV `ca191aa651d9a88b2edfeb18335a929840d3ec02`, `unpack=0`, `LICENSE = "CLOSED"`: an opaque binary, check before shipping it in a product). `INITRAMFS_NAME` is set in the kernel recipe after the inherit (a machine-conf value is overwritten by `kernel_android.bbclass`), plus `do_deploy[depends] += "furios-bootman-initramfs:do_deploy"`. LuneOS' Halium initramfs (Tofee's `tofe/halium-9.0`) has no LVM support and never reached the rootfs here; FuriOS' has it and lays the rootfs out as LuneOS expects (`/halium-system/var/lib/lxc/android/android-rootfs.img`, `/android`, `/userdata/android-data`). The working Ubuntu Touch port does the same (`deviceinfo_prebuilt_boot_ramdisk`).
- **`plymouth.enable=0` is required.** FuriOS' initramfs starts plymouthd, which survives `switch_root` holding the framebuffer; LuneOS ships no plymouth units, so a healthy LuneOS ran 256 s, 566 s, 598 s behind a pulsing FuriOS logo. Their `scripts/init-premount/plymouth` honours the flag; the only restarters (`unlock_encrypted_partition`, `run_furios_recovery`) are not reached.
- **`firmware_class.path=/vendor/firmware` must be on the cmdline**, not set later in sysfs: with `MTK_COMBO=y` the combo drivers `request_firmware()` `conninfra.cfg` and `wifi.cfg`, the default `/lib/firmware` does not hold them, and `conninfra_dev_do_drv_init()` latches a static `init_done` after the container's `conninfra_loader` triggers it (~11 s), so there is no second attempt. Failure reads like hardware: `failed to parse 'coex_wmt_epa_elna'`, `Fail to get conninfra pinctrl`, `Direct firmware load for wifi.cfg failed with error -2`, `WMT turn on WIFI fail!`. Value copied from FuriLabs' own cmdline.

## Vendor and GSI

FuriLabs' own vendor (`vendor-3.img`, from filedump.furios.io), which FuriOS `dd`s into the inactive `dynpart-vendor_a|_b`. Leave it in place and target it; a unit that never ran FuriOS may carry the stock MediaTek vendor, so check which is flashed before comparing two devices. VNDK 32 is inside what the stock `halium_arm64` 16.0 GSI ships (`android-system-image-radon.bb`, release from `halium-luneos-gsi-16.inc`), carried as `android-rootfs.img` and loop-mounted so `super` is never written.

**`com.android.vndk.v31` is needed even though the vendor is VNDK 32.** `HYBRIS_PREFER_VNDK` (hal-userspace.md § Audio) picks the APEX from `/vendor/etc/selinux/plat_sepolicy_vers.txt`, which reads **31.0** here (normal for 12.1). The `20260826-1` GSI shipped only v32 and v34, the lookup returned "", and the feature silently turned itself off; pulseaudio died on `cannot locate symbol "_ZN7android4base8BasenameERKNSt3__1..." referenced by "/android/vendor/lib64/libnvram.so"`. The `20260910` GSI ships all of `PRODUCT_EXTRA_VNDK_VERSIONS := 27 … 34`; bumping to it fixed audio. Every 16.0 recipe now takes its GSI from one `halium-luneos-gsi-16.inc` (32-bit and legacy machines override its PV; device-bringup-yocto.md § android-system-image recipes), and libhybris patch 0009 falls back to the oldest APEX at least as new and warns once when nothing resolves.

## Yocto

Layer `meta-smartphone/meta-furilabs`, `MACHINE=radon` (`require meta-android-halium.inc`, `KERNEL_IMAGETYPE = "Image.gz"`, `PREFERRED_VERSION_android-headers-halium = "16.0%"`, `pulseaudio-modules-droid` 17.0.103, no X server). `MACHINE_FEATURES` omit `nfc`, `fingerprint` and `esim`, which keeps nfcd/biomd/lpac out; add `killswitch`, `camera-rear camera-front`.

| Recipe | Role |
|---|---|
| `linux-furilabs-radon_git.bb` + `luneos.cfg` + 3 patches | kernel + boot image |
| `furios-bootman-initramfs_1.0.bb` | the prebuilt ramdisk |
| `android-system-image-radon.bb` | the 16.0 GSI as `android-rootfs.img` |
| `radon-usb-debug_1.0.bb` | one gadget carrying rndis + adb in FunctionFS order, rndis-only fallback, binds the first non-dummy UDC; radon-only until proven |
| `initramfs-scripts-halium` bbappend | `S01-lvm-bootman.sh` and the `LUNEOS_TRACE_INITRD` harness, for LuneOS' own initramfs (not in the shipped boot image) |
| `luneos-device-config` bbappend, `radon-deviceinfo` | Tier 1 adaptation |
| `bootman_git.bb` | bootman with the DRM backend (minui is not in OE); not installed |

```sh
MACHINE=radon bitbake linux-furilabs-radon    # -> Image.gz-radon.fastboot
```

`ANDROID_BOARD_BOOTIMAGE_PARTITION = "/dev/disk/by-partlabel/boot_a"` is the on-device path for a running system rewriting its boot image; MTK only gets `by-partlabel`.

## Install

Two routes.

**Standalone (mtkclient, wipes FuriOS)** — installing.md § MediaTek BROM/preloader for the rules. Enter BROM: power fully off, hold Volume Down, plug in USB (a bootlooping phone presents its preloader each cycle). `backup-stock.sh` first: it reads `boot_a`, `boot_b`, the GPT and a baseline `expdb`, writes nothing; no factory image is published (FuriLabs ship the kernel as the Debian package `linux-bootimage-furiphone-radon`). `install.sh` writes `vbmeta_a`/`_b` (a generated empty unsigned AVB image, flags 0x3, byte-identical to FuriLabs' `merged/vbmeta.img`), `boot_a` + `boot_b` (both: the active slot lives in `misc`; `SLOT=_a` overrides) and `userdata`. Never `super` (FuriLabs' vendor), `preloader`, `lk`, `tee`, `md1img`, `dtbo`, `misc`, firmware, or `vendor_boot_a`. FuriLabs' own flash writes slot A only (`boot_b`, `dtbo_b`, `md1img_b` are `is_download: false`). The scatter carries both EMMC and UFS layouts. `install.sh` parses `mtk printgpt` with sed and `printf`, not gawk's `strtonum()`.

**Dual-boot alongside FuriOS (bootman, LVM).** `userdata` is an LVM PV, VG `furios`; each OS lives in an LV and carries its own boot image. In FuriOS: install `furios-app-bootman`, create an LV named exactly `luneos` (≥ 8 GiB), reboot, then run `install-dualboot.sh` on the phone. Selecting an entry makes bootman mount the LV, read `VERSION=` from `<lv>/usr/lib/furios/device/flash-bootimage.conf`, require `<lv>/boot/boot.img-$VERSION` **and** `<lv>/boot/dtbo.img-$VERSION`, `dd` them to `boot_a` and `dtbo_a`, write the LV to `/furios-persist/bootman/next-boot` and reboot; the initramfs mounts that LV and rotates `next-boot` → `old-boot`. With no `next-boot`, the FuriOS initramfs runs bootman, and choosing the entry equal to `old-boot` boots it directly.

- **Keep the raw partition and the in-LV copy in step.** bootman reflashes both on every selection: an LV holding an old plymouth-enabled `boot.img-*` undid the fix on each trip through the menu, and a 39,074-byte self-built dtbo in the LV hung lk outright (no preloader, no log). `dtbo_a` and every LV's `dtbo.img-*` must be the stock 42,816-byte file; UBports say the same ("dtbo built in ubports build system fails to boot").
- **Restoring FuriOS takes two writes:** FuriLabs' `boot.img` to `boot_a` **and** `old-boot` in `furios-persist` (`vendor_boot_a`) reset to `/dev/furios/furios-rootfs` (dump, edit the ext4 with debugfs, `fsck -fn`, write back), or FuriOS' kernel mounts the LuneOS LV. Flashing a LuneOS image directly needs the matching persist state (`next-boot = /dev/furios/luneos`, no `old-boot`) in the same session.

## Subsystem notes

**Display.** MediaTek DRM reports its writeback endpoints as permanently connected (`card0-Writeback-1/2 status=connected enabled=disabled` beside `card0-DSI-1`); `product.env` excluded `Virtual` connectors but not `Writeback`, so the compositor picked `Writeback1`, hung 90 s and restarted forever. Excluding writeback unconditionally (a writeback endpoint can never be the only output) gives `Display device to use: card0, DSI1`, geometry `720x1600+0+0r0s1`. Then `couldn't find an OpenGL ES implementation` (SIGABRT, 753+ restarts): the vendor sets `ro.board.platform=mt6877` and no `ro.hardware.egl`, and ships `libGLES_mali.so` and `libGLES_meow.so`; `deviceinfo_hardware_egl="meow"` as on mp01 (hal-userspace.md § Mali under libhybris). Precondition for both: `deviceinfo_force_hwc2="1"`, without which surface-manager spends its 90 s start timeout failing to take DRM master.

**Scaling.** 262 ppi → GridUnit 15 (1.45 mm per unit vs sargo's 1.44); `deviceinfo_device_pixel_ratio="1.6"` gives a 450 × 1000 CSS canvas (unverified on hardware). FuriLabs run phosh at scale 2 (360 × 800), right for GTK, wrong for Enyo.

**Audio.** 48 kHz (`deviceinfo_audio_sample_rate`), from FuriLabs' `load-module module-droid-card rate=48000 voice_virtual_stream=true hw_volume=false`; `hw_volume=false` has no LuneOS key yet, the thread to pull if volume is stuck. `deviceinfo_hybris_prefer_vndk="1"` (§ Vendor and GSI).

**Wi-Fi / Bluetooth (combo).** Firmware path above. Units gated on `/sys/module/wlan*` or `.ko` globs never ran with the driver built in — the mtk-connectivity BT unit, `mtk-connectivity-wifi` and `wlan-suspend-mode`, whose `driver_layout()` also picked the Qualcomm private-ioctl struct (`SETSUSPENDMODE 0 layout=qcom -> FAIL [Errno 22]`, `layout=mtk -> OK`); rule: debugging.md § Never gate a unit on `/sys/module/<driver>`, hal-userspace.md § MediaTek connectivity. cfg80211 is built in and FuriLabs' 4.19 trusts both the wens and sforshee regdb keys (debugging.md § Regulatory domain). An SSH-banner-then-hang over Wi-Fi was the router bridging 2.4 and 5 GHz, not the phone (debugging.md § "Wi-Fi associates, ping works, but TCP hangs"). Do not copy mp01's bluebinder Synchronization Train mask unless `hci0` fails with "Unknown HCI Command".

**Modem.** `lshal` returns nothing on this device (verified on FuriOS, host and container), so 40-ofono-binder cannot derive slots: the adaptation states `deviceinfo_binder_slots="slot1 slot2"` and `deviceinfo_binder_radio_interface="1.4"` (with explicit slots the plugin otherwise falls back to 1.2, which this modem answers with `getSignalStrengthResponse_1_2 INVALID_RESPONSE`). `radon-modem-image` and FuriLabs' 131-line `70-radon.rules` (ccci, flashlight, vibrator, touch) have not been reviewed.

**Keys.** Not pinned; derivation should find power/volume (`mtk-pmic-keys`, `mtk-kpd`). FuriLabs' `input-redirector-ignore` lists `event0..event3` as built-in keys and touch.

## Open issues

- Bluetooth and modem end to end not recorded on hardware.
- An earlier boot showed `conninfra_loader` SIGSEGV (fault addr 0x3) inside the GSI's Android 16 `liblog` (`__android_log_print` from `main+752`) — Android 12 vendor code under the Android 16 linker, which no `HYBRIS_*` variable reaches; the proper fix is a vendor linker namespace (`ld.config.txt`) the GSI does not generate. Whether it still occurs after the firmware-path fix is not recorded.
- The FuriOS bootman initramfs is an opaque `CLOSED` binary; replacing it means LVM support in LuneOS' initramfs (`S01-lvm-bootman.sh` reimplements the contract but differs: FuriOS never mounts `userdata` under LVM and keeps everything in the root LV).
- `radon-modem-image` and `70-radon.rules` not reviewed; `deviceinfo_device_pixel_ratio` unverified.

## Device-specific traps

- **Instrumentation must not change the result.** Panic-only dumping (`dump_fail_to_part`) wrote 8 MiB of zeros because this device hung, never panicked; a periodic dumper to `init_boot_b` was the right shape (debugging.md § Recording the initramfs to a spare partition). A heavy one (`systemd.log_level=debug`, 8 MiB `log_buf_len`, the ring written every 2 s) made the boot get less far. Zero the log partitions before each boot and require a header in the reader; run one mtkclient process at a time.
- **ext4 will not mount a device rw while it is mounted ro elsewhere**; it quietly gives another ro mount ("source write-protected"). A leftover `mount -o ro /dev/furios/luneos` blocked every write; `umount -l` keeps the superblock held.
- **USB transport:** xHCI enumeration failed on three ports (`device descriptor read/64, error -110`, 146 TX errors) until a different cable fixed it. FuriOS' NetworkManager re-applies `172.16.42.1/24` on `usb0` (`pt2usb` profile); use IPv6 link-local: `ping6 -c4 -I usb0 ff02::1`, then `ssh furios@fe80::<phone>%usb0`. FuriOS' tethering advertises `FuriOS forky Device on rndis0 10.15.19.82` in iSerial.
- The vendor's `bootopt=` is lk's, not ours to change; and do not copy mp01's 20-character cmdline padding, KMI-poison list, panel rotation, `GKI_BOOTIMG` or ThinLTO.

## Sources

- https://github.com/furilabs/linux-furiphone-radon (branch `forky`)
- https://github.com/furilabs/adaptation-furiphone-radon
- https://github.com/furilabs/radon-vendor-32
- https://github.com/furilabs/bootman
- https://gitlab.com/ubports/porting/community-ports/android12/furiphone-flx1/furiphone-krypton (carries `deviceinfo-radon`)
- https://github.com/bkerler/mtkclient
- https://github.com/shr-distribution/meta-smartphone (`meta-furilabs`)
