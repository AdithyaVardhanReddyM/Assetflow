import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-[#f7f4ee] text-[#1f211c]">
      <header className="mx-auto flex w-full max-w-6xl flex-col items-stretch gap-4 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/"
          className="flex items-center gap-3"
          aria-label="Asset Flow"
        >
          <span className="grid size-9 place-items-center rounded-md bg-[#1f211c] text-sm font-semibold text-[#f7f4ee]">
            AF
          </span>
          <span className="text-sm font-semibold uppercase tracking-[0.28em]">
            Asset Flow
          </span>
        </Link>
        <nav className="flex w-full items-center gap-3 sm:w-auto">
          <Show when="signed-out">
            <SignInButton mode="modal" forceRedirectUrl="/workflow">
              <button className="h-10 flex-1 rounded-md border border-[#1f211c]/20 px-4 text-sm font-medium transition hover:border-[#1f211c]/45 hover:bg-white/70 sm:flex-none">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal" forceRedirectUrl="/workflow">
              <button className="h-10 flex-1 rounded-md bg-[#1f211c] px-4 text-sm font-medium text-white shadow-sm transition hover:bg-[#34362f] sm:flex-none">
                Create account
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/workflow"
              className="inline-flex h-10 items-center rounded-md border border-[#1f211c]/20 px-4 text-sm font-medium transition hover:border-[#1f211c]/45 hover:bg-white/70"
            >
              Open studio
            </Link>
            <UserButton />
          </Show>
        </nav>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-12 px-6 py-10 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="max-w-xl">
          <p className="mb-4 text-sm font-semibold uppercase tracking-[0.28em] text-[#786f5d]">
            Asset operations
          </p>
          <h1 className="text-5xl font-semibold leading-[1.02] tracking-normal text-[#1f211c] sm:text-6xl">
            Move assets from request to reconciled.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-[#595447]">
            A calm workspace for intake, approvals, transfers, and the final
            ledger check.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Show when="signed-out">
              <SignUpButton mode="modal" forceRedirectUrl="/workflow">
                <button className="h-12 rounded-md bg-[#b24c2e] px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-[#963f26]">
                  Start workspace
                </button>
              </SignUpButton>
              <SignInButton mode="modal" forceRedirectUrl="/workflow">
                <button className="h-12 rounded-md border border-[#1f211c]/20 bg-white/60 px-6 text-sm font-semibold transition hover:border-[#1f211c]/45 hover:bg-white">
                  Sign in
                </button>
              </SignInButton>
            </Show>
            <Show when="signed-in">
              <Link
                href="/workflow"
                className="inline-flex h-12 items-center justify-center rounded-md bg-[#b24c2e] px-6 text-sm font-semibold text-white shadow-sm transition hover:bg-[#963f26]"
              >
                Open studio
              </Link>
            </Show>
          </div>
        </section>

        <section
          id="flow"
          className="rounded-lg border border-[#1f211c]/10 bg-white/75 p-4 shadow-[0_24px_80px_rgba(57,48,32,0.16)] backdrop-blur"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Requests", "18", "#b24c2e"],
              ["Approved", "11", "#245e55"],
              ["Settled", "7", "#4f5f89"],
            ].map(([label, value, color]) => (
              <div key={label} className="rounded-md bg-[#f7f4ee] p-4">
                <div
                  className="mb-5 h-1.5 w-10 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#786f5d]">
                  {label}
                </p>
                <p className="mt-2 text-3xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-md border border-[#1f211c]/10">
            {[
              ["Hardware refresh", "Awaiting approval", "$42,800"],
              ["Data room renewal", "Ready to transfer", "$12,400"],
              ["Regional fleet audit", "Reconciling", "$86,120"],
              ["Creative suite seats", "Settled", "$9,960"],
            ].map(([name, status, amount]) => (
              <div
                key={name}
                className="grid grid-cols-[1fr_auto] gap-4 border-b border-[#1f211c]/10 bg-white px-4 py-4 last:border-b-0 sm:grid-cols-[1fr_12rem_auto]"
              >
                <p className="font-medium">{name}</p>
                <p className="hidden text-sm text-[#6b6556] sm:block">
                  {status}
                </p>
                <p className="font-mono text-sm font-semibold">{amount}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
