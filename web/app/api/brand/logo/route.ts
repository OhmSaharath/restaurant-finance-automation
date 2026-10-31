import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getTenantUserContext, resolveBrandId } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "brand-logos";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 4096;
const OUTPUT_SIZE = 512;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function isBrandManager(role: string | null): boolean {
  return role === "owner" || role === "admin";
}

type Rgba = { r: number; g: number; b: number; a: number };

function pixelAt(data: Buffer, index: number): Rgba {
  const offset = index * 4;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/**
 * Detect a simple edge-connected background and remove it conservatively.
 *
 * This intentionally does not attempt AI segmentation: a logo with a
 * photographic/gradient background should be preserved rather than damaged.
 * Solid black/white/transparent padding (the common “logo is tiny” case) is
 * removed from the canvas, then the result is normalized to a 512px square.
 */
async function processLogo(input: Uint8Array) {
  const source = sharp(input, { limitInputPixels: 16_000_000 }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Could not read logo dimensions.");
  if (metadata.width > MAX_SOURCE_DIMENSION || metadata.height > MAX_SOURCE_DIMENSION) {
    throw new Error(`Logo dimensions must be ${MAX_SOURCE_DIMENSION}×${MAX_SOURCE_DIMENSION}px or smaller.`);
  }

  const { data, info } = await source.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const sampleSize = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) / 16)));
  const samples: Rgba[] = [];
  for (const [x0, y0] of [[0, 0], [width - sampleSize, 0], [0, height - sampleSize], [width - sampleSize, height - sampleSize]]) {
    for (let y = y0; y < y0 + sampleSize; y += 1) {
      for (let x = x0; x < x0 + sampleSize; x += 1) samples.push(pixelAt(data, y * width + x));
    }
  }
  const background: Rgba = {
    r: Math.round(samples.reduce((sum, p) => sum + p.r, 0) / samples.length),
    g: Math.round(samples.reduce((sum, p) => sum + p.g, 0) / samples.length),
    b: Math.round(samples.reduce((sum, p) => sum + p.b, 0) / samples.length),
    a: Math.round(samples.reduce((sum, p) => sum + p.a, 0) / samples.length),
  };
  const maxCornerSpread = Math.max(...samples.map((p) => colorDistance(p, background)));
  const transparentCorners = samples.every((p) => p.a < 24);
  const solidCorners = !transparentCorners && background.a > 230 && maxCornerSpread <= 18;
  const shouldRemoveBackground = transparentCorners || solidCorners;

  let processed = Buffer.from(data);
  let removed = 0;
  if (shouldRemoveBackground) {
    const visited = new Uint8Array(width * height);
    const queue = new Uint32Array(width * height);
    let head = 0;
    let tail = 0;
    const matches = (index: number) => {
      const p = pixelAt(processed, index);
      if (transparentCorners) return p.a < 48;
      return p.a > 0 && colorDistance(p, background) <= 28;
    };
    const seed = (index: number) => {
      if (visited[index] || !matches(index)) return;
      visited[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < width; x += 1) { seed(x); seed((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y += 1) { seed(y * width); seed(y * width + width - 1); }
    while (head < tail) {
      const index = queue[head++];
      processed[index * 4 + 3] = 0;
      removed += 1;
      const x = index % width;
      if (x > 0) seed(index - 1);
      if (x + 1 < width) seed(index + 1);
      if (index >= width) seed(index - width);
      if (index + width < width * height) seed(index + width);
    }
    // If the heuristic would erase almost everything, retain the original.
    if (removed < width * height * 0.005 || removed > width * height * 0.8) {
      processed = Buffer.from(data);
      removed = 0;
    }
  }

  let normalizedSource = sharp(processed, { raw: { width, height, channels: 4 } });
  // sharp's trim is RGB-oriented and does not reliably crop transparent
  // pixels in every input format, so use the alpha channel we just computed
  // for a deterministic bounding box.
  if (removed > 0) {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (processed[(y * width + x) * 4 + 3] > 4) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right >= left && bottom >= top) {
      normalizedSource = normalizedSource.extract({
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
      });
    }
  }
  const normalized = await normalizedSource
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();

  return {
    bytes: normalized,
    width,
    height,
    backgroundRemoved: removed > 0,
    cropped: removed > 0 || width !== height,
  };
}

async function getBrandAccess(request: NextRequest) {
  const ctx = await getTenantUserContext();
  if (!ctx?.userId) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const requestedBrand = new URL(request.url).searchParams.get("brand_id");
  const brandId = resolveBrandId(ctx, requestedBrand);
  if (!brandId) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", message: "Only a workspace owner or admin can manage the logo." },
        { status: 403 }
      ),
    };
  }
  const admin = createAdminClient();
  const { data: membership } = await admin
    .from("brand_users")
    .select("role")
    .eq("user_id", ctx.userId)
    .eq("brand_id", brandId)
    .maybeSingle();
  const effectiveRole = typeof membership?.role === "string" ? membership.role : ctx.role;
  if (!isBrandManager(effectiveRole)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden", message: "Only a workspace owner or admin can manage the logo." },
        { status: 403 }
      ),
    };
  }
  return { ctx, brandId };
}

