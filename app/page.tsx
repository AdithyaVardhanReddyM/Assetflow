import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Image from "next/image";
import { redirect } from "next/navigation";
import Script from "next/script";

/* One 100vh screen. The background is a Unicorn Studio scene; the hero
   sits on masked pools of blurred cream. Anyone already signed in skips
   straight to the studio. */

/* Inline icons for the headline: the studio's own node glyphs, drawn
   bare so the hero quotes the product itself. */
const HERO_ICONS = [
  "/image_gen.svg",
  "/video_gen.svg",
  "/music_gen.svg",
] as const;

export default async function Home() {
  const { userId } = await auth();
  if (userId) redirect("/workflow");

  return (
    <main className="relative h-dvh overflow-hidden bg-[#f7f4ee] text-[#1f211c]">
      <style>{`
        @keyframes lp-rise {
          from { opacity: 0; transform: translateY(20px); filter: blur(6px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
        .lp-rise { animation: lp-rise 800ms cubic-bezier(0.32, 0.72, 0, 1) both; }
        @media (prefers-reduced-motion: reduce) {
          .lp-rise { animation-duration: 1ms; }
        }
      `}</style>

      {/* ---- Background: Unicorn Studio scene -------------------------- */}
      <div
        className="fixed inset-0 w-full h-screen z-0 pointer-events-none"
        style={{ filter: "hue-rotate(190deg) saturate(1.2)" }}
      >
        <div
          data-us-project="FixNvEwvWwbu3QX9qC3F"
          className="absolute inset-0 w-full h-full"
          style={{ minHeight: "100vh" }}
        />
      </div>
      <Script
        id="unicorn-studio"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{
          __html: `
            !function(){if(!window.UnicornStudio){window.UnicornStudio={isInitialized:!1};var i=document.createElement("script");i.src="https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@v1.4.29/dist/unicornStudio.umd.js",i.onload=function(){window.UnicornStudio.isInitialized||(UnicornStudio.init(),window.UnicornStudio.isInitialized=!0)},(document.head || document.body).appendChild(i)}}();
          `,
        }}
      />

      {/* ---- Foreground ------------------------------------------------ */}
      <div className="relative z-10 mx-auto flex h-full w-full max-w-[1440px] flex-col px-6 sm:px-12">
        <header className="lp-rise flex items-center justify-between py-7">
          <div className="relative">
            {/* Same treatment as the hero: a masked pool of blurred cream
                that dissolves outward, so the logo sits on calm ground
                without a visible box. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-16 -inset-y-10"
              style={{
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                background:
                  "radial-gradient(closest-side, rgba(247, 244, 238, 0.95), rgba(247, 244, 238, 0.5) 60%, transparent 100%)",
                maskImage:
                  "radial-gradient(closest-side, black 40%, transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(closest-side, black 40%, transparent 100%)",
              }}
            />
            <Image
              className="relative"
              src="/assetflow_full_logo.svg"
              alt="Asset Flow"
              width={216}
              height={30}
              priority
            />
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <SignInButton mode="modal" forceRedirectUrl="/workflow">
              <button className="flex h-10 shrink-0 items-center border border-primary px-5 text-sm font-semibold text-[#1f211c]/80 transition-all duration-150 hover:bg-primary hover:text-primary-foreground active:scale-[0.97]">
                Log in
              </button>
            </SignInButton>
            <SignUpButton mode="modal" forceRedirectUrl="/workflow">
              <button className="h-10 bg-[#1f211c] px-5 text-sm font-semibold text-[#f7f4ee] shadow-[0_12px_32px_rgba(31,33,28,0.28)] transition hover:bg-[#34362f]">
                Get started
              </button>
            </SignUpButton>
          </div>
        </header>

        <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
          <div className="relative flex flex-col items-center">
            {/* A soft pool of paper behind the text: backdrop blur plus a
                cream radial wash, both masked so they dissolve outward and
                never draw a visible edge over the scene. */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-x-64 -inset-y-48 sm:-inset-x-[32rem] sm:-inset-y-80"
              style={{
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
                background:
                  "radial-gradient(closest-side, rgba(247, 244, 238, 0.95), rgba(247, 244, 238, 0.5) 60%, transparent 100%)",
                maskImage:
                  "radial-gradient(closest-side, black 40%, transparent 100%)",
                WebkitMaskImage:
                  "radial-gradient(closest-side, black 40%, transparent 100%)",
              }}
            />
            <h1
              className="lp-rise relative font-heading text-[clamp(2.5rem,5.5vw,5rem)] font-semibold leading-[1.08] tracking-[-0.025em]"
              style={{ animationDelay: "120ms" }}
            >
              Where ideas flow
              <br />
              into{" "}
              <span
                aria-hidden
                className="mx-[0.1em] inline-flex translate-y-[0.1em] items-center gap-[0.12em] align-baseline"
              >
                {HERO_ICONS.map((src) => (
                  <Image
                    key={src}
                    src={src}
                    alt=""
                    width={48}
                    height={48}
                    className="size-[0.78em]"
                  />
                ))}
              </span>{" "}
              <em className="font-serif font-normal italic tracking-normal text-[oklch(0.681_0.162_75.834)]">
                assets.
              </em>
            </h1>

            <p
              className="lp-rise relative mt-6 max-w-2xl font-[family-name:var(--font-bricolage)] text-base leading-7 text-[#595447] sm:mt-8 sm:text-lg sm:leading-8"
              style={{ animationDelay: "240ms" }}
            >
              Asset Flow turns media generation into visual workflows. Chain
              image, video, audio, and 3D models from different providers into
              one pipeline, refine the results in the studio, and let every
              asset land in durable storage carrying its provenance, metadata,
              and full lineage.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
