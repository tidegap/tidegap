import { Section } from "@/components/ui/section";

// Encoded from tidegap-video out/v1 (silent cut, 46.8 s): H.264 CRF 23,
// +faststart. Phones get the 720p file; 1080p from the lg breakpoint.
export const DEMO_VIDEO = {
  src1080: "/video/tidegap-demo-1080.mp4",
  src720: "/video/tidegap-demo-720.mp4",
  poster: "/video/tidegap-demo-poster.jpg",
} as const;

/** The 45-second product demo. No autoplay and preload="none": nothing but the poster loads until play. */
export function DemoVideo() {
  return (
    <Section id="demo" eyebrow="Demo" title="See it in 45 seconds.">
      <figure className="reveal">
        <div className="lift overflow-hidden rounded-xl border border-rule bg-bg-elev">
          <video
            controls
            muted
            playsInline
            preload="none"
            poster={DEMO_VIDEO.poster}
            width={1920}
            height={1080}
            aria-label="Tidegap demo: an agent queues a task and it runs at the cleanest grid hour"
            className="block aspect-video h-auto w-full"
          >
            <source src={DEMO_VIDEO.src1080} type="video/mp4" media="(min-width: 1024px)" />
            <source src={DEMO_VIDEO.src720} type="video/mp4" />
            <p>
              Your browser cannot play this video.{" "}
              <a href={DEMO_VIDEO.src720} className="text-accent hover:underline">
                Download the demo (MP4)
              </a>
              .
            </p>
          </video>
        </div>
        <figcaption className="type-caption mt-2">
          An agent hands Tidegap a task that can wait, and it runs at the cleanest hour before the deadline. No sound.
        </figcaption>
      </figure>
    </Section>
  );
}
