"use client";

/**
 * A link's leading icon, swapped for a spinner while its navigation is in
 * flight. Both doors between the canvas and the library are auth-gated and
 * fetch on arrival, so a click can sit for a beat with nothing to show for it.
 *
 * The spinner matches the icon's box, so nothing around it moves. Must be
 * rendered inside a `Link` — `useLinkStatus` reads the nearest one.
 */

import * as React from "react";
import { useLinkStatus } from "next/link";

import { Spinner } from "@/components/ui/spinner";

export function LinkPendingIcon({
  icon,
  className,
}: {
  icon: React.ReactNode;
  className?: string;
}) {
  const { pending } = useLinkStatus();
  return pending ? <Spinner className={className ?? "size-4"} /> : icon;
}
