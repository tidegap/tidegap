import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEMO_VIDEO, DemoVideo } from "@/components/home/demo-video";

const html = renderToStaticMarkup(<DemoVideo />);
const video = html.match(/<video[^>]*>/)?.[0] ?? "";
const PUBLIC = join(__dirname, "../../../public");

describe("DemoVideo server markup", () => {
  it("never autoplays, loops or preloads", () => {
    expect(video).toMatch(/\spreload="none"/);
    expect(video).toMatch(/\scontrols=""/);
    expect(video).toMatch(/\splaysInline=""|\splaysinline=""/);
    expect(video).not.toMatch(/autoplay|loop|muted/i);
    expect(video).toContain(`poster="${DEMO_VIDEO.poster}"`);
  });

  it("serves 1080p from lg and 720p otherwise", () => {
    const sources = [...html.matchAll(/<source[^>]*>/g)].map((m) => m[0]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toContain(`src="${DEMO_VIDEO.src1080}"`);
    expect(sources[0]).toContain('media="(min-width: 1024px)"');
    expect(sources[1]).toContain(`src="${DEMO_VIDEO.src720}"`);
    expect(sources[1]).not.toContain("media=");
  });

  it("has a default English captions track", () => {
    const track = html.match(/<track[^>]*>/)?.[0] ?? "";
    expect(track).toContain('kind="captions"');
    expect(track).toContain(`src="${DEMO_VIDEO.captions}"`);
    expect(track).toMatch(/\ssrcLang="en"|\ssrclang="en"/);
    expect(track).toMatch(/\sdefault=""/);
    const vtt = readFileSync(join(PUBLIC, DEMO_VIDEO.captions), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
  });

  it("has a fallback link and a caption", () => {
    expect(html).toContain(`<a href="${DEMO_VIDEO.src720}"`);
    expect(html).toContain("Download the demo (MP4)");
    expect(html).toMatch(/<figcaption[^>]*>[^<]+/);
  });

  it("points at committed files within the size budget", () => {
    const budget: Array<[string, number]> = [
      [DEMO_VIDEO.src1080, 6_000_000],
      [DEMO_VIDEO.src720, 3_000_000],
      [DEMO_VIDEO.poster, 200_000],
      [DEMO_VIDEO.captions, 10_000],
    ];
    for (const [src, max] of budget) {
      const file = join(PUBLIC, src);
      expect(existsSync(file), src).toBe(true);
      expect(statSync(file).size, src).toBeLessThanOrEqual(max);
    }
    const size = (src: string) => statSync(join(PUBLIC, src)).size;
    expect(size(DEMO_VIDEO.src720)).toBeLessThan(size(DEMO_VIDEO.src1080));
  });
});
