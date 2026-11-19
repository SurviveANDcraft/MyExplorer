//! `icon` and `thumb` URI scheme protocols (PNG).

use std::num::NonZeroUsize;
use std::sync::{Arc, LazyLock};

use lru::LruCache;
use parking_lot::Mutex;
use tauri::http::{header, Response};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Com::IBindCtx;
use windows::Win32::UI::Controls::IImageList;
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHGetImageList, SHFILEINFOW,
    SHGFI_SYSICONINDEX, SHGFI_USEFILEATTRIBUTES, SIIGBF_THUMBNAILONLY,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
use windows_core::PCWSTR;

use crate::util::*;

type Png = Arc<Vec<u8>>;

static ICONS: LazyLock<Mutex<LruCache<String, Png>>> =
    LazyLock::new(|| Mutex::new(LruCache::new(NonZeroUsize::new(4096).unwrap_or(NonZeroUsize::MIN))));

struct ThumbCache {
    lru: LruCache<String, Png>,
    bytes: usize,
}
const THUMB_BYTES: usize = 24 * 1024 * 1024;
static THUMBS: LazyLock<Mutex<ThumbCache>> = LazyLock::new(|| Mutex::new(ThumbCache { lru: LruCache::unbounded(), bytes: 0 }));

fn snap_size(s: Option<&str>) -> u32 {
    let v: u32 = s.and_then(|x| x.parse().ok()).unwrap_or(32);
    [16u32, 32, 48, 96, 256].into_iter().find(|&x| x >= v).unwrap_or(256)
}

fn png_response(png: Option<Png>) -> Response<Vec<u8>> {
    match png {
        Some(p) => Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(p.as_ref().clone())
            .unwrap_or_else(|_| Response::new(Vec::new())),
        None => Response::builder()
            .status(404)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new())),
    }
}

// ── pixel helpers ───────────────────────────────────────────────────────────

struct Rgba {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

/// 32bpp top-down BGRA bits of a bitmap.
unsafe fn bitmap_bits(hbm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    // SAFETY: caller passes a valid HBITMAP; buffers sized from its dimensions.
    unsafe {
        let mut bm = BITMAP::default();
        if GetObjectW(HGDIOBJ(hbm.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth.unsigned_abs(), bm.bmHeight.unsigned_abs());
        if w == 0 || h == 0 || w > 4096 || h > 4096 {
            return None;
        }
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(dc, hbm, 0, h, Some(buf.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        if lines == 0 {
            return None;
        }
        Some((w, h, buf))
    }
}

fn bgra_to_rgba(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
    }
}

unsafe fn hicon_to_rgba(hicon: HICON) -> Option<Rgba> {
    // SAFETY: valid HICON from the image list; bitmaps deleted, icon destroyed.
    unsafe {
        let mut ii = ICONINFO::default();
        GetIconInfo(hicon, &mut ii).ok()?;
        let color = if ii.hbmColor.is_invalid() { None } else { bitmap_bits(ii.hbmColor) };
        let mask = if ii.hbmMask.is_invalid() { None } else { bitmap_bits(ii.hbmMask) };
        if !ii.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        let _ = DestroyIcon(hicon);
        let (w, h, mut px) = color?;
        if px.chunks_exact(4).all(|p| p[3] == 0) {
            // No alpha channel: derive from the AND mask (black = opaque).
            if let Some((mw, mh, m)) = mask {
                if mw == w && mh >= h {
                    for (i, p) in px.chunks_exact_mut(4).enumerate() {
                        p[3] = if m[i * 4] == 0 { 255 } else { 0 };
                    }
                }
            } else {
                for p in px.chunks_exact_mut(4) {
                    p[3] = 255;
                }
            }
        }
        bgra_to_rgba(&mut px);
        Some(Rgba { w, h, px })
    }
}

fn unpremultiply(px: &mut [u8]) {
    let premul = px.chunks_exact(4).all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3]);
    if !premul {
        return;
    }
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a > 0 && a < 255 {
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

/// Area-average downscale (or nearest upscale) to fit within `size`.
fn fit(img: Rgba, size: u32) -> Rgba {
    if img.w <= size && img.h <= size {
        return img;
    }
    let scale = size as f32 / img.w.max(img.h) as f32;
    let nw = ((img.w as f32 * scale).round() as u32).max(1);
    let nh = ((img.h as f32 * scale).round() as u32).max(1);
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        let y0 = y * img.h / nh;
        let y1 = ((y + 1) * img.h / nh).max(y0 + 1);
        for x in 0..nw {
            let x0 = x * img.w / nw;
            let x1 = ((x + 1) * img.w / nw).max(x0 + 1);
            let mut acc = [0u32; 4];
            let mut n = 0u32;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * img.w + sx) * 4) as usize;
                    let a = img.px[i + 3] as u32;
                    acc[0] += img.px[i] as u32 * a;
                    acc[1] += img.px[i + 1] as u32 * a;
                    acc[2] += img.px[i + 2] as u32 * a;
                    acc[3] += a;
                    n += 1;
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            if let (Some(r), Some(g), Some(b)) =
                (acc[0].checked_div(acc[3]), acc[1].checked_div(acc[3]), acc[2].checked_div(acc[3]))
            {
                out[o] = r as u8;
                out[o + 1] = g as u8;
                out[o + 2] = b as u8;
            }
            out[o + 3] = (acc[3] / n.max(1)) as u8;
        }
    }
    Rgba { w: nw, h: nh, px: out }
}

