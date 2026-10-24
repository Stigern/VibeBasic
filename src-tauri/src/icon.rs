//! The project icon off macOS (where sips makes the .icns): a PNG decoded to RGBA (the Linux window icon), scaled to the
//! sizes of a Windows .ico, and the .ico itself (PNG-compressed images, which Windows reads since Vista).
#![cfg_attr(target_os = "macos", allow(dead_code))]

use std::io::Cursor;

/// An 8-bit RGBA image, rows top to bottom.
#[derive(Debug, Clone, PartialEq)]
pub struct Rgba {
  pub width: u32,
  pub height: u32,
  pub pixels: Vec<u8>,
}

pub fn is_png(b: &[u8]) -> bool {
  b.starts_with(b"\x89PNG\r\n\x1a\n")
}

/// A Windows icon file (reserved 0, type 1, at least one image).
pub fn is_ico(b: &[u8]) -> bool {
  b.len() >= 22 && b[..4] == [0, 0, 1, 0] && (b[4] != 0 || b[5] != 0)
}

pub fn decode_png(png: &[u8]) -> Result<Rgba, String> {
  let mut dec = png::Decoder::new(Cursor::new(png));
  dec.set_transformations(png::Transformations::normalize_to_color8());
  let mut reader = dec.read_info().map_err(|e| format!("icon: {e}"))?;
  let mut buf = vec![0u8; reader.output_buffer_size().ok_or("icon: the image is too large")?];
  let info = reader.next_frame(&mut buf).map_err(|e| format!("icon: {e}"))?;
  let (w, h) = (info.width as usize, info.height as usize);
  let channels = match info.color_type {
    png::ColorType::Grayscale => 1,
    png::ColorType::GrayscaleAlpha => 2,
    png::ColorType::Rgb => 3,
    png::ColorType::Rgba => 4,
    png::ColorType::Indexed => return Err("icon: unsupported PNG colour type".into()),
  };
  let mut pixels = Vec::with_capacity(w * h * 4);
  for y in 0..h {
    let row = &buf[y * info.line_size..][..w * channels];
    for px in row.chunks_exact(channels) {
      pixels.extend_from_slice(&match channels {
        1 => [px[0], px[0], px[0], 255],
        2 => [px[0], px[0], px[0], px[1]],
        3 => [px[0], px[1], px[2], 255],
        _ => [px[0], px[1], px[2], px[3]],
      });
    }
  }
  Ok(Rgba { width: info.width, height: info.height, pixels })
}

pub fn encode_png(img: &Rgba) -> Result<Vec<u8>, String> {
  let mut out = Vec::new();
  let mut enc = png::Encoder::new(&mut out, img.width, img.height);
  enc.set_color(png::ColorType::Rgba);
  enc.set_depth(png::BitDepth::Eight);
  let mut w = enc.write_header().map_err(|e| e.to_string())?;
  w.write_image_data(&img.pixels).map_err(|e| e.to_string())?;
  w.finish().map_err(|e| e.to_string())?;
  Ok(out)
}

/// `img` scaled (area average, aspect kept) and centred on a transparent `size` x `size` square.
pub fn fit_square(img: &Rgba, size: u32) -> Rgba {
  let (w, h) = (img.width.max(1) as f64, img.height.max(1) as f64);
  let scale = size as f64 / w.max(h);
  let (dw, dh) = (((w * scale).round() as u32).clamp(1, size), ((h * scale).round() as u32).clamp(1, size));
  let (ox, oy) = ((size - dw) / 2, (size - dh) / 2);
  let (sx, sy) = (w / dw as f64, h / dh as f64);
  let mut pixels = vec![0u8; (size * size * 4) as usize];
  for y in 0..dh {
    let (y0, y1) = (y as f64 * sy, (y + 1) as f64 * sy);
    for x in 0..dw {
      let (x0, x1) = (x as f64 * sx, (x + 1) as f64 * sx);
      // premultiplied sums, so transparent pixels don't darken the edges
      let mut acc = [0f64; 4];
      let mut area = 0f64;
      for py in (y0.floor() as u32)..(y1.ceil() as u32).min(img.height) {
        let wy = (y1.min(py as f64 + 1.0) - y0.max(py as f64)).max(0.0);
        for px in (x0.floor() as u32)..(x1.ceil() as u32).min(img.width) {
          let wx = (x1.min(px as f64 + 1.0) - x0.max(px as f64)).max(0.0);
          let wgt = wx * wy;
          let i = ((py * img.width + px) * 4) as usize;
          let a = img.pixels[i + 3] as f64;
          for (sum, v) in acc.iter_mut().zip(&img.pixels[i..i + 3]) {
            *sum += *v as f64 * a * wgt;
          }
          acc[3] += a * wgt;
          area += wgt;
        }
      }
      let o = (((oy + y) * size + ox + x) * 4) as usize;
      if acc[3] > 0.0 {
        for (out, sum) in pixels[o..o + 3].iter_mut().zip(acc) {
          *out = (sum / acc[3]).round().clamp(0.0, 255.0) as u8;
        }
        pixels[o + 3] = (acc[3] / area).round().clamp(0.0, 255.0) as u8;
      }
    }
  }
  Rgba { width: size, height: size, pixels }
}

