# Device: a3-2015-halium (Samsung Galaxy A3 2015, SM-A300FU) — MSM8916 on the 16.0 GSI through lk2nd

A 32-bit Qualcomm MSM8916 phone from 2015 running the LineageOS 18.1 vendor (VNDK 30) of vlw's a3lte
trees under the generic `halium_arm` 16.0 GSI, booted through lk2nd. Kept next to the mainline machine
`a3-2015`. Working on 8 Oct 2026: UI, modem (rmt_storage, qmuxd, rild), Wi-Fi with the real MAC,
Bluetooth, audio, flashlight, camera preview and still pictures. Layer `meta-smartphone/meta-samsung`,
`MACHINE=a3-2015-halium`; status file `meta-samsung/conf/machine/a3-2015-halium-STATUS.md`.

What makes it worth reading: almost every fault was a generic gap that only this combination exposed —
a vendor kernel too old for the GSI's assumptions, a Samsung bootloader that boots into charger mode
after every hard reset, a HAL1 camera, and the first VNDK 30 vendor in the legacy set.

## Platform facts

| Fact | Value |
|---|---|
| Kernel | vlw `android_kernel_samsung_msm8916-caf` lineage-18.1, 3.10.108, 32-bit; LuneOS branch `a3-2015/3.10/lineage-18.1` in shr-distribution/linux |
| Vendor | LineageOS 18.1 `lineage_a3lte` built in a Halium 11 tree, converted by halium-legacy-vendor (VNDK 30) |
| Boot | Samsung SBL, then lk2nd at the start of the boot partition, which boots the real boot image from 512 KiB in |
| Adaptation | `ro.product.vendor.device=a3lte` (every model), so the adaptation directory is `a3lte` |
| Charger / gauge | rt5033 (no current reading), sec-battery; pack 1900 mAh (LineageOS power_profile.xml) |
| Wi-Fi / BT | WCNSS (pronto), prima built in (`CONFIG_PRONTO_WLAN=y`); BT over the Android HAL and bluebinder |
| Camera | QCamera2 HAL1 behind LineageOS' Samsung camera wrapper, mm-qcamera-daemon; rear (90°) and front (270°) |
| Flash | rt5033 flash driver, `/sys/class/camera/flash/rear_flash` only (no LED class device) |

## Lessons, in the order they bit

1. **The kernel command line was cut at 1024 bytes.** CONFIG_CMDLINE + boot image cmdline + the 775 bytes
   the Samsung SBL passes through lk2nd overflow 3.10's `COMMAND_LINE_SIZE`. Everything after `lcd_id` was
   lost, including `androidboot.baseband`, `androidboot.mode` and `mdss_mdp.panel`. Symptom: the modem
   came up and the phone reset ~10 s later, every boot. Fix: `COMMAND_LINE_SIZE 2048`. Check
   `wc -c /proc/cmdline` on any legacy port whose bootloader passes a long command line.
2. **rmt_storage stops itself on `ro.baseband=unknown`** ("Remote storage service is not supported on
   unknown target"), the modem loses its EFS, crashes, and restart level SYSTEM resets the SoC.
3. **rmt_storage relies on ANDROID_PARANOID_NETWORK.** It drops to `setgid(AID_NET_RAW)` + `setuid(9999)`
   keeping only CAP_BLOCK_SUSPEND; on Android, paranoid networking makes group net_raw count as
   CAP_NET_RAW for the IPC router's bind check. With it off (as luneos.cfg had it, following sm-t520):
   "msm_ipc_router_bind: rmt_storage Do not have permissions". Fixed narrowly by accepting group net_raw
   in `ipc_router_security.c check_permissions()`. See kernel-porting.md for the general rule.
4. **MemAvailable** is missing before 3.14; memorymanager then refuses every app launch. The tenderloin
   commit "mm: add MemAvailable to /proc/meminfo" cherry-picks cleanly onto 3.10.
5. **Charger mode after every hard reset with a cable.** Off-mode charging, a long Power press, lk2nd's
   `fastboot reboot` and a plain `reboot` (msm-poweroff does a PMIC hard reset without a reboot argument)
   all come up with `androidboot.mode=charger androidboot.baseband=lpm`. Crash resets and reboots with an
   argument (`systemctl reboot --reboot-argument=normal`; systemd 257 ignores the old positional form)
   come up normal. With the truncated command line LuneOS never saw the mode and booted in full on
   `baseband=lpm`. The initramfs has to hold in charger mode (Herrie82/meta-smartphone#6 does it with a
   charging screen; its power-key reboot must pass an argument on this phone).
6. **Display: three gaps, each hiding the next.** libft2.so (`HALIUM_LEGACY_EXTRA_LIBS`), the legacy shim
   for the composer's framework copies (`HALIUM_LEGACY_SHIM_TARGETS`), and gralloc in sphal needing
   libbinder/libui (GSI linkerconfig change, now for VNDK 28 and 30). See hal-userspace.md.
7. **Wi-Fi:** prima starts on `echo sta > /sys/module/wlan/parameters/fwpath`, but only once the WCNSS
   control channel is up (`wcnss_version` stops reading INVALID); writing earlier fails with ENODEV
   after 12 s. And the vendor's `hciattach` (init.qcom.bt.sh) must not be force-started at boot: it
   powers WCNSS up through the BT path before wcnss_service ("regulator get of riva_vddmx failed (-19)",
   "Failed to execute wcnss_wlan_power") and then neither Wi-Fi nor BT work.
8. **EFS and the Bluetooth address.** LineageOS had no fstab line for `/efs` either; a vendor
   `fstab.efs` makes mount-android.sh mount it read-only. The BT HAL needs `ro.bt.bdaddr_path` (from
   the device's system.prop, carried with `HALIUM_LEGACY_SYSTEM_PROP_PREFIXES`) and group 3008 to read
   `bt_addr` (radio:net_bt_stack 0640) — by number, the 16.0 init no longer knows `net_bt_stack`.
9. **Flashlight:** Samsung's `rear_flash` file, now a nyx led_torch backend.
10. **Camera, three layers:** a provider service (LineageOS loads the provider in-process; built in the
    same Halium 11 tree and declared hwbinder), the text-relocation shim for libmmcamera_faceproc.so (else
    "mct_stream_start_link ... Null" and a white preview), and five HIDL threads in minimediaservice
    (else takePicture deadlocks). See hal-userspace.md.

## Tools that worked on this phone

- A RAM-booted test image (`fastboot boot` in lk2nd) whose initramfs holds with an RNDIS telnet shell
  (`a3_hold` on the command line) — battery and power-supply state readable without booting LuneOS.
- A logger started from the initramfs (`dmesg > file; sync` every 0.5 s on the rootfs) for boots that
  die before adb; the next boot reads the previous one's file.
- `debuggerd -b <container pid>` inside the container for native backtraces of a hung HAL.
- Rebooting reliably: `systemd-run --on-active=2 /bin/systemctl --force reboot --reboot-argument=normal`
  (a backgrounded command in an adb shell dies with the session).
- Recovery when the boot partition is lost: Download mode and
  `heimdall flash --BOOT <lk2nd (512 KiB) + boot.img>`.