fn encode(img: &Rgba) -> Option<Png> {
    let mut out = Vec::with_capacity((img.w * img.h) as usize);
    {
        let mut enc = png::Encoder::new(&mut out, img.w, img.h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().ok()?;
        w.write_image_data(&img.px).ok()?;
    }
    Some(Arc::new(out))
}

// ── icons ───────────────────────────────────────────────────────────────────

enum IconSrc<'a> {
    Ext(&'a str),
    Path(&'a str),
}

/// Must run on an STA thread.
fn sys_icon(src: &IconSrc, size: u32) -> Option<Rgba> {
    let (name, attrs, use_attrs) = match src {
        IconSrc::Ext(":dir") => ("folder".to_string(), FA_DIRECTORY, true),
        IconSrc::Ext("") => ("file".to_string(), FA_NORMAL, true),
        IconSrc::Ext(e) => (format!("file.{e}"), FA_NORMAL, true),
        IconSrc::Path(p) => (p.to_string(), 0, false),
    };
    let w = wide(&name);
    let mut sfi = SHFILEINFOW::default();
    let mut flags = SHGFI_SYSICONINDEX;
    if use_attrs {
        flags |= SHGFI_USEFILEATTRIBUTES;
    }
    // SAFETY: valid string and out struct; COM initialized on this thread.
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(w.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(attrs),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if ok == 0 {
        return None;
    }
    let get = |list: i32| -> Option<Rgba> {
        // SAFETY: system image list access on STA thread.
        unsafe {
            let il: IImageList = SHGetImageList(list).ok()?;
            let hicon = il.GetIcon(sfi.iIcon, 1 /* ILD_TRANSPARENT */).ok()?;
            hicon_to_rgba(hicon)
        }
    };
    // SHIL_LARGE=0 (32), SHIL_SMALL=1 (16), SHIL_EXTRALARGE=2 (48), SHIL_JUMBO=4 (256)
    let img = match size {
        16 => get(1),
        32 => get(0),
        48 => get(2),
        _ => {
            let j = get(4);
            match j {
                // Jumbo list pads small-only icons into the top-left corner: use the 48px version.
                Some(img) if content_extent(&img) <= 48 && img.w >= 256 => get(2),
                other => other,
            }
        }
    }?;
    Some(fit(img, size))
}

fn content_extent(img: &Rgba) -> u32 {
    let mut m = 0u32;
    for y in 0..img.h {
        for x in 0..img.w {
            if img.px[((y * img.w + x) * 4 + 3) as usize] > 8 {
                m = m.max(x + 1).max(y + 1);
            }
        }
    }
    m
}

fn icon_png(src: IconSrc, size: u32) -> Option<Png> {
    let key = match &src {
        IconSrc::Ext(e) => format!("e:{e}:{size}"),
        IconSrc::Path(p) => format!("p:{}:{size}", p.to_lowercase()),
    };
    if let Some(p) = ICONS.lock().get(&key) {
        return Some(p.clone());
    }
    let png = encode(&sys_icon(&src, size)?)?;
    ICONS.lock().put(key, png.clone());
    Some(png)
}

/// Icon for a real path, never touching cloud placeholder content.
fn path_icon(path: &str, size: u32) -> Option<Png> {
    let attrs = crate::fs::attributes(path);
    let name = file_name(path);
    match attrs {
        Some(a) if is_cloud_attrs(a) => icon_png(IconSrc::Ext(&ext_of(name)), size),
        Some(_) => icon_png(IconSrc::Path(path), size),
        None => icon_png(IconSrc::Ext(&ext_of(name)), size),
    }
}

pub fn icon_response(uri: &str) -> Response<Vec<u8>> {
    let params = query_params(uri);
    let get = |k: &str| params.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
    let size = snap_size(get("size"));
    let png = if let Some(p) = get("path").filter(|p| !p.is_empty()) {
        path_icon(&norm_path(p), size)
    } else {
        let ext = get("ext").unwrap_or("").trim_start_matches('.').to_lowercase();
        icon_png(IconSrc::Ext(&ext), size).or_else(|| icon_png(IconSrc::Ext(""), size))
    };
    png_response(png)
}

// ── thumbnails ──────────────────────────────────────────────────────────────

fn shell_thumb(path: &str, size: u32) -> Option<Rgba> {
    let w = wide(path);
    // SAFETY: COM on STA thread; bitmap deleted after copying its bits.
    unsafe {
        let f: IShellItemImageFactory =
            SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None::<&IBindCtx>).ok()?;
        let hbm = f.GetImage(SIZE { cx: size as i32, cy: size as i32 }, SIIGBF_THUMBNAILONLY).ok()?;
        let bits = bitmap_bits(hbm);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let (bw, bh, mut px) = bits?;
        if px.chunks_exact(4).all(|p| p[3] == 0) {
            for p in px.chunks_exact_mut(4) {
                p[3] = 255;
            }
        } else {
            unpremultiply(&mut px);
        }
        bgra_to_rgba(&mut px);
        Some(fit(Rgba { w: bw, h: bh, px }, size))
    }
}

pub fn thumb_response(uri: &str) -> Response<Vec<u8>> {
    let params = query_params(uri);
    let get = |k: &str| params.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
    let size = snap_size(get("size").or(Some("256")));
    let Some(path) = get("path").filter(|p| !p.is_empty()).map(norm_path) else {
        return png_response(None);
    };
    let key = format!("{}|{size}|{}", path.to_lowercase(), get("m").unwrap_or(""));
    if let Some(p) = THUMBS.lock().lru.get(&key) {
        return png_response(Some(p.clone()));
    }
    let attrs = crate::fs::attributes(&path);
    let thumb = match attrs {
        // Never hydrate cloud placeholders; folders fall back to their icon.
        Some(a) if !is_cloud_attrs(a) && a & FA_DIRECTORY == 0 => shell_thumb(&path, size).and_then(|i| encode(&i)),
        _ => None,
    };
    match thumb {
        Some(png) => {
            let mut c = THUMBS.lock();
            c.bytes += png.len();
            if let Some(old) = c.lru.put(key, png.clone()) {
                c.bytes -= old.len();
            }
            while c.bytes > THUMB_BYTES {
                match c.lru.pop_lru() {
                    Some((_, v)) => c.bytes -= v.len(),
                    None => break,
                }
            }
            png_response(Some(png))
        }
        None => png_response(path_icon(&path, size)),
    }
}

/// PNG bytes of a 32bpp (often premultiplied) menu bitmap; None if unreadable.
pub(crate) fn hbitmap_png(hbm: HBITMAP) -> Option<Vec<u8>> {
    // SAFETY: caller passes a live HBITMAP it owns or borrows for the call.
    let (w, h, mut px) = unsafe { bitmap_bits(hbm)? };
    if px.chunks_exact(4).all(|p| p[3] == 0) {
        if px.chunks_exact(4).all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0) {
            return None;
        }
        for p in px.chunks_exact_mut(4) {
            p[3] = 255;
        }
    }
    unpremultiply(&mut px);
    bgra_to_rgba(&mut px);
    encode(&Rgba { w, h, px }).map(|a| a.to_vec())
}
