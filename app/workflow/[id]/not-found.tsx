import Link from "next/link";

export default function WorkflowNotFound() {
  return (
    <div className="fixed inset-0 grid place-items-center bg-[#f7f4ee] px-6 text-[#1f211c]">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-medium tracking-[-0.01em]">
          No such <span className="font-serif italic">workflow</span>
        </h1>
        <p className="mt-3 text-[13px] leading-6 text-[#8a8271]">
          It may have been deleted, or it belongs to another workspace.
        </p>
        <Link
          href="/workflow"
          className="mt-6 inline-flex h-10 items-center border border-[#1f211c]/20 px-5 text-[13px] font-semibold transition-colors hover:border-[#1f211c]/45 hover:bg-white/70"
        >
          Back to workflows
        </Link>
      </div>
    </div>
  );
}
