# playhound on macOS and Linux

Each [release](https://github.com/whatmekota/playhound/releases/latest) has:

| You have                             | Download                                    |
| ------------------------------------ | ------------------------------------------- |
| Mac with Apple silicon (M1 or later) | `playhound-<version>-mac-arm64.dmg`         |
| Mac with an Intel chip               | `playhound-<version>-mac-x64.dmg`           |
| Linux, 64-bit PC                     | `playhound-<version>-linux-x86_64.AppImage` |

Not sure which Mac you have? Apple menu → About This Mac: "Chip: Apple M…" is
Apple silicon, "Processor: Intel" is Intel.

## macOS

playhound is not signed by Apple (that needs a paid developer account), so
macOS blocks it the first time.

1. Open the `.dmg` and drag playhound into Applications.
2. Open playhound. macOS says it cannot check it for malware. Click **Done**
   (not Move to Bin).
3. Let it through:
   - **macOS 15 (Sequoia) and later:** System Settings → Privacy & Security,
     scroll down to "playhound was blocked", click **Open Anyway** and confirm.
   - **macOS 14 and earlier:** right-click (or Control-click) playhound in
     Applications, choose **Open**, then **Open** again.

After that it opens normally. If macOS says the app "is damaged and can't be
opened", run this once in Terminal, then open it again:

```bash
xattr -dr com.apple.quarantine /Applications/playhound.app
```

Allow **Bluetooth** when it asks (for the Handy and heart-rate monitors), and
allow incoming connections and the **local network** if asked, or the phone
remote cannot connect.

**Updates are manual on macOS.** Apple only lets signed apps update
themselves. playhound still checks, and says in the title bar and in
Settings → Updates when a new version is out. Download the new `.dmg` and
drag it over the old app. Your library, playlists and settings stay where they
are (`~/Library/Application Support/playhound`). A new download needs step 3
once more.

## Linux

1. Download the `.AppImage`.
2. Make it executable: `chmod +x playhound-*.AppImage`, or in your file manager
   Properties → Permissions → Allow executing as program.
3. Run it.

If it does not start:

- **"dlopen(): error loading libfuse.so.2"**: install FUSE 2,
  `sudo apt install libfuse2` (`libfuse2t64` on Ubuntu 24.04 and later).
- **An error about the SUID sandbox** (Ubuntu 24.04 and later restrict it):
  start it with `./playhound-*.AppImage --no-sandbox`.

For an OSR / SR6 over USB, your user needs access to serial ports:
`sudo usermod -aG dialout $USER` (the group is `uucp` on Arch), then log out
and back in.

**Updates are automatic** for the AppImage, as on Windows: a new version
downloads in the background and installs when you quit, or when you click
**Restart to update** in the title bar. Keep the AppImage where it is; it is
replaced in place. Your data lives in `~/.config/playhound`.