async function ensureBucket(admin: ReturnType<typeof createAdminClient>) {
  const { data: existing } = await admin.storage.getBucket(BUCKET);
  if (existing) return;
  const { error } = await admin.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: `${MAX_BYTES}`,
    allowedMimeTypes: Array.from(ALLOWED_TYPES),
  });
  // A concurrent first upload may create the bucket between the two calls.
  if (error && !/already exists|duplicate/i.test(error.message || "")) throw error;
}

export async function POST(request: NextRequest) {
  try {
    const access = await getBrandAccess(request);
    if (access.error) return access.error;

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please select a logo image." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json({ error: "Logo must be a PNG, JPG, or WebP image." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Logo must be 2 MB or smaller." }, { status: 400 });
    }

    const processed = await processLogo(new Uint8Array(await file.arrayBuffer()));
    const admin = createAdminClient();
    await ensureBucket(admin);
    // Always store the normalized PNG so transparent padding and dimensions are
    // consistent regardless of whether the user uploaded JPG, PNG, or WebP.
    const path = `${access.brandId}/logo.png`;
    const { error: uploadError } = await admin.storage.from(BUCKET).upload(path, processed.bytes, {
      upsert: true,
      contentType: "image/png",
      cacheControl: "3600",
    });
    if (uploadError) throw uploadError;
    // Remove old extension variants only after the new object is safely
    // stored, so a transient upload failure never blanks an existing logo.
    await admin.storage.from(BUCKET).remove([
      `${access.brandId}/logo.png`,
      `${access.brandId}/logo.jpg`,
      `${access.brandId}/logo.webp`,
    ].filter((candidate) => candidate !== path));

    const { data: publicUrl } = admin.storage.from(BUCKET).getPublicUrl(path);
    const logoUrl = `${publicUrl.publicUrl}?v=${Date.now()}`;
    const { error: updateError } = await admin
      .from("brands")
      .update({ logo_url: logoUrl })
      .eq("id", access.brandId);
    if (updateError) throw updateError;

    return NextResponse.json({
      logo_url: logoUrl,
      processing: {
        original_width: processed.width,
        original_height: processed.height,
        output_size: OUTPUT_SIZE,
        cropped: processed.cropped,
        background_removed: processed.backgroundRemoved,
      },
    });
  } catch (error: any) {
    console.error("Brand logo upload failed:", error);
    return NextResponse.json({ error: error?.message || "Could not save the workspace logo." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const access = await getBrandAccess(request);
    if (access.error) return access.error;

    const admin = createAdminClient();
    await admin.storage.from(BUCKET).remove([
      `${access.brandId}/logo.png`,
      `${access.brandId}/logo.jpg`,
      `${access.brandId}/logo.webp`,
    ]);
    const { error } = await admin.from("brands").update({ logo_url: null }).eq("id", access.brandId);
    if (error) throw error;
    return NextResponse.json({ logo_url: null });
  } catch (error: any) {
    console.error("Brand logo removal failed:", error);
    return NextResponse.json({ error: error?.message || "Could not remove the workspace logo." }, { status: 500 });
  }
}
