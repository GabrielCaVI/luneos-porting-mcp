# Device: sm-t220 (Samsung Galaxy Tab A7 Lite Wi-Fi, MT8768T)

Samsung Galaxy Tab A7 Lite Wi-Fi (`sm-t220`), MediaTek MT8768T, Tier B on its stock Android 12 vendor and the Halium 16 GSI: boots LuneOS with audio, media, app installs.

A MediaTek tablet (platform `mt6765`) running the stock Android 12 vendor and its 4.19.191 kernel under the generic Halium 16 GSI, modelled on radon (device-radon.md). Worth reading for the chain of faults that all looked like "no sound" — a kernel syscall, a vendor library's allocator assumption, a resource table and a scheduler limit, none visible in a mixer — and for the Samsung Odin/TWRP install route (installing.md § Samsung Download mode).

## Status (as of 4 Oct 2026)

| Area | State | Notes |
|---|---|---|
| Boot | works | Halium initramfs finds `rootfs.img` on userdata; container up |
| Display, touch | works | maintainer report |
| Wi-Fi | works | maintainer report; no `firmware_class.path` needed |
| Speaker audio | works | PulseAudio route and GStreamer, verified on device |
| Headphones, jack detect | works | |
| HTML5 media (umediaserver) | works | Testr app, verified on device |
| App install (appinstalld2) | works | needs `ar` (§ Subsystem notes) |
| Camera | works | maintainer report |
| Sensors | partial | grip (SAR) only; proximity request answered "invalid sensor type: 8" |
| Bluetooth, GPS, suspend/resume, charging | untested | |
| Telephony | n/a | Wi-Fi model, no modem |
| USB in LuneOS | none | no gadget configured, so debug over Wi-Fi ssh |

## Platform facts

Read from the factory firmware (T220XXSAEYE4) and the running tablet.

| Fact | Value |
|---|---|
| SoC / platform | MT8768T, `mt6765`; PowerVR GPU behind MediaTek's "meow" EGL wrapper (`ro.hardware.egl=mtk` works) |
| Vendor | Android 12, sdk 31, VNDK 31, `ro.product.vendor.device=gta7litewifi` (so the adaptation directory is `gta7litewifi`), `ro.hardware.hwcomposer=mtk_common` |
| Partitions | single slot eMMC: boot `mmcblk0p38` (32 MiB), recovery p39, dtbo p13, vbmeta p14, vbmeta_system p40, vbmeta_vendor p41, super p45 (system/system_ext/vendor/product/odm), userdata p51 (f2fs) |
| Panel | 800x1340, driver-reported 107 x 172 mm (196 ppi, not ruler-checked), `lcd_density` 213 |
| Codec | MT6357 PMIC codec (`mtk-soc-codec-6357.c`; the `mt6358` directory next to it is not the one built) |
| Speaker amps | two Awinic AW87xxx class-K PAs on i2c bus 3 (0x58, 0x59, chip id 0x59), fed from the codec line-out |
| Keys | Vol Up on `mtk-kpd`, Vol Down and Power on `mtk-pmic-keys`, headset jack as a `mt-snd-card Headset Jack` input |
| Sensors (stock) | ST lis2doc accel, Memsic mmc5603 mag, AMS tsl2540 light |
| Power supply | `mt6370_pmu_charger`, `mtk-gauge`, `mtk-master-charger` |
| Console | kernel dts console `ttyS0,921600n1`; whether the UART is reachable is unknown |

## Kernel

