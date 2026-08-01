import { InspectView } from "@/components/inspect/inspect-view";

export const metadata = {
  title: "Inspect · Asset Flow",
  description:
    "Drop a file exported from Asset Flow and read the provenance it carries.",
};

/**
 * Public on purpose — this page exists for the person who *received* a
 * stamped file, who has no account and needs none. Everything happens
 * client-side against the public inspect endpoint; there is nothing for the
 * server to render ahead of time.
 */
export default function InspectPage() {
  return <InspectView />;
}