/// The sizes of a made app's .ico.
pub const ICO_SIZES: [u32; 4] = [256, 48, 32, 16];

/// A .ico with the image at each of ICO_SIZES, every one a PNG.
pub fn ico_from_png(png: &[u8]) -> Result<Vec<u8>, String> {
  let src = decode_png(png)?;
  let images = ICO_SIZES.iter().map(|&s| encode_png(&fit_square(&src, s)).map(|d| (s, d))).collect::<Result<Vec<_>, _>>()?;
  let mut ico = vec![0, 0, 1, 0];
  ico.extend_from_slice(&(images.len() as u16).to_le_bytes());
  let mut offset = 6 + 16 * images.len() as u32;
  for (size, data) in &images {
    let dim = if *size >= 256 { 0 } else { *size as u8 };
    ico.extend_from_slice(&[dim, dim, 0, 0]);
    ico.extend_from_slice(&1u16.to_le_bytes()); // planes
    ico.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    ico.extend_from_slice(&(data.len() as u32).to_le_bytes());
    ico.extend_from_slice(&offset.to_le_bytes());
    offset += data.len() as u32;
  }
  for (_, data) in images {
    ico.extend_from_slice(&data);
  }
  Ok(ico)
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;

  /// A `w` x `h` PNG, opaque red on the left half, transparent on the right.
  pub fn sample_png(w: u32, h: u32) -> Vec<u8> {
    let mut pixels = Vec::new();
    for _ in 0..h {
      for x in 0..w {
        pixels.extend_from_slice(if x < w / 2 { &[255, 0, 0, 255] } else { &[0, 0, 0, 0] });
      }
    }
    encode_png(&Rgba { width: w, height: h, pixels }).unwrap()
  }

  #[test]
  fn png_round_trip_and_detection() {
    let png = sample_png(4, 2);
    assert!(is_png(&png) && !is_ico(&png));
    let img = decode_png(&png).unwrap();
    assert_eq!((img.width, img.height), (4, 2));
    assert_eq!(&img.pixels[..4], &[255, 0, 0, 255]);
    assert_eq!(&img.pixels[12..16], &[0, 0, 0, 0]);
    assert!(decode_png(b"not a png").is_err());
  }

  #[test]
  fn fit_square_scales_and_centres() {
    let img = decode_png(&sample_png(64, 32)).unwrap();
    let s = fit_square(&img, 16);
    assert_eq!((s.width, s.height, s.pixels.len()), (16, 16, 16 * 16 * 4));
    let at = |x: u32, y: u32| &s.pixels[((y * 16 + x) * 4) as usize..][..4];
    assert_eq!(at(0, 0), &[0, 0, 0, 0]); // the letterbox above the 16x8 picture
    assert_eq!(at(2, 8), &[255, 0, 0, 255]);
    assert_eq!(at(13, 8)[3], 0);
    // upscaling a 1x1 image fills the square
    let one = Rgba { width: 1, height: 1, pixels: vec![1, 2, 3, 255] };
    assert!(fit_square(&one, 4).pixels.chunks(4).all(|p| p == [1, 2, 3, 255]));
  }

  #[test]
  fn ico_has_every_size() {
    let ico = ico_from_png(&sample_png(300, 300)).unwrap();
    assert!(is_ico(&ico));
    assert_eq!(u16::from_le_bytes([ico[4], ico[5]]), ICO_SIZES.len() as u16);
    for (i, size) in ICO_SIZES.iter().enumerate() {
      let e = &ico[6 + i * 16..][..16];
      assert_eq!(e[0] as u32, if *size == 256 { 0 } else { *size });
      let len = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
      let off = u32::from_le_bytes(e[12..16].try_into().unwrap()) as usize;
      let img = decode_png(&ico[off..off + len]).unwrap();
      assert_eq!((img.width, img.height), (*size, *size));
    }
  }
}