`gta7lite/android_kernel_samsung_ot8`, branch `halium-12`: Samsung's 4.19.191 drop plus one Halium config commit, built with Google Clang r416183b, `gta7litewifi_defconfig` + the branch's `halium.config` + `luneos.cfg` (a first pass: 28 options differ from Samsung's defconfig). The running stock kernel was built with Android clang 11.0.1 (r383902).

Patches:

- **0002 restores `net/bluetooth/hci_sock.c`.** Samsung reduces `hci_sock_create()` to `return 0`; bluebinder's HCI socket then hits `BUG_ON(!sk)` in `bt_sock_reclassify_lock` and MediaTek's `ipanic_die()` resets the device — a "Failed to boot" panic then a reset every 77 s (57 s of it in the kernel), seen as preloader `0e8d:2000` re-enumerating. `net/bluetooth/` differed from v4.19.191 in that file only (kernel-porting.md § Vendor trees that stub out `net/bluetooth/hci_sock.c`). Evidence: `/sys/fs/pstore/console-ramoops-0`, read in TWRP right after a loop reset.
- **0003 backports `waitid(P_PIDFD)`.** Applied to 4.19.191 with only line offsets; the 4.14 `CLONE_PIDFD` `*parent_tidptr` follow-up is not needed here because this `copy_process()` has no such check (kernel-porting.md § `pidfd_open()` without `waitid(P_PIDFD)`).

**Known difference from stock dtb: battery charging data.** The source tree is older than the firmware: `battery_cv` and the `jeita_temp_*_cv` values are 0x432380 (4.40 V) against stock 0x42d560 (4.38 V), `ss,cv-ranges` differ, and stock has a `gxy_battery_ttf` node. Decided by the maintainer: left as is, 4.40 V judged safe. Not a bug to rediscover.

## Boot image

Header v2, page 2048, kernel `0x40080000`, ramdisk `0x51b00000`, tags/dtb `0x47880000`, os_version `0x18000195` (Android 12, patch 2025-05); cmdline `bootopt=64S3,32N2,64N2 printk.devkmsg=on`. The dtb section must be an Android `dt_table` (magic `0xd7b7ab1e`, one entry id 0) wrapping `mt6765.dtb` — this lk does not parse a bare FDT. `do_make_dt_table` builds it, and the same layout rebuilds Samsung's table byte for byte (boot-images.md § Class 1 — legacy header v2).

## Vendor and GSI

Stock Android 12 vendor (VNDK 31) out of `super`, served by the Halium 16 `halium_arm64` GSI. The running firmware was T220XXS6CWL2 (Android 13 system, Android 12 vendor); boot-image work used the newer factory T220XXSAEYE4.

## Yocto

Layer `meta-smartphone/meta-samsung`, `MACHINE=sm-t220`; status file `meta-samsung/conf/machine/sm-t220-STATUS.md`. `deviceinfo_hardware_egl="mtk"`; `deviceinfo_android_skip_services="stp_dump"`.

## Install

Samsung Download mode route (installing.md § Samsung Download mode (Odin, TWRP)). Device specifics:

- **Unlock once:** Developer options → OEM unlocking, then Download mode (Vol Up + Vol Down while plugging in USB) and long-press Vol Up at the warning screen. Orange state; the Knox warranty bit is set. `adb reboot download` from stock goes straight to "Downloading...".
- The Samsung lk's fastboot answers "not allowed in locked state" and has no flash/erase commands.
- **vbmeta:** an unsigned header with `AVB_VBMETA_IMAGE_FLAGS_VERIFICATION_DISABLED` (flags=2 at offset 120, padded to 4096) lets the unlocked lk boot a non-Samsung image.
- **Odin** (`odin4` for Linux, built from `main` at e916c1e or later; the release fails multi-part sequences with "expected 30 got 0") is fine for `boot` and `vbmeta`. Use `TMPDIR` on a real disk, one fresh Download session per run, and a newline before the md5 trailer of the `.tar.md5`. `SW REV CHECK FAIL: [userdata]` (fused 6 > binary 0) is cosmetic.
- **Odin's userdata write left holes in the rootfs image** — at flash time, content-specific, not zero runs, not decompression, not the initramfs resize. Do not use it for userdata.
- **Rootfs through TWRP** (Vol Up + Power): `adb -s <serial> push rootfs.ext4 /data/rootfs.img.new` (~79 MB/s; over Wi-Fi ssh ~0.6 MiB/s, an hour for 4.4 GB), verify the checksum, rename the current file to `rootfs.img.prev` and the new one to `rootfs.img`. Always `adb -s`: TWRP and another device are often both on the bus.
- **Boot partition from a running LuneOS:** `dd` the `Image.gz.fastboot` to `/dev/mmcblk0p38`, read back and compare, keep a copy of the old partition. BusyBox `dd` here has no `conv=notrunc`; patch in place by concatenating `dd bs=4` pieces. `android-kernel-bootimg`'s postinst writes the boot image too, so an `opkg` install of it re-flashes the kernel.
- **Rollback:** `ro.boot.rp=6` on the tablet (…XXS6… firmware). Flashing the YE4 factory bootloader raises the rollback value irreversibly; the LuneOS package touches only boot, vbmeta and userdata. Restore with matching firmware to keep the option of going back to S6.
- After the first boot on a new rootfs ssh refuses the old host key: new image, new keys.

## Subsystem notes

**PulseAudio killed with no trace: `RLIMIT_RTTIME`.** PulseAudio loaded `module-droid-card` and died ~1 s later (`code=killed, status=9/KILL`, no core, no log). It arms `RLIMIT_RTTIME` (200 ms) with real-time scheduling; the droid sink threads run `SCHED_RR` and a write into the MediaTek HAL can run longer without sleeping, so the scheduler tick SIGKILLs from interrupt context. Found with the `signal_generate` tracepoint filtered to `sig==9` (debugging.md § Tooling appendix): sender `droid-sink-deep` itself, `code=128`, hard-IRQ. Fix: `rlimit-rttime = -1` in `/etc/pulse/daemon.conf.d/`, keeping real-time scheduling.

**Speakers silent, headphones fine: uncleared `malloc` in a vendor library.** A direct `aplay` to `hw:0,0` with only `Audio_Amp_L/R` on was audible on headphones; every mixer setting was silent on the speakers, with the jack verified empty. The HAL never selected the Awinic path. `AudioALSAHardwareResourceManager::setNonSmartPAType()` maps `MTK_AUDIO_SPEAKER_PATH`: `int_spk_amp` → 0 (internal amp, `speaker_output` only), `int_lo_buf` → 1, `int_hp_buf` → 2 (`aw_speaker_*` / Awinic), `2_in_1_spk` → 3, `3_in_1_spk` → 4. The vendor `AudioParamOptions.xml` says `int_hp_buf`, but the HAL logged `MTK_AUDIO_NUMBER_OF_MIC undefined in AudioParamOptions` and used 0. `strace -f -e trace=openat,newfstatat` on a copy of the PulseAudio process:

    newfstatat(".../\264\254\213\233U/vendor/etc/audio_param_huaqin/NA/AudioParamOptions.xml") = -1 ENOENT

`libaudio_param_parser-vnd.so` `appGetXmlDirFromProperty()` does `buf = malloc(512)` then `strcat(buf, path)` (and `property_set`s the corrupted value: `persist.vendor.audio.tuning.def_path = "wڞU/vendor/..."`). General lesson, and the fixes that did not work: hal-userspace.md § Vendor libraries that assume Android's zeroed `malloc`. What works here: `mtk-audio-param-fixup` patches a copy of the device's own library at boot — `mov w1,#1` / `nop` / `bl calloc@plt` replacing `ldr`/`stur`/`bl malloc`, plus a `nop` over the now canary-less stack-protector check — checks every instruction word it changes, does nothing on a different build, and bind-mounts it over the original before PulseAudio starts. No vendor binary is redistributed. Not the amplifier switch: the 32-bit `awinic.audio.effect.so` the HAL fails to `dlopen` ("is 32-bit instead of 64-bit") is Awinic's speaker-protection DSP (`aw_piano_*`).

**`module-droid-hidl` without its helper.** It spawns `/usr/libexec/audiosystem-passthrough/audiosystem-passthrough`, but the recipe had only a build-time `DEPENDS`, so the image lacked the binary ("helper disappeared"). Check the runtime dependency whenever a module execs a helper.

**Web-app audio: three layers**, all general and described in hal-userspace.md § webOS media server (umediaserver) on Halium. Here the `waitid(P_PIDFD)` layer is fixed by kernel patch 0003 (§ Kernel), and the resource table is raised to VDEC 16 / ADEC 8.

**`stp_dump3` at 93% CPU.** `start-android-hals.sh` starts every service init left stopped, including `disabled` ones; MediaTek's connectivity core-dump collector sat at ~93% (56 CPU-minutes in one reading) beside a load average ~26. Tell: `init: Processed ctl.start for 'stp_dump' from pid: 0`. Fix: `deviceinfo_android_skip_services="stp_dump"`, plus a `prop.halium` with `persist.vendor.connsys.coredump.mode=0` (and the AEE dump properties) bind-mounted over the GSI's empty `/system/etc/prop.halium` — the mechanism FuriOS' adaptations use. It was not what made file copies slow; the Wi-Fi path was (under 1 MiB/s with it stopped).

**appinstalld2.** It unpacks an IPK with `ar`, which the standard image lacks (busybox built without the applet; `binutils` only in the developer package group): `Failed to execute child process "ar"`. Its package database under `/media/cryptofs/apps` cannot see system packages, so `Depends: cordova` fails with `nothing provides cordova`; repack without `Depends:` for a test. A hand-run `opkg install` succeeds into the system root, which is misleading. `LunaAppManager`, `appinstalld` and `ApplicationInstallerUtility` log the exact `opkg` command line in the journal.

Audio-debugging and logging techniques found here (jack-state check via `EVIOCGSW`, `amixer contents` diffs on the host, strace from the deploy directory's ipk, `logcat -b all -c` against a flooding tag) are in debugging.md (§ Audio, § Tooling appendix). On this chatty MTK kernel the dmesg ring and the journal's kernel part rotate within minutes, so audio/accdet/i2c probe lines are gone by the time you ssh in: reboot and read them at once, or capture `journalctl -k -b` early. `AudioALSAPlaybackHandlerNormal` alone filled logcat with 35,000 lines.

## Open issues

- Panel size not ruler-checked; proximity probably absent on the Wi-Fi model, not checked against the spec sheet.
- GPS, Bluetooth, suspend/resume, charging behaviour.
- `luneos.cfg` is a first pass; validate against `/proc/config.gz` of a running kernel.
- Backlight node for the initramfs `machine.conf` not set.
- No USB gadget in LuneOS.

## Sources

- https://github.com/gta7lite/android_kernel_samsung_ot8 (branch `halium-12`)
- LineageOS device trees `android_device_samsung_mt6765-common` and `android_device_samsung_gta7litewifi` in the same GitHub org, branch `lineage-22.2`
- https://github.com/shr-distribution/meta-smartphone (`meta-samsung`)
