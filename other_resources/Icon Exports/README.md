# Icon Export Know-How

This folder stores the source icon set exported from Icon Composer.

## What these files are for

- Source of truth: this folder
- Main source image: `Icon-iOS-Default-1024x1024@1x.png`
- Optional reference image: `Icon-iOS-Default-512x512@1x.png`

The Electron app does not read these files directly. The real app icons are regenerated into:

- `build/icon.icns`
- `build/icon.ico`
- `build/icon.png`
- `resources/icon.png`

## Current visual rule

- Default visual scale: `80%`
- Why: the raw Icon Composer export fills the whole canvas and looks too large in macOS Dock and Finder
- Fix: shrink the artwork inside a transparent canvas before generating Electron icons

In practice, use a `1024x1024` source, resize artwork to about `819x819`, then center it on a transparent `1024x1024` canvas.

## Recovery instruction for Codex

If the leader asks to rebuild icons from this folder, do this:

1. Read this file first.
2. Use `other_resources/Icon Exports/Icon-iOS-Default-1024x1024@1x.png` as the source.
3. Apply the default `80%` visual scale unless the leader asks for another size.
4. Regenerate all four output files:
   `build/icon.icns`
   `build/icon.ico`
   `build/icon.png`
   `resources/icon.png`
5. Verify:
   `build/icon.png` and `resources/icon.png` should have visible content coverage around `0.80`
   `build/icon.icns` should be a valid macOS icon file
   `git status --short build/icon.icns build/icon.ico build/icon.png resources/icon.png` should show modified files when changed

## Known-good generation approach

Use ImageMagick plus `tiff2icns`.

- `iconutil` was unreliable with these Icon Composer PNG exports
- `tiff2icns` produced valid `.icns` files consistently

Reference shell flow:

```sh
tmpdir=$(mktemp -d)
src='other_resources/Icon Exports/Icon-iOS-Default-1024x1024@1x.png'
padded="$tmpdir/icon-1024-padded.png"

magick "$src" -background none -resize 819x819 -gravity center -extent 1024x1024 PNG32:"$padded"
magick "$padded" -resize 512x512 PNG32:build/icon.png
cp build/icon.png resources/icon.png
magick "$padded" -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico

for size in 16 32 48 128 256 512 1024; do
  magick "$padded" -resize ${size}x${size} PNG32:"$tmpdir/${size}.png"
done

magick \
  "$tmpdir/16.png" \
  "$tmpdir/32.png" \
  "$tmpdir/48.png" \
  "$tmpdir/128.png" \
  "$tmpdir/256.png" \
  "$tmpdir/512.png" \
  "$tmpdir/1024.png" \
  "$tmpdir/icon.tiff"

tiff2icns "$tmpdir/icon.tiff" build/icon.icns
rm -rf "$tmpdir"
```

## Verification snippets

Check PNG content coverage:

```sh
python3 - <<'PY'
from PIL import Image
for path in ['build/icon.png', 'resources/icon.png']:
    img = Image.open(path).convert('RGBA')
    bbox = img.getchannel('A').getbbox()
    print(path, img.size, bbox)
PY
```

Check generated file types:

```sh
file build/icon.icns build/icon.ico build/icon.png resources/icon.png
```

## Notes

- If a new icon still looks too large, reduce the scale below `80%`
- If it looks too small, increase the scale above `80%`
- If macOS still shows the old icon, the issue is usually icon cache, not generation
