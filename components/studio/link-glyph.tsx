"use client";

/**
 * The glyph inside a `<Link>`, swapped for a spinner while that link's
 * navigation is pending — the same trade the toolbar makes for a tool busy
 * creating a workflow.
 *
 * Worth having because the routes it sits on are dynamic: the studio reads
 * the document, and the canvas also waits on the catalog, its comments and
 * its chat thread. Prefetch cannot make either instant, so without this a
 * click sits with no answer at all while the server renders.
 *
 * Must be rendered *inside* the Link it reports on — that is where
 * `useLinkStatus` reads from.
 */

import { useLinkStatus } from "next/link";

import { Spinner } from "@/components/ui/spinner";

export function LinkGlyph({
  children,
  className,
}: {
  /** The glyph the link wears at rest. */
  children: React.ReactNode;
  /** Sizing for the spinner — match the glyph it stands in for, or the
   *  button changes width the moment it is clicked. */
  className?: string;
}) {
  const { pending } = useLinkStatus();
  return pending ? <Spinner className={className} /> : <>{children}</>;
}
