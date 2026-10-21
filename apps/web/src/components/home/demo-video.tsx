import { Section } from "@/components/ui/section";

// Encoded from tidegap-video out/v2 (voiced cut, 46.8 s, Kokoro-82M voice
// af_heart, Apache-2.0), the render without the burned-in caption bar: the captions track below carries the same
// cues, so they never show twice. H.264 CRF 23, AAC 128k, +faststart. Phones
// get the 720p file; 1080p from the lg breakpoint.
export const DEMO_VIDEO = {
  src1080: "/video/tidegap-demo-1080.mp4",
  src720: "/video/tidegap-demo-720.mp4",
  poster: "/video/tidegap-demo-poster.jpg",
  captions: "/video/tidegap-demo.vtt",
} as const;

/** The 45-second product demo. No autoplay and preload="none": nothing but the poster loads until play; sound plays only after the viewer presses play. */
export function DemoVideo() {
  return (
    <Section id="demo" eyebrow="Demo" title="See it in 45 seconds.">
      <figure className="reveal">
        <div className="lift overflow-hidden rounded-xl border border-rule bg-bg-elev">
          <video
            controls
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
            <track kind="captions" src={DEMO_VIDEO.captions} srcLang="en" label="English" default />
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
          An agent hands Tidegap a task that can wait, and it runs at the cleanest hour before the deadline. Narrated by an AI voice; captions included.
        </figcaption>
      </figure>
    </Section>
  );
}
